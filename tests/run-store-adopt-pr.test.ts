import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import type { ProjectPullRequestSnapshotRow } from "../src/run-store.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-run-store-adopt-pr-")
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
    number: 246,
    priority: 99,
    state: "open",
    title: "Sample issue",
    updated_at: "2026-04-02T00:00:00Z",
    url: "https://example.invalid/issue/246",
    ...overrides
  };
}

function samplePrRow(
  overrides: Partial<Omit<ProjectPullRequestSnapshotRow, "polledAt">> = {}
): Omit<ProjectPullRequestSnapshotRow, "polledAt"> {
  return {
    branchOrigin: "issue_branch",
    checks: "success",
    draft: false,
    headRef: "sym/alpha/246-fix-login",
    headSha: "abc123",
    labels: [],
    mergeable: "mergeable",
    merged: false,
    open: true,
    prNumber: 246,
    reviewDecision: "approved",
    stateAvailable: true,
    title: "Fix login",
    trackingState: "open",
    unresolvedReviewThreads: 0,
    url: "https://github.com/pmatos/symphonika/pull/246",
    ...overrides
  };
}

describe("RunStore adopt-pr helpers (ADR-2026-09-03-1158)", () => {
  it("createAdoptedRun parks a row directly in 'waiting' with no parent, no provider, and a recorded reason", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createAdoptedRun({
        currentStateId: "wait_for_pr",
        id: "adopted-1",
        issue: sampleIssue(),
        projectName: "alpha",
        workspacePath: "/tmp/ws/alpha/246-fix-login"
      });

      const detail = store.getRun("adopted-1");
      expect(detail).toBeDefined();
      expect(detail?.state).toBe("waiting");
      expect(detail?.currentStateId).toBe("wait_for_pr");
      expect(detail?.stateTransitionReason).toBe("adopted_pull_request");
      expect(detail?.isContinuation).toBe(false);
      expect(detail?.continuationParentRunId).toBeNull();
      expect(detail?.workspacePath).toBe("/tmp/ws/alpha/246-fix-login");
      expect(detail?.provider).toBe("");
    } finally {
      store.close();
    }
  });

  it("createAdoptedRun clears stale progress-guard history for the issue before parking", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const edge = {
        fromStateId: "wait_for_pr",
        issueNumber: 246,
        projectName: "alpha",
        toStateId: "merge"
      };
      // A prior, unrelated chain already claimed this edge.
      expect(store.claimProgressEdge(edge, "fingerprint-a")).toBe("claimed");
      expect(store.claimProgressEdge(edge, "fingerprint-a")).toBe("unchanged");

      store.createAdoptedRun({
        currentStateId: "wait_for_pr",
        id: "adopted-2",
        issue: sampleIssue(),
        projectName: "alpha",
        workspacePath: "/tmp/ws/alpha/246-fix-login"
      });

      // If the stale row survived, re-claiming the identical fingerprint
      // would read "unchanged" instead of "claimed".
      expect(store.claimProgressEdge(edge, "fingerprint-a")).toBe("claimed");
    } finally {
      store.close();
    }
  });

  it("reassignTrackedPullRequestRun updates run_id without disturbing other tracked-PR fields", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "dead-run",
        issue: sampleIssue(),
        projectName: "alpha",
        providerCommand: "fake-codex",
        providerName: "codex"
      });
      store.createAdoptedRun({
        currentStateId: "wait_for_pr",
        id: "adopted-run",
        issue: sampleIssue(),
        projectName: "alpha",
        workspacePath: "/tmp/ws/alpha/246-fix-login"
      });
      store.trackPullRequest({
        branchName: "sym/alpha/246-fix-login",
        headSha: "abc123",
        issueNumber: 246,
        prNumber: 246,
        projectName: "alpha",
        prUrl: "https://github.com/pmatos/symphonika/pull/246",
        runId: "dead-run"
      });

      store.reassignTrackedPullRequestRun({
        prNumber: 246,
        projectName: "alpha",
        runId: "adopted-run"
      });

      const tracked = store.findTrackedPullRequestByProjectAndNumber({
        prNumber: 246,
        projectName: "alpha"
      });
      expect(tracked?.runId).toBe("adopted-run");
      expect(tracked?.branchName).toBe("sym/alpha/246-fix-login");
      expect(tracked?.prUrl).toBe(
        "https://github.com/pmatos/symphonika/pull/246"
      );
    } finally {
      store.close();
    }
  });

  it("getProjectPullRequestSnapshot returns the matching row, and undefined for an unknown PR", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [samplePrRow(), samplePrRow({ prNumber: 9, title: "Other PR" })]
      });

      const snapshot = store.getProjectPullRequestSnapshot("alpha", 246);
      expect(snapshot?.title).toBe("Fix login");
      expect(snapshot?.headRef).toBe("sym/alpha/246-fix-login");
      expect(snapshot?.headSha).toBe("abc123");
      expect(snapshot?.open).toBe(true);
      expect(snapshot?.merged).toBe(false);

      expect(store.getProjectPullRequestSnapshot("alpha", 999)).toBeUndefined();
      expect(store.getProjectPullRequestSnapshot("beta", 246)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
