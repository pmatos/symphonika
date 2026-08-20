import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import type { PullRequestState } from "../src/pull-request-state.js";
import {
  openRunStore,
  type ProjectPullRequestSnapshotRow,
  type RunStore
} from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-pr-merge-test-"));
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

const TEST_SECRET: CsrfSecret = randomBytes(32);
const SESSION_ID = "a".repeat(32);
const VALID_TOKEN = csrfTokenFor(TEST_SECRET, SESSION_ID);
const HOST = "127.0.0.1:4000";

function browserHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    cookie: `sym_session=${SESSION_ID}`,
    host: HOST,
    origin: `http://${HOST}`,
    ...extra
  };
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

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
    checks: null,
    draft: false,
    headRef: "sym/alpha/246-fix-login",
    headSha: "abc123",
    labels: [],
    mergeable: null,
    merged: false,
    open: true,
    prNumber: 246,
    reviewDecision: null,
    stateAvailable: false,
    title: "Orphaned PR",
    trackingState: null,
    unresolvedReviewThreads: null,
    url: "https://github.com/pmatos/symphonika/pull/246",
    ...overrides
  };
}

function sampleFreshState(
  overrides: Partial<PullRequestState> = {}
): PullRequestState {
  return {
    checks: "success",
    draft: false,
    headSha: "abc123",
    mergeable: "mergeable",
    merged: true,
    number: 246,
    open: false,
    reviewDecision: "approved",
    reviewFollowup: {
      checks: "SUCCESS",
      decision: "APPROVED",
      feedbackFingerprint: "sha256:test",
      unresolvedThreads: []
    },
    trackingState: "merged",
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
  runStore.syncProjectStates([
    { name: "alpha", validationState: "valid", weight: 1 }
  ]);
  runStore.replaceProjectPullRequestSnapshots({
    polledAt: "2026-05-22T10:00:00.000Z",
    projectName: "alpha",
    repository: { owner: "pmatos", repo: "alpha" },
    rows: [samplePrRow()]
  });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

describe("Merge section visibility (#309 part 3, ADR 0078)", () => {
  it("offers the Merge button for an untracked PR — the #259 orphan case", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/prs/alpha/246", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("No live Run owns this PR");
      expect(html).toContain('action="/prs/alpha/246/merge"');
      // The form carries the SHA this page actually shows, for the merge
      // POST to pin against rather than re-reading the snapshot fresh.
      expect(html).toContain(
        '<input type="hidden" name="expected_head_sha" value="abc123">'
      );
      const mergeForm =
        /<form method="post" action="\/prs\/alpha\/246\/merge">([\s\S]*?)<\/form>/.exec(
          html
        )?.[1];
      expect(mergeForm).toContain(
        '<input type="hidden" name="snapshot_owner" value="pmatos">'
      );
      expect(mergeForm).toContain(
        '<input type="hidden" name="snapshot_repo" value="alpha">'
      );
    } finally {
      test.cleanup();
    }
  });

  it("offers the Merge button when the tracked Run has already terminated", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-done-1",
        issue: sampleIssue({ number: 9 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-done-1", "succeeded");
      test.runStore.trackPullRequest({
        branchName: "sym/alpha/9-fix",
        headSha: "abc123",
        issueNumber: 9,
        prNumber: 246,
        prUrl: "https://github.com/pmatos/symphonika/pull/246",
        projectName: "alpha",
        runId: "run-done-1"
      });

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/prs/alpha/246", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("No live Run owns this PR");
      expect(html).toContain('action="/prs/alpha/246/merge"');
    } finally {
      test.cleanup();
    }
  });

  it("shows 'owned by run X' for a live successor Run, even though the originally-tracked Run already terminated", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-done-1",
        issue: sampleIssue({ number: 9 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-done-1", "succeeded");
      // TrackedPullRequest.runId still points at the terminated original —
      // a re-dispatch for the same issue created a second, currently-live
      // Run that TrackedPullRequest was never updated to reflect.
      test.runStore.trackPullRequest({
        branchName: "sym/alpha/9-fix",
        headSha: "abc123",
        issueNumber: 9,
        prNumber: 246,
        prUrl: "https://github.com/pmatos/symphonika/pull/246",
        projectName: "alpha",
        runId: "run-done-1"
      });
      test.runStore.createRun({
        id: "run-successor-1",
        issue: sampleIssue({ number: 9 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getActiveRuns: () => [
          {
            cancelReason: null,
            cancelRequested: false,
            issueNumber: 9,
            projectName: "alpha",
            runId: "run-successor-1"
          }
        ],
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/prs/alpha/246", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("owned by run run-successor-1");
      expect(html).toContain("Cannot be merged until that Run is cancelled");
      expect(html).not.toContain('action="/prs/alpha/246/merge"');
    } finally {
      test.cleanup();
    }
  });

  it("shows 'owned by run X' and no Merge form when a live Run owns the PR", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-live-1",
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
        runId: "run-live-1"
      });

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getActiveRuns: () => [
          {
            cancelReason: null,
            cancelRequested: false,
            issueNumber: 9,
            projectName: "alpha",
            runId: "run-live-1"
          }
        ],
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/prs/alpha/246", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("owned by run run-live-1");
      expect(html).toContain("Cannot be merged until that Run is cancelled");
      expect(html).not.toContain('action="/prs/alpha/246/merge"');
    } finally {
      test.cleanup();
    }
  });
});

describe("POST /prs/:project/:number/merge (#309 part 3)", () => {
  it("merges and shows the re-derived state, not assumed merged", async () => {
    const test = await setup();
    try {
      let received: unknown;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        mergePullRequest: (input) => {
          received = input;
          return Promise.resolve({
            freshState: sampleFreshState(),
            ok: true
          });
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123",
          snapshot_owner: "pmatos",
          snapshot_repo: "alpha"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();

      expect(html).toContain("Merge attempted on GitHub");
      expect(html).toContain("Re-derived current state");
      expect(html).toContain("merged");
      expect(received).toEqual({
        expectedHeadSha: "abc123",
        prNumber: 246,
        projectName: "alpha",
        snapshotRepository: { owner: "pmatos", repo: "alpha" }
      });
      // A confirmed merge (freshState.merged === true) suppresses the Merge
      // section entirely — otherwise the page would show a live Merge
      // button directly under a banner saying the PR is already merged.
      expect(html).not.toContain('action="/prs/alpha/246/merge"');
      expect(html).not.toContain("<h2>Merge</h2>");
    } finally {
      test.cleanup();
    }
  });

  it("pins the merge to the SHA submitted with the form, not a fresh re-read of the snapshot", async () => {
    const test = await setup();
    try {
      let received: unknown;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        mergePullRequest: (input) => {
          received = input;
          return Promise.resolve({ freshState: sampleFreshState(), ok: true });
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      // A poll landing between page-load and the click updated the
      // snapshot's headSha to "def456" -- the merge must still use what
      // the operator's page actually showed ("abc123"), submitted via the
      // hidden form field, not this newer DB value.
      test.runStore.replaceProjectPullRequestSnapshots({
        polledAt: "2026-05-22T10:05:00.000Z",
        projectName: "alpha",
        rows: [samplePrRow({ headSha: "def456" })]
      });

      await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });

      expect(received).toMatchObject({ expectedHeadSha: "abc123" });
    } finally {
      test.cleanup();
    }
  });

  it("surfaces a GitHub-side merge refusal honestly, showing the re-derived (still-open) state", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        mergePullRequest: () =>
          Promise.resolve({
            error: "Pull Request is not mergeable",
            freshState: sampleFreshState({
              merged: false,
              open: true,
              trackingState: "open"
            }),
            ok: false
          }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();

      expect(html).toContain("Merge failed");
      expect(html).toContain("Pull Request is not mergeable");
      expect(html).toContain("Re-derived current state");
      expect(html).toContain("open");
      // Not merged — the Merge section stays offered so the operator can
      // retry once they've fixed whatever GitHub refused for.
      expect(html).toContain('action="/prs/alpha/246/merge"');
    } finally {
      test.cleanup();
    }
  });

  it("shows 'could not be re-derived' when the post-attempt state fetch itself fails", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        mergePullRequest: () =>
          Promise.resolve({ freshState: undefined, ok: true }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("could not be re-derived");
    } finally {
      test.cleanup();
    }
  });

  it("refuses when the in-process active-run registry shows a live Run for the PR", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-live-1",
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
        runId: "run-live-1"
      });

      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getActiveRuns: () => [
          {
            cancelReason: null,
            cancelRequested: false,
            issueNumber: 9,
            projectName: "alpha",
            runId: "run-live-1"
          }
        ],
        mergePullRequest: () => {
          called = true;
          return Promise.resolve({ freshState: undefined, ok: true });
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Refused: run run-live-1 is live for this PR.");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses when a live Run is owned by a sibling Project aliasing the same repository", async () => {
    const test = await setup();
    try {
      // The PR itself is tracked under "alpha", but the Run actually working
      // its issue was dispatched under "beta" -- a second configured Project
      // pointing at the same GitHub owner/repo as "alpha". Without
      // getProjectRepoAliases, findLiveRunIdForIssue's projectName-only
      // match would miss it and offer the merge unrefused.
      test.runStore.createRun({
        id: "run-live-beta",
        issue: sampleIssue({ number: 9 }),
        projectName: "beta",
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
        runId: "run-live-beta"
      });

      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getActiveRuns: () => [
          {
            cancelReason: null,
            cancelRequested: false,
            issueNumber: 9,
            projectName: "beta",
            runId: "run-live-beta"
          }
        ],
        getProjectRepoAliases: (projectName) =>
          projectName === "alpha" || projectName === "beta"
            ? ["alpha", "beta"]
            : [projectName],
        mergePullRequest: () => {
          called = true;
          return Promise.resolve({ freshState: undefined, ok: true });
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Refused: run run-live-beta is live for this PR.");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses when the Run Store shows an active (queued/running) Run owning the PR", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-active-1",
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
        runId: "run-active-1"
      });

      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        mergePullRequest: () => {
          called = true;
          return Promise.resolve({ freshState: undefined, ok: true });
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Refused: run run-active-1 is live for this PR.");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses when the Run Store shows a parked (waiting) Run owning the PR", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-waiting-1",
        issue: sampleIssue({ number: 9 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-waiting-1", "waiting");
      test.runStore.trackPullRequest({
        branchName: "sym/alpha/9-fix",
        headSha: "abc123",
        issueNumber: 9,
        prNumber: 246,
        prUrl: "https://github.com/pmatos/symphonika/pull/246",
        projectName: "alpha",
        runId: "run-waiting-1"
      });

      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        mergePullRequest: () => {
          called = true;
          return Promise.resolve({ freshState: undefined, ok: true });
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Refused: run run-waiting-1 is live for this PR.");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("reports merge as unavailable when no mergePullRequest callback is wired", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/246/merge", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          expected_head_sha: "abc123"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("merge is unavailable");
    } finally {
      test.cleanup();
    }
  });

  it("404s a merge attempt for a PR outside the snapshot", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/prs/alpha/999/merge", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });
});
