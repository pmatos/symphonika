import { mkdirSync } from "node:fs";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import type { IssueSnapshot } from "./issue-polling.js";
import type { AgentProviderName, NormalizedProviderEvent } from "./provider.js";

export type RunState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "input_required"
  | "failed"
  | "succeeded"
  | "cancelled"
  | "stale";

export type FailureClassification = "transient" | "deterministic" | "input_required";

export type CancelReason = "closed_issue" | "eligibility_loss" | "operator";

export type RunStatus = {
  branchName: string;
  cancelReason: CancelReason | null;
  cancelRequested: boolean;
  continuationParentRunId: string | null;
  failureClassification: FailureClassification | null;
  id: string;
  isContinuation: boolean;
  issueNumber: number;
  issueSnapshotPath: string;
  metadataPath: string;
  normalizedLogPath: string;
  project: string;
  promptPath: string;
  provider: string;
  rawLogPath: string;
  retryCount: number;
  state: RunState;
  terminalReason: string | null;
  workspacePath: string;
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
  failure_classification: string | null;
  id: string;
  is_continuation: number;
  issue_number: number;
  issue_snapshot_path: string | null;
  metadata_path: string | null;
  normalized_log_path: string | null;
  project_name: string;
  prompt_path: string | null;
  provider_name: string | null;
  raw_log_path: string | null;
  retry_count: number;
  state: RunState;
  terminal_reason: string | null;
  workspace_path: string | null;
};

export class RunStore {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
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

  createContinuationRun(input: CreateRunInput & { parentRunId: string }): void {
    this.insertRunRow({
      ...input,
      isContinuation: true,
      parentRunId: input.parentRunId,
      providerCommand: input.providerCommand,
      providerName: input.providerName,
      state: "queued"
    });
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
        .prepare("update runs set terminal_reason = ?, updated_at = ? where id = ?")
        .run(reason, timestamp(), runId);
      return;
    }
    this.database
      .prepare(
        "update runs set terminal_reason = ?, failure_classification = ?, updated_at = ? where id = ?"
      )
      .run(reason, classification, timestamp(), runId);
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

  listActiveRunIds(): { runId: string; projectName: string; issueNumber: number }[] {
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

  countSucceededContinuations(projectName: string, issueNumber: number): number {
    const row = this.database
      .prepare(
        "select count(*) as count from runs where project_name = ? and issue_number = ? and state = 'succeeded' and is_continuation = 1"
      )
      .get(projectName, issueNumber) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  updateRunState(runId: string, state: RunState): void {
    const now = timestamp();
    this.database
      .prepare("update runs set state = ?, updated_at = ? where id = ?")
      .run(state, now, runId);
    this.recordRunTransition(runId, state, now);
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
          "workspace_path, branch_name, prompt_path, issue_snapshot_path,",
          "raw_log_path, normalized_log_path, created_at, updated_at",
          ") values (",
          "@id, @run_id, @attempt_number, @state, @provider_name, @provider_command,",
          "@workspace_path, @branch_name, @prompt_path, @issue_snapshot_path,",
          "@raw_log_path, @normalized_log_path, @created_at, @updated_at",
          ")"
        ].join(" ")
      )
      .run({
        attempt_number: input.attemptNumber,
        branch_name: input.branchName,
        created_at: now,
        id: input.id,
        issue_snapshot_path: input.issueSnapshotPath,
        normalized_log_path: input.normalizedLogPath,
        prompt_path: input.promptPath,
        provider_command: input.providerCommand,
        provider_name: input.providerName,
        raw_log_path: input.rawLogPath,
        run_id: input.runId,
        state: input.state,
        updated_at: now,
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

  listRuns(): RunStatus[] {
    const rows = this.database
      .prepare(
        [
          "select id, project_name, issue_number, state, provider_name,",
          "workspace_path, branch_name, prompt_path, metadata_path,",
          "issue_snapshot_path, raw_log_path, normalized_log_path,",
          "is_continuation, continuation_parent_run_id, retry_count,",
          "failure_classification, terminal_reason, cancel_requested, cancel_reason",
          "from runs order by created_at desc, id desc"
        ].join(" ")
      )
      .all() as RunRow[];

    return rows.map((row) => mapRunRow(row));
  }

  markCancelRequested(runId: string, reason: CancelReason): void {
    this.database
      .prepare(
        "update runs set cancel_requested = 1, cancel_reason = ?, updated_at = ? where id = ?"
      )
      .run(reason, timestamp(), runId);
  }

  markLeakedRunsAsStale(
    reason = "leaked_active_run"
  ): { runId: string; projectName: string; issueNumber: number }[] {
    const rows = this.database
      .prepare(
        "select id, project_name, issue_number from runs where state in ('queued','preparing_workspace','running')"
      )
      .all() as { id: string; project_name: string; issue_number: number }[];
    const swept = rows.map((row) => ({
      issueNumber: row.issue_number,
      projectName: row.project_name,
      runId: row.id
    }));
    for (const entry of swept) {
      this.recordTerminalReason(entry.runId, reason);
      this.updateRunState(entry.runId, "stale");
    }
    return swept;
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
    `);

    const additions: Array<[string, string, string]> = [
      ["runs", "is_continuation", "integer not null default 0"],
      ["runs", "continuation_parent_run_id", "text"],
      ["runs", "retry_count", "integer not null default 0"],
      ["runs", "failure_classification", "text"],
      ["runs", "terminal_reason", "text"],
      ["runs", "cancel_requested", "integer not null default 0"],
      ["runs", "cancel_reason", "text"],
      ["attempts", "failure_classification", "text"]
    ];

    const apply = this.database.transaction(() => {
      for (const [table, column, decl] of additions) {
        this.ensureColumn(table, column, decl);
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
}

export function openRunStore(options: OpenRunStoreOptions): RunStore {
  mkdirSync(options.stateRoot, { recursive: true });
  return new RunStore(new DatabaseConstructor(databasePath(options.stateRoot)));
}

export function databasePath(stateRoot: string): string {
  return path.join(stateRoot, "symphonika.db");
}

function nextTransitionSequence(database: SqliteDatabase, runId: string): number {
  const row = database
    .prepare(
      "select coalesce(max(sequence), 0) + 1 as next_sequence from run_state_transitions where run_id = ?"
    )
    .get(runId) as { next_sequence?: number } | undefined;

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
    failureClassification:
      (row.failure_classification as FailureClassification | null) ?? null,
    id: row.id,
    isContinuation: row.is_continuation === 1,
    issueNumber: row.issue_number,
    issueSnapshotPath: row.issue_snapshot_path ?? "",
    metadataPath: row.metadata_path ?? "",
    normalizedLogPath: row.normalized_log_path ?? "",
    project: row.project_name,
    promptPath: row.prompt_path ?? "",
    provider: row.provider_name ?? "",
    rawLogPath: row.raw_log_path ?? "",
    retryCount: row.retry_count ?? 0,
    state: row.state,
    terminalReason: row.terminal_reason ?? null,
    workspacePath: row.workspace_path ?? ""
  };
}
