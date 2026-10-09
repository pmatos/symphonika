import {
  evaluateProjectEligibility,
  normalizeIssueSnapshot,
  tryAddLabelsToIssue,
  tryGetIssue,
  tryGetIssueDependencies,
  type GitHubIssuesApi
} from "../issue-polling.js";
import { isAgentProviderName } from "../human-resume-command.js";
import type { AsyncMutex } from "../lifecycle/async-mutex.js";
import {
  isDispatchProject,
  type DispatchProjectConfig,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "../lifecycle/run-controller.js";
import type { AgentProviderName } from "../provider.js";
import type { ProviderPlan, RunStore } from "../run-store.js";

const PROVIDER_CHOICES: readonly AgentProviderName[] = [
  "omp",
  "claude",
  "codex"
];

const DEFAULT_GITHUB_TIMEOUT_MS = 15_000;

type ProviderStartContext = {
  defaultProvider: AgentProviderName;
  graphFingerprint: string;
  providers: AgentProviderName[];
  readyLabel: string;
  repository: { owner: string; repo: string };
  workflowName: string;
};

export type ProviderStartPreview = {
  blockers: string[];
  context: ProviderStartContext;
  plan: ProviderPlan | undefined;
};

export type ProviderStartOutcome =
  | { kind: "started"; plan: ProviderPlan | undefined }
  | { kind: "refused"; error: string }
  | {
      kind: "label_write_failed";
      error: string;
      plan: ProviderPlan | undefined;
    }
  | {
      kind: "plan_withdrawn";
      error: string | undefined;
      labelWritten: boolean;
      status: ProviderPlan["status"];
    }
  | { kind: "cancelled" };

type StartIssueRequest = {
  graphFingerprint: string;
  issueNumber: number;
  projectName: string;
  provider: string;
  snapshotPolledAt: string;
  snapshotRepository: { owner: string; repo: string } | undefined;
};

type RetryProviderPlanRequest = {
  issueNumber: number;
  planId: string;
  projectName: string;
  snapshotRepository: { owner: string; repo: string } | undefined;
};

type CancelProviderPlanRequest = RetryProviderPlanRequest;

export type ProviderStartService = {
  cancel(input: CancelProviderPlanRequest): Promise<ProviderStartOutcome>;
  preview(
    projectName: string,
    issueNumber: number
  ): ProviderStartPreview | undefined;
  retry(input: RetryProviderPlanRequest): Promise<ProviderStartOutcome>;
  start(input: StartIssueRequest): Promise<ProviderStartOutcome>;
};

export type ProviderStartDeps = {
  checkLiveRun: (
    projectName: string,
    issueNumber: number
  ) => string | undefined;
  createPlanId: () => string;
  dispatchMutex: AsyncMutex;
  getProject: (name: string) => RunControllerProjectConfig | undefined;
  getProvidersConfig: () => RunControllerProvidersConfig;
  githubIssuesApi: GitHubIssuesApi;
  githubTimeoutMs?: number;
  isProviderRegistered: (name: AgentProviderName) => boolean;
  resolveToken: (tokenRef: string) => string | undefined;
  runStore: RunStore;
  verifySnapshotBinding: (input: {
    issueNumber: number;
    projectName: string;
    rendered: { owner: string; repo: string } | undefined;
  }) => string | undefined;
};

// Reasons an Issue cannot be started with a chain-wide provider choice.
// `snapshotReasons` are the poller's own ineligibility reasons for the Issue;
// the "missing required label" one is dropped because adding that label is
// precisely what Start does.
export function startBlockers(input: {
  labels: string[];
  liveRunId: string | undefined;
  plan: ProviderPlan | undefined;
  readyLabel: string;
  snapshotReasons: string[];
  suppressed: boolean;
}): string[] {
  const blockers = input.snapshotReasons.filter(
    (reason) => reason !== `missing required label ${input.readyLabel}`
  );
  if (hasLabel(input.labels, input.readyLabel)) {
    blockers.push(
      `already has the Ready Label ${input.readyLabel}; a provider choice made now would not be honored`
    );
  }
  if (input.liveRunId !== undefined) {
    blockers.push(`reserved by live run ${input.liveRunId}`);
  }
  if (input.suppressed) {
    blockers.push(
      "latest run ended blocked with no workspace changes; resolve that before starting again"
    );
  }
  if (input.plan?.status === "pending") {
    blockers.push(
      `provider plan ${input.plan.id} is still pending; cancel it or let it finish`
    );
  }
  return blockers;
}

function hasLabel(labels: string[], label: string): boolean {
  const wanted = label.toLowerCase();
  return labels.some((candidate) => candidate.toLowerCase() === wanted);
}

function sameRepository(
  left: { owner: string; repo: string },
  right: { owner: string; repo: string }
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LiveReadResult =
  | { kind: "ok"; hasReadyLabel: boolean; reasons: string[] }
  | { kind: "error"; error: string };

export function createProviderStartService(
  deps: ProviderStartDeps
): ProviderStartService {
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

  function contextFor(
    project: DispatchProjectConfig
  ): ProviderStartContext | undefined {
    const workflow = project.workflow;
    if (!("expandedWorkflow" in workflow)) {
      return undefined;
    }
    const providersConfig = deps.getProvidersConfig() as Partial<
      Record<AgentProviderName, { command: string }>
    >;
    return {
      defaultProvider: project.agent.provider,
      graphFingerprint: workflow.contentHash,
      providers: PROVIDER_CHOICES.filter(
        (name) =>
          (providersConfig[name]?.command ?? "").trim().length > 0 &&
          deps.isProviderRegistered(name)
      ),
      readyLabel: project.issue_filters.ready_label,
      repository: {
        owner: project.tracker.owner,
        repo: project.tracker.repo
      },
      workflowName: workflow.expandedWorkflow.name
    };
  }

  function activePlan(context: ProviderStartContext, issueNumber: number) {
    return deps.runStore.getActiveProviderPlan({
      issueNumber,
      repository: context.repository
    });
  }

  function preview(
    projectName: string,
    issueNumber: number
  ): ProviderStartPreview | undefined {
    const project = dispatchProject(projectName);
    if (project === undefined) {
      return undefined;
    }
    const context = contextFor(project);
    const snapshot = deps.runStore.getProjectIssueSnapshot(
      projectName,
      issueNumber
    );
    if (context === undefined || snapshot === undefined) {
      return undefined;
    }
    const plan = activePlan(context, issueNumber);
    return {
      blockers: startBlockers({
        labels: snapshot.labels,
        liveRunId: deps.checkLiveRun(projectName, issueNumber),
        plan,
        readyLabel: context.readyLabel,
        snapshotReasons: snapshot.reasons,
        suppressed: deps.runStore.latestRunSuppressesFreshDispatch({
          issueNumber,
          projectName,
          repository: context.repository
        })
      }),
      context,
      plan
    };
  }

  // Fails closed: an unreadable Issue or dependency list refuses the action.
  // Runs before dispatchMutex is taken, so a slow GitHub read can never stall
  // dispatch; with the Ready Label absent nothing can claim the Issue
  // meanwhile.
  async function readLive(
    project: DispatchProjectConfig,
    context: ProviderStartContext,
    issueNumber: number,
    token: string
  ): Promise<LiveReadResult> {
    const repository = {
      owner: context.repository.owner,
      repo: context.repository.repo,
      signal: AbortSignal.timeout(timeoutMs),
      token
    };
    try {
      const raw = await tryGetIssue(deps.githubIssuesApi, {
        ...repository,
        issueNumber
      });
      if (raw === undefined || raw === null) {
        return {
          error: "the Issue could not be read from GitHub",
          kind: "error"
        };
      }
      if (raw.pull_request !== undefined) {
        return {
          error: "#" + issueNumber + " is a pull request",
          kind: "error"
        };
      }
      const dependencies = await tryGetIssueDependencies(deps.githubIssuesApi, {
        ...repository,
        issueNumbers: [issueNumber]
      });
      if (dependencies === undefined) {
        return {
          error: "the Issue's dependency links could not be read from GitHub",
          kind: "error"
        };
      }
      const issue = normalizeIssueSnapshot(raw, project);
      const issueDependencies = dependencies.get(issueNumber);
      if (issueDependencies !== undefined) {
        issue.blockedBy = issueDependencies.blockedBy;
        issue.blockedByTruncated = issueDependencies.truncated;
      }
      const hasReadyLabel = hasLabel(issue.labels, context.readyLabel);
      const { reasons } = evaluateProjectEligibility(
        {
          ...issue,
          labels: hasReadyLabel
            ? issue.labels
            : [...issue.labels, context.readyLabel]
        },
        project
      );
      return { hasReadyLabel, kind: "ok", reasons };
    } catch (error) {
      return {
        error: `the Issue could not be checked on GitHub: ${errorMessage(error)}`,
        kind: "error"
      };
    }
  }

  function resolveRequestContext(
    projectName: string,
    issueNumber: number,
    snapshotRepository: { owner: string; repo: string } | undefined
  ):
    | {
        project: DispatchProjectConfig;
        context: ProviderStartContext;
        token: string;
      }
    | { error: string } {
    const project = dispatchProject(projectName);
    if (project === undefined) {
      return { error: `projects.${projectName} is not a dispatch project` };
    }
    const context = contextFor(project);
    if (context === undefined) {
      return {
        error: `projects.${projectName} has no loaded workflow to start against`
      };
    }
    const bindingError = deps.verifySnapshotBinding({
      issueNumber,
      projectName,
      rendered: snapshotRepository
    });
    if (bindingError !== undefined) {
      return { error: bindingError };
    }
    const token = deps.resolveToken(project.tracker.token);
    if (token === undefined) {
      return {
        error: `projects.${projectName}.tracker.token is not available`
      };
    }
    return { context, project, token };
  }

  // Records the label result under dispatchMutex: a claim holds the mutex from
  // its plan re-check through consumeProviderPlan, so a result landing in that
  // window (a timed-out write that actually reached GitHub) would otherwise
  // flip the plan it is about to consume. The write itself is conditional on
  // `pending`, so a claim or Cancel that already settled the plan is reported
  // as it actually is, never overwritten.
  async function settleLabelWrite(
    plan: ProviderPlan,
    failure: string | undefined
  ): Promise<ProviderStartOutcome> {
    await deps.dispatchMutex.acquire();
    try {
      deps.runStore.markProviderPlanLabelResult(
        plan.id,
        failure === undefined ? { ok: true } : { error: failure, ok: false }
      );
    } finally {
      deps.dispatchMutex.release();
    }
    const settled = deps.runStore.getProviderPlan(plan.id);
    if (settled?.status === "consumed") {
      return { kind: "started", plan: settled };
    }
    if (failure === undefined && settled?.status === "label_written") {
      return { kind: "started", plan: settled };
    }
    if (failure !== undefined && settled?.status === "label_failed") {
      return { error: failure, kind: "label_write_failed", plan: settled };
    }
    return {
      error: failure,
      kind: "plan_withdrawn",
      labelWritten: failure === undefined,
      status: settled?.status ?? plan.status
    };
  }

  async function writeReadyLabel(
    plan: ProviderPlan,
    context: ProviderStartContext,
    token: string
  ): Promise<ProviderStartOutcome> {
    let failure: string | undefined;
    try {
      const added = await tryAddLabelsToIssue(deps.githubIssuesApi, {
        ...context.repository,
        issueNumber: plan.issueNumber,
        labels: [context.readyLabel],
        signal: AbortSignal.timeout(timeoutMs),
        token
      });
      if (!added) {
        failure = "adding labels is not supported by the configured GitHub API";
      }
    } catch (error) {
      failure = errorMessage(error);
    }
    return settleLabelWrite(plan, failure);
  }

  function refuse(error: string): ProviderStartOutcome {
    return { error, kind: "refused" };
  }

  async function start(
    input: StartIssueRequest
  ): Promise<ProviderStartOutcome> {
    if (!isAgentProviderName(input.provider)) {
      return refuse(`${input.provider} is not a known provider`);
    }
    const provider = input.provider;
    const resolved = resolveRequestContext(
      input.projectName,
      input.issueNumber,
      input.snapshotRepository
    );
    if ("error" in resolved) {
      return refuse(resolved.error);
    }
    const { context, project, token } = resolved;
    if (!context.providers.includes(provider)) {
      return refuse(`${provider} is not configured and registered`);
    }
    if (input.graphFingerprint !== context.graphFingerprint) {
      return refuse(
        "the workflow changed since this preview was rendered; reload the preview"
      );
    }
    const snapshot = deps.runStore.getProjectIssueSnapshot(
      input.projectName,
      input.issueNumber
    );
    if (snapshot === undefined) {
      return refuse("the Issue has no snapshot; poll the Project first");
    }
    if (snapshot.polledAt !== input.snapshotPolledAt) {
      return refuse(
        "the Issue snapshot changed since this preview was rendered; reload the preview"
      );
    }

    const localBlockers = (): string[] =>
      startBlockers({
        labels: snapshot.labels,
        liveRunId: deps.checkLiveRun(input.projectName, input.issueNumber),
        plan: activePlan(context, input.issueNumber),
        readyLabel: context.readyLabel,
        snapshotReasons: snapshot.reasons,
        suppressed: deps.runStore.latestRunSuppressesFreshDispatch({
          issueNumber: input.issueNumber,
          projectName: input.projectName,
          repository: context.repository
        })
      });
    const early = localBlockers();
    if (early.length > 0) {
      return refuse(`cannot start: ${early.join("; ")}`);
    }

    const live = await readLive(project, context, input.issueNumber, token);
    if (live.kind === "error") {
      return refuse(live.error);
    }
    if (live.hasReadyLabel) {
      return refuse(
        `already has the Ready Label ${context.readyLabel} on GitHub; a provider choice made now would not be honored`
      );
    }
    if (live.reasons.length > 0) {
      return refuse(`cannot start: ${live.reasons.join("; ")}`);
    }

    let plan: ProviderPlan;
    await deps.dispatchMutex.acquire();
    try {
      const blockers = localBlockers();
      if (blockers.length > 0) {
        return refuse(`cannot start: ${blockers.join("; ")}`);
      }
      plan = deps.runStore.createProviderPlan({
        graphFingerprint: context.graphFingerprint,
        id: deps.createPlanId(),
        issueNumber: input.issueNumber,
        projectName: input.projectName,
        provider,
        readyLabel: context.readyLabel,
        repository: context.repository,
        snapshotPolledAt: input.snapshotPolledAt
      });
    } finally {
      deps.dispatchMutex.release();
    }
    return writeReadyLabel(plan, context, token);
  }

  async function retry(
    input: RetryProviderPlanRequest
  ): Promise<ProviderStartOutcome> {
    const resolved = resolveRequestContext(
      input.projectName,
      input.issueNumber,
      input.snapshotRepository
    );
    if ("error" in resolved) {
      return refuse(resolved.error);
    }
    const { context, project, token } = resolved;
    const plan = deps.runStore.getProviderPlan(input.planId);
    if (
      plan === undefined ||
      plan.issueNumber !== input.issueNumber ||
      !sameRepository(plan.repository, context.repository)
    ) {
      return refuse("the provider plan does not belong to this Issue");
    }
    if (plan.status !== "label_failed" && plan.status !== "expired") {
      return refuse(`provider plan is ${plan.status}; nothing to retry`);
    }
    if (plan.graphFingerprint !== context.graphFingerprint) {
      return refuse(
        "the workflow changed since this plan was made; cancel it and start again from a fresh preview"
      );
    }
    if (!context.providers.includes(plan.provider)) {
      return refuse(`${plan.provider} is no longer configured and registered`);
    }
    const live = await readLive(project, context, input.issueNumber, token);
    if (live.kind === "error") {
      return refuse(live.error);
    }
    if (live.reasons.length > 0) {
      return refuse(`cannot retry: ${live.reasons.join("; ")}`);
    }

    await deps.dispatchMutex.acquire();
    try {
      const liveRunId = deps.checkLiveRun(input.projectName, input.issueNumber);
      if (liveRunId !== undefined) {
        return refuse(`cannot retry: reserved by live run ${liveRunId}`);
      }
      if (!deps.runStore.reopenProviderPlan(plan.id)) {
        return refuse("the provider plan changed; reload the page");
      }
    } finally {
      deps.dispatchMutex.release();
    }
    const reopened = deps.runStore.getProviderPlan(plan.id);
    if (reopened === undefined) {
      return refuse("the provider plan disappeared");
    }
    if (live.hasReadyLabel) {
      return settleLabelWrite(reopened, undefined);
    }
    return writeReadyLabel(reopened, context, token);
  }

  async function cancel(
    input: CancelProviderPlanRequest
  ): Promise<ProviderStartOutcome> {
    const resolved = resolveRequestContext(
      input.projectName,
      input.issueNumber,
      input.snapshotRepository
    );
    if ("error" in resolved) {
      return refuse(resolved.error);
    }
    const { context, project, token } = resolved;
    const plan = deps.runStore.getProviderPlan(input.planId);
    if (
      plan === undefined ||
      plan.issueNumber !== input.issueNumber ||
      !sameRepository(plan.repository, context.repository)
    ) {
      return refuse("the provider plan does not belong to this Issue");
    }
    if (plan.status === "label_written") {
      const live = await readLive(project, context, input.issueNumber, token);
      if (live.kind === "error") {
        return refuse(live.error);
      }
      if (live.hasReadyLabel) {
        return refuse(
          `remove the Ready Label ${context.readyLabel} first; the plan is cancelled only once the Issue is no longer ready`
        );
      }
    }
    await deps.dispatchMutex.acquire();
    try {
      if (deps.runStore.getProviderPlan(plan.id)?.status !== plan.status) {
        return refuse("the provider plan changed; reload the page");
      }
      if (!deps.runStore.cancelProviderPlan(plan.id)) {
        const settled = deps.runStore.getProviderPlan(plan.id);
        return refuse(
          `provider plan is ${settled?.status ?? "gone"}; it can no longer be cancelled`
        );
      }
    } finally {
      deps.dispatchMutex.release();
    }
    return { kind: "cancelled" };
  }

  return { cancel, preview, retry, start };
}
