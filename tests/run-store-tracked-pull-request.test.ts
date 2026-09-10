import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import type { RunStore } from "../src/run-store.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-tracked-pr-lookup-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function sampleIssue(): IssueSnapshot {
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
    url: "https://example.invalid/issue/246"
  };
}

// An Issue accumulates one tracked_pull_requests row per redispatched chain's
// Issue Branch (trackPullRequest upserts by (project, pr_number); rows are never
// deleted). Insert the branch we later scope to FIRST so it has the lower id,
// and a different branch SECOND so the unscoped "newest by id" lookup returns
// the *other* branch's row -- the exact shape #736 fixed.
async function storeWithTwoBranchRows(): Promise<RunStore> {
  const store = openRunStore({ stateRoot: await makeTempRoot() });
  openStores.push(store);
  store.createRun({
    id: "run-a",
    issue: sampleIssue(),
    projectName: "alpha",
    providerCommand: "fake-codex",
    providerName: "codex"
  });
  store.createRun({
    id: "run-b",
    issue: sampleIssue(),
    projectName: "alpha",
    providerCommand: "fake-codex",
    providerName: "codex"
  });
  store.trackPullRequest({
    branchName: "sym/alpha/246-fix-login",
    headSha: "aaa111",
    issueNumber: 246,
    prNumber: 246,
    projectName: "alpha",
    prUrl: "https://github.com/pmatos/symphonika/pull/246",
    runId: "run-a"
  });
  store.trackPullRequest({
    branchName: "sym/alpha/246-redispatch",
    headSha: "bbb222",
    issueNumber: 246,
    prNumber: 247,
    projectName: "alpha",
    prUrl: "https://github.com/pmatos/symphonika/pull/247",
    runId: "run-b"
  });
  return store;
}

describe("findTrackedPullRequestByIssue", () => {
  it("returns the newest tracked PR by id when no branch is given", async () => {
    const store = await storeWithTwoBranchRows();
    const tracked = store.findTrackedPullRequestByIssue({
      issueNumber: 246,
      projectName: "alpha"
    });
    expect(tracked?.prNumber).toBe(247);
    expect(tracked?.branchName).toBe("sym/alpha/246-redispatch");
  });

  it("treats an empty-string branch as unscoped (newest by id)", async () => {
    const store = await storeWithTwoBranchRows();
    const tracked = store.findTrackedPullRequestByIssue({
      branchName: "",
      issueNumber: 246,
      projectName: "alpha"
    });
    expect(tracked?.prNumber).toBe(247);
  });

  it("returns the branch-matching row even when a different branch's row is newer by id", async () => {
    const store = await storeWithTwoBranchRows();
    const tracked = store.findTrackedPullRequestByIssue({
      branchName: "sym/alpha/246-fix-login",
      issueNumber: 246,
      projectName: "alpha"
    });
    expect(tracked?.prNumber).toBe(246);
    expect(tracked?.branchName).toBe("sym/alpha/246-fix-login");
  });
});
