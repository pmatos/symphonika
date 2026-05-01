import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-rsd-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
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

describe("RunStore detail queries", () => {
  it("getRun returns the run with attempts and transitions", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "run-A",
        issue: sampleIssue(),
        projectName: "symphonika",
        providerCommand: "codex --x",
        providerName: "codex"
      });
      store.updateRunState("run-A", "preparing_workspace");
      store.createAttempt({
        attemptNumber: 1,
        branchName: "sym/symphonika/42-sample",
        branchRef: "refs/heads/sym/symphonika/42-sample",
        id: "run-A-attempt-1",
        issueSnapshotPath: "/tmp/snap.json",
        metadataPath: "/tmp/meta.json",
        normalizedLogPath: "/tmp/normalized.jsonl",
        promptPath: "/tmp/prompt.md",
        providerCommand: "codex --x",
        providerName: "codex",
        rawLogPath: "/tmp/raw.jsonl",
        runId: "run-A",
        state: "running",
        workspacePath: "/tmp/work"
      });
      store.updateRunState("run-A", "running");

      const detail = store.getRun("run-A");
      expect(detail).toBeDefined();
      expect(detail?.id).toBe("run-A");
      expect(detail?.issueTitle).toBe("Sample issue");
      expect(detail?.attempts).toHaveLength(1);
      expect(detail?.attempts[0]?.id).toBe("run-A-attempt-1");
      expect(detail?.transitions.map((t) => t.state)).toEqual([
        "queued",
        "preparing_workspace",
        "running"
      ]);
    } finally {
      store.close();
    }
  });

  it("getRun returns undefined for unknown id", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      expect(store.getRun("missing")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("listRuns filters by state, project, and issueNumber", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "r-1",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      store.updateRunState("r-1", "running");
      store.createRun({
        id: "r-2",
        issue: sampleIssue({ number: 2 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      store.updateRunState("r-2", "failed");
      store.createRun({
        id: "r-3",
        issue: sampleIssue({ number: 3 }),
        projectName: "beta",
        providerCommand: "x",
        providerName: "claude"
      });
      store.updateRunState("r-3", "failed");

      expect(
        store.listRuns({ project: "alpha", state: "failed" }).map((r) => r.id)
      ).toEqual(["r-2"]);
      expect(
        store
          .listRuns({ state: "failed" })
          .map((r) => r.id)
          .sort()
      ).toEqual(["r-2", "r-3"]);
      expect(store.listRuns({ issueNumber: 1 }).map((r) => r.id)).toEqual([
        "r-1"
      ]);
    } finally {
      store.close();
    }
  });

  it("listProviderEvents respects limit and afterSequence", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "r-events",
        issue: sampleIssue(),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      store.createAttempt({
        attemptNumber: 1,
        branchName: "branch",
        branchRef: "refs/heads/branch",
        id: "r-events-attempt-1",
        issueSnapshotPath: "/tmp/snap.json",
        metadataPath: "/tmp/meta.json",
        normalizedLogPath: "/tmp/normalized.jsonl",
        promptPath: "/tmp/prompt.md",
        providerCommand: "x",
        providerName: "codex",
        rawLogPath: "/tmp/raw.jsonl",
        runId: "r-events",
        state: "running",
        workspacePath: "/tmp/work"
      });
      for (let i = 1; i <= 5; i += 1) {
        store.recordProviderEvent({
          attemptId: "r-events-attempt-1",
          normalized: { type: "message", message: `m${i}` },
          raw: { kind: "message", body: `m${i}` },
          runId: "r-events",
          sequence: i
        });
      }

      expect(store.listProviderEvents("r-events").map((e) => e.sequence)).toEqual([
        1, 2, 3, 4, 5
      ]);
      expect(
        store
          .listProviderEvents("r-events", { limit: 2 })
          .map((e) => e.sequence)
      ).toEqual([1, 2]);
      expect(
        store
          .listProviderEvents("r-events", { afterSequence: 3 })
          .map((e) => e.sequence)
      ).toEqual([4, 5]);
    } finally {
      store.close();
    }
  });
});
