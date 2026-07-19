import { createReadStream, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import type { IssueSnapshot } from "./issue-polling.js";
import { isPathInside } from "./path-safety.js";
import type { AgentProviderName, NormalizedProviderEvent } from "./provider.js";
import { nextRecurringFireAt } from "./routines/schedule.js";
import type {
  RoutineDeclaration,
  RoutineFiringState,
  RoutineKind,
  RoutineState,
  RoutineStatus
} from "./routines/types.js";
import type { ExpandedWorkflow } from "./workflow.js";

export type RunState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "input_required"
  | "failed"
  | "succeeded"
  | "cancelled"
  | "stale"
  | "waiting";

export type FailureClassification =
  "transient" | "deterministic" | "input_required";

export type CancelReason =
  "closed_issue" | "eligibility_loss" | "no_progress" | "operator";

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
  projectName: string;
  schedulerCurrentWeight: number;
  updatedAt: string;
  validationMessage: string | null;
  validationState: ProjectValidationState;
  weight: number;
};

export type RoutineFiringStatus = {
  createdAt: string;
  id: string;
  projectName: string;
  provider: AgentProviderName;
  providerCommand: string;
  routineName: string;
  state: RoutineFiringState;
  terminalReason: string | null;
  updatedAt: string;
  workspacePath: string;
};

export type RoutineFiringStateTransition = {
  createdAt: string;
  sequence: number;
  state: RoutineFiringState;
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
  issueNumber: number;
  normalizedLogPath: string;
  projectName: string;
  runId: string;
  state: Extract<RunState, "running">;
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
  state?: RunState;
};

export type OpenRunStoreOptions = {
  stateRoot: string;
};

export type CreateRunInput = {
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
  id: string;
  issue_number: number;
  normalized_log_path: string | null;
  project_name: string;
  state: WatchdogCandidateRun["state"];
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
  project_name: string;
  scheduler_current_weight: number;
  updated_at: string;
  validation_message: string | null;
  validation_state: ProjectValidationState;
  weight: number;
};

type RoutineRow = {
  created_at: string;
  kind: RoutineKind;
  last_fired_at: string | null;
  name: string;
  next_fire_at: string | null;
  project_name: string;
  provider_name: AgentProviderName | null;
  schedule_at: string;
  schedule_cron: string | null;
  schedule_tz: string | null;
  source_path: string;
  state: RoutineState;
  updated_at: string;
};

type RoutineFiringRow = {
  created_at: string;
  id: string;
  project_name: string;
  provider_command: string;
  provider_name: AgentProviderName;
  routine_name: string;
  state: RoutineFiringState;
  terminal_reason: string | null;
  updated_at: string;
  workspace_path: string | null;
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

export class RunStore {
  private readonly database: SqliteDatabase;
  private readonly stateRoot: string;

  constructor(database: SqliteDatabase, options: { stateRoot?: string } = {}) {
    this.database = database;
    this.stateRoot = path.resolve(options.stateRoot ?? process.cwd());
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  createRun(input: CreateRunInput): void {
    this.insertRunRow({
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
      this.insertRunRow({
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
    });
    apply();
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

  createContinuationRun(input: CreateRunInput & { parentRunId: string }): void {
    this.insertRunRow({
      ...input,
      isContinuation: true,
      parentRunId: input.parentRunId,
      providerCommand: input.providerCommand,
      providerName: input.providerName,
      state: "queued"
    });
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
    this.insertRunRow({
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
          "select id, project_name, issue_number, state,",
          "workspace_path, normalized_log_path",
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
      issueNumber: row.issue_number,
      normalizedLogPath: row.normalized_log_path ?? "",
      projectName: row.project_name,
      runId: row.id,
      state: row.state,
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

  upsertWatchdogSample(sample: WatchdogSample): void {
    this.database
      .prepare(
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
      )
      .run({
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
      });
  }

  rememberWatchdogTurnIds(runId: string, turnIds: Iterable<string>): number {
    const insert = this.database.prepare(
      "insert or ignore into watchdog_turn_ids (run_id, turn_id) values (?, ?)"
    );
    const count = this.database.prepare(
      "select count(*) as count from watchdog_turn_ids where run_id = ?"
    );
    const apply = this.database.transaction(() => {
      for (const turnId of turnIds) {
        insert.run(runId, turnId);
      }
      return count.get(runId) as { count: number };
    });
    return apply().count;
  }

  markRunNoProgressStale(runId: string, updatedAt = timestamp()): boolean {
    const result = this.database
      .prepare(
        [
          "update runs set",
          "state = 'stale',",
          "terminal_reason = 'no_progress',",
          "failure_classification = 'deterministic',",
          "updated_at = ?",
          "where id = ?",
          "and state = 'running'",
          "and cancel_requested = 0"
        ].join(" ")
      )
      .run(updatedAt, runId);
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

  private insertRunRow(input: {
    id: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    parentRunId: string | null;
    projectName: string;
    providerCommand: string | null;
    providerName: AgentProviderName | null;
    state: RunState;
  }): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "insert into runs (",
          "id, project_name, issue_number, issue_title, state, issue_snapshot_json,",
          "provider_name, provider_command, is_continuation, continuation_parent_run_id,",
          "created_at, updated_at",
          ") values (",
          "@id, @project_name, @issue_number, @issue_title, @state, @issue_snapshot_json,",
          "@provider_name, @provider_command, @is_continuation, @continuation_parent_run_id,",
          "@created_at, @updated_at",
          ")"
        ].join(" ")
      )
      .run({
        continuation_parent_run_id: input.parentRunId,
        created_at: now,
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
    this.recordRunTransition(input.id, input.state, now);
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

      const rows = this.database
        .prepare("select project_name from project_states where active = 1")
        .all() as { project_name: string }[];
      for (const row of rows) {
        if (activeNames.has(row.project_name)) {
          continue;
        }
        this.database
          .prepare(
            "update project_states set active = 0, validation_state = 'inactive', validation_message = null, updated_at = ? where project_name = ?"
          )
          .run(now, row.project_name);
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
          "last_poll_started_at, last_poll_finished_at, last_poll_ok, last_poll_error,",
          "last_fetched_issues, last_candidate_issues, last_filtered_issues,",
          "created_at, updated_at",
          ") values (",
          "@project_name, 1, 1, @validation_state, @validation_message,",
          "@last_poll_started_at, @last_poll_finished_at, @last_poll_ok, @last_poll_error,",
          "@last_fetched_issues, @last_candidate_issues, @last_filtered_issues,",
          "@created_at, @updated_at",
          ")",
          "on conflict(project_name) do update set",
          "validation_state = excluded.validation_state,",
          "validation_message = excluded.validation_message,",
          "last_poll_started_at = excluded.last_poll_started_at,",
          "last_poll_finished_at = excluded.last_poll_finished_at,",
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
        project_name: input.projectName,
        updated_at: now,
        validation_message: message,
        validation_state: validationState
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
          "last_poll_started_at, last_poll_finished_at, last_poll_ok, last_poll_error,",
          "last_fetched_issues, last_candidate_issues, last_filtered_issues,",
          "scheduler_current_weight, last_dispatched_at, last_dispatched_issue_number,",
          "created_at, updated_at",
          "from project_states order by project_name asc"
        ].join(" ")
      )
      .all() as ProjectStateRow[];
    return rows.map((row) => mapProjectStateRow(row));
  }

  syncRoutines(
    projectName: string,
    routines: RoutineDeclaration[],
    options: { now?: Date; recomputeRecurring?: boolean } = {}
  ): void {
    const now = timestamp();
    const scheduleNow = options.now ?? new Date();
    const upsert = this.database.prepare(
      [
        "insert into routines (",
        "project_name, name, source_path, kind, provider_name, schedule_at, schedule_cron, schedule_tz, next_fire_at, prompt_body, state, created_at, updated_at",
        ") values (",
        "@project_name, @name, @source_path, @kind, @provider_name, @schedule_at, @schedule_cron, @schedule_tz, @next_fire_at, @prompt_body, 'active', @created_at, @updated_at",
        ")",
        "on conflict(project_name, name) do update set",
        "source_path = excluded.source_path,",
        "kind = excluded.kind,",
        "provider_name = excluded.provider_name,",
        "schedule_at = excluded.schedule_at,",
        "schedule_cron = excluded.schedule_cron,",
        "schedule_tz = excluded.schedule_tz,",
        "next_fire_at = case",
        "when @recompute_recurring = 1 and excluded.schedule_cron is not null then excluded.next_fire_at",
        "when routines.schedule_at is not excluded.schedule_at or routines.schedule_cron is not excluded.schedule_cron or routines.schedule_tz is not excluded.schedule_tz then excluded.next_fire_at",
        "when routines.next_fire_at is null and routines.state != 'expired' then excluded.next_fire_at",
        "else routines.next_fire_at end,",
        "prompt_body = excluded.prompt_body,",
        "last_fired_at = case",
        "when routines.schedule_at is not excluded.schedule_at or routines.schedule_cron is not excluded.schedule_cron or routines.schedule_tz is not excluded.schedule_tz then null",
        "else routines.last_fired_at end,",
        // Recurring schedules remain active; unchanged expired one-shots stay expired.
        "state = case",
        "when excluded.schedule_cron is not null then 'active'",
        "when routines.schedule_at is not excluded.schedule_at then 'active'",
        "when routines.state = 'expired' then 'expired'",
        "else 'active' end,",
        "updated_at = excluded.updated_at"
      ].join(" ")
    );
    const apply = this.database.transaction(() => {
      if (routines.length === 0) {
        this.database
          .prepare("delete from routines where project_name = ?")
          .run(projectName);
      } else {
        const names = routines.map((routine) => routine.name);
        const placeholders = names.map(() => "?").join(", ");
        this.database
          .prepare(
            `delete from routines where project_name = ? and name not in (${placeholders})`
          )
          .run(projectName, ...names);
      }
      for (const routine of routines) {
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
        upsert.run({
          created_at: now,
          kind: routine.kind,
          name: routine.name,
          project_name: projectName,
          prompt_body: routine.prompt,
          provider_name: routine.provider,
          next_fire_at: scheduleValues.nextFireAt,
          recompute_recurring: options.recomputeRecurring === true ? 1 : 0,
          // Existing databases have a NOT NULL schedule_at column. An empty
          // legacy value identifies recurring rows; schedule_cron is canonical.
          schedule_at: scheduleValues.scheduleAt,
          schedule_cron: scheduleValues.scheduleCron,
          schedule_tz: scheduleValues.scheduleTz,
          source_path: routine.sourcePath,
          updated_at: now
        });
      }
    });
    apply();
  }

  pruneRoutinesForUnknownProjects(projectNames: Iterable<string>): void {
    const now = timestamp();
    const names = [...new Set(projectNames)];
    if (names.length === 0) {
      this.database
        .prepare("update routines set state = 'inactive', updated_at = ?")
        .run(now);
      return;
    }
    const placeholders = names.map(() => "?").join(", ");
    this.database
      .prepare(
        `update routines set state = 'inactive', updated_at = ? where project_name not in (${placeholders})`
      )
      .run(now, ...names);
  }

  listRoutines(filter: { project?: string } = {}): RoutineStatus[] {
    const conditions: string[] = ["state != 'inactive'"];
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
          "select project_name, name, source_path, kind, provider_name, schedule_at, schedule_cron, schedule_tz, next_fire_at, state, last_fired_at, created_at, updated_at",
          "from routines",
          where,
          "order by project_name asc, name asc"
        ]
          .filter((part) => part.length > 0)
          .join(" ")
      )
      .all(params) as RoutineRow[];
    return rows.map((row) => mapRoutineRow(row));
  }

  getRoutine(input: {
    name: string;
    projectName: string;
  }): (RoutineStatus & { prompt: string }) | undefined {
    const row = this.database
      .prepare(
        [
          "select project_name, name, source_path, kind, provider_name, schedule_at, schedule_cron, schedule_tz, next_fire_at, state, last_fired_at, created_at, updated_at, prompt_body",
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

  advanceRecurringRoutine(input: {
    nextFireAt: string;
    name: string;
    projectName: string;
    skippedAt: string;
  }): boolean {
    const result = this.database
      .prepare(
        [
          "update routines set next_fire_at = @next_fire_at, updated_at = @updated_at",
          "where project_name = @project_name and name = @name",
          "and state = 'active' and schedule_cron is not null",
          "and next_fire_at is not null and next_fire_at <= @skipped_at"
        ].join(" ")
      )
      .run({
        name: input.name,
        next_fire_at: input.nextFireAt,
        project_name: input.projectName,
        skipped_at: input.skippedAt,
        updated_at: timestamp()
      });
    return result.changes > 0;
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

  createRoutineFiring(input: {
    id: string;
    projectName: string;
    providerCommand: string;
    providerName: AgentProviderName;
    routineName: string;
  }): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "insert into routine_firings (",
          "id, project_name, routine_name, state, provider_name, provider_command, created_at, updated_at",
          ") values (",
          "@id, @project_name, @routine_name, 'queued', @provider_name, @provider_command, @created_at, @updated_at",
          ")"
        ].join(" ")
      )
      .run({
        created_at: now,
        id: input.id,
        project_name: input.projectName,
        provider_command: input.providerCommand,
        provider_name: input.providerName,
        routine_name: input.routineName,
        updated_at: now
      });
    this.recordRoutineFiringTransition(input.id, "queued", now);
  }

  claimRoutineFiring(input: {
    firedAt: string;
    firingId: string;
    nextFireAt?: string;
    projectName: string;
    providerCommand: string;
    providerName: AgentProviderName;
    routineName: string;
  }): boolean {
    const claim = this.database.transaction(() => {
      this.createRoutineFiring({
        id: input.firingId,
        projectName: input.projectName,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        routineName: input.routineName
      });
      const result = this.database
        .prepare(
          [
            "update routines set",
            "state = case when schedule_cron is null then 'expired' else 'active' end,",
            "next_fire_at = case when schedule_cron is null then null else @next_fire_at end,",
            "last_fired_at = @fired_at,",
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
    });
    try {
      claim();
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
    id: string;
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
          "workspace_path = coalesce(@workspace_path, workspace_path),",
          "updated_at = @updated_at",
          "where id = @id"
        ].join(" ")
      )
      .run({
        id: input.id,
        state: input.state,
        terminal_reason: input.terminalReason ?? null,
        updated_at: now,
        workspace_path: input.workspacePath ?? null
      });
    this.recordRoutineFiringTransition(input.id, input.state, now);
  }

  updateRoutineFiringWorkspace(input: {
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
          "prompt_path = coalesce(@prompt_path, prompt_path),",
          "raw_log_path = coalesce(@raw_log_path, raw_log_path),",
          "normalized_log_path = coalesce(@normalized_log_path, normalized_log_path),",
          "updated_at = @updated_at",
          "where id = @id"
        ].join(" ")
      )
      .run({
        id: input.id,
        normalized_log_path: input.normalizedLogPath ?? null,
        prompt_path: input.promptPath ?? null,
        raw_log_path: input.rawLogPath ?? null,
        updated_at: timestamp(),
        workspace_path: input.workspacePath
      });
  }

  listRoutineFirings(filter: { project?: string } = {}): RoutineFiringStatus[] {
    const conditions: string[] = [];
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
          "select id, project_name, routine_name, state, provider_name, provider_command, workspace_path, terminal_reason, created_at, updated_at",
          "from routine_firings",
          where,
          "order by created_at desc, id desc"
        ]
          .filter((part) => part.length > 0)
          .join(" ")
      )
      .all(params) as RoutineFiringRow[];
    return rows.map((row) => mapRoutineFiringRow(row));
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
    this.database
      .prepare("update runs set state = ?, updated_at = ? where id = ?")
      .run(state, now, runId);
    this.recordRunTransition(runId, state, now);
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
    if (filter?.state !== undefined) {
      conditions.push("state = @state");
      params.state = filter.state;
    }
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
          "last_followup_run_id, state, last_observed_at, created_at, updated_at",
          "from tracked_pull_requests",
          "where state = 'open'",
          "order by last_observed_at asc, id asc"
        ].join(" ")
      )
      .all() as TrackedPullRequestRow[];

    return rows.map((row) => mapTrackedPullRequestRow(row));
  }

  recordPullRequestObservation(input: {
    headSha: string;
    id: number;
    prUrl: string;
    state: PullRequestTrackingState;
  }): void {
    const now = timestamp();
    this.database
      .prepare(
        [
          "update tracked_pull_requests set",
          "pr_url = @pr_url,",
          "last_seen_head_sha = @last_seen_head_sha,",
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
        "update runs set cancel_requested = 1, cancel_reason = ?, updated_at = ? where id = ?"
      )
      .run(reason, timestamp(), runId);
  }

  markLeakedRunsAsStale(reason = "leaked_active_run"): {
    runId: string;
    projectName: string;
    issueNumber: number;
    previousState: RunState;
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
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, state from runs",
          "where state in ('queued','preparing_workspace','running')",
          "or (state = 'waiting' and current_state_id is null)"
        ].join(" ")
      )
      .all() as {
      id: string;
      project_name: string;
      issue_number: number;
      state: RunState;
    }[];
    const swept = rows.map((row) => ({
      issueNumber: row.issue_number,
      previousState: row.state,
      projectName: row.project_name,
      runId: row.id
    }));
    const update = this.database.prepare(
      [
        "update runs set",
        "state = 'stale',",
        "terminal_reason = ?,",
        "updated_at = ?",
        "where id = ?"
      ].join(" ")
    );
    const apply = this.database.transaction(() => {
      for (const entry of swept) {
        const updatedAt = timestamp();
        update.run(reason, updatedAt, entry.runId);
        this.recordRunTransition(entry.runId, "stale", updatedAt);
      }
    });
    apply();
    return swept;
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
        "updated_at = ?",
        "where id = ?"
      ].join(" ")
    );
    const apply = this.database.transaction(() => {
      for (const entry of migrated) {
        const updatedAt = timestamp();
        update.run(
          INPUT_REQUIRED_LEGACY_TERMINAL_REASON,
          updatedAt,
          entry.runId
        );
        this.recordRunTransition(entry.runId, "failed", updatedAt);
      }
    });
    apply();
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
        schedule_at text not null,
        schedule_cron text,
        schedule_tz text,
        next_fire_at text,
        prompt_body text not null,
        state text not null,
        last_fired_at text,
        created_at text not null,
        updated_at text not null,
        primary key (project_name, name)
      );

      create table if not exists routine_firings (
        id text primary key,
        project_name text not null,
        routine_name text not null,
        state text not null,
        provider_name text not null,
        provider_command text not null,
        workspace_path text,
        prompt_path text,
        raw_log_path text,
        normalized_log_path text,
        terminal_reason text,
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
    `);

    const additions: Array<[string, string, string]> = [
      ["runs", "is_continuation", "integer not null default 0"],
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
      ["attempts", "failure_classification", "text"],
      ["attempts", "metadata_path", "text"],
      ["attempts", "workflow_graph_path", "text"],
      ["watchdog_samples", "normalized_log_path", "text not null default ''"],
      ["watchdog_samples", "last_message_at", "text"],
      ["routines", "schedule_cron", "text"],
      ["routines", "schedule_tz", "text"],
      ["routines", "next_fire_at", "text"],
      ["routine_firings", "prompt_path", "text"],
      ["routine_firings", "raw_log_path", "text"],
      ["routine_firings", "normalized_log_path", "text"]
    ];

    const apply = this.database.transaction(() => {
      for (const [table, column, decl] of additions) {
        this.ensureColumn(table, column, decl);
      }
    });
    apply();
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

  private ensureColumn(table: string, column: string, decl: string): void {
    const existing = this.database
      .prepare("select name from pragma_table_info(?)")
      .all(table) as { name: string }[];
    if (existing.some((row) => row.name === column)) {
      return;
    }

    this.database.exec(`alter table ${table} add column ${column} ${decl};`);
  }

  private recordRunTransition(
    runId: string,
    state: RunState,
    createdAt: string
  ): void {
    const sequence = nextTransitionSequence(this.database, runId);
    this.database
      .prepare(
        "insert into run_state_transitions (run_id, sequence, state, created_at) values (?, ?, ?, ?)"
      )
      .run(runId, sequence, state, createdAt);
  }

  private recordRoutineFiringTransition(
    firingId: string,
    state: RoutineFiringState,
    createdAt: string
  ): void {
    const sequence = nextRoutineFiringTransitionSequence(
      this.database,
      firingId
    );
    this.database
      .prepare(
        "insert into routine_firing_state_transitions (firing_id, sequence, state, created_at) values (?, ?, ?, ?)"
      )
      .run(firingId, sequence, state, createdAt);
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
    projectName: row.project_name,
    schedulerCurrentWeight: row.scheduler_current_weight,
    updatedAt: row.updated_at,
    validationMessage: row.validation_message ?? null,
    validationState: row.validation_state,
    weight: row.weight
  };
}

function mapRoutineRow(row: RoutineRow): RoutineStatus {
  return {
    kind: row.kind,
    lastFiredAt: row.last_fired_at ?? null,
    name: row.name,
    nextFireAt: row.state === "active" ? row.next_fire_at : null,
    projectName: row.project_name,
    provider: row.provider_name ?? null,
    scheduleAt: row.schedule_at.length === 0 ? null : row.schedule_at,
    scheduleCron: row.schedule_cron ?? null,
    scheduleTz: row.schedule_tz ?? null,
    sourcePath: row.source_path,
    state: row.state
  };
}

function mapRoutineFiringRow(row: RoutineFiringRow): RoutineFiringStatus {
  return {
    createdAt: row.created_at,
    id: row.id,
    projectName: row.project_name,
    provider: row.provider_name,
    providerCommand: row.provider_command,
    routineName: row.routine_name,
    state: row.state,
    terminalReason: row.terminal_reason ?? null,
    updatedAt: row.updated_at,
    workspacePath: row.workspace_path ?? ""
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
    runId: row.run_id,
    state: row.state,
    updatedAt: row.updated_at
  };
}
