import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-run-store-waiting-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
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
      expect(detail?.promptPath).toBe("");
    } finally {
      store.close();
    }
  });

  it("listWaitingRuns surfaces waiting rows and excludes cancel-requested ones", async () => {
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
      expect(waiting.map((row: { runId: string }) => row.runId).sort()).toEqual(["wait-A"]);
      expect(waiting[0]).toMatchObject({
        currentStateId: "review_check",
        issueNumber: 10,
        projectName: "symphonika",
        runId: "wait-A"
      });
    } finally {
      store.close();
    }
  });
});
