import { isAgentProviderName } from "../human-resume-command.js";
import {
  normalizeIssueSnapshot,
  sameIssueRepository,
  tryGetIssue,
  type GitHubIssuesApi,
  type IssueSnapshot
} from "../issue-polling.js";
import type { AsyncMutex } from "../lifecycle/async-mutex.js";
import { isAgentState } from "../lifecycle/chain-provider.js";
import {
  isDispatchProject,
  type DispatchProjectConfig,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "../lifecycle/run-controller.js";
import { findWorkflowState } from "../lifecycle/state-machine-dispatch.js";
import type { AgentProviderName } from "../provider.js";
import type {
  AttemptStatus,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";

const PROVIDER_CHOICES: readonly AgentProviderName[] = [
  "omp",
  "claude",
  "codex"
];

const DEFAULT_GITHUB_TIMEOUT_MS = 15_000;

// A Run that stopped and is waiting on a human. A `waiting` Run is not here on
// purpose: it is a live Run (it holds its claim, its PR and its schedule) and
// it sits at a wait or merge_pr state, which has no provider to change.
const RECOVERABLE_RUN_STATES: ReadonlySet<RunState> = new Set([
  "blocked",
  "failed",
  "input_required"
]);

// Labels that mean something other than a stopped Run still owns the Issue:
// a live Run elsewhere, or a claim that outlived its Run. Both are cleared by
// the operator (clear-stale-claim), never by a recovery.
const CLAIM_LABELS = ["sym:claimed", "sym:running", "sym:stale"] as const;

export type ProviderRecoveryRefusalReason =
  | "claim-held"
  | "duplicate"
  | "invalid-position"
  | "issue-closed"
  | "live-run"
  | "not-a-dispatch-project"
  | "position-mismatch"
  | "provider-unavailable"
  | "repository-mismatch"
  | "run-not-found"
  | "run-not-stopped"
  | "shutting-down"
  | "superseded"
  | "workflow-not-fsm";

export type ProviderRecoveryOutcome =
  | {
      kind: "accepted";
      fromRunId: string;
      interventionId: string;
      stateId: string;
      toProvider: AgentProviderName;
    }
  | {
      kind: "refused";
      error: string;
      liveRunId?: string;
      reason: ProviderRecoveryRefusalReason;
    }
  | { kind: "error"; error: string };

type RecoverStoppedStateRequest = {
  issueNumber: number;
  projectName: string;
  provider: string;
  // How the request reached the daemon. There is no operator identity to
  // record (ADR 0075 authenticates a request, not a person).
  requestedVia: string;
  // The stopped Run and the state the operator saw it stopped at. The state is
  // re-checked against the Run's own position, so a preview that has gone
  // stale cannot redirect a recovery.
  runId: string;
  stateId: string;
};

// What the operator reviews before confirming. Built from local state only
// (no GitHub call), so the Issue page can ask whether to offer a recovery on
// every render; the live Issue read happens when the operator confirms.
export type ProviderRecoveryPreview = {
  // Why the Issue cannot be recovered right now, in operator terms. Empty
  // means a confirm would be attempted; GitHub is still read live then.
  blockers: string[];
  // The provider the form proposes: the first available one other than the
  // stopped Run's, preferring the Project default.
  defaultProvider: AgentProviderName | undefined;
  lastAttempt: AttemptStatus | undefined;
  projectDefaultProvider: AgentProviderName;
  providers: AgentProviderName[];
  repository: { owner: string; repo: string };
  run: RunStatus;
  state: {
    actionKind: string | undefined;
    declaredProvider: AgentProviderName | undefined;
    id: string | undefined;
  };
  workflowName: string | undefined;
};

export function recoveryHttpStatus(
  outcome: ProviderRecoveryOutcome
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

export type ProviderRecoveryService = {
  preview(
    projectName: string,
    issueNumber: number
  ): ProviderRecoveryPreview | undefined;
  recover(
    request: RecoverStoppedStateRequest
  ): Promise<ProviderRecoveryOutcome>;
};

export type ProviderRecoveryDeps = {
  checkLiveRun: (
    projectName: string,
    issueNumber: number
  ) => string | undefined;
  createInterventionId: () => string;
  dispatchMutex: AsyncMutex;
  getProject: (name: string) => RunControllerProjectConfig | undefined;
  getProvidersConfig: () => RunControllerProvidersConfig;
  githubIssuesApi: GitHubIssuesApi;
  githubTimeoutMs?: number;
  hasPendingShutdownResume: (runId: string) => boolean;
  isProviderRegistered: (name: AgentProviderName) => boolean;
  resolveToken: (tokenRef: string) => string | undefined;
  runStore: RunStore;
  scheduleRecovery: (input: {
    interventionId: string;
    issue: IssueSnapshot;
    parentRunId: string;
    projectName: string;
    provider: AgentProviderName;
    toStateId: string;
  }) => boolean;
};

function claimHeldMessage(held: readonly string[]): string {
  return `the Issue still carries ${held.join(", ")}; clear the stale claim first, or wait for the live Run it belongs to`;
}

function heldClaimLabels(labels: readonly string[]): string[] {
  return CLAIM_LABELS.filter((claimLabel) =>
    labels.some((label) => label.toLowerCase() === claimLabel)
  );
}

function refuse(
  reason: ProviderRecoveryRefusalReason,
  error: string,
  liveRunId?: string
): ProviderRecoveryOutcome {
  return {
    error,
    kind: "refused",
    reason,
    ...(liveRunId === undefined ? {} : { liveRunId })
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Recovery of a stopped FSM state with a different provider (#863). The new
// Run is a Continuation of the stopped one, so it inherits the Run Chain, the
// FSM position, the branch and the Workspace; earlier states are never
// replayed. Modelled on adoptPullRequest: a live GitHub read outside
// dispatchMutex, then every local check repeated inside it. The launch itself
// is scheduled, not awaited, and takes the claim mutex later, so nothing here
// holds that mutex across a provider run.
export function createProviderRecoveryService(
  deps: ProviderRecoveryDeps
): ProviderRecoveryService {
  const timeoutMs = deps.githubTimeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;

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

  // Local checks that need no GitHub call and are cheap to repeat under the
  // mutex. Returns the refusal, or undefined when the Run may be recovered.
  function localRefusal(
    project: DispatchProjectConfig,
    request: RecoverStoppedStateRequest
  ): ProviderRecoveryOutcome | undefined {
    const run = deps.runStore.getRun(request.runId);
    if (
      run === undefined ||
      run.project !== request.projectName ||
      run.issueNumber !== request.issueNumber
    ) {
      return refuse("run-not-found", "no such Run for this Issue");
    }
    if (!RECOVERABLE_RUN_STATES.has(run.state)) {
      return refuse(
        "run-not-stopped",
        run.state === "waiting"
          ? "the Run is parked at a wait state and still owns the Issue; recovery re-enters agent states only"
          : `the Run is ${run.state}; only a failed, blocked or input_required Run can be recovered`
      );
    }
    if (run.currentStateId === null) {
      return refuse(
        "invalid-position",
        "the Run has no FSM position to re-enter (it reached a workflow terminal)"
      );
    }
    if (run.currentStateId !== request.stateId) {
      return refuse(
        "position-mismatch",
        `the Run stopped at ${run.currentStateId}, not ${request.stateId}; reload and review again`
      );
    }
    const workflow = project.workflow;
    if (
      !("expandedWorkflow" in workflow) ||
      workflow.expandedWorkflow.source.kind !== "raw_fsm"
    ) {
      return refuse(
        "workflow-not-fsm",
        "only a raw FSM workflow has per-state positions to recover"
      );
    }
    const state = findWorkflowState(
      workflow.expandedWorkflow,
      run.currentStateId
    );
    if (state === undefined || !isAgentState(state)) {
      return refuse(
        "invalid-position",
        `state ${run.currentStateId} is not an agent state in the current workflow`
      );
    }
    const origin = deps.runStore.getRunIssueRepository(run.id);
    if (origin !== undefined && !sameIssueRepository(origin, project.tracker)) {
      return refuse(
        "repository-mismatch",
        "the Run belongs to a different repository than the Project now tracks"
      );
    }
    if (!deps.runStore.isIssueHeadRun(run.id)) {
      return refuse(
        "superseded",
        "a later Run exists for this Issue; recovering this one would replay completed work"
      );
    }
    return undefined;
  }

  function liveRefusal(
    projectName: string,
    request: RecoverStoppedStateRequest
  ): ProviderRecoveryOutcome | undefined {
    const liveRunId = deps.checkLiveRun(projectName, request.issueNumber);
    if (liveRunId !== undefined) {
      return refuse(
        "live-run",
        `the Issue is reserved by live Run ${liveRunId}; a provider cannot be switched while work is executing or scheduled`,
        liveRunId
      );
    }
    if (deps.hasPendingShutdownResume(request.runId)) {
      return refuse(
        "live-run",
        "the Run is already being resumed after a shutdown"
      );
    }
    return undefined;
  }

  async function recover(
    request: RecoverStoppedStateRequest
  ): Promise<ProviderRecoveryOutcome> {
    const project = dispatchProject(request.projectName);
    if (project === undefined) {
      return refuse(
        "not-a-dispatch-project",
        `projects.${request.projectName} is not a dispatch project`
      );
    }
    const provider = request.provider;
    if (
      !isAgentProviderName(provider) ||
      !availableProviders().includes(provider)
    ) {
      return refuse(
        "provider-unavailable",
        `${provider} is not a configured and registered provider`
      );
    }
    const early =
      localRefusal(project, request) ?? liveRefusal(project.name, request);
    if (early !== undefined) {
      return early;
    }

    const token = deps.resolveToken(project.tracker.token);
    if (token === undefined) {
      return {
        error: `projects.${request.projectName}.tracker.token is not available`,
        kind: "error"
      };
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      signal: AbortSignal.timeout(timeoutMs),
      token
    };
    let rawIssue: Awaited<ReturnType<typeof tryGetIssue>>;
    try {
      rawIssue = await tryGetIssue(deps.githubIssuesApi, {
        ...repository,
        issueNumber: request.issueNumber
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
        "the Issue is closed; recovering it could repeat effects of states that already completed"
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
      const refusal =
        localRefusal(project, request) ?? liveRefusal(project.name, request);
      if (refusal !== undefined) {
        return refusal;
      }
      const run = deps.runStore.getRun(request.runId);
      try {
        deps.runStore.createProviderIntervention({
          fromProvider: run?.provider ?? null,
          fromRunId: request.runId,
          id: interventionId,
          issueNumber: request.issueNumber,
          kind: "recovery",
          projectName: project.name,
          repository: {
            owner: project.tracker.owner,
            repo: project.tracker.repo
          },
          requestedVia: request.requestedVia,
          stateId: request.stateId,
          toProvider: provider
        });
      } catch {
        return refuse(
          "duplicate",
          "a recovery of this Run is already in progress"
        );
      }
      let scheduled: boolean;
      try {
        scheduled = deps.scheduleRecovery({
          interventionId,
          issue,
          parentRunId: request.runId,
          projectName: project.name,
          provider,
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
    } finally {
      deps.dispatchMutex.release();
    }
    return {
      fromRunId: request.runId,
      interventionId,
      kind: "accepted",
      stateId: request.stateId,
      toProvider: provider
    };
  }

  function availableProviders(): AgentProviderName[] {
    const providersConfig = deps.getProvidersConfig() as Partial<
      Record<AgentProviderName, { command: string }>
    >;
    return PROVIDER_CHOICES.filter(
      (name) =>
        (providersConfig[name]?.command ?? "").trim().length > 0 &&
        deps.isProviderRegistered(name)
    );
  }

  // The candidate is the Issue's newest Run: recovery only ever re-enters the
  // head of the history, and localRefusal says why a newer Run supersedes an
  // older one. A preview exists whenever the Issue has a Run to describe, even
  // one that cannot be recovered, so the page can say why.
  function preview(
    projectName: string,
    issueNumber: number
  ): ProviderRecoveryPreview | undefined {
    const project = dispatchProject(projectName);
    const run = deps.runStore.listRuns({
      issueNumber,
      limit: 1,
      project: projectName
    })[0];
    if (project === undefined || run === undefined) {
      return undefined;
    }
    const request = {
      issueNumber,
      projectName,
      provider: "",
      requestedVia: "preview",
      runId: run.id,
      stateId: run.currentStateId ?? ""
    };
    const blockers: string[] = [];
    const local = localRefusal(project, request);
    if (local?.kind === "refused") {
      blockers.push(local.error);
    }
    const live = liveRefusal(projectName, request);
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
    const providers = availableProviders();
    if (providers.length === 0) {
      blockers.push("no provider is configured and registered");
    }
    const workflow = project.workflow;
    const expanded =
      "expandedWorkflow" in workflow ? workflow.expandedWorkflow : undefined;
    const state =
      run.currentStateId === null || expanded === undefined
        ? undefined
        : findWorkflowState(expanded, run.currentStateId);
    const projectDefaultProvider = project.agent.provider;
    const alternatives = providers.filter((name) => name !== run.provider);
    const defaultProvider = alternatives.includes(projectDefaultProvider)
      ? projectDefaultProvider
      : (alternatives[0] ?? providers[0]);
    return {
      blockers,
      defaultProvider,
      lastAttempt: deps.runStore.listAttempts(run.id).at(-1),
      projectDefaultProvider,
      providers,
      repository: {
        owner: project.tracker.owner,
        repo: project.tracker.repo
      },
      run,
      state: {
        actionKind: state?.action?.kind,
        declaredProvider:
          state !== undefined && isAgentState(state)
            ? state.action?.provider
            : undefined,
        id: run.currentStateId ?? undefined
      },
      workflowName: expanded?.name
    };
  }

  return { preview, recover };
}
