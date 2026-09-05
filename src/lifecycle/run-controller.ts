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
import { projectPullRequestSignals } from "../workflow/pr-signal-projection.js";
import type {
  AgentProvider,
  AgentProviderName,
  AgentProviderRegistry,
  NormalizedProviderEvent,
  ProviderEvent
} from "../provider.js";
import type { WatchdogConfig } from "../reload.js";
import {
  secretsForEmailConfig,
  type EmailNotificationConfig
} from "../notifications/config.js";
import { redactValueDeep } from "../redaction.js";
import type { CancelReason, ProgressEdge, RunStore } from "../run-store.js";
import { WATCHDOG_TERMINAL_REASONS } from "../run-store.js";
import type {
  IssueWorkspacePreparation,
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../workspace.js";
import {
  prepareIssueWorkspace as defaultPrepareIssueWorkspace,
  WorkspacePreparationCleanupError
} from "../workspace.js";
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
import { raceAbortSignal } from "../abort-race.js";
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
  ClaimLabelWriter,
  type ApplyLabelsInput
} from "./claim-label-writer.js";
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
  removeProviderScratch,
  type ProviderScratchIdentity
} from "./provider-scratch.js";
import { decideNextStep, findWorkflowState } from "./state-machine-dispatch.js";
import {
  buildCapReachedReason,
  buildMergePrRefusedReason
} from "./terminal-reason.js";

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
  // See ScheduledWorkInput's onShutdown for the contract; forwarded verbatim
  // by every daemon/CLI wiring of this handler.
  onShutdown?: () => Promise<void>;
  projectName: string;
  runId: string;
}) => boolean;

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
  // Required, not optional: this loader supplies half the Project credential
  // inventory, and a caller that omits it silently drops the SMTP password from
  // every evidence boundary a Run writes. That silent-omission shape is exactly
  // what issue #612 was. Return undefined for "no email sink configured".
  emailConfigLoader: () => EmailNotificationConfig | undefined;
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
  // Receives the same lifecycle event as the sampled Watchdog observer when
  // the slot-owned Run deadline wins. The daemon uses it for health
  // notifications; the Run Store CAS guarantees exactly-once delivery.
  onWatchdogTerminated?: WatchdogTerminationObserver;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => IssueWorkspacePreparation;
  // Optional one-shot override for provider environment sizing. Daemon
  // callers reuse globalConcurrencyLoader; the explicit one-shot dispatch
  // supplies this loader without turning its config value into an admission
  // gate (ADR 0053).
  providerBuildCapacityLoader?: () => Promise<{
    maxInFlight: number | undefined;
  }>;
  projectsLoader: () => Promise<Map<string, RunControllerProjectConfig>>;
  providersLoader: () => Promise<RunControllerProvidersConfig>;
  pullRequestPolicyLoader?: () => Promise<PullRequestFollowupPolicy>;
  runStore: RunStore;
  schedule: ScheduleHandler;
  stateRoot: string;
  // Resolves the effective daemon + Project Watchdog policy at slot claim.
  // Synchronous: it reads an in-memory config snapshot, and both call sites
  // are inside the dispatch mutex. Omitted by one-shot/unit callers that do
  // not run the daemon Watchdog.
  watchdogConfigLoader?: (projectName: string) => RunDeadlinePolicy;
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
  // Resolved once at attempt start and reused for every evidence boundary
  // (stderr tee, each event, the terminal-reason classification) so a
  // Service Config reload mid-attempt cannot leave one boundary scrubbing a
  // different credential set than another. See SPEC.md §6.
  redactSecrets: readonly string[];
};

type StartedAttempt = {
  evidence: AttemptEvidence;
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

// The Watchdog policy slice a Run Slot Deadline needs: whether the cap is on
// at all, and how many wall-clock minutes it allows from the Run's claim.
type RunDeadlinePolicy = Pick<WatchdogConfig, "enabled" | "maxRunMinutes">;

type WatchdogTerminationObserver = (run: {
  issueNumber: number;
  projectName: string;
  runId: string;
}) => void;

class RunTimeoutError extends Error {
  constructor() {
    super(
      "run exceeded its wall-clock timeout while owning a concurrency slot"
    );
    this.name = "RunTimeoutError";
  }
}

type RunSlotDeadline = {
  abortPreparation: () => Promise<void>;
  arm: () => void;
  clear: () => void;
  race: <T>(operation: Promise<T>) => Promise<T>;
  // Spreadable so bounded call sites read `...deadline.signalOption` instead
  // of re-deriving "is there a deadline" at each one.
  signalOption: { signal?: AbortSignal };
  signal: AbortSignal | undefined;
};

const NO_RUN_SLOT_DEADLINE: RunSlotDeadline = {
  abortPreparation: () => Promise.resolve(),
  arm: () => undefined,
  clear: () => undefined,
  race: (operation) => operation,
  signalOption: {},
  signal: undefined
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RUN_SLOT_DEADLINE_ABORT_MESSAGE = "Run slot deadline aborted";

// The single reading of "is the Run wall-clock cap active", in milliseconds.
// Every deadline in this module derives its expiry from this one predicate.
function runCapMs(config: RunDeadlinePolicy): number | undefined {
  return config.enabled && config.maxRunMinutes > 0
    ? config.maxRunMinutes * 60_000
    : undefined;
}

function runSlotDeadline(input: {
  expiresAtMs: number;
  onExpire: () => void;
}): RunSlotDeadline {
  const controller = new AbortController();
  const { expiresAtMs } = input;
  let timer: NodeJS.Timeout | undefined;
  let cleared = false;
  const clear = (): void => {
    cleared = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const expire = (): void => {
    if (cleared || controller.signal.aborted) {
      return;
    }
    controller.abort(new RunTimeoutError());
    input.onExpire();
  };
  const schedule = (): void => {
    if (cleared || controller.signal.aborted) {
      return;
    }
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    timer = setTimeout(schedule, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  };
  const abortPreparation = (): Promise<void> => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("run cancelled before provider start"));
    }
    clear();
    return Promise.resolve();
  };
  return {
    abortPreparation,
    arm: schedule,
    clear,
    race: <T>(operation: Promise<T>): Promise<T> =>
      raceAbortSignal(
        operation,
        controller.signal,
        RUN_SLOT_DEADLINE_ABORT_MESSAGE
      ),
    signalOption: { signal: controller.signal },
    signal: controller.signal
  };
}

export class RunController {
  private readonly activeRuns: ActiveRunRegistry;
  private readonly agentProviders: AgentProviderRegistry;
  private readonly claimLabels: ClaimLabelWriter;
  private readonly configDir: string;
  private readonly createRunId: () => string;
  private readonly dispatchMutex: AsyncMutex;
  private readonly emailConfigLoader: () => EmailNotificationConfig | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fileOverlapGuard: DispatchFileOverlapGuard;
  private readonly githubIssuesApi: GitHubIssuesApi;
  private readonly globalConcurrencyLoader: () => Promise<{
    maxInFlight: number | undefined;
  }>;
  private readonly hostPressureGate: HostPressureGate | undefined;
  private readonly lifecyclePolicy: LifecyclePolicy;
  private readonly logger?: Logger;
  private readonly onWatchdogTerminated:
    WatchdogTerminationObserver | undefined;
  private readonly prepareIssueWorkspace: (
    input: PrepareIssueWorkspaceInput
  ) => IssueWorkspacePreparation;
  private readonly providerBuildCapacityLoader: () => Promise<{
    maxInFlight: number | undefined;
  }>;
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
  private readonly watchdogConfigLoader: (
    projectName: string
  ) => RunDeadlinePolicy;

  constructor(options: RunControllerOptions) {
    this.activeRuns = options.activeRuns;
    this.agentProviders = options.agentProviders;
    this.claimLabels = new ClaimLabelWriter({
      api: options.githubIssuesApi as LabelWritingGitHubIssuesApi,
      ...(options.logger === undefined ? {} : { logger: options.logger })
    });
    this.configDir = options.configDir;
    this.createRunId = options.createRunId ?? randomUUID;
    this.dispatchMutex = options.dispatchMutex ?? createAsyncMutex();
    this.emailConfigLoader = options.emailConfigLoader;
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
    this.onWatchdogTerminated = options.onWatchdogTerminated;
    this.prepareIssueWorkspace =
      options.prepareIssueWorkspace ?? defaultPrepareIssueWorkspace;
    this.providerBuildCapacityLoader =
      options.providerBuildCapacityLoader ?? this.globalConcurrencyLoader;
    this.projectsLoader = options.projectsLoader;
    this.providersLoader = options.providersLoader;
    this.pullRequestPolicyLoader =
      options.pullRequestPolicyLoader ??
      ((): Promise<PullRequestFollowupPolicy> =>
        Promise.resolve(DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY));
    this.runStore = options.runStore;
    this.schedule = options.schedule;
    this.stateRoot = options.stateRoot;
    this.watchdogConfigLoader =
      options.watchdogConfigLoader ??
      ((): RunDeadlinePolicy => ({ enabled: false, maxRunMinutes: 0 }));
  }

  // Run-scoped: expiry is measured from the Run row's original `created_at`,
  // so a retry inherits the remaining time rather than restarting the cap.
  private createRunSlotDeadline(input: {
    config: RunDeadlinePolicy;
    issueNumber: number;
    projectName: string;
    runId: string;
  }): RunSlotDeadline {
    const capMs = runCapMs(input.config);
    if (capMs === undefined) {
      return NO_RUN_SLOT_DEADLINE;
    }
    // Narrow read: this runs while the dispatch mutex is held, and only the
    // wall-clock origin is needed.
    const createdAtMs = Date.parse(
      this.runStore.getRunCreatedAt(input.runId) ?? ""
    );
    if (Number.isNaN(createdAtMs)) {
      return NO_RUN_SLOT_DEADLINE;
    }
    return runSlotDeadline({
      expiresAtMs: createdAtMs + capMs,
      onExpire: () => {
        // Slot ownership is the enforcement scope. This read and the
        // synchronous SQLite CAS below share one event-loop turn, so an
        // unregister cannot interleave between the proof and mutation.
        if (this.activeRuns.getInFlight(input.runId) === undefined) {
          return;
        }
        const marked = this.runStore.markSlotOwnedRunTimedOut(input.runId);
        if (!marked) {
          return;
        }
        // The sampled Watchdog logs its own verdict; without this the only
        // trace of a deadline win is the row and the health notification.
        this.logger?.warn(
          {
            issueNumber: input.issueNumber,
            maxRunMinutes: input.config.maxRunMinutes,
            project: input.projectName,
            runId: input.runId,
            terminalReason: "run_timeout"
          },
          "symphonika Run slot deadline marked run stale"
        );
        void this.activeRuns
          .requestCancel(input.runId, CANCEL_REASONS.RUN_TIMEOUT)
          .catch((error: unknown) => {
            this.logger?.warn(
              { err: error, runId: input.runId },
              "symphonika Run deadline cancellation failed"
            );
          });
        try {
          this.onWatchdogTerminated?.({
            issueNumber: input.issueNumber,
            projectName: input.projectName,
            runId: input.runId
          });
        } catch (error) {
          this.logger?.warn(
            { err: error, runId: input.runId },
            "symphonika Run deadline termination observer failed"
          );
        }
      }
    });
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
    // Held from the claimGuard/suppression check through the terminal Run
    // write, mirroring claimAndPersistRun's own claim boundary (and
    // recordStateAdvanceTerminalTarget's). Without this, a concurrent run
    // for the same issue can record its blocked/no_workspace_changes verdict
    // between this method's suppression check and its `sym:claimed` +
    // createRun writes, letting a stale "not suppressed" read through and
    // re-open the redispatch loop the verdict was meant to close. See
    // ADR 0052 / ADR 0053, issue #693.
    await this.dispatchMutex.acquire();
    try {
      if (input.claimGuard?.() === false) {
        throw new FreshClaimDeferredError(
          `fresh issue claim deferred for project ${input.project.name}`
        );
      }
      if (
        this.runStore.latestRunSuppressesFreshDispatch({
          issueNumber: input.issue.number,
          projectName: input.project.name,
          repository: input.repository
        })
      ) {
        throw new FreshClaimDeferredError(
          `fresh issue claim suppressed by latest no_workspace_changes outcome for ${input.project.name}#${input.issue.number}`
        );
      }
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
      await this.claimLabels.applyTerminal({
        deferReleaseToScheduler: false,
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
    } finally {
      this.dispatchMutex.release();
    }
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
    let deadline = NO_RUN_SLOT_DEADLINE;
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
        const watchdogConfig = this.watchdogConfigLoader(project.name);
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
            deadline = this.createRunSlotDeadline({
              config: watchdogConfig,
              issueNumber: refreshed.number,
              projectName: project.name,
              runId: payload.runId
            });
            this.activeRuns.reserveSlot({
              cancel: deadline.abortPreparation,
              issueNumber: refreshed.number,
              projectName: project.name,
              ...(payload.respectsIssueLabels === undefined
                ? {}
                : { respectsIssueLabels: payload.respectsIssueLabels }),
              runId: payload.runId
            });
            deadline.arm();
          } catch (error) {
            deadline.clear();
            if (!(error instanceof RegistryShutdownError)) {
              throw error;
            }
            // The run row keeps its pre-retry state; no provider starts.
            shuttingDown = true;
          }
          if (!shuttingDown) {
            try {
              await deadline.race(
                this.bestEffort(
                  () =>
                    this.addLabelsBounded({
                      deadline,
                      issueNumber: refreshed.number,
                      labels: ["sym:claimed"],
                      repository
                    }),
                  {
                    issueNumber: refreshed.number,
                    label: "sym:claimed",
                    operation: "addLabel",
                    project: project.name,
                    runId: payload.runId
                  }
                )
              );
            } catch {
              // A slot cancellation or Run timeout aborts the label request.
              // runAttemptLifecycle observes the latched cancellation and
              // owns unregister + terminal classification outside the mutex.
            }
          }
        }
      }
    } finally {
      this.dispatchMutex.release();
    }

    if (shuttingDown) {
      // The retry timer already fired (this callback is running) but
      // reserveSlot's shutdown gate refused the claim before any row
      // mutation — the row is still "failed" (transient) from when the
      // timer was first accepted, with no cancel_reason. Unlike a refused
      // or cleared *registration* (handled by cancelRunAfterScheduleRefused/
      // Cleared before this callback ever started), nothing else will
      // persist shutdown evidence for it. See issue #663 / PR #674 review.
      await this.cancelRunAfterScheduleCleared({
        issueNumber: refreshed.number,
        repository,
        runId: payload.runId
      });
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
      const scheduled = this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () => this.executeRetry(payload),
        issueNumber: refreshed.number,
        kind: "retry",
        onShutdown: () =>
          this.cancelRunAfterScheduleCleared({
            issueNumber: refreshed.number,
            repository,
            runId: payload.runId
          }),
        projectName: project.name,
        runId: payload.runId
      });
      if (!scheduled) {
        await this.cancelRunAfterScheduleRefused({
          issueNumber: refreshed.number,
          repository,
          runId: payload.runId
        });
      }
      return;
    }

    await this.runAttemptLifecycle({
      attemptNumber: payload.attemptNumber,
      deadline,
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
      // retry that resolves to `true`, and the attempt's metadata handoff
      // flips the reserved slot's `false` back to label-controlled —
      // re-opening the eligibility_loss cancellation storm this change
      // closes. See ADR 0044.
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
    await this.claimLabels.applyTerminal({
      cancelReason: input.reason,
      deferReleaseToScheduler: false,
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

  // A sibling to isIssueOwnedByWorkflow, for a case that predicate cannot
  // see: terminalizing a Run releases FSM ownership (current_state_id goes
  // null, state leaves "waiting") in the same update that asserts operator
  // attention via sym:blocked/sym:human-needed. For an ordinary blocked
  // outcome that release is correct — the global PR follow-up loop should
  // pick up review-followup duties. For a deterministic merge refusal it is
  // not: re-attempting the exact merge this Run just declared refused would
  // contradict the terminalization. Scoped to the exact PR (not just the
  // issue) so a refusal on one of an issue's tracked PRs cannot gate — or
  // fail to gate — a different tracked PR on the same issue.
  isIssueMergeRefused(input: {
    issueNumber: number;
    prNumber: number;
    projectName: string;
  }): boolean {
    return this.runStore.hasMergeRefusalForPullRequest(input);
  }

  // Shared tail of every "terminalize this waiting Run as blocked" path (ADR
  // 0058): record the actionable reason, flip RunState, and label the issue.
  // A caller that also needs recordWorkflowTerminal runs that first, since
  // only it knows the terminal state id and its own transition reason.
  private async terminalizeBlocked(input: {
    issueNumber: number;
    reason: string;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    this.runStore.recordTerminalReason(
      input.runId,
      input.reason,
      "deterministic"
    );
    this.runStore.updateRunState(input.runId, "blocked");
    await this.claimLabels.markBlocked({
      issueNumber: input.issueNumber,
      repository: input.repository
    });
  }

  private async terminateMergePrRefusal(input: {
    issueNumber: number;
    message: string;
    prNumber: number;
    repository: GitHubIssueRepositoryInput;
    runId: string;
    stateId: string;
    transitionReason: string;
  }): Promise<void> {
    this.runStore.recordWorkflowTerminal(input.runId, {
      terminalStateId: input.stateId,
      transitionReason: input.transitionReason
    });
    await this.terminalizeBlocked({
      issueNumber: input.issueNumber,
      reason: buildMergePrRefusedReason(input.prNumber, input.message),
      repository: input.repository,
      runId: input.runId
    });
  }

  // Observes the tracked pull request and projects it into the wait state's
  // signal map, performing the merge attempt for a merge_pr state along the way.
  // undefined means the caller has nothing to decide this tick: observation
  // either stayed retryably parked or terminalized a deterministic refusal here.
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
        const terminateRefusal = (message: string, transitionReason: string) =>
          this.terminateMergePrRefusal({
            issueNumber: input.issueNumber,
            message,
            prNumber: tracked.prNumber,
            repository,
            runId,
            stateId: waitState.id,
            transitionReason
          });
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
            const message = "GitHub tracker does not expose mergePullRequest";
            await terminateRefusal(message, `merge_pr unavailable: ${message}`);
            this.logger?.warn(
              { runId },
              "symphonika merge_pr: tracker has no mergePullRequest support"
            );
            return undefined;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (isPermanentMergeRefusal(error)) {
            const attempt = this.runStore.incrementMergeRefusalCount(runId);
            if (attempt < MAX_MERGE_REFUSAL_ATTEMPTS) {
              this.runStore.recordWaitingActivity(
                runId,
                `merge_pr refused for PR #${tracked.prNumber} (attempt ${attempt}/${MAX_MERGE_REFUSAL_ATTEMPTS}): ${message}`
              );
              this.logger?.warn(
                { attempt, err: error, prNumber: tracked.prNumber, runId },
                "symphonika merge_pr refused, parking for retry"
              );
              return undefined;
            }
            await terminateRefusal(
              `${message} (after ${attempt} refused attempts)`,
              `merge_pr refused for PR #${tracked.prNumber} after ${attempt} attempts: ${message}`
            );
            this.logger?.warn(
              { attempt, err: error, prNumber: tracked.prNumber, runId },
              "symphonika merge_pr permanently refused"
            );
            return undefined;
          }
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
          await this.terminalizeBlocked({
            issueNumber: refreshed.number,
            reason: "workflow_terminal_blocked",
            repository,
            runId
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
          ...(row.branchName.length === 0
            ? {}
            : { branchName: row.branchName }),
          currentStateId: decision.to,
          id: nextWaitingRunId,
          issue: refreshed,
          parentRunId: runId,
          projectName: project.name,
          ...(row.workspacePath.length === 0
            ? {}
            : { workspacePath: row.workspacePath })
        });
        const scheduled = this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () => this.executeWaitPark({ waitingRunId: nextWaitingRunId }),
          issueNumber: refreshed.number,
          kind: "wait_park",
          projectName: project.name,
          runId
        });
        if (!scheduled) {
          this.logWaitReevaluationRefused(nextWaitingRunId);
        }
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

      const scheduled = this.schedule({
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
        onShutdown: () =>
          this.cancelRunAfterScheduleCleared({
            issueNumber: refreshed.number,
            repository,
            runId
          }),
        projectName: project.name,
        runId
      });
      if (!scheduled) {
        await this.cancelRunAfterScheduleRefused({
          issueNumber: refreshed.number,
          repository,
          runId
        });
      }
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
        await this.terminalizeBlocked({
          issueNumber: refreshed.number,
          reason: "workflow_terminal_blocked",
          repository,
          runId
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
    const scheduled = this.schedule({
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
    if (!scheduled) {
      this.releaseShutdownResume(resumePayload.parentRunId);
      this.logger?.debug(
        { runId: resumePayload.parentRunId },
        "symphonika shutdown resume registration refused: daemon shutting down"
      );
    }
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
        // landing before the attempt updates the slot metadata cancels it as
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
        // shutdown drain alive past stop(). claimAndPersistRun's own
        // catch already persists cancellation when it threw AFTER creating
        // the child row (runId) — touching the parent here would clobber
        // that already-correct state. But its fast-path throw (shutdown
        // observed before any row/label mutation) never reaches that catch,
        // so if no child row exists, the parent (payload.parentRunId,
        // already "succeeded" from the advance decision) is left with no
        // shutdown evidence and no walk to resume. See issue #663 / PR #674
        // review.
        if (this.runStore.getRun(runId) === undefined) {
          await this.cancelRunAfterScheduleCleared({
            issueNumber: refreshed.number,
            repository,
            runId: payload.parentRunId
          });
        }
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
        const scheduled = this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () => this.executeStateAdvance(payload),
          issueNumber: refreshed.number,
          kind: "state_advance",
          onShutdown: () =>
            this.cancelRunAfterScheduleCleared({
              issueNumber: refreshed.number,
              repository,
              runId: payload.parentRunId
            }),
          projectName: project.name,
          runId
        });
        if (!scheduled) {
          await this.cancelRunAfterScheduleRefused({
            issueNumber: refreshed.number,
            repository,
            runId: payload.parentRunId
          });
        }
        return;
      }
      throw error;
    }
  }

  // Rolls back a sym:claimed written before the shutdown gate closed.
  // Only the shutdown path awaits: the isShuttingDown() check at each call
  // site and the createContinuationRun below it are synchronous, so stop()
  // cannot close the gate between check and row creation. See ADR 0052.
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
    // and no child row (input.runId) is ever created on this path, so the
    // parent (input.parentRunId) — already "succeeded" from the advance/
    // continuation decision — is the only durable row that can still carry
    // shutdown evidence. Without this, the parent is left with no
    // cancel_reason and the next daemon's resume query ignores it, the same
    // gap the fired-callback fix (window 3) closed for the try/catch below.
    // See issue #663 / PR #674 review.
    if (this.activeRuns.isShuttingDown()) {
      await this.cancelRunAfterScheduleCleared({
        issueNumber: input.issue.number,
        repository: input.repository,
        runId: input.parentRunId
      });
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
      // Unlike the pre-label-write check above, sym:claimed is now applied
      // — but daemon_shutdown cancellation must KEEP it (ADR 0088's resume
      // pass relies on the claim staying present), not release it. Cancel
      // the parent the same way as above rather than rolling the label back.
      await this.cancelRunAfterScheduleCleared({
        issueNumber: input.issue.number,
        repository: input.repository,
        runId: input.parentRunId
      });
      this.logger?.debug(
        { issueNumber: input.issue.number, runId: input.runId },
        `symphonika ${
          input.phase === "state-advance" ? "state advance" : "continuation"
        } skipped: daemon shutting down`
      );
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
    await this.claimLabels.applyTerminal({
      deferReleaseToScheduler: false,
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
      // No child row exists yet — cancel the parent so shutdown evidence is
      // durable. See the matching gate in failScheduledRunBeforeProvider for
      // the full rationale. See issue #663 / PR #674 review.
      await this.cancelRunAfterScheduleCleared({
        issueNumber: input.issue.number,
        repository: input.repository,
        runId: input.parentRunId
      });
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
        // sym:claimed is now applied but must be KEPT for daemon_shutdown
        // (ADR 0088's resume pass relies on it), not rolled back.
        await this.cancelRunAfterScheduleCleared({
          issueNumber: input.issue.number,
          repository: input.repository,
          runId: input.parentRunId
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
      await this.claimLabels.applyTerminal({
        deferReleaseToScheduler: false,
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
      await this.claimLabels.release({
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
        await this.claimLabels.release({
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
        // shutdown drain alive past stop(). Same fast-path-vs-post-create
        // distinction as executeStateAdvance: only cancel the parent when
        // claimAndPersistRun never got far enough to create (and itself
        // cancel) the child row. See issue #663 / PR #674 review.
        if (this.runStore.getRun(runId) === undefined) {
          await this.cancelRunAfterScheduleCleared({
            issueNumber: refreshed.number,
            repository,
            runId: payload.parentRunId
          });
        }
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
        const scheduled = this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () => this.executeContinuation(payload),
          issueNumber: refreshed.number,
          kind: "continuation",
          onShutdown: () =>
            this.cancelRunAfterScheduleCleared({
              issueNumber: refreshed.number,
              repository,
              runId: payload.parentRunId
            }),
          projectName: project.name,
          runId
        });
        if (!scheduled) {
          await this.cancelRunAfterScheduleRefused({
            issueNumber: refreshed.number,
            repository,
            runId: payload.parentRunId
          });
        }
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
        isDispatchProject(project) &&
        this.runStore.latestRunSuppressesFreshDispatch({
          issueNumber: entry.issue.number,
          projectName: project.name,
          repository: project.tracker
        })
      ) {
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
    // advance / PR followup). See ADR 0052 / ADR 0053. A failure after
    // claimAndPersistRun's own createRun call reconciles the orphaned Run row
    // (label writes and scheduleNext included) before rethrowing, so that
    // reconciliation also runs inside this same mutex hold. See ADR 0093.
    let deadline: RunSlotDeadline;
    await this.dispatchMutex.acquire();
    try {
      deadline = await this.claimAndPersistRun({
        ...input,
        onPostCreateClaimFailure: (error) =>
          this.reconcilePostCreateClaimFailure({ ...input, error })
      });
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
      deadline,
      runId: input.runId
    });
  }

  private async reconcilePostCreateClaimFailure(input: {
    attemptNumber: number;
    error: unknown;
    extraInstructions?: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    project: DispatchProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    respectsIssueLabels?: boolean;
    runId: string;
  }): Promise<void> {
    // claimAndPersistRun owns rollback before createRun and shutdown
    // cancellation after it. This caller owns the remaining case: a Run row
    // exists, but claimAndPersistRun failed before handing a live slot to
    // runAttemptLifecycle. Keep the whole repair under dispatchMutex so stale
    // detection cannot observe a queued row between slot cleanup and its
    // terminal state.
    this.activeRuns.unregister(input.runId);

    const terminal = await classifyFailure({
      error: input.error,
      events: [],
      cancelRequested: false,
      redactSecrets: this.redactionInventory(input.repository.token)
    });
    const state = mapOutcomeToRunState(terminal);
    const willRetry = this.isRetryableTransientFailure(terminal, input.runId);
    this.runStore.recordTerminalReason(
      input.runId,
      terminal.reason,
      terminal.classification
    );
    this.runStore.updateRunState(input.runId, state);
    this.markNotificationPendingIfNeeded(input.runId, willRetry);
    await this.claimLabels.applyTerminal({
      deferReleaseToScheduler: false,
      fsmContinuing: false,
      issueNumber: input.issue.number,
      outcome: terminal,
      repository: input.repository,
      willRetry
    });
    try {
      await this.scheduleNext({
        ...(input.extraInstructions === undefined
          ? {}
          : { extraInstructions: input.extraInstructions }),
        issue: input.issue,
        outcome: terminal,
        project: input.project,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        repository: input.repository,
        ...(input.respectsIssueLabels === undefined
          ? {}
          : { respectsIssueLabels: input.respectsIssueLabels }),
        runId: input.runId,
        runtimeAttemptNumber: input.attemptNumber,
        willRetry
      });
    } catch (scheduleError) {
      this.logger?.error(
        { err: scheduleError, runId: input.runId },
        "symphonika scheduleNext failed"
      );
    }
    this.logger?.warn(
      {
        classification: terminal.classification,
        issueNumber: input.issue.number,
        project: input.project.name,
        runId: input.runId,
        state,
        terminalReason: terminal.reason,
        willRetry
      },
      "symphonika reconciled Run after claim persistence failed"
    );
  }

  // Shared retry-eligibility check: a failed+transient outcome still has
  // budget left in the retry cap. Used at every point that decides whether a
  // Run row is reused for a retry or finalized as terminal.
  private isRetryableTransientFailure(
    outcome: ClassifiedTerminal,
    runId: string
  ): boolean {
    return (
      outcome.kind === "failed" &&
      outcome.classification === "transient" &&
      this.runStore.runRetryCount(runId) < this.lifecyclePolicy.retry.cap
    );
  }

  // Shared by reconcilePostCreateClaimFailure and runAttemptLifecycle's
  // terminal handling: once the retry budget is spent, this is the point
  // that makes the attempt visible to the durable notification digest (ADR
  // 0071); a still-retryable run defers, since the same Run row is reused.
  private markNotificationPendingIfNeeded(
    runId: string,
    willRetry: boolean
  ): void {
    if (willRetry) {
      return;
    }
    try {
      this.runStore.markRunNotificationPending(runId);
    } catch (error) {
      this.logger?.warn(
        { err: error, runId },
        "symphonika issue Run notification evidence write failed"
      );
    }
  }

  private async cancelRunAfterScheduleRefused(input: {
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    await this.cancelScheduledLifecycleWork({
      ...input,
      reason: CANCEL_REASONS.DAEMON_SHUTDOWN
    });
    this.markNotificationPendingIfNeeded(input.runId, false);
    this.logger?.debug(
      { issueNumber: input.issueNumber, runId: input.runId },
      "symphonika delayed work refused: daemon shutting down"
    );
  }

  // Companion to cancelRunAfterScheduleRefused for the other half of the same
  // shutdown race: a timer accepted before cancelAll() latched the registry,
  // then cleared before it fired. Passed as onShutdown to every retry/
  // continuation/state_advance schedule() call so the registry can invoke it
  // once the timer is gone — that item never gets its own fire() call, so
  // this is the only remaining chance to record cancellation evidence. Without
  // it the row is left "failed" (transient) with sym:claimed and no
  // cancel_reason, which the restart-resume pass ignores because it requires
  // cancel_reason=daemon_shutdown (see shutdown-resume.ts / SPEC.md). Not
  // wired to wait_park: a waiting row is already durable and is meant to
  // survive shutdown untouched for the next daemon's reconciliation.
  private async cancelRunAfterScheduleCleared(input: {
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    await this.cancelScheduledLifecycleWork({
      ...input,
      reason: CANCEL_REASONS.DAEMON_SHUTDOWN
    });
    this.markNotificationPendingIfNeeded(input.runId, false);
    this.logger?.debug(
      { issueNumber: input.issueNumber, runId: input.runId },
      "symphonika accepted delayed work cleared: daemon shutting down"
    );
  }

  private logWaitReevaluationRefused(runId: string): void {
    this.logger?.debug(
      { runId },
      "symphonika wait re-evaluation registration refused: daemon shutting down"
    );
  }

  private async claimAndPersistRun(input: {
    claimGuard?: () => boolean;
    isContinuation: boolean;
    issue: IssueSnapshot;
    // Invoked (still under dispatchMutex) when this call's own createRun
    // succeeded but a later step in the same claim failed. The caller
    // supplies it because reconciliation needs attemptNumber/extraInstructions
    // and the DispatchProjectConfig-narrowed project, none of which
    // claimAndPersistRun itself reads — see ADR 0093.
    onPostCreateClaimFailure: (error: unknown) => Promise<void>;
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
  }): Promise<RunSlotDeadline> {
    // Shutdown gate, fast path: throwing before any side effect needs no
    // rollback. The gate can still land during the addLabelsToIssue await
    // below; the catch then cleans up the partial claim. See ADR 0052.
    if (this.activeRuns.isShuttingDown()) {
      throw new RegistryShutdownError(
        `daemon is shutting down; refusing to claim issue ${input.project.name}#${input.issue.number}`
      );
    }
    // pickProjectCandidate and failFreshDispatchBeforeProvider apply the same
    // check so a suppressed Issue does not starve later candidates and a
    // misconfigured-provider short circuit still honors the guard. Repeat it
    // here inside the serialized claim boundary so no durable verdict can
    // land between selection and the `sym:claimed` write. Continuations and
    // FSM-owned work are intentionally outside this fresh-dispatch-only rule.
    if (
      !input.isContinuation &&
      this.runStore.latestRunSuppressesFreshDispatch({
        issueNumber: input.issue.number,
        projectName: input.project.name,
        repository: input.repository
      })
    ) {
      throw new FreshClaimDeferredError(
        `fresh issue claim suppressed by latest no_workspace_changes outcome for ${input.project.name}#${input.issue.number}`
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
    const watchdogConfig = this.watchdogConfigLoader(input.project.name);
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
    let deadline = NO_RUN_SLOT_DEADLINE;
    let runCreated = false;
    // This write predates the Run row, so it cannot use the Run-scoped
    // deadline armed further down, and it runs while dispatchMutex is held --
    // a hung request would stall every other dispatch, not merely this slot.
    // Same mechanism and same policy, but measured from now because the Run's
    // origin is only recorded moments later. See ADR 0093.
    const claimCapMs = runCapMs(watchdogConfig);
    const claimDeadline =
      claimCapMs === undefined
        ? NO_RUN_SLOT_DEADLINE
        : runSlotDeadline({
            expiresAtMs: Date.now() + claimCapMs,
            onExpire: () => undefined
          });
    claimDeadline.arm();
    try {
      await claimDeadline.race(
        this.addLabelsBounded({
          deadline: claimDeadline,
          issueNumber: input.issue.number,
          labels: ["sym:claimed"],
          repository: input.repository
        })
      );
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
      deadline = this.createRunSlotDeadline({
        config: watchdogConfig,
        issueNumber: input.issue.number,
        projectName: input.project.name,
        runId: input.runId
      });
      // Reserve the in-flight slot BEFORE mutex release so subsequent picks
      // (per-issue reservation + Slice-2 cap counts) observe the run. The
      // provider cancel handler is bound later in runAttemptLifecycle via
      // attachProvider once every pre-provider await has settled. See ADR
      // 0052 / ADR 0093.
      this.activeRuns.reserveSlot({
        cancel: deadline.abortPreparation,
        issueNumber: input.issue.number,
        projectName: input.project.name,
        ...(input.respectsIssueLabels === undefined
          ? {}
          : { respectsIssueLabels: input.respectsIssueLabels }),
        runId: input.runId
      });
      deadline.arm();
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
      deadline.clear();
      // Once the claim request was issued its outcome is indeterminate: the
      // bounded race above can reject while GitHub has already applied the
      // label. Any rollback below runs while dispatchMutex is held, so it
      // gets its own bound under the same policy -- an unbounded rollback
      // would stall every later dispatch just like the write it undoes.
      const rollbackDeadline =
        claimCapMs === undefined
          ? NO_RUN_SLOT_DEADLINE
          : runSlotDeadline({
              expiresAtMs: Date.now() + claimCapMs,
              onExpire: () => undefined
            });
      rollbackDeadline.arm();
      try {
        if (error instanceof RegistryShutdownError && runCreated) {
          // The shutdown snapshot in stop() predates this row, so record the
          // shutdown reason here and release the claim label best-effort.
          this.runStore.markCancelRequested(
            input.runId,
            CANCEL_REASONS.DAEMON_SHUTDOWN
          );
          this.runStore.updateRunState(input.runId, "cancelled");
          await this.bestEffort(
            () =>
              rollbackDeadline.race(
                this.removeLabelsBounded({
                  deadline: rollbackDeadline,
                  issueNumber: input.issue.number,
                  labels: ["sym:claimed"],
                  repository: input.repository
                })
              ),
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
          await this.claimLabels.markFailed({
            issueNumber: input.issue.number,
            repository: input.repository
          });
        } else if (!runCreated) {
          // The claim write timed out or failed without confirming, so the
          // Issue may carry `sym:claimed` with no Run row behind it. Left
          // alone, the stale-claim sweep would add `sym:stale`, which v1
          // never auto-clears, excluding the Issue until an operator
          // intervenes. Removing a label that was never applied is a no-op,
          // so roll the claim back either way. Scoped to !runCreated: once
          // the Run row exists, the label is the caller's only durable
          // record of ownership, and other branches above already own its
          // fate.
          await this.bestEffort(
            () =>
              rollbackDeadline.race(
                this.removeLabelsBounded({
                  deadline: rollbackDeadline,
                  issueNumber: input.issue.number,
                  labels: ["sym:claimed"],
                  repository: input.repository
                })
              ),
            {
              issueNumber: input.issue.number,
              label: "sym:claimed",
              operation: "removeLabel",
              project: input.project.name,
              runId: input.runId
            }
          );
        }
      } finally {
        rollbackDeadline.clear();
      }
      if (runCreated && !(error instanceof RegistryShutdownError)) {
        // Guarded so a throw from reconciliation itself (e.g. a busy/corrupt
        // sqlite write right after a successful claim) can never replace the
        // original error below — losing it would defeat the caller's
        // `instanceof CapBreachedError | FileOverlapDetectedError | ...`
        // classification and leave this exact Run row un-reconciled, silently.
        try {
          await input.onPostCreateClaimFailure(error);
        } catch (reconcileError) {
          this.logger?.error(
            { err: reconcileError, runId: input.runId },
            "symphonika post-create claim reconciliation failed"
          );
        }
      }
      throw error;
    } finally {
      // The claim write has settled either way by here; release its timer
      // rather than leaving it armed for the whole cap.
      claimDeadline.clear();
    }
    return deadline;
  }

  // The signal must reach both the HTTP request and the await around it: a
  // provider that ignores `request.signal` would otherwise keep the slot.
  private async addLabelsBounded(input: {
    deadline: RunSlotDeadline;
    issueNumber: number;
    labels: string[];
    repository: GitHubIssueRepositoryInput;
  }): Promise<void> {
    await (
      this.githubIssuesApi as LabelWritingGitHubIssuesApi
    ).addLabelsToIssue({
      ...input.repository,
      issueNumber: input.issueNumber,
      labels: input.labels,
      ...input.deadline.signalOption
    });
  }

  private async removeLabelsBounded(input: {
    deadline: RunSlotDeadline;
    issueNumber: number;
    labels: string[];
    repository: GitHubIssueRepositoryInput;
  }): Promise<void> {
    await (
      this.githubIssuesApi as LabelWritingGitHubIssuesApi
    ).removeLabelsFromIssue({
      ...input.repository,
      issueNumber: input.issueNumber,
      labels: input.labels,
      ...input.deadline.signalOption
    });
  }

  private async runAttemptLifecycle(input: {
    attemptNumber: number;
    deadline: RunSlotDeadline;
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
      events: [],
      redactSecrets: this.redactionInventory(input.repository.token)
    };
    let attemptCreated = false;
    let started: StartedAttempt | undefined;
    // Workspace preparation is the only setup operation the deadline can
    // actually stop. Its abort-cleanup channel, rather than its full result,
    // is therefore the only operation the finally may wait on after expiry.
    // See ADR 0093 / issue #640.
    let workspaceOperation: IssueWorkspacePreparation | undefined;
    let workspaceAbortCleanup: Promise<void> | undefined;
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
    const cancelBeforeAttach = this.cancelledBeforeProviderStart(input.runId);

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
      loadedWorkflow = await input.deadline.race(
        this.loadWorkflow(input.project.workflow)
      );
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
        const scheduled = this.schedule({
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
        parkedAsWaiting = scheduled;
        if (!scheduled) {
          this.logWaitReevaluationRefused(input.runId);
        }
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
      // (issue #258). The unregister-in-finally ordering keeps the in-flight
      // entry through provider teardown, so gating on "provider exited"
      // cannot close the window; label-immunity is the fix. Computed
      // here so both the in-flight metadata update and scheduleNext (in
      // finally) carry the same guarantee, including into retry scheduling.
      // Markdown compatibility-graph workflows keep their label-driven
      // behavior unless the caller explicitly owns continuation eligibility
      // (PR Follow-up).
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
          promptTemplate = await input.deadline.race(
            readFile(promptPath, "utf8")
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `workflow state ${currentState.id} prompt not found at ${promptPath}: ${message}`,
            { cause: error }
          );
        }
      }

      // Reuse the branch/workspace this Run's chain already decided on at an
      // earlier attempt, instead of re-deriving it from input.issue.title --
      // which may be a live, just-refreshed title that no longer matches the
      // title in effect when the chain's branch was first created. See issue
      // #699.
      const existingRun = this.runStore.getRun(input.runId);
      const existingWorkspace =
        existingRun !== undefined &&
        existingRun.branchName.length > 0 &&
        existingRun.workspacePath.length > 0
          ? {
              branchName: existingRun.branchName,
              workspacePath: existingRun.workspacePath
            }
          : undefined;

      workspaceOperation = this.prepareIssueWorkspace({
        configDir: this.configDir,
        ...(existingWorkspace === undefined
          ? {}
          : { existing: existingWorkspace }),
        issue: {
          number: input.issue.number,
          title: input.issue.title
        },
        project: projectForAttempt,
        ...input.deadline.signalOption
      });
      // Detached: the deadline race below may already have moved on by the
      // time this settles, so this must not become something the finally
      // block awaits (that would reintroduce #640 / violate ADR 0093). It
      // only observes a rejection reason that would otherwise go unlogged.
      void workspaceOperation.catch((error: unknown) => {
        if (error instanceof WorkspacePreparationCleanupError) {
          this.logger?.warn(
            { err: error, issue: input.issue.number, runId: input.runId },
            "issue workspace cleanup did not complete after Run Slot Deadline abort"
          );
        }
      });
      workspaceAbortCleanup =
        workspaceOperation.abortCleanup ??
        workspaceOperation.then(
          () => undefined,
          () => undefined
        );
      const prepared = await input.deadline.race(workspaceOperation);
      started = await input.deadline.race(
        this.startAttempt({
          attemptId,
          attemptNumber: input.attemptNumber,
          ...(input.extraInstructions === undefined
            ? {}
            : { extraInstructions: input.extraInstructions }),
          isContinuation: input.isContinuation,
          issue: input.issue,
          prepared,
          project: projectForAttempt,
          providerCommand: input.providerCommand,
          providerName: input.providerName,
          ...(promptTemplate === undefined ? {} : { promptTemplate }),
          runId: input.runId
        })
      );
      await input.deadline.race(input.provider.validate(input.providerCommand));
      await input.deadline.race(
        this.addLabelsBounded({
          deadline: input.deadline,
          issueNumber: input.issue.number,
          labels: ["sym:running"],
          repository: input.repository
        })
      );
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
      // Preserve the raw-FSM label-immunity handoff at its existing point,
      // independently of the provider cancellation handoff. A raw-FSM agent
      // may remove agent-ready as part of its work (issue #258), while the
      // preparation handler must remain installed through every await before
      // provider execution begins.
      this.activeRuns.updateRespectsIssueLabels(
        input.runId,
        respectsIssueLabels
      );
      try {
        headShaAtAttemptStart = await input.deadline.race(
          inspectWorkspaceHead({
            workspacePath: started.evidence.workspacePath,
            ...input.deadline.signalOption
          })
        );
      } catch (error) {
        // A deadline or preparation cancellation must unwind the slot. Only a
        // settled Git inspection failure is deferred until clean provider
        // exit for workspace_inspection_failed classification.
        if (input.deadline.signal?.aborted === true) {
          throw error;
        }
        // Defer this deterministic inspection failure until a clean provider
        // exit. Cancellation, input-required, and provider failures must retain
        // their own higher-priority classification.
        headInspectionFailed = true;
      }

      await this.iterateAttempt({
        attemptId,
        attemptNumber: input.attemptNumber,
        deadline: input.deadline,
        evidence: started.evidence,
        issue: input.issue,
        prompt: started.prompt,
        promptPath: started.promptPath,
        provider: input.provider,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
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
      // sym:running label / createAttempt / HEAD inspection / scratch
      // creation). See ADR 0052 / ADR 0093.
      // The deadline race can reject before AbortSignal-driven Git teardown
      // and owned-path cleanup settle. Keep the slot until the preparation's
      // separate abort-cleanup channel settles, but do not await its full
      // result: stat/mkdir/realpath/rename cannot observe the signal and may
      // remain stalled indefinitely. The rest of startAttempt (loadWorkflow,
      // evidence persistence, log-file creation) is abandoned for the same
      // reason. See ADR 0093 / issue #640.
      if (input.deadline.signal?.aborted === true) {
        await workspaceAbortCleanup?.catch(() => undefined);
      }
      input.deadline.clear();
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
          this.runStore.reassertRunWatchdogStale(
            input.runId,
            watchdogTerminalReason
          );
        if (reasserted) {
          if (attemptCreated) {
            this.runStore.updateAttemptState(attemptId, "stale");
          }
          await this.claimLabels.applyTerminal({
            cancelReason: watchdogTerminalReason,
            deferReleaseToScheduler: false,
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
          redactSecrets: runtime.redactSecrets,
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
        const deferRetryableTransientAdvance = this.isRetryableTransientFailure(
          terminal,
          input.runId
        );
        // loadedWorkflow can be undefined if this.loadWorkflow itself threw
        // before currentState was set; in that case we run the bare
        // classifyFailure outcome without an FSM-driven overlay.
        if (currentState !== undefined && loadedWorkflow !== undefined) {
          workflowOutcome = await this.applyWorkflowOutcome({
            actionExecuted: attemptCreated,
            branchName: started?.evidence.branchName,
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

          const willRetry = this.isRetryableTransientFailure(
            effectiveOutcome,
            input.runId
          );
          // updateRunState deliberately defers transient failures because the
          // same Run row is reused by retries. Once the budget is exhausted,
          // this is the point that makes the genuinely-terminal attempt
          // visible to the durable notification digest (ADR 0071).
          this.markNotificationPendingIfNeeded(input.runId, willRetry);

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
          // whole is not failing. The claim-label writer's `applyTerminal` uses
          // this to suppress `sym:failed`, which subsequent successful states
          // would otherwise leave
          // on the issue forever.
          const fsmContinuing =
            isRawFsm &&
            (workflowOutcome.advancedToState !== null ||
              workflowOutcome.parkAsWait === true);
          // Only a non-raw-FSM `success` is ambiguous at this point: for those
          // workflows `fsmContinuing` above is unconditionally false, but
          // scheduleNext's success-path section (after this call returns)
          // still decides whether to schedule a real continuation dispatch.
          // `input_required` and a permanent `failed` are never ambiguous --
          // scheduleNext returns immediately for both -- and a genuine
          // raw-FSM terminal success independently makes scheduleNext a
          // no-op via `suppressContinuation`, so neither needs deferral.
          const deferReleaseToScheduler =
            !isRawFsm && effectiveOutcome.kind === "success";
          const labelInput: ApplyLabelsInput = {
            deferReleaseToScheduler,
            fsmContinuing,
            issueNumber: input.issue.number,
            outcome: effectiveOutcome,
            repository: input.repository,
            willRetry
          };
          if (cancelReason !== undefined) {
            labelInput.cancelReason = cancelReason;
          }
          await this.claimLabels.applyTerminal(labelInput);

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
    prepared: PreparedIssueWorkspace;
    promptTemplate?: string;
    providerCommand: string;
    providerName: AgentProviderName;
    runId: string;
  }): Promise<StartedAttempt> {
    const { prepared } = input;
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
      prompt: renderedPrompt.prompt,
      promptPath: evidence.promptPath
    };
  }

  private async applyWorkflowOutcome(input: {
    actionExecuted: boolean;
    branchName: string | undefined;
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
          ...(input.branchName === undefined
            ? {}
            : { branchName: input.branchName }),
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

  // Shared by runAttemptLifecycle (pre-loadWorkflow) and iterateAttempt
  // (pre-attachProvider): a cancel that lands during any pre-provider await
  // latches cancelRequested on the slot, and both callers must observe it
  // before doing more preparation work or attaching the real provider.
  private cancelledBeforeProviderStart(runId: string): Error | undefined {
    return this.activeRuns.getInFlight(runId)?.cancelRequested === true
      ? new Error(`run ${runId} was cancelled before provider start`)
      : undefined;
  }

  private async iterateAttempt(input: {
    attemptId: string;
    attemptNumber: number;
    deadline: RunSlotDeadline;
    evidence: AttemptEvidence;
    issue: IssueSnapshot;
    prompt: string;
    promptPath: string;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
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
    const scratchOperation = createProviderScratch(
      this.stateRoot,
      scratchIdentity
    );
    let scratchPath: string | undefined;
    let sequence = 0;
    try {
      scratchPath = await input.deadline.race(scratchOperation);
      const { maxInFlight: globalMaxInFlight } = await input.deadline.race(
        this.providerBuildCapacityLoader()
      );

      // This is the last pre-provider await. A cancellation during HEAD
      // inspection, scratch creation, or capacity loading fired the
      // preparation handler and is latched on the slot; observe it before
      // replacing that handler so a provider process is never launched
      // after cancellation.
      const cancelBeforeProviderStart = this.cancelledBeforeProviderStart(
        input.runId
      );
      if (cancelBeforeProviderStart !== undefined) {
        throw cancelBeforeProviderStart;
      }
      this.activeRuns.attachProvider(input.runId, {
        cancel: () => input.provider.cancel(input.runId),
        provider: input.provider
      });

      for await (const event of input.provider.runAttempt({
        branchName: input.evidence.branchName,
        ...(globalMaxInFlight === undefined ? {} : { globalMaxInFlight }),
        issue: input.issue,
        prompt: input.prompt,
        promptPath: input.promptPath,
        provider: {
          command: input.providerCommand,
          name: input.providerName
        },
        recordProviderScopeCleanupPending: (pending) => {
          this.runStore.setAttemptProviderScopeCleanupPending(
            input.attemptId,
            pending
          );
        },
        run: scratchIdentity,
        scratchPath,
        stderrLogPath: providerStderrLogPath(input.evidence.rawLogPath),
        // Providers run full-permission and inherit this process's env
        // (provider-process.ts spawns with `{ ...process.env }`), so an agent
        // that echoes its GitHub token would otherwise persist it verbatim
        // into an artifact the dashboard serves. Use the same complete
        // inventory as the JSONL and terminal-reason boundaries, snapshotted
        // once for the whole attempt (runtime.redactSecrets). SPEC.md §6.
        stderrRedactSecrets: input.runtime.redactSecrets,
        workspacePath: input.evidence.workspacePath
      })) {
        sequence += 1;
        const normalized = await this.persistProviderEvent({
          attemptId: input.attemptId,
          event,
          normalizedLogPath: input.evidence.normalizedLogPath,
          rawLogPath: input.evidence.rawLogPath,
          redactSecrets: input.runtime.redactSecrets,
          runId: input.runId,
          sequence
        });
        if (normalized !== undefined) {
          input.runtime.events.push(normalized);
        }
      }
    } finally {
      // Best effort: failing to delete temporary files must never mask the
      // attempt's own outcome. The startup sweep reclaims what is left.
      if (
        scratchPath !== undefined &&
        input.deadline.signal?.aborted !== true
      ) {
        await this.bestEffort(
          () => removeProviderScratch(this.stateRoot, scratchIdentity),
          {
            issueNumber: input.issue.number,
            operation: "removeProviderScratch",
            runId: input.runId
          }
        );
      } else {
        // Either the deadline race deliberately abandoned a stalled mkdir, or
        // scratch creation succeeded but the deadline (or a pre-attach
        // cancel, which shares the same signal) fired during a later
        // pre-provider await. removeProviderScratch's rm() is not
        // signal-aware and could stall on an unresponsive filesystem, so
        // slot release cannot wait on it either way. Handed off to a method
        // taking only the primitives it needs, rather than a closure over
        // this scope, so the orphaned promise chain cannot keep the whole
        // attempt (prompt, evidence, provider) reachable for as long as
        // removal is pending.
        this.reclaimAbandonedScratch(
          scratchOperation,
          scratchIdentity,
          input.issue.number,
          input.runId
        );
      }
    }
  }

  private reclaimAbandonedScratch(
    scratchOperation: Promise<string>,
    scratchIdentity: ProviderScratchIdentity,
    issueNumber: number,
    runId: string
  ): void {
    void scratchOperation
      .then(() =>
        this.bestEffort(
          () => removeProviderScratch(this.stateRoot, scratchIdentity),
          { issueNumber, operation: "removeProviderScratch", runId }
        )
      )
      .catch(() => undefined);
  }

  private async persistProviderEvent(input: {
    attemptId: string;
    event: ProviderEvent;
    normalizedLogPath: string;
    rawLogPath: string;
    redactSecrets: readonly string[];
    runId: string;
    sequence: number;
  }): Promise<NormalizedProviderEvent | undefined> {
    // Prefer the provider's own queue-ingestion stamp (set by adapters whose
    // transport queue observes receipt independent of consumer speed, e.g.
    // jsonl-process-queue.ts) over this method's own clock: awaiting a slow
    // state-root write for the *previous* event before this one is even
    // dequeued would otherwise charge that latency to this event's receipt
    // time. The fallback covers orchestrator-synthesized events and adapters
    // with no queue to timestamp. See ADR 0090.
    const receivedAt = input.event.receivedAt ?? new Date().toISOString();
    const raw = redactValueDeep(input.event.raw, input.redactSecrets);
    // Redact only the copies that get persisted (JSONL + SQLite). The
    // returned value feeds runtime.events for classifyFailure's lifecycle
    // interpretation, which matches on protocol discriminators like
    // `type: "process_exit"`; deep-redacting that object in place could
    // rewrite a discriminator into something unmatchable if a configured
    // secret happens to be a substring of it (e.g. an SMTP password of
    // "process"). classifyFailure already redacts its derived terminal
    // reason before that reason is persisted, so nothing unredacted reaches
    // evidence through this path.
    const redactedNormalized =
      input.event.normalized === undefined
        ? undefined
        : redactValueDeep(input.event.normalized, input.redactSecrets);
    // The Run Store write happens before the JSONL appends below, not after:
    // recordProviderEvent/recordProviderStreamReceipt are synchronous SQLite
    // writes that embed the full raw/normalized payload in the row (they do
    // not depend on the JSONL file), and the live status APIs derive their
    // watermark from this row. Awaiting the (slower, purely supplementary)
    // JSONL appends first would delay that watermark by the same write
    // latency this whole method exists to keep out of receivedAt -- the
    // Watchdog already tails the normalized log independently by its own
    // byte offset, so nothing depends on the JSONL line preceding this row.
    // A failed append can therefore now leave a Run Store row with no
    // corresponding JSONL line, which the previous ordering could not: this
    // append is still awaited and its rejection still propagates out of
    // iterateAttempt exactly as before, but the row is no longer rolled back
    // with it. See ADR 0090.
    if (redactedNormalized === undefined) {
      this.runStore.recordProviderStreamReceipt({
        attemptId: input.attemptId,
        receivedAt,
        runId: input.runId,
        sequence: input.sequence
      });
    } else {
      this.runStore.recordProviderEvent({
        attemptId: input.attemptId,
        normalized: redactedNormalized,
        raw,
        receivedAt,
        runId: input.runId,
        sequence: input.sequence
      });
    }
    await Promise.all([
      appendJsonl(input.rawLogPath, raw),
      ...(redactedNormalized === undefined
        ? []
        : [appendJsonl(input.normalizedLogPath, redactedNormalized)])
    ]);
    return input.event.normalized;
  }

  // The Project credential inventory for one execution: the effective tracker
  // token plus the resolved SMTP password when an email sink is configured
  // (SPEC.md §6). Resolved once per attempt (see RunRuntime.redactSecrets) so
  // every evidence boundary scrubs the same execution-time credentials even
  // if a Service Config reload changes the inventory mid-attempt.
  private redactionInventory(repositoryToken: string): string[] {
    // Not deduped here: every consumer funnels through secretSpans, which
    // already collapses duplicates.
    return [
      repositoryToken,
      ...secretsForEmailConfig(this.emailConfigLoader(), this.env)
    ];
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
    // Same boolean computed at the call site for the claim-label writer's applyTerminal. Used
    // by the stateAdvance bail-out path to decide between restoring
    // `sym:failed` (failed && !willRetry — the claim-label writer's applyTerminal suppressed it
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
        const scheduled = this.schedule({
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
          onShutdown: () =>
            this.cancelRunAfterScheduleCleared({
              issueNumber: input.issue.number,
              repository: input.repository,
              runId: input.runId
            }),
          projectName: input.project.name,
          runId: input.runId
        });
        if (!scheduled) {
          await this.cancelRunAfterScheduleRefused({
            issueNumber: input.issue.number,
            repository: input.repository,
            runId: input.runId
          });
        }
        return;
      }
      // Bail-out: `refreshIssue` returned `undefined` (transient API error)
      // or the issue is closed/missing (null or non-open). The claim-label
      // writer's `applyTerminal`
      // was called before `scheduleNext` with `fsmContinuing=true` (any
      // stateAdvance != null implies it). What it did depends on the outcome:
      //
      // - `failed && !willRetry`: the claim-label writer's applyTerminal suppressed `sym:failed`
      //   (or `sym:blocked`, see isBlockedOutcome) on the assumption that the
      //   FSM would continue. The suppression promise is now broken; restore
      //   whichever label matches the outcome so the issue is not orphaned
      //   with only `sym:claimed`. Then return — there is no retry to fire and
      //   no continuation to schedule.
      // - `failed && willRetry`: the claim-label writer's applyTerminal did not add either label
      //   (it short-circuited on `willRetry`). The transient-retry branch
      //   below is the right path; fall through so it fires.
      // - `success`: the claim-label writer's applyTerminal did not add either label, and no
      //   retry applies. Fall through; `suppressContinuation` (always true
      //   when `stateAdvance != null`) ends the call.
      if (input.outcome.kind === "failed" && !input.willRetry) {
        if (isBlockedOutcome(input.outcome)) {
          await this.claimLabels.markBlocked({
            issueNumber: input.issue.number,
            repository: input.repository
          });
        } else {
          await this.claimLabels.markFailed({
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
      const scheduled = this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () => this.executeWaitPark({ waitingRunId }),
        issueNumber: input.issue.number,
        kind: "wait_park",
        projectName: input.project.name,
        runId: input.runId
      });
      if (!scheduled) {
        this.logWaitReevaluationRefused(waitingRunId);
      }
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
      const next = currentRetries + 1;
      const delayMs = computeRetryDelayMs(next, this.lifecyclePolicy);
      const scheduled = this.schedule({
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
        onShutdown: () =>
          this.cancelRunAfterScheduleCleared({
            issueNumber: input.issue.number,
            repository: input.repository,
            runId: input.runId
          }),
        projectName: input.project.name,
        runId: input.runId
      });
      if (!scheduled) {
        await this.cancelRunAfterScheduleRefused({
          issueNumber: input.issue.number,
          repository: input.repository,
          runId: input.runId
        });
        return;
      }
      this.runStore.incrementRetryCount(input.runId);
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
      await this.claimLabels.release({
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
        await this.claimLabels.release({
          issueNumber: input.issue.number,
          phase: "continuation-scheduling-eligibility-loss",
          repository: input.repository
        });
      }
      return;
    }

    if (this.lifecyclePolicy.continuation.cap <= 0) {
      // Continuations disabled: no continuation will ever be scheduled for
      // this success, so this is the point a deferred non-raw-FSM success
      // (see deferReleaseToScheduler) learns no more work is coming. Without
      // this release, a plain single-shot success on a cap-disabled project
      // would never give back its claim (#709). Guarded the same way as the
      // eligibility-loss branch above: label-immune (PR Follow-up) work may
      // still share this Issue Reservation with a live parked/waiting Run,
      // so releasing here would strip the claim out from under it.
      if (input.respectsIssueLabels !== false) {
        await this.claimLabels.release({
          issueNumber: input.issue.number,
          phase: "continuation-scheduling-disabled",
          repository: input.repository
        });
      }
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
      await this.claimLabels.markFailed({
        issueNumber: input.issue.number,
        repository: input.repository
      });
      // The continuation loop stops here -- no further continuation will be
      // scheduled -- so this is the point a deferred non-raw-FSM success
      // (see deferReleaseToScheduler) finally learns no more work is coming.
      // sym:failed (just added) keeps the issue dispatch-ineligible even
      // after sym:claimed/sym:stale are released.
      await this.claimLabels.release({
        issueNumber: input.issue.number,
        phase: "continuation-scheduling-cap-reached",
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

    const scheduled = this.schedule({
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
      onShutdown: () =>
        this.cancelRunAfterScheduleCleared({
          issueNumber: input.issue.number,
          repository: input.repository,
          runId: input.runId
        }),
      projectName: input.project.name,
      runId: input.runId
    });
    if (!scheduled) {
      await this.cancelRunAfterScheduleRefused({
        issueNumber: input.issue.number,
        repository: input.repository,
        runId: input.runId
      });
    }
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

// GitHub documents 405 as "merge cannot be performed" — but gives no
// machine-readable signal for whether that's durable (branch protection
// forbids the configured merge method) or will clear on its own (required
// checks still running under `pull_requests.merge.require_status_success:
// false`, or a branch-protection dimension Symphonika's policy doesn't model
// at all, e.g. required-up-to-date). A mismatched head (409),
// validation/rate response (422), server error, or transport failure is
// already retried without counting toward this bound.
function isPermanentMergeRefusal(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 405
  );
}

// Five ticks at the default 30s poll interval (issue-polling.ts's
// DEFAULT_POLLING_INTERVAL_MS) is a couple of minutes — enough room for
// pending required checks to finish without parking indefinitely the way a
// bare "retry forever" would. Counted in RunStore.merge_refusal_count, a
// dedicated column rather than a state_transition_reason-encoded token: that
// field is overwritten by every other kind of merge_pr observation, so a
// count parked there would reset to zero the moment a permanently refused
// merge alternates with any intervening non-405 tick.
const MAX_MERGE_REFUSAL_ATTEMPTS = 5;

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
