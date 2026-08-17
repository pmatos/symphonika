import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import {
  openRunStore,
  type ProjectPullRequestSnapshotRow,
  type RunStore
} from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-pr-search-test-"));
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
    body: "",
    created_at: "",
    id: 1,
    labels: [],
    number: 1,
    priority: 99,
    state: "open",
    title: "issue",
    updated_at: "",
    url: "",
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

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

describe("GET /prs (#309, ADR 0077)", () => {
  it("lists open pull requests across every configured Project", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 },
        { name: "beta", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [samplePrRow({ prNumber: 246, title: "Alpha PR" })]
      });
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "beta",
        rows: [
          samplePrRow({
            branchOrigin: "routine_firing_branch",
            prNumber: 12,
            title: "Beta routine PR"
          })
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs")).text();

      expect(html).toContain("Alpha PR");
      expect(html).toContain("Beta routine PR");
      expect(html).toContain("Issue Branch");
      expect(html).toContain("Routine Firing branch");
    } finally {
      test.cleanup();
    }
  });

  it("filters by project, origin, tracking, and free-text title search", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          samplePrRow({
            branchOrigin: "issue_branch",
            prNumber: 1,
            title: "Fix the login flow"
          }),
          samplePrRow({
            branchOrigin: "neither",
            prNumber: 2,
            title: "Manual hotfix"
          })
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const byOrigin = await (await app.request("/prs?origin=neither")).text();
      expect(byOrigin).not.toContain("Fix the login flow");
      expect(byOrigin).toContain("Manual hotfix");

      const byQuery = await (await app.request("/prs?q=login")).text();
      expect(byQuery).toContain("Fix the login flow");
      expect(byQuery).not.toContain("Manual hotfix");

      const byProject = await (await app.request("/prs?project=nope")).text();
      expect(byProject).toContain("No matching pull requests");
    } finally {
      test.cleanup();
    }
  });

  it("treats an unrecognized ?tracking= as no filter, not a match-nothing filter", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [samplePrRow({ title: "Still shown" })]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs?tracking=bogus")).text();
      expect(html).toContain("Still shown");
    } finally {
      test.cleanup();
    }
  });

  it("shows the owning Run for a PR tracked by PR Follow-up", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [samplePrRow({ prNumber: 246, title: "Tracked PR" })]
      });
      test.runStore.createRun({
        id: "run-42",
        issue: sampleIssue({ number: 9 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.trackPullRequest({
        branchName: "sym/alpha/9-fix",
        headSha: "abc123",
        issueNumber: 9,
        prNumber: 246,
        prUrl: "https://github.com/pmatos/symphonika/pull/246",
        projectName: "alpha",
        runId: "run-42"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs")).text();
      expect(html).toContain("run-42");
      // The "Tracking" filter's <option value="untracked"> is always
      // present; assert on the rendered pill text, not the raw substring.
      expect(html).not.toContain(">untracked<");
    } finally {
      test.cleanup();
    }
  });

  it("shows an untracked PR from a Symphonika branch — the #259 orphan case", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          samplePrRow({
            branchOrigin: "issue_branch",
            headRef: "sym/alpha/246-orphan",
            prNumber: 246,
            title: "Orphaned Symphonika PR"
          })
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs")).text();
      expect(html).toContain("Orphaned Symphonika PR");
      expect(html).toContain(">untracked<");

      const trackedOnly = await (
        await app.request("/prs?tracking=tracked")
      ).text();
      expect(trackedOnly).not.toContain("Orphaned Symphonika PR");

      const untrackedOnly = await (
        await app.request("/prs?tracking=untracked")
      ).text();
      expect(untrackedOnly).toContain("Orphaned Symphonika PR");
    } finally {
      test.cleanup();
    }
  });

  it("marks a pre-restart snapshot as stale rather than current", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2020-01-01T00:00:00.000Z",
        projectName: "alpha",
        rows: [samplePrRow({ title: "Old snapshot" })]
      });

      const app = createHttpApp({
        now: () => Date.parse("2026-05-22T10:00:00.000Z"),
        runStore: test.runStore,
        startedAtMs: Date.parse("2026-05-22T09:00:00.000Z"),
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs")).text();
      expect(html).toContain("(pre-restart)");
    } finally {
      test.cleanup();
    }
  });

  it("renders an empty-state message when no snapshot rows exist", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs")).text();
      expect(html).toContain("No matching pull requests");
    } finally {
      test.cleanup();
    }
  });

  it("links to the PR search page from the shared nav", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/")).text();
      expect(html).toContain('<a href="/prs">Pull requests</a>');
    } finally {
      test.cleanup();
    }
  });
});

describe("GET /prs/:project/:number (#309, ADR 0077)", () => {
  it("renders Symphonika's normalized Pull Request State when available", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          samplePrRow({
            checks: "failure",
            mergeable: "conflicting",
            prNumber: 246,
            reviewDecision: "changes_requested",
            title: "Needs work",
            unresolvedReviewThreads: 3
          })
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs/alpha/246")).text();
      expect(html).toContain("Needs work");
      expect(html).toContain("conflicting");
      expect(html).toContain("failure");
      expect(html).toContain("changes_requested");
      expect(html).toContain("3");
    } finally {
      test.cleanup();
    }
  });

  it("shows the enrichment-unavailable case as distinct from a clean state", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          samplePrRow({
            checks: null,
            mergeable: null,
            prNumber: 246,
            reviewDecision: null,
            stateAvailable: false,
            title: "Unfetched PR",
            unresolvedReviewThreads: null
          })
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (await app.request("/prs/alpha/246")).text();
      expect(html).toContain("could not be fetched");
    } finally {
      test.cleanup();
    }
  });

  it("404s for a PR outside the snapshot", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/999");
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });
});
