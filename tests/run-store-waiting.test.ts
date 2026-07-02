import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-run-store-waiting-")
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

function sampleIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "issue body",
    created_at: "2026-04-01T00:00:00Z",
    id: 1001,
    labels: ["agent-ready"],
    number: 42,
    priority: 99,
    state: "open",
    title: "Sample issue",
    updated_at: "2026-04-02T00:00:00Z",
    url: "https://example.invalid/issue/42",
    ...overrides
  };
}

function seedParent(store: ReturnType<typeof openRunStore>, id: string) {
  store.createRun({
    id,
    issue: sampleIssue(),
    projectName: "symphonika",
    providerCommand: "fake-codex",
    providerName: "codex"
  });
  store.updateRunState(id, "succeeded");
}

describe("RunStore waiting-run helpers", () => {
  it("createWaitingRun persists a row in 'waiting' state with no provider evidence", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      seedParent(store, "parent-1");

      store.createWaitingRun({
        currentStateId: "holding",
        id: "wait-1",
        issue: sampleIssue(),
        parentRunId: "parent-1",
        projectName: "symphonika"
      });

      const detail = store.getRun("wait-1");
      expect(detail).toBeDefined();
      expect(detail?.state).toBe("waiting");
      expect(detail?.currentStateId).toBe("holding");
      expect(detail?.continuationParentRunId).toBe("parent-1");
      expect(detail?.isContinuation).toBe(true);
      expect(detail?.provider).toBe("");
      expect(store.listRunArtifacts("wait-1")).toContainEqual({
        kind: "prompt",
        present: false,
        sizeBytes: undefined
      });
    } finally {
      store.close();
    }
  });

  it("listWaitingRuns surfaces waiting rows including cancel-requested ones so reconciliation can transition them", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      seedParent(store, "parent-A");
      seedParent(store, "parent-B");

      store.createWaitingRun({
        currentStateId: "review_check",
        id: "wait-A",
        issue: sampleIssue({ number: 10 }),
        parentRunId: "parent-A",
        projectName: "symphonika"
      });
      store.createWaitingRun({
        currentStateId: "merge_gate",
        id: "wait-B",
        issue: sampleIssue({ number: 11 }),
        parentRunId: "parent-B",
        projectName: "symphonika"
      });
      store.markCancelRequested("wait-B", "operator");

      const waiting = store.listWaitingRuns();
      expect(waiting.map((row: { runId: string }) => row.runId).sort()).toEqual(
        ["wait-A", "wait-B"]
      );
      const waitB = waiting.find((row) => row.runId === "wait-B");
      expect(waitB).toMatchObject({
        currentStateId: "merge_gate",
        issueNumber: 11,
        projectName: "symphonika",
        runId: "wait-B"
      });
    } finally {
      store.close();
    }
  });

  // Without atomicity, a crash after insertRunRow but before setRunCurrentState
  // leaves a row in state='waiting' with current_state_id=NULL. listWaitingRuns
  // filters those out, so reconcileWaitingRuns can never see them — a true
  // orphan that survives any number of daemon restarts.
  it("createWaitingRun rolls back the inserted row if setRunCurrentState throws", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    const spy = vi
      .spyOn(RunStore.prototype, "setRunCurrentState")
      .mockImplementation(() => {
        throw new Error("simulated crash between writes");
      });

    try {
      seedParent(store, "parent-atomic");

      expect(() =>
        store.createWaitingRun({
          currentStateId: "holding",
          id: "wait-atomic",
          issue: sampleIssue(),
          parentRunId: "parent-atomic",
          projectName: "symphonika"
        })
      ).toThrow("simulated crash between writes");

      expect(store.getRun("wait-atomic")).toBeUndefined();
      expect(
        store.listRuns().find((entry) => entry.id === "wait-atomic")
      ).toBeUndefined();
    } finally {
      spy.mockRestore();
      store.close();
    }
  });
});
