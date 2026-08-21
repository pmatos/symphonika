import { createReadStream, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import type {
  IssueSnapshot,
  RawGitHubIssueDependencyRef
} from "./issue-polling.js";
import { isPathInside } from "./path-safety.js";
import type { AgentProviderName, NormalizedProviderEvent } from "./provider.js";
import type {
  RoutineOutcome,
  RoutineOutcomeAction,
  RoutineOutcomeSource,
  RoutineOutcomeStatus
} from "./routines/outcome.js";
import { nextRecurringFireAt } from "./routines/schedule.js";
import type {
  RoutineCatchUpPolicy,
  RoutineDisabledReason,
  RoutineFiringState,
  RoutineFiringTriggerSource,
  RoutineKind,
  RoutineNotificationState,
  RoutinePullRequestStatus,
  RoutineSkipReason,
  RoutineState,
  RoutineStatus,
  TargetedRoutineDeclaration
} from "./routines/types.js";
import type { ExpandedWorkflow } from "./workflow/types.js";

export type RunState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "input_required"
  | "failed"
  | "blocked"
  | "succeeded"
  | "cancelled"
  | "stale"
  | "waiting";

export type FailureClassification =
  "transient" | "deterministic" | "input_required";

export type RunNotificationState =
  "skipped" | "pending" | "sending" | "sent" | "failed";

export type CancelReason =
  | "closed_issue"
  | "daemon_shutdown"
  | "eligibility_loss"
  | "no_progress"
  | "operator";

// Once stop() records daemon_shutdown, later cancellation writers (an
// in-flight reconcile or a UI cancel during the shutdown drain) must not
// overwrite it — the shutdown contract requires the reason to stick for
// every row that was live when shutdown began. See SPEC 12.3.
const SHUTDOWN_PREEMPTIVE_REASON: CancelReason = "daemon_shutdown";

// Shared by listRuns/listRoutineFirings so both accept either a single state
// or a state set (e.g. the dashboard's active-now band, which spans several
// non-terminal states) without each call site hand-rolling an IN clause. An
// empty array is a deliberate "match nothing" rather than "no filter" — the
// dashboard should render an empty band, not every row, if ever called with
// an empty state set — and it must be special-cased regardless, since
// `state in ()` is invalid SQL.
function pushStateCondition<State extends string>(
  conditions: string[],
  params: Record<string, unknown>,
  state: State | State[] | undefined
): void {
  if (state === undefined) {
    return;
  }
  if (!Array.isArray(state)) {
    conditions.push("state = @state");
    params.state = state;
    return;
  }
  if (state.length === 0) {
    conditions.push("0 = 1");
    return;
  }
  const placeholders = state.map((_, index) => `@state${index}`);
  conditions.push(`state in (${placeholders.join(", ")})`);
  state.forEach((value, index) => {
    params[`state${index}`] = value;
  });
}

export type RunStatus = {
  branchName: string;
  cancelReason: CancelReason | null;
  cancelRequested: boolean;
  continuationParentRunId: string | null;
  createdAt: string;
  currentStateId: string | null;
  failureClassification: FailureClassification | null;
  id: string;
  isContinuation: boolean;
  issueNumber: number;
  issueTitle: string;
  project: string;
  provider: string;
  retryCount: number;
  state: RunState;
  stateTransitionReason: string | null;
  terminalReason: string | null;
  terminalStateId: string | null;
  updatedAt: string;
  workspacePath: string;
};

export type ProjectLastRunStatus = RunStatus & {
  lastTransitionAt: string;
};

export type AttemptStatus = {
  artifacts: RunArtifactDescriptor[];
  attemptNumber: number;
  branchName: string;
  createdAt: string;
  id: string;
  providerCommand: string;
  providerName: string;
  runId: string;
  state: RunState;
  updatedAt: string;
  workspacePath: string;
};

export type RunStateTransition = {
  createdAt: string;
  sequence: number;
  state: RunState;
};

export type RunDetail = RunStatus & {
  attempts: AttemptStatus[];
  transitions: RunStateTransition[];
};

export type RunArtifactKind =
  | "issue_snapshot"
  | "prompt"
  | "prompt_metadata"
  | "workflow_graph"
  | "provider_raw"
  | "provider_normalized";

export type RunArtifactDescriptor = {
  kind: RunArtifactKind;
  present: boolean;
  sizeBytes: number | undefined;
};

export type PromptMetadata = Record<string, unknown>;

export type PullRequestTrackingState = "closed" | "merged" | "open";

type ProjectValidationState = "inactive" | "invalid" | "valid";

export type ProjectState = {
  active: boolean;
  createdAt: string;
  lastCandidateIssues: number;
  lastDispatchedAt: string | null;
  lastDispatchedIssueNumber: number | null;
  lastFetchedIssues: number;
  lastFilteredIssues: number;
  lastPollError: string | null;
  lastPollFinishedAt: string | null;
  lastPollOk: boolean | null;
  lastPollStartedAt: string | null;
  lastSuccessfulPollAt: string | null;
  projectName: string;
  schedulerCurrentWeight: number;
  updatedAt: string;
  validationMessage: string | null;
  validationState: ProjectValidationState;
  weight: number;
};

export type RoutineFiringStatus = {
  branchName: string;
  branchRef: string;
  cancelReason: CancelReason | null;
  cancelRequested: boolean;
  commitsAhead: boolean;
  createdAt: string;
  fanoutId: string | null;
  id: string;
  kind: RoutineKind | null;
  notificationError?: string | null;
  notificationState?: RoutineNotificationState;
  outcome: RoutineOutcome | null;
  projectName: string;
  provider: AgentProviderName;
  providerCommand: string;
  pullRequests: RoutinePullRequestStatus[];
  routineName: string;
  scheduledAt: string | null;
  state: RoutineFiringState;
  terminalReason: string | null;
  triggerSource: RoutineFiringTriggerSource;
  updatedAt: string;
  workspacePath: string;
  workspacePrunedAt: string | null;
};

export type RoutineFiringStateTransition = {
  createdAt: string;
  sequence: number;
  state: RoutineFiringState;
};

export type RoutineFanoutHoldReason =
  | `provider_command_missing: ${AgentProviderName}`
  | `provider_not_registered: ${AgentProviderName}`;

export type RoutineFanoutTargetStatus = {
  disposition: "pending" | "held" | "firing" | "skipped";
  firing: RoutineFiringStatus | null;
  firingId: string | null;
  holdReason: RoutineFanoutHoldReason | null;
  projectName: string;
  skipReason: RoutineSkipReason | "target_unavailable" | null;
};

export type RoutineFanoutStatus = {
  createdAt: string;
  failureCount: number;
  id: string;
  issueCount: number;
  notificationError: string | null;
  notificationState: "pending" | "sending" | "sent" | "skipped";
  notifiedAt: string | null;
  pullRequestCount: number;
  routineName: string;
  scheduledAt: string;
  subject: string;
  targets: RoutineFanoutTargetStatus[];
  updatedAt: string;
};

export type SyncProjectStateInput = {
  name: string;
  validationMessage?: string | null;
  validationState?: ProjectValidationState;
  weight?: number | undefined;
};

export type ProjectPollOutcomeInput = {
  candidateIssues: number;
  error?: string | null;
  fetchedIssues: number;
  filteredIssues: number;
  ok: boolean;
  projectName: string;
};

type ProjectIssueSnapshotKind = "candidate" | "filtered";

export type ProjectIssueSnapshotRow = {
  blockedBy: RawGitHubIssueDependencyRef[];
  // A fetched-blocker count over ISSUE_DEPENDENCIES_MAX_BLOCKERS_PER_ISSUE
  // (src/issue-polling.ts) unfetched -- must gate exactly like an open
  // blocker (fail closed on ambiguity), not just influence
  // evaluateProjectEligibility's reasons. Persisted as its own column so
  // the label-write route's snapshot-backed gate sees it too, not just the
  // daemon's live IssueSnapshot.
  blockedByTruncated: boolean;
  issueNumber: number;
  kind: ProjectIssueSnapshotKind;
  labels: string[];
  // Best-effort "## Parent" heading parse (parseParentIssueNumber,
  // src/issue-polling.ts) -- display-only graph clustering, never a
  // gating signal. Absent when the body had no parseable heading.
  parentIssueNumber?: number;
  polledAt: string;
  priority: number;
  reasons: string[];
  title: string;
};

export type ProjectSnapshotRepository = {
  owner: string;
  repo: string;
};

// Persists #303's per-project issue poll snapshot (ADR 0073): the daemon
// replaces a project's rows wholesale on every *successful* poll for that
// project, so an issue that stops being returned (closed, relabeled) ages
// out on the next successful tick rather than needing a separate retention
// sweep. A failed poll leaves prior rows untouched — see the ADR for why.
// #308 (ADR 0077) added `labels`: the triage search page needs an issue's
// full label set, not just the subset `reasons` names as the cause of a
// filter decision.
export type ReplaceProjectIssueSnapshotsInput = {
  polledAt: string;
  projectName: string;
  // Optional only for pre-repository-binding callers and migration tests.
  // Production poll persistence always supplies it; an unbound legacy row
  // is deliberately ineligible for a label write until the next successful
  // poll replaces it.
  repository?: ProjectSnapshotRepository;
  rows: Array<{
    blockedBy: RawGitHubIssueDependencyRef[];
    blockedByTruncated: boolean;
    issueNumber: number;
    kind: ProjectIssueSnapshotKind;
    labels: string[];
    parentIssueNumber?: number;
    priority: number;
    reasons: string[];
    title: string;
  }>;
};

export type PullRequestBranchOrigin =
  "issue_branch" | "routine_firing_branch" | "neither";
type PullRequestMergeableState = "mergeable" | "conflicting" | "unknown";
type PullRequestChecksState = "failure" | "pending" | "success" | "unknown";
type PullRequestReviewDecisionState =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "commented"
  | "unknown";
type PullRequestTrackingStateSnapshot = "closed" | "merged" | "open";

// Persists #309's per-repo PR poll snapshot (ADR 0077), mirroring #303's
// `project_issue_snapshots`: the daemon replaces a project's rows wholesale
// on every successful poll, so a PR that stops being returned (closed,
// merged) ages out on the next successful tick. `stateAvailable` is false
// when Symphonika's own Pull Request State (src/pull-request-state.ts)
// couldn't be fetched for this PR at poll time — the mergeable/checks/
// reviewDecision/trackingState/unresolvedReviewThreads fields are then all
// null, distinct from GitHub genuinely reporting "unknown".
export type ProjectPullRequestSnapshotRow = {
  branchOrigin: PullRequestBranchOrigin;
  checks: PullRequestChecksState | null;
  draft: boolean;
  headRef: string | null;
  headSha: string | null;
  labels: string[];
  mergeable: PullRequestMergeableState | null;
  merged: boolean;
  open: boolean;
  polledAt: string;
  prNumber: number;
  reviewDecision: PullRequestReviewDecisionState | null;
  stateAvailable: boolean;
  title: string;
  trackingState: PullRequestTrackingStateSnapshot | null;
  unresolvedReviewThreads: number | null;
  url: string | null;
};

export type ReplaceProjectPullRequestSnapshotsInput = {
  polledAt: string;
  projectName: string;
  repository?: ProjectSnapshotRepository;
  rows: Array<Omit<ProjectPullRequestSnapshotRow, "polledAt">>;
};

// #309 part 3's durable-evidence record for a dashboard-triggered merge
// action (AC9), independent of any Run — unlike recordWaitingActivity
// (Run-keyed) and recordPullRequestObservation (tracked_pull_requests.id-
// keyed), a merge target can be #259's untracked-orphan case with neither.
// One row per attempt, written once after the attempt completes (both the
// merge outcome and, separately, the re-derived post-attempt state) rather
// than a two-phase "attempting" / "done" pair — see ADR 0078 for why a
// single post-attempt insert was chosen over that alternative.
export type RecordPullRequestMergeAttemptInput = {
  error: string | null;
  freshTrackingState: PullRequestTrackingStateSnapshot | null;
  method: string;
  ok: boolean;
  prNumber: number;
  projectName: string;
};

export type PullRequestMergeAttempt = {
  attemptedAt: string;
  error: string | null;
  freshTrackingState: PullRequestTrackingStateSnapshot | null;
  id: number;
  method: string;
  ok: boolean;
  prNumber: number;
  projectName: string;
};

export type ProjectDispatchSelectionInput = {
  issueNumber: number;
  projectName: string;
  schedulerWeights: Array<{
    currentWeight: number;
    projectName: string;
    weight: number;
  }>;
};

export type PullRequestDiscoveryRun = {
  branchName: string;
  issueNumber: number;
  projectName: string;
  runId: string;
};

export type TrackedPullRequest = {
  branchName: string;
  createdAt: string;
  headShaAtDispatch: string;
  id: number;
  issueNumber: number;
  lastFollowupRunId: string | null;
  lastObservedAt: string;
  lastReviewDispatchFingerprint: string | null;
  lastSeenHeadSha: string;
  projectName: string;
  prNumber: number;
  prUrl: string;
  reviewDispatchCount: number;
  reviewFollowupCapReached: boolean;
  runId: string;
  state: PullRequestTrackingState;
  updatedAt: string;
};

export type ProviderEventRecord = {
  attemptId: string;
  createdAt: string;
  normalized: NormalizedProviderEvent;
  raw: unknown;
  runId: string;
  sequence: number;
  type: string;
};

export type WatchdogSample = {
  idleSince: string | null;
  lastMessageAt: string | null;
  lastToolCallAt: string | null;
  normalizedLogOffset: number;
  normalizedLogPath: string;
  outputTokensTotal: number;
  runId: string;
  sampledAt: string;
  turnIdSetSize: number;
  workspaceMtimeMax: number;
};

export type WatchdogCandidateRun = {
  evidenceIgnore: readonly string[];
  issueNumber: number;
  normalizedLogPath: string;
  projectName: string;
  runId: string;
  state: Extract<RunState, "running">;
  watchdogGeneration: number;
  workspacePath: string;
};

export type ListProviderEventsOptions = {
  afterSequence?: number;
  limit?: number;
  order?: "asc" | "desc";
};

export type ListRunsFilter = {
  issueNumber?: number;
  limit?: number;
  project?: string;
  state?: RunState | RunState[];
};

export type OpenRunStoreOptions = {
  stateRoot: string;
};

export type CreateRunInput = {
  evidenceIgnore?: readonly string[];
  id: string;
  issue: IssueSnapshot;
  projectName: string;
  providerCommand: string;
  providerName: AgentProviderName;
};

export type RunEvidenceInput = {
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

export type CreateAttemptInput = RunEvidenceInput & {
  attemptNumber: number;
  id: string;
  providerCommand: string;
  providerName: AgentProviderName;
  runId: string;
  state: RunState;
};

export type ProviderEventMetadataInput = {
  attemptId: string;
  normalized: NormalizedProviderEvent;
  raw: unknown;
  runId: string;
  sequence: number;
};

type RunRow = {
  branch_name: string | null;
  cancel_reason: string | null;
  cancel_requested: number;
  continuation_parent_run_id: string | null;
  created_at: string;
  current_state_id: string | null;
  failure_classification: string | null;
  id: string;
  is_continuation: number;
  issue_number: number;
  issue_title: string;
  project_name: string;
  provider_name: string | null;
  retry_count: number;
  state: RunState;
  state_transition_reason: string | null;
  terminal_reason: string | null;
  terminal_state_id: string | null;
  updated_at: string;
  workspace_path: string | null;
};

type ProjectLastRunRow = RunRow & {
  last_transition_at: string;
};

type AttemptRow = {
  attempt_number: number;
  branch_name: string;
  created_at: string;
  id: string;
  issue_snapshot_path: string | null;
  metadata_path: string | null;
  normalized_log_path: string | null;
  prompt_path: string | null;
  provider_command: string;
  provider_name: string;
  raw_log_path: string | null;
  run_id: string;
  state: RunState;
  updated_at: string;
  workflow_graph_path: string | null;
  workspace_path: string;
};

type RunArtifactRow = {
  issue_snapshot_json: string;
  issue_snapshot_path: string | null;
  metadata_path: string | null;
  normalized_log_path: string | null;
  prompt_path: string | null;
  raw_log_path: string | null;
  workflow_graph_path: string | null;
};

type AttemptArtifactRow = {
  issue_snapshot_path: string | null;
  metadata_path: string | null;
  normalized_log_path: string | null;
  prompt_path: string | null;
  raw_log_path: string | null;
  run_id: string;
  workflow_graph_path: string | null;
};

type ProviderEventRow = {
  attempt_id: string;
  created_at: string;
  normalized_json: string;
  raw_json: string;
  run_id: string;
  sequence: number;
  type: string;
};

function mapProviderEventRow(row: ProviderEventRow): ProviderEventRecord {
  return {
    attemptId: row.attempt_id,
    createdAt: row.created_at,
    normalized: JSON.parse(row.normalized_json) as NormalizedProviderEvent,
    raw: JSON.parse(row.raw_json) as unknown,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type
  };
}

type WatchdogCandidateRunRow = {
  evidence_ignore_json: string;
  id: string;
  issue_number: number;
  normalized_log_path: string | null;
  project_name: string;
  state: WatchdogCandidateRun["state"];
  watchdog_generation: number;
  workspace_path: string | null;
};

type WatchdogSampleRow = {
  idle_since: string | null;
  last_message_at: string | null;
  last_tool_call_at: string | null;
  normalized_log_offset: number;
  normalized_log_path: string;
  output_tokens_total: number;
  run_id: string;
  sampled_at: string;
  turn_id_set_size: number;
  workspace_mtime_max: number;
};

type WatchdogTokenSampleRow = {
  normalized_log_path: string;
  output_tokens_total: number;
  sampled_at: string;
};

type PullRequestDiscoveryRunRow = {
  branch_name: string;
  id: string;
  issue_number: number;
  project_name: string;
};

type TrackedPullRequestRow = {
  branch_name: string;
  created_at: string;
  head_sha_at_dispatch: string;
  id: number;
  issue_number: number;
  last_followup_run_id: string | null;
  last_observed_at: string;
  last_review_dispatch_fingerprint: string | null;
  last_seen_head_sha: string;
  project_name: string;
  pr_number: number;
  pr_url: string;
  review_dispatch_count: number;
  review_followup_cap_reached: number;
  run_id: string;
  state: PullRequestTrackingState;
  updated_at: string;
};

type ProjectStateRow = {
  active: number;
  created_at: string;
  last_candidate_issues: number;
  last_dispatched_at: string | null;
  last_dispatched_issue_number: number | null;
  last_fetched_issues: number;
  last_filtered_issues: number;
  last_poll_error: string | null;
  last_poll_finished_at: string | null;
  last_poll_ok: number | null;
  last_poll_started_at: string | null;
  last_successful_poll_at: string | null;
  project_name: string;
  scheduler_current_weight: number;
  updated_at: string;
  validation_message: string | null;
  validation_state: ProjectValidationState;
  weight: number;
};

type ProjectIssueSnapshotDbRow = {
  blocked_by: string | null;
  blocked_by_truncated: number;
  issue_number: number;
  kind: ProjectIssueSnapshotKind;
  labels: string | null;
  parent_issue_number: number | null;
  polled_at: string;
  priority: number;
  reasons: string | null;
  title: string;
};

type ProjectPullRequestSnapshotDbRow = {
  branch_origin: PullRequestBranchOrigin;
  checks: PullRequestChecksState | null;
  draft: number;
  head_ref: string | null;
  head_sha: string | null;
  labels: string | null;
  mergeable: PullRequestMergeableState | null;
  merged: number;
  open: number;
  polled_at: string;
  pr_number: number;
  review_decision: PullRequestReviewDecisionState | null;
  state_available: number;
  title: string;
  tracking_state: PullRequestTrackingStateSnapshot | null;
  unresolved_review_threads: number | null;
  url: string | null;
};

type PullRequestMergeAttemptDbRow = {
  attempted_at: string;
  error: string | null;
  fresh_tracking_state: PullRequestTrackingStateSnapshot | null;
  id: number;
  method: string;
  ok: number;
  pr_number: number;
  project_name: string;
};

type RoutineRow = {
  allow_overlap: number;
  catch_up: RoutineCatchUpPolicy;
  created_at: string;
  disabled_reason: RoutineDisabledReason | null;
  effort: string | null;
  kind: RoutineKind;
  last_attempted_at: string | null;
  last_fired_at: string | null;
  last_skip_at: string | null;
  last_skip_reason: RoutineSkipReason | null;
  model: string | null;
  name: string;
  next_fire_at: string | null;
  notify_enabled: number;
  project_name: string;
  permission_mode: string | null;
  provider_name: AgentProviderName | null;
  schedule_at: string;
  schedule_cron: string | null;
  schedule_tz: string | null;
  source_path: string;
  state: RoutineState;
  timeout_minutes: number | null;
  updated_at: string;
};

type RoutineFiringRow = {
  branch_name: string | null;
  branch_ref: string | null;
  cancel_reason: CancelReason | null;
  cancel_requested: number;
  commits_ahead: number;
  created_at: string;
  fanout_id: string | null;
  id: string;
  kind: RoutineKind | null;
  notification_error: string | null;
  notification_state: RoutineNotificationState | null;
  outcome_action: RoutineOutcomeAction | null;
  outcome_source: RoutineOutcomeSource | null;
  outcome_status: RoutineOutcomeStatus | null;
  outcome_summary: string | null;
  outcome_title: string | null;
  outcome_url: string | null;
  outcome_verified: number | null;
  project_name: string;
  provider_command: string;
  provider_name: AgentProviderName;
  routine_name: string;
  scheduled_at: string;
  state: RoutineFiringState;
  terminal_reason: string | null;
  trigger_source: RoutineFiringTriggerSource;
  updated_at: string;
  workspace_path: string | null;
  workspace_pruned_at: string | null;
};

type RoutineOutcomeRow = Pick<
  RoutineFiringRow,
  | "outcome_action"
  | "outcome_source"
  | "outcome_status"
  | "outcome_summary"
  | "outcome_title"
  | "outcome_url"
  | "outcome_verified"
>;

type RoutinePullRequestRow = {
  firing_id: string;
  head_sha: string;
  pr_number: number;
  project_name: string;
  routine_name: string;
};

type RoutineFanoutRow = {
  created_at: string;
  id: string;
  notification_error: string | null;
  notification_state: RoutineFanoutStatus["notificationState"];
  notified_at: string | null;
  routine_name: string;
  scheduled_at: string;
  updated_at: string;
};

type RoutineFanoutTargetRow = {
  disposition: RoutineFanoutTargetStatus["disposition"];
  fanout_id: string;
  firing_id: string | null;
  hold_reason: RoutineFanoutHoldReason | null;
  project_name: string;
  skip_reason: RoutineSkipReason | "target_unavailable" | null;
};

const PULL_REQUEST_DISCOVERY_LIMIT = 25;
const MAX_PULL_REQUEST_DISCOVERY_ATTEMPTS = 10;
export const INPUT_REQUIRED_LEGACY_BACKFILL_GRACE_MS = 60_000;
const INPUT_REQUIRED_LEGACY_TERMINAL_REASON =
  "provider requested input (legacy)";

class RoutineAlreadyClaimedError extends Error {
  constructor() {
    super("routine already claimed");
    this.name = "RoutineAlreadyClaimedError";
  }
}

// See docs/adr/0074-live-notification-path.md: these are invalidation
// signals (identity + new state), not a replay log. A listener that
// misses events during a disconnect is expected to reconcile once on
// reconnect rather than replay what it missed.
export type ChangeEvent =
  | { kind: "run-transition"; runId: string; sequence: number; state: RunState }
  | {
      firingId: string;
      kind: "firing-transition";
      sequence: number;
      state: RoutineFiringState;
    }
  | {
      finishedAt: string;
      kind: "project-poll";
      ok: boolean;
      projectName: string;
    }
  | { errors: string[]; kind: "reload-outcome"; ok: boolean };

type FiringTransitionChangeEvent = Extract<
  ChangeEvent,
  { kind: "firing-transition" }
>;

type RunTransitionChangeEvent = Extract<
  ChangeEvent,
  { kind: "run-transition" }
>;

type InsertRunRowInput = {
  evidenceIgnore?: readonly string[];
  id: string;
  isContinuation: boolean;
  issue: IssueSnapshot;
  parentRunId: string | null;
  projectName: string;
  providerCommand: string | null;
  providerName: AgentProviderName | null;
  state: RunState;
};

type CreateRoutineFiringInput = {
  branchName?: string;
  branchRef?: string;
  fanoutId?: string;
  id: string;
  kind?: RoutineKind;
  projectName: string;
  providerCommand: string;
  providerName: AgentProviderName;
  routineName: string;
  scheduledAt?: string | null;
  triggerSource?: RoutineFiringTriggerSource;
  workspacePath?: string;
};

export class RunStore {
  private readonly changeListeners = new Set<(event: ChangeEvent) => void>();
  private readonly database: SqliteDatabase;
  private readonly stateRoot: string;

  constructor(database: SqliteDatabase, options: { stateRoot?: string } = {}) {
    this.database = database;
    this.stateRoot = path.resolve(options.stateRoot ?? process.cwd());
    this.migrate();
  }

  // Every listener runs even if an earlier one throws, since a broken SSE
  // connection must never take down a state-transition write.
  private publishChange(event: ChangeEvent): void {
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch {
        // Isolated per docs/adr/0074: a subscriber's failure is its own.
      }
    }
  }

  // Publishes events collected from inside a transaction, after the
  // transaction has committed — see docs/adr/0074 and #433. Publishing
  // per-entry inside the transaction loop would leak an event for a row
  // whose write gets rolled back by a later entry's failure.
  private publishAll(events: readonly ChangeEvent[]): void {
    for (const event of events) {
      this.publishChange(event);
    }
  }

  publishReloadOutcome(input: { errors: string[]; ok: boolean }): void {
    this.publishChange({
      errors: input.errors,
      kind: "reload-outcome",
      ok: input.ok
    });
  }

  subscribeToChanges(listener: (event: ChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  // Exposed for the "daemon does not leak streams on disconnect"
  // acceptance criterion (#305) — not otherwise used at runtime.
  get changeListenerCount(): number {
    return this.changeListeners.size;
  }

  close(): void {
    this.database.close();
  }

  createRun(input: CreateRunInput): void {
    this.recordRunRow({
      ...input,
      isContinuation: false,
      parentRunId: null,
      providerCommand: input.providerCommand,
      providerName: input.providerName,
      state: "queued"
    });
  }

  createWaitingRun(input: {
    currentStateId: string;
    id: string;
    issue: IssueSnapshot;
    parentRunId: string;
    projectName: string;
  }): void {
    // ADR 0047 depends on the waiting row being durable — `listWaitingRuns`
    // filters out rows whose `current_state_id` is null, so a crash between
    // these two writes would silently orphan the row forever. Wrap them in a
    // single SQLite transaction so the row either exists with both fields set
    // or not at all.
    const apply = this.database.transaction(() => {
      const event = this.insertRunRow({
        id: input.id,
        isContinuation: true,
        issue: input.issue,
        parentRunId: input.parentRunId,
        projectName: input.projectName,
        providerCommand: null,
        providerName: null,
        state: "waiting"
      });
      this.setRunCurrentState(input.id, input.currentStateId);
      return event;
    });
    this.publishChange(apply());
  }

  // Includes cancel-requested rows on purpose: a waiting run cancelled via
  // cancelViaUi only flips `cancel_requested = 1`, and the cancellation branch
  // lives inside reEvaluateWaitingRun. Filtering cancel-requested rows out
  // here would leave the row stuck in `state = "waiting"` forever.
  listWaitingRuns(): Array<{
    currentStateId: string;
    issueNumber: number;
    projectName: string;
    runId: string;
  }> {
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, current_state_id",
          "from runs",
          "where state = 'waiting'",
          "and current_state_id is not null",
          "order by created_at asc"
        ].join(" ")
      )
      .all() as Array<{
      id: string;
      project_name: string;
      issue_number: number;
      current_state_id: string;
    }>;
    return rows.map((row) => ({
      currentStateId: row.current_state_id,
      issueNumber: row.issue_number,
      projectName: row.project_name,
      runId: row.id
    }));
  }

  // Inheriting the parent's current_state_id is only correct when the caller
  // has already forward-stamped that parent row with the state this
  // continuation should start at (recordWorkflowStateAdvance / createWaitingRun
  // do this before scheduling). A caller whose "parent" is simply whatever run
  // is currently associated with an issue/PR — e.g. PR review-followup, where
  // the parent is by construction parked at a wait/merge_pr state — must pass
  // inheritParentState: false so the continuation instead falls back to
  // expandedWorkflow.initial in runAttemptLifecycle. See issue #358.
  createContinuationRun(
    input: CreateRunInput & {
      inheritParentState?: boolean;
      parentRunId: string;
    }
  ): void {
    this.recordRunRow({
      ...(input.evidenceIgnore === undefined
        ? {}
        : { evidenceIgnore: input.evidenceIgnore }),
      id: input.id,
      isContinuation: true,
      issue: input.issue,
      parentRunId: input.parentRunId,
      projectName: input.projectName,
      providerCommand: input.providerCommand,
      providerName: input.providerName,
      state: "queued"
    });
    if (input.inheritParentState === false) {
      return;
    }
    const parent = this.database
      .prepare("select current_state_id from runs where id = ?")
      .get(input.parentRunId) as
      { current_state_id: string | null } | undefined;
    if (parent?.current_state_id != null) {
      this.setRunCurrentState(input.id, parent.current_state_id);
    }
  }

  createCapReachedFailureRun(input: {
    id: string;
    issue: IssueSnapshot;
    parentRunId: string;
    projectName: string;
    reason: string;
  }): void {
    this.recordRunRow({
      id: input.id,
      isContinuation: true,
      issue: input.issue,
      parentRunId: input.parentRunId,
      projectName: input.projectName,
      providerCommand: null,
      providerName: null,
      state: "failed"
    });
    this.database
      .prepare(
        "update runs set terminal_reason = ?, failure_classification = 'deterministic', updated_at = ? where id = ?"
      )
      .run(input.reason, timestamp(), input.id);
    this.updateRunState(input.id, "failed");
  }

  recordTerminalReason(
    runId: string,
    reason: string,
    classification?: FailureClassification
  ): void {
    if (classification === undefined) {
      this.database
        .prepare(
          "update runs set terminal_reason = ?, updated_at = ? where id = ?"
        )
        .run(reason, timestamp(), runId);
      return;
    }
    this.database
      .prepare(
        "update runs set terminal_reason = ?, failure_classification = ?, updated_at = ? where id = ?"
      )
      .run(reason, classification, timestamp(), runId);
  }

  setRunCurrentState(runId: string, currentStateId: string): void {
    this.database
      .prepare(
        "update runs set current_state_id = ?, updated_at = ? where id = ?"
      )
      .run(currentStateId, timestamp(), runId);
  }

  recordWorkflowStateAdvance(
    runId: string,
    input: { nextStateId: string; transitionReason: string }
  ): void {
    this.database
      .prepare(
        [
          "update runs set",
          "current_state_id = ?,",
          "state_transition_reason = ?,",
          "updated_at = ?",
          "where id = ?"
        ].join(" ")
      )
      .run(input.nextStateId, input.transitionReason, timestamp(), runId);
  }

  recordWorkflowTerminal(
    runId: string,
    input: { terminalStateId: string; transitionReason: string }
  ): void {
    this.database
      .prepare(
        [
          "update runs set",
          "current_state_id = null,",
          "terminal_state_id = ?,",
          "state_transition_reason = ?,",
          "updated_at = ?",
          "where id = ?"
        ].join(" ")
      )
      .run(input.terminalStateId, input.transitionReason, timestamp(), runId);
  }

  recordWorkflowBlocked(
    runId: string,
    input: { stateId: string; transitionReason: string }
  ): void {
    // `current_state_id` is intentionally preserved so a transient retry
    // (which reuses this run row) resumes at the stuck state instead of
    // falling back to `expandedWorkflow.initial`.
    this.database
      .prepare(
        [
          "update runs set",
          "terminal_state_id = ?,",
          "state_transition_reason = ?,",
          "updated_at = ?",
          "where id = ?"
        ].join(" ")
      )
      .run(input.stateId, input.transitionReason, timestamp(), runId);
  }

  recordWaitingActivity(runId: string, reason: string): void {
    this.database
      .prepare(
        "update runs set state_transition_reason = ?, updated_at = ? where id = ?"
      )
      .run(reason, timestamp(), runId);
  }

  incrementRetryCount(runId: string): number {
    const updated = this.database
      .prepare(
        "update runs set retry_count = retry_count + 1, updated_at = ? where id = ? returning retry_count"
      )
      .get(timestamp(), runId) as { retry_count: number } | undefined;
    return updated?.retry_count ?? 0;
  }

  runRetryCount(runId: string): number {
    const row = this.database
      .prepare("select retry_count from runs where id = ?")
      .get(runId) as { retry_count: number } | undefined;
    return row?.retry_count ?? 0;
  }

  isContinuationRun(runId: string): boolean {
    const row = this.database
      .prepare("select is_continuation from runs where id = ?")
      .get(runId) as { is_continuation: number } | undefined;
    return row?.is_continuation === 1;
  }

  listActiveRunIds(): {
    runId: string;
    projectName: string;
    issueNumber: number;
  }[] {
    const rows = this.database
      .prepare(
        "select id, project_name, issue_number from runs where state in ('queued','preparing_workspace','running')"
      )
      .all() as { id: string; project_name: string; issue_number: number }[];
    return rows.map((row) => ({
      issueNumber: row.issue_number,
      projectName: row.project_name,
      runId: row.id
    }));
  }

  listWatchdogCandidateRuns(): WatchdogCandidateRun[] {
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, state, evidence_ignore_json,",
          "workspace_path, normalized_log_path, watchdog_generation",
          "from runs",
          // ADR 0054: only `running` Runs have a live provider that can wedge.
          // queued/preparing_workspace have no provider yet (no liveness signal
          // to advance, must not accrue idle time); waiting is parked by design.
          "where state = 'running'",
          "order by created_at asc, id asc"
        ].join(" ")
      )
      .all() as WatchdogCandidateRunRow[];
    return rows.map((row) => ({
      evidenceIgnore: parseEvidenceIgnore(row.evidence_ignore_json),
      issueNumber: row.issue_number,
      normalizedLogPath: row.normalized_log_path ?? "",
      projectName: row.project_name,
      runId: row.id,
      state: row.state,
      watchdogGeneration: row.watchdog_generation,
      workspacePath: row.workspace_path ?? ""
    }));
  }

  getWatchdogSample(runId: string): WatchdogSample | undefined {
    const row = this.database
      .prepare(
        [
          "select run_id, sampled_at, last_tool_call_at, last_message_at,",
          "workspace_mtime_max, turn_id_set_size, output_tokens_total,",
          "normalized_log_offset, normalized_log_path, idle_since",
          "from watchdog_samples where run_id = ?"
        ].join(" ")
      )
      .get(runId) as WatchdogSampleRow | undefined;
    return row === undefined ? undefined : mapWatchdogSampleRow(row);
  }

  upsertWatchdogSample(
    sample: WatchdogSample,
    watchdogGeneration?: number
  ): boolean {
    const values = {
      idle_since: sample.idleSince,
      last_message_at: sample.lastMessageAt,
      last_tool_call_at: sample.lastToolCallAt,
      normalized_log_offset: sample.normalizedLogOffset,
      normalized_log_path: sample.normalizedLogPath,
      output_tokens_total: sample.outputTokensTotal,
      run_id: sample.runId,
      sampled_at: sample.sampledAt,
      turn_id_set_size: sample.turnIdSetSize,
      workspace_mtime_max: sample.workspaceMtimeMax
    };
    const latest = this.database.prepare(
      [
        "insert into watchdog_samples (",
        "run_id, sampled_at, last_tool_call_at, last_message_at,",
        "workspace_mtime_max, turn_id_set_size, output_tokens_total,",
        "normalized_log_offset, normalized_log_path, idle_since",
        ") values (",
        "@run_id, @sampled_at, @last_tool_call_at, @last_message_at,",
        "@workspace_mtime_max, @turn_id_set_size, @output_tokens_total,",
        "@normalized_log_offset, @normalized_log_path, @idle_since",
        ")",
        "on conflict(run_id) do update set",
        "sampled_at = excluded.sampled_at,",
        "last_tool_call_at = excluded.last_tool_call_at,",
        "last_message_at = excluded.last_message_at,",
        "workspace_mtime_max = excluded.workspace_mtime_max,",
        "turn_id_set_size = excluded.turn_id_set_size,",
        "output_tokens_total = excluded.output_tokens_total,",
        "normalized_log_offset = excluded.normalized_log_offset,",
        "normalized_log_path = excluded.normalized_log_path,",
        "idle_since = excluded.idle_since"
      ].join(" ")
    );
    const history = this.database.prepare(
      [
        "insert or replace into watchdog_sample_history (",
        "run_id, sampled_at, last_tool_call_at, last_message_at,",
        "workspace_mtime_max, turn_id_set_size, output_tokens_total,",
        "normalized_log_offset, normalized_log_path, idle_since",
        ") values (",
        "@run_id, @sampled_at, @last_tool_call_at, @last_message_at,",
        "@workspace_mtime_max, @turn_id_set_size, @output_tokens_total,",
        "@normalized_log_offset, @normalized_log_path, @idle_since",
        ")"
      ].join(" ")
    );
    return this.database.transaction(() => {
      if (
        watchdogGeneration !== undefined &&
        !this.isCurrentWatchdogGeneration(sample.runId, watchdogGeneration)
      ) {
        return false;
      }
      latest.run(values);
      history.run(values);
      return true;
    })();
  }

  watchdogOutputTokenGrowth(runId: string, windowStart: string): number {
    const baseline = this.database
      .prepare(
        [
          "select sampled_at, output_tokens_total, normalized_log_path",
          "from watchdog_sample_history",
          "where run_id = ? and sampled_at <= ?",
          "order by sampled_at desc limit 1"
        ].join(" ")
      )
      .get(runId, windowStart) as WatchdogTokenSampleRow | undefined;
    const inWindow = this.database
      .prepare(
        [
          "select sampled_at, output_tokens_total, normalized_log_path",
          "from watchdog_sample_history",
          "where run_id = ? and sampled_at > ?",
          "order by sampled_at asc"
        ].join(" ")
      )
      .all(runId, windowStart) as WatchdogTokenSampleRow[];
    const samples = baseline === undefined ? inWindow : [baseline, ...inWindow];
    if (samples.length < 2) {
      return 0;
    }

    let growth = 0;
    let previous = samples[0]!;
    for (const current of samples.slice(1)) {
      growth +=
        current.normalized_log_path === previous.normalized_log_path
          ? Math.max(
              0,
              current.output_tokens_total - previous.output_tokens_total
            )
          : Math.max(0, current.output_tokens_total);
      previous = current;
    }
    return growth;
  }

  rememberWatchdogTurnIds(
    runId: string,
    turnIds: Iterable<string>,
    watchdogGeneration?: number
  ): number | undefined {
    const insert = this.database.prepare(
      "insert or ignore into watchdog_turn_ids (run_id, turn_id) values (?, ?)"
    );
    const count = this.database.prepare(
      "select count(*) as count from watchdog_turn_ids where run_id = ?"
    );
    const apply = this.database.transaction(() => {
      if (
        watchdogGeneration !== undefined &&
        !this.isCurrentWatchdogGeneration(runId, watchdogGeneration)
      ) {
        return undefined;
      }
      for (const turnId of turnIds) {
        insert.run(runId, turnId);
      }
      return count.get(runId) as { count: number };
    });
    return apply()?.count;
  }

  markRunNoProgressStale(
    runId: string,
    updatedAt = timestamp(),
    watchdogGeneration?: number
  ): boolean {
    const generationGuard =
      watchdogGeneration === undefined
        ? ""
        : "and watchdog_generation = @watchdog_generation";
    const result = this.database
      .prepare(
        [
          "update runs set",
          "state = 'stale',",
          "terminal_reason = 'no_progress',",
          "failure_classification = 'deterministic',",
          "notification_state = 'pending',",
          "notification_error = null,",
          "updated_at = @updated_at",
          "where id = @id",
          "and state = 'running'",
          "and cancel_requested = 0",
          generationGuard
        ].join(" ")
      )
      .run({
        id: runId,
        updated_at: updatedAt,
        ...(watchdogGeneration === undefined
          ? {}
          : { watchdog_generation: watchdogGeneration })
      });
    if (result.changes === 0) {
      return false;
    }
    this.recordRunTransition(runId, "stale", updatedAt);
    return true;
  }

  // Stale-claim liveness needs waiting rows too: a parked wait still wears
  // `sym:claimed` (ADR 0046), and between scheduled `wait_park` callbacks it
  // has no entry in `activeRuns` and no row in `listActiveRunIds`. Cancel-
  // requested rows stay included for the same reason `listWaitingRuns`
  // includes them — they are still live until `reEvaluateWaitingRun`
  // transitions them.
  listWaitingRunIds(): {
    runId: string;
    projectName: string;
    issueNumber: number;
  }[] {
    const rows = this.database
      .prepare(
        "select id, project_name, issue_number from runs where state = 'waiting'"
      )
      .all() as { id: string; project_name: string; issue_number: number }[];
    return rows.map((row) => ({
      issueNumber: row.issue_number,
      projectName: row.project_name,
      runId: row.id
    }));
  }

  private recordRunRow(input: InsertRunRowInput): void {
    this.publishChange(this.insertRunRow(input));
  }

  private insertRunRow(input: InsertRunRowInput): RunTransitionChangeEvent {
    const now = timestamp();
    this.database
      .prepare(
        [
          "insert into runs (",
          "id, project_name, issue_number, issue_title, state, issue_snapshot_json,",
          "evidence_ignore_json, provider_name, provider_command,",
          "is_continuation, continuation_parent_run_id,",
          "created_at, updated_at",
          ") values (",
          "@id, @project_name, @issue_number, @issue_title, @state, @issue_snapshot_json,",
          "@evidence_ignore_json, @provider_name, @provider_command,",
          "@is_continuation, @continuation_parent_run_id,",
          "@created_at, @updated_at",
          ")"
        ].join(" ")
      )
      .run({
        continuation_parent_run_id: input.parentRunId,
        created_at: now,
        evidence_ignore_json: JSON.stringify(input.evidenceIgnore ?? []),
        id: input.id,
        is_continuation: input.isContinuation ? 1 : 0,
        issue_number: input.issue.number,
        issue_snapshot_json: JSON.stringify(input.issue),
        issue_title: input.issue.title,
        project_name: input.projectName,
        provider_command: input.providerCommand,
        provider_name: input.providerName,
        state: input.state,
        updated_at: now
      });
    return this.insertRunTransition(input.id, input.state, now);
  }

  countSucceededContinuations(
    projectName: string,
    issueNumber: number
  ): number {
    const row = this.database
      .prepare(
        "select count(*) as count from runs where project_name = ? and issue_number = ? and state = 'succeeded' and is_continuation = 1"
      )
      .get(projectName, issueNumber) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  syncProjectStates(projects: SyncProjectStateInput[]): void {
    const now = timestamp();
    const normalized = projects.map((project) => ({
      name: project.name,
      validationMessage: project.validationMessage ?? null,
      validationState: project.validationState ?? "valid",
      weight: normalizeProjectWeight(project.weight)
    }));
    const activeNames = new Set(normalized.map((project) => project.name));
    const apply = this.database.transaction(() => {
      for (const project of normalized) {
        this.database
          .prepare(
            [
              "insert into project_states (",
              "project_name, active, weight, validation_state, validation_message,",
              "created_at, updated_at",
              ") values (",
              "@project_name, 1, @weight, @validation_state, @validation_message,",
              "@created_at, @updated_at",
              ")",
              "on conflict(project_name) do update set",
              "active = 1,",
              "weight = excluded.weight,",
              "validation_state = excluded.validation_state,",
              "validation_message = excluded.validation_message,",
              "updated_at = excluded.updated_at"
            ].join(" ")
          )
          .run({
            created_at: now,
            project_name: project.name,
            updated_at: now,
            validation_message: project.validationMessage,
            validation_state: project.validationState,
            weight: project.weight
          });
      }

      for (const projectName of this.listActiveProjectNames()) {
        if (activeNames.has(projectName)) {
          continue;
        }
        this.database
          .prepare(
            "update project_states set active = 0, validation_state = 'inactive', validation_message = null, updated_at = ? where project_name = ?"
          )
          .run(now, projectName);
      }
    });
    apply();
  }

  recordProjectPollOutcome(input: ProjectPollOutcomeInput): void {
    const now = timestamp();
    const validationState: ProjectValidationState = input.ok
      ? "valid"
      : "invalid";
    const message = input.ok ? null : (input.error ?? "project poll failed");
    this.database
      .prepare(
        [
          "insert into project_states (",
          "project_name, active, weight, validation_state, validation_message,",
          "last_poll_started_at, last_poll_finished_at, last_successful_poll_at, last_poll_ok, last_poll_error,",
          "last_fetched_issues, last_candidate_issues, last_filtered_issues,",
          "created_at, updated_at",
          ") values (",
          "@project_name, 1, 1, @validation_state, @validation_message,",
          "@last_poll_started_at, @last_poll_finished_at, @last_successful_poll_at, @last_poll_ok, @last_poll_error,",
          "@last_fetched_issues, @last_candidate_issues, @last_filtered_issues,",
          "@created_at, @updated_at",
          ")",
          "on conflict(project_name) do update set",
          "validation_state = excluded.validation_state,",
          "validation_message = excluded.validation_message,",
          "last_poll_started_at = excluded.last_poll_started_at,",
          "last_poll_finished_at = excluded.last_poll_finished_at,",
          "last_successful_poll_at = case when excluded.last_poll_ok = 1 then excluded.last_successful_poll_at else project_states.last_successful_poll_at end,",
          "last_poll_ok = excluded.last_poll_ok,",
          "last_poll_error = excluded.last_poll_error,",
          "last_fetched_issues = excluded.last_fetched_issues,",
          "last_candidate_issues = excluded.last_candidate_issues,",
          "last_filtered_issues = excluded.last_filtered_issues,",
          "updated_at = excluded.updated_at"
        ].join(" ")
      )
      .run({
        created_at: now,
        last_candidate_issues: input.candidateIssues,
        last_fetched_issues: input.fetchedIssues,
        last_filtered_issues: input.filteredIssues,
        last_poll_error: input.error ?? null,
        last_poll_finished_at: now,
        last_poll_ok: input.ok ? 1 : 0,
        last_poll_started_at: now,
        last_successful_poll_at: input.ok ? now : null,
        project_name: input.projectName,
        updated_at: now,
        validation_message: message,
        validation_state: validationState
      });
    this.publishChange({
      finishedAt: now,
      kind: "project-poll",
      ok: input.ok,
      projectName: input.projectName
    });
  }

  recordProjectDispatchSelection(input: ProjectDispatchSelectionInput): void {
    const now = timestamp();
    const apply = this.database.transaction(() => {
      for (const weight of input.schedulerWeights) {
        this.database
          .prepare(
            [
              "insert into project_states (",
              "project_name, active, weight, validation_state, validation_message, scheduler_current_weight, created_at, updated_at",
              ") values (",
              "@project_name, 1, @weight, 'valid', null, @scheduler_current_weight, @created_at, @updated_at",
              ")",
              "on conflict(project_name) do update set",
              "active = 1,",
              "weight = excluded.weight,",
              "validation_state = case when project_states.validation_state = 'inactive' then 'valid' else project_states.validation_state end,",
              "validation_message = case when project_states.validation_state = 'inactive' then null else project_states.validation_message end,",
              "scheduler_current_weight = excluded.scheduler_current_weight,",
              "updated_at = excluded.updated_at"
            ].join(" ")
          )
          .run({
            created_at: now,
            project_name: weight.projectName,
            scheduler_current_weight: weight.currentWeight,
            updated_at: now,
            weight: normalizeProjectWeight(weight.weight)
          });
      }

      this.database
        .prepare(
          "update project_states set last_dispatched_at = ?, last_dispatched_issue_number = ?, updated_at = ? where project_name = ?"
        )
        .run(now, input.issueNumber, now, input.projectName);
    });
    apply();
  }

  listProjectStates(): ProjectState[] {
    const rows = this.database
      .prepare(
        [
          "select project_name, active, weight, validation_state, validation_message,",
          "last_poll_started_at, last_poll_finished_at, last_successful_poll_at, last_poll_ok, last_poll_error,",
          "last_fetched_issues, last_candidate_issues, last_filtered_issues,",
          "scheduler_current_weight, last_dispatched_at, last_dispatched_issue_number,",
          "created_at, updated_at",
          "from project_states order by project_name asc"
        ].join(" ")
      )
      .all() as ProjectStateRow[];
    return rows.map((row) => mapProjectStateRow(row));
  }

  listActiveProjectNames(): string[] {
    const rows = this.database
      .prepare(
        "select project_name from project_states where active = 1 order by project_name asc"
      )
      .all() as { project_name: string }[];
    return rows.map((row) => row.project_name);
  }

  replaceProjectIssueSnapshots(input: ReplaceProjectIssueSnapshotsInput): void {
    const now = timestamp();
    const apply = this.database.transaction(() => {
      this.database
        .prepare("delete from project_issue_snapshots where project_name = ?")
        .run(input.projectName);
      const insert = this.database.prepare(
        [
          "insert into project_issue_snapshots (",
          "project_name, issue_number, kind, title, priority, reasons, labels,",
          "blocked_by, blocked_by_truncated, parent_issue_number,",
          "repository_owner, repository_name, polled_at,",
          "created_at, updated_at",
          ") values (",
          "@project_name, @issue_number, @kind, @title, @priority, @reasons, @labels,",
          "@blocked_by, @blocked_by_truncated, @parent_issue_number,",
          "@repository_owner, @repository_name, @polled_at,",
          "@created_at, @updated_at",
          ")"
        ].join(" ")
      );
      for (const row of input.rows) {
        insert.run({
          blocked_by:
            row.blockedBy.length === 0 ? null : JSON.stringify(row.blockedBy),
          blocked_by_truncated: row.blockedByTruncated ? 1 : 0,
          created_at: now,
          issue_number: row.issueNumber,
          kind: row.kind,
          labels: row.labels.length === 0 ? null : JSON.stringify(row.labels),
          parent_issue_number: row.parentIssueNumber ?? null,
          polled_at: input.polledAt,
          priority: row.priority,
          project_name: input.projectName,
          repository_name: input.repository?.repo ?? null,
          repository_owner: input.repository?.owner ?? null,
          reasons:
            row.reasons.length === 0 ? null : JSON.stringify(row.reasons),
          title: row.title,
          updated_at: now
        });
      }
    });
    apply();
  }

  getProjectIssueSnapshotRepository(
    projectName: string,
    issueNumber: number
  ): ProjectSnapshotRepository | undefined {
    const row = this.database
      .prepare(
        "select repository_owner, repository_name from project_issue_snapshots where project_name = ? and issue_number = ?"
      )
      .get(projectName, issueNumber) as
      | { repository_name: string | null; repository_owner: string | null }
      | undefined;
    return snapshotRepository(row);
  }

  listProjectIssueSnapshots(projectName: string): ProjectIssueSnapshotRow[] {
    const rows = this.database
      .prepare(
        [
          "select issue_number, kind, title, priority, reasons, labels,",
          "blocked_by, blocked_by_truncated, parent_issue_number, polled_at",
          "from project_issue_snapshots where project_name = ?",
          "order by issue_number asc"
        ].join(" ")
      )
      .all(projectName) as ProjectIssueSnapshotDbRow[];
    return rows.map((row) => ({
      blockedBy:
        row.blocked_by === null
          ? []
          : (JSON.parse(row.blocked_by) as RawGitHubIssueDependencyRef[]),
      blockedByTruncated: row.blocked_by_truncated === 1,
      issueNumber: row.issue_number,
      kind: row.kind,
      labels: row.labels === null ? [] : (JSON.parse(row.labels) as string[]),
      ...(row.parent_issue_number === null
        ? {}
        : { parentIssueNumber: row.parent_issue_number }),
      polledAt: row.polled_at,
      priority: row.priority,
      reasons:
        row.reasons === null ? [] : (JSON.parse(row.reasons) as string[]),
      title: row.title
    }));
  }

  replaceProjectPullRequestSnapshots(
    input: ReplaceProjectPullRequestSnapshotsInput
  ): void {
    const now = timestamp();
    const apply = this.database.transaction(() => {
      this.database
        .prepare(
          "delete from project_pull_request_snapshots where project_name = ?"
        )
        .run(input.projectName);
      const insert = this.database.prepare(
        [
          "insert into project_pull_request_snapshots (",
          "project_name, pr_number, title, url, draft, open, merged,",
          "head_ref, head_sha, labels, branch_origin, state_available, mergeable,",
          "checks, review_decision, tracking_state, unresolved_review_threads,",
          "repository_owner, repository_name, polled_at, created_at, updated_at",
          ") values (",
          "@project_name, @pr_number, @title, @url, @draft, @open, @merged,",
          "@head_ref, @head_sha, @labels, @branch_origin, @state_available, @mergeable,",
          "@checks, @review_decision, @tracking_state, @unresolved_review_threads,",
          "@repository_owner, @repository_name, @polled_at, @created_at, @updated_at",
          ")"
        ].join(" ")
      );
      for (const row of input.rows) {
        insert.run({
          branch_origin: row.branchOrigin,
          checks: row.checks,
          created_at: now,
          draft: row.draft ? 1 : 0,
          head_ref: row.headRef,
          head_sha: row.headSha,
          labels: row.labels.length === 0 ? null : JSON.stringify(row.labels),
          mergeable: row.mergeable,
          merged: row.merged ? 1 : 0,
          open: row.open ? 1 : 0,
          polled_at: input.polledAt,
          pr_number: row.prNumber,
          project_name: input.projectName,
          review_decision: row.reviewDecision,
          repository_name: input.repository?.repo ?? null,
          repository_owner: input.repository?.owner ?? null,
          state_available: row.stateAvailable ? 1 : 0,
          title: row.title,
          tracking_state: row.trackingState,
          unresolved_review_threads: row.unresolvedReviewThreads,
          updated_at: now,
          url: row.url
        });
      }
    });
    apply();
  }

  getProjectPullRequestSnapshotRepository(
    projectName: string,
    prNumber: number
  ): ProjectSnapshotRepository | undefined {
    const row = this.database
      .prepare(
        "select repository_owner, repository_name from project_pull_request_snapshots where project_name = ? and pr_number = ?"
      )
      .get(projectName, prNumber) as
      | { repository_name: string | null; repository_owner: string | null }
      | undefined;
    return snapshotRepository(row);
  }

  listProjectPullRequestSnapshots(
    projectName: string
  ): ProjectPullRequestSnapshotRow[] {
    const rows = this.database
      .prepare(
        [
          "select pr_number, title, url, draft, open, merged, head_ref,",
          "head_sha, labels, branch_origin, state_available, mergeable, checks,",
          "review_decision, tracking_state, unresolved_review_threads, polled_at",
          "from project_pull_request_snapshots where project_name = ?",
          "order by pr_number asc"
        ].join(" ")
      )
      .all(projectName) as ProjectPullRequestSnapshotDbRow[];
    return rows.map((row) => ({
      branchOrigin: row.branch_origin,
      checks: row.checks,
      draft: row.draft === 1,
      headRef: row.head_ref,
      headSha: row.head_sha,
      labels: row.labels === null ? [] : (JSON.parse(row.labels) as string[]),
      mergeable: row.mergeable,
      merged: row.merged === 1,
      open: row.open === 1,
      polledAt: row.polled_at,
      prNumber: row.pr_number,
      reviewDecision: row.review_decision,
      stateAvailable: row.state_available === 1,
      title: row.title,
      trackingState: row.tracking_state,
      unresolvedReviewThreads: row.unresolved_review_threads,
      url: row.url
    }));
  }

  recordPullRequestMergeAttempt(
    input: RecordPullRequestMergeAttemptInput
  ): void {
    this.database
      .prepare(
        [
          "insert into pull_request_merge_attempts (",
          "project_name, pr_number, method, ok, error, fresh_tracking_state,",
          "attempted_at",
          ") values (",
          "@project_name, @pr_number, @method, @ok, @error, @fresh_tracking_state,",
          "@attempted_at",
          ")"
        ].join(" ")
      )
      .run({
        attempted_at: timestamp(),
        error: input.error,
        fresh_tracking_state: input.freshTrackingState,
        method: input.method,
        ok: input.ok ? 1 : 0,
        pr_number: input.prNumber,
        project_name: input.projectName
      });
  }

  // Test-verification reader for recordPullRequestMergeAttempt's evidence
  // (AC9) — not wired to any UI; #309 part 3 deliberately ships no
  // merge-attempt-history surface.
  listPullRequestMergeAttempts(
    projectName: string,
    prNumber: number
  ): PullRequestMergeAttempt[] {
    const rows = this.database
      .prepare(
        [
          "select id, project_name, pr_number, method, ok, error,",
          "fresh_tracking_state, attempted_at",
          "from pull_request_merge_attempts",
          "where project_name = ? and pr_number = ?",
          "order by id asc"
        ].join(" ")
      )
      .all(projectName, prNumber) as PullRequestMergeAttemptDbRow[];
    return rows.map((row) => ({
      attemptedAt: row.attempted_at,
      error: row.error,
      freshTrackingState: row.fresh_tracking_state,
      id: row.id,
      method: row.method,
      ok: row.ok === 1,
      prNumber: row.pr_number,
      projectName: row.project_name
    }));
  }

  // Synchronizes service-level routine declarations into the routines table.
  // Each routine carries its own target `projectName` (ADR 0069); removal-
  // detection runs per project so a routine removed from one project's target
  // set is soft-disabled without touching another project's rows.
  // `protectedNamesByProject` holds invalid-routine names per project so their
  // rows are not demoted to removed_from_config (ADR 0060).
  // `trackerlessGitRoutinesByProject` carries declarations rejected by ADR
  // 0062 so persisted rows are safely disabled with their precise cause. A
  // first-seen rejection also persists a disabled row, so a later tracker
  // restoration re-enters through the normal upsert's restore rules instead
  // of looking like a brand-new declaration (an elapsed one-shot expires
  // rather than firing retroactively). See ADR 0066.
  syncRoutines(
    routines: TargetedRoutineDeclaration[],
    options: {
      now?: Date;
      // All projects that should run removal-detection this sync, including
      // projects whose last routine was just removed (zero routines). Without
      // this, `syncRoutines([])` would never enter the loop and a removed
      // routine's row would stay active. See ADR 0069.
      projects?: string[];
      protectedNamesByProject?: Record<string, string[]>;
      recomputeRecurring?: boolean;
      trackerlessGitRoutinesByProject?: Record<
        string,
        TargetedRoutineDeclaration[]
      >;
      // Routines rejected by the model/effort-vs-provider-template cross-
      // check (ADR 0067 amendment). Handled the same way as
      // trackerlessGitRoutinesByProject: excluded from removed_from_config
      // demotion and soft-disabled with their own dedicated reason instead.
      templateRejectedRoutinesByProject?: Record<
        string,
        TargetedRoutineDeclaration[]
      >;
    } = {}
  ): void {
    const now = timestamp();
    const scheduleNow = options.now ?? new Date();
    const nowIso = scheduleNow.toISOString();
    const upsert = this.database.prepare(
      [
        "insert into routines (",
        "project_name, name, source_path, kind, provider_name, model, effort, permission_mode, timeout_minutes, schedule_at, schedule_cron, schedule_tz, next_fire_at, prompt_body, state, disabled_reason, allow_overlap, catch_up, notify_enabled, created_at, updated_at",
        ") values (",
        "@project_name, @name, @source_path, @kind, @provider_name, @model, @effort, @permission_mode, @timeout_minutes, @schedule_at, @schedule_cron, @schedule_tz, @next_fire_at, @prompt_body,",
        "case when @disabled = 1 then 'disabled' else 'active' end,",
        "@disabled_reason, @allow_overlap, @catch_up, @notify_enabled, @created_at, @updated_at",
        ")",
        "on conflict(project_name, name) do update set",
        "source_path = excluded.source_path,",
        "kind = excluded.kind,",
        "provider_name = excluded.provider_name,",
        "model = excluded.model,",
        "effort = excluded.effort,",
        "permission_mode = excluded.permission_mode,",
        "timeout_minutes = excluded.timeout_minutes,",
        "allow_overlap = excluded.allow_overlap,",
        "catch_up = excluded.catch_up,",
        "notify_enabled = excluded.notify_enabled,",
        "schedule_at = excluded.schedule_at,",
        "schedule_cron = excluded.schedule_cron,",
        "schedule_tz = excluded.schedule_tz,",
        "next_fire_at = case",
        "when @recompute_recurring = 1 and excluded.schedule_cron is not null and excluded.catch_up = 'skip' then excluded.next_fire_at",
        "when routines.schedule_at is not excluded.schedule_at or routines.schedule_cron is not excluded.schedule_cron or routines.schedule_tz is not excluded.schedule_tz then excluded.next_fire_at",
        // Un-disabling (front matter disabled: true removed, or the routine's
        // path restored after removal) always recomputes from the current
        // tick's now — never resurrects a next_fire_at computed before the
        // routine was disabled. For cron this is always strictly future; for
        // an elapsed one-shot the state branch below routes to 'expired',
        // where next_fire_at is never read.
        "when (routines.state = 'disabled' or routines.state = 'inactive') and @disabled = 0 then excluded.next_fire_at",
        "when routines.next_fire_at is null and routines.state != 'expired' then excluded.next_fire_at",
        "else routines.next_fire_at end,",
        "prompt_body = excluded.prompt_body,",
        "last_fired_at = case",
        "when routines.schedule_at is not excluded.schedule_at or routines.schedule_cron is not excluded.schedule_cron or routines.schedule_tz is not excluded.schedule_tz then null",
        "else routines.last_fired_at end,",
        // Recurring schedules stay active; a rescheduled routine reactivates.
        // Otherwise an already-fired or previously-expired one-shot stays
        // expired — including an inactive one-shot restored on Project
        // re-enable, whose firing evidence must not re-fire (ADR-0021).
        // An operator-disabled routine (@disabled = 1) wins over every other
        // branch, even a schedule change made in the same edit.
        "state = case",
        "when @disabled = 1 then 'disabled'",
        "when excluded.schedule_cron is not null then 'active'",
        // Restoring a one-shot whose `at` already elapsed while disabled or
        // inactive must not fire it retroactively, even when its schedule was
        // edited while stopped. This precedes schedule-change reactivation so
        // only a future one-shot edit can reactivate a stopped Routine.
        "when (routines.state = 'disabled' or routines.state = 'inactive') and @disabled = 0 and excluded.schedule_cron is null and routines.last_fired_at is null and excluded.schedule_at <= @now_iso then 'expired'",
        "when routines.schedule_at is not excluded.schedule_at or routines.schedule_cron is not excluded.schedule_cron or routines.schedule_tz is not excluded.schedule_tz then 'active'",
        "when routines.state = 'expired' or routines.last_fired_at is not null then 'expired'",
        "else 'active' end,",
        "disabled_reason = excluded.disabled_reason,",
        "updated_at = excluded.updated_at"
      ].join(" ")
    );
    // Seed the per-project iteration set from BOTH the declared routines AND
    // `options.projects` — a project whose last routine was just removed has
    // zero routines but must still run removal-detection (its persisted rows
    // must be soft-disabled). See ADR 0069.
    const byProject = new Map<string, TargetedRoutineDeclaration[]>();
    for (const projectName of options.projects ?? []) {
      byProject.set(projectName, []);
    }
    for (const routine of routines) {
      const list = byProject.get(routine.projectName);
      if (list === undefined) {
        byProject.set(routine.projectName, [routine]);
      } else {
        list.push(routine);
      }
    }
    // Shared by trackerlessGitRoutinesByProject (ADR 0066) and
    // templateRejectedRoutinesByProject (ADR 0067 amendment): both categories
    // are declarations that parsed fine but are structurally incompatible
    // with something else in the current config (host tracker / resolved
    // provider template). Both get soft-disabled with a dedicated reason
    // instead of the generic removed_from_config, and both persist a
    // first-seen rejection so a later fix re-enters through the normal
    // upsert's restore rules rather than looking like a brand-new
    // declaration.
    const disableRejectedRoutines = (
      projectName: string,
      rejectedRoutines: TargetedRoutineDeclaration[],
      disabledReason:
        "rejected_tracker_less_host" | "rejected_provider_template_mismatch"
    ): void => {
      if (rejectedRoutines.length === 0) {
        return;
      }
      const rejectedNames = rejectedRoutines.map((routine) => routine.name);
      const placeholders = rejectedNames.map(() => "?").join(", ");
      this.database
        .prepare(
          `update routines set state = 'disabled', disabled_reason = '${disabledReason}', updated_at = ? where project_name = ? and name in (${placeholders}) and not (state = 'disabled' and disabled_reason = '${disabledReason}')`
        )
        .run(now, projectName, ...rejectedNames);
      // First-seen rejections have no row to demote — persist one so a
      // later fix re-enters through the normal upsert's restore rules. The
      // UPDATE above already demoted a real existing row, so the conflict
      // clause only replaces an identity-only invalid stub (empty
      // prompt_body) with the rejected declaration; previously valid
      // configuration stays untouched.
      for (const routine of rejectedRoutines) {
        const scheduleValues =
          "cron" in routine.schedule
            ? {
                nextFireAt: nextRecurringFireAt(routine.schedule, scheduleNow),
                scheduleAt: "",
                scheduleCron: routine.schedule.cron,
                scheduleTz: routine.schedule.tz
              }
            : {
                nextFireAt: routine.schedule.at,
                scheduleAt: routine.schedule.at,
                scheduleCron: null,
                scheduleTz: null
              };
        this.database
          .prepare(
            [
              "insert into routines (",
              "project_name, name, source_path, kind, provider_name, model, effort, permission_mode, timeout_minutes, schedule_at, schedule_cron, schedule_tz, next_fire_at, prompt_body, state, disabled_reason, allow_overlap, catch_up, created_at, updated_at",
              ") values (",
              `@project_name, @name, @source_path, @kind, @provider_name, @model, @effort, @permission_mode, @timeout_minutes, @schedule_at, @schedule_cron, @schedule_tz, @next_fire_at, @prompt_body, 'disabled', '${disabledReason}', @allow_overlap, @catch_up, @created_at, @updated_at`,
              ") on conflict(project_name, name) do update set",
              "source_path = excluded.source_path,",
              "kind = excluded.kind,",
              "provider_name = excluded.provider_name,",
              "model = excluded.model,",
              "effort = excluded.effort,",
              "permission_mode = excluded.permission_mode,",
              "timeout_minutes = excluded.timeout_minutes,",
              "schedule_at = excluded.schedule_at,",
              "schedule_cron = excluded.schedule_cron,",
              "schedule_tz = excluded.schedule_tz,",
              "next_fire_at = excluded.next_fire_at,",
              "prompt_body = excluded.prompt_body,",
              "state = excluded.state,",
              "disabled_reason = excluded.disabled_reason,",
              "allow_overlap = excluded.allow_overlap,",
              "catch_up = excluded.catch_up,",
              "updated_at = excluded.updated_at",
              "where routines.prompt_body = ''"
            ].join(" ")
          )
          .run({
            allow_overlap: routine.allowOverlap === true ? 1 : 0,
            catch_up: routine.catchUp ?? "skip",
            created_at: now,
            effort: routine.effort ?? null,
            kind: routine.kind,
            model: routine.model ?? null,
            name: routine.name,
            permission_mode: routine.permissionMode ?? null,
            project_name: routine.projectName,
            prompt_body: routine.prompt,
            provider_name: routine.provider,
            next_fire_at: scheduleValues.nextFireAt,
            schedule_at: scheduleValues.scheduleAt,
            schedule_cron: scheduleValues.scheduleCron,
            schedule_tz: scheduleValues.scheduleTz,
            source_path: routine.sourcePath,
            timeout_minutes: routine.timeoutMinutes ?? null,
            updated_at: now
          });
      }
    };
    const apply = this.database.transaction(() => {
      for (const [projectName, projectRoutines] of byProject) {
        const declaredNames = projectRoutines.map((routine) => routine.name);
        const trackerlessGitRoutines =
          options.trackerlessGitRoutinesByProject?.[projectName] ?? [];
        const templateRejectedRoutines =
          options.templateRejectedRoutinesByProject?.[projectName] ?? [];
        const excludedNames = [
          ...new Set([
            ...declaredNames,
            ...(options.protectedNamesByProject?.[projectName] ?? []),
            ...trackerlessGitRoutines.map((routine) => routine.name),
            ...templateRejectedRoutines.map((routine) => routine.name)
          ])
        ];
        // Excludes only rows already disabled *for this same reason* — an
        // operator-disabled routine (disabled_reason='operator') whose path is
        // then also removed from config must be upgraded to
        // 'removed_from_config', not left with the stale prior reason.
        if (excludedNames.length === 0) {
          this.database
            .prepare(
              "update routines set state = 'disabled', disabled_reason = 'removed_from_config', updated_at = ? where project_name = ? and not (state = 'disabled' and disabled_reason = 'removed_from_config')"
            )
            .run(now, projectName);
        } else {
          const placeholders = excludedNames.map(() => "?").join(", ");
          this.database
            .prepare(
              `update routines set state = 'disabled', disabled_reason = 'removed_from_config', updated_at = ? where project_name = ? and name not in (${placeholders}) and not (state = 'disabled' and disabled_reason = 'removed_from_config')`
            )
            .run(now, projectName, ...excludedNames);
        }
        disableRejectedRoutines(
          projectName,
          trackerlessGitRoutines,
          "rejected_tracker_less_host"
        );
        disableRejectedRoutines(
          projectName,
          templateRejectedRoutines,
          "rejected_provider_template_mismatch"
        );
        for (const routine of projectRoutines) {
          const scheduleValues =
            "cron" in routine.schedule
              ? {
                  nextFireAt: nextRecurringFireAt(
                    routine.schedule,
                    scheduleNow
                  ),
                  scheduleAt: "",
                  scheduleCron: routine.schedule.cron,
                  scheduleTz: routine.schedule.tz
                }
              : {
                  nextFireAt: routine.schedule.at,
                  scheduleAt: routine.schedule.at,
                  scheduleCron: null,
                  scheduleTz: null
                };
          upsert.run({
            allow_overlap: routine.allowOverlap === true ? 1 : 0,
            catch_up: routine.catchUp ?? "skip",
            created_at: now,
            disabled: routine.disabled === true ? 1 : 0,
            disabled_reason: routine.disabled === true ? "operator" : null,
            effort: routine.effort ?? null,
            kind: routine.kind,
            model: routine.model ?? null,
            name: routine.name,
            notify_enabled: routine.notify === false ? 0 : 1,
            permission_mode: routine.permissionMode ?? null,
            project_name: routine.projectName,
            prompt_body: routine.prompt,
            provider_name: routine.provider,
            next_fire_at: scheduleValues.nextFireAt,
            now_iso: nowIso,
            recompute_recurring: options.recomputeRecurring === true ? 1 : 0,
            // Existing databases have a NOT NULL schedule_at column. An empty
            // legacy value identifies recurring rows; schedule_cron is canonical.
            schedule_at: scheduleValues.scheduleAt,
            schedule_cron: scheduleValues.scheduleCron,
            schedule_tz: scheduleValues.scheduleTz,
            source_path: routine.sourcePath,
            timeout_minutes: routine.timeoutMinutes ?? null,
            updated_at: now
          });
        }
      }
    });
    apply();
  }

  ensureRoutineFanout(input: {
    id: string;
    projectNames: string[];
    routineName: string;
    scheduledAt: string;
  }): { created: boolean; id: string } {
    const now = timestamp();
    const ensure = this.database.transaction(() => {
      const inserted = this.database
        .prepare(
          [
            "insert into routine_fanouts (",
            "id, routine_name, scheduled_at, notification_state, created_at, updated_at",
            ") values (?, ?, ?, 'pending', ?, ?)",
            "on conflict(routine_name, scheduled_at) do nothing"
          ].join(" ")
        )
        .run(input.id, input.routineName, input.scheduledAt, now, now);
      const row = this.database
        .prepare(
          [
            "select id from routine_fanouts",
            "where routine_name = ? and scheduled_at = ?"
          ].join(" ")
        )
        .get(input.routineName, input.scheduledAt) as
        { id: string } | undefined;
      if (row === undefined) {
        throw new Error("routine fan-out identity could not be persisted");
      }
      const insertTarget = this.database.prepare(
        [
          "insert into routine_fanout_targets (",
          "fanout_id, project_name, disposition, created_at, updated_at",
          ") values (?, ?, 'pending', ?, ?)",
          "on conflict(fanout_id, project_name) do nothing"
        ].join(" ")
      );
      // Expected membership belongs to the clock event snapshot that creates
      // the fan-out. A later reload may introduce another due one-shot target
      // with the same scheduled_at, but extending this existing row would
      // mutate the group after work began and could require a second summary.
      if (inserted.changes > 0) {
        for (const projectName of input.projectNames) {
          insertTarget.run(row.id, projectName, now, now);
        }
      }
      return { created: inserted.changes > 0, id: row.id };
    });
    return ensure();
  }

  hasRoutineFanoutTarget(input: { id: string; projectName: string }): boolean {
    return (
      this.database
        .prepare(
          "select 1 from routine_fanout_targets where fanout_id = ? and project_name = ?"
        )
        .get(input.id, input.projectName) !== undefined
    );
  }

  getRoutineFanout(id: string): RoutineFanoutStatus | undefined {
    const row = this.database
      .prepare(
        [
          "select id, routine_name, scheduled_at, notification_state,",
          "notification_error, notified_at, created_at, updated_at",
          "from routine_fanouts where id = ?"
        ].join(" ")
      )
      .get(id) as RoutineFanoutRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const targets = this.database
      .prepare(
        [
          "select fanout_id, project_name, disposition, firing_id, hold_reason, skip_reason",
          "from routine_fanout_targets where fanout_id = ?",
          "order by project_name asc"
        ].join(" ")
      )
      .all(id) as RoutineFanoutTargetRow[];
    const mappedTargets = targets.map((target) => ({
      disposition: target.disposition,
      firing:
        target.firing_id === null
          ? null
          : (this.getRoutineFiring(target.firing_id) ?? null),
      firingId: target.firing_id,
      holdReason: target.hold_reason,
      projectName: target.project_name,
      skipReason: target.skip_reason
    }));
    const pullRequestCount = mappedTargets.reduce(
      (count, target) => count + (target.firing?.pullRequests.length ?? 0),
      0
    );
    const failureCount = mappedTargets.filter(
      (target) =>
        target.disposition === "held" ||
        target.firing?.state === "failed" ||
        target.firing?.state === "cancelled"
    ).length;
    const issueCount = 0;
    return {
      createdAt: row.created_at,
      failureCount,
      id: row.id,
      issueCount,
      notificationError: row.notification_error,
      notificationState: row.notification_state,
      notifiedAt: row.notified_at,
      pullRequestCount,
      routineName: row.routine_name,
      scheduledAt: row.scheduled_at,
      subject: `[ptt] ${row.routine_name} — ${pullRequestCount} PR, ${issueCount} issue, ${failureCount} failed`,
      targets: mappedTargets,
      updatedAt: row.updated_at
    };
  }

  listReadyRoutineFanouts(): RoutineFanoutStatus[] {
    // `held` is deliberately absent from the outstanding predicate: ADR
    // 0084 makes provider admission failures summary-terminal while leaving
    // their clock events claimable.
    const rows = this.database
      .prepare(
        [
          "select f.id",
          "from routine_fanouts f",
          "where f.notification_state = 'pending'",
          "and not exists (",
          "select 1 from routine_fanout_targets t",
          "left join routine_firings rf on rf.id = t.firing_id",
          "where t.fanout_id = f.id",
          "and (t.disposition = 'pending'",
          "or (t.disposition = 'firing' and (rf.id is null or rf.state not in ('succeeded', 'failed', 'cancelled'))))",
          ")",
          "order by f.created_at asc, f.id asc"
        ].join(" ")
      )
      .all() as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const fanout = this.getRoutineFanout(row.id);
      return fanout === undefined ? [] : [fanout];
    });
  }

  // A target can be inserted by a re-entrant reload (ADR 0052) between
  // listReadyRoutineFanouts()'s snapshot and this claim. Rechecking
  // readiness here, atomically with the state flip, stops the claim from
  // starting a send for a fan-out that just gained an outstanding target.
  private routineFanoutHasOutstandingTargets(id: string): boolean {
    return (
      this.database
        .prepare(
          [
            "select 1 from routine_fanout_targets t",
            "left join routine_firings rf on rf.id = t.firing_id",
            "where t.fanout_id = ?",
            "and (t.disposition = 'pending'",
            "or (t.disposition = 'firing' and (rf.id is null or rf.state not in ('succeeded', 'failed', 'cancelled'))))"
          ].join(" ")
        )
        .get(id) !== undefined
    );
  }

  claimRoutineFanoutNotification(id: string): boolean {
    const claim = this.database.transaction(() => {
      if (this.routineFanoutHasOutstandingTargets(id)) {
        return false;
      }
      const result = this.database
        .prepare(
          [
            "update routine_fanouts set notification_state = 'sending',",
            "notification_error = null, updated_at = ?",
            "where id = ? and notification_state = 'pending'"
          ].join(" ")
        )
        .run(timestamp(), id);
      return result.changes > 0;
    });
    return claim();
  }

  completeRoutineFanoutNotification(
    input:
      { error: string; id: string } | { id: string; state: "sent" | "skipped" }
  ): void {
    const now = timestamp();
    if ("error" in input) {
      this.database
        .prepare(
          [
            "update routine_fanouts set notification_state = 'pending',",
            "notification_error = ?, updated_at = ?",
            "where id = ? and notification_state = 'sending'"
          ].join(" ")
        )
        .run(input.error, now, input.id);
      return;
    }
    if (input.state === "sent") {
      this.database
        .prepare(
          [
            "update routine_fanouts set notification_state = 'sent',",
            "notification_error = null, notified_at = ?, updated_at = ?",
            "where id = ? and notification_state = 'sending'"
          ].join(" ")
        )
        .run(now, now, input.id);
      return;
    }
    this.database
      .prepare(
        [
          "update routine_fanouts set notification_state = 'skipped',",
          "notification_error = null, updated_at = ?",
          "where id = ? and notification_state = 'sending'"
        ].join(" ")
      )
      .run(now, input.id);
  }

  releaseInterruptedRoutineFanoutNotifications(): number {
    const result = this.database
      .prepare(
        [
          "update routine_fanouts set notification_state = 'pending',",
          "notification_error = 'delivery interrupted by daemon restart',",
          "updated_at = ? where notification_state = 'sending'"
        ].join(" ")
      )
      .run(timestamp());
    return result.changes;
  }

  holdRoutineFanoutTarget(input: {
    fanoutId: string;
    projectName: string;
    reason: RoutineFanoutHoldReason;
  }): boolean {
    // Repeated daemon ticks refresh the durable reason without touching the
    // Routine Target's due clock or skip evidence. A racing claim/skip wins
    // by moving the leg out of the accepted dispositions.
    const result = this.database
      .prepare(
        [
          "update routine_fanout_targets",
          "set disposition = 'held', hold_reason = ?, skip_reason = null, updated_at = ?",
          "where fanout_id = ? and project_name = ?",
          "and disposition in ('pending', 'held')"
        ].join(" ")
      )
      .run(input.reason, timestamp(), input.fanoutId, input.projectName);
    return result.changes > 0;
  }

  settleUnavailableRoutineFanoutTargets(): number {
    const result = this.database
      .prepare(
        [
          "update routine_fanout_targets",
          "set disposition = 'skipped', hold_reason = null, skip_reason = 'target_unavailable', updated_at = ?",
          "where disposition in ('pending', 'held')",
          "and not exists (",
          "select 1 from routine_fanouts f",
          "join routines r on r.name = f.routine_name",
          "and r.project_name = routine_fanout_targets.project_name",
          "where f.id = routine_fanout_targets.fanout_id",
          "and r.state = 'active'",
          "and r.next_fire_at = f.scheduled_at",
          ")"
        ].join(" ")
      )
      .run(timestamp());
    return result.changes;
  }

  markRoutinesInactiveForProject(
    projectName: string,
    options: {
      now?: Date;
      trackerlessGitRoutines?: TargetedRoutineDeclaration[];
      templateRejectedRoutines?: TargetedRoutineDeclaration[];
    } = {}
  ): void {
    const now = timestamp();
    const scheduleNow = options.now ?? new Date();
    const insertInactive = this.database.prepare(
      [
        "insert into routines (",
        "project_name, name, source_path, kind, provider_name, model, effort, permission_mode, timeout_minutes, schedule_at, schedule_cron, schedule_tz, next_fire_at, prompt_body, state, allow_overlap, catch_up, created_at, updated_at",
        ") values (",
        "@project_name, @name, @source_path, @kind, @provider_name, @model, @effort, @permission_mode, @timeout_minutes, @schedule_at, @schedule_cron, @schedule_tz, @next_fire_at, @prompt_body, 'inactive', @allow_overlap, @catch_up, @created_at, @updated_at",
        ") on conflict(project_name, name) do update set",
        "source_path = excluded.source_path,",
        "kind = excluded.kind,",
        "provider_name = excluded.provider_name,",
        "model = excluded.model,",
        "effort = excluded.effort,",
        "permission_mode = excluded.permission_mode,",
        "timeout_minutes = excluded.timeout_minutes,",
        "schedule_at = excluded.schedule_at,",
        "schedule_cron = excluded.schedule_cron,",
        "schedule_tz = excluded.schedule_tz,",
        "next_fire_at = excluded.next_fire_at,",
        "prompt_body = excluded.prompt_body,",
        "state = excluded.state,",
        "disabled_reason = excluded.disabled_reason,",
        "allow_overlap = excluded.allow_overlap,",
        "catch_up = excluded.catch_up,",
        "updated_at = excluded.updated_at",
        "where routines.prompt_body = ''"
      ].join(" ")
    );
    const apply = this.database.transaction(() => {
      // A disabled Project still needs identity and schedule evidence for a
      // first-seen tracker-less kind: git rejection or a first-seen provider-
      // template rejection. Without this inactive row, simultaneously
      // restoring the Project and the underlying rejection cause after `at`
      // elapsed would look like a brand-new active declaration and fire
      // retroactively. Only an identity-only invalid stub is reclaimed on
      // conflict; previously valid rows stay intact until the cascade below.
      for (const routine of [
        ...(options.trackerlessGitRoutines ?? []),
        ...(options.templateRejectedRoutines ?? [])
      ]) {
        const scheduleValues =
          "cron" in routine.schedule
            ? {
                nextFireAt: nextRecurringFireAt(routine.schedule, scheduleNow),
                scheduleAt: "",
                scheduleCron: routine.schedule.cron,
                scheduleTz: routine.schedule.tz
              }
            : {
                nextFireAt: routine.schedule.at,
                scheduleAt: routine.schedule.at,
                scheduleCron: null,
                scheduleTz: null
              };
        insertInactive.run({
          allow_overlap: routine.allowOverlap === true ? 1 : 0,
          catch_up: routine.catchUp ?? "skip",
          created_at: now,
          effort: routine.effort ?? null,
          kind: routine.kind,
          model: routine.model ?? null,
          name: routine.name,
          permission_mode: routine.permissionMode ?? null,
          project_name: projectName,
          prompt_body: routine.prompt,
          provider_name: routine.provider,
          next_fire_at: scheduleValues.nextFireAt,
          schedule_at: scheduleValues.scheduleAt,
          schedule_cron: scheduleValues.scheduleCron,
          schedule_tz: scheduleValues.scheduleTz,
          source_path: routine.sourcePath,
          timeout_minutes: routine.timeoutMinutes ?? null,
          updated_at: now
        });
      }
      this.database
        .prepare(
          // disabled_reason only means anything on state = 'disabled' — clear
          // it here so an inactive row never surfaces a stale routine-level
          // reason left over from before the Project-cascade (ADR-0060).
          "update routines set state = 'inactive', disabled_reason = null, updated_at = ? where project_name = ? and (state != 'inactive' or disabled_reason is not null)"
        )
        .run(now, projectName);
    });
    apply();
  }

  // Persists identity-only evidence for a routine declaration that has never
  // had a valid snapshot (a brand-new file with a parseable name but invalid
  // front matter elsewhere). kind/schedule_at/prompt_body are unreadable
  // sentinels — evaluateRoutineSchedule (src/routines/schedule.ts) never
  // fires a non-'active' row, so these values are never read as real config.
  // A validly-configured routine always has a non-empty prompt_body, so
  // prompt_body = '' reliably identifies a row that has never been anything
  // but this stub. On conflict, reclaim such a row back to 'invalid' (it may
  // have gone dormant as 'disabled'/'inactive' via a Project-cascade or
  // removal-from-config while still broken) but never touch a row that has
  // ever held a real declaration.
  upsertInvalidRoutineStub(input: {
    name: string;
    projectName: string;
    sourcePath: string;
  }): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "insert into routines (",
          "project_name, name, source_path, kind, schedule_at, prompt_body, state, created_at, updated_at",
          ") values (",
          "@project_name, @name, @source_path, 'report', '', '', 'invalid', @created_at, @updated_at",
          ")",
          "on conflict(project_name, name) do update set",
          "source_path = excluded.source_path,",
          "state = 'invalid',",
          "disabled_reason = null,",
          "updated_at = excluded.updated_at",
          "where routines.prompt_body = ''"
        ].join(" ")
      )
      .run({
        created_at: now,
        name: input.name,
        project_name: input.projectName,
        source_path: input.sourcePath,
        updated_at: now
      });
  }

  pruneRoutinesForUnknownProjects(projectNames: Iterable<string>): void {
    const now = timestamp();
    const names = [...new Set(projectNames)];
    // disabled_reason only means anything on state = 'disabled' — clear it
    // here so an inactive row never surfaces a stale routine-level reason
    // left over from before the Project-cascade (ADR-0060).
    if (names.length === 0) {
      this.database
        .prepare(
          "update routines set state = 'inactive', disabled_reason = null, updated_at = ? where state != 'inactive'"
        )
        .run(now);
      return;
    }
    const placeholders = names.map(() => "?").join(", ");
    this.database
      .prepare(
        `update routines set state = 'inactive', disabled_reason = null, updated_at = ? where project_name not in (${placeholders}) and state != 'inactive'`
      )
      .run(now, ...names);
  }

  listRoutines(
    filter: { includeInactive?: boolean; now?: Date; project?: string } = {}
  ): RoutineStatus[] {
    const conditions: string[] =
      filter.includeInactive === true ? [] : ["state != 'inactive'"];
    const params: Record<string, unknown> = {};
    if (filter.project !== undefined) {
      conditions.push("project_name = @project");
      params.project = filter.project;
    }
    const where =
      conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
    const rows = this.database
      .prepare(
        [
          "select project_name, name, source_path, kind, provider_name, model, effort, permission_mode, timeout_minutes, schedule_at, schedule_cron, schedule_tz, next_fire_at, state, disabled_reason, allow_overlap, catch_up, notify_enabled, last_fired_at, last_attempted_at, last_skip_reason, last_skip_at, created_at, updated_at",
          "from routines",
          where,
          "order by project_name asc, name asc"
        ]
          .filter((part) => part.length > 0)
          .join(" ")
      )
      .all(params) as RoutineRow[];
    const countsNow = filter.now ?? new Date();
    return rows.map((row) => ({
      ...mapRoutineRow(row),
      latestOutcome: this.latestRoutineOutcome(row.project_name, row.name),
      pullRequestNumbers: this.latestRoutinePullRequestNumbers(
        row.project_name,
        row.name
      ),
      skipCounts24h: this.routineSkipCounts24h(
        row.project_name,
        row.name,
        countsNow
      )
    }));
  }

  private routineSkipCounts24h(
    projectName: string,
    routineName: string,
    now: Date
  ): Record<RoutineSkipReason, number> {
    const counts: Record<RoutineSkipReason, number> = {
      catch_up_window: 0,
      concurrency_cap: 0,
      overlap: 0
    };
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const rows = this.database
      .prepare(
        [
          "select reason, sum(count) as count from routine_skip_counts",
          "where project_name = ? and routine_name = ?",
          "and skipped_at >= ? and skipped_at <= ? group by reason"
        ].join(" ")
      )
      .all(projectName, routineName, cutoff, now.toISOString()) as Array<{
      count: number;
      reason: RoutineSkipReason;
    }>;
    for (const row of rows) {
      counts[row.reason] = row.count;
    }
    return counts;
  }

  getRoutine(input: {
    name: string;
    projectName: string;
  }): (RoutineStatus & { prompt: string }) | undefined {
    const row = this.database
      .prepare(
        [
          "select project_name, name, source_path, kind, provider_name, model, effort, permission_mode, timeout_minutes, schedule_at, schedule_cron, schedule_tz, next_fire_at, state, disabled_reason, allow_overlap, catch_up, notify_enabled, last_fired_at, last_attempted_at, last_skip_reason, last_skip_at, created_at, updated_at, prompt_body",
          "from routines where project_name = ? and name = ? and state != 'inactive'"
        ].join(" ")
      )
      .get(input.projectName, input.name) as
      (RoutineRow & { prompt_body: string }) | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      ...mapRoutineRow(row),
      latestOutcome: this.latestRoutineOutcome(row.project_name, row.name),
      pullRequestNumbers: this.latestRoutinePullRequestNumbers(
        row.project_name,
        row.name
      ),
      skipCounts24h: this.routineSkipCounts24h(
        row.project_name,
        row.name,
        new Date()
      ),
      prompt: row.prompt_body
    };
  }

  hasActiveRoutineFiring(input: {
    name: string;
    projectName: string;
  }): boolean {
    const row = this.database
      .prepare(
        [
          "select 1 from routine_firings",
          "where project_name = ? and routine_name = ?",
          "and state in ('queued', 'preparing_workspace', 'running')",
          "limit 1"
        ].join(" ")
      )
      .get(input.projectName, input.name);
    return row !== undefined;
  }

  private latestRoutineOutcome(
    projectName: string,
    routineName: string
  ): RoutineOutcome | null {
    const row = this.database
      .prepare(
        [
          "select outcome_status, outcome_action, outcome_url, outcome_title, outcome_summary, outcome_verified, outcome_source",
          "from routine_firings where project_name = ? and routine_name = ?",
          "and outcome_status is not null",
          "order by created_at desc, id desc limit 1"
        ].join(" ")
      )
      .get(projectName, routineName) as RoutineOutcomeRow | undefined;
    return mapRoutineOutcomeRow(row);
  }

  skipRoutineFiring(input: {
    attemptedAt: string;
    fanoutId?: string;
    name: string;
    nextFireAt?: string;
    projectName: string;
    reason: RoutineSkipReason;
  }): boolean {
    const apply = this.database.transaction(() => {
      const result = this.database
        .prepare(
          [
            "update routines set",
            "state = case when schedule_cron is null then 'expired' else 'active' end,",
            "next_fire_at = case when schedule_cron is null then null else coalesce(@next_fire_at, next_fire_at) end,",
            "last_attempted_at = @attempted_at,",
            "last_skip_reason = @reason,",
            "last_skip_at = @attempted_at,",
            "updated_at = @updated_at",
            "where project_name = @project_name and name = @name and state = 'active'",
            "and next_fire_at is not null and next_fire_at <= @attempted_at",
            "and (schedule_cron is null or @next_fire_at is not null)"
          ].join(" ")
        )
        .run({
          attempted_at: input.attemptedAt,
          name: input.name,
          next_fire_at: input.nextFireAt ?? null,
          project_name: input.projectName,
          reason: input.reason,
          updated_at: timestamp()
        });
      if (result.changes === 0) {
        return false;
      }
      if (input.fanoutId !== undefined) {
        // A repaired held leg may encounter an ordinary admission skip, so
        // it remains consumable by the same atomic clock-advance path as a
        // newly evaluated pending leg (ADR 0084).
        const target = this.database
          .prepare(
            [
              "update routine_fanout_targets set",
              "disposition = 'skipped', hold_reason = null, skip_reason = ?, updated_at = ?",
              "where fanout_id = ? and project_name = ? and disposition in ('pending', 'held')"
            ].join(" ")
          )
          .run(input.reason, timestamp(), input.fanoutId, input.projectName);
        if (target.changes === 0) {
          throw new RoutineAlreadyClaimedError();
        }
      }
      this.database
        .prepare(
          [
            "insert into routine_skip_counts (project_name, routine_name, reason, skipped_at, count)",
            "values (@project_name, @routine_name, @reason, @skipped_at, 1)",
            "on conflict(project_name, routine_name, reason, skipped_at)",
            "do update set count = count + 1"
          ].join(" ")
        )
        .run({
          project_name: input.projectName,
          reason: input.reason,
          routine_name: input.name,
          skipped_at: input.attemptedAt
        });
      return true;
    });
    return apply();
  }

  markRoutineExpired(input: {
    firedAt: string;
    name: string;
    projectName: string;
  }): boolean {
    const result = this.database
      .prepare(
        [
          "update routines set",
          "state = 'expired',",
          "last_fired_at = ?,",
          "updated_at = ?",
          "where project_name = ? and name = ? and state = 'active'"
        ].join(" ")
      )
      .run(input.firedAt, timestamp(), input.projectName, input.name);
    return result.changes > 0;
  }

  createRoutineFiring(input: CreateRoutineFiringInput): void {
    this.publishChange(this.insertRoutineFiring(input));
  }

  private insertRoutineFiring(
    input: CreateRoutineFiringInput
  ): FiringTransitionChangeEvent {
    const now = timestamp();
    const kind =
      input.kind ?? this.routineKind(input.projectName, input.routineName);
    if (kind === undefined) {
      throw new Error(
        `cannot create firing ${input.id}: routine kind is unavailable`
      );
    }
    this.database
      .prepare(
        [
          "insert into routine_firings (",
          "id, fanout_id, project_name, routine_name, kind, state, provider_name, provider_command, trigger_source, scheduled_at, workspace_path, branch_name, branch_ref, created_at, updated_at",
          ") values (",
          "@id, @fanout_id, @project_name, @routine_name, @kind, 'queued', @provider_name, @provider_command, @trigger_source, @scheduled_at, @workspace_path, @branch_name, @branch_ref, @created_at, @updated_at",
          ")"
        ].join(" ")
      )
      .run({
        branch_name: input.branchName ?? null,
        branch_ref: input.branchRef ?? null,
        created_at: now,
        fanout_id: input.fanoutId ?? null,
        id: input.id,
        kind,
        project_name: input.projectName,
        provider_command: input.providerCommand,
        provider_name: input.providerName,
        routine_name: input.routineName,
        scheduled_at: input.scheduledAt ?? "",
        trigger_source: input.triggerSource ?? "scheduled",
        updated_at: now,
        workspace_path: input.workspacePath ?? null
      });
    return this.insertRoutineFiringTransition(input.id, "queued", now);
  }

  claimRoutineFiring(input: {
    branchName?: string;
    branchRef?: string;
    fanoutId?: string;
    firedAt: string;
    firingId: string;
    kind?: RoutineKind;
    nextFireAt?: string;
    projectName: string;
    providerCommand: string;
    providerName: AgentProviderName;
    routineName: string;
    scheduledAt: string;
    triggerSource?: RoutineFiringTriggerSource;
    workspacePath?: string;
  }): boolean {
    const claim = this.database.transaction(() => {
      const event = this.insertRoutineFiring({
        ...(input.branchName === undefined
          ? {}
          : { branchName: input.branchName }),
        ...(input.branchRef === undefined
          ? {}
          : { branchRef: input.branchRef }),
        ...(input.fanoutId === undefined ? {} : { fanoutId: input.fanoutId }),
        id: input.firingId,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        projectName: input.projectName,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        routineName: input.routineName,
        scheduledAt: input.scheduledAt,
        ...(input.triggerSource === undefined
          ? {}
          : { triggerSource: input.triggerSource }),
        ...(input.workspacePath === undefined
          ? {}
          : { workspacePath: input.workspacePath })
      });
      const result = this.database
        .prepare(
          [
            "update routines set",
            "state = case when schedule_cron is null then 'expired' else 'active' end,",
            "next_fire_at = case when schedule_cron is null then null else @next_fire_at end,",
            "last_fired_at = @fired_at,",
            "last_attempted_at = @fired_at,",
            "updated_at = @updated_at",
            "where project_name = @project_name and name = @routine_name and state = 'active'",
            "and next_fire_at is not null and next_fire_at <= @fired_at",
            "and (schedule_cron is null or @next_fire_at is not null)"
          ].join(" ")
        )
        .run({
          fired_at: input.firedAt,
          next_fire_at: input.nextFireAt ?? null,
          project_name: input.projectName,
          routine_name: input.routineName,
          updated_at: timestamp()
        });
      if (result.changes === 0) {
        throw new RoutineAlreadyClaimedError();
      }
      if (input.fanoutId !== undefined) {
        // A held leg remains schedule-claimable after its one-shot summary,
        // so provider repair uses the same atomic claim path as a newly
        // evaluated pending leg (ADR 0084).
        const target = this.database
          .prepare(
            [
              "update routine_fanout_targets set",
              "disposition = 'firing', firing_id = ?, hold_reason = null, skip_reason = null, updated_at = ?",
              "where fanout_id = ? and project_name = ? and disposition in ('pending', 'held')"
            ].join(" ")
          )
          .run(input.firingId, timestamp(), input.fanoutId, input.projectName);
        if (target.changes === 0) {
          throw new RoutineAlreadyClaimedError();
        }
      }
      return event;
    });
    try {
      const event = claim();
      this.publishChange(event);
      return true;
    } catch (error) {
      if (error instanceof RoutineAlreadyClaimedError) {
        return false;
      }
      throw error;
    }
  }

  claimManualRoutineFiring(input: {
    branchName?: string;
    branchRef?: string;
    firingId: string;
    forceOperatorDisabled?: boolean;
    kind?: RoutineKind;
    projectName: string;
    providerCommand: string;
    providerName: AgentProviderName;
    routineName: string;
    workspacePath?: string;
  }): boolean {
    const claim = this.database.transaction(() => {
      const eligible = this.database
        .prepare(
          [
            "select 1 from routines",
            "where project_name = @project_name and name = @routine_name",
            "and (state = 'active'",
            "or (@force_operator_disabled = 1 and state = 'disabled' and disabled_reason = 'operator'))"
          ].join(" ")
        )
        .get({
          force_operator_disabled: input.forceOperatorDisabled === true ? 1 : 0,
          project_name: input.projectName,
          routine_name: input.routineName
        });
      if (eligible === undefined) {
        throw new RoutineAlreadyClaimedError();
      }
      return this.insertRoutineFiring({
        ...(input.branchName === undefined
          ? {}
          : { branchName: input.branchName }),
        ...(input.branchRef === undefined
          ? {}
          : { branchRef: input.branchRef }),
        id: input.firingId,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        projectName: input.projectName,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        routineName: input.routineName,
        scheduledAt: null,
        triggerSource: "manual",
        ...(input.workspacePath === undefined
          ? {}
          : { workspacePath: input.workspacePath })
      });
    });
    try {
      const event = claim();
      this.publishChange(event);
      return true;
    } catch (error) {
      if (error instanceof RoutineAlreadyClaimedError) {
        return false;
      }
      throw error;
    }
  }

  updateRoutineFiringState(id: string, state: RoutineFiringState): void {
    const now = timestamp();
    this.database
      .prepare(
        "update routine_firings set state = ?, updated_at = ? where id = ?"
      )
      .run(state, now, id);
    this.recordRoutineFiringTransition(id, state, now);
  }

  completeRoutineFiring(input: {
    cancelReason?: CancelReason;
    commitsAhead?: boolean;
    id: string;
    outcome?: RoutineOutcome;
    state: Extract<RoutineFiringState, "succeeded" | "failed" | "cancelled">;
    terminalReason?: string | null;
    workspacePath?: string;
  }): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "update routine_firings set",
          "state = @state,",
          "terminal_reason = @terminal_reason,",
          "outcome_status = @outcome_status,",
          "outcome_action = @outcome_action,",
          "outcome_url = @outcome_url,",
          "outcome_title = @outcome_title,",
          "outcome_summary = @outcome_summary,",
          "outcome_verified = @outcome_verified,",
          "outcome_source = @outcome_source,",
          "commits_ahead = case",
          "when @commits_ahead is not null then @commits_ahead",
          "when @outcome_action = 'commit' and @outcome_verified = 1 then 1",
          "else commits_ahead end,",
          "cancel_reason = case when cancel_reason = @shutdown_preemptive then cancel_reason else coalesce(@cancel_reason, cancel_reason) end,",
          "workspace_path = coalesce(@workspace_path, workspace_path),",
          "updated_at = @updated_at",
          "where id = @id"
        ].join(" ")
      )
      .run({
        cancel_reason: input.cancelReason ?? null,
        commits_ahead:
          input.commitsAhead === undefined ? null : Number(input.commitsAhead),
        shutdown_preemptive: SHUTDOWN_PREEMPTIVE_REASON,
        id: input.id,
        outcome_action: input.outcome?.action ?? null,
        outcome_source: input.outcome?.source ?? null,
        outcome_status: input.outcome?.status ?? null,
        outcome_summary: input.outcome?.summary ?? null,
        outcome_title: input.outcome?.title ?? null,
        outcome_url: input.outcome?.url ?? null,
        outcome_verified:
          input.outcome === undefined ? null : Number(input.outcome.verified),
        state: input.state,
        terminal_reason: input.terminalReason ?? null,
        updated_at: now,
        workspace_path: input.workspacePath ?? null
      });
    this.recordRoutineFiringTransition(input.id, input.state, now);
  }

  getRoutineFiring(id: string): RoutineFiringStatus | undefined {
    const row = this.database
      .prepare(
        [
          "select id, fanout_id, project_name, routine_name, kind, state, provider_name, provider_command, trigger_source, scheduled_at, workspace_path, workspace_pruned_at, branch_name, branch_ref, terminal_reason, commits_ahead, outcome_status, outcome_action, outcome_url, outcome_title, outcome_summary, outcome_verified, outcome_source, notification_state, notification_error, cancel_requested, cancel_reason, created_at, updated_at",
          "from routine_firings where id = ?"
        ].join(" ")
      )
      .get(id) as RoutineFiringRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      ...mapRoutineFiringRow(row),
      pullRequests: this.listRoutinePullRequests({ firingId: row.id })
    };
  }

  recordRoutineFiringNotification(input: {
    error?: string | null;
    id: string;
    state: RoutineNotificationState;
  }): void {
    this.database
      .prepare(
        "update routine_firings set notification_state = ?, notification_error = ?, updated_at = ? where id = ?"
      )
      .run(input.state, input.error ?? null, timestamp(), input.id);
  }

  markRoutineFiringCancelRequested(
    firingId: string,
    reason: CancelReason
  ): void {
    this.database
      .prepare(
        "update routine_firings set cancel_requested = 1, cancel_reason = case when cancel_reason = ? then cancel_reason else ? end, updated_at = ? where id = ?"
      )
      .run(SHUTDOWN_PREEMPTIVE_REASON, reason, timestamp(), firingId);
  }

  updateRoutineFiringWorkspace(input: {
    branchName?: string;
    branchRef?: string;
    id: string;
    normalizedLogPath?: string;
    promptPath?: string;
    rawLogPath?: string;
    workspacePath: string;
  }): void {
    this.database
      .prepare(
        [
          "update routine_firings set",
          "workspace_path = @workspace_path,",
          "branch_name = coalesce(@branch_name, branch_name),",
          "branch_ref = coalesce(@branch_ref, branch_ref),",
          "prompt_path = coalesce(@prompt_path, prompt_path),",
          "raw_log_path = coalesce(@raw_log_path, raw_log_path),",
          "normalized_log_path = coalesce(@normalized_log_path, normalized_log_path),",
          "updated_at = @updated_at",
          "where id = @id"
        ].join(" ")
      )
      .run({
        branch_name: input.branchName ?? null,
        branch_ref: input.branchRef ?? null,
        id: input.id,
        normalized_log_path: input.normalizedLogPath ?? null,
        prompt_path: input.promptPath ?? null,
        raw_log_path: input.rawLogPath ?? null,
        updated_at: timestamp(),
        workspace_path: input.workspacePath
      });
  }

  listRoutineFirings(
    filter: {
      limit?: number;
      project?: string;
      routineName?: string;
      state?: RoutineFiringState | RoutineFiringState[];
    } = {}
  ): RoutineFiringStatus[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    pushStateCondition(conditions, params, filter.state);
    if (filter.project !== undefined) {
      conditions.push("project_name = @project");
      params.project = filter.project;
    }
    if (filter.routineName !== undefined) {
      conditions.push("routine_name = @routine_name");
      params.routine_name = filter.routineName;
    }
    if (filter.limit !== undefined) {
      params.limit = Math.max(0, Math.floor(filter.limit));
    }
    const where =
      conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
    const limit = filter.limit === undefined ? "" : "limit @limit";
    const rows = this.database
      .prepare(
        [
          "select id, fanout_id, project_name, routine_name, kind, state, provider_name, provider_command, trigger_source, scheduled_at, workspace_path, workspace_pruned_at, branch_name, branch_ref, terminal_reason, commits_ahead, outcome_status, outcome_action, outcome_url, outcome_title, outcome_summary, outcome_verified, outcome_source, notification_state, notification_error, cancel_requested, cancel_reason, created_at, updated_at",
          "from routine_firings",
          where,
          "order by created_at desc, id desc",
          limit
        ]
          .filter((part) => part.length > 0)
          .join(" ")
      )
      .all(params) as RoutineFiringRow[];
    return rows.map((row) => ({
      ...mapRoutineFiringRow(row),
      pullRequests: this.listRoutinePullRequests({ firingId: row.id })
    }));
  }

  listRoutineTargetProjects(routineName: string): string[] {
    const rows = this.database
      .prepare(
        [
          "select project_name from routines where name = @routine_name",
          "union",
          "select project_name from routine_firings where routine_name = @routine_name",
          "order by project_name asc"
        ].join(" ")
      )
      .all({ routine_name: routineName }) as Array<{ project_name: string }>;
    return rows.map((row) => row.project_name);
  }

  listRoutineWorkspacePruneCandidates(input: {
    cancelledBefore: string;
    failedBefore: string;
    succeededBefore: string;
  }): RoutineFiringStatus[] {
    const rows = this.database
      .prepare(
        [
          "select id, fanout_id, project_name, routine_name, kind, state, provider_name, provider_command, trigger_source, scheduled_at, workspace_path, workspace_pruned_at, branch_name, branch_ref, terminal_reason, commits_ahead, outcome_status, outcome_action, outcome_url, outcome_title, outcome_summary, outcome_verified, outcome_source, notification_state, notification_error, cancel_requested, cancel_reason, created_at, updated_at",
          "from routine_firings",
          "where workspace_path is not null and workspace_path <> ''",
          "and workspace_pruned_at is null",
          // Canonical Routine Outcome and local commit evidence are independent:
          // a verified issue/PR action may legitimately win reconciliation while
          // the firing branch still contains the only copy of commits. Withhold
          // every commits-ahead firing until publication is separately verified.
          "and commits_ahead = 0",
          "and (",
          "(state = 'succeeded' and updated_at <= @succeeded_before)",
          "or (state = 'failed' and updated_at <= @failed_before)",
          "or (state = 'cancelled' and updated_at <= @cancelled_before)",
          ")",
          "order by updated_at asc, id asc"
        ].join(" ")
      )
      .all({
        cancelled_before: input.cancelledBefore,
        failed_before: input.failedBefore,
        succeeded_before: input.succeededBefore
      }) as RoutineFiringRow[];
    return rows.map((row) => ({
      ...mapRoutineFiringRow(row),
      pullRequests: this.listRoutinePullRequests({ firingId: row.id })
    }));
  }

  markRoutineWorkspacePruned(input: { id: string; prunedAt: string }): boolean {
    const result = this.database
      .prepare(
        [
          "update routine_firings set workspace_pruned_at = @pruned_at",
          "where id = @id and workspace_pruned_at is null",
          "and state in ('succeeded', 'failed', 'cancelled')"
        ].join(" ")
      )
      .run({ id: input.id, pruned_at: input.prunedAt });
    return result.changes > 0;
  }

  recordRoutinePullRequest(input: RoutinePullRequestStatus): void {
    this.database
      .prepare(
        [
          "insert into routine_pull_requests (",
          "project_name, routine_name, firing_id, pr_number, head_sha, created_at, updated_at",
          ") values (",
          "@project_name, @routine_name, @firing_id, @pr_number, @head_sha, @created_at, @updated_at",
          ")",
          "on conflict(project_name, routine_name, firing_id, pr_number) do update set",
          "head_sha = excluded.head_sha, updated_at = excluded.updated_at"
        ].join(" ")
      )
      .run({
        created_at: timestamp(),
        firing_id: input.firingId,
        head_sha: input.headSha,
        pr_number: input.prNumber,
        project_name: input.projectName,
        routine_name: input.routineName,
        updated_at: timestamp()
      });
  }

  listRoutinePullRequests(
    filter: {
      firingId?: string;
      project?: string;
      routineName?: string;
    } = {}
  ): RoutinePullRequestStatus[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.firingId !== undefined) {
      conditions.push("firing_id = @firing_id");
      params.firing_id = filter.firingId;
    }
    if (filter.project !== undefined) {
      conditions.push("project_name = @project");
      params.project = filter.project;
    }
    if (filter.routineName !== undefined) {
      conditions.push("routine_name = @routine_name");
      params.routine_name = filter.routineName;
    }
    const where =
      conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
    const rows = this.database
      .prepare(
        [
          "select project_name, routine_name, firing_id, pr_number, head_sha",
          "from routine_pull_requests",
          where,
          "order by pr_number asc"
        ]
          .filter((part) => part.length > 0)
          .join(" ")
      )
      .all(params) as RoutinePullRequestRow[];
    return rows.map(mapRoutinePullRequestRow);
  }

  listRoutineFiringTransitions(id: string): RoutineFiringStateTransition[] {
    const rows = this.database
      .prepare(
        "select sequence, state, created_at from routine_firing_state_transitions where firing_id = ? order by sequence asc"
      )
      .all(id) as Array<{
      created_at: string;
      sequence: number;
      state: RoutineFiringState;
    }>;
    return rows.map((row) => ({
      createdAt: row.created_at,
      sequence: row.sequence,
      state: row.state
    }));
  }

  getProjectStatesByName(): Map<string, ProjectState> {
    return new Map(
      this.listProjectStates().map((state) => [state.projectName, state])
    );
  }

  updateRunState(runId: string, state: RunState): void {
    const now = timestamp();
    const update = this.database.prepare(
      [
        "update runs set state = @state,",
        "notification_state = case",
        "when @state in ('succeeded', 'failed', 'blocked', 'cancelled', 'stale', 'input_required')",
        "and not (@state = 'failed' and failure_classification = 'transient')",
        "then 'pending' else notification_state end,",
        "notification_error = case",
        "when @state in ('succeeded', 'failed', 'blocked', 'cancelled', 'stale', 'input_required')",
        "and not (@state = 'failed' and failure_classification = 'transient')",
        "then null else notification_error end,",
        "watchdog_generation = watchdog_generation +",
        "case when @state = 'preparing_workspace' then 1 else 0 end,",
        "updated_at = @updated_at where id = @id"
      ].join(" ")
    );
    // The Run row and transition are one durable state change. If they commit
    // separately, later bookkeeping can overwrite updated_at and erase the
    // only recoverable timestamp for an interrupted terminal transition.
    const apply = this.database.transaction(() => {
      if (state === "preparing_workspace") {
        // A Run row is reused across transient retry attempts, while the
        // latest Watchdog sample and remembered turn IDs are keyed by run_id.
        // Advance the generation fence and clear those attempt-local values
        // before exposing the new attempt's preparing state. A sample captured
        // by the prior generation can then recreate neither current data nor a
        // stale verdict after its async I/O completes. Append-only sample history
        // remains durable evidence.
        this.database
          .prepare("delete from watchdog_samples where run_id = ?")
          .run(runId);
        this.database
          .prepare("delete from watchdog_turn_ids where run_id = ?")
          .run(runId);
      }
      update.run({ id: runId, state, updated_at: now });
      const event = this.insertRunTransition(runId, state, now);
      if (state === "waiting") {
        // ADR 0054: idle_since is a persisted wall-clock timestamp and the
        // watchdog never samples waiting Runs, so clear it on entry to waiting so
        // the grace window cannot absorb an unsampled wait excursion as idle time.
        // A Run returning to running starts its idle clock fresh on its next idle
        // tick rather than inheriting pre-wait idle time (see ADR 0047).
        this.database
          .prepare(
            "update watchdog_samples set idle_since = null where run_id = ?"
          )
          .run(runId);
      }
      return event;
    });
    this.publishChange(apply());
  }

  listPendingRunNotifications(): RunStatus[] {
    const rows = this.database
      .prepare(
        [
          "select id from runs",
          "where notification_state = 'pending'",
          "order by updated_at asc, id asc"
        ].join(" ")
      )
      .all() as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const run = this.getRun(row.id);
      return run === undefined ? [] : [run];
    });
  }

  markRunNotificationPending(runId: string): void {
    this.database
      .prepare(
        "update runs set notification_state = 'pending', notification_error = null where id = ?"
      )
      .run(runId);
  }

  claimRunNotifications(runIds: readonly string[]): boolean {
    if (runIds.length === 0) {
      return false;
    }
    const claimConflict = new Error("run notification claim conflict");
    const claim = this.database.transaction(() => {
      const update = this.database.prepare(
        "update runs set notification_state = 'sending', notification_error = null where id = ? and notification_state = 'pending'"
      );
      let claimed = 0;
      for (const runId of runIds) {
        claimed += update.run(runId).changes;
      }
      if (claimed !== runIds.length) {
        throw claimConflict;
      }
    });
    try {
      claim();
      return true;
    } catch (error) {
      if (error === claimConflict) {
        return false;
      }
      throw error;
    }
  }

  completeRunNotifications(input: {
    error?: string;
    runIds: readonly string[];
    state: Extract<RunNotificationState, "failed" | "sent" | "skipped">;
  }): void {
    if (input.runIds.length === 0) {
      return;
    }
    const complete = this.database.transaction(() => {
      const update = this.database.prepare(
        [
          "update runs set notification_state = ?, notification_error = ?",
          "where id = ? and notification_state in ('pending', 'sending')"
        ].join(" ")
      );
      for (const runId of input.runIds) {
        update.run(input.state, input.error ?? null, runId);
      }
    });
    complete();
  }

  releaseInterruptedRunNotifications(): number {
    return this.database
      .prepare(
        [
          "update runs set notification_state = 'pending',",
          "notification_error = 'delivery interrupted by daemon restart'",
          "where notification_state = 'sending'"
        ].join(" ")
      )
      .run().changes;
  }

  updateRunEvidence(runId: string, evidence: RunEvidenceInput): void {
    this.database
      .prepare(
        [
          "update runs set",
          "branch_name = @branch_name,",
          "branch_ref = @branch_ref,",
          "issue_snapshot_path = @issue_snapshot_path,",
          "metadata_path = @metadata_path,",
          "normalized_log_path = @normalized_log_path,",
          "prompt_path = @prompt_path,",
          "raw_log_path = @raw_log_path,",
          "workflow_graph_path = @workflow_graph_path,",
          "workspace_path = @workspace_path,",
          "updated_at = @updated_at",
          "where id = @id"
        ].join(" ")
      )
      .run({
        branch_name: evidence.branchName,
        branch_ref: evidence.branchRef,
        id: runId,
        issue_snapshot_path: evidence.issueSnapshotPath,
        metadata_path: evidence.metadataPath,
        normalized_log_path: evidence.normalizedLogPath,
        prompt_path: evidence.promptPath,
        raw_log_path: evidence.rawLogPath,
        updated_at: timestamp(),
        workflow_graph_path: evidence.workflowGraphPath,
        workspace_path: evidence.workspacePath
      });
  }

  createAttempt(input: CreateAttemptInput): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "insert into attempts (",
          "id, run_id, attempt_number, state, provider_name, provider_command,",
          "workspace_path, branch_name, prompt_path, metadata_path, issue_snapshot_path,",
          "raw_log_path, normalized_log_path, workflow_graph_path,",
          "created_at, updated_at",
          ") values (",
          "@id, @run_id, @attempt_number, @state, @provider_name, @provider_command,",
          "@workspace_path, @branch_name, @prompt_path, @metadata_path, @issue_snapshot_path,",
          "@raw_log_path, @normalized_log_path, @workflow_graph_path,",
          "@created_at, @updated_at",
          ")"
        ].join(" ")
      )
      .run({
        attempt_number: input.attemptNumber,
        branch_name: input.branchName,
        created_at: now,
        id: input.id,
        issue_snapshot_path: input.issueSnapshotPath,
        metadata_path: input.metadataPath,
        normalized_log_path: input.normalizedLogPath,
        prompt_path: input.promptPath,
        provider_command: input.providerCommand,
        provider_name: input.providerName,
        raw_log_path: input.rawLogPath,
        run_id: input.runId,
        state: input.state,
        updated_at: now,
        workflow_graph_path: input.workflowGraphPath,
        workspace_path: input.workspacePath
      });
  }

  updateAttemptState(attemptId: string, state: RunState): void {
    this.database
      .prepare("update attempts set state = ?, updated_at = ? where id = ?")
      .run(state, timestamp(), attemptId);
  }

  recordProviderEvent(input: ProviderEventMetadataInput): void {
    this.database
      .prepare(
        [
          "insert into provider_events (",
          "run_id, attempt_id, sequence, type, raw_json, normalized_json, created_at",
          ") values (",
          "@run_id, @attempt_id, @sequence, @type, @raw_json, @normalized_json, @created_at",
          ")"
        ].join(" ")
      )
      .run({
        attempt_id: input.attemptId,
        created_at: timestamp(),
        normalized_json: JSON.stringify(input.normalized),
        raw_json: JSON.stringify(input.raw),
        run_id: input.runId,
        sequence: input.sequence,
        type: input.normalized.type
      });
  }

  listRuns(filter?: ListRunsFilter): RunStatus[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    pushStateCondition(conditions, params, filter?.state);
    if (filter?.project !== undefined) {
      conditions.push("project_name = @project");
      params.project = filter.project;
    }
    if (filter?.issueNumber !== undefined) {
      conditions.push("issue_number = @issueNumber");
      params.issueNumber = filter.issueNumber;
    }
    const where =
      conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`;
    const limit =
      filter?.limit !== undefined
        ? `limit ${Math.max(0, Math.floor(filter.limit))}`
        : "";

    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, issue_title, state, provider_name,",
          "workspace_path, branch_name,",
          "current_state_id, terminal_state_id, state_transition_reason,",
          "is_continuation, continuation_parent_run_id, retry_count,",
          "failure_classification, terminal_reason, cancel_requested, cancel_reason,",
          "created_at, updated_at",
          "from runs",
          where,
          "order by created_at desc, id desc",
          limit
        ]
          .filter((part) => part.length > 0)
          .join(" ")
      )
      .all(params) as RunRow[];

    return rows.map((row) => mapRunRow(row));
  }

  findRunWorkspacePaths(runIds: readonly string[]): Map<string, string> {
    const ids = Array.from(new Set(runIds));
    if (ids.length === 0) {
      return new Map();
    }
    const placeholders = ids.map((_, index) => `@id${index}`);
    const params = Object.fromEntries(
      ids.map((id, index) => [`id${index}`, id])
    );
    const rows = this.database
      .prepare(
        [
          "select id, workspace_path from runs",
          `where id in (${placeholders.join(", ")})`,
          "and workspace_path is not null and workspace_path <> ''"
        ].join(" ")
      )
      .all(params) as Array<{ id: string; workspace_path: string }>;
    return new Map(rows.map((row) => [row.id, row.workspace_path]));
  }

  // One query for "each project's most recent run in one of `states`",
  // keyed by project name — the dashboard's Projects section wants this per
  // row, and a per-project listRuns(limit:1) call would be an N+1 query
  // against the number of configured Projects. lastTransitionAt comes from the
  // newest state transition, not `updated_at`, so post-terminal bookkeeping
  // (PR-discovery retries) cannot reset a Run's age.
  // insertRunRow always writes a first transition, so the coalesce fallback
  // covers imported rows without transition history and legacy process-exit
  // artifacts from before Run state and transition writes became atomic.
  listLatestRunsByProject(input: {
    projectNames: string[];
    states: RunState[];
  }): Map<string, ProjectLastRunStatus> {
    const result = new Map<string, ProjectLastRunStatus>();
    if (input.projectNames.length === 0 || input.states.length === 0) {
      return result;
    }
    const projectPlaceholders = input.projectNames.map(
      (_, index) => `@project${index}`
    );
    const statePlaceholders = input.states.map((_, index) => `@state${index}`);
    const params: Record<string, unknown> = {};
    input.projectNames.forEach((name, index) => {
      params[`project${index}`] = name;
    });
    input.states.forEach((state, index) => {
      params[`state${index}`] = state;
    });
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, issue_title, state, provider_name,",
          "workspace_path, branch_name,",
          "current_state_id, terminal_state_id, state_transition_reason,",
          "is_continuation, continuation_parent_run_id, retry_count,",
          "failure_classification, terminal_reason, cancel_requested, cancel_reason,",
          "created_at, updated_at,",
          "coalesce((select case when transition.state = ranked_runs.state",
          "  then transition.created_at end from run_state_transitions transition",
          "  where transition.run_id = ranked_runs.id",
          "  order by transition.sequence desc limit 1), updated_at) as last_transition_at",
          "from (",
          "select *, row_number() over (",
          "partition by project_name order by created_at desc, id desc",
          ") as rn from runs",
          `where project_name in (${projectPlaceholders.join(", ")})`,
          `and state in (${statePlaceholders.join(", ")})`,
          ") as ranked_runs where rn = 1"
        ].join(" ")
      )
      .all(params) as ProjectLastRunRow[];
    for (const row of rows) {
      result.set(row.project_name, {
        ...mapRunRow(row),
        lastTransitionAt: row.last_transition_at
      });
    }
    return result;
  }

  getRun(id: string): RunDetail | undefined {
    const row = this.database
      .prepare(
        [
          "select id, project_name, issue_number, issue_title, state, provider_name,",
          "workspace_path, branch_name,",
          "current_state_id, terminal_state_id, state_transition_reason,",
          "is_continuation, continuation_parent_run_id, retry_count,",
          "failure_classification, terminal_reason, cancel_requested, cancel_reason,",
          "created_at, updated_at",
          "from runs where id = ?"
        ].join(" ")
      )
      .get(id) as RunRow | undefined;

    if (row === undefined) {
      return undefined;
    }

    return {
      ...mapRunRow(row),
      attempts: this.listAttempts(id),
      transitions: this.listRunStateTransitions(id)
    };
  }

  listAttempts(runId: string): AttemptStatus[] {
    const rows = this.database
      .prepare(
        [
          "select id, run_id, attempt_number, state, provider_name, provider_command,",
          "workspace_path, branch_name, prompt_path, metadata_path, issue_snapshot_path,",
          "raw_log_path, normalized_log_path, workflow_graph_path,",
          "created_at, updated_at",
          "from attempts where run_id = ? order by attempt_number asc, id asc"
        ].join(" ")
      )
      .all(runId) as AttemptRow[];

    return rows.map((row) => ({
      artifacts: this.describeAttemptArtifacts(row),
      attemptNumber: row.attempt_number,
      branchName: row.branch_name,
      createdAt: row.created_at,
      id: row.id,
      providerCommand: row.provider_command,
      providerName: row.provider_name,
      runId: row.run_id,
      state: row.state,
      updatedAt: row.updated_at,
      workspacePath: row.workspace_path
    }));
  }

  listAttemptArtifacts(attemptId: string): RunArtifactDescriptor[] {
    const row = this.getAttemptArtifactRow(attemptId);
    if (row === undefined) {
      return [];
    }
    return this.describeAttemptArtifacts(row);
  }

  openAttemptArtifactStream(
    attemptId: string,
    kind: RunArtifactKind
  ): Promise<NodeJS.ReadableStream | undefined> {
    if (!ATTEMPT_ARTIFACT_KIND_SET.has(kind)) {
      return Promise.resolve(undefined);
    }
    const row = this.getAttemptArtifactRow(attemptId);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      this.openArtifactPath(row.run_id, attemptArtifactPath(row, kind))
    );
  }

  listRunStateTransitions(runId: string): RunStateTransition[] {
    const rows = this.database
      .prepare(
        "select sequence, state, created_at from run_state_transitions where run_id = ? order by sequence asc"
      )
      .all(runId) as {
      created_at: string;
      sequence: number;
      state: RunState;
    }[];

    return rows.map((row) => ({
      createdAt: row.created_at,
      sequence: row.sequence,
      state: row.state
    }));
  }

  listProviderEvents(
    runId: string,
    options: ListProviderEventsOptions = {}
  ): ProviderEventRecord[] {
    const conditions: string[] = ["run_id = @runId"];
    const params: Record<string, unknown> = { runId };
    if (options.afterSequence !== undefined) {
      conditions.push("sequence > @afterSequence");
      params.afterSequence = options.afterSequence;
    }
    const limit =
      options.limit !== undefined
        ? `limit ${Math.max(0, Math.floor(options.limit))}`
        : "";
    const order =
      options.order === "desc"
        ? "created_at desc, id desc"
        : "sequence asc, created_at asc, id asc";
    const rows = this.database
      .prepare(
        [
          "select run_id, attempt_id, sequence, type, raw_json, normalized_json, created_at",
          "from provider_events",
          `where ${conditions.join(" and ")}`,
          `order by ${order}`,
          limit
        ]
          .filter((part) => part.length > 0)
          .join(" ")
      )
      .all(params) as ProviderEventRow[];

    return rows.map((row) => mapProviderEventRow(row));
  }

  // Provider event `sequence` resets to 1 on every attempt, so an unscoped
  // `order by sequence desc` would pick whichever attempt produced the most
  // events, not the latest one. Callers pass the terminal attempt id to get the
  // failure that actually determined the run's outcome.
  getLastFailureEvent(
    runId: string,
    attemptId?: string
  ): ProviderEventRecord | undefined {
    const conditions = [
      "run_id = @runId",
      "type in ('turn_failed', 'malformed_event')"
    ];
    const params: Record<string, unknown> = { runId };
    if (attemptId !== undefined) {
      conditions.push("attempt_id = @attemptId");
      params.attemptId = attemptId;
    }
    const row = this.database
      .prepare(
        [
          "select run_id, attempt_id, sequence, type, raw_json, normalized_json, created_at",
          "from provider_events",
          `where ${conditions.join(" and ")}`,
          "order by sequence desc, id desc",
          "limit 1"
        ].join(" ")
      )
      .get(params) as ProviderEventRow | undefined;
    return row === undefined ? undefined : mapProviderEventRow(row);
  }

  listRunArtifacts(runId: string): RunArtifactDescriptor[] {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return [];
    }
    return RUN_ARTIFACT_KINDS.map((kind) => {
      const filePath = this.safeArtifactPath(runId, artifactPath(row, kind));
      const sizeBytes =
        filePath === undefined ? undefined : artifactSize(filePath);
      return {
        kind,
        present: sizeBytes !== undefined,
        sizeBytes
      };
    });
  }

  async getIssueSnapshot(runId: string): Promise<IssueSnapshot | undefined> {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return undefined;
    }
    const fileValue = await this.readJsonArtifact<IssueSnapshot>(
      runId,
      row.issue_snapshot_path
    );
    if (fileValue !== undefined) {
      return fileValue;
    }
    return JSON.parse(row.issue_snapshot_json) as IssueSnapshot;
  }

  async getRenderedPrompt(runId: string): Promise<string | undefined> {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return undefined;
    }
    return this.readTextArtifact(runId, row.prompt_path);
  }

  async getPromptMetadata(runId: string): Promise<PromptMetadata | undefined> {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return undefined;
    }
    return this.readJsonArtifact<PromptMetadata>(runId, row.metadata_path);
  }

  async getWorkflowGraph(runId: string): Promise<ExpandedWorkflow | undefined> {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return undefined;
    }
    return this.readJsonArtifact<ExpandedWorkflow>(
      runId,
      row.workflow_graph_path
    );
  }

  getRawProviderLog(runId: string): Promise<NodeJS.ReadableStream | undefined> {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.openArtifactPath(runId, row.raw_log_path));
  }

  async getNormalizedEventLog(
    runId: string
  ): Promise<NormalizedProviderEvent[] | undefined> {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return undefined;
    }
    const contents = await this.readTextArtifact(
      runId,
      row.normalized_log_path
    );
    if (contents === undefined) {
      return undefined;
    }
    return contents
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as NormalizedProviderEvent);
  }

  openArtifactStream(
    runId: string,
    kind: RunArtifactKind
  ): Promise<NodeJS.ReadableStream | undefined> {
    const row = this.getRunArtifactRow(runId);
    if (row === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      this.openArtifactPath(runId, artifactPath(row, kind))
    );
  }

  listRunsAwaitingPullRequestDiscovery(
    options: { limit?: number; maxAttempts?: number } = {}
  ): PullRequestDiscoveryRun[] {
    const limit = Math.max(
      0,
      Math.floor(options.limit ?? PULL_REQUEST_DISCOVERY_LIMIT)
    );
    const maxAttempts = Math.max(
      1,
      Math.floor(options.maxAttempts ?? MAX_PULL_REQUEST_DISCOVERY_ATTEMPTS)
    );
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, branch_name",
          "from runs",
          "where state = 'succeeded'",
          "and branch_name is not null",
          "and branch_name <> ''",
          "and pr_discovery_attempts < @maxAttempts",
          "and not exists (",
          "  select 1 from tracked_pull_requests pr",
          "  where pr.project_name = runs.project_name",
          "  and pr.branch_name = runs.branch_name",
          ")",
          "order by pr_discovery_attempts asc, updated_at asc, id asc",
          "limit @limit"
        ].join(" ")
      )
      .all({ limit, maxAttempts }) as PullRequestDiscoveryRunRow[];

    return rows.map((row) => ({
      branchName: row.branch_name,
      issueNumber: row.issue_number,
      projectName: row.project_name,
      runId: row.id
    }));
  }

  recordPullRequestDiscoveryAttempt(runId: string): void {
    this.database
      .prepare(
        "update runs set pr_discovery_attempts = pr_discovery_attempts + 1, updated_at = ? where id = ?"
      )
      .run(timestamp(), runId);
  }

  hasPullRequestFollowupWork(options: { maxAttempts?: number } = {}): boolean {
    const maxAttempts = Math.max(
      1,
      Math.floor(options.maxAttempts ?? MAX_PULL_REQUEST_DISCOVERY_ATTEMPTS)
    );
    const row = this.database
      .prepare(
        [
          "select 1 as found from tracked_pull_requests where state = 'open'",
          "union all",
          "select 1 as found from runs",
          "where state = 'succeeded'",
          "and branch_name is not null",
          "and branch_name <> ''",
          "and pr_discovery_attempts < @maxAttempts",
          "and not exists (",
          "  select 1 from tracked_pull_requests pr",
          "  where pr.project_name = runs.project_name",
          "  and pr.branch_name = runs.branch_name",
          ")",
          "limit 1"
        ].join(" ")
      )
      .get({ maxAttempts }) as { found: number } | undefined;
    return row !== undefined;
  }

  trackPullRequest(input: {
    branchName: string;
    headSha: string;
    issueNumber: number;
    projectName: string;
    prNumber: number;
    prUrl: string;
    runId: string;
  }): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "insert into tracked_pull_requests (",
          "project_name, issue_number, run_id, pr_number, pr_url, branch_name,",
          "head_sha_at_dispatch, last_seen_head_sha, state, last_observed_at,",
          "created_at, updated_at",
          ") values (",
          "@project_name, @issue_number, @run_id, @pr_number, @pr_url, @branch_name,",
          "@head_sha_at_dispatch, @last_seen_head_sha, 'open', @last_observed_at,",
          "@created_at, @updated_at",
          ")",
          "on conflict(project_name, pr_number) do update set",
          "issue_number = excluded.issue_number,",
          "pr_url = excluded.pr_url,",
          "branch_name = excluded.branch_name,",
          "last_seen_head_sha = excluded.last_seen_head_sha,",
          "state = 'open',",
          "last_observed_at = excluded.last_observed_at,",
          "updated_at = excluded.updated_at"
        ].join(" ")
      )
      .run({
        branch_name: input.branchName,
        created_at: now,
        head_sha_at_dispatch: input.headSha,
        issue_number: input.issueNumber,
        last_observed_at: now,
        last_seen_head_sha: input.headSha,
        pr_number: input.prNumber,
        pr_url: input.prUrl,
        project_name: input.projectName,
        run_id: input.runId,
        updated_at: now
      });
  }

  // Used by the global PR follow-up loop to decide whether a tracked PR's
  // merge belongs to the FSM (when a workflow has parked the run in a
  // `merge_pr` state) or to the global auto-merge path. Returns the most
  // recent waiting row for the (project, issue) pair, ignoring cancelled
  // runs so a long-cancelled wait does not gate the global loop.
  findWaitingRunByIssue(input: {
    issueNumber: number;
    projectName: string;
  }): { currentStateId: string | null; runId: string } | undefined {
    const row = this.database
      .prepare(
        [
          "select id, current_state_id",
          "from runs",
          "where state = 'waiting'",
          "and cancel_requested = 0",
          "and project_name = ? and issue_number = ?",
          "order by created_at desc limit 1"
        ].join(" ")
      )
      .get(input.projectName, input.issueNumber) as
      { current_state_id: string | null; id: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { currentStateId: row.current_state_id, runId: row.id };
  }

  // Wait re-evaluation needs to see merged/closed tracked PRs so a workflow
  // waiting on `pr_merged: true` can advance after the PR follow-up
  // dispatcher has marked the tracked row "merged". Returns the most-recent
  // tracked PR for the (project, issue) pair regardless of `state`.
  findTrackedPullRequestByIssue(input: {
    issueNumber: number;
    projectName: string;
  }): TrackedPullRequest | undefined {
    const row = this.database
      .prepare(
        [
          "select id, project_name, issue_number, run_id, pr_number, pr_url,",
          "branch_name, head_sha_at_dispatch, last_seen_head_sha,",
          "last_review_dispatch_fingerprint, review_dispatch_count,",
          "review_followup_cap_reached,",
          "last_followup_run_id, state, last_observed_at, created_at, updated_at",
          "from tracked_pull_requests",
          "where project_name = ? and issue_number = ?",
          "order by id desc limit 1"
        ].join(" ")
      )
      .get(input.projectName, input.issueNumber) as
      TrackedPullRequestRow | undefined;
    return row === undefined ? undefined : mapTrackedPullRequestRow(row);
  }

  listOpenTrackedPullRequests(): TrackedPullRequest[] {
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, run_id, pr_number, pr_url,",
          "branch_name, head_sha_at_dispatch, last_seen_head_sha,",
          "last_review_dispatch_fingerprint, review_dispatch_count,",
          "review_followup_cap_reached,",
          "last_followup_run_id, state, last_observed_at, created_at, updated_at",
          "from tracked_pull_requests",
          "where state = 'open'",
          "order by last_observed_at asc, id asc"
        ].join(" ")
      )
      .all() as TrackedPullRequestRow[];

    return rows.map((row) => mapTrackedPullRequestRow(row));
  }

  // Unlike listOpenTrackedPullRequests, includes 'closed' rows: PR Follow-up
  // sets a tracking row to 'closed' when GitHub reports the PR closed, but a
  // reopened PR can still have a live parked Run — the PR-merge/clear-stale-
  // claim ownership guards need that Run's issueNumber regardless of the
  // tracking row's state.
  findTrackedPullRequestByProjectAndNumber(input: {
    projectName: string;
    prNumber: number;
  }): TrackedPullRequest | undefined {
    const row = this.database
      .prepare(
        [
          "select id, project_name, issue_number, run_id, pr_number, pr_url,",
          "branch_name, head_sha_at_dispatch, last_seen_head_sha,",
          "last_review_dispatch_fingerprint, review_dispatch_count,",
          "review_followup_cap_reached,",
          "last_followup_run_id, state, last_observed_at, created_at, updated_at",
          "from tracked_pull_requests",
          "where project_name = ? and pr_number = ?",
          "order by id desc limit 1"
        ].join(" ")
      )
      .get(input.projectName, input.prNumber) as
      TrackedPullRequestRow | undefined;
    return row === undefined ? undefined : mapTrackedPullRequestRow(row);
  }

  // A run whose provider is still preparing/running has no tracked_pull_
  // requests row yet (listRunsAwaitingPullRequestDiscovery only considers
  // 'succeeded' runs) — this lets the PR-merge/clear-stale-claim ownership
  // guards resolve the issue a not-yet-discovered PR's branch belongs to,
  // so a still-running provider's PR is not read as ownerless.
  findRunByProjectAndBranch(input: {
    branchName: string;
    projectName: string;
  }): { issueNumber: number; runId: string } | undefined {
    const row = this.database
      .prepare(
        [
          "select id, issue_number from runs",
          "where project_name = ? and branch_name = ?",
          "order by updated_at desc, id desc limit 1"
        ].join(" ")
      )
      .get(input.projectName, input.branchName) as
      { id: string; issue_number: number } | undefined;
    return row === undefined
      ? undefined
      : { issueNumber: row.issue_number, runId: row.id };
  }

  // Routine Firings are a separate entity from Runs and never get a
  // tracked_pull_requests row (that table is sourced only from `runs` via
  // listRunsAwaitingPullRequestDiscovery), so a `routine_firing_branch`
  // snapshot's PR always resolved to no owner. routine_firings carries its
  // own liveness via `state`, so this is checked independently of the
  // Run-keyed ownership path rather than trying to force it through
  // findLiveRunIdForIssue (Routine Firings have no issue number).
  findLiveRoutineFiringByBranch(input: {
    branchName: string;
    projectName: string;
  }): { firingId: string; routineName: string } | undefined {
    const row = this.database
      .prepare(
        [
          "select id, routine_name from routine_firings",
          "where project_name = ? and branch_name = ?",
          "and state in ('queued', 'preparing_workspace', 'running')",
          "order by created_at desc limit 1"
        ].join(" ")
      )
      .get(input.projectName, input.branchName) as
      { id: string; routine_name: string } | undefined;
    return row === undefined
      ? undefined
      : { firingId: row.id, routineName: row.routine_name };
  }

  recordPullRequestObservation(input: {
    headSha: string;
    id: number;
    prUrl: string;
    reviewFollowupCapReached: boolean;
    state: PullRequestTrackingState;
  }): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "update tracked_pull_requests set",
          "pr_url = @pr_url,",
          "last_seen_head_sha = @last_seen_head_sha,",
          "review_followup_cap_reached = @review_followup_cap_reached,",
          "state = @state,",
          "last_observed_at = @last_observed_at,",
          "updated_at = @updated_at",
          "where id = @id"
        ].join(" ")
      )
      .run({
        id: input.id,
        last_observed_at: now,
        last_seen_head_sha: input.headSha,
        pr_url: input.prUrl,
        review_followup_cap_reached: input.reviewFollowupCapReached ? 1 : 0,
        state: input.state,
        updated_at: now
      });
  }

  recordPullRequestReviewDispatch(input: {
    fingerprint: string;
    headSha: string;
    id: number;
    runId: string;
  }): void {
    this.database
      .prepare(
        [
          "update tracked_pull_requests set",
          "last_review_dispatch_fingerprint = @fingerprint,",
          "review_dispatch_count = review_dispatch_count + 1,",
          "last_followup_run_id = @run_id,",
          "last_seen_head_sha = @head_sha,",
          "updated_at = @updated_at",
          "where id = @id"
        ].join(" ")
      )
      .run({
        fingerprint: input.fingerprint,
        head_sha: input.headSha,
        id: input.id,
        run_id: input.runId,
        updated_at: timestamp()
      });
  }

  markCancelRequested(runId: string, reason: CancelReason): void {
    this.database
      .prepare(
        "update runs set cancel_requested = 1, cancel_reason = case when cancel_reason = ? then cancel_reason else ? end, updated_at = ? where id = ?"
      )
      .run(SHUTDOWN_PREEMPTIVE_REASON, reason, timestamp(), runId);
  }

  findLeakedRuns(): {
    runId: string;
    projectName: string;
    issueNumber: number;
    previousState: RunState;
    previousTerminalReason: string | null;
  }[] {
    // Sweeps three classes of orphaned rows:
    // - queued / preparing_workspace / running: their in-memory scheduler
    //   callback and provider stream are gone after a crash; they cannot
    //   resume.
    // - waiting with current_state_id IS NULL: pre-atomicity crash artifact
    //   from createWaitingRun's two-write window (now closed by the
    //   transaction wrapper); listWaitingRuns filters these out so
    //   reconcileWaitingRuns can never re-evaluate them. Valid durable waits
    //   (current_state_id set) are intentionally preserved per ADR 0047.
    // - stale with terminal_reason = 'leaked_active_run_cleanup_pending': a
    //   prior sweep terminalized the row but could not confirm its provider
    //   scope was actually stopped. Read-only re-detection here (see
    //   markRunsStale below) is what makes that retry durable across
    //   restarts without ever re-exposing the row as 'running' — see
    //   docs/adr/0064.
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, state, terminal_reason",
          "from runs",
          "where state in ('queued','preparing_workspace','running')",
          "or (state = 'waiting' and current_state_id is null)",
          "or (state = 'stale' and terminal_reason = 'leaked_active_run_cleanup_pending')"
        ].join(" ")
      )
      .all() as {
      id: string;
      project_name: string;
      issue_number: number;
      state: RunState;
      terminal_reason: string | null;
    }[];
    return rows.map((row) => ({
      issueNumber: row.issue_number,
      previousState: row.state,
      previousTerminalReason: row.terminal_reason,
      projectName: row.project_name,
      runId: row.id
    }));
  }

  markRunsStale(
    entries: { runId: string; reason: string; previousState: RunState }[]
  ): void {
    const update = this.database.prepare(
      [
        "update runs set",
        "state = 'stale',",
        "terminal_reason = ?,",
        "notification_state = 'pending',",
        "notification_error = null,",
        "updated_at = ?",
        "where id = ?"
      ].join(" ")
    );
    const apply = this.database.transaction(() => {
      const events: RunTransitionChangeEvent[] = [];
      for (const entry of entries) {
        const updatedAt = timestamp();
        update.run(entry.reason, updatedAt, entry.runId);
        // A re-swept row (previousState already 'stale') isn't changing
        // state -- only its terminal_reason may bump between pending and
        // confirmed -- so recording another "stale" transition here would
        // duplicate an entry every restart for as long as cleanup stays
        // unconfirmed, unboundedly, in a table rendered verbatim on the
        // dashboard.
        if (entry.previousState !== "stale") {
          events.push(
            this.insertRunTransition(entry.runId, "stale", updatedAt)
          );
        }
      }
      return events;
    });
    this.publishAll(apply());
  }

  findLeakedRoutineFirings(): {
    firingId: string;
    projectName: string;
    routineName: string;
    previousState: RoutineFiringState;
    previousTerminalReason: string | null;
  }[] {
    // A daemon crash or kill can leave a routine firing durably in queued,
    // preparing_workspace, or running. findLeakedRuns only sweeps the runs
    // table, so without this reconciliation the orphaned firing keeps
    // hasActiveRoutineFiring returning true forever, permanently skipping every
    // future recurring tick for that routine. routine_firings has no 'stale'
    // state, so leaked rows are settled as 'failed' with a distinct
    // terminal_reason to remove them from the active set. A row already
    // 'failed' with terminal_reason = 'leaked_routine_firing_cleanup_pending'
    // is re-detected the same way findLeakedRuns re-detects its own pending
    // rows — see docs/adr/0064.
    const rows = this.database
      .prepare(
        [
          "select id, project_name, routine_name, state, terminal_reason",
          "from routine_firings",
          "where state in ('queued','preparing_workspace','running')",
          "or (state = 'failed' and terminal_reason = 'leaked_routine_firing_cleanup_pending')"
        ].join(" ")
      )
      .all() as {
      id: string;
      project_name: string;
      routine_name: string;
      state: RoutineFiringState;
      terminal_reason: string | null;
    }[];
    return rows.map((row) => ({
      firingId: row.id,
      previousState: row.state,
      previousTerminalReason: row.terminal_reason,
      projectName: row.project_name,
      routineName: row.routine_name
    }));
  }

  markRoutineFiringsFailed(
    entries: {
      firingId: string;
      reason: string;
      previousState: RoutineFiringState;
    }[]
  ): void {
    const update = this.database.prepare(
      [
        "update routine_firings set",
        "state = 'failed',",
        "terminal_reason = ?,",
        "commits_ahead = case",
        "when kind = 'report' then 0",
        "when workspace_path is not null and workspace_path <> '' then 1",
        "else commits_ahead end,",
        "updated_at = ?",
        "where id = ?"
      ].join(" ")
    );
    const apply = this.database.transaction(() => {
      const events: FiringTransitionChangeEvent[] = [];
      for (const entry of entries) {
        const updatedAt = timestamp();
        update.run(entry.reason, updatedAt, entry.firingId);
        // See markRunsStale's identical guard: a re-swept row (previousState
        // already 'failed') isn't changing state, so skip the duplicate
        // transition record.
        if (entry.previousState !== "failed") {
          events.push(
            this.insertRoutineFiringTransition(
              entry.firingId,
              "failed",
              updatedAt
            )
          );
        }
      }
      return events;
    });
    this.publishAll(apply());
  }

  failLegacyInputRequiredRuns(
    options: { graceMs?: number; now?: Date } = {}
  ): { runId: string; projectName: string; issueNumber: number }[] {
    const graceMs = options.graceMs ?? INPUT_REQUIRED_LEGACY_BACKFILL_GRACE_MS;
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - graceMs).toISOString();
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number",
          "from runs",
          "where state = 'input_required'",
          "and updated_at < ?",
          "order by updated_at asc, id asc"
        ].join(" ")
      )
      .all(cutoff) as {
      id: string;
      project_name: string;
      issue_number: number;
    }[];
    const migrated = rows.map((row) => ({
      issueNumber: row.issue_number,
      projectName: row.project_name,
      runId: row.id
    }));
    const update = this.database.prepare(
      [
        "update runs set",
        "state = 'failed',",
        "terminal_reason = ?,",
        "failure_classification = 'input_required',",
        "notification_state = 'pending',",
        "notification_error = null,",
        "updated_at = ?",
        "where id = ?"
      ].join(" ")
    );
    const apply = this.database.transaction(() => {
      const events: RunTransitionChangeEvent[] = [];
      for (const entry of migrated) {
        const updatedAt = timestamp();
        update.run(
          INPUT_REQUIRED_LEGACY_TERMINAL_REASON,
          updatedAt,
          entry.runId
        );
        events.push(this.insertRunTransition(entry.runId, "failed", updatedAt));
      }
      return events;
    });
    this.publishAll(apply());
    return migrated;
  }

  private migrate(): void {
    this.database.exec(`
      create table if not exists runs (
        id text primary key,
        project_name text not null,
        issue_number integer not null,
        issue_title text not null,
        state text not null,
        issue_snapshot_json text not null,
        evidence_ignore_json text not null default '[]',
        provider_name text,
        provider_command text,
        workspace_path text,
        branch_name text,
        branch_ref text,
        prompt_path text,
        metadata_path text,
        issue_snapshot_path text,
        raw_log_path text,
        normalized_log_path text,
        notification_state text not null default 'skipped',
        notification_error text,
        watchdog_generation integer not null default 0,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists attempts (
        id text primary key,
        run_id text not null,
        attempt_number integer not null,
        state text not null,
        provider_name text not null,
        provider_command text not null,
        workspace_path text not null,
        branch_name text not null,
        prompt_path text not null,
        metadata_path text not null,
        issue_snapshot_path text not null,
        raw_log_path text not null,
        normalized_log_path text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (run_id) references runs(id)
      );

      create table if not exists run_state_transitions (
        id integer primary key autoincrement,
        run_id text not null,
        sequence integer not null,
        state text not null,
        created_at text not null,
        foreign key (run_id) references runs(id)
      );

      create table if not exists provider_events (
        id integer primary key autoincrement,
        run_id text not null,
        attempt_id text not null,
        sequence integer not null,
        type text not null,
        raw_json text not null,
        normalized_json text not null,
        created_at text not null,
        foreign key (run_id) references runs(id),
        foreign key (attempt_id) references attempts(id)
      );

      create table if not exists tracked_pull_requests (
        id integer primary key autoincrement,
        project_name text not null,
        issue_number integer not null,
        run_id text not null,
        pr_number integer not null,
        pr_url text not null,
        branch_name text not null,
        head_sha_at_dispatch text not null,
        last_seen_head_sha text not null,
        last_review_dispatch_fingerprint text,
        review_dispatch_count integer not null default 0,
        review_followup_cap_reached integer not null default 0,
        last_followup_run_id text,
        state text not null,
        last_observed_at text not null,
        created_at text not null,
        updated_at text not null,
        unique(project_name, pr_number),
        foreign key (run_id) references runs(id)
      );

      create table if not exists project_states (
        project_name text primary key,
        active integer not null default 1,
        weight integer not null default 1,
        validation_state text not null default 'valid',
        validation_message text,
        last_poll_started_at text,
        last_poll_finished_at text,
        last_successful_poll_at text,
        last_poll_ok integer,
        last_poll_error text,
        last_fetched_issues integer not null default 0,
        last_candidate_issues integer not null default 0,
        last_filtered_issues integer not null default 0,
        scheduler_current_weight integer not null default 0,
        last_dispatched_at text,
        last_dispatched_issue_number integer,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists project_issue_snapshots (
        project_name text not null,
        issue_number integer not null,
        kind text not null,
        title text not null,
        priority integer not null default 0,
        reasons text,
        labels text,
        repository_owner text,
        repository_name text,
        polled_at text not null,
        created_at text not null,
        updated_at text not null,
        primary key (project_name, issue_number)
      );

      create table if not exists project_pull_request_snapshots (
        project_name text not null,
        pr_number integer not null,
        title text not null,
        url text,
        draft integer not null default 0,
        open integer not null default 0,
        merged integer not null default 0,
        head_ref text,
        head_sha text,
        labels text,
        branch_origin text not null default 'neither',
        state_available integer not null default 0,
        mergeable text,
        checks text,
        review_decision text,
        tracking_state text,
        unresolved_review_threads integer,
        repository_owner text,
        repository_name text,
        polled_at text not null,
        created_at text not null,
        updated_at text not null,
        primary key (project_name, pr_number)
      );

      create table if not exists pull_request_merge_attempts (
        id integer primary key autoincrement,
        project_name text not null,
        pr_number integer not null,
        method text not null,
        ok integer not null,
        error text,
        fresh_tracking_state text,
        attempted_at text not null
      );

      create table if not exists watchdog_samples (
        run_id text primary key,
        sampled_at text not null,
        last_tool_call_at text,
        workspace_mtime_max real not null,
        turn_id_set_size integer not null,
        output_tokens_total integer not null,
        normalized_log_offset integer not null,
        idle_since text,
        normalized_log_path text not null default '',
        last_message_at text,
        foreign key (run_id) references runs(id)
      );

      create table if not exists watchdog_sample_history (
        run_id text not null,
        sampled_at text not null,
        last_tool_call_at text,
        workspace_mtime_max real not null,
        turn_id_set_size integer not null,
        output_tokens_total integer not null,
        normalized_log_offset integer not null,
        idle_since text,
        normalized_log_path text not null default '',
        last_message_at text,
        primary key (run_id, sampled_at),
        foreign key (run_id) references runs(id)
      );

      create table if not exists watchdog_turn_ids (
        run_id text not null,
        turn_id text not null,
        primary key (run_id, turn_id),
        foreign key (run_id) references runs(id)
      );

      create table if not exists routines (
        project_name text not null,
        name text not null,
        source_path text not null,
        kind text not null,
        provider_name text,
        model text,
        effort text,
        permission_mode text,
        timeout_minutes real,
        schedule_at text not null,
        schedule_cron text,
        schedule_tz text,
        next_fire_at text,
        prompt_body text not null,
        state text not null,
        allow_overlap integer not null default 0,
        catch_up text not null default 'skip',
        notify_enabled integer not null default 1,
        last_fired_at text,
        last_attempted_at text,
        last_skip_reason text,
        last_skip_at text,
        disabled_reason text,
        created_at text not null,
        updated_at text not null,
        primary key (project_name, name)
      );

      create table if not exists routine_skip_counts (
        project_name text not null,
        routine_name text not null,
        reason text not null,
        skipped_at text not null,
        count integer not null,
        primary key (project_name, routine_name, reason, skipped_at),
        foreign key (project_name, routine_name) references routines(project_name, name) on delete cascade
      );

      create table if not exists routine_firings (
        id text primary key,
        project_name text not null,
        routine_name text not null,
        -- Nullable so a database created here matches one migrated from a
        -- release without this column, where historical rows stay unknown.
        -- createRoutineFiring rejects a firing whose kind cannot be resolved.
        kind text,
        state text not null,
        provider_name text not null,
        provider_command text not null,
        trigger_source text not null default 'scheduled',
        scheduled_at text not null,
        workspace_path text,
        workspace_pruned_at text,
        branch_name text,
        branch_ref text,
        prompt_path text,
        raw_log_path text,
        normalized_log_path text,
        terminal_reason text,
        commits_ahead integer not null default 0,
        outcome_status text,
        outcome_action text,
        outcome_url text,
        outcome_title text,
        outcome_summary text,
        outcome_verified integer,
        outcome_source text,
        notification_state text,
        notification_error text,
        cancel_requested integer not null default 0,
        cancel_reason text,
        created_at text not null,
        updated_at text not null,
        foreign key (project_name, routine_name) references routines(project_name, name)
      );

      create table if not exists routine_firing_state_transitions (
        id integer primary key autoincrement,
        firing_id text not null,
        sequence integer not null,
        state text not null,
        created_at text not null,
        foreign key (firing_id) references routine_firings(id)
      );

      create table if not exists routine_pull_requests (
        id integer primary key autoincrement,
        project_name text not null,
        routine_name text not null,
        firing_id text not null,
        pr_number integer not null,
        head_sha text not null,
        created_at text not null,
        updated_at text not null,
        unique(project_name, routine_name, firing_id, pr_number),
        foreign key (project_name, routine_name) references routines(project_name, name),
        foreign key (firing_id) references routine_firings(id)
      );

      create table if not exists routine_fanouts (
        id text primary key,
        routine_name text not null,
        scheduled_at text not null,
        notification_state text not null default 'pending',
        notification_error text,
        notified_at text,
        created_at text not null,
        updated_at text not null,
        unique(routine_name, scheduled_at)
      );

      create table if not exists routine_fanout_targets (
        fanout_id text not null,
        project_name text not null,
        disposition text not null default 'pending',
        firing_id text,
        hold_reason text,
        skip_reason text,
        created_at text not null,
        updated_at text not null,
        primary key (fanout_id, project_name),
        foreign key (fanout_id) references routine_fanouts(id),
        foreign key (firing_id) references routine_firings(id)
      );
    `);

    const additions: Array<[string, string, string]> = [
      ["runs", "is_continuation", "integer not null default 0"],
      ["runs", "evidence_ignore_json", "text not null default '[]'"],
      ["runs", "continuation_parent_run_id", "text"],
      ["runs", "retry_count", "integer not null default 0"],
      ["runs", "failure_classification", "text"],
      ["runs", "terminal_reason", "text"],
      ["runs", "cancel_requested", "integer not null default 0"],
      ["runs", "cancel_reason", "text"],
      ["runs", "pr_discovery_attempts", "integer not null default 0"],
      ["runs", "workflow_graph_path", "text"],
      ["runs", "current_state_id", "text"],
      ["runs", "terminal_state_id", "text"],
      ["runs", "state_transition_reason", "text"],
      ["runs", "notification_state", "text not null default 'skipped'"],
      ["runs", "notification_error", "text"],
      ["runs", "watchdog_generation", "integer not null default 0"],
      [
        "tracked_pull_requests",
        "review_followup_cap_reached",
        "integer not null default 0"
      ],
      ["project_states", "last_successful_poll_at", "text"],
      ["attempts", "failure_classification", "text"],
      ["attempts", "metadata_path", "text"],
      ["attempts", "workflow_graph_path", "text"],
      ["watchdog_samples", "normalized_log_path", "text not null default ''"],
      ["watchdog_samples", "last_message_at", "text"],
      ["routines", "schedule_cron", "text"],
      ["routines", "schedule_tz", "text"],
      ["routines", "next_fire_at", "text"],
      ["routines", "allow_overlap", "integer not null default 0"],
      ["routines", "catch_up", "text not null default 'skip'"],
      ["routines", "notify_enabled", "integer not null default 1"],
      ["routines", "last_attempted_at", "text"],
      ["routines", "last_skip_reason", "text"],
      ["routines", "last_skip_at", "text"],
      ["routines", "disabled_reason", "text"],
      ["routines", "model", "text"],
      ["routines", "effort", "text"],
      ["routines", "permission_mode", "text"],
      ["routines", "timeout_minutes", "real"],
      ["routine_firings", "prompt_path", "text"],
      ["routine_firings", "raw_log_path", "text"],
      ["routine_firings", "normalized_log_path", "text"],
      ["routine_firings", "kind", "text"],
      ["routine_firings", "commits_ahead", "integer not null default 0"],
      ["routine_firings", "outcome_status", "text"],
      ["routine_firings", "outcome_action", "text"],
      ["routine_firings", "outcome_url", "text"],
      ["routine_firings", "outcome_title", "text"],
      ["routine_firings", "outcome_summary", "text"],
      ["routine_firings", "outcome_verified", "integer"],
      ["routine_firings", "outcome_source", "text"],
      [
        "routine_firings",
        "trigger_source",
        "text not null default 'scheduled'"
      ],
      ["routine_firings", "scheduled_at", "text not null default ''"],
      ["routine_firings", "branch_name", "text"],
      ["routine_firings", "branch_ref", "text"],
      ["routine_firings", "cancel_requested", "integer not null default 0"],
      ["routine_firings", "cancel_reason", "text"],
      ["routine_firings", "notification_state", "text"],
      ["routine_firings", "notification_error", "text"],
      ["routine_firings", "workspace_pruned_at", "text"],
      ["routine_firings", "fanout_id", "text"],
      ["routine_fanout_targets", "hold_reason", "text"],
      ["project_issue_snapshots", "labels", "text"],
      ["project_issue_snapshots", "blocked_by", "text"],
      [
        "project_issue_snapshots",
        "blocked_by_truncated",
        "integer not null default 0"
      ],
      ["project_issue_snapshots", "parent_issue_number", "integer"],
      ["project_issue_snapshots", "repository_owner", "text"],
      ["project_issue_snapshots", "repository_name", "text"],
      ["project_pull_request_snapshots", "labels", "text"],
      ["project_pull_request_snapshots", "repository_owner", "text"],
      ["project_pull_request_snapshots", "repository_name", "text"]
    ];

    const apply = this.database.transaction(() => {
      let addedCommitsAhead = false;
      let addedFiringKind = false;
      let addedLastSuccessfulPollAt = false;
      for (const [table, column, decl] of additions) {
        const added = this.ensureColumn(table, column, decl);
        if (
          added &&
          table === "routine_firings" &&
          column === "commits_ahead"
        ) {
          addedCommitsAhead = true;
        }
        if (added && table === "routine_firings" && column === "kind") {
          addedFiringKind = true;
        }
        if (
          added &&
          table === "project_states" &&
          column === "last_successful_poll_at"
        ) {
          addedLastSuccessfulPollAt = true;
        }
      }

      if (addedLastSuccessfulPollAt) {
        // A legacy latest-success row has enough evidence to recover this
        // timestamp exactly. A latest-failure row does not reveal when its
        // preceding success happened, so leave that case unknown.
        this.database.exec(`
          update project_states
          set last_successful_poll_at = last_poll_finished_at
          where last_poll_ok = 1;
        `);
      }

      if (addedFiringKind) {
        // Branch identity is immutable firing evidence. It can prove a
        // historical firing was kind: git, while a missing/local-remote ref
        // cannot safely distinguish a report firing from older git rows that
        // predate branch persistence. Leave those rows unknown so retention
        // never derives and deletes a branch from mutable Routine state.
        this.database.exec(`
          update routine_firings
          set kind = 'git'
          where branch_ref like 'refs/heads/%';
        `);
      }

      if (addedCommitsAhead) {
        // Rows written before commits_ahead existed were never inspected on
        // every terminal path. Only a known report routine is a verified
        // negative; git and unclassifiable historical rows are protected.
        // Keep this in the column-add transaction so a crash cannot expose
        // the default zero before the one-time backfill finishes.
        this.database.exec(`
          update routine_firings
          set commits_ahead = 1
          where not exists (
            select 1
            from routines
            where routines.project_name = routine_firings.project_name
              and routines.name = routine_firings.routine_name
              and routines.kind = 'report'
          );
        `);
      }
    });
    apply();

    this.database.exec(`
      create index if not exists routine_firing_workspace_retention_idx
      on routine_firings(workspace_pruned_at, state, updated_at);
    `);

    // run_state_transitions is append-only with no retention sweep and has no
    // other index. nextTransitionSequence's max(sequence) lookup runs on every
    // transition write, and both listRunStateTransitions and
    // listLatestRunsByProject's newest-transition subquery otherwise degrade
    // to a full scan plus a temp b-tree sort of the whole table.
    this.database.exec(`
      create index if not exists run_state_transitions_run_seq_idx
      on run_state_transitions(run_id, sequence);
    `);

    // Runs after the ensureColumn additions above so databases created before
    // watchdog_samples gained normalized_log_path/last_message_at have those
    // columns before the history backfill reads them.
    this.database.exec(`
      insert or ignore into watchdog_sample_history (
        run_id, sampled_at, last_tool_call_at, last_message_at,
        workspace_mtime_max, turn_id_set_size, output_tokens_total,
        normalized_log_offset, normalized_log_path, idle_since
      )
      select
        run_id, sampled_at, last_tool_call_at, last_message_at,
        workspace_mtime_max, turn_id_set_size, output_tokens_total,
        normalized_log_offset, normalized_log_path, idle_since
      from watchdog_samples;
    `);

    this.backfillAttemptMetadataPaths();
  }

  private backfillAttemptMetadataPaths(): void {
    const rows = this.database
      .prepare(
        [
          "select attempts.id, attempts.attempt_number, attempts.prompt_path,",
          "attempts.metadata_path, runs.metadata_path as run_metadata_path",
          "from attempts left join runs on runs.id = attempts.run_id",
          "where attempts.metadata_path is null or attempts.metadata_path = ''"
        ].join(" ")
      )
      .all() as Array<{
      attempt_number: number;
      id: string;
      metadata_path: string | null;
      prompt_path: string | null;
      run_metadata_path: string | null;
    }>;
    if (rows.length === 0) {
      return;
    }

    const update = this.database.prepare(
      "update attempts set metadata_path = ? where id = ?"
    );
    const apply = this.database.transaction(() => {
      for (const row of rows) {
        const metadataPath =
          inferAttemptMetadataPath(row.prompt_path, row.attempt_number) ??
          row.run_metadata_path;
        if (metadataPath !== null && metadataPath.length > 0) {
          update.run(metadataPath, row.id);
        }
      }
    });
    apply();
  }

  private ensureColumn(table: string, column: string, decl: string): boolean {
    const existing = this.database
      .prepare("select name from pragma_table_info(?)")
      .all(table) as { name: string }[];
    if (existing.some((row) => row.name === column)) {
      return false;
    }

    this.database.exec(`alter table ${table} add column ${column} ${decl};`);
    return true;
  }

  private isCurrentWatchdogGeneration(
    runId: string,
    watchdogGeneration: number
  ): boolean {
    return (
      this.database
        .prepare(
          "select 1 from runs where id = ? and state = 'running' and watchdog_generation = ?"
        )
        .get(runId, watchdogGeneration) !== undefined
    );
  }

  private recordRunTransition(
    runId: string,
    state: RunState,
    createdAt: string
  ): void {
    this.publishChange(this.insertRunTransition(runId, state, createdAt));
  }

  private insertRunTransition(
    runId: string,
    state: RunState,
    createdAt: string
  ): RunTransitionChangeEvent {
    const sequence = nextTransitionSequence(this.database, runId);
    this.database
      .prepare(
        "insert into run_state_transitions (run_id, sequence, state, created_at) values (?, ?, ?, ?)"
      )
      .run(runId, sequence, state, createdAt);
    return { kind: "run-transition", runId, sequence, state };
  }

  private recordRoutineFiringTransition(
    firingId: string,
    state: RoutineFiringState,
    createdAt: string
  ): void {
    this.publishChange(
      this.insertRoutineFiringTransition(firingId, state, createdAt)
    );
  }

  private insertRoutineFiringTransition(
    firingId: string,
    state: RoutineFiringState,
    createdAt: string
  ): FiringTransitionChangeEvent {
    const sequence = nextRoutineFiringTransitionSequence(
      this.database,
      firingId
    );
    this.database
      .prepare(
        "insert into routine_firing_state_transitions (firing_id, sequence, state, created_at) values (?, ?, ?, ?)"
      )
      .run(firingId, sequence, state, createdAt);
    return {
      firingId,
      kind: "firing-transition",
      sequence,
      state
    };
  }

  private latestRoutinePullRequestNumbers(
    projectName: string,
    routineName: string
  ): number[] {
    const latest = this.database
      .prepare(
        [
          "select id from routine_firings",
          "where project_name = ? and routine_name = ?",
          "order by created_at desc, id desc limit 1"
        ].join(" ")
      )
      .get(projectName, routineName) as { id: string } | undefined;
    return latest === undefined
      ? []
      : this.listRoutinePullRequests({ firingId: latest.id }).map(
          (pullRequest) => pullRequest.prNumber
        );
  }

  private routineKind(
    projectName: string,
    routineName: string
  ): RoutineKind | undefined {
    return (
      this.database
        .prepare(
          "select kind from routines where project_name = ? and name = ?"
        )
        .get(projectName, routineName) as { kind: RoutineKind } | undefined
    )?.kind;
  }

  private getRunArtifactRow(runId: string): RunArtifactRow | undefined {
    return this.database
      .prepare(
        [
          "select issue_snapshot_json, issue_snapshot_path, metadata_path,",
          "normalized_log_path, prompt_path, raw_log_path, workflow_graph_path",
          "from runs where id = ?"
        ].join(" ")
      )
      .get(runId) as RunArtifactRow | undefined;
  }

  private getAttemptArtifactRow(
    attemptId: string
  ): AttemptArtifactRow | undefined {
    return this.database
      .prepare(
        [
          "select run_id, issue_snapshot_path, prompt_path, metadata_path,",
          "raw_log_path, normalized_log_path, workflow_graph_path",
          "from attempts where id = ?"
        ].join(" ")
      )
      .get(attemptId) as AttemptArtifactRow | undefined;
  }

  private describeAttemptArtifacts(
    row: AttemptArtifactRow
  ): RunArtifactDescriptor[] {
    return ATTEMPT_ARTIFACT_KINDS.map((kind) => {
      const filePath = this.safeArtifactPath(
        row.run_id,
        attemptArtifactPath(row, kind)
      );
      const sizeBytes =
        filePath === undefined ? undefined : artifactSize(filePath);
      return {
        kind,
        present: sizeBytes !== undefined,
        sizeBytes
      };
    });
  }

  private async readTextArtifact(
    runId: string,
    filePath: string | null
  ): Promise<string | undefined> {
    const safePath = this.safeArtifactPath(runId, filePath);
    if (safePath === undefined) {
      return undefined;
    }
    try {
      return await readFile(safePath, "utf8");
    } catch {
      return undefined;
    }
  }

  private async readJsonArtifact<T>(
    runId: string,
    filePath: string | null
  ): Promise<T | undefined> {
    const contents = await this.readTextArtifact(runId, filePath);
    if (contents === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(contents) as T;
    } catch {
      return undefined;
    }
  }

  private openArtifactPath(
    runId: string,
    filePath: string | null
  ): NodeJS.ReadableStream | undefined {
    const safePath = this.safeArtifactPath(runId, filePath);
    if (safePath === undefined) {
      return undefined;
    }
    if (artifactSize(safePath) === undefined) {
      return undefined;
    }
    return createReadStream(safePath);
  }

  private safeArtifactPath(
    runId: string,
    filePath: string | null
  ): string | undefined {
    if (filePath === null || filePath.length === 0) {
      return undefined;
    }
    const evidenceRoot = path.join(this.stateRoot, "logs", "runs", runId);
    if (!isPathInside(filePath, evidenceRoot)) {
      return undefined;
    }
    return filePath;
  }
}

export function openRunStore(options: OpenRunStoreOptions): RunStore {
  mkdirSync(options.stateRoot, { recursive: true });
  return new RunStore(
    new DatabaseConstructor(databasePath(options.stateRoot)),
    {
      stateRoot: options.stateRoot
    }
  );
}

export function databasePath(stateRoot: string): string {
  return path.join(stateRoot, "symphonika.db");
}

function nextTransitionSequence(
  database: SqliteDatabase,
  runId: string
): number {
  const row = database
    .prepare(
      "select coalesce(max(sequence), 0) + 1 as next_sequence from run_state_transitions where run_id = ?"
    )
    .get(runId) as { next_sequence?: number } | undefined;

  return row?.next_sequence ?? 1;
}

function nextRoutineFiringTransitionSequence(
  database: SqliteDatabase,
  firingId: string
): number {
  const row = database
    .prepare(
      "select coalesce(max(sequence), 0) + 1 as next_sequence from routine_firing_state_transitions where firing_id = ?"
    )
    .get(firingId) as { next_sequence?: number } | undefined;

  return row?.next_sequence ?? 1;
}

function timestamp(): string {
  return new Date().toISOString();
}

function parseEvidenceIgnore(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.every((entry): entry is string => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function mapRunRow(row: RunRow): RunStatus {
  return {
    branchName: row.branch_name ?? "",
    cancelReason: (row.cancel_reason as CancelReason | null) ?? null,
    cancelRequested: row.cancel_requested === 1,
    continuationParentRunId: row.continuation_parent_run_id ?? null,
    createdAt: row.created_at,
    currentStateId: row.current_state_id ?? null,
    failureClassification:
      (row.failure_classification as FailureClassification | null) ?? null,
    id: row.id,
    isContinuation: row.is_continuation === 1,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    project: row.project_name,
    provider: row.provider_name ?? "",
    retryCount: row.retry_count ?? 0,
    state: row.state,
    stateTransitionReason: row.state_transition_reason ?? null,
    terminalReason: row.terminal_reason ?? null,
    terminalStateId: row.terminal_state_id ?? null,
    updatedAt: row.updated_at,
    workspacePath: row.workspace_path ?? ""
  };
}

function mapWatchdogSampleRow(row: WatchdogSampleRow): WatchdogSample {
  return {
    idleSince: row.idle_since,
    lastMessageAt: row.last_message_at,
    lastToolCallAt: row.last_tool_call_at,
    normalizedLogOffset: row.normalized_log_offset,
    normalizedLogPath: row.normalized_log_path,
    outputTokensTotal: row.output_tokens_total,
    runId: row.run_id,
    sampledAt: row.sampled_at,
    turnIdSetSize: row.turn_id_set_size,
    workspaceMtimeMax: row.workspace_mtime_max
  };
}

const RUN_ARTIFACT_KINDS: readonly RunArtifactKind[] = [
  "issue_snapshot",
  "prompt",
  "prompt_metadata",
  "workflow_graph",
  "provider_raw",
  "provider_normalized"
];

const ATTEMPT_ARTIFACT_KINDS: readonly RunArtifactKind[] = [
  "issue_snapshot",
  "prompt",
  "prompt_metadata",
  "workflow_graph",
  "provider_raw",
  "provider_normalized"
];

const ATTEMPT_ARTIFACT_KIND_SET: ReadonlySet<RunArtifactKind> = new Set(
  ATTEMPT_ARTIFACT_KINDS
);

function artifactPath(
  row: RunArtifactRow,
  kind: RunArtifactKind
): string | null {
  switch (kind) {
    case "issue_snapshot":
      return row.issue_snapshot_path;
    case "prompt":
      return row.prompt_path;
    case "prompt_metadata":
      return row.metadata_path;
    case "workflow_graph":
      return row.workflow_graph_path;
    case "provider_raw":
      return row.raw_log_path;
    case "provider_normalized":
      return row.normalized_log_path;
  }
}

function attemptArtifactPath(
  row: AttemptArtifactRow,
  kind: RunArtifactKind
): string | null {
  switch (kind) {
    case "issue_snapshot":
      return row.issue_snapshot_path;
    case "prompt":
      return row.prompt_path;
    case "prompt_metadata":
      return row.metadata_path;
    case "workflow_graph":
      return row.workflow_graph_path;
    case "provider_raw":
      return row.raw_log_path;
    case "provider_normalized":
      return row.normalized_log_path;
  }
}

function inferAttemptMetadataPath(
  promptPath: string | null,
  attemptNumber: number
): string | null {
  if (promptPath === null || promptPath.length === 0) {
    return null;
  }
  const directory = path.dirname(promptPath);
  const basename = path.basename(promptPath);
  if (basename === "prompt.md") {
    return path.join(directory, "prompt-metadata.json");
  }
  const attemptMatch = /^prompt\.attempt-(\d+)\.md$/.exec(basename);
  if (attemptMatch !== null) {
    return path.join(
      directory,
      `prompt-metadata.attempt-${attemptMatch[1]}.json`
    );
  }
  if (attemptNumber > 1) {
    return path.join(
      directory,
      `prompt-metadata.attempt-${attemptNumber}.json`
    );
  }
  return null;
}

function artifactSize(filePath: string): number | undefined {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

function mapProjectStateRow(row: ProjectStateRow): ProjectState {
  return {
    active: row.active === 1,
    createdAt: row.created_at,
    lastCandidateIssues: row.last_candidate_issues,
    lastDispatchedAt: row.last_dispatched_at ?? null,
    lastDispatchedIssueNumber: row.last_dispatched_issue_number ?? null,
    lastFetchedIssues: row.last_fetched_issues,
    lastFilteredIssues: row.last_filtered_issues,
    lastPollError: row.last_poll_error ?? null,
    lastPollFinishedAt: row.last_poll_finished_at ?? null,
    lastPollOk:
      row.last_poll_ok === null || row.last_poll_ok === undefined
        ? null
        : row.last_poll_ok === 1,
    lastPollStartedAt: row.last_poll_started_at ?? null,
    lastSuccessfulPollAt: row.last_successful_poll_at ?? null,
    projectName: row.project_name,
    schedulerCurrentWeight: row.scheduler_current_weight,
    updatedAt: row.updated_at,
    validationMessage: row.validation_message ?? null,
    validationState: row.validation_state,
    weight: row.weight
  };
}

function snapshotRepository(
  row:
    | { repository_name: string | null; repository_owner: string | null }
    | undefined
): ProjectSnapshotRepository | undefined {
  if (
    row === undefined ||
    row.repository_owner === null ||
    row.repository_name === null
  ) {
    return undefined;
  }
  return { owner: row.repository_owner, repo: row.repository_name };
}

function mapRoutineRow(row: RoutineRow): RoutineStatus {
  return {
    allowOverlap: row.allow_overlap === 1,
    catchUp: row.catch_up,
    disabledReason: row.disabled_reason ?? null,
    ...(row.effort === null ? {} : { effort: row.effort }),
    kind: row.kind,
    latestOutcome: null,
    lastAttemptedAt: row.last_attempted_at ?? null,
    lastFiredAt: row.last_fired_at ?? null,
    lastSkipAt: row.last_skip_at ?? null,
    lastSkipReason: row.last_skip_reason ?? null,
    ...(row.model === null ? {} : { model: row.model }),
    name: row.name,
    nextFireAt: row.state === "active" ? row.next_fire_at : null,
    ...(row.notify_enabled === 0 ? { notify: false } : {}),
    projectName: row.project_name,
    ...(row.permission_mode === null
      ? {}
      : { permissionMode: row.permission_mode }),
    provider: row.provider_name ?? null,
    pullRequestNumbers: [],
    scheduleAt: row.schedule_at.length === 0 ? null : row.schedule_at,
    scheduleCron: row.schedule_cron ?? null,
    scheduleTz: row.schedule_tz ?? null,
    skipCounts24h: {
      catch_up_window: 0,
      concurrency_cap: 0,
      overlap: 0
    },
    sourcePath: row.source_path,
    state: row.state,
    ...(row.timeout_minutes === null
      ? {}
      : { timeoutMinutes: row.timeout_minutes })
  };
}

function mapRoutineFiringRow(row: RoutineFiringRow): RoutineFiringStatus {
  return {
    branchName: row.branch_name ?? "",
    branchRef: row.branch_ref ?? "",
    cancelReason: row.cancel_reason ?? null,
    cancelRequested: row.cancel_requested === 1,
    commitsAhead: row.commits_ahead === 1,
    createdAt: row.created_at,
    fanoutId: row.fanout_id ?? null,
    id: row.id,
    kind: row.kind ?? null,
    ...(row.notification_state === null
      ? {}
      : {
          notificationError: row.notification_error ?? null,
          notificationState: row.notification_state
        }),
    outcome: mapRoutineOutcomeRow(row),
    projectName: row.project_name,
    provider: row.provider_name,
    providerCommand: row.provider_command,
    pullRequests: [],
    routineName: row.routine_name,
    scheduledAt: row.scheduled_at.length === 0 ? null : row.scheduled_at,
    state: row.state,
    terminalReason: row.terminal_reason ?? null,
    triggerSource: row.trigger_source,
    updatedAt: row.updated_at,
    workspacePath: row.workspace_path ?? "",
    workspacePrunedAt: row.workspace_pruned_at ?? null
  };
}

function mapRoutineOutcomeRow(
  row: RoutineOutcomeRow | undefined
): RoutineOutcome | null {
  if (
    row === undefined ||
    row.outcome_status === null ||
    row.outcome_action === null ||
    row.outcome_title === null ||
    row.outcome_summary === null ||
    row.outcome_verified === null ||
    row.outcome_source === null
  ) {
    return null;
  }
  return {
    action: row.outcome_action,
    source: row.outcome_source,
    status: row.outcome_status,
    summary: row.outcome_summary,
    title: row.outcome_title,
    url: row.outcome_url,
    verified: row.outcome_verified === 1
  };
}

function mapRoutinePullRequestRow(
  row: RoutinePullRequestRow
): RoutinePullRequestStatus {
  return {
    firingId: row.firing_id,
    headSha: row.head_sha,
    prNumber: row.pr_number,
    projectName: row.project_name,
    routineName: row.routine_name
  };
}

function normalizeProjectWeight(weight: number | undefined): number {
  if (weight === undefined || !Number.isInteger(weight) || weight <= 0) {
    return 1;
  }
  return weight;
}

function mapTrackedPullRequestRow(
  row: TrackedPullRequestRow
): TrackedPullRequest {
  return {
    branchName: row.branch_name,
    createdAt: row.created_at,
    headShaAtDispatch: row.head_sha_at_dispatch,
    id: row.id,
    issueNumber: row.issue_number,
    lastFollowupRunId: row.last_followup_run_id ?? null,
    lastObservedAt: row.last_observed_at,
    lastReviewDispatchFingerprint: row.last_review_dispatch_fingerprint ?? null,
    lastSeenHeadSha: row.last_seen_head_sha,
    projectName: row.project_name,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    reviewDispatchCount: row.review_dispatch_count,
    reviewFollowupCapReached: row.review_followup_cap_reached === 1,
    runId: row.run_id,
    state: row.state,
    updatedAt: row.updated_at
  };
}
