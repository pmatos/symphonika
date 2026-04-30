import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { databasePath, openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-run-store-lifecycle-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

function columnNames(database: Database.Database, table: string): string[] {
  const rows = database
    .prepare("select name from pragma_table_info(?)")
    .all(table) as { name: string }[];
  return rows.map((row) => row.name);
}

function seedRun(
  store: ReturnType<typeof openRunStore>,
  overrides: { id?: string; issueNumber?: number; projectName?: string } = {}
): string {
  const id = overrides.id ?? "run-1";
  store.createRun({
    id,
    issue: {
      body: "",
      created_at: "2025-01-01T00:00:00Z",
      id: 1000,
      labels: ["agent-ready"],
      number: overrides.issueNumber ?? 7,
      priority: 1,
      state: "open",
      title: "fixture",
      updated_at: "2025-01-01T00:00:00Z",
      url: "https://example/1"
    },
    projectName: overrides.projectName ?? "symphonika",
    providerCommand: "fake",
    providerName: "codex"
  });
  return id;
}

describe("run-store lifecycle CRUD", () => {
  it("markCancelRequested surfaces in listRuns", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      store.markCancelRequested(id, "closed_issue");

      const [run] = store.listRuns();
      expect(run).toMatchObject({
        id,
        cancelRequested: true,
        cancelReason: "closed_issue"
      });

      // idempotent
      store.markCancelRequested(id, "closed_issue");
    } finally {
      store.close();
    }
  });

  it("recordTerminalReason persists reason and classification", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      store.recordTerminalReason(id, "workspace_branch_conflict", "deterministic");

      const [run] = store.listRuns();
      expect(run).toMatchObject({
        terminalReason: "workspace_branch_conflict",
        failureClassification: "deterministic"
      });
    } finally {
      store.close();
    }
  });

  it("incrementRetryCount returns the new value across calls", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      expect(store.incrementRetryCount(id)).toBe(1);
      expect(store.incrementRetryCount(id)).toBe(2);
      expect(store.runRetryCount(id)).toBe(2);
    } finally {
      store.close();
    }
  });

  it("countSucceededContinuations counts only succeeded continuation runs for the issue", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "parent", issueNumber: 42 });
      store.updateRunState("parent", "succeeded");

      store.createContinuationRun({
        id: "cont-1",
        issue: {
          body: "",
          created_at: "2025-01-01T00:00:00Z",
          id: 1042,
          labels: ["agent-ready"],
          number: 42,
          priority: 1,
          state: "open",
          title: "fixture",
          updated_at: "2025-01-01T00:00:00Z",
          url: "https://example/42"
        },
        parentRunId: "parent",
        projectName: "symphonika",
        providerCommand: "fake",
        providerName: "codex"
      });
      store.updateRunState("cont-1", "succeeded");

      // sibling continuation that succeeded for a different issue must not count
      seedRun(store, { id: "other-parent", issueNumber: 99 });
      store.updateRunState("other-parent", "succeeded");

      expect(store.countSucceededContinuations("symphonika", 42)).toBe(1);
      expect(store.countSucceededContinuations("symphonika", 99)).toBe(0);
    } finally {
      store.close();
    }
  });

  it("listActiveRunIds returns non-terminal runs", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "queued", issueNumber: 1 });
      seedRun(store, { id: "running", issueNumber: 2 });
      store.updateRunState("running", "running");
      seedRun(store, { id: "done", issueNumber: 3 });
      store.updateRunState("done", "succeeded");

      const ids = store.listActiveRunIds().map((entry) => entry.runId).sort();
      expect(ids).toEqual(["queued", "running"]);
    } finally {
      store.close();
    }
  });

  it("createCapReachedFailureRun inserts a synthetic failed continuation row", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "parent", issueNumber: 8 });
      store.updateRunState("parent", "succeeded");

      store.createCapReachedFailureRun({
        id: "cap-1",
        issue: {
          body: "",
          created_at: "2025-01-01T00:00:00Z",
          id: 1008,
          labels: ["agent-ready"],
          number: 8,
          priority: 1,
          state: "open",
          title: "fixture",
          updated_at: "2025-01-01T00:00:00Z",
          url: "https://example/8"
        },
        parentRunId: "parent",
        projectName: "symphonika",
        reason: "continuation cap reached"
      });

      const cap = store
        .listRuns()
        .find((entry) => entry.id === "cap-1");
      expect(cap).toMatchObject({
        state: "failed",
        isContinuation: true,
        continuationParentRunId: "parent",
        terminalReason: "continuation cap reached",
        failureClassification: "deterministic",
        issueNumber: 8
      });
    } finally {
      store.close();
    }
  });
});

describe("run-store schema migration", () => {
  it("preserves existing rows when adding lifecycle columns to an old database", async () => {
    const root = await makeTempRoot();
    const dbPath = databasePath(root);
    const writer = new Database(dbPath);
    try {
      writer.exec(`
        create table runs (
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
        create table attempts (
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
          updated_at text not null
        );
        create table run_state_transitions (
          id integer primary key autoincrement,
          run_id text not null,
          sequence integer not null,
          state text not null,
          created_at text not null
        );
        create table provider_events (
          id integer primary key autoincrement,
          run_id text not null,
          attempt_id text not null,
          sequence integer not null,
          type text not null,
          raw_json text not null,
          normalized_json text not null,
          created_at text not null
        );
        insert into runs (
          id, project_name, issue_number, issue_title, state, issue_snapshot_json,
          created_at, updated_at
        ) values (
          'legacy-run', 'symphonika', 99, 't', 'succeeded', '{}',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
      `);
    } finally {
      writer.close();
    }

    const store = openRunStore({ stateRoot: root });
    store.close();

    const reader = new Database(dbPath, { readonly: true });
    try {
      expect(columnNames(reader, "runs")).toEqual(
        expect.arrayContaining([
          "is_continuation",
          "retry_count",
          "cancel_requested"
        ])
      );
      const row = reader.prepare("select id, retry_count, is_continuation from runs where id = ?").get("legacy-run") as
        | { id: string; retry_count: number; is_continuation: number }
        | undefined;
      expect(row).toEqual({
        id: "legacy-run",
        retry_count: 0,
        is_continuation: 0
      });
    } finally {
      reader.close();
    }
  });

  it("adds lifecycle columns on a fresh database", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    store.close();

    const database = new Database(databasePath(root), { readonly: true });
    try {
      const runs = columnNames(database, "runs");
      expect(runs).toEqual(
        expect.arrayContaining([
          "is_continuation",
          "continuation_parent_run_id",
          "retry_count",
          "failure_classification",
          "terminal_reason",
          "cancel_requested",
          "cancel_reason"
        ])
      );

      const attempts = columnNames(database, "attempts");
      expect(attempts).toEqual(expect.arrayContaining(["failure_classification"]));
    } finally {
      database.close();
    }
  });
});
