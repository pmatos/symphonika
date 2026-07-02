import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: "logs/runs/run-1/provider.normalized.jsonl",
        outputTokensTotal: 0,
        runId: id,
        sampledAt: "2026-05-22T09:30:00.000Z",
        turnIdSetSize: 0,
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
        "workspace_mtime_max",
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
        lastToolCallAt: "2026-05-22T12:00:00.000Z",
        normalizedLogOffset: 42,
        normalizedLogPath: "logs/runs/run-watchdog/provider.normalized.jsonl",
        outputTokensTotal: 9,
        runId: "run-watchdog",
        sampledAt: "2026-05-22T12:15:00.000Z",
        turnIdSetSize: 2,
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
        lastToolCallAt: "2026-05-22T12:00:00.000Z",
        normalizedLogOffset: 42,
        normalizedLogPath: "logs/runs/run-watchdog/provider.normalized.jsonl",
        outputTokensTotal: 9,
        runId: "run-watchdog",
        sampledAt: "2026-05-22T12:15:00.000Z",
        turnIdSetSize: 2,
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

  it("markLeakedRunsAsStale transitions non-terminal runs to stale", async () => {
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

      const swept = store.markLeakedRunsAsStale();

      expect(swept.map((entry) => entry.runId).sort()).toEqual([
        "preparing",
        "queued",
        "running"
      ]);
      expect(swept).toEqual(
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

      const runsById = new Map(
        store.listRuns().map((entry) => [entry.id, entry])
      );
      expect(runsById.get("queued")).toMatchObject({
        state: "stale",
        terminalReason: "leaked_active_run"
      });
      expect(runsById.get("running")?.state).toBe("stale");
      expect(runsById.get("preparing")?.state).toBe("stale");
      // valid waiting rows (current_state_id set) are intentionally durable
      // across daemon restarts (ADR 0047); reconcileWaitingRuns re-evaluates
      // them on the next tick — the startup sweep must not touch them.
      expect(runsById.get("waiting")?.state).toBe("waiting");
      expect(runsById.get("succeeded")?.state).toBe("succeeded");
      expect(runsById.get("failed")?.state).toBe("failed");
      expect(store.listActiveRunIds()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("markLeakedRunsAsStale sweeps waiting rows missing current_state_id", async () => {
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

      const swept = store.markLeakedRunsAsStale();

      expect(swept.map((entry) => entry.runId)).toEqual(["wait-orphan"]);
      expect(swept[0]).toMatchObject({
        runId: "wait-orphan",
        previousState: "waiting",
        issueNumber: 11
      });

      const runsById = new Map(
        store.listRuns().map((entry) => [entry.id, entry])
      );
      expect(runsById.get("wait-valid")?.state).toBe("waiting");
      expect(runsById.get("wait-orphan")).toMatchObject({
        state: "stale",
        terminalReason: "leaked_active_run"
      });
    } finally {
      store.close();
    }
  });

  it("markLeakedRunsAsStale is idempotent on a clean database", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      expect(store.markLeakedRunsAsStale()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("markLeakedRunsAsStale returns previousState per row", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: root });
    try {
      seedRun(store, { id: "queued", issueNumber: 1 });
      seedRun(store, { id: "running", issueNumber: 2 });
      store.updateRunState("running", "running");
      seedRun(store, { id: "preparing", issueNumber: 3 });
      store.updateRunState("preparing", "preparing_workspace");

      const swept = store.markLeakedRunsAsStale();
      const previousByRunId = new Map(
        swept.map((entry) => [entry.runId, entry.previousState])
      );

      expect(previousByRunId.get("queued")).toBe("queued");
      expect(previousByRunId.get("running")).toBe("running");
      expect(previousByRunId.get("preparing")).toBe("preparing_workspace");
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
          "select id, retry_count, is_continuation from runs where id = ?"
        )
        .get("legacy-run") as
        | { id: string; retry_count: number; is_continuation: number }
        | undefined;
      expect(row).toEqual({
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
});
