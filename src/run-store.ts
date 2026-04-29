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

export type RunStatus = {
  branchName: string;
  id: string;
  issueNumber: number;
  issueSnapshotPath: string;
  metadataPath: string;
  normalizedLogPath: string;
  project: string;
  promptPath: string;
  provider: string;
  rawLogPath: string;
  state: RunState;
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
  id: string;
  issue_number: number;
  issue_snapshot_path: string | null;
  metadata_path: string | null;
  normalized_log_path: string | null;
  project_name: string;
  prompt_path: string | null;
  provider_name: string | null;
  raw_log_path: string | null;
  state: RunState;
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
    const now = timestamp();
    this.database
      .prepare(
        [
          "insert into runs (",
          "id, project_name, issue_number, issue_title, state, issue_snapshot_json,",
          "provider_name, provider_command, created_at, updated_at",
          ") values (",
          "@id, @project_name, @issue_number, @issue_title, @state, @issue_snapshot_json,",
          "@provider_name, @provider_command, @created_at, @updated_at",
          ")"
        ].join(" ")
      )
      .run({
        created_at: now,
        id: input.id,
        issue_number: input.issue.number,
        issue_snapshot_json: JSON.stringify(input.issue),
        issue_title: input.issue.title,
        project_name: input.projectName,
        provider_command: input.providerCommand,
        provider_name: input.providerName,
        state: "queued",
        updated_at: now
      });
    this.recordRunTransition(input.id, "queued", now);
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
          "issue_snapshot_path, raw_log_path, normalized_log_path",
          "from runs order by created_at desc, id desc"
        ].join(" ")
      )
      .all() as RunRow[];

    return rows.map((row) => ({
      branchName: row.branch_name ?? "",
      id: row.id,
      issueNumber: row.issue_number,
      issueSnapshotPath: row.issue_snapshot_path ?? "",
      metadataPath: row.metadata_path ?? "",
      normalizedLogPath: row.normalized_log_path ?? "",
      project: row.project_name,
      promptPath: row.prompt_path ?? "",
      provider: row.provider_name ?? "",
      rawLogPath: row.raw_log_path ?? "",
      state: row.state,
      workspacePath: row.workspace_path ?? ""
    }));
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
