import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { databasePath, openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-run-store-lifecycle-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
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
  overrides: {
    evidenceIgnore?: readonly string[];
    id?: string;
    issueNumber?: number;
    projectName?: string;
    url?: string;
  } = {}
): string {
  const id = overrides.id ?? "run-1";
  store.createRun({
    ...(overrides.evidenceIgnore === undefined
      ? {}
      : { evidenceIgnore: overrides.evidenceIgnore }),
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
      url: overrides.url ?? "https://example/1"
    },
    projectName: overrides.projectName ?? "symphonika",
    providerCommand: "fake",
    providerName: "codex"
  });
  return id;
}

function evidence(branchName: string) {
  return {
    branchName,
    branchRef: `refs/heads/${branchName}`,
    issueSnapshotPath: "/tmp/issue-snapshot.json",
    metadataPath: "/tmp/prompt-metadata.json",
    normalizedLogPath: "/tmp/provider.normalized.jsonl",
    promptPath: "/tmp/prompt.md",
    rawLogPath: "/tmp/provider.raw.jsonl",
    workflowGraphPath: "/tmp/workflow-graph.json",
    workspacePath: "/tmp/workspace"
  };
}

describe("run-store lifecycle CRUD", () => {
  it("persists project cursor and validation state across store reopen", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      store.syncProjectStates([
        { name: "alpha", weight: 2 },
        { name: "beta", weight: 1 }
      ]);
      store.recordProjectPollOutcome({
        candidateIssues: 2,
        fetchedIssues: 4,
        filteredIssues: 1,
        ok: true,
        projectName: "alpha"
      });
      store.recordProjectPollOutcome({
        candidateIssues: 0,
        error:
          "projects.beta.tracker.token references unset environment variable $BETA_TOKEN",
        fetchedIssues: 0,
        filteredIssues: 0,
        ok: false,
        projectName: "beta"
      });
      store.recordProjectDispatchSelection({
        issueNumber: 12,
        projectName: "alpha",
        schedulerWeights: [
          { currentWeight: -1, projectName: "alpha", weight: 2 },
          { currentWeight: 1, projectName: "beta", weight: 1 }
        ]
      });
    } finally {
      store.close();
    }

    const reopened = openRunStore({ stateRoot: root });
    try {
      const states = reopened.listProjectStates();
      expect(states.map((state) => state.projectName)).toEqual([
        "alpha",
        "beta"
      ]);
      expect(states[0]).toMatchObject({
        active: true,
        lastCandidateIssues: 2,
        lastDispatchedIssueNumber: 12,
        lastFetchedIssues: 4,
        lastFilteredIssues: 1,
        lastPollError: null,
        lastPollOk: true,
        projectName: "alpha",
        schedulerCurrentWeight: -1,
        validationMessage: null,
        validationState: "valid",
        weight: 2
      });
      expect(states[0]?.lastDispatchedAt).toEqual(expect.any(String));
      expect(states[0]?.lastPollFinishedAt).toEqual(expect.any(String));
      expect(states[1]).toMatchObject({
        active: true,
        lastCandidateIssues: 0,
        lastDispatchedAt: null,
        lastDispatchedIssueNumber: null,
        lastFetchedIssues: 0,
        lastFilteredIssues: 0,
        lastPollOk: false,
        projectName: "beta",
        schedulerCurrentWeight: 1,
        validationState: "invalid",
        weight: 1
      });
      expect(states[1]?.lastPollError).toContain("BETA_TOKEN");
      expect(states[1]?.validationMessage).toContain("BETA_TOKEN");
    } finally {
      reopened.close();
    }
  });

  it("reactivates project metadata when dispatch records scheduler state", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      store.syncProjectStates([{ name: "alpha", weight: 5 }]);
      store.syncProjectStates([]);

      expect(store.listProjectStates()[0]).toMatchObject({
        active: false,
        projectName: "alpha",
        validationState: "inactive",
        weight: 5
      });

      store.recordProjectDispatchSelection({
        issueNumber: 42,
        projectName: "alpha",
        schedulerWeights: [
          { currentWeight: 0, projectName: "alpha", weight: 5 }
        ]
      });

      expect(store.listProjectStates()[0]).toMatchObject({
        active: true,
        lastDispatchedIssueNumber: 42,
        projectName: "alpha",
        schedulerCurrentWeight: 0,
        validationMessage: null,
        validationState: "valid",
        weight: 5
      });
    } finally {
      store.close();
    }
  });

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

  it("daemon_shutdown overwrites an earlier reason and cannot be overwritten", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      store.markCancelRequested(id, "operator");
      store.markCancelRequested(id, "daemon_shutdown");
      expect(store.getRun(id)).toMatchObject({
        cancelRequested: true,
        cancelReason: "daemon_shutdown"
      });

      store.markCancelRequested(id, "closed_issue");
      store.markCancelRequested(id, "operator");
      expect(store.getRun(id)).toMatchObject({
        cancelRequested: true,
        cancelReason: "daemon_shutdown"
      });
    } finally {
      store.close();
    }
  });

  it("does not mark cancel-requested runs stale for no progress", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      store.updateRunState(id, "running");
      store.markCancelRequested(id, "closed_issue");

      expect(store.markRunNoProgressStale(id, "2026-05-22T10:00:00.000Z")).toBe(
        false
      );
      expect(store.getRun(id)).toMatchObject({
        cancelReason: "closed_issue",
        cancelRequested: true,
        state: "running",
        terminalReason: null
      });
    } finally {
      store.close();
    }
  });

  it("clears the watchdog idle_since when a run enters waiting", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      store.updateRunState(id, "running");
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:30:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: "logs/runs/run-1/provider.normalized.jsonl",
        outputTokensTotal: 0,
        runId: id,
        sampledAt: "2026-05-22T09:30:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: 0
      });
      expect(store.getWatchdogSample(id)?.idleSince).toBe(
        "2026-05-22T09:30:00.000Z"
      );

      store.updateRunState(id, "waiting");

      expect(store.getWatchdogSample(id)?.idleSince).toBeNull();
    } finally {
      store.close();
    }
  });

  it("recordTerminalReason persists reason and classification", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      store.recordTerminalReason(
        id,
        "workspace_branch_conflict",
        "deterministic"
      );

      const [run] = store.listRuns();
      expect(run).toMatchObject({
        terminalReason: "workspace_branch_conflict",
        failureClassification: "deterministic"
      });
    } finally {
      store.close();
    }
  });

  it("createContinuationRun inherits the parent run's current FSM state", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const parentId = seedRun(store, { id: "parent-fsm", issueNumber: 11 });
      store.setRunCurrentState(parentId, "implementing");

      store.createContinuationRun({
        id: "cont-fsm",
        issue: {
          body: "",
          created_at: "2025-01-01T00:00:00Z",
          id: 2011,
          labels: ["agent-ready"],
          number: 11,
          priority: 1,
          state: "open",
          title: "fixture",
          updated_at: "2025-01-01T00:00:00Z",
          url: "https://example/11"
        },
        parentRunId: parentId,
        projectName: "symphonika",
        providerCommand: "fake",
        providerName: "codex"
      });

      const continuation = store.getRun("cont-fsm");
      expect(continuation?.currentStateId).toBe("implementing");
      expect(continuation?.isContinuation).toBe(true);
      expect(continuation?.continuationParentRunId).toBe(parentId);
    } finally {
      store.close();
    }
  });

  it("createContinuationRun leaves current_state_id null when the parent never recorded one", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const parentId = seedRun(store, { id: "parent-no-fsm", issueNumber: 12 });
      // Never call setRunCurrentState — simulates a Markdown workflow path that
      // exits before applyWorkflowOutcome runs, or a parent that walked to a terminal.
      store.createContinuationRun({
        id: "cont-no-fsm",
        issue: {
          body: "",
          created_at: "2025-01-01T00:00:00Z",
          id: 2012,
          labels: ["agent-ready"],
          number: 12,
          priority: 1,
          state: "open",
          title: "fixture",
          updated_at: "2025-01-01T00:00:00Z",
          url: "https://example/12"
        },
        parentRunId: parentId,
        projectName: "symphonika",
        providerCommand: "fake",
        providerName: "codex"
      });

      const continuation = store.getRun("cont-no-fsm");
      expect(continuation?.currentStateId).toBeNull();
    } finally {
      store.close();
    }
  });

  it("rolls back the row when state inheritance throws mid-createContinuationRun", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const parentId = seedRun(store, { id: "parent-boom", issueNumber: 13 });
      store.setRunCurrentState(parentId, "implementing");

      const setRunCurrentStateSpy = vi
        .spyOn(store, "setRunCurrentState")
        .mockImplementationOnce(() => {
          throw new Error("boom: simulated post-insert failure");
        });

      // claimAndPersistRun's runCreated bookkeeping depends on
      // createContinuationRun returning without throwing meaning a durable
      // row now exists — a throw here must roll back the row insert too, not
      // just skip the state inheritance. See ADR 0093.
      expect(() =>
        store.createContinuationRun({
          id: "cont-boom",
          issue: {
            body: "",
            created_at: "2025-01-01T00:00:00Z",
            id: 2013,
            labels: ["agent-ready"],
            number: 13,
            priority: 1,
            state: "open",
            title: "fixture",
            updated_at: "2025-01-01T00:00:00Z",
            url: "https://example/13"
          },
          parentRunId: parentId,
          projectName: "symphonika",
          providerCommand: "fake",
          providerName: "codex"
        })
      ).toThrow("boom: simulated post-insert failure");

      setRunCurrentStateSpy.mockRestore();
      expect(store.getRun("cont-boom")).toBeUndefined();
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

      const ids = store
        .listActiveRunIds()
        .map((entry) => entry.runId)
        .sort();
      expect(ids).toEqual(["queued", "running"]);
    } finally {
      store.close();
    }
  });

  it("migrates watchdog sample tables idempotently", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    store.close();

    const database = new Database(databasePath(root), { readonly: true });
    try {
      expect(columnNames(database, "watchdog_samples")).toEqual([
        "run_id",
        "sampled_at",
        "last_tool_call_at",
        "last_progress_at",
        "workspace_mtime_max",
        "workspace_digest",
        "turn_id_set_size",
        "output_tokens_total",
        "normalized_log_offset",
        "idle_since",
        "normalized_log_path",
        "last_message_at"
      ]);
      expect(columnNames(database, "watchdog_turn_ids")).toEqual([
        "run_id",
        "turn_id"
      ]);
    } finally {
      database.close();
    }
  });

  it("persists watchdog samples across store reopen", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "run-watchdog", issueNumber: 77 });
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T12:10:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T12:00:00.000Z",
        normalizedLogOffset: 42,
        normalizedLogPath: "logs/runs/run-watchdog/provider.normalized.jsonl",
        outputTokensTotal: 9,
        runId: "run-watchdog",
        sampledAt: "2026-05-22T12:15:00.000Z",
        turnIdSetSize: 2,
        workspaceDigest: "",
        workspaceMtimeMax: 1_769_000_000_123
      });
    } finally {
      store.close();
    }

    const reopened = openRunStore({ stateRoot: root });
    try {
      expect(reopened.getWatchdogSample("run-watchdog")).toEqual({
        idleSince: "2026-05-22T12:10:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T12:00:00.000Z",
        normalizedLogOffset: 42,
        normalizedLogPath: "logs/runs/run-watchdog/provider.normalized.jsonl",
        outputTokensTotal: 9,
        runId: "run-watchdog",
        sampledAt: "2026-05-22T12:15:00.000Z",
        turnIdSetSize: 2,
        workspaceDigest: "",
        workspaceMtimeMax: 1_769_000_000_123
      });
    } finally {
      reopened.close();
    }
  });

  it("lists only running runs as watchdog candidates", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "queued", issueNumber: 1 });
      seedRun(store, { id: "running", issueNumber: 2 });
      store.updateRunState("running", "running");
      store.updateRunEvidence("running", evidence("branch-running"));
      seedRun(store, { id: "preparing", issueNumber: 3 });
      store.updateRunState("preparing", "preparing_workspace");
      seedRun(store, { id: "waiting", issueNumber: 4 });
      store.updateRunState("waiting", "waiting");
      store.setRunCurrentState("waiting", "pr_review");

      // ADR 0054: only `running` Runs are candidates; queued, preparing_workspace,
      // and waiting are all excluded.
      expect(store.listWatchdogCandidateRuns()).toEqual([
        expect.objectContaining({
          normalizedLogPath: "/tmp/provider.normalized.jsonl",
          runId: "running",
          state: "running",
          workspacePath: "/tmp/workspace"
        })
      ]);
    } finally {
      store.close();
    }
  });

  it("retains a running Run's evidence ignore policy across store reopen", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, {
        evidenceIgnore: ["vendor/", "out/"],
        id: "running",
        issueNumber: 2
      });
      store.updateRunState("running", "running");
      store.updateRunEvidence("running", evidence("branch-running"));
    } finally {
      store.close();
    }

    const reopened = openRunStore({ stateRoot: root });
    try {
      expect(reopened.listWatchdogCandidateRuns()).toEqual([
        expect.objectContaining({
          evidenceIgnore: ["vendor/", "out/"],
          runId: "running"
        })
      ]);
    } finally {
      reopened.close();
    }
  });

  it("findLeakedRuns detects non-terminal runs without changing state", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "queued", issueNumber: 1 });
      seedRun(store, { id: "running", issueNumber: 2 });
      store.updateRunState("running", "running");
      seedRun(store, { id: "preparing", issueNumber: 3 });
      store.updateRunState("preparing", "preparing_workspace");
      // valid durable wait — has current_state_id set (ADR 0047)
      seedRun(store, { id: "waiting", issueNumber: 6 });
      store.updateRunState("waiting", "waiting");
      store.setRunCurrentState("waiting", "pr_review");
      seedRun(store, { id: "succeeded", issueNumber: 4 });
      store.updateRunState("succeeded", "succeeded");
      seedRun(store, { id: "failed", issueNumber: 5 });
      store.updateRunState("failed", "failed");

      const leaked = store.findLeakedRuns();

      expect(leaked.map((entry) => entry.runId).sort()).toEqual([
        "preparing",
        "queued",
        "running"
      ]);
      expect(leaked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: "queued",
            projectName: "symphonika",
            issueNumber: 1
          }),
          expect.objectContaining({
            runId: "running",
            projectName: "symphonika",
            issueNumber: 2
          }),
          expect.objectContaining({
            runId: "preparing",
            projectName: "symphonika",
            issueNumber: 3
          })
        ])
      );

      // detection alone must not mutate any row.
      const runsById = new Map(
        store.listRuns().map((entry) => [entry.id, entry])
      );
      expect(runsById.get("queued")?.state).toBe("queued");
      expect(runsById.get("running")?.state).toBe("running");
      expect(runsById.get("preparing")?.state).toBe("preparing_workspace");
      expect(runsById.get("waiting")?.state).toBe("waiting");
      expect(runsById.get("succeeded")?.state).toBe("succeeded");
      expect(runsById.get("failed")?.state).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("findLeakedRuns detects waiting rows missing current_state_id", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      // valid durable wait (current_state_id set) — must survive
      seedRun(store, { id: "wait-valid", issueNumber: 10 });
      store.updateRunState("wait-valid", "waiting");
      store.setRunCurrentState("wait-valid", "pr_review");

      // pre-atomicity crash artifact (current_state_id NULL) — must be swept
      seedRun(store, { id: "wait-orphan", issueNumber: 11 });
      store.updateRunState("wait-orphan", "waiting");

      const leaked = store.findLeakedRuns();

      expect(leaked.map((entry) => entry.runId)).toEqual(["wait-orphan"]);
      expect(leaked[0]).toMatchObject({
        runId: "wait-orphan",
        previousState: "waiting",
        issueNumber: 11
      });
    } finally {
      store.close();
    }
  });

  it("findLeakedRuns returns nothing on a clean database", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      expect(store.findLeakedRuns()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("findLeakedRuns returns previousState per row", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "queued", issueNumber: 1 });
      seedRun(store, { id: "running", issueNumber: 2 });
      store.updateRunState("running", "running");
      seedRun(store, { id: "preparing", issueNumber: 3 });
      store.updateRunState("preparing", "preparing_workspace");

      const leaked = store.findLeakedRuns();
      const previousByRunId = new Map(
        leaked.map((entry) => [entry.runId, entry.previousState])
      );

      expect(previousByRunId.get("queued")).toBe("queued");
      expect(previousByRunId.get("running")).toBe("running");
      expect(previousByRunId.get("preparing")).toBe("preparing_workspace");
    } finally {
      store.close();
    }
  });

  it("markRunsStale transitions the given rows to stale with a per-row reason", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "confirmed", issueNumber: 1 });
      store.updateRunState("confirmed", "running");
      seedRun(store, { id: "pending", issueNumber: 2 });
      store.updateRunState("pending", "running");

      store.markRunsStale([
        {
          previousState: "running",
          reason: "leaked_active_run",
          runId: "confirmed"
        },
        {
          previousState: "running",
          reason: "leaked_active_run_cleanup_pending",
          runId: "pending"
        }
      ]);

      const runsById = new Map(
        store.listRuns().map((entry) => [entry.id, entry])
      );
      expect(runsById.get("confirmed")).toMatchObject({
        state: "stale",
        terminalReason: "leaked_active_run"
      });
      expect(runsById.get("pending")).toMatchObject({
        state: "stale",
        terminalReason: "leaked_active_run_cleanup_pending"
      });
      expect(store.listActiveRunIds()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("findLeakedRuns rediscovers a row left with the cleanup-pending reason", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "pending", issueNumber: 1 });
      store.updateRunState("pending", "running");
      store.markRunsStale([
        {
          previousState: "running",
          reason: "leaked_active_run_cleanup_pending",
          runId: "pending"
        }
      ]);

      // a plain 'stale' row from a confirmed sweep must not resurface.
      seedRun(store, { id: "confirmed", issueNumber: 2 });
      store.updateRunState("confirmed", "running");
      store.markRunsStale([
        {
          previousState: "running",
          reason: "leaked_active_run",
          runId: "confirmed"
        }
      ]);

      const leaked = store.findLeakedRuns();

      expect(leaked.map((entry) => entry.runId)).toEqual(["pending"]);
      expect(leaked[0]).toMatchObject({
        runId: "pending",
        previousState: "stale",
        previousTerminalReason: "leaked_active_run_cleanup_pending"
      });
    } finally {
      store.close();
    }
  });

  // Regression: a host where systemd-run --user stays unavailable across
  // every restart has findLeakedRuns() re-surface the same
  // leaked_active_run_cleanup_pending row on every sweep. Recording a fresh
  // "stale" transition on each re-sweep -- even though the row was already
  // stale -- would grow run_state_transitions unboundedly with duplicate
  // entries for a row that never actually changed state, and that table
  // renders verbatim in the dashboard's "State transitions" section.
  it("markRunsStale does not record a duplicate transition when re-sweeping an already-stale row", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "pending", issueNumber: 1 });
      store.updateRunState("pending", "running");

      store.markRunsStale([
        {
          previousState: "running",
          reason: "leaked_active_run_cleanup_pending",
          runId: "pending"
        }
      ]);
      // A later restart re-detects the same still-pending row; findLeakedRuns
      // now reports its previousState as 'stale', not 'running'.
      store.markRunsStale([
        {
          previousState: "stale",
          reason: "leaked_active_run_cleanup_pending",
          runId: "pending"
        }
      ]);

      const states = store
        .listRunStateTransitions("pending")
        .map((entry) => entry.state);
      expect(states.filter((state) => state === "stale")).toHaveLength(1);
      expect(
        store.listRuns().find((entry) => entry.id === "pending")
      ).toMatchObject({
        state: "stale",
        terminalReason: "leaked_active_run_cleanup_pending"
      });
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
        reason: "cap_reached:no_commits"
      });

      const cap = store.listRuns().find((entry) => entry.id === "cap-1");
      expect(cap).toMatchObject({
        state: "failed",
        isContinuation: true,
        continuationParentRunId: "parent",
        terminalReason: "cap_reached:no_commits",
        failureClassification: "deterministic",
        issueNumber: 8
      });
    } finally {
      store.close();
    }
  });

  it("tracks pull requests discovered from succeeded run branches", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const branchName = "sym/symphonika/54-pr-followup";
      const id = seedRun(store, { id: "parent", issueNumber: 54 });
      store.updateRunEvidence(id, evidence(branchName));
      store.updateRunState(id, "succeeded");

      expect(store.hasPullRequestFollowupWork()).toBe(true);
      expect(store.listRunsAwaitingPullRequestDiscovery()).toEqual([
        {
          branchName,
          issueNumber: 54,
          projectName: "symphonika",
          runId: "parent"
        }
      ]);

      store.trackPullRequest({
        branchName,
        headSha: "abc123",
        issueNumber: 54,
        projectName: "symphonika",
        prNumber: 81,
        prUrl: "https://github.com/pmatos/symphonika/pull/81",
        runId: "parent"
      });

      expect(store.listRunsAwaitingPullRequestDiscovery()).toEqual([]);
      expect(store.hasPullRequestFollowupWork()).toBe(true);
      const [tracked] = store.listOpenTrackedPullRequests();
      expect(tracked).toMatchObject({
        branchName,
        headShaAtDispatch: "abc123",
        lastSeenHeadSha: "abc123",
        prNumber: 81,
        reviewDispatchCount: 0,
        state: "open"
      });

      expect(tracked).toBeDefined();
      store.recordPullRequestReviewDispatch({
        fingerprint: "sha256:feedback",
        headSha: "def456",
        id: tracked!.id,
        runId: "review-run"
      });
      store.recordPullRequestObservation({
        headSha: "def456",
        id: tracked!.id,
        prUrl: tracked!.prUrl,
        reviewFollowupCapReached: false,
        state: "merged"
      });

      expect(store.listOpenTrackedPullRequests()).toEqual([]);
      expect(store.hasPullRequestFollowupWork()).toBe(false);
    } finally {
      store.close();
    }
  });

  it("PR discovery prefers least-attempted runs and excludes ones that hit the attempt cap", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const stuckBranch = "sym/symphonika/stuck";
      const freshBranch = "sym/symphonika/fresh";
      seedRun(store, { id: "run-a-stuck", issueNumber: 1 });
      store.updateRunEvidence("run-a-stuck", evidence(stuckBranch));
      store.updateRunState("run-a-stuck", "succeeded");
      seedRun(store, { id: "run-b-fresh", issueNumber: 2 });
      store.updateRunEvidence("run-b-fresh", evidence(freshBranch));
      store.updateRunState("run-b-fresh", "succeeded");

      // Simulate 3 polls where the stuck run is checked but no PR is found.
      store.recordPullRequestDiscoveryAttempt("run-a-stuck");
      store.recordPullRequestDiscoveryAttempt("run-a-stuck");
      store.recordPullRequestDiscoveryAttempt("run-a-stuck");

      // The fresh run (attempts=0) now sorts ahead of the stuck run (attempts=3) —
      // newer work cannot be starved by older never-matched runs.
      expect(
        store.listRunsAwaitingPullRequestDiscovery().map((run) => run.runId)
      ).toEqual(["run-b-fresh", "run-a-stuck"]);

      // Push the stuck run past the cap; it must be excluded entirely from candidates.
      for (let i = 0; i < 5; i += 1) {
        store.recordPullRequestDiscoveryAttempt("run-a-stuck");
      }
      expect(
        store
          .listRunsAwaitingPullRequestDiscovery({ maxAttempts: 5 })
          .map((run) => run.runId)
      ).toEqual(["run-b-fresh"]);

      // Once both are exhausted, hasPullRequestFollowupWork reports no candidate work.
      for (let i = 0; i < 5; i += 1) {
        store.recordPullRequestDiscoveryAttempt("run-b-fresh");
      }
      expect(store.hasPullRequestFollowupWork({ maxAttempts: 5 })).toBe(false);
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
          metadata_path, created_at, updated_at
        ) values (
          'legacy-run', 'symphonika', 99, 't', 'succeeded', '{}',
          '/state/logs/runs/legacy-run/prompt-metadata.attempt-2.json',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
        insert into attempts (
          id, run_id, attempt_number, state, provider_name, provider_command,
          workspace_path, branch_name, prompt_path, issue_snapshot_path,
          raw_log_path, normalized_log_path, created_at, updated_at
        ) values (
          'legacy-attempt-2', 'legacy-run', 2, 'succeeded', 'codex', 'codex',
          '/workspace', 'sym/symphonika/99-t',
          '/state/logs/runs/legacy-run/prompt.attempt-2.md',
          '/state/logs/runs/legacy-run/issue-snapshot.attempt-2.json',
          '/state/logs/runs/legacy-run/provider.raw.attempt-2.jsonl',
          '/state/logs/runs/legacy-run/provider.normalized.attempt-2.jsonl',
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
          "evidence_ignore_json",
          "is_continuation",
          "retry_count",
          "cancel_requested"
        ])
      );
      expect(columnNames(reader, "attempts")).toEqual(
        expect.arrayContaining(["metadata_path"])
      );
      const row = reader
        .prepare(
          "select id, retry_count, is_continuation, evidence_ignore_json from runs where id = ?"
        )
        .get("legacy-run") as
        | {
            evidence_ignore_json: string;
            id: string;
            retry_count: number;
            is_continuation: number;
          }
        | undefined;
      expect(row).toEqual({
        evidence_ignore_json: "[]",
        id: "legacy-run",
        retry_count: 0,
        is_continuation: 0
      });
      const attempt = reader
        .prepare("select metadata_path from attempts where id = ?")
        .get("legacy-attempt-2") as { metadata_path: string } | undefined;
      expect(attempt).toEqual({
        metadata_path:
          "/state/logs/runs/legacy-run/prompt-metadata.attempt-2.json"
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
      expect(attempts).toEqual(
        expect.arrayContaining(["failure_classification", "metadata_path"])
      );
    } finally {
      database.close();
    }
  });

  it("adds the labels column when upgrading a pre-#420 project_pull_request_snapshots table", async () => {
    const root = await makeTempRoot();
    const dbPath = databasePath(root);
    const writer = new Database(dbPath);
    try {
      // #419's original CREATE TABLE shape, before #420 added `labels` --
      // a database that already ran #419's migration has this table
      // without the column, and CREATE TABLE IF NOT EXISTS alone would
      // never add it.
      writer.exec(`
        create table project_pull_request_snapshots (
          project_name text not null,
          pr_number integer not null,
          title text not null,
          url text,
          draft integer not null default 0,
          open integer not null default 0,
          merged integer not null default 0,
          head_ref text,
          head_sha text,
          branch_origin text not null default 'neither',
          state_available integer not null default 0,
          mergeable text,
          checks text,
          review_decision text,
          tracking_state text,
          unresolved_review_threads integer,
          polled_at text not null,
          created_at text not null,
          updated_at text not null,
          primary key (project_name, pr_number)
        );
        insert into project_pull_request_snapshots (
          project_name, pr_number, title, url, draft, open, merged,
          head_ref, head_sha, branch_origin, state_available,
          polled_at, created_at, updated_at
        ) values (
          'alpha', 246, 'Fix login', 'https://github.com/pmatos/symphonika/pull/246',
          0, 1, 0, 'sym/alpha/246-fix-login', 'abc123', 'issue_branch', 0,
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
      `);
    } finally {
      writer.close();
    }

    const store = openRunStore({ stateRoot: root });
    try {
      expect(store.listProjectPullRequestSnapshots("alpha")).toEqual([
        expect.objectContaining({
          labels: [],
          prNumber: 246,
          title: "Fix login"
        })
      ]);
      // The migration must not just add the column but leave it usable —
      // an upgrade that adds a nullable column but can't be written back
      // to would still break the very next poll tick.
      store.replaceProjectPullRequestSnapshots({
        polledAt: "2026-01-01T00:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            branchOrigin: "issue_branch",
            checks: null,
            draft: false,
            headRef: "sym/alpha/246-fix-login",
            headSha: "abc123",
            labels: ["agent-ready"],
            mergeable: null,
            merged: false,
            open: true,
            prNumber: 246,
            reviewDecision: null,
            stateAvailable: false,
            title: "Fix login",
            trackingState: null,
            unresolvedReviewThreads: null,
            url: "https://github.com/pmatos/symphonika/pull/246"
          }
        ]
      });
      expect(store.listProjectPullRequestSnapshots("alpha")).toEqual([
        expect.objectContaining({ labels: ["agent-ready"] })
      ]);
    } finally {
      store.close();
    }

    const reader = new Database(dbPath, { readonly: true });
    try {
      expect(columnNames(reader, "project_pull_request_snapshots")).toContain(
        "labels"
      );
    } finally {
      reader.close();
    }
  });

  it("backfills issue_owner/issue_repo from persisted snapshot urls", async () => {
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
          metadata_path text,
          created_at text not null,
          updated_at text not null
        );
        insert into runs (
          id, project_name, issue_number, issue_title, state,
          issue_snapshot_json, created_at, updated_at
        ) values (
          'legacy-github', 'symphonika', 7, 't', 'cancelled',
          '{"url":"https://github.com/acme/alpha/issues/7"}',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        ), (
          'legacy-unparseable', 'symphonika', 8, 't', 'cancelled',
          '{"url":"https://example/8"}',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        ), (
          'legacy-empty', 'symphonika', 9, 't', 'cancelled', '{}',
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
        expect.arrayContaining(["issue_owner", "issue_repo"])
      );
      expect(
        reader
          .prepare(
            "select id, issue_owner, issue_repo from runs order by id asc"
          )
          .all()
      ).toEqual([
        { id: "legacy-empty", issue_owner: null, issue_repo: null },
        { id: "legacy-github", issue_owner: "acme", issue_repo: "alpha" },
        { id: "legacy-unparseable", issue_owner: null, issue_repo: null }
      ]);
    } finally {
      reader.close();
    }
  });

  it("backfills sample history when upgrading a pre-history watchdog_samples table", async () => {
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
          metadata_path text,
          created_at text not null,
          updated_at text not null
        );
        create table watchdog_samples (
          run_id text primary key,
          sampled_at text not null,
          last_tool_call_at text,
          workspace_mtime_max real not null,
          turn_id_set_size integer not null,
          output_tokens_total integer not null,
          normalized_log_offset integer not null,
          idle_since text,
          foreign key (run_id) references runs(id)
        );
        insert into runs (
          id, project_name, issue_number, issue_title, state,
          issue_snapshot_json, created_at, updated_at
        ) values (
          'legacy-watchdog', 'symphonika', 99, 't', 'queued', '{}',
          '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z'
        );
        insert into watchdog_samples (
          run_id, sampled_at, last_tool_call_at, workspace_mtime_max,
          turn_id_set_size, output_tokens_total, normalized_log_offset, idle_since
        ) values (
          'legacy-watchdog', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z',
          1234.5, 3, 100, 7, null
        );
      `);
    } finally {
      writer.close();
    }

    const store = openRunStore({ stateRoot: root });
    store.close();

    const reader = new Database(dbPath, { readonly: true });
    try {
      expect(columnNames(reader, "watchdog_samples")).toEqual(
        expect.arrayContaining(["normalized_log_path", "last_message_at"])
      );
      const history = reader
        .prepare(
          "select run_id, output_tokens_total, normalized_log_path, last_message_at from watchdog_sample_history where run_id = ?"
        )
        .get("legacy-watchdog") as
        | {
            last_message_at: string | null;
            normalized_log_path: string;
            output_tokens_total: number;
            run_id: string;
          }
        | undefined;
      expect(history).toEqual({
        last_message_at: null,
        normalized_log_path: "",
        output_tokens_total: 100,
        run_id: "legacy-watchdog"
      });
    } finally {
      reader.close();
    }
  });
});

describe("listResumableShutdownRuns", () => {
  it("returns only the newest shutdown-cancelled run per issue", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const older = seedRun(store, { id: "run-1" });
      store.setRunCurrentState(older, "plan");
      store.markCancelRequested(older, "daemon_shutdown");
      store.updateRunState(older, "cancelled");

      const newer = seedRun(store, { id: "run-2" });
      store.setRunCurrentState(newer, "implement");
      store.markCancelRequested(newer, "daemon_shutdown");
      store.updateRunState(newer, "cancelled");

      expect(store.listResumableShutdownRuns()).toEqual([
        {
          currentStateId: "implement",
          issueNumber: 7,
          projectName: "symphonika",
          runId: "run-2"
        }
      ]);
    } finally {
      store.close();
    }
  });

  it("ignores other cancel reasons and non-cancelled states", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const operator = seedRun(store, { id: "run-1", issueNumber: 1 });
      store.setRunCurrentState(operator, "implement");
      store.markCancelRequested(operator, "operator");
      store.updateRunState(operator, "cancelled");

      const running = seedRun(store, { id: "run-2", issueNumber: 2 });
      store.setRunCurrentState(running, "implement");
      store.markCancelRequested(running, "daemon_shutdown");
      store.updateRunState(running, "running");

      expect(store.listResumableShutdownRuns()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("reports a null state for a run cancelled before its workflow state was persisted", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const id = seedRun(store);
      store.markCancelRequested(id, "daemon_shutdown");
      store.updateRunState(id, "cancelled");

      expect(store.listResumableShutdownRuns()).toEqual([
        {
          currentStateId: null,
          issueNumber: 7,
          projectName: "symphonika",
          runId: id
        }
      ]);
    } finally {
      store.close();
    }
  });

  it("recovers the run's original repository from the persisted snapshot url", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      store.createRun({
        id: "run-1",
        issue: {
          body: "",
          created_at: "2025-01-01T00:00:00Z",
          id: 1000,
          labels: ["agent-ready"],
          number: 7,
          priority: 1,
          state: "open",
          title: "fixture",
          updated_at: "2025-01-01T00:00:00Z",
          url: "https://github.com/pmatos/symphonika/issues/7"
        },
        projectName: "symphonika",
        providerCommand: "fake",
        providerName: "codex"
      });
      store.setRunCurrentState("run-1", "implement");
      store.markCancelRequested("run-1", "daemon_shutdown");
      store.updateRunState("run-1", "cancelled");

      expect(store.listResumableShutdownRuns()[0]?.issueRepository).toEqual({
        owner: "pmatos",
        repo: "symphonika"
      });
    } finally {
      store.close();
    }
  });

  it("reports no repository when the snapshot url is not a github issue url", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      // seedRun's fixture url is `https://example/1` — nothing to parse, so
      // the caller has no mismatch to act on.
      const id = seedRun(store);
      store.setRunCurrentState(id, "implement");
      store.markCancelRequested(id, "daemon_shutdown");
      store.updateRunState(id, "cancelled");

      expect(
        store.listResumableShutdownRuns()[0]?.issueRepository
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("drops a declined run and survives a store reopen", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    const id = seedRun(store);
    try {
      store.setRunCurrentState(id, "implement");
      store.markCancelRequested(id, "daemon_shutdown");
      store.updateRunState(id, "cancelled");
      expect(store.listResumableShutdownRuns()).toHaveLength(1);

      store.markShutdownResumeDeclined(id);
      expect(store.listResumableShutdownRuns()).toEqual([]);
    } finally {
      store.close();
    }

    const reopened = openRunStore({ stateRoot: root });
    try {
      expect(reopened.listResumableShutdownRuns()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("scopes the newest-run guard per repository when a project is retargeted", async () => {
    // The #602 reproduction: project P is retargeted from repository A to B,
    // an issue with the same number is shutdown-cancelled in each, and the
    // tracker returns to A. Before the repository partition, B's newer row
    // eliminated A's, `resumeShutdownCancelledRuns` refused B at the origin
    // gate, and A#7 stayed `sym:claimed` with no live run.
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const inA = seedRun(store, {
        id: "run-a",
        url: "https://github.com/acme/alpha/issues/7"
      });
      store.setRunCurrentState(inA, "implement");
      store.markCancelRequested(inA, "daemon_shutdown");
      store.updateRunState(inA, "cancelled");

      const inB = seedRun(store, {
        id: "run-b",
        url: "https://github.com/acme/beta/issues/7"
      });
      store.setRunCurrentState(inB, "plan");
      store.markCancelRequested(inB, "daemon_shutdown");
      store.updateRunState(inB, "cancelled");

      expect(
        store
          .listResumableShutdownRuns()
          .map((entry) => ({
            repository: entry.issueRepository,
            runId: entry.runId
          }))
          .sort((left, right) => left.runId.localeCompare(right.runId))
      ).toEqual([
        { repository: { owner: "acme", repo: "alpha" }, runId: "run-a" },
        { repository: { owner: "acme", repo: "beta" }, runId: "run-b" }
      ]);
    } finally {
      store.close();
    }
  });

  it("treats a differently-cased repository as the same run history", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const older = seedRun(store, {
        id: "run-1",
        url: "https://github.com/acme/alpha/issues/7"
      });
      store.setRunCurrentState(older, "plan");
      store.markCancelRequested(older, "daemon_shutdown");
      store.updateRunState(older, "cancelled");

      const newer = seedRun(store, {
        id: "run-2",
        url: "https://github.com/ACME/Alpha/issues/7"
      });
      store.setRunCurrentState(newer, "implement");
      store.markCancelRequested(newer, "daemon_shutdown");
      store.updateRunState(newer, "cancelled");

      expect(
        store.listResumableShutdownRuns().map((entry) => entry.runId)
      ).toEqual(["run-2"]);
    } finally {
      store.close();
    }
  });

  it("keeps rows of undetermined origin in one history rather than splitting them", async () => {
    // Two unparseable rows must not both surface: null is one bucket, not a
    // value that matches nothing, or every legacy issue would be resumed
    // twice.
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const older = seedRun(store, { id: "run-1" });
      store.setRunCurrentState(older, "plan");
      store.markCancelRequested(older, "daemon_shutdown");
      store.updateRunState(older, "cancelled");

      const newer = seedRun(store, { id: "run-2" });
      store.setRunCurrentState(newer, "implement");
      store.markCancelRequested(newer, "daemon_shutdown");
      store.updateRunState(newer, "cancelled");

      expect(
        store.listResumableShutdownRuns().map((entry) => entry.runId)
      ).toEqual(["run-2"]);
    } finally {
      store.close();
    }
  });

  it("scopes the newest-run guard per project when issue numbers collide", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      const alpha = seedRun(store, { id: "run-1", projectName: "alpha" });
      store.setRunCurrentState(alpha, "implement");
      store.markCancelRequested(alpha, "daemon_shutdown");
      store.updateRunState(alpha, "cancelled");

      const beta = seedRun(store, { id: "run-2", projectName: "beta" });
      store.setRunCurrentState(beta, "plan");
      store.markCancelRequested(beta, "daemon_shutdown");
      store.updateRunState(beta, "cancelled");

      expect(
        store
          .listResumableShutdownRuns()
          .map((entry) => `${entry.projectName}:${entry.runId}`)
          .sort()
      ).toEqual(["alpha:run-1", "beta:run-2"]);
    } finally {
      store.close();
    }
  });
});
