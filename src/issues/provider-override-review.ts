import { isAgentProviderName } from "../human-resume-command.js";
import {
  normalizeIssueSnapshot,
  sameIssueRepository,
  tryGetIssue,
  type IssueSnapshot
} from "../issue-polling.js";
import {
  isAgentState,
  type ReviewedOverride
} from "../lifecycle/chain-provider.js";
import {
  isDispatchProject,
  type DispatchProjectConfig
} from "../lifecycle/run-controller.js";
import { findWorkflowState } from "../lifecycle/state-machine-dispatch.js";
import { isProviderOverrideReviewReason } from "../lifecycle/terminal-reason.js";
import type { AgentProviderName } from "../provider.js";
import type { ProviderPlan, RunStatus } from "../run-store.js";
import {
  diffStateDefinitions,
  stateDefinitionEvidence,
  type StateDefinitionChange,
  type StateDefinitionEvidence
} from "../workflow/state-definition-digest.js";
import {
  availableProviders,
  claimHeldMessage,
  DEFAULT_GITHUB_TIMEOUT_MS,
  errorMessage,
  heldClaimLabels,
  type ProviderRecoveryDeps
} from "./provider-recovery.js";

type OverrideReviewResolution = "drop" | "keep" | "rebind";

const RESOLUTIONS: readonly OverrideReviewResolution[] = [
  "keep",
  "rebind",
  "drop"
];

export type OverrideReviewRefusalReason =
  | "claim-held"
  | "duplicate"
  | "evidence-changed"
  | "invalid-position"
  | "invalid-resolution"
  | "issue-closed"
  | "live-run"
  | "no-open-review"
  | "not-a-dispatch-project"
  | "position-mismatch"
  | "provider-unavailable"
  | "repository-mismatch"
  | "run-not-found"
  | "shutting-down"
  | "state-removed"
  | "superseded"
  | "workflow-not-fsm";

export type OverrideReviewOutcome =
  | {
      fromRunId: string;
      interventionId: string;
      kind: "accepted";
      provider: AgentProviderName;
      resolution: OverrideReviewResolution;
      stateId: string;
    }
  | {
      error: string;
      kind: "refused";
      liveRunId?: string;
      reason: OverrideReviewRefusalReason;
    }
  | { error: string; kind: "error" };

type ResolveOverrideReviewRequest = {
  issueNumber: number;
  // The digest of the state's current definition that the operator reviewed.
  // Re-checked against the live workflow, so a preview that has gone stale
  // cannot bind a choice to a definition the operator never saw.
  newDigest: string;
  projectName: string;
  // Only for `rebind`.
  provider: string;
  requestedVia: string;
  resolution: string;
  runId: string;
  stateId: string;
};

export type OverrideReviewPreview = {
  blockers: string[];
  // The provider `drop` falls back to: the chain-wide choice.
  chainProvider: AgentProviderName;
  // The graph the chain last walked, taken from the nearest Run that captured
  // one (the parked Run itself never launched, so it has none).
  capturedGraph:
    | {
        contentHash: string;
        runId: string;
        stateDigest: string | null;
        workflowName: string;
      }
    | undefined;
  changes: StateDefinitionChange[];
  // Undefined when the state is gone from the current workflow.
  current: StateDefinitionEvidence | undefined;
  providers: AgentProviderName[];
  recorded: StateDefinitionEvidence;
  recordedProvider: AgentProviderName;
  repository: { owner: string; repo: string };
  run: RunStatus;
  stateId: string;
  workflowName: string | undefined;
};

export function overrideReviewHttpStatus(
  outcome: OverrideReviewOutcome
): 202 | 409 | 422 | 500 {
  if (outcome.kind === "accepted") {
    return 202;
  }
  if (outcome.kind === "error") {
    return 500;
  }
  return outcome.reason === "live-run" ||
    outcome.reason === "claim-held" ||
    outcome.reason === "duplicate"
    ? 409
    : 422;
}

export type OverrideReviewService = {
  // The Run holding an open review for the Issue, from local state only.
  findOpenReview(
    projectName: string,
    issueNumber: number
  ): { runId: string; stateId: string } | undefined;
  preview(
    projectName: string,
    issueNumber: number
  ): Promise<OverrideReviewPreview | undefined>;
  resolve(
    request: ResolveOverrideReviewRequest
  ): Promise<OverrideReviewOutcome>;
};

export type OverrideReviewDeps = Omit<
  ProviderRecoveryDeps,
  "scheduleRecovery"
> & {
  // Re-reads the config and workflow from disk. The park was decided on a
  // forced reload at State Advance, which can be ahead of the daemon's
  // hot-reloaded snapshot; judging the review against a stale snapshot would
  // show an edit as reverted, or bind the choice to a definition the launch
  // then disagrees with.
  reloadConfig?: () => Promise<void>;
  scheduleResume: (input: {
    interventionId: string;
    issue: IssueSnapshot;
    override: ReviewedOverride;
    parentRunId: string;
    projectName: string;
    toStateId: string;
  }) => boolean;
};

type ReviewContext = {
  chainProvider: AgentProviderName;
  current: StateDefinitionEvidence | undefined;
  isAgent: boolean;
  plan: ProviderPlan;
  recorded: StateDefinitionEvidence;
  recordedProvider: AgentProviderName;
  run: RunStatus;
  stateId: string;
  workflowName: string;
};

type Inspection =
  | { context: ReviewContext; kind: "review" }
  | { kind: "refusal"; refusal: OverrideReviewOutcome };

function refuse(
  reason: OverrideReviewRefusalReason,
  error: string,
  liveRunId?: string
): OverrideReviewOutcome {
  return {
    error,
    kind: "refused",
    reason,
    ...(liveRunId === undefined ? {} : { liveRunId })
  };
}

function isOpenReview(run: RunStatus): boolean {
  return (
    run.state === "blocked" &&
    run.currentStateId !== null &&
    isProviderOverrideReviewReason(run.terminalReason)
  );
}

// Review of a per-state provider choice whose state changed (#864, stage 2 of
// ADR-2026-10-23-1738). The operator keeps the recorded provider, rebinds the
// state to another, or drops the choice; the chain then resumes at the same
// state as a Continuation of the parked Run, through the route recovery uses
// (#863). Nothing about the plan changes until the resumed Run claims: the
// rewrite is applied by the RunController together with the launch.
export function createOverrideReviewService(
  deps: OverrideReviewDeps
): OverrideReviewService {
  const timeoutMs = deps.githubTimeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;

  async function refreshConfig(): Promise<void> {
    try {
      await deps.reloadConfig?.();
    } catch {
      // A failed reload keeps the last good snapshot, which is what the
      // launch falls back to as well.
    }
  }

  function dispatchProject(
    projectName: string
  ): DispatchProjectConfig | undefined {
    const project = deps.getProject(projectName);
    return project !== undefined &&
      project.disabled !== true &&
      isDispatchProject(project)
      ? project
      : undefined;
  }

  function headRun(
    projectName: string,
    issueNumber: number
  ): RunStatus | undefined {
    return deps.runStore.listRuns({
      issueNumber,
      limit: 1,
      project: projectName
    })[0];
  }

  function findOpenReview(
    projectName: string,
    issueNumber: number
  ): { runId: string; stateId: string } | undefined {
    const run = headRun(projectName, issueNumber);
    return run !== undefined && isOpenReview(run) && run.currentStateId !== null
      ? { runId: run.id, stateId: run.currentStateId }
      : undefined;
  }

  // Everything that does not depend on the operator's resolution: the Run is
  // the open review of this Issue, at the state the operator saw, and still
  // the head of its history.
  function inspect(
    project: DispatchProjectConfig,
    request: Pick<
      ResolveOverrideReviewRequest,
      "issueNumber" | "projectName" | "runId" | "stateId"
    >
  ): Inspection {
    const fail = (outcome: OverrideReviewOutcome): Inspection => ({
      kind: "refusal",
      refusal: outcome
    });
    const run = deps.runStore.getRun(request.runId);
    if (
      run === undefined ||
      run.project !== request.projectName ||
      run.issueNumber !== request.issueNumber
    ) {
      return fail(refuse("run-not-found", "no such Run for this Issue"));
    }
    if (!isOpenReview(run)) {
      return fail(
        refuse(
          "no-open-review",
          `the Run is ${run.state} and is not parked for a provider override review`
        )
      );
    }
    if (run.currentStateId !== request.stateId) {
      return fail(
        refuse(
          "position-mismatch",
          `the Run is parked at ${run.currentStateId ?? "no state"}, not ${request.stateId}; reload and review again`
        )
      );
    }
    const workflow = project.workflow;
    if (
      !("expandedWorkflow" in workflow) ||
      workflow.expandedWorkflow.source.kind !== "raw_fsm"
    ) {
      return fail(
        refuse(
          "workflow-not-fsm",
          "only a raw FSM workflow has per-state provider choices to review"
        )
      );
    }
    const origin = deps.runStore.getRunIssueRepository(run.id);
    if (origin !== undefined && !sameIssueRepository(origin, project.tracker)) {
      return fail(
        refuse(
          "repository-mismatch",
          "the Run belongs to a different repository than the Project now tracks"
        )
      );
    }
    if (!deps.runStore.isIssueHeadRun(run.id)) {
      return fail(
        refuse(
          "superseded",
          "a later Run exists for this Issue; resuming this one would replay completed work"
        )
      );
    }
    const plan = deps.runStore.getChainProviderPlan(run.id);
    const recordedProvider = plan?.stateProviders[request.stateId];
    const recorded = plan?.stateDefinitions[request.stateId];
    if (
      plan === undefined ||
      !Object.hasOwn(plan.stateProviders, request.stateId) ||
      recordedProvider === undefined ||
      recorded === undefined
    ) {
      return fail(
        refuse(
          "no-open-review",
          `the Run Chain holds no recorded provider choice for state ${request.stateId}`
        )
      );
    }
    const state = findWorkflowState(workflow.expandedWorkflow, request.stateId);
    return {
      context: {
        chainProvider: plan.provider,
        current:
          state === undefined ? undefined : stateDefinitionEvidence(state),
        isAgent: isAgentState(state),
        plan,
        recorded,
        recordedProvider,
        run,
        stateId: request.stateId,
        workflowName: workflow.expandedWorkflow.name
      },
      kind: "review"
    };
  }

  // What the current workflow still allows, independent of the operator's
  // choice. A removed state cannot be resumed at, so there is nothing to
  // resolve until the workflow has the state again.
  function stateRefusal(
    context: ReviewContext
  ): OverrideReviewOutcome | undefined {
    if (context.current === undefined) {
      return refuse(
        "state-removed",
        `state ${context.stateId} no longer exists in the workflow, so the chain cannot resume there; restore the state or start the Issue again`
      );
    }
    if (!context.isAgent) {
      return refuse(
        "invalid-position",
        `state ${context.stateId} is no longer an agent state in the current workflow`
      );
    }
    return undefined;
  }

  function liveRefusal(
    projectName: string,
    issueNumber: number,
    runId: string
  ): OverrideReviewOutcome | undefined {
    const liveRunId = deps.checkLiveRun(projectName, issueNumber);
    if (liveRunId !== undefined) {
      return refuse(
        "live-run",
        `the Issue is reserved by live Run ${liveRunId}; the chain cannot be resumed while work is executing or scheduled`,
        liveRunId
      );
    }
    if (deps.hasPendingShutdownResume(runId)) {
      return refuse(
        "live-run",
        "the Run is already being resumed after a shutdown"
      );
    }
    return undefined;
  }

  function resolutionRefusal(
    context: ReviewContext,
    request: ResolveOverrideReviewRequest
  ):
    | { refusal: OverrideReviewOutcome }
    | {
        override: ReviewedOverride;
        provider: AgentProviderName;
        resolution: OverrideReviewResolution;
      } {
    const resolution = RESOLUTIONS.find((name) => name === request.resolution);
    if (resolution === undefined) {
      return {
        refusal: refuse(
          "invalid-resolution",
          "choose whether to keep the recorded provider, rebind the state to another, or drop the choice"
        )
      };
    }
    const stale = stateRefusal(context);
    if (stale !== undefined) {
      return { refusal: stale };
    }
    const { current } = context;
    if (current === undefined || request.newDigest !== current.digest) {
      return {
        refusal: refuse(
          "evidence-changed",
          "the state's definition changed since this review was rendered; reload and review again"
        )
      };
    }
    const available = availableProviders(deps);
    let provider: AgentProviderName;
    if (resolution === "keep") {
      provider = context.recordedProvider;
    } else if (resolution === "drop") {
      provider = context.chainProvider;
    } else if (
      !isAgentProviderName(request.provider) ||
      request.provider === context.recordedProvider
    ) {
      return {
        refusal: refuse(
          "invalid-resolution",
          `rebind needs a provider other than the recorded ${context.recordedProvider}`
        )
      };
    } else {
      provider = request.provider;
    }
    if (!available.includes(provider)) {
      return {
        refusal: refuse(
          "provider-unavailable",
          `${provider} is not a configured and registered provider`
        )
      };
    }
    return {
      override: resolution === "drop" ? null : { evidence: current, provider },
      provider,
      resolution
    };
  }

  async function resolve(
    request: ResolveOverrideReviewRequest
  ): Promise<OverrideReviewOutcome> {
    await refreshConfig();
    const project = dispatchProject(request.projectName);
    if (project === undefined) {
      return refuse(
        "not-a-dispatch-project",
        `projects.${request.projectName} is not a dispatch project`
      );
    }
    const check = ():
      | { refusal: OverrideReviewOutcome }
      | (Exclude<ReturnType<typeof resolutionRefusal>, { refusal: unknown }> & {
          context: ReviewContext;
        }) => {
      const inspection = inspect(project, request);
      if (inspection.kind === "refusal") {
        return { refusal: inspection.refusal };
      }
      const decided = resolutionRefusal(inspection.context, request);
      if ("refusal" in decided) {
        return decided;
      }
      const live = liveRefusal(
        project.name,
        request.issueNumber,
        request.runId
      );
      return live === undefined
        ? { ...decided, context: inspection.context }
        : { refusal: live };
    };
    const early = check();
    if ("refusal" in early) {
      return early.refusal;
    }

    const token = deps.resolveToken(project.tracker.token);
    if (token === undefined) {
      return {
        error: `projects.${request.projectName}.tracker.token is not available`,
        kind: "error"
      };
    }
    let rawIssue: Awaited<ReturnType<typeof tryGetIssue>>;
    try {
      rawIssue = await tryGetIssue(deps.githubIssuesApi, {
        issueNumber: request.issueNumber,
        owner: project.tracker.owner,
        repo: project.tracker.repo,
        signal: AbortSignal.timeout(timeoutMs),
        token
      });
    } catch (error) {
      return {
        error: `the Issue could not be read from GitHub: ${errorMessage(error)}`,
        kind: "error"
      };
    }
    if (rawIssue === undefined || rawIssue === null) {
      return {
        error: "the Issue could not be read from GitHub",
        kind: "error"
      };
    }
    if ((rawIssue.state ?? "open") !== "open") {
      return refuse(
        "issue-closed",
        "the Issue is closed; resuming it could repeat effects of states that already completed"
      );
    }
    const issue = normalizeIssueSnapshot(rawIssue, project);
    const held = heldClaimLabels(issue.labels);
    if (held.length > 0) {
      return refuse("claim-held", claimHeldMessage(held));
    }

    const interventionId = deps.createInterventionId();
    await deps.dispatchMutex.acquire();
    try {
      const decided = check();
      if ("refusal" in decided) {
        return decided.refusal;
      }
      const { context } = decided;
      try {
        deps.runStore.createProviderIntervention({
          fromProvider: context.recordedProvider,
          fromRunId: request.runId,
          id: interventionId,
          issueNumber: request.issueNumber,
          kind: "override_review",
          newDigest: request.newDigest,
          oldDigest: context.recorded.digest,
          projectName: project.name,
          repository: {
            owner: project.tracker.owner,
            repo: project.tracker.repo
          },
          requestedVia: request.requestedVia,
          resolution: decided.resolution,
          stateId: request.stateId,
          toProvider: decided.provider
        });
      } catch {
        return refuse(
          "duplicate",
          "a review of this Run is already being resolved"
        );
      }
      let scheduled: boolean;
      try {
        scheduled = deps.scheduleResume({
          interventionId,
          issue,
          override: decided.override,
          parentRunId: request.runId,
          projectName: project.name,
          toStateId: request.stateId
        });
      } catch (error) {
        deps.runStore.settleProviderIntervention(
          { id: interventionId },
          { error: errorMessage(error), outcome: "failed" }
        );
        return { error: errorMessage(error), kind: "error" };
      }
      if (!scheduled) {
        deps.runStore.settleProviderIntervention(
          { id: interventionId },
          { error: "the daemon is shutting down", outcome: "dropped" }
        );
        return refuse("shutting-down", "the daemon is shutting down");
      }
      return {
        fromRunId: request.runId,
        interventionId,
        kind: "accepted",
        provider: decided.provider,
        resolution: decided.resolution,
        stateId: request.stateId
      };
    } finally {
      deps.dispatchMutex.release();
    }
  }

  async function capturedGraphFor(
    run: RunStatus,
    stateId: string
  ): Promise<OverrideReviewPreview["capturedGraph"]> {
    let cursor: RunStatus | undefined = run;
    for (let depth = 0; cursor !== undefined && depth < 256; depth += 1) {
      const graph = await deps.runStore.getWorkflowGraph(cursor.id);
      if (graph !== undefined) {
        const state = graph.states.find((entry) => entry.id === stateId);
        return {
          contentHash: graph.contentHash,
          runId: cursor.id,
          stateDigest:
            state === undefined ? null : stateDefinitionEvidence(state).digest,
          workflowName: graph.name
        };
      }
      cursor =
        cursor.continuationParentRunId === null
          ? undefined
          : deps.runStore.getRun(cursor.continuationParentRunId);
    }
    return undefined;
  }

  async function preview(
    projectName: string,
    issueNumber: number
  ): Promise<OverrideReviewPreview | undefined> {
    await refreshConfig();
    const project = dispatchProject(projectName);
    const open = findOpenReview(projectName, issueNumber);
    if (project === undefined || open === undefined) {
      return undefined;
    }
    const request = {
      issueNumber,
      projectName,
      runId: open.runId,
      stateId: open.stateId
    };
    const inspection = inspect(project, request);
    if (inspection.kind === "refusal") {
      return undefined;
    }
    const { context } = inspection;
    const blockers: string[] = [];
    const stale = stateRefusal(context);
    if (stale?.kind === "refused") {
      blockers.push(stale.error);
    }
    const live = liveRefusal(projectName, issueNumber, open.runId);
    if (live?.kind === "refused") {
      blockers.push(live.error);
    }
    const snapshot = deps.runStore.getProjectIssueSnapshot(
      projectName,
      issueNumber
    );
    const held = heldClaimLabels(snapshot?.labels ?? []);
    if (held.length > 0) {
      blockers.push(claimHeldMessage(held));
    }
    const providers = availableProviders(deps);
    if (providers.length === 0) {
      blockers.push("no provider is configured and registered");
    }
    return {
      blockers,
      capturedGraph: await capturedGraphFor(context.run, open.stateId),
      chainProvider: context.chainProvider,
      changes:
        context.current === undefined
          ? []
          : diffStateDefinitions(
              context.recorded.definition,
              context.current.definition
            ),
      current: context.current,
      providers,
      recorded: context.recorded,
      recordedProvider: context.recordedProvider,
      repository: {
        owner: project.tracker.owner,
        repo: project.tracker.repo
      },
      run: context.run,
      stateId: open.stateId,
      workflowName: context.workflowName
    };
  }

  return { findOpenReview, preview, resolve };
}
