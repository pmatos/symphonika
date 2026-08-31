import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type {
  GitHubIssueLabelInput,
  GitHubIssueRepositoryInput,
  GitHubIssuesApi,
  IssuePollStatus,
  IssueSnapshot,
  PollingProjectConfig,
  RawGitHubPullRequestReviewThread
} from "../issue-polling.js";
import {
  tryGetIssue,
  tryGetIssueDependencies,
  tryGetPullRequestFollowupState,
  tryMergePullRequest
} from "../issue-polling.js";
import {
  DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
  pullRequestReadyToMerge,
  reviewContextFromState,
  type PullRequestFollowupPolicy
} from "../pull-request-followup.js";
import {
  compareCandidateIssues,
  normalizeLabels,
  normalizeProjectWeight,
  priorityForLabels
} from "../issue-priority.js";
import { providerStderrLogPath } from "../providers/provider-stderr.js";
import {
  interpretPullRequest,
  type PullRequestState
} from "../pull-request-state.js";
import { evaluateRunContinuationEligibility } from "./issue-eligibility.js";
import { projectPullRequestSignals } from "./pr-signal-projection.js";
import type {
  AgentProvider,
  AgentProviderName,
  AgentProviderRegistry,
  NormalizedProviderEvent,
  ProviderEvent
} from "../provider.js";
import type { CancelReason, ProgressEdge, RunStore } from "../run-store.js";
import { WATCHDOG_TERMINAL_REASONS } from "../run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../workspace.js";
import { prepareIssueWorkspace as defaultPrepareIssueWorkspace } from "../workspace.js";
import { readFile } from "node:fs/promises";

import type { WorkflowReference } from "../config-schemas.js";
import type { TargetedRoutineDeclaration } from "../routines/types.js";
import {
  persistRunEvidence,
  renderAutonomousPrompt
} from "../workflow/autonomous-prompt.js";
import {
  parseWorkflowContract,
  type WorkflowEvidence
} from "../workflow/contract-loading.js";
import { expandWorkflowDefinition } from "../workflow/fsm-expansion.js";
import { workflowPredicateEvaluation } from "../workflow/predicates.js";
import type {
  ExpandedWorkflow,
  ExpandedWorkflowState,
  WorkflowAction,
  WorkflowPredicateMap
} from "../workflow/types.js";

import {
  ActiveRunRegistry,
  CANCEL_REASONS,
  computeRetryDelayMs,
  LIFECYCLE_POLICY,
  RegistryShutdownError,
  type LifecyclePolicy
} from "./active-runs.js";
import { probeStateArtifacts, statePredicateKeys } from "./artifact-probe.js";
import {
  buildEdgeBudgetExhaustedReason,
  buildNoProgressReason,
  DEFAULT_PROGRESS_GUARD_MAX_EDGE_CLAIMS,
  parseEdgeBudgetExhaustedReason,
  parseNoProgressReason,
  progressFingerprint
} from "./progress-fingerprint.js";
import { createAsyncMutex, type AsyncMutex } from "./async-mutex.js";
import { classifyCapReachedOutcome } from "./cap-reached-context.js";
import {
  evaluateConcurrencyCapacity,
  isGlobalCapReached,
  isProjectCapReached
} from "./concurrency-capacity.js";
import {
  classifyFailure,
  inspectWorkspaceHead,
  type ClassifiedTerminal
} from "./classify-failure.js";
import {
  fuseTerminalLabel,
  fuseWorkflowTerminal,
  isBlockedOutcome,
  mapOutcomeToRunState,
  narrowTerminalLabel,
  signalsFromTerminal,
  type TerminalLabel
} from "./outcome-projection.js";
import { DispatchFileOverlapGuard } from "./file-overlap-guard.js";
import type { HostPressureGate, HostPressureVerdict } from "./host-pressure.js";
import {
  createProviderScratch,
  removeProviderScratch
} from "./provider-scratch.js";
import { decideNextStep, findWorkflowState } from "./state-machine-dispatch.js";
import { buildCapReachedReason } from "./terminal-reason.js";

export type WorkflowSnapshot = {
  body: string;
  contentHash: string;
  evidence: WorkflowEvidence;
  expandedWorkflow: ExpandedWorkflow;
  format: WorkflowReference["format"];
  path: string;
};

type LoadedWorkflow = {
  body: string;
  contentHash: string;
  evidence: WorkflowEvidence;
  errors: string[];
  expandedWorkflow: ExpandedWorkflow;
  format: WorkflowReference["format"];
  path: string;
};

export type RunControllerProjectConfig = {
  mode: "dispatch" | "routine_host";
  name: string;
  disabled?: boolean | undefined;
  weight?: number | undefined;
  // Per-project concurrency cap. Omitted defaults to 1 at consume-time.
  // See ADR 0053.
  max_in_flight?: number | undefined;
  dispatch?: PollingProjectConfig["dispatch"] | undefined;
  // Required for Dispatch Projects; optional for Routine Hosts (required when
  // the host targets kind: git firings — enforced at reload). The issue
  // dispatch path reads tracker only for projects that produced polling
  // candidates, which Routine Hosts never do. See ADR 0062.
  tracker?: PollingProjectConfig["tracker"] | undefined;
  // Dispatch-only. Routine Hosts have no issue filters, priority, or workflow.
  issue_filters?: PollingProjectConfig["issue_filters"] | undefined;
  priority?: PollingProjectConfig["priority"] | undefined;
  // Project-owned bound for changing park-mediated cycles. Zero disables the
  // absolute budget while leaving identical-observation fingerprinting live.
  progressGuard?: { maxClaimsPerEdge: number } | undefined;
  agent: { provider: AgentProviderName } & Record<string, unknown>;
  workspace: {
    git: {
      base_branch: string;
      remote: string;
    };
    root: string;
  };
  // Dispatch-only. A Routine Host has no workflow contract.
  workflow?: WorkflowReference | WorkflowSnapshot | undefined;
  // Service-level routines targeting this Project. Present on every Project
  // entry in the runtime map; empty array when none target it. See ADR 0063.
  routines?: TargetedRoutineDeclaration[] | undefined;
  // Names of routines targeting this Project whose current reload is invalid
  // and has no prior valid snapshot to carry forward. Protects their store
  // rows (state = 'invalid') from being soft-disabled as "removed from
  // config" by the next syncRoutines call — see ADR 0060.
  invalidRoutineNames?: string[] | undefined;
  // kind: git routines rejected because this Routine Host has no tracker.
  // Persisted rows are soft-disabled with a precise reason so stale
  // executable configuration cannot keep firing, and first-seen rejections
  // persist a disabled row so a later tracker restoration follows the normal
  // one-shot/cron restore rules. See ADR 0066.
  trackerlessGitRoutines?: TargetedRoutineDeclaration[] | undefined;
  // Routines whose resolved model/effort the resolved provider's command
  // template never references (or whose resolved template is malformed).
  // Persisted rows are soft-disabled with a precise reason so a
  // still-configured routine is never mistaken for one removed from
  // routines:, mirroring trackerlessGitRoutines above. See ADR 0067.
  templateRejectedRoutines?: TargetedRoutineDeclaration[] | undefined;
  watchdog?:
    | {
        graceMinutes?: number;
        maxRunMinutes?: number;
        outputTokenBudget?: number;
      }
    | undefined;
};

// A Dispatch Project's runtime config: the issue-dispatch fields are required.
// The issue-dispatch path (dispatchOneFresh, continuation, state advance,
// review follow-up) only ever sees Dispatch Projects — Routine Hosts produce
// no polling candidates and own no issues — so entry points narrow to this
// type before reading tracker/workflow/issue_filters/priority. See ADR 0062.
export type DispatchProjectConfig = RunControllerProjectConfig & {
  mode: "dispatch";
  tracker: NonNullable<RunControllerProjectConfig["tracker"]>;
  issue_filters: NonNullable<RunControllerProjectConfig["issue_filters"]>;
  priority: NonNullable<RunControllerProjectConfig["priority"]>;
  workflow: NonNullable<RunControllerProjectConfig["workflow"]>;
};

export function isDispatchProject(
  project: RunControllerProjectConfig
): project is DispatchProjectConfig {
  return (
    project.mode === "dispatch" &&
    project.tracker !== undefined &&
    project.issue_filters !== undefined &&
    project.priority !== undefined &&
    project.workflow !== undefined
  );
}

export type RunControllerProvidersConfig = {
  codex: { command: string };
  claude: { command: string };
  omp?: { command: string };
};

export type ScheduleHandler = (input: {
  delayMs: number;
  fire: () => Promise<void>;
  issueNumber: number;
  kind: "retry" | "continuation" | "state_advance" | "wait_park";
  projectName: string;
  runId: string;
}) => void;

export type RunControllerOptions = {
  activeRuns: ActiveRunRegistry;
  agentProviders: AgentProviderRegistry;
  configDir: string;
  createRunId?: () => string;
  // Mutex that guards the narrowed dispatch claim section (candidate
  // selection + sym:claimed label + scheduler-cursor write + createRun +
  // reserveSlot). Released BEFORE runAttemptLifecycle streams provider
  // events. Daemon and one-shot CLI pass their own instance so reconcile
  // gates (reconcileWaitingRuns, stale-claims) can still consult it. See
  // ADR 0052.
  dispatchMutex?: AsyncMutex;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  // Returns the global concurrency cap (undefined = unbounded). Per-project
  // caps are read from the project config inside the picker. See ADR 0053.
  globalConcurrencyLoader?: () => Promise<{ maxInFlight: number | undefined }>;
  // Host pressure-stall admission gate (ADR 0088). Omitted means the
  // controller never defers on host state — the one-shot CLI's posture,
  // matching how it already ignores max_in_flight.
  hostPressureGate?: HostPressureGate;
  lifecyclePolicy?: LifecyclePolicy;
  logger?: Logger;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  projectsLoader: () => Promise<Map<string, RunControllerProjectConfig>>;
  providersLoader: () => Promise<RunControllerProvidersConfig>;
  pullRequestPolicyLoader?: () => Promise<PullRequestFollowupPolicy>;
  runStore: RunStore;
  schedule: ScheduleHandler;
  stateRoot: string;
};

export type DispatchOneFreshResult =
  { dispatched: false; reason: string } | { dispatched: true; runId: string };

export type DispatchOneFreshOptions = {
  isClaimAllowed?: (project: DispatchProjectConfig) => boolean;
};

export type ReviewFollowupContext = {
  headSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  reviewDecision: string | null;
  statusCheckRollupState: string | null;
  unresolvedThreads: RawGitHubPullRequestReviewThread[];
};

type DispatchTarget = {
  candidate: { issue: IssueSnapshot; project: string };
  project: RunControllerProjectConfig;
  provider: AgentProvider;
  schedulerWeights: Array<{
    currentWeight: number;
    projectName: string;
    weight: number;
  }>;
};

type LabelWritingGitHubIssuesApi = GitHubIssuesApi & {
  addLabelsToIssue: (input: GitHubIssueLabelInput) => Promise<void>;
  removeLabelsFromIssue: (input: GitHubIssueLabelInput) => Promise<void>;
};

type RunRuntime = {
  attemptId: string;
  attemptNumber: number;
  events: NormalizedProviderEvent[];
};

type StartedAttempt = {
  evidence: AttemptEvidence;
  prepared: PreparedIssueWorkspace;
  prompt: string;
  promptPath: string;
};

type AttemptEvidence = {
  branchName: string;
  branchRef: string;
  issueSnapshotPath: string;
  metadataPath: string;
  normalizedLogPath: string;
  promptPath: string;
  rawLogPath: string;
  workflowGraphPath: string;
  workspacePath: string;
};

type ApplyLabelsInput = {
  cancelReason?: CancelReason;
  // True when applyWorkflowOutcome advanced the raw-FSM walk to a non-terminal
  // next state or parked into a wait/merge_pr action. The per-state
  // ClassifiedTerminal may still be `failed` (e.g. a planning step that
  // exited provider_success=true without committing → no_workspace_changes,
  // which isBlockedOutcome would otherwise map to `sym:blocked`), but the
  // workflow as a whole is continuing — so neither `sym:failed` nor
  // `sym:blocked` must be added on this transition or the issue will stay
  // externally marked failed/blocked even after a later state succeeds
  // (subsequent applyTerminalLabels calls only remove `sym:running`).
  fsmContinuing: boolean;
  issueNumber: number;
  outcome: ClassifiedTerminal;
  repository: GitHubIssueRepositoryInput;
  willRetry: boolean;
};

type RetryPayload = {
  attemptNumber: number;
  extraInstructions?: string;
  issue: IssueSnapshot;
  projectName: string;
  // Carry the provider chosen for this run (which may be a per-state override
  // from a raw FSM action.provider) so the retry executes the same provider
  // and command, not the project default. Without this, a state declaring
  // action.provider: claude in a project whose default is codex would retry
  // on codex and produce inconsistent prompts/evidence.
  providerCommand: string;
  providerName: AgentProviderName;
  // When false (raw FSM mid-walk runs), executeRetry skips the labels_all /
  // labels_none re-check so a transient provider failure stays recoverable
  // even when labels drift during the FSM walk. CLOSED_ISSUE still cancels.
  // See ADR 0046.
  respectsIssueLabels?: boolean;
  runId: string;
};

type ContinuationPayload = {
  issue: IssueSnapshot;
  parentRunId: string;
  projectName: string;
  // Preserve the parent Run's Continuation Eligibility ownership while the
  // one-shot callback is delayed. Label-immune PR Follow-up work must not
  // release its claim solely because labels drift before the callback fires.
  respectsIssueLabels?: boolean;
};

type StateAdvancePayload = {
  // Rendered by the park that scheduled this advance, from the observation it
  // decided on. A repair state reached because reviewers left feedback needs
  // the thread bodies in its prompt; nothing downstream re-fetches them.
  extraInstructions?: string;
  issue: IssueSnapshot;
  parentRunId: string;
  projectName: string;
  // Set only by scheduleShutdownResume. It makes executeStateAdvance's
  // contention reschedule re-arm through that same wrapper, so the resume
  // stays accounted for across every retry. See hasPendingShutdownResume.
  shutdownResume?: boolean;
  toStateId: string;
};

// What one park re-evaluation observed. `pullRequestState` is absent for a
// wait decided from the Workspace alone (ADR 0087), where there is no tracked
// pull request to observe. Distinct from `undefined`, which the observation
// returns to mean "stay parked, nothing to decide this tick".
// Whether a run on this workflow keeps its Issue-label eligibility checks.
// A raw FSM is FSM-governed: the state machine, not the label set, decides
// whether the agent keeps running, and an agent state legitimately removes
// `agent-ready` as it works. Markdown compatibility graphs stay label-driven.
// One definition, because both the claim (executeStateAdvance) and the attempt
// (runAttemptLifecycle's fallback) have to answer it identically. See ADR 0046.
function respectsIssueLabelsFor(expandedWorkflow: ExpandedWorkflow): boolean {
  return expandedWorkflow.source.kind !== "raw_fsm";
}

type WaitObservation = {
  pullRequestState?: PullRequestState;
  signals: WorkflowPredicateMap;
};

type WorkflowOutcomeResult = {
  advancedToState: string | null;
  advancedToTerminal: boolean;
  blocked: boolean;
  parkAsWait?: boolean;
  terminalLabel?: TerminalLabel;
  waitingRunId?: string;
};

type WaitParkPayload = {
  waitingRunId: string;
};

// Thrown by claimAndPersistRun's in-mutex re-check when a concurrent
// dispatch already filled the last available slot, when the same (project,
// issue) was reserved, or when a newly reserved Run created known file
// overlap before this claim reached claimAndPersistRun. Callers handle these
// as "skip this fire": fresh dispatch silently no-ops (next tick will pick
// again); scheduled paths (continuation / state advance / retry / review
// followup) reschedule the callback. See ADR 0053 / ADR 0085.
class CapBreachedError extends Error {
  readonly name = "CapBreachedError";
}

class IssueReservedError extends Error {
  readonly name = "IssueReservedError";
}

class FileOverlapDetectedError extends Error {
  readonly name = "FileOverlapDetectedError";
}

class FreshClaimDeferredError extends Error {
  readonly name = "FreshClaimDeferredError";
}

export class RunController {
  private readonly activeRuns: ActiveRunRegistry;
  private readonly agentProviders: AgentProviderRegistry;
  private readonly configDir: string;
  private readonly createRunId: () => string;
  private readonly dispatchMutex: AsyncMutex;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fileOverlapGuard: DispatchFileOverlapGuard;
  private readonly githubIssuesApi: GitHubIssuesApi;
  private readonly globalConcurrencyLoader: () => Promise<{
    maxInFlight: number | undefined;
  }>;
  private readonly hostPressureGate: HostPressureGate | undefined;
  private readonly lifecyclePolicy: LifecyclePolicy;
  private readonly logger?: Logger;
  private readonly prepareIssueWorkspace: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  private readonly projectsLoader: () => Promise<
    Map<string, RunControllerProjectConfig>
  >;
  private readonly providersLoader: () => Promise<RunControllerProvidersConfig>;
  private readonly pullRequestPolicyLoader: () => Promise<PullRequestFollowupPolicy>;
  private readonly runStore: RunStore;
  private readonly schedule: ScheduleHandler;
  // Parent Run id -> number of scheduled-but-unsettled shutdown resume
  // callbacks for it. A count rather than a set because a contention retry
  // re-arms before the callback it replaces has unwound, and a set would let
  // the outgoing callback's release erase the incoming one's claim. See
  // hasPendingShutdownResume.
  private readonly shutdownResumesPending = new Map<string, number>();
  private readonly stateRoot: string;

  constructor(options: RunControllerOptions) {
    this.activeRuns = options.activeRuns;
    this.agentProviders = options.agentProviders;
    this.configDir = options.configDir;
    this.createRunId = options.createRunId ?? randomUUID;
    this.dispatchMutex = options.dispatchMutex ?? createAsyncMutex();
    this.env = options.env ?? process.env;
    this.fileOverlapGuard = new DispatchFileOverlapGuard({
      activeRuns: options.activeRuns,
      configDir: options.configDir,
      env: this.env,
      githubIssuesApi: options.githubIssuesApi,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      runStore: options.runStore
    });
    this.githubIssuesApi = options.githubIssuesApi;
    this.globalConcurrencyLoader =
      options.globalConcurrencyLoader ??
      ((): Promise<{ maxInFlight: number | undefined }> =>
        Promise.resolve({ maxInFlight: undefined }));
    this.hostPressureGate = options.hostPressureGate;
    this.lifecyclePolicy = options.lifecyclePolicy ?? LIFECYCLE_POLICY;
    if (options.logger !== undefined) {
      this.logger = options.logger;
    }
    this.prepareIssueWorkspace =
      options.prepareIssueWorkspace ?? defaultPrepareIssueWorkspace;
    this.projectsLoader = options.projectsLoader;
    this.providersLoader = options.providersLoader;
    this.pullRequestPolicyLoader =
      options.pullRequestPolicyLoader ??
      ((): Promise<PullRequestFollowupPolicy> =>
        Promise.resolve(DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY));
    this.runStore = options.runStore;
    this.schedule = options.schedule;
    this.stateRoot = options.stateRoot;
  }

  // Re-samples at most once per configured interval (createHostPressureGate
  // owns the TTL), so a candidate loop pays one /proc read per interval
  // rather than one per candidate. An absent gate admits.
  private async refreshHostPressure(): Promise<HostPressureVerdict> {
    if (this.hostPressureGate === undefined) {
      return { admitted: true };
    }
    return this.hostPressureGate.refresh();
  }

  async dispatchOneFresh(
    pollStatus: IssuePollStatus,
    options: DispatchOneFreshOptions = {}
  ): Promise<DispatchOneFreshResult> {
    // Host pressure first: a stalled host makes every candidate
    // undispatchable regardless of how much count-headroom the caps leave,
    // so refusing here also skips the overlap guard's GitHub round-trips.
    // The reason names the machine, not the config. See ADR 0088.
    const pressure = await this.refreshHostPressure();
    if (!pressure.admitted) {
      this.logger?.info(
        {
          observed: pressure.observed,
          resource: pressure.resource,
          threshold: pressure.threshold
        },
        "symphonika dispatch deferred: host pressure"
      );
      return { dispatched: false, reason: pressure.reason };
    }
    // Snapshot candidates before any await so a concurrent poll cannot wipe them.
    const candidates = pollStatus.candidateIssues.slice();
    const projects = await this.projectsLoader();
    const providersConfig = await this.providersLoader();
    const target = await this.pickTargetFromCandidates(candidates, projects);
    if (target === undefined) {
      return {
        dispatched: false,
        reason: "no eligible issue has a registered provider"
      };
    }

    // Routine Hosts never produce polling candidates, so a selected target
    // is always a Dispatch Project. The guard is unreachable in practice but
    // narrows target.project for the tracker/workflow reads below. See ADR 0062.
    if (!isDispatchProject(target.project)) {
      return {
        dispatched: false,
        reason: `project ${target.project.name} is not a dispatch project`
      };
    }

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return {
        dispatched: false,
        reason: "GitHub tracker does not support operational label writes"
      };
    }

    const token = resolveTokenFromEnv(target.project.tracker.token, this.env);
    if (token === undefined) {
      return {
        dispatched: false,
        reason: `projects.${target.project.name}.tracker.token is not available`
      };
    }

    const runId = this.createRunId();
    const repository = {
      owner: target.project.tracker.owner,
      repo: target.project.tracker.repo,
      token
    };
    const claimProject = target.project;
    const isClaimAllowed = options.isClaimAllowed;
    const claimGuard =
      isClaimAllowed === undefined
        ? undefined
        : () => isClaimAllowed(claimProject);

    // Honor action.provider on the initial raw-FSM state, matching the
    // per-state routing executeStateAdvance applies to subsequent advances.
    // runAttemptLifecycle reloads the workflow downstream regardless, so
    // loading it once here pays only on actually-selected dispatches. Falls
    // back to the project default for contract workflows or when the
    // initial agent action declares no provider.
    let initialAction: WorkflowAction | undefined;
    try {
      const loaded = await this.loadWorkflow(target.project.workflow);
      if (
        loaded.errors.length === 0 &&
        loaded.expandedWorkflow.source.kind === "raw_fsm"
      ) {
        const initialState = findWorkflowState(
          loaded.expandedWorkflow,
          loaded.expandedWorkflow.initial
        );
        if (initialState?.action !== undefined) {
          initialAction = initialState.action;
        }
      }
    } catch {
      // Workflow load failure falls back to the project default; the same
      // error surfaces from runAttemptLifecycle's reload during the attempt.
    }

    const providerName =
      initialAction?.kind === "agent" && initialAction.provider !== undefined
        ? initialAction.provider
        : target.project.agent.provider;
    const providerCommand = (
      providersConfig as Partial<RunControllerProvidersConfig>
    )[providerName]?.command;

    try {
      if (
        providerCommand === undefined ||
        providerCommand.trim().length === 0
      ) {
        await this.failFreshDispatchBeforeProvider({
          ...(claimGuard === undefined ? {} : { claimGuard }),
          issue: target.candidate.issue,
          project: target.project,
          providerCommand: providerCommand ?? "",
          providerName,
          reason: `provider_command_missing: ${providerName}`,
          repository,
          runId
        });
        return { dispatched: true, runId };
      }

      const provider = this.agentProviders[providerName];
      if (provider === undefined) {
        await this.failFreshDispatchBeforeProvider({
          ...(claimGuard === undefined ? {} : { claimGuard }),
          issue: target.candidate.issue,
          project: target.project,
          providerCommand,
          providerName,
          reason: `provider_not_registered: ${providerName}`,
          repository,
          runId
        });
        return { dispatched: true, runId };
      }

      await this.runFreshLifecycle({
        attemptNumber: 1,
        ...(claimGuard === undefined ? {} : { claimGuard }),
        isContinuation: false,
        issue: target.candidate.issue,
        parentRunId: null,
        project: target.project,
        provider,
        providerCommand,
        providerName,
        repository,
        runId,
        schedulerWeights: target.schedulerWeights,
        verifyFileOverlap: target.project.dispatch?.overlap_guard === true
      });
    } catch (error) {
      if (error instanceof RegistryShutdownError) {
        this.logger?.debug(
          { reason: error.message, runId },
          "symphonika fresh dispatch skipped: daemon shutting down"
        );
        return { dispatched: false, reason: error.message };
      }
      if (
        error instanceof CapBreachedError ||
        error instanceof FileOverlapDetectedError ||
        error instanceof IssueReservedError ||
        error instanceof FreshClaimDeferredError
      ) {
        // A concurrent dispatch may have taken the slot or introduced known
        // overlap between the lock-free picker and claimAndPersistRun's
        // in-mutex re-check, or a caller-owned admission guard may have closed
        // in that same window. A later tick can reconsider the candidate once
        // the gate clears. See ADR 0053 / ADR 0083 / ADR 0085.
        this.logger?.debug(
          { reason: error.message, runId },
          "symphonika fresh dispatch skipped at claim boundary"
        );
        return { dispatched: false, reason: error.message };
      }
      throw error;
    }

    return { dispatched: true, runId };
  }

  private async failFreshDispatchBeforeProvider(input: {
    claimGuard?: () => boolean;
    issue: IssueSnapshot;
    project: RunControllerProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    reason: string;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    if (this.activeRuns.isShuttingDown()) {
      throw new RegistryShutdownError(
        `daemon is shutting down; refusing to claim issue ${input.project.name}#${input.issue.number}`
      );
    }
    if (input.claimGuard?.() === false) {
      throw new FreshClaimDeferredError(
        `fresh issue claim deferred for project ${input.project.name}`
      );
    }
    await this.bestEffort(
      () =>
        (this.githubIssuesApi as LabelWritingGitHubIssuesApi).addLabelsToIssue({
          ...input.repository,
          issueNumber: input.issue.number,
          labels: ["sym:claimed"]
        }),
      {
        issueNumber: input.issue.number,
        label: "sym:claimed",
        operation: "addLabel",
        phase: "fresh-dispatch-provider-resolution",
        project: input.project.name,
        runId: input.runId
      }
    );
    if (this.activeRuns.isShuttingDown()) {
      // The provider-resolution failure path does not reserve an in-flight
      // slot, so reserveSlot cannot reject a shutdown-racing claim for it.
      // Roll back the label before skipping row creation. See ADR 0052.
      await this.bestEffort(
        () =>
          (
            this.githubIssuesApi as LabelWritingGitHubIssuesApi
          ).removeLabelsFromIssue({
            ...input.repository,
            issueNumber: input.issue.number,
            labels: ["sym:claimed"]
          }),
        {
          issueNumber: input.issue.number,
          label: "sym:claimed",
          operation: "removeLabel",
          phase: "fresh-dispatch-provider-resolution-shutdown",
          project: input.project.name,
          runId: input.runId
        }
      );
      throw new RegistryShutdownError(
        `daemon is shutting down; refusing to claim issue ${input.project.name}#${input.issue.number}`
      );
    }
    this.runStore.createRun({
      id: input.runId,
      issue: input.issue,
      projectName: input.project.name,
      providerCommand: input.providerCommand,
      providerName: input.providerName
    });
    this.runStore.recordTerminalReason(
      input.runId,
      input.reason,
      "deterministic"
    );
    this.runStore.updateRunState(input.runId, "failed");
    this.logger?.warn(
      {
        issueNumber: input.issue.number,
        project: input.project.name,
        provider: input.providerName,
        reason: input.reason,
        runId: input.runId
      },
      "symphonika fresh dispatch failed before provider launch"
    );
    await this.applyTerminalLabels({
      fsmContinuing: false,
      issueNumber: input.issue.number,
      outcome: {
        classification: "deterministic",
        kind: "failed",
        reason: input.reason
      },
      repository: input.repository,
      willRetry: false
    });
  }

  async executeRetry(payload: RetryPayload): Promise<void> {
    const projects = await this.projectsLoader();
    const project = projects.get(payload.projectName);
    if (
      project === undefined ||
      project.disabled === true ||
      !isDispatchProject(project)
    ) {
      this.logger?.warn(
        { projectName: payload.projectName, runId: payload.runId },
        "symphonika retry dropped: project disabled or removed"
      );
      return;
    }

    const provider = this.agentProviders[payload.providerName];
    if (provider === undefined) {
      this.logger?.warn(
        {
          projectName: payload.projectName,
          providerName: payload.providerName,
          runId: payload.runId
        },
        "symphonika retry dropped: provider missing"
      );
      return;
    }

    const providerCommand = payload.providerCommand;

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      this.logger?.warn(
        { runId: payload.runId },
        "symphonika retry dropped: github tracker missing label writes"
      );
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      this.logger?.warn(
        { runId: payload.runId },
        "symphonika retry dropped: token not available"
      );
      return;
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    // Re-validate eligibility before re-asserting sym:claimed and starting the
    // attempt. During the [10s, 30s, 2m] retry backoff the issue may have been
    // closed or lost required labels; reconcile cannot help here because a
    // scheduled retry is not present in activeRuns.list() during the window.
    const refreshed = await this.refreshIssue({
      project,
      issueNumber: payload.issue.number,
      repository
    });
    if (refreshed === undefined) {
      this.logger?.warn(
        { runId: payload.runId, projectName: payload.projectName },
        "symphonika retry dropped: issue refresh unavailable"
      );
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      await this.cancelScheduledLifecycleWork({
        issueNumber: payload.issue.number,
        reason: CANCEL_REASONS.CLOSED_ISSUE,
        repository,
        runId: payload.runId
      });
      return;
    }
    // Closed issues still cancel above for every scope; see
    // evaluateRunContinuationEligibility for the fsm_owned vs
    // label_controlled policy.
    const eligibility = evaluateRunContinuationEligibility(refreshed, project, {
      scope:
        payload.respectsIssueLabels === false ? "fsm_owned" : "label_controlled"
    });
    if (!eligibility.eligible) {
      await this.cancelScheduledLifecycleWork({
        issueNumber: payload.issue.number,
        reason: CANCEL_REASONS.ELIGIBILITY_LOSS,
        repository,
        runId: payload.runId
      });
      return;
    }

    // Re-assert sym:claimed and reserve the in-flight slot under the mutex so
    // a concurrent fresh dispatch on the same daemon tick cannot beat this
    // retry to the (project, issue) key. The previous attempt unregistered
    // in its finally, so the slot is currently free — but a fresh dispatch
    // on a DIFFERENT issue in this project (or globally) could have filled
    // the cap during the retry's backoff window. Re-check caps and
    // reservation inside the mutex; on contention, reschedule the retry
    // instead of breaching the cap. See ADR 0053.
    let contention: CapBreachedError | IssueReservedError | undefined;
    // A retry that arrives after stop() closed the registry must skip —
    // WITHOUT rescheduling, since the scheduler itself is being torn down.
    // See ADR 0052.
    let shuttingDown = false;
    await this.dispatchMutex.acquire();
    try {
      if (this.activeRuns.isShuttingDown()) {
        shuttingDown = true;
      } else {
        // A retry re-entering dispatch is a fresh claim on host resources, so
        // it faces the same pressure gate as a first attempt; deferring here
        // reschedules the retry rather than breaching it. See ADR 0088.
        const pressure = await this.refreshHostPressure();
        const { maxInFlight: globalMax } = await this.globalConcurrencyLoader();
        const capacity = evaluateConcurrencyCapacity({
          configuredProjectMax: project.max_in_flight,
          globalInFlight: this.activeRuns.countInFlight(),
          globalMax,
          projectInFlight: this.activeRuns.countInFlightByProject(project.name),
          projectName: project.name
        });
        if (!pressure.admitted) {
          contention = new CapBreachedError(pressure.reason);
        } else if (!capacity.admitted) {
          contention = new CapBreachedError(capacity.reason);
        } else if (
          this.activeRuns.isIssueReserved(project.name, refreshed.number)
        ) {
          contention = new IssueReservedError(
            `issue ${project.name}#${refreshed.number} is already reserved`
          );
        }
        if (contention === undefined) {
          // Reserve BEFORE re-asserting the label: when stop() closes the
          // registry during the loader await above, reserveSlot refuses the
          // slot here and no stale sym:claimed label is left behind. See
          // ADR 0052.
          try {
            this.activeRuns.reserveSlot({
              issueNumber: refreshed.number,
              projectName: project.name,
              ...(payload.respectsIssueLabels === undefined
                ? {}
                : { respectsIssueLabels: payload.respectsIssueLabels }),
              runId: payload.runId
            });
          } catch (error) {
            if (!(error instanceof RegistryShutdownError)) {
              throw error;
            }
            // The run row keeps its pre-retry state; no provider starts.
            shuttingDown = true;
          }
          if (!shuttingDown) {
            await this.bestEffort(
              () =>
                this.githubIssuesApi.addLabelsToIssue!({
                  ...repository,
                  issueNumber: refreshed.number,
                  labels: ["sym:claimed"]
                }),
              {
                issueNumber: refreshed.number,
                label: "sym:claimed",
                operation: "addLabel",
                project: project.name,
                runId: payload.runId
              }
            );
          }
        }
      }
    } finally {
      this.dispatchMutex.release();
    }

    if (shuttingDown) {
      this.logger?.debug(
        {
          issueNumber: refreshed.number,
          project: project.name,
          runId: payload.runId
        },
        "symphonika retry skipped: daemon shutting down"
      );
      return;
    }

    if (contention !== undefined) {
      // Reschedule the retry with the configured continuation delay; the
      // next fire will re-check caps and proceed when contention clears.
      this.logger?.warn(
        {
          issueNumber: refreshed.number,
          project: project.name,
          reason: contention.message,
          runId: payload.runId
        },
        "symphonika retry rescheduled: contention at claim"
      );
      this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () => this.executeRetry(payload),
        issueNumber: refreshed.number,
        kind: "retry",
        projectName: project.name,
        runId: payload.runId
      });
      return;
    }

    await this.runAttemptLifecycle({
      attemptNumber: payload.attemptNumber,
      ...(payload.extraInstructions === undefined
        ? {}
        : { extraInstructions: payload.extraInstructions }),
      isContinuation: this.runStore.isContinuationRun(payload.runId),
      issue: refreshed,
      project,
      provider,
      providerCommand,
      providerName: payload.providerName,
      repository,
      // Forward the caller-owned label-immunity flag into the retry attempt,
      // mirroring runFreshLifecycle. Without this, runAttemptLifecycle sees
      // input.respectsIssueLabels === undefined and recomputes it from the
      // workflow kind; for a non-raw_fsm (markdown-compatible) PR follow-up
      // retry that resolves to `true`, and attachProvider flips the reserved
      // slot's `false` back to label-controlled — re-opening the
      // eligibility_loss cancellation storm this change closes. See ADR 0044.
      ...(payload.respectsIssueLabels === undefined
        ? {}
        : { respectsIssueLabels: payload.respectsIssueLabels }),
      runId: payload.runId
    });
  }

  private async cancelScheduledLifecycleWork(input: {
    issueNumber: number;
    reason: CancelReason;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    this.runStore.markCancelRequested(input.runId, input.reason);
    this.runStore.recordTerminalReason(input.runId, input.reason);
    this.runStore.updateRunState(input.runId, "cancelled");
    await this.applyTerminalLabels({
      cancelReason: input.reason,
      fsmContinuing: false,
      issueNumber: input.issueNumber,
      outcome: { kind: "cancelled", reason: input.reason },
      repository: input.repository,
      willRetry: false
    });
  }

  async executeWaitPark(payload: WaitParkPayload): Promise<void> {
    // Wait re-evaluation mutates the waiting run row and may call
    // tryMergePullRequest / recordPullRequestObservation. Hold the dispatch
    // mutex around the whole body so the reconcileWaitingRuns tryAcquire
    // gate in the daemon (src/daemon.ts) provides actual exclusion against
    // a concurrent tick's wait reconciliation on the same row. See ADR 0052.
    await this.dispatchMutex.acquire();
    try {
      await this.reEvaluateWaitingRun(payload.waitingRunId);
    } finally {
      this.dispatchMutex.release();
    }
  }

  // Tells the global PR follow-up loop whether a raw-FSM workflow already owns
  // this Issue — that is, whether it is parked at a state of its own and will
  // decide what happens next on its own tick. When true, the global loop must
  // act on neither the merge nor the review feedback.
  //
  // This started life as `isIssueParkedInMergePrState`, asking only about the
  // merge (ADR 0048): without it, discovery and the global merge happen in the
  // same tick, before the merge_pr state's re-evaluation ever sees the tracked
  // PR. Review feedback needed exactly the same deference and did not have it,
  // so a parked run and a workflow-unaware review dispatch ran as two live FSM
  // positions on one Issue, the second replaying the pipeline from `initial`
  // against a finished PR. Asking the general question is what makes that
  // unrepresentable rather than merely guarded against. See issue #616.
  //
  // Scoped to raw_fsm because only a raw FSM has a position to be parked at.
  // A markdown compatibility-graph workflow has no state machine, so the
  // global loop remains its only follow-up path.
  //
  // Takes the caller's already-resolved project rather than re-reading it: the
  // follow-up loop holds it, and the daemon's loader rebuilds a Map of every
  // project on each call. The workflow-kind test comes before the waiting-row
  // lookup for the same reason — it is one in-memory field read that rejects
  // every markdown project outright, while the lookup is an unindexed scan of
  // a table that grows with every Run ever recorded.
  async isIssueOwnedByWorkflow(input: {
    issueNumber: number;
    project: RunControllerProjectConfig;
  }): Promise<boolean> {
    const { project } = input;
    if (project.disabled === true || !isDispatchProject(project)) {
      return false;
    }
    let loaded;
    try {
      loaded = await this.loadWorkflow(project.workflow);
    } catch {
      return false;
    }
    if (
      loaded.errors.length > 0 ||
      loaded.expandedWorkflow.source.kind !== "raw_fsm"
    ) {
      return false;
    }
    const waiting = this.runStore.findWaitingRunByIssue({
      issueNumber: input.issueNumber,
      projectName: project.name
    });
    if (waiting === undefined || waiting.currentStateId === null) {
      return false;
    }
    // A `current_state_id` naming a state the workflow no longer has means the
    // workflow was edited out from under the park. Nothing will advance that
    // row, so claiming ownership here would strand the PR entirely.
    return (
      findWorkflowState(loaded.expandedWorkflow, waiting.currentStateId) !==
      undefined
    );
  }

  // Observes the tracked pull request and projects it into the wait state's
  // signal map, performing the merge attempt for a merge_pr state along the way.
  // undefined means "stay parked": there is nothing to decide this tick.
  //
  // Extracted from reEvaluateWaitingRun so the decision that follows it is
  // reachable without a tracked pull request. A wait state naming only artifact
  // predicates is decided from the Workspace alone (ADR 0087) — the poll has
  // everything it needs on disk. A state that also names PR predicates, and
  // every merge_pr state, still waits for its PR: an absent PR signal reads as
  // unmet under strict equality, so evaluating early would drop such a state
  // onto a catch-all transition on its first poll.
  private async observeWaitPullRequestSignals(input: {
    isMergePr: boolean;
    issueNumber: number;
    projectName: string;
    repository: GitHubIssueRepositoryInput;
    runId: string;
    waitState: ExpandedWorkflowState;
  }): Promise<WaitObservation | undefined> {
    const { isMergePr, repository, runId, waitState } = input;

    // Use the all-states lookup: a wait state targeting `pr_merged: true` must
    // still see the tracked row after PR follow-up has marked it "merged"; an
    // open-only listing would strand the wait. The dispatcher's own open-only
    // loop is unaffected — only wait re-evaluation widens the lookup.
    const tracked = this.runStore.findTrackedPullRequestByIssue({
      issueNumber: input.issueNumber,
      projectName: input.projectName
    });
    if (tracked === undefined) {
      if (!isMergePr && isArtifactOnlyWaitState(waitState)) {
        this.logger?.debug(
          { runId, issueNumber: input.issueNumber },
          "symphonika wait re-eval: deciding artifact-only wait with no tracked PR"
        );
        return { signals: { provider_success: true } };
      }
      if (isMergePr) {
        this.runStore.recordWaitingActivity(
          runId,
          `merge_pr awaiting Symphonika-tracked pull request for issue #${input.issueNumber}`
        );
      }
      this.logger?.debug(
        { runId, issueNumber: input.issueNumber },
        "symphonika wait re-eval skipped: no PR tracked yet"
      );
      return undefined;
    }

    let prState;
    try {
      prState = await tryGetPullRequestFollowupState(this.githubIssuesApi, {
        owner: repository.owner,
        pullNumber: tracked.prNumber,
        repo: repository.repo,
        token: repository.token
      });
    } catch (error) {
      this.logger?.warn(
        { err: error, runId },
        "symphonika wait re-eval skipped: PR state fetch failed"
      );
      return undefined;
    }
    if (prState === undefined || prState === null) {
      return undefined;
    }

    const pullRequestState = interpretPullRequest(prState);
    const signals: WorkflowPredicateMap = {
      provider_success: true,
      ...projectPullRequestSignals(pullRequestState)
    };

    if (isMergePr) {
      const policy = await this.pullRequestPolicyLoader();
      const method =
        coerceMergeMethod(waitState.action?.method) ?? policy.merge.method;
      if (!policy.merge.enabled) {
        this.runStore.recordWaitingActivity(
          runId,
          "merge_pr deferred: pull_requests.merge.enabled is false"
        );
        this.logger?.debug(
          { runId },
          "symphonika merge_pr re-eval: merge disabled by policy"
        );
      } else if (pullRequestReadyToMerge(pullRequestState, policy)) {
        try {
          const merged = await tryMergePullRequest(this.githubIssuesApi, {
            expectedHeadSha: pullRequestState.headSha,
            method,
            owner: repository.owner,
            pullNumber: tracked.prNumber,
            repo: repository.repo,
            token: repository.token
          });
          if (merged) {
            // Reproject signals against the post-merge state so workflow
            // transitions written in the natural shape (e.g.
            // `when: { pr_merged: true, pr_open: false }`) match — without
            // this, signals would still carry `pr_open: true` from the
            // pre-merge fetch and a refetch-style transition would silently
            // stay parked even though the merge succeeded.
            const mergedSignals = projectPullRequestSignals({
              ...pullRequestState,
              merged: true,
              open: false
            });
            for (const key of Object.keys(mergedSignals)) {
              signals[key] = mergedSignals[key]!;
            }
            this.runStore.recordPullRequestObservation({
              headSha: pullRequestState.headSha,
              id: tracked.id,
              prUrl: pullRequestState.url,
              reviewFollowupCapReached: false,
              state: "merged"
            });
            this.runStore.recordWaitingActivity(
              runId,
              `merge_pr merged PR #${tracked.prNumber} via ${method}`
            );
            this.logger?.info(
              { method, prNumber: tracked.prNumber, runId },
              "symphonika merge_pr merged PR"
            );
          } else {
            this.runStore.recordWaitingActivity(
              runId,
              `merge_pr unavailable: GitHub tracker does not expose mergePullRequest`
            );
            this.logger?.warn(
              { runId },
              "symphonika merge_pr: tracker has no mergePullRequest support"
            );
            return undefined;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.runStore.recordWaitingActivity(
            runId,
            `merge_pr attempt failed for PR #${tracked.prNumber}: ${message}`
          );
          this.logger?.warn(
            { err: error, prNumber: tracked.prNumber, runId },
            "symphonika merge_pr attempt failed"
          );
          return undefined;
        }
      } else {
        this.runStore.recordWaitingActivity(
          runId,
          `merge_pr deferred: PR #${tracked.prNumber} not yet ready under policy`
        );
        this.logger?.debug(
          { runId },
          "symphonika merge_pr re-eval: PR not yet ready to merge"
        );
      }
    }

    return { pullRequestState, signals };
  }

  async reEvaluateWaitingRun(runId: string): Promise<void> {
    const row = this.runStore.getRun(runId);
    if (row === undefined || row.state !== "waiting") {
      return;
    }
    if (row.cancelRequested) {
      const reason: CancelReason = row.cancelReason ?? "operator";
      this.runStore.markCancelRequested(runId, reason);
      this.runStore.updateRunState(runId, "cancelled");
      return;
    }
    if (row.currentStateId === null) {
      return;
    }

    const projects = await this.projectsLoader();
    const project = projects.get(row.project);
    if (
      project === undefined ||
      project.disabled === true ||
      !isDispatchProject(project)
    ) {
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return;
    }
    const repository: GitHubIssueRepositoryInput = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    const refreshed = await this.refreshIssue({
      project,
      issueNumber: row.issueNumber,
      repository
    });
    if (refreshed === undefined) {
      return;
    }
    if (
      refreshed === null ||
      !evaluateRunContinuationEligibility(refreshed, project, {
        scope: "fsm_owned"
      }).eligible
    ) {
      this.runStore.markCancelRequested(runId, "closed_issue");
      this.runStore.updateRunState(runId, "cancelled");
      return;
    }

    const loaded = await this.loadWorkflow(project.workflow);
    const waitState = findWorkflowState(
      loaded.expandedWorkflow,
      row.currentStateId
    );
    if (waitState === undefined) {
      this.logger?.warn(
        { runId, stateId: row.currentStateId },
        "symphonika wait re-eval skipped: workflow state not found"
      );
      return;
    }

    const isMergePr = waitState.action?.kind === "merge_pr";

    const observation = await this.observeWaitPullRequestSignals({
      isMergePr,
      issueNumber: row.issueNumber,
      projectName: row.project,
      repository,
      runId,
      waitState
    });
    if (observation === undefined) {
      return;
    }
    const { pullRequestState, signals } = observation;

    const waitArtifactExists = await probeStateArtifacts({
      state: waitState,
      workspacePath: row.workspacePath
    });
    const decision = decideNextStep({
      actionExecuted: true,
      ...(waitArtifactExists === undefined
        ? {}
        : { artifactExists: waitArtifactExists }),
      signals,
      state: waitState
    });

    // Re-evaluation during shutdown must not mutate rows or arm timers:
    // the scheduler has been cancelled and stop() is closing the store.
    // The waiting row stays durable for the next daemon's reconciliation.
    if (this.activeRuns.isShuttingDown()) {
      this.logger?.debug(
        { runId },
        "symphonika wait re-eval skipped: daemon shutting down"
      );
      return;
    }

    if (decision.kind === "stay_waiting") {
      // The guard's own park returns before this branch, so reaching it with a
      // no-progress reason still on the row means the guard has stopped
      // firing: the observation moved on and the state simply has nothing to
      // match now. Clear it, or the manual-attention banner would outlive the
      // condition that raised it.
      if (
        parseNoProgressReason(row.stateTransitionReason) !== null ||
        parseEdgeBudgetExhaustedReason(row.stateTransitionReason) !== null
      ) {
        this.runStore.recordWaitingActivity(runId, decision.reason);
      }
      this.logger?.debug(
        { reason: decision.reason, runId },
        "symphonika wait re-eval: still waiting"
      );
      return;
    }

    if (decision.kind === "advance") {
      const next = findWorkflowState(loaded.expandedWorkflow, decision.to);
      if (next?.terminal !== undefined) {
        this.runStore.recordWorkflowTerminal(runId, {
          terminalStateId: next.id,
          transitionReason: decision.reason
        });
        // A wait/merge_pr row can advance straight into a workflow-authored
        // `terminal: blocked` node (e.g. a PR follow-up that gives up on
        // merge conflicts). Honor the same RunState/label contract as the
        // provider-attempt path (ADR 0058) so the issue doesn't stay
        // eligible for redispatch under a stale "succeeded" verdict.
        if (next.terminal === "blocked") {
          this.runStore.recordTerminalReason(
            runId,
            "workflow_terminal_blocked",
            "deterministic"
          );
          this.runStore.updateRunState(runId, "blocked");
          await this.markIssueBlocked({
            issueNumber: refreshed.number,
            repository
          });
          return;
        }
        this.runStore.updateRunState(runId, "succeeded");
        return;
      }
      // The loop-breaker. A park can only make progress on what it observed,
      // so re-taking the same edge on an identical observation would put the
      // workflow back where it already was. A changed observation can still
      // churn forever, so the edge also has an absolute accepted-claim budget.
      // Stay parked when either half refuses the edge, and say which one did.
      // Terminal targets are exempt: they end the chain, so they cannot loop.
      // See issues #616 and #619.
      const edge: ProgressEdge = {
        fromStateId: waitState.id,
        issueNumber: row.issueNumber,
        projectName: row.project,
        toStateId: decision.to
      };
      const maxEdgeClaims =
        project.progressGuard?.maxClaimsPerEdge ??
        DEFAULT_PROGRESS_GUARD_MAX_EDGE_CLAIMS;
      const claim = this.runStore.claimProgressEdge(
        edge,
        progressFingerprint({
          artifactExists: waitArtifactExists,
          pullRequestState,
          signals,
          state: waitState
        }),
        maxEdgeClaims
      );
      if (claim !== "claimed") {
        this.runStore.recordWaitingActivity(
          runId,
          claim === "unchanged"
            ? buildNoProgressReason(edge)
            : buildEdgeBudgetExhaustedReason(edge, maxEdgeClaims)
        );
        this.logger?.warn(
          {
            claim,
            fromStateId: waitState.id,
            issueNumber: row.issueNumber,
            project: row.project,
            runId,
            toStateId: decision.to
          },
          "symphonika wait re-eval parked: workflow progress guard refused edge"
        );
        return;
      }

      this.runStore.recordWorkflowStateAdvance(runId, {
        nextStateId: decision.to,
        transitionReason: decision.reason
      });
      this.runStore.updateRunState(runId, "succeeded");

      if (isParkedAction(next?.action?.kind)) {
        const nextWaitingRunId = this.createRunId();
        this.runStore.createWaitingRun({
          currentStateId: decision.to,
          id: nextWaitingRunId,
          issue: refreshed,
          parentRunId: runId,
          projectName: project.name,
          ...(row.workspacePath.length === 0
            ? {}
            : { workspacePath: row.workspacePath })
        });
        this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () => this.executeWaitPark({ waitingRunId: nextWaitingRunId }),
          issueNumber: refreshed.number,
          kind: "wait_park",
          projectName: project.name,
          runId
        });
        return;
      }

      // Carry the review feedback into the state the park routed to. The
      // observation is already in hand here, and the target state's prompt is
      // the only place it can still reach the agent.
      const reviewInstructions =
        pullRequestState !== undefined &&
        pullRequestState.reviewFollowup.unresolvedThreads.length > 0
          ? renderReviewFollowupInstructions(
              reviewContextFromState(pullRequestState, pullRequestState.headSha)
            )
          : undefined;

      this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () =>
          this.executeStateAdvance({
            ...(reviewInstructions === undefined
              ? {}
              : { extraInstructions: reviewInstructions }),
            issue: refreshed,
            parentRunId: runId,
            projectName: project.name,
            toStateId: decision.to
          }),
        issueNumber: refreshed.number,
        kind: "state_advance",
        projectName: project.name,
        runId
      });
      return;
    }

    if (decision.kind === "blocked") {
      this.runStore.recordWorkflowBlocked(runId, {
        stateId: waitState.id,
        transitionReason: decision.reason
      });
      this.runStore.updateRunState(runId, "succeeded");
      return;
    }

    if (decision.kind === "terminate") {
      this.runStore.recordWorkflowTerminal(runId, {
        terminalStateId: decision.stateId,
        transitionReason: `entered terminal state ${decision.terminal}`
      });
      // See the matching `terminal === "blocked"` handling in the `advance`
      // branch above — same ADR 0058 contract, reached via a direct
      // terminate decision instead of an advance-to-terminal one.
      if (decision.terminal === "blocked") {
        this.runStore.recordTerminalReason(
          runId,
          "workflow_terminal_blocked",
          "deterministic"
        );
        this.runStore.updateRunState(runId, "blocked");
        await this.markIssueBlocked({
          issueNumber: refreshed.number,
          repository
        });
        return;
      }
      this.runStore.updateRunState(runId, "succeeded");
    }
  }

  // Re-enters a raw-FSM walk that a graceful shutdown cancelled mid-flight,
  // at the state the killed Run was executing. `toStateId` is that Run's
  // persisted `current_state_id`, which is also what the continuation
  // inherits in claimAndPersistRun — so the two agree without a
  // forward-stamp, unlike the ordinary advance path.
  //
  // Goes through the injected scheduler rather than awaiting
  // executeStateAdvance directly: the resumed attempt runs the provider to
  // completion, so awaiting it here would block the reconcile tick that
  // called it for the whole agent run. Scheduling also registers the work in
  // the Scheduled Work registry, which makes the Issue visibly live to
  // stale-claim detection from this moment on. See docs/adr/0088.
  scheduleShutdownResume(payload: StateAdvancePayload): void {
    const resumePayload: StateAdvancePayload = {
      ...payload,
      shutdownResume: true
    };
    this.retainShutdownResume(resumePayload.parentRunId);
    this.schedule({
      delayMs: this.lifecyclePolicy.continuation.delayMs,
      fire: async () => {
        try {
          await this.executeStateAdvance(resumePayload);
        } finally {
          // A contention retry has already retained the id again by the time
          // this runs, so the count stays above zero and the Issue stays
          // guarded across the handover.
          this.releaseShutdownResume(resumePayload.parentRunId);
        }
      },
      issueNumber: resumePayload.issue.number,
      kind: "state_advance",
      projectName: resumePayload.projectName,
      runId: resumePayload.parentRunId
    });
  }

  private retainShutdownResume(parentRunId: string): void {
    this.shutdownResumesPending.set(
      parentRunId,
      (this.shutdownResumesPending.get(parentRunId) ?? 0) + 1
    );
  }

  private releaseShutdownResume(parentRunId: string): void {
    const next = (this.shutdownResumesPending.get(parentRunId) ?? 0) - 1;
    if (next > 0) {
      this.shutdownResumesPending.set(parentRunId, next);
      return;
    }
    this.shutdownResumesPending.delete(parentRunId);
  }

  // Closes the fire-to-claim window that `activeRuns.isIssueReserved` cannot
  // see. ScheduledWorkRegistry drops its entry *before* invoking the
  // callback, and executeStateAdvance then awaits config, provider and
  // workflow loads plus a GitHub refresh before claimAndPersistRun reserves
  // the slot and writes the continuation row. Throughout that prologue the
  // Issue looks unreserved and the cancelled parent is still the newest Run
  // for it, so resumeShutdownCancelledRuns — which re-derives its work from a
  // durable query on every reconcile tick, unlike every other scheduled kind
  // — would schedule a second resume and could end up running the same
  // Workflow state twice on the same Issue Branch. Membership is dropped when
  // the callback settles, including on a dropped advance, so a Run that never
  // reached its claim stays resumable for the next tick.
  hasPendingShutdownResume(parentRunId: string): boolean {
    return (this.shutdownResumesPending.get(parentRunId) ?? 0) > 0;
  }

  async executeStateAdvance(payload: StateAdvancePayload): Promise<void> {
    const projects = await this.projectsLoader();
    const project = projects.get(payload.projectName);
    if (
      project === undefined ||
      project.disabled === true ||
      !isDispatchProject(project)
    ) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika state advance dropped: project disabled or removed"
      );
      return;
    }

    const providersConfig = await this.providersLoader();

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return;
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    // State advance asks the fsm_owned Continuation Eligibility question; see
    // evaluateRunContinuationEligibility.
    const refreshed = await this.refreshIssue({
      project,
      issueNumber: payload.issue.number,
      repository
    });
    if (refreshed === undefined) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika state advance dropped: issue refresh unavailable"
      );
      return;
    }
    if (
      refreshed === null ||
      !evaluateRunContinuationEligibility(refreshed, project, {
        scope: "fsm_owned"
      }).eligible
    ) {
      return;
    }

    const runId = this.createRunId();
    let loadedWorkflow: LoadedWorkflow;
    try {
      loadedWorkflow = await this.loadWorkflow(project.workflow, {
        forceReload: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = this.lastKnownGoodLoadedWorkflow(project.workflow);
      if (fallback === undefined) {
        const providerName = project.agent.provider;
        const providerCommand =
          (providersConfig as Partial<RunControllerProvidersConfig>)[
            providerName
          ]?.command ?? "";
        await this.failScheduledRunBeforeProvider({
          issue: refreshed,
          parentRunId: payload.parentRunId,
          phase: "state-advance",
          project,
          providerCommand,
          providerName,
          reason: `workflow_load_failed: ${message}`,
          repository,
          runId
        });
        return;
      }
      // SPEC §5.2: report the reload error but continue with the last-known-good
      // workflow snapshot. A transient malformed edit during the delay must not
      // mark an otherwise valid mid-walk run as failed.
      this.logger?.warn(
        {
          issueNumber: refreshed.number,
          parentRunId: payload.parentRunId,
          project: project.name,
          reason: `workflow_load_failed: ${message}`,
          runId
        },
        "symphonika state advance reload failed; using last known good workflow"
      );
      loadedWorkflow = fallback;
    }
    if (loadedWorkflow.errors.length > 0) {
      const fallback = this.lastKnownGoodLoadedWorkflow(project.workflow);
      const reason = `workflow_load_failed: ${loadedWorkflow.errors.join("; ")}`;
      if (fallback === undefined) {
        const providerName = project.agent.provider;
        const providerCommand =
          (providersConfig as Partial<RunControllerProvidersConfig>)[
            providerName
          ]?.command ?? "";
        await this.failScheduledRunBeforeProvider({
          issue: refreshed,
          parentRunId: payload.parentRunId,
          phase: "state-advance",
          project,
          providerCommand,
          providerName,
          reason,
          repository,
          runId
        });
        return;
      }
      this.logger?.warn(
        {
          issueNumber: refreshed.number,
          parentRunId: payload.parentRunId,
          project: project.name,
          reason,
          runId
        },
        "symphonika state advance reload invalid; using last known good workflow"
      );
      loadedWorkflow = fallback;
    }

    const targetState = findWorkflowState(
      loadedWorkflow.expandedWorkflow,
      payload.toStateId
    );
    if (targetState === undefined) {
      const providerName = project.agent.provider;
      const providerCommand =
        (providersConfig as Partial<RunControllerProvidersConfig>)[providerName]
          ?.command ?? "";
      await this.failScheduledRunBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        phase: "state-advance",
        project,
        providerCommand,
        providerName,
        reason: `workflow_state_not_found: ${payload.toStateId}`,
        repository,
        runId
      });
      return;
    }

    // Mirror the schedule-time terminal short-circuit in executeWaitPark
    // (see the `next?.terminal !== undefined` branch above). When a workflow
    // edit during the continuation delay rewrites payload.toStateId into a
    // terminal state, recording the transition is the entire intent — no
    // provider should be launched on a state with no agent action.
    if (targetState.terminal !== undefined) {
      const providerName = project.agent.provider;
      const providerCommand =
        (providersConfig as Partial<RunControllerProvidersConfig>)[providerName]
          ?.command ?? "";
      await this.recordStateAdvanceTerminalTarget({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        project,
        providerCommand,
        providerName,
        repository,
        runId,
        targetState
      });
      return;
    }

    const providerName =
      targetState.action?.kind === "agent" &&
      targetState.action.provider !== undefined
        ? targetState.action.provider
        : project.agent.provider;
    const providerConfig = (
      providersConfig as Partial<RunControllerProvidersConfig>
    )[providerName];
    const providerCommand = providerConfig?.command;

    if (providerCommand === undefined || providerCommand.trim().length === 0) {
      await this.failScheduledRunBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        phase: "state-advance",
        project,
        providerCommand: providerCommand ?? "",
        providerName,
        reason: `provider_command_missing: ${providerName}`,
        repository,
        runId
      });
      return;
    }

    const provider = this.agentProviders[providerName];
    if (provider === undefined) {
      await this.failScheduledRunBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        phase: "state-advance",
        project,
        providerCommand,
        providerName,
        reason: `provider_not_registered: ${providerName}`,
        repository,
        runId
      });
      return;
    }

    try {
      await this.runFreshLifecycle({
        attemptNumber: 1,
        ...(payload.extraInstructions === undefined
          ? {}
          : { extraInstructions: payload.extraInstructions }),
        isContinuation: true,
        issue: refreshed,
        parentRunId: payload.parentRunId,
        // Decide label immunity at the claim, not after the workflow reload
        // inside runAttemptLifecycle. Its fallback computes the same answer,
        // but only once the attempt is already under way — so reserveSlot
        // registers a raw-FSM advance as label-controlled, and a reconcile
        // landing in the window before attachProvider cancels it as
        // ELIGIBILITY_LOSS. A raw FSM legitimately removes `agent-ready` as
        // it works, so that window is reachable on the expected path. The old
        // review dispatch set this flag explicitly for the same reason; the
        // advance path is where review rounds arrive now. See ADR 0046.
        respectsIssueLabels: respectsIssueLabelsFor(
          loadedWorkflow.expandedWorkflow
        ),
        project: {
          ...project,
          workflow: {
            body: loadedWorkflow.body,
            contentHash: loadedWorkflow.contentHash,
            evidence: loadedWorkflow.evidence,
            expandedWorkflow: loadedWorkflow.expandedWorkflow,
            format: loadedWorkflow.format,
            path: loadedWorkflow.path
          }
        },
        provider,
        providerCommand,
        providerName,
        repository,
        runId
      });
    } catch (error) {
      if (error instanceof RegistryShutdownError) {
        // Skip WITHOUT rescheduling: a rescheduled timer would keep the
        // shutdown drain alive past stop().
        this.logger?.debug(
          {
            issueNumber: refreshed.number,
            project: project.name,
            reason: error.message,
            runId
          },
          "symphonika state_advance skipped: daemon shutting down"
        );
        return;
      }
      if (
        error instanceof CapBreachedError ||
        error instanceof IssueReservedError
      ) {
        this.logger?.warn(
          {
            issueNumber: refreshed.number,
            project: project.name,
            reason: error.message,
            runId
          },
          "symphonika state_advance rescheduled: contention at claim"
        );
        // A shutdown resume re-arms through scheduleShutdownResume so the
        // pending count survives the retry. A cap breach in particular throws
        // before any reservation is taken, and the bare reschedule below
        // leaves the retry's own fire-to-claim window unguarded — which is
        // reachable on the expected path, since ADR 0088 relies on
        // concurrency caps to meter a multi-Issue restart burst.
        if (payload.shutdownResume === true) {
          this.scheduleShutdownResume(payload);
          return;
        }
        this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () => this.executeStateAdvance(payload),
          issueNumber: refreshed.number,
          kind: "state_advance",
          projectName: project.name,
          runId
        });
        return;
      }
      throw error;
    }
  }

  // Rolls back a sym:claimed written before the shutdown gate closed.
  // Only the shutdown path awaits: the isShuttingDown() check at each call
  // site and the createContinuationRun below it are synchronous, so stop()
  // cannot close the gate between check and row creation. See ADR 0052.
  private async rollbackScheduledRunClaimLabel(input: {
    issueNumber: number;
    phase: "continuation" | "state-advance";
    projectName: string;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    await this.releaseIssueClaim({
      issueNumber: input.issueNumber,
      phase: input.phase,
      repository: input.repository
    });
    this.logger?.debug(
      { issueNumber: input.issueNumber, runId: input.runId },
      `symphonika ${
        input.phase === "state-advance" ? "state advance" : "continuation"
      } skipped: daemon shutting down`
    );
  }

  private async failScheduledRunBeforeProvider(input: {
    issue: IssueSnapshot;
    parentRunId: string;
    phase: "continuation" | "state-advance";
    project: RunControllerProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    reason: string;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    // Shutdown gate: every call site returns immediately after this helper,
    // so skipping here skips the whole exit. The checks are synchronous
    // with the row creation below — see rollbackScheduledRunClaimLabel.
    if (this.activeRuns.isShuttingDown()) {
      this.logger?.debug(
        { issueNumber: input.issue.number, runId: input.runId },
        `symphonika ${
          input.phase === "state-advance" ? "state advance" : "continuation"
        } skipped: daemon shutting down`
      );
      return;
    }
    await this.bestEffort(
      () =>
        (this.githubIssuesApi as LabelWritingGitHubIssuesApi).addLabelsToIssue({
          ...input.repository,
          issueNumber: input.issue.number,
          labels: ["sym:claimed"]
        }),
      {
        issueNumber: input.issue.number,
        label: "sym:claimed",
        operation: "addLabel",
        phase: `${input.phase}-provider-resolution`,
        project: input.project.name,
        runId: input.runId
      }
    );
    if (this.activeRuns.isShuttingDown()) {
      await this.rollbackScheduledRunClaimLabel({
        issueNumber: input.issue.number,
        phase: input.phase,
        projectName: input.project.name,
        repository: input.repository,
        runId: input.runId
      });
      return;
    }
    this.runStore.createContinuationRun({
      id: input.runId,
      issue: input.issue,
      parentRunId: input.parentRunId,
      projectName: input.project.name,
      providerCommand: input.providerCommand,
      providerName: input.providerName
    });
    this.runStore.recordTerminalReason(
      input.runId,
      input.reason,
      "deterministic"
    );
    this.runStore.updateRunState(input.runId, "failed");
    this.logger?.warn(
      {
        issueNumber: input.issue.number,
        parentRunId: input.parentRunId,
        project: input.project.name,
        provider: input.providerName,
        reason: input.reason,
        runId: input.runId
      },
      `symphonika ${
        input.phase === "state-advance" ? "state advance" : "continuation"
      } failed before provider launch`
    );
    await this.applyTerminalLabels({
      fsmContinuing: false,
      issueNumber: input.issue.number,
      outcome: {
        classification: "deterministic",
        kind: "failed",
        reason: input.reason
      },
      repository: input.repository,
      willRetry: false
    });
  }

  private async recordStateAdvanceTerminalTarget(input: {
    issue: IssueSnapshot;
    parentRunId: string;
    project: RunControllerProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    runId: string;
    targetState: ExpandedWorkflowState;
  }): Promise<void> {
    if (this.activeRuns.isShuttingDown()) {
      this.logger?.debug(
        { issueNumber: input.issue.number, runId: input.runId },
        "symphonika state advance skipped: daemon shutting down"
      );
      return;
    }
    // Held for the whole claim-label + continuation-row span, mirroring
    // claimAndPersistRun: without it, this delete-before-fire branch adds
    // sym:claimed and creates the continuation run row with no exclusion
    // against handleClearStaleClaim's concurrent liveness check, which
    // acquires the same mutex before deciding whether to clear the label.
    await this.dispatchMutex.acquire();
    try {
      await this.bestEffort(
        () =>
          (
            this.githubIssuesApi as LabelWritingGitHubIssuesApi
          ).addLabelsToIssue({
            ...input.repository,
            issueNumber: input.issue.number,
            labels: ["sym:claimed"]
          }),
        {
          issueNumber: input.issue.number,
          label: "sym:claimed",
          operation: "addLabel",
          phase: "state-advance-terminal-target",
          project: input.project.name,
          runId: input.runId
        }
      );
      if (this.activeRuns.isShuttingDown()) {
        await this.rollbackScheduledRunClaimLabel({
          issueNumber: input.issue.number,
          phase: "state-advance",
          projectName: input.project.name,
          repository: input.repository,
          runId: input.runId
        });
        return;
      }
      this.runStore.createContinuationRun({
        id: input.runId,
        issue: input.issue,
        parentRunId: input.parentRunId,
        projectName: input.project.name,
        providerCommand: input.providerCommand,
        providerName: input.providerName
      });
      const transitionReason = `reloaded target ${input.targetState.id} is terminal`;
      this.runStore.recordWorkflowTerminal(input.runId, {
        terminalStateId: input.targetState.id,
        transitionReason
      });
      const outcome = fuseTerminalLabel(
        { kind: "success", reason: transitionReason },
        input.targetState.terminal
      );
      this.runStore.recordTerminalReason(
        input.runId,
        outcome.reason,
        outcome.classification
      );
      this.runStore.updateRunState(input.runId, mapOutcomeToRunState(outcome));
      this.logger?.info(
        {
          issueNumber: input.issue.number,
          parentRunId: input.parentRunId,
          project: input.project.name,
          runId: input.runId,
          targetStateId: input.targetState.id,
          terminal: input.targetState.terminal
        },
        "symphonika state advance recorded reloaded terminal target without launching provider"
      );
      await this.applyTerminalLabels({
        fsmContinuing: false,
        issueNumber: input.issue.number,
        outcome,
        repository: input.repository,
        willRetry: false
      });
    } finally {
      this.dispatchMutex.release();
    }
  }

  async executeContinuation(payload: ContinuationPayload): Promise<void> {
    const projects = await this.projectsLoader();
    const project = projects.get(payload.projectName);
    if (
      project === undefined ||
      project.disabled === true ||
      !isDispatchProject(project)
    ) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika continuation dropped: project disabled or removed"
      );
      return;
    }

    const providersConfig = await this.providersLoader();

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return;
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    // Re-check issue state at the moment the continuation fires. The success
    // path already checks before scheduling, but operators may remove
    // agent-ready or add needs-human during the short continuation delay.
    const refreshed = await this.refreshIssue({
      project,
      issueNumber: payload.issue.number,
      repository
    });
    if (refreshed === undefined) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika continuation dropped: issue refresh unavailable"
      );
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      // Issue closure ends every Continuation Eligibility scope. The
      // one-shot callback has been consumed and no replacement step will be
      // scheduled, so the Issue Reservation ends here. See SPEC section 9.3.
      await this.releaseIssueClaim({
        issueNumber: payload.issue.number,
        phase: "continuation-closed-issue",
        repository
      });
      return;
    }
    if (
      !evaluateRunContinuationEligibility(refreshed, project, {
        scope: "label_controlled"
      }).eligible
    ) {
      // Label/dependency drift ends a label-controlled reservation, but a
      // PR Follow-up Run remains workflow-owned and may share the claim with
      // a parked/waiting Run. Preserve that label-immune reservation.
      if (payload.respectsIssueLabels !== false) {
        await this.releaseIssueClaim({
          issueNumber: payload.issue.number,
          phase: "continuation-eligibility-loss",
          repository
        });
      }
      return;
    }

    const runId = this.createRunId();
    const providerName = project.agent.provider;
    const providerCommand = providersConfig[providerName]?.command;
    if (providerCommand === undefined || providerCommand.trim().length === 0) {
      await this.failScheduledRunBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        phase: "continuation",
        project,
        providerCommand: providerCommand ?? "",
        providerName,
        reason: `provider_command_missing: ${providerName}`,
        repository,
        runId
      });
      return;
    }

    const provider = this.agentProviders[providerName];
    if (provider === undefined) {
      await this.failScheduledRunBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        phase: "continuation",
        project,
        providerCommand,
        providerName,
        reason: `provider_not_registered: ${providerName}`,
        repository,
        runId
      });
      return;
    }

    try {
      await this.runFreshLifecycle({
        attemptNumber: 1,
        isContinuation: true,
        issue: refreshed,
        parentRunId: payload.parentRunId,
        project,
        provider,
        providerCommand,
        providerName,
        repository,
        ...(payload.respectsIssueLabels === undefined
          ? {}
          : { respectsIssueLabels: payload.respectsIssueLabels }),
        runId
      });
    } catch (error) {
      if (error instanceof RegistryShutdownError) {
        // Skip WITHOUT rescheduling: a rescheduled timer would keep the
        // shutdown drain alive past stop().
        this.logger?.debug(
          {
            issueNumber: refreshed.number,
            project: project.name,
            reason: error.message,
            runId
          },
          "symphonika continuation skipped: daemon shutting down"
        );
        return;
      }
      if (
        error instanceof CapBreachedError ||
        error instanceof IssueReservedError
      ) {
        this.logger?.warn(
          {
            issueNumber: refreshed.number,
            project: project.name,
            reason: error.message,
            runId
          },
          "symphonika continuation rescheduled: contention at claim"
        );
        this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () => this.executeContinuation(payload),
          issueNumber: refreshed.number,
          kind: "continuation",
          projectName: project.name,
          runId
        });
        return;
      }
      throw error;
    }
  }

  async dispatchReviewFollowup(input: {
    issueNumber: number;
    parentRunId: string;
    projectName: string;
    review: ReviewFollowupContext;
  }): Promise<DispatchOneFreshResult> {
    const projects = await this.projectsLoader();
    const project = projects.get(input.projectName);
    if (
      project === undefined ||
      project.disabled === true ||
      !isDispatchProject(project)
    ) {
      return {
        dispatched: false,
        reason: "project disabled or removed"
      };
    }

    if (this.activeRuns.isIssueReserved(input.projectName, input.issueNumber)) {
      return {
        dispatched: false,
        reason: "issue already has an active or scheduled run"
      };
    }

    // A raw FSM decides for itself where work resumes: it has a position, and
    // that position is the only thing allowed to name a start state. This
    // dispatch has no position to offer — it would have to pick one, and the
    // only one it could pick is `expandedWorkflow.initial`, which replays the
    // pipeline against a finished PR (issue #616). A markdown
    // compatibility-graph workflow has no state machine and no position, so
    // its single entry point is the right and only answer, and this path
    // stays its follow-up route.
    //
    // The global loop already declines to call this for a parked raw-FSM
    // Issue (isIssueOwnedByWorkflow). This is the same rule stated where it
    // is enforceable: a raw FSM whose run is NOT parked has terminated or
    // blocked, and replaying it from the top is no more correct there.
    try {
      const loaded = await this.loadWorkflow(project.workflow);
      if (
        loaded.errors.length === 0 &&
        loaded.expandedWorkflow.source.kind === "raw_fsm"
      ) {
        return {
          dispatched: false,
          reason: "raw_fsm workflow owns its own review follow-up"
        };
      }
    } catch {
      // Refuse rather than fall through. The caller's own deference also fails
      // open on a load error (isIssueOwnedByWorkflow returns false), so a
      // transient failure would otherwise defeat both guards at once and
      // replay a raw FSM from `initial` — exactly what issue #616 is about.
      // A markdown workflow loses one tick of follow-up and retries.
      return {
        dispatched: false,
        reason: "workflow could not be loaded to establish ownership"
      };
    }

    const providersConfig = await this.providersLoader();
    const providerName = project.agent.provider;
    const provider = this.agentProviders[providerName];
    if (provider === undefined) {
      return {
        dispatched: false,
        reason: "project provider is not registered"
      };
    }

    const providerCommand = (
      providersConfig as Partial<RunControllerProvidersConfig>
    )[providerName]?.command;
    if (providerCommand === undefined || providerCommand.trim().length === 0) {
      return {
        dispatched: false,
        reason: `provider command is not configured: ${providerName}`
      };
    }

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return {
        dispatched: false,
        reason: "GitHub tracker does not support operational label writes"
      };
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return {
        dispatched: false,
        reason: `projects.${project.name}.tracker.token is not available`
      };
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    const refreshed = await this.refreshIssue({
      project,
      issueNumber: input.issueNumber,
      repository
    });
    if (refreshed === undefined) {
      return {
        dispatched: false,
        reason: "issue refresh unavailable"
      };
    }
    if (refreshed === null || refreshed.state !== "open") {
      return {
        dispatched: false,
        reason: "issue is closed"
      };
    }

    const runId = this.createRunId();
    try {
      await this.runFreshLifecycle({
        attemptNumber: 1,
        extraInstructions: renderReviewFollowupInstructions(input.review),
        isContinuation: true,
        issue: refreshed,
        parentRunId: input.parentRunId,
        project,
        provider,
        providerCommand,
        providerName,
        repository,
        respectsIssueLabels: false,
        runId
      });
    } catch (error) {
      if (error instanceof RegistryShutdownError) {
        return { dispatched: false, reason: error.message };
      }
      if (
        error instanceof CapBreachedError ||
        error instanceof IssueReservedError
      ) {
        // The PR follow-up loop retries on the next tick. No explicit
        // reschedule needed here. See ADR 0053.
        return { dispatched: false, reason: error.message };
      }
      throw error;
    }

    return { dispatched: true, runId };
  }

  private async pickTargetFromCandidates(
    candidates: ReadonlyArray<{ issue: IssueSnapshot; project: string }>,
    projects: Map<string, RunControllerProjectConfig>
  ): Promise<DispatchTarget | undefined> {
    // Global cap check first: if the daemon is already at its global limit,
    // no project's candidate is dispatchable. See ADR 0053.
    const { maxInFlight: globalMax } = await this.globalConcurrencyLoader();
    if (isGlobalCapReached(globalMax, this.activeRuns.countInFlight())) {
      return undefined;
    }
    const states = this.runStore.getProjectStatesByName();
    const buckets = new Map<
      string,
      Array<{ issue: IssueSnapshot; project: string }>
    >();
    for (const candidate of candidates) {
      const bucket = buckets.get(candidate.project);
      if (bucket === undefined) {
        buckets.set(candidate.project, [candidate]);
        continue;
      }
      bucket.push(candidate);
    }

    const dispatchable: Array<{
      candidate: { issue: IssueSnapshot; project: string };
      currentWeight: number;
      nextWeight: number;
      project: RunControllerProjectConfig;
      provider: AgentProvider;
      weight: number;
    }> = [];

    for (const [projectName, project] of projects) {
      const bucket = buckets.get(projectName);
      if (bucket === undefined || project.disabled === true) {
        continue;
      }
      const provider = this.agentProviders[project.agent.provider];
      if (provider === undefined) {
        continue;
      }
      // Per-project concurrency cap. Default cap of 1 preserves the legacy
      // serial behavior when max_in_flight is omitted. See ADR 0053.
      if (
        isProjectCapReached(
          project.max_in_flight,
          this.activeRuns.countInFlightByProject(projectName)
        )
      ) {
        continue;
      }
      const candidate = await this.pickProjectCandidate(bucket, project);
      if (candidate === undefined) {
        continue;
      }
      const weight = normalizeProjectWeight(
        project.weight ?? states.get(projectName)?.weight
      );
      const currentWeight =
        states.get(projectName)?.schedulerCurrentWeight ?? 0;
      dispatchable.push({
        candidate,
        currentWeight,
        nextWeight: currentWeight + weight,
        project,
        provider,
        weight
      });
    }

    if (dispatchable.length === 0) {
      return undefined;
    }

    const totalWeight = dispatchable.reduce(
      (sum, entry) => sum + entry.weight,
      0
    );
    let selected = dispatchable[0]!;
    for (const entry of dispatchable.slice(1)) {
      if (entry.nextWeight > selected.nextWeight) {
        selected = entry;
      }
    }
    const schedulerWeights = dispatchable.map((entry) => ({
      currentWeight:
        entry === selected ? entry.nextWeight - totalWeight : entry.nextWeight,
      projectName: entry.project.name,
      weight: entry.weight
    }));

    return {
      candidate: selected.candidate,
      project: selected.project,
      provider: selected.provider,
      schedulerWeights
    };
  }

  // Sequential on purpose: the first admissible candidate wins, so the overlap
  // guard's GitHub round-trip is only paid until one is found.
  private async pickProjectCandidate(
    bucket: ReadonlyArray<{ issue: IssueSnapshot; project: string }>,
    project: RunControllerProjectConfig
  ): Promise<{ issue: IssueSnapshot; project: string } | undefined> {
    const guarded = project.dispatch?.overlap_guard === true;
    for (const entry of bucket.slice().sort(compareCandidateIssues)) {
      if (this.activeRuns.isIssueReserved(entry.project, entry.issue.number)) {
        continue;
      }
      if (
        !guarded ||
        !(await this.fileOverlapGuard.hasKnownOverlap({
          issue: entry.issue,
          project
        }))
      ) {
        return entry;
      }
    }
    return undefined;
  }

  private async runFreshLifecycle(input: {
    attemptNumber: number;
    claimGuard?: () => boolean;
    extraInstructions?: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    parentRunId: string | null;
    project: DispatchProjectConfig;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    respectsIssueLabels?: boolean;
    runId: string;
    schedulerWeights?: Array<{
      currentWeight: number;
      projectName: string;
      weight: number;
    }>;
    verifyFileOverlap?: boolean;
  }): Promise<void> {
    // Narrowed critical section: claim label + scheduler cursor + createRun
    // + reserveSlot all happen while the mutex is held. Provider event
    // streaming runs AFTER mutex release. CapBreachedError and
    // IssueReservedError propagate to the caller, which decides whether to
    // silently no-op (fresh dispatch) or reschedule (continuation / state
    // advance / PR followup). See ADR 0052 / ADR 0053.
    await this.dispatchMutex.acquire();
    try {
      await this.claimAndPersistRun(input);
    } finally {
      this.dispatchMutex.release();
    }

    await this.runAttemptLifecycle({
      attemptNumber: input.attemptNumber,
      ...(input.extraInstructions === undefined
        ? {}
        : { extraInstructions: input.extraInstructions }),
      isContinuation: input.isContinuation,
      issue: input.issue,
      project: input.project,
      provider: input.provider,
      providerCommand: input.providerCommand,
      providerName: input.providerName,
      repository: input.repository,
      ...(input.respectsIssueLabels === undefined
        ? {}
        : { respectsIssueLabels: input.respectsIssueLabels }),
      runId: input.runId
    });
  }

  private async claimAndPersistRun(input: {
    claimGuard?: () => boolean;
    isContinuation: boolean;
    issue: IssueSnapshot;
    parentRunId: string | null;
    project: RunControllerProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    respectsIssueLabels?: boolean;
    runId: string;
    schedulerWeights?: Array<{
      currentWeight: number;
      projectName: string;
      weight: number;
    }>;
    verifyFileOverlap?: boolean;
  }): Promise<void> {
    // Shutdown gate, fast path: throwing before any side effect needs no
    // rollback. The gate can still land during the addLabelsToIssue await
    // below; the catch then cleans up the partial claim. See ADR 0052.
    if (this.activeRuns.isShuttingDown()) {
      throw new RegistryShutdownError(
        `daemon is shutting down; refusing to claim issue ${input.project.name}#${input.issue.number}`
      );
    }
    // Host pressure BEFORE the cap, matching the other two admission points
    // and the contract in SPEC.md / ADR 0088. Both breaches raise the same
    // CapBreachedError, so the order changes no control flow — only which
    // reason reaches the operator, and on a stalled host at its cap (the
    // common co-occurrence: pressure builds precisely while runs are in
    // flight) cap-first would report a full cap and hide the real cause.
    // Every claim path funnels through here inside the mutex — fresh
    // dispatch, continuation, state advance and PR review follow-up alike —
    // so this is the one place that guarantees no claim starts against a
    // stalled host. Scheduled callers already treat CapBreachedError as
    // "reschedule", the right response to transient pressure.
    const hostPressure = await this.refreshHostPressure();
    if (!hostPressure.admitted) {
      throw new CapBreachedError(hostPressure.reason);
    }
    // Re-check concurrency caps inside the mutex. pickTargetFromCandidates
    // ran without the lock, so two concurrent ticks could both observe a
    // below-cap count before either reserves a slot — without this guard,
    // both would proceed and the cap would be breached. Continuations are
    // NOT exempt: a continuation fires after the parent's `finally` released
    // its slot, but during that gap a fresh dispatch on another issue may
    // have filled the cap. Scheduled callers catch CapBreachedError and
    // reschedule. See ADR 0053.
    const { maxInFlight: globalMax } = await this.globalConcurrencyLoader();
    const capacity = evaluateConcurrencyCapacity({
      configuredProjectMax: input.project.max_in_flight,
      globalInFlight: this.activeRuns.countInFlight(),
      globalMax,
      projectInFlight: this.activeRuns.countInFlightByProject(
        input.project.name
      ),
      projectName: input.project.name
    });
    if (!capacity.admitted) {
      throw new CapBreachedError(capacity.reason);
    }

    // Re-check per-(project, issue) reservation inside the mutex. With
    // max_in_flight > 1, two re-entrant ticks can both observe a candidate
    // as unreserved in pickTargetFromCandidates (because neither has called
    // reserveSlot yet). Without this guard the second one would write a
    // duplicate sym:claimed label + create a duplicate run row before
    // reserveSlot throws on the (project, issue) lock. See ADR 0052.
    if (
      this.activeRuns.isIssueReserved(input.project.name, input.issue.number)
    ) {
      throw new IssueReservedError(
        `issue ${input.project.name}#${input.issue.number} is already reserved`
      );
    }

    const overlapInspection =
      input.verifyFileOverlap === true
        ? await this.fileOverlapGuard.inspectCandidate({
            issue: input.issue,
            project: input.project
          })
        : undefined;
    if (overlapInspection?.hasKnownOverlap === true) {
      throw new FileOverlapDetectedError(
        `issue ${input.project.name}#${input.issue.number} has known file overlap`
      );
    }

    if (input.claimGuard?.() === false) {
      throw new FreshClaimDeferredError(
        `fresh issue claim deferred for project ${input.project.name}`
      );
    }

    let claimed = false;
    let runCreated = false;
    try {
      await (
        this.githubIssuesApi as LabelWritingGitHubIssuesApi
      ).addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issue.number,
        labels: ["sym:claimed"]
      });
      claimed = true;
      this.logger?.info(
        {
          issueNumber: input.issue.number,
          isContinuation: input.isContinuation,
          parentRunId: input.parentRunId,
          project: input.project.name,
          provider: input.providerName,
          runId: input.runId
        },
        "symphonika claimed issue and starting run"
      );
      if (input.schedulerWeights !== undefined) {
        this.runStore.recordProjectDispatchSelection({
          issueNumber: input.issue.number,
          projectName: input.project.name,
          schedulerWeights: input.schedulerWeights
        });
      }
      const createInput = {
        evidenceIgnore:
          input.project.workflow !== undefined &&
          "expandedWorkflow" in input.project.workflow
            ? input.project.workflow.evidence.ignore
            : [],
        id: input.runId,
        issue: input.issue,
        projectName: input.project.name,
        providerCommand: input.providerCommand,
        providerName: input.providerName
      };
      if (input.isContinuation && input.parentRunId !== null) {
        this.runStore.createContinuationRun({
          ...createInput,
          parentRunId: input.parentRunId
        });
      } else {
        // A fresh claim opens a new run chain for this Issue. Any progress
        // history belongs to the chain before it, and holding it would park
        // the new chain on an edge it has never taken. See issue #616.
        this.runStore.clearProgressFingerprints({
          issueNumber: input.issue.number,
          projectName: input.project.name
        });
        this.runStore.createRun(createInput);
      }
      runCreated = true;
      // Reserve the in-flight slot BEFORE mutex release so subsequent picks
      // (per-issue reservation + Slice-2 cap counts) observe the run. The
      // provider cancel handler is bound later in runAttemptLifecycle via
      // attachProvider once provider.validate has succeeded. See ADR 0052.
      this.activeRuns.reserveSlot({
        issueNumber: input.issue.number,
        projectName: input.project.name,
        ...(input.respectsIssueLabels === undefined
          ? {}
          : { respectsIssueLabels: input.respectsIssueLabels }),
        runId: input.runId
      });
      if (
        overlapInspection !== undefined &&
        overlapInspection.candidateFiles.length > 0
      ) {
        this.activeRuns.updateTouchedFiles(input.runId, {
          files: overlapInspection.candidateFiles,
          refreshedAt: overlapInspection.refreshedAt
        });
      }
    } catch (error) {
      if (error instanceof RegistryShutdownError && runCreated) {
        // The shutdown snapshot in stop() predates this row, so record the
        // shutdown reason here and release the claim label best-effort.
        this.runStore.markCancelRequested(
          input.runId,
          CANCEL_REASONS.DAEMON_SHUTDOWN
        );
        this.runStore.updateRunState(input.runId, "cancelled");
        const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
        await this.bestEffort(
          () =>
            api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issue.number,
              labels: ["sym:claimed"]
            }),
          {
            issueNumber: input.issue.number,
            label: "sym:claimed",
            operation: "removeLabel",
            project: input.project.name,
            runId: input.runId
          }
        );
      } else if (!runCreated && claimed) {
        // Failure between claim and createRun (rare): still mark sym:failed best-effort.
        await this.markIssueFailed({
          issueNumber: input.issue.number,
          repository: input.repository
        });
      }
      throw error;
    }
  }

  private async runAttemptLifecycle(input: {
    attemptNumber: number;
    extraInstructions?: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    project: DispatchProjectConfig;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    respectsIssueLabels?: boolean;
    runId: string;
  }): Promise<void> {
    const attemptId = `${input.runId}-attempt-${input.attemptNumber}`;
    const runtime: RunRuntime = {
      attemptId,
      attemptNumber: input.attemptNumber,
      events: []
    };
    let attemptCreated = false;
    let started: StartedAttempt | undefined;
    let headShaAtAttemptStart: string | undefined;
    let headInspectionFailed = false;
    let caughtError: unknown;
    // Hoisted so the finally can read them on any exit path (including a
    // loadWorkflow throw or a parked-state early return). The initial label
    // policy matches the reservation-time override when the caller supplied
    // one (PR Follow-up), otherwise it keeps reserveSlot's label-controlled
    // default. parkedAsWaiting=false enables the default failure pipeline.
    // See ADR 0044 / ADR 0052.
    let loadedWorkflow:
      Awaited<ReturnType<typeof this.loadWorkflow>> | undefined;
    let currentState: ReturnType<typeof findWorkflowState> | undefined;
    let projectForAttempt = input.project;
    let respectsIssueLabels = input.respectsIssueLabels ?? true;
    let parkedAsWaiting = false;
    let preservedWatchdogTerminal = false;

    this.runStore.updateRunState(input.runId, "preparing_workspace");

    // If reconcile flipped cancelRequested between reserveSlot (inside the
    // narrowed dispatch mutex) and entry into runAttemptLifecycle, honor it
    // immediately without launching the provider. See ADR 0052.
    const reservedEntry = this.activeRuns.getInFlight(input.runId);
    const cancelBeforeAttach: Error | undefined =
      reservedEntry !== undefined && reservedEntry.cancelRequested
        ? new Error(`run ${input.runId} was cancelled before provider start`)
        : undefined;

    try {
      // If pre-attempt cancel-request was observed above, jump straight to
      // the finally block so the caller sees a cancelled outcome.
      if (cancelBeforeAttach !== undefined) {
        throw cancelBeforeAttach;
      }

      // loadWorkflow lives inside the try so a throw still routes through
      // the unregister in finally (preventing the slot leak the previous
      // structure had: throw -> early exit -> reserveSlot'd entry stranded
      // until daemon restart). See ADR 0052.
      loadedWorkflow = await this.loadWorkflow(input.project.workflow);
      if (loadedWorkflow.errors.length === 0) {
        const persistedStateId = this.runStore.getRun(
          input.runId
        )?.currentStateId;
        const startStateId =
          persistedStateId ?? loadedWorkflow.expandedWorkflow.initial;
        currentState = findWorkflowState(
          loadedWorkflow.expandedWorkflow,
          startStateId
        );
        if (currentState !== undefined) {
          this.runStore.setRunCurrentState(input.runId, currentState.id);
        }
        projectForAttempt = {
          ...input.project,
          workflow: {
            body: loadedWorkflow.body,
            contentHash: loadedWorkflow.contentHash,
            evidence: loadedWorkflow.evidence,
            expandedWorkflow: loadedWorkflow.expandedWorkflow,
            format: loadedWorkflow.format,
            path: loadedWorkflow.path
          }
        };
      }
      // Raw FSM workflows whose entry state is a parked action (wait/merge_pr)
      // must never launch a provider — they have no prompt and must instead be
      // parked into the waiting-row reconciliation path immediately. Without
      // this guard, runAttemptLifecycle would call startAttempt with an empty
      // raw-FSM prompt, terminate, and then fall through `applyWorkflowOutcome`
      // (which has no `stay_waiting` branch) leaving the workflow with no
      // waiting row and no merge attempt scheduled. Returning here keeps the
      // run row durable (state="waiting", current_state_id set) so a daemon
      // restart can resume the reconciliation. See SPEC §12.6 / §12.7.
      if (
        loadedWorkflow.errors.length === 0 &&
        loadedWorkflow.expandedWorkflow.source.kind === "raw_fsm" &&
        currentState !== undefined &&
        isParkedAction(currentState.action?.kind)
      ) {
        // A cancel (operator or shutdown) can land during loadWorkflow
        // above, after cancelBeforeAttach was captured. Parking now would
        // flip the row to waiting and arm a timer after the scheduler was
        // cancelled. Returning early instead: the finally sees the latched
        // cancelRequested and classifies the run cancelled — no error
        // escapes to be logged as a dispatch failure. See ADR 0052.
        const cancelBeforePark = this.activeRuns.getInFlight(input.runId);
        if (cancelBeforePark?.cancelRequested === true) {
          return;
        }
        this.runStore.updateRunState(input.runId, "waiting");
        this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () => this.executeWaitPark({ waitingRunId: input.runId }),
          issueNumber: input.issue.number,
          kind: "wait_park",
          projectName: input.project.name,
          runId: input.runId
        });
        // Set the flag so finally skips the failure-classification pipeline
        // (the wait_park scheduled callback owns re-evaluation), but still
        // runs the unconditional unregister that releases the in-flight slot.
        parkedAsWaiting = true;
        return;
      }

      // Raw FSM runs are FSM-governed: the state machine, not the issue label
      // set, decides whether the agent keeps running — for the initial state as
      // much as for state-advance continuations. This immunity covers the whole
      // in-flight walk, including the fresh initial state, because a raw FSM
      // agent state legitimately removes the eligibility label (`agent-ready`)
      // as its terminal action before the run parks into a label-immune wait
      // state. Without covering the initial state, reconcileActiveRuns re-checks
      // labels while the provider is still draining, sees `agent-ready` gone,
      // and cancels the finished run as ELIGIBILITY_LOSS — orphaning its PR
      // (issue #258). The unregister-in-finally ordering means the in-flight
      // entry only exists while the provider is live, so gating on "provider
      // exited" cannot close the window; label-immunity is the fix. Computed
      // here so both activeRuns.attachProvider and scheduleNext (in finally)
      // carry the same guarantee, including into retry scheduling. Markdown
      // compatibility-graph workflows keep their label-driven behavior unless
      // the caller explicitly owns continuation eligibility (PR Follow-up).
      // CLOSED_ISSUE cancellation still applies. See ADR 0046.
      respectsIssueLabels =
        input.respectsIssueLabels ??
        respectsIssueLabelsFor(loadedWorkflow.expandedWorkflow);
      // For raw FSM workflows, the agent action's `prompt` field points at the
      // template file to send to the provider for this state. Resolve it here
      // so startAttempt renders the right prompt (rather than the YAML body of
      // the workflow file, which is meaningless input for the agent).
      let promptTemplate: string | undefined;
      if (
        currentState !== undefined &&
        loadedWorkflow.expandedWorkflow.source.kind === "raw_fsm" &&
        currentState.action?.kind === "agent" &&
        currentState.action.prompt !== undefined
      ) {
        const workflowDir = path.dirname(loadedWorkflow.path);
        const promptPath = path.resolve(
          workflowDir,
          currentState.action.prompt
        );
        try {
          promptTemplate = await readFile(promptPath, "utf8");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `workflow state ${currentState.id} prompt not found at ${promptPath}: ${message}`,
            { cause: error }
          );
        }
      }

      started = await this.startAttempt({
        attemptId,
        attemptNumber: input.attemptNumber,
        ...(input.extraInstructions === undefined
          ? {}
          : { extraInstructions: input.extraInstructions }),
        isContinuation: input.isContinuation,
        issue: input.issue,
        project: projectForAttempt,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        ...(promptTemplate === undefined ? {} : { promptTemplate }),
        runId: input.runId
      });
      await input.provider.validate(input.providerCommand);
      await (
        this.githubIssuesApi as LabelWritingGitHubIssuesApi
      ).addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issue.number,
        labels: ["sym:running"]
      });
      this.runStore.updateRunState(input.runId, "running");
      this.runStore.createAttempt({
        ...started.evidence,
        attemptNumber: input.attemptNumber,
        id: attemptId,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        runId: input.runId,
        state: "running"
      });
      attemptCreated = true;
      // Slot was reserved upstream in claimAndPersistRun. Bind the live
      // provider cancel handler (and update respectsIssueLabels once the
      // workflow kind is known) onto the existing entry.
      this.activeRuns.attachProvider(input.runId, {
        cancel: () => input.provider.cancel(input.runId),
        provider: input.provider,
        respectsIssueLabels
      });

      // A cancel (watchdog no_progress, operator, closed_issue, eligibility_loss)
      // can land DURING the potentially long workspace prep above — after the
      // one-shot cancelBeforeAttach check. The attachProvider hand-off just fired
      // provider.cancel against a provider that runAttempt has not started yet, so
      // it was a no-op, and the latched cancelRequested suppresses any later
      // cancel. Re-check here and skip launching a provider we could no longer
      // stop; the finally block preserves the stale/no_progress verdict (or
      // classifies the cancellation). See ADR 0052 / ADR 0054.
      const cancelDuringPrepare = this.activeRuns.getInFlight(input.runId);
      if (cancelDuringPrepare?.cancelRequested === true) {
        throw new Error(
          `run ${input.runId} was cancelled before provider start`
        );
      }

      try {
        headShaAtAttemptStart = await inspectWorkspaceHead({
          workspacePath: started.evidence.workspacePath
        });
      } catch {
        // Defer this deterministic inspection failure until a clean provider
        // exit. Cancellation, input-required, and provider failures must retain
        // their own higher-priority classification.
        headInspectionFailed = true;
      }

      await this.iterateAttempt({
        attemptId,
        attemptNumber: input.attemptNumber,
        evidence: started.evidence,
        issue: input.issue,
        prompt: started.prompt,
        promptPath: started.promptPath,
        provider: input.provider,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        repositoryToken: input.repository.token,
        runId: input.runId,
        runtime
      });
    } catch (error) {
      caughtError = error;
    } finally {
      let cancelRequested = false;
      let cancelReason: CancelReason | undefined;
      // Slot was reserved unconditionally upstream in claimAndPersistRun, so
      // unregister is unconditional here. The previous `if (registered)`
      // guard would leak the slot if a throw happened between reserveSlot
      // and attachProvider (loadWorkflow / prepareIssueWorkspace / validate /
      // sym:running label / createAttempt). See ADR 0052.
      const removed = this.activeRuns.unregister(input.runId);
      if (removed !== undefined) {
        cancelRequested = removed.cancelRequested;
        cancelReason = removed.cancelReason;
      }
      const preservedRun = this.runStore.getRun(input.runId);
      // terminal_reason "no_progress" is set exclusively by the watchdog
      // (markRunNoProgressStale), so it is a reliable signal that the watchdog
      // staled this run — even when a concurrent updateRunState(..., "running")
      // earlier in this same lifecycle clobbered the row back to a non-stale
      // state after the watchdog fired (updateRunState rewrites state but
      // leaves terminal_reason intact). The watchdog samples `running` rows
      // only, so the race is the narrow one where a run is staled after its
      // first `running` write and a later write in this same lifecycle
      // overwrites the verdict. Gate on terminal_reason rather
      // than state === "stale" so the clobber cannot defeat the verdict, and
      // re-assert the stale state when it was overwritten. See ADR 0054.
      const watchdogTerminalReason = WATCHDOG_TERMINAL_REASONS.find(
        (reason) => reason === preservedRun?.terminalReason
      );
      if (watchdogTerminalReason !== undefined) {
        // Re-assert the stale verdict if a clobbering updateRunState(.., "running")
        // overwrote the state. markRunWatchdogStale refuses rows with
        // cancel_requested=1, so if a concurrent operator/closed-issue cancel won
        // the race the re-assert returns false; in that case we must NOT preserve
        // the watchdog verdict — fall through to classifyFailure so the
        // cancellation terminates the run. Otherwise the row would be left stuck
        // in "running" with no provider (a state-machine leak).
        const reasserted =
          preservedRun?.state === "stale" ||
          this.runStore.markRunWatchdogStale(
            input.runId,
            watchdogTerminalReason
          );
        if (reasserted) {
          if (attemptCreated) {
            this.runStore.updateAttemptState(attemptId, "stale");
          }
          await this.applyTerminalLabels({
            cancelReason: watchdogTerminalReason,
            fsmContinuing: false,
            issueNumber: input.issue.number,
            outcome: {
              kind: "cancelled",
              reason: watchdogTerminalReason
            },
            repository: input.repository,
            willRetry: false
          });
          this.logger?.info(
            {
              attemptNumber: input.attemptNumber,
              cancelReason,
              issueNumber: input.issue.number,
              project: input.project.name,
              runId: input.runId,
              state: "stale",
              terminalReason: watchdogTerminalReason
            },
            "symphonika run termination preserved watchdog verdict"
          );
          preservedWatchdogTerminal = true;
        }
      }
      // Parked-as-waiting runs have already committed their "waiting" state
      // and scheduled the wait_park callback that will own re-evaluation.
      // The failure-classification + scheduleNext pipeline below would
      // overwrite the waiting state and double-schedule, so it's gated on
      // !parkedAsWaiting. The unconditional unregister above already
      // released the in-flight slot. See ADR 0052 — slot-leak fix.
      if (!parkedAsWaiting && !preservedWatchdogTerminal) {
        const terminal = await classifyFailure({
          cancelRequested,
          ...(caughtError === undefined ? {} : { error: caughtError }),
          events: runtime.events,
          ...(started === undefined
            ? {}
            : {
                stderrLogPath: providerStderrLogPath(
                  started.evidence.rawLogPath
                ),
                successWorkspace: {
                  baseBranch: input.project.workspace.git.base_branch,
                  headInspectionFailed,
                  ...(headShaAtAttemptStart === undefined
                    ? {}
                    : { headShaAtStart: headShaAtAttemptStart }),
                  workspacePath: started.evidence.workspacePath
                }
              })
        });
        let workflowOutcome: WorkflowOutcomeResult = {
          advancedToState: null,
          advancedToTerminal: false,
          blocked: false
        };
        // Retryable transient failures get first claim on the failed state. We
        // still evaluate terminal workflow transitions below, because a raw FSM
        // may intentionally map provider_success=false to terminal blocked/failure,
        // but non-terminal advances are deferred until the retry budget is spent.
        const deferRetryableTransientAdvance =
          terminal.kind === "failed" &&
          terminal.classification === "transient" &&
          this.runStore.runRetryCount(input.runId) <
            this.lifecyclePolicy.retry.cap;
        // loadedWorkflow can be undefined if this.loadWorkflow itself threw
        // before currentState was set; in that case we run the bare
        // classifyFailure outcome without an FSM-driven overlay.
        if (currentState !== undefined && loadedWorkflow !== undefined) {
          workflowOutcome = await this.applyWorkflowOutcome({
            actionExecuted: attemptCreated,
            currentState,
            deferRetryableTransientAdvance,
            issue: input.issue,
            project: input.project,
            runId: input.runId,
            terminal,
            workflow: loadedWorkflow.expandedWorkflow,
            workspacePath: started?.evidence.workspacePath
          });
        }
        const effectiveOutcome = fuseWorkflowTerminal(
          terminal,
          workflowOutcome.terminalLabel
        );
        const outcomeState = mapOutcomeToRunState(effectiveOutcome);
        if (attemptCreated) {
          this.runStore.updateAttemptState(attemptId, outcomeState);
        }
        this.runStore.recordTerminalReason(
          input.runId,
          effectiveOutcome.reason,
          effectiveOutcome.classification
        );
        const sourceKind = loadedWorkflow?.expandedWorkflow.source.kind;
        const isRawFsm = sourceKind === "raw_fsm";
        const suppressContinuation =
          isRawFsm &&
          (workflowOutcome.advancedToTerminal ||
            workflowOutcome.blocked ||
            workflowOutcome.advancedToState !== null);
        // Hold dispatchMutex from the terminal-state write through
        // scheduleNext's registration of the retry/continuation/state-advance
        // callback (this.schedule, surfaced to readers via getScheduled).
        // Without this, a run is briefly invisible to every liveness source
        // collectLiveRunEntries reads (activeRuns already unregistered it in
        // the finally-block's first step; the DB row just went terminal; no
        // scheduled callback exists yet) even though it is about to continue
        // via retry or FSM advance. handleClearStaleClaim / the PR-merge
        // guard acquire this same mutex before checking liveness, so holding
        // it here closes that window instead of racing it.
        await this.dispatchMutex.acquire();
        try {
          this.runStore.updateRunState(input.runId, outcomeState);

          const willRetry =
            effectiveOutcome.kind === "failed" &&
            effectiveOutcome.classification === "transient" &&
            this.runStore.runRetryCount(input.runId) <
              this.lifecyclePolicy.retry.cap;
          if (!willRetry) {
            // updateRunState deliberately defers transient failures because the
            // same Run row is reused by retries. Once the budget is exhausted,
            // this is the point that makes the genuinely-terminal attempt
            // visible to the durable notification digest (ADR 0071).
            try {
              this.runStore.markRunNotificationPending(input.runId);
            } catch (error) {
              this.logger?.warn(
                { err: error, runId: input.runId },
                "symphonika issue Run notification evidence write failed"
              );
            }
          }

          this.logger?.info(
            {
              attemptNumber: input.attemptNumber,
              cancelReason,
              cancelRequested,
              classification: effectiveOutcome.classification,
              isContinuation: input.isContinuation,
              issueNumber: input.issue.number,
              kind: effectiveOutcome.kind,
              project: input.project.name,
              runId: input.runId,
              state: outcomeState,
              terminalReason: effectiveOutcome.reason,
              willRetry,
              workflowTerminalLabel: workflowOutcome.terminalLabel
            },
            "symphonika run terminated"
          );

          // The raw-FSM walk is "continuing" when applyWorkflowOutcome either
          // advanced into a non-terminal next state or parked into a wait/merge_pr
          // action. In both cases the per-state ClassifiedTerminal may legitimately
          // be `failed` (e.g. a planning step that exited provider_success=true
          // without committing → no_workspace_changes) while the workflow as a
          // whole is not failing. applyTerminalLabels uses this to suppress
          // `sym:failed`, which subsequent successful states would otherwise leave
          // on the issue forever.
          const fsmContinuing =
            isRawFsm &&
            (workflowOutcome.advancedToState !== null ||
              workflowOutcome.parkAsWait === true);
          const labelInput: ApplyLabelsInput = {
            fsmContinuing,
            issueNumber: input.issue.number,
            outcome: effectiveOutcome,
            repository: input.repository,
            willRetry
          };
          if (cancelReason !== undefined) {
            labelInput.cancelReason = cancelReason;
          }
          await this.applyTerminalLabels(labelInput);

          // scheduleNext also handles transient throws (kind=failed/transient with retry budget).
          // It is a no-op for cancelled, deterministic, and input_required outcomes.
          try {
            await this.scheduleNext({
              ...(input.extraInstructions === undefined
                ? {}
                : { extraInstructions: input.extraInstructions }),
              issue: input.issue,
              outcome: effectiveOutcome,
              project: input.project,
              providerCommand: input.providerCommand,
              providerName: input.providerName,
              repository: input.repository,
              respectsIssueLabels,
              runId: input.runId,
              runtimeAttemptNumber: input.attemptNumber,
              willRetry,
              stateAdvance:
                isRawFsm &&
                workflowOutcome.advancedToState !== null &&
                workflowOutcome.parkAsWait !== true
                  ? {
                      toStateId: workflowOutcome.advancedToState
                    }
                  : null,
              waitPark:
                isRawFsm &&
                workflowOutcome.parkAsWait === true &&
                workflowOutcome.waitingRunId !== undefined
                  ? { waitingRunId: workflowOutcome.waitingRunId }
                  : null,
              suppressContinuation
            });
          } catch (scheduleError) {
            this.logger?.error(
              { err: scheduleError, runId: input.runId },
              "symphonika scheduleNext failed"
            );
          }
        } finally {
          this.dispatchMutex.release();
        }
      } // end if (!parkedAsWaiting)
    }

    if (caughtError !== undefined && !preservedWatchdogTerminal) {
      throw caughtError instanceof Error
        ? caughtError
        : new Error(
            typeof caughtError === "string" ? caughtError : "unknown error"
          );
    }
  }

  private async startAttempt(input: {
    attemptId: string;
    attemptNumber: number;
    extraInstructions?: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    project: DispatchProjectConfig;
    promptTemplate?: string;
    providerCommand: string;
    providerName: AgentProviderName;
    runId: string;
  }): Promise<StartedAttempt> {
    const prepared = await this.prepareIssueWorkspace({
      configDir: this.configDir,
      issue: {
        number: input.issue.number,
        title: input.issue.title
      },
      project: input.project
    });
    const workflow = await this.loadWorkflow(input.project.workflow);
    const workflowPath = workflow.path;
    if (workflow.errors.length > 0) {
      throw new Error(workflow.errors.join("\n"));
    }

    const promptInput = {
      branch: {
        name: prepared.branchName,
        ref: prepared.branchRef
      },
      ...(input.extraInstructions === undefined
        ? {}
        : { extraInstructions: input.extraInstructions }),
      issue: input.issue,
      project: { name: input.project.name },
      provider: {
        command: input.providerCommand,
        name: input.providerName
      },
      run: {
        attempt: input.attemptNumber,
        continuation: input.isContinuation,
        id: input.runId
      },
      template: input.promptTemplate ?? workflow.body,
      workflowContentHash: workflow.contentHash,
      workflowPath,
      workspace: {
        path: prepared.workspacePath,
        previous_attempt: prepared.reused,
        root: path.resolve(this.configDir, input.project.workspace.root)
      }
    };
    const renderedPrompt = renderAutonomousPrompt(promptInput);
    const evidence = await persistRunEvidence({
      ...promptInput,
      attemptNumber: input.attemptNumber,
      expandedWorkflow: workflow.expandedWorkflow,
      renderedPrompt,
      stateRoot: this.stateRoot
    });
    const attemptSuffix =
      input.attemptNumber === 1 ? "" : `.attempt-${input.attemptNumber}`;
    const rawLogPath = path.join(
      evidence.runEvidenceDirectory,
      `provider.raw${attemptSuffix}.jsonl`
    );
    const normalizedLogPath = path.join(
      evidence.runEvidenceDirectory,
      `provider.normalized${attemptSuffix}.jsonl`
    );
    await Promise.all([
      writeFile(rawLogPath, "", "utf8"),
      writeFile(normalizedLogPath, "", "utf8")
    ]);
    const attemptEvidence: AttemptEvidence = {
      branchName: prepared.branchName,
      branchRef: prepared.branchRef,
      issueSnapshotPath: evidence.issueSnapshotPath,
      metadataPath: evidence.metadataPath,
      normalizedLogPath,
      promptPath: evidence.promptPath,
      rawLogPath,
      workflowGraphPath: evidence.workflowGraphPath,
      workspacePath: prepared.workspacePath
    };
    this.runStore.updateRunEvidence(input.runId, attemptEvidence);

    return {
      evidence: attemptEvidence,
      prepared,
      prompt: renderedPrompt.prompt,
      promptPath: evidence.promptPath
    };
  }

  private async applyWorkflowOutcome(input: {
    actionExecuted: boolean;
    currentState: ExpandedWorkflowState;
    deferRetryableTransientAdvance?: boolean;
    issue: IssueSnapshot;
    project: RunControllerProjectConfig;
    runId: string;
    terminal: ClassifiedTerminal;
    workflow: ExpandedWorkflow;
    workspacePath: string | undefined;
  }): Promise<WorkflowOutcomeResult> {
    const signals = signalsFromTerminal(input.terminal);
    const artifactExists = await probeStateArtifacts({
      state: input.currentState,
      workspacePath: input.workspacePath
    });
    const decision = decideNextStep({
      actionExecuted: input.actionExecuted,
      ...(artifactExists === undefined ? {} : { artifactExists }),
      signals,
      state: input.currentState
    });

    if (decision.kind === "advance") {
      const next = findWorkflowState(input.workflow, decision.to);
      if (next?.terminal !== undefined) {
        this.runStore.recordWorkflowTerminal(input.runId, {
          terminalStateId: next.id,
          transitionReason: decision.reason
        });
        const terminalLabel = narrowTerminalLabel(next.terminal);
        return {
          advancedToState: null,
          advancedToTerminal: true,
          blocked: false,
          ...(terminalLabel === undefined ? {} : { terminalLabel })
        };
      }
      if (input.deferRetryableTransientAdvance === true) {
        return {
          advancedToState: null,
          advancedToTerminal: false,
          blocked: false
        };
      }
      this.runStore.recordWorkflowStateAdvance(input.runId, {
        nextStateId: decision.to,
        transitionReason: decision.reason
      });
      if (isParkedAction(next?.action?.kind)) {
        const waitingRunId = this.createRunId();
        this.runStore.createWaitingRun({
          currentStateId: decision.to,
          id: waitingRunId,
          issue: input.issue,
          parentRunId: input.runId,
          projectName: input.project.name,
          ...(input.workspacePath === undefined
            ? {}
            : { workspacePath: input.workspacePath })
        });
        return {
          advancedToState: decision.to,
          advancedToTerminal: false,
          blocked: false,
          parkAsWait: true,
          waitingRunId
        };
      }
      return {
        advancedToState: decision.to,
        advancedToTerminal: false,
        blocked: false
      };
    }

    if (decision.kind === "blocked") {
      this.runStore.recordWorkflowBlocked(input.runId, {
        stateId: input.currentState.id,
        transitionReason: decision.reason
      });
      return {
        advancedToState: null,
        advancedToTerminal: false,
        blocked: true
      };
    }

    if (decision.kind === "terminate") {
      this.runStore.recordWorkflowTerminal(input.runId, {
        terminalStateId: decision.stateId,
        transitionReason: `entered terminal state ${decision.terminal}`
      });
      const terminalLabel = narrowTerminalLabel(decision.terminal);
      return {
        advancedToState: null,
        advancedToTerminal: true,
        blocked: false,
        ...(terminalLabel === undefined ? {} : { terminalLabel })
      };
    }

    return { advancedToState: null, advancedToTerminal: false, blocked: false };
  }

  private lastKnownGoodLoadedWorkflow(
    workflow: WorkflowReference | WorkflowSnapshot
  ): LoadedWorkflow | undefined {
    if (!("expandedWorkflow" in workflow)) {
      return undefined;
    }
    return {
      body: workflow.body,
      contentHash: workflow.contentHash,
      evidence: workflow.evidence,
      errors: [],
      expandedWorkflow: workflow.expandedWorkflow,
      format: workflow.format,
      path: workflow.path
    };
  }

  private async loadWorkflow(
    workflow: WorkflowReference | WorkflowSnapshot,
    options: { forceReload?: boolean } = {}
  ): Promise<LoadedWorkflow> {
    if (!("expandedWorkflow" in workflow) || options.forceReload === true) {
      const workflowPath = path.resolve(this.configDir, workflow.path);
      const contents = await readFile(workflowPath, "utf8");
      const format = workflow.format;
      const expanded = await expandWorkflowDefinition(
        contents,
        workflowPath,
        format
      );
      // Raw FSM YAML files commonly open with the `---` document marker; the
      // markdown contract parser would reject those as missing a closing
      // delimiter. Skip it entirely for raw FSM — per-state `action.prompt`
      // files supply the actual prompt at dispatch time.
      if (expanded.workflow.source.kind === "raw_fsm") {
        return {
          body: "",
          contentHash: expanded.workflow.contentHash,
          evidence: { ignore: [] },
          errors: expanded.errors,
          expandedWorkflow: expanded.workflow,
          format,
          path: workflowPath
        };
      }
      const contract = parseWorkflowContract(contents, workflowPath);
      return {
        body: contract.body,
        contentHash: contract.contentHash,
        evidence: contract.evidence,
        errors: [...contract.errors, ...expanded.errors],
        expandedWorkflow: expanded.workflow,
        format,
        path: workflowPath
      };
    }

    return {
      body: workflow.body,
      contentHash: workflow.contentHash,
      evidence: workflow.evidence,
      errors: [],
      expandedWorkflow: workflow.expandedWorkflow,
      format: workflow.format,
      path: workflow.path
    };
  }

  private async iterateAttempt(input: {
    attemptId: string;
    attemptNumber: number;
    evidence: AttemptEvidence;
    issue: IssueSnapshot;
    prompt: string;
    promptPath: string;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
    repositoryToken: string;
    runId: string;
    runtime: RunRuntime;
  }): Promise<void> {
    const scratchIdentity = {
      attempt: input.attemptNumber,
      id: input.runId
    };
    // Allocated per attempt and removed below, so the agent's build output
    // lands on disk instead of a RAM-backed /tmp and cannot outlive the
    // attempt that produced it. See ADR 0088.
    const scratchPath = await createProviderScratch(
      this.stateRoot,
      scratchIdentity
    );
    let sequence = 0;
    try {
      for await (const event of input.provider.runAttempt({
        branchName: input.evidence.branchName,
        issue: input.issue,
        prompt: input.prompt,
        promptPath: input.promptPath,
        provider: {
          command: input.providerCommand,
          name: input.providerName
        },
        run: scratchIdentity,
        scratchPath,
        stderrLogPath: providerStderrLogPath(input.evidence.rawLogPath),
        // Providers run full-permission and inherit this process's env
        // (provider-process.ts spawns with `{ ...process.env }`), so an agent
        // that echoes its GitHub token would otherwise persist it verbatim
        // into an artifact the dashboard serves. SPEC.md §6. The wider gap —
        // this token is not scrubbed from a Run's own raw/normalized evidence
        // either, and the Run path resolves no other secrets — is issue #612.
        stderrRedactSecrets: [input.repositoryToken],
        workspacePath: input.evidence.workspacePath
      })) {
        sequence += 1;
        await this.persistProviderEvent({
          attemptId: input.attemptId,
          event,
          normalizedLogPath: input.evidence.normalizedLogPath,
          rawLogPath: input.evidence.rawLogPath,
          runId: input.runId,
          sequence
        });
        if (event.normalized !== undefined) {
          input.runtime.events.push(event.normalized);
        }
      }
    } finally {
      // Best effort: failing to delete temporary files must never mask the
      // attempt's own outcome. The startup sweep reclaims what is left.
      await this.bestEffort(
        () => removeProviderScratch(this.stateRoot, scratchIdentity),
        {
          issueNumber: input.issue.number,
          operation: "removeProviderScratch",
          runId: input.runId
        }
      );
    }
  }

  private async persistProviderEvent(input: {
    attemptId: string;
    event: ProviderEvent;
    normalizedLogPath: string;
    rawLogPath: string;
    runId: string;
    sequence: number;
  }): Promise<void> {
    await Promise.all([
      appendJsonl(input.rawLogPath, input.event.raw),
      ...(input.event.normalized === undefined
        ? []
        : [appendJsonl(input.normalizedLogPath, input.event.normalized)])
    ]);
    if (input.event.normalized === undefined) {
      this.runStore.recordProviderStreamEvent({
        attemptId: input.attemptId,
        runId: input.runId,
        sequence: input.sequence
      });
      return;
    }
    this.runStore.recordProviderEvent({
      attemptId: input.attemptId,
      normalized: input.event.normalized,
      raw: input.event.raw,
      runId: input.runId,
      sequence: input.sequence
    });
  }

  // Independent, best-effort add: called alongside the sym:* label in both
  // markIssueFailed and markIssueBlocked so a human-attention signal exists
  // regardless of which terminal-failure path was taken (exhausted retries,
  // provider asking for input, or an explicit blocked terminal). Kept as its
  // own try/catch so a sym:* label failure never suppresses this one, and
  // vice versa. sym:human-needed uses the sym: prefix like every other
  // orchestrator-owned label (sym:claimed/running/blocked/failed/stale) —
  // distinct from the pre-existing manual "needs-human" convention operators
  // may add by hand. It is listed in REQUIRED_OPERATIONAL_LABELS, so
  // evaluateProjectEligibility (issue-polling.ts) already excludes it from
  // redispatch while agent-ready is still present, the same way sym:blocked
  // and sym:failed do.
  private async markIssueNeedsHuman(input: {
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
  }): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    try {
      await api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:human-needed"]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:human-needed label"
      );
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      "symphonika marked issue sym:human-needed"
    );
  }

  private async markIssueFailed(input: {
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
  }): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    try {
      await api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:failed"]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:failed label; sym:claimed left in place"
      );
      await this.markIssueNeedsHuman(input);
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      "symphonika marked issue sym:failed"
    );
    await this.markIssueNeedsHuman(input);
  }

  private async markIssueBlocked(input: {
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
  }): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    try {
      await api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:blocked"]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:blocked label; sym:claimed left in place"
      );
      await this.markIssueNeedsHuman(input);
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      "symphonika marked issue sym:blocked"
    );
    await this.markIssueNeedsHuman(input);
  }

  private async applyTerminalLabels(input: ApplyLabelsInput): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    if (input.outcome.kind === "cancelled") {
      const reason = input.cancelReason;
      await this.bestEffort(
        () =>
          api.removeLabelsFromIssue({
            ...input.repository,
            issueNumber: input.issueNumber,
            labels: ["sym:running"]
          }),
        {
          issueNumber: input.issueNumber,
          label: "sym:running",
          operation: "removeLabel",
          phase: "cancelled"
        }
      );
      if (
        reason === CANCEL_REASONS.CLOSED_ISSUE ||
        reason === CANCEL_REASONS.ELIGIBILITY_LOSS
      ) {
        await this.releaseIssueClaim({
          issueNumber: input.issueNumber,
          phase:
            reason === CANCEL_REASONS.CLOSED_ISSUE
              ? "closed-issue-cleanup"
              : "eligibility-loss-cleanup",
          repository: input.repository
        });
      }
      if (reason === CANCEL_REASONS.CLOSED_ISSUE) {
        await this.bestEffort(
          () =>
            api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:failed"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:failed",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
        await this.bestEffort(
          () =>
            api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:blocked"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:blocked",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
        await this.bestEffort(
          () =>
            api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:human-needed"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:human-needed",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
      }
      return;
    }

    await this.bestEffort(
      () =>
        api.removeLabelsFromIssue({
          ...input.repository,
          issueNumber: input.issueNumber,
          labels: ["sym:running"]
        }),
      {
        issueNumber: input.issueNumber,
        label: "sym:running",
        operation: "removeLabel",
        phase: "terminal"
      }
    );

    // Skip `sym:failed` only for `failed && !willRetry` outcomes when the
    // raw-FSM walk advanced or parked: the per-state outcome is failed
    // (e.g. no_workspace_changes on a planning step that exited
    // provider_success=true) but the workflow as a whole is continuing,
    // and a later successful state would otherwise leave `sym:failed` on
    // the issue because the success path here only removes `sym:running`.
    //
    // `input_required` is always terminal regardless of `fsmContinuing`:
    // `scheduleNext` returns immediately for input_required at the top of
    // its method, so no FSM continuation is actually scheduled even when
    // applyWorkflowOutcome's signals matched a non-terminal transition.
    // Suppressing `sym:failed` there would orphan the issue with neither
    // `sym:running` nor `sym:failed` nor a continuation.
    if (input.outcome.kind === "input_required") {
      await this.markIssueFailed({
        issueNumber: input.issueNumber,
        repository: input.repository
      });
      return;
    }
    if (
      input.outcome.kind === "failed" &&
      !input.willRetry &&
      !input.fsmContinuing
    ) {
      if (isBlockedOutcome(input.outcome)) {
        await this.markIssueBlocked({
          issueNumber: input.issueNumber,
          repository: input.repository
        });
      } else {
        await this.markIssueFailed({
          issueNumber: input.issueNumber,
          repository: input.repository
        });
      }
    }
  }

  private async releaseIssueClaim(input: {
    issueNumber: number;
    phase:
      | "closed-issue-cleanup"
      | "continuation"
      | "continuation-closed-issue"
      | "continuation-eligibility-loss"
      | "continuation-scheduling-closed-issue"
      | "continuation-scheduling-eligibility-loss"
      | "eligibility-loss-cleanup"
      | "state-advance";
    repository: GitHubIssueRepositoryInput;
  }): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    await this.bestEffort(
      () =>
        api.removeLabelsFromIssue({
          ...input.repository,
          issueNumber: input.issueNumber,
          labels: ["sym:claimed"]
        }),
      {
        issueNumber: input.issueNumber,
        label: "sym:claimed",
        operation: "removeLabel",
        phase: input.phase
      }
    );
  }

  private async scheduleNext(input: {
    extraInstructions?: string;
    issue: IssueSnapshot;
    outcome: ClassifiedTerminal;
    project: DispatchProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    respectsIssueLabels?: boolean;
    runId: string;
    runtimeAttemptNumber: number;
    stateAdvance?: { toStateId: string } | null;
    suppressContinuation?: boolean;
    waitPark?: { waitingRunId: string } | null;
    // Same boolean computed at the call site for applyTerminalLabels. Used
    // by the stateAdvance bail-out path to decide between restoring
    // `sym:failed` (failed && !willRetry — applyTerminalLabels suppressed it
    // because fsmContinuing was true) and falling through to the failed
    // branch so the retry can fire (failed && willRetry).
    willRetry: boolean;
  }): Promise<void> {
    if (
      input.outcome.kind === "cancelled" ||
      input.outcome.kind === "input_required"
    ) {
      return;
    }

    // Raw FSM mid-walk: the workflow predicate engine — not the per-state
    // ClassifiedTerminal — decides what runs next, except that retryable
    // transient failures defer non-terminal advances before this method ever
    // receives stateAdvance. A step that exits provider_success=true without
    // committing still yields a deterministic `no_workspace_changes` outcome,
    // but applyWorkflowOutcome may have advanced the FSM (e.g. plan ->
    // implement gated only on provider_success). Fire the FSM continuation
    // before the failed branch so the next state runs even when the source
    // state's per-state result classifies as failed. State advance also skips
    // the continuation cap and asks only the fsm_owned Continuation
    // Eligibility question; see evaluateRunContinuationEligibility.
    if (input.stateAdvance != null) {
      const stateAdvance = input.stateAdvance;
      const refreshedForAdvance = await this.refreshIssue({
        project: input.project,
        issueNumber: input.issue.number,
        repository: input.repository
      });
      const canScheduleAdvance =
        refreshedForAdvance !== undefined &&
        refreshedForAdvance !== null &&
        evaluateRunContinuationEligibility(refreshedForAdvance, input.project, {
          scope: "fsm_owned"
        }).eligible;
      if (canScheduleAdvance) {
        this.logger?.info(
          {
            delayMs: this.lifecyclePolicy.continuation.delayMs,
            issueNumber: refreshedForAdvance.number,
            parentRunId: input.runId,
            project: input.project.name,
            toStateId: stateAdvance.toStateId
          },
          "symphonika scheduling state advance"
        );
        this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () =>
            this.executeStateAdvance({
              issue: refreshedForAdvance,
              parentRunId: input.runId,
              projectName: input.project.name,
              toStateId: stateAdvance.toStateId
            }),
          issueNumber: refreshedForAdvance.number,
          kind: "state_advance",
          projectName: input.project.name,
          runId: input.runId
        });
        return;
      }
      // Bail-out: `refreshIssue` returned `undefined` (transient API error)
      // or the issue is closed/missing (null or non-open). `applyTerminalLabels`
      // was called before `scheduleNext` with `fsmContinuing=true` (any
      // stateAdvance != null implies it). What it did depends on the outcome:
      //
      // - `failed && !willRetry`: applyTerminalLabels suppressed `sym:failed`
      //   (or `sym:blocked`, see isBlockedOutcome) on the assumption that the
      //   FSM would continue. The suppression promise is now broken; restore
      //   whichever label matches the outcome so the issue is not orphaned
      //   with only `sym:claimed`. Then return — there is no retry to fire and
      //   no continuation to schedule.
      // - `failed && willRetry`: applyTerminalLabels did not add either label
      //   (it short-circuited on `willRetry`). The transient-retry branch
      //   below is the right path; fall through so it fires.
      // - `success`: applyTerminalLabels did not add either label, and no
      //   retry applies. Fall through; `suppressContinuation` (always true
      //   when `stateAdvance != null`) ends the call.
      if (input.outcome.kind === "failed" && !input.willRetry) {
        if (isBlockedOutcome(input.outcome)) {
          await this.markIssueBlocked({
            issueNumber: input.issue.number,
            repository: input.repository
          });
        } else {
          await this.markIssueFailed({
            issueNumber: input.issue.number,
            repository: input.repository
          });
        }
        return;
      }
      // For all other outcomes, fall through to the subsequent branches.
    }

    // Raw FSM advanced into a wait state: the waiting row was already created
    // synchronously by applyWorkflowOutcome (so a daemon restart can recover
    // it). Schedule a one-shot re-evaluation; subsequent re-evaluations come
    // from the daemon tick's reconcileWaitingRuns pass. Sits above the failed
    // branch for the same reason as state advance: the FSM may legitimately
    // park even when the source state's per-state result classifies as failed.
    // Retryable transient failures defer this park before waitPark is created.
    if (input.waitPark != null) {
      this.logger?.info(
        {
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          issueNumber: input.issue.number,
          parentRunId: input.runId,
          project: input.project.name,
          waitingRunId: input.waitPark.waitingRunId
        },
        "symphonika scheduling wait re-evaluation"
      );
      const waitingRunId = input.waitPark.waitingRunId;
      this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () => this.executeWaitPark({ waitingRunId }),
        issueNumber: input.issue.number,
        kind: "wait_park",
        projectName: input.project.name,
        runId: input.runId
      });
      return;
    }

    if (input.outcome.kind === "failed") {
      if (input.outcome.classification !== "transient") {
        return;
      }
      const currentRetries = this.runStore.runRetryCount(input.runId);
      if (currentRetries >= this.lifecyclePolicy.retry.cap) {
        return;
      }
      const next = this.runStore.incrementRetryCount(input.runId);
      const delayMs = computeRetryDelayMs(next, this.lifecyclePolicy);
      this.schedule({
        delayMs,
        fire: () =>
          this.executeRetry({
            attemptNumber: input.runtimeAttemptNumber + 1,
            ...(input.extraInstructions === undefined
              ? {}
              : { extraInstructions: input.extraInstructions }),
            issue: input.issue,
            projectName: input.project.name,
            providerCommand: input.providerCommand,
            providerName: input.providerName,
            // Carry the FSM mid-walk label-immunity bit into the retry. Without
            // this a transient provider failure during a raw FSM walk would be
            // cancelled with ELIGIBILITY_LOSS the moment labels drift, even
            // though the in-flight attempt and the success-to-next-state path
            // are both label-immune. See ADR 0046.
            ...(input.respectsIssueLabels === false
              ? { respectsIssueLabels: false }
              : {}),
            runId: input.runId
          }),
        issueNumber: input.issue.number,
        kind: "retry",
        projectName: input.project.name,
        runId: input.runId
      });
      return;
    }

    // success path: re-check eligibility, schedule continuation, enforce cap.
    // For raw FSM workflows that reached an explicit terminal node or blocked
    // on a missing transition, the FSM owns the decision to stop — do not
    // schedule another continuation even if the issue still matches
    // `agent-ready`. Markdown compatibility-graph workflows keep the legacy
    // "loop on agent-ready" behavior.
    if (input.suppressContinuation === true) {
      this.logger?.info(
        {
          issueNumber: input.issue.number,
          project: input.project.name,
          runId: input.runId
        },
        "symphonika workflow suppressed label-driven continuation"
      );
      return;
    }

    const refreshed = await this.refreshIssue({
      project: input.project,
      issueNumber: input.issue.number,
      repository: input.repository
    });
    if (refreshed === undefined) {
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      // Issue closure ends every Continuation Eligibility scope, including
      // label-immune PR Follow-up work. The completed run has already
      // released its in-flight slot and no continuation will be scheduled,
      // so the Issue Reservation ends here. See SPEC section 9.3.
      await this.releaseIssueClaim({
        issueNumber: input.issue.number,
        phase: "continuation-scheduling-closed-issue",
        repository: input.repository
      });
      return;
    }
    if (
      !evaluateRunContinuationEligibility(refreshed, input.project, {
        scope: "label_controlled"
      }).eligible
    ) {
      // Raw-FSM mid-walk / label-immune runs (respectsIssueLabels === false,
      // e.g. a PR Follow-up dispatch) intentionally never gate continuation
      // scheduling on labels_all/labels_none (see ADR 0046), so ineligibility
      // on an open issue is expected steady state, not a lost reservation —
      // releasing sym:claimed for it would strip the claim out from under a
      // still-live parked/waiting Run that owns the same Issue Reservation.
      if (input.respectsIssueLabels !== false) {
        await this.releaseIssueClaim({
          issueNumber: input.issue.number,
          phase: "continuation-scheduling-eligibility-loss",
          repository: input.repository
        });
      }
      return;
    }

    if (this.lifecyclePolicy.continuation.cap <= 0) {
      // Continuations disabled; nothing to schedule and nothing to surface as cap-reached.
      return;
    }

    const succeededContinuations = this.runStore.countSucceededContinuations(
      input.project.name,
      input.issue.number
    );
    if (succeededContinuations >= this.lifecyclePolicy.continuation.cap) {
      const parent = this.runStore.getRun(input.runId);
      const kind = await classifyCapReachedOutcome({
        api: this.githubIssuesApi,
        branch: parent?.branchName ?? "",
        logger: this.logger,
        repository: input.repository
      });
      const capId = this.createRunId();
      this.logger?.info(
        {
          cap: this.lifecyclePolicy.continuation.cap,
          capRunId: capId,
          issueNumber: input.issue.number,
          kind,
          parentRunId: input.runId,
          project: input.project.name,
          succeededContinuations
        },
        "symphonika continuation cap reached; marking issue failed"
      );
      this.runStore.createCapReachedFailureRun({
        id: capId,
        issue: refreshed,
        parentRunId: input.runId,
        projectName: input.project.name,
        reason: buildCapReachedReason(kind)
      });
      await this.markIssueFailed({
        issueNumber: input.issue.number,
        repository: input.repository
      });
      return;
    }

    this.logger?.info(
      {
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        issueNumber: refreshed.number,
        parentRunId: input.runId,
        project: input.project.name,
        succeededContinuations
      },
      "symphonika scheduling continuation"
    );

    this.schedule({
      delayMs: this.lifecyclePolicy.continuation.delayMs,
      fire: () =>
        this.executeContinuation({
          issue: refreshed,
          parentRunId: input.runId,
          projectName: input.project.name,
          ...(input.respectsIssueLabels === false
            ? { respectsIssueLabels: false }
            : {})
        }),
      issueNumber: refreshed.number,
      kind: "continuation",
      projectName: input.project.name,
      runId: input.runId
    });
  }

  private async refreshIssue(input: {
    project: DispatchProjectConfig;
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
  }): Promise<IssueSnapshot | null | undefined> {
    let raw;
    try {
      raw = await tryGetIssue(this.githubIssuesApi, {
        issueNumber: input.issueNumber,
        owner: input.repository.owner,
        repo: input.repository.repo,
        token: input.repository.token
      });
    } catch (error) {
      this.logger?.warn(
        { err: error },
        "symphonika continuation refresh failed"
      );
      return undefined;
    }
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null) {
      return null;
    }
    const snapshot = normalizeRawIssue(raw, input.project);
    // Refreshed snapshots feed Continuation Eligibility before scheduled
    // work re-asserts its claim. Label-controlled work applies the same
    // Dependency Gate as the poll loop; FSM-owned work deliberately ignores
    // dependency drift under ADR 0082. Without this refresh, the former would
    // read absent blockedBy fields as "no blockers". A dependency-fetch error
    // is narrower than an issue-fetch error: the REST snapshot above is still
    // good, so keep it and mark blockedByTruncated true (the existing
    // fail-closed shape for label-controlled work) rather than discarding the
    // whole refresh via `return undefined`. Every caller treats undefined as
    // "drop the scheduled work entirely", which would let one transient
    // GraphQL error permanently cancel work instead of applying its selected
    // eligibility scope.
    let dependencies;
    try {
      dependencies = await tryGetIssueDependencies(this.githubIssuesApi, {
        issueNumbers: [input.issueNumber],
        owner: input.repository.owner,
        repo: input.repository.repo,
        token: input.repository.token
      });
    } catch (error) {
      this.logger?.warn(
        { err: error },
        "symphonika continuation dependency refresh failed"
      );
      snapshot.blockedByTruncated = true;
      return snapshot;
    }
    const issueDependencies = dependencies?.get(input.issueNumber);
    if (issueDependencies !== undefined) {
      snapshot.blockedBy = issueDependencies.blockedBy;
      snapshot.blockedByTruncated = issueDependencies.truncated;
    }
    return snapshot;
  }

  private async bestEffort(
    fn: () => Promise<void>,
    context?: Record<string, unknown>
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger?.warn(
        { err, ...context },
        "symphonika best-effort op failed; continuing"
      );
    }
  }
}

function renderReviewFollowupInstructions(
  review: ReviewFollowupContext
): string {
  const lines = [
    "## Pull request review follow-up",
    "",
    "Symphonika detected unaddressed reviewer feedback on an existing pull request for this issue.",
    `PR: #${review.pullRequestNumber} ${review.pullRequestUrl}`,
    `Head SHA: ${review.headSha || "unknown"}`,
    `Review decision: ${review.reviewDecision ?? "none"}`,
    `Status checks: ${review.statusCheckRollupState ?? "unknown"}`,
    "",
    "This is a follow-up run, not a fresh PR creation run. Stay on the existing issue branch, address the review feedback below, push the same branch, and use the local `gh` CLI to reply to the PR review thread when appropriate. Do not open a second pull request.",
    "",
    "### Unaddressed review feedback",
    ""
  ];

  if (review.unresolvedThreads.length === 0) {
    lines.push(
      "- GitHub reported requested changes but did not expose unresolved review threads."
    );
    return `${lines.join("\n")}\n`;
  }

  for (const thread of review.unresolvedThreads) {
    const location = [thread.path, thread.line].filter(Boolean).join(":");
    lines.push(
      `#### Thread ${thread.id}${location.length === 0 ? "" : ` (${location})`}`
    );
    if (thread.isOutdated === true) {
      lines.push("Outdated: true");
    }
    for (const comment of thread.comments) {
      const author = comment.author ?? "unknown";
      const createdAt = comment.createdAt ?? "unknown time";
      const url = comment.url ?? "";
      lines.push(
        `- ${author} at ${createdAt}${url.length === 0 ? "" : ` (${url})`}:`
      );
      lines.push(indentReviewBody(comment.body ?? ""));
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function indentReviewBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return "  (empty comment)";
  }
  return trimmed
    .split(/\r?\n/)
    .slice(0, 80)
    .map((line) => `  ${line}`)
    .join("\n");
}

function isLabelWritingGitHubIssuesApi(
  api: GitHubIssuesApi
): api is LabelWritingGitHubIssuesApi {
  const candidate = api as Partial<LabelWritingGitHubIssuesApi>;
  return (
    typeof candidate.addLabelsToIssue === "function" &&
    typeof candidate.removeLabelsFromIssue === "function"
  );
}

function resolveTokenFromEnv(
  reference: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
  if (match === null) {
    return undefined;
  }
  const value = env[match[1] ?? ""];
  return value === undefined || value.length === 0 ? undefined : value;
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function normalizeRawIssue(
  raw: import("../issue-polling.js").RawGitHubIssue,
  project: DispatchProjectConfig
): IssueSnapshot {
  const labels = normalizeLabels(raw.labels ?? []);
  return {
    body: raw.body ?? "",
    created_at: raw.created_at ?? "",
    id: raw.id ?? 0,
    labels,
    number: raw.number ?? 0,
    priority: priorityForLabels(labels, project.priority),
    state: raw.state ?? "open",
    title: raw.title ?? "",
    updated_at: raw.updated_at ?? "",
    url: raw.html_url ?? raw.url ?? ""
  };
}

function isParkedAction(kind: string | undefined): boolean {
  return kind === "wait" || kind === "merge_pr";
}

// True when every predicate a wait state names can be answered without
// observing a pull request: at least one artifact predicate, and nothing beyond
// artifact predicates and `provider_success`, which wait re-evaluation always
// supplies. Deliberately strict — `branch_ahead_of_base` and the PR signals are
// not projected on this path, and treating an unprojected signal as merely
// "unmet" would let a catch-all transition fire on the first poll.
function isArtifactOnlyWaitState(state: ExpandedWorkflowState): boolean {
  let sawArtifact = false;
  for (const key of statePredicateKeys(state)) {
    if (workflowPredicateEvaluation(key) === "artifact") {
      sawArtifact = true;
      continue;
    }
    if (key !== "provider_success") {
      return false;
    }
  }
  return sawArtifact;
}

function coerceMergeMethod(
  method: string | undefined
): PullRequestFollowupPolicy["merge"]["method"] | undefined {
  if (method === "merge" || method === "rebase" || method === "squash") {
    return method;
  }
  return undefined;
}
