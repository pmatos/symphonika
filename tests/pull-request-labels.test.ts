import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import {
  openRunStore,
  type ProjectPullRequestSnapshotRow,
  type RunStore
} from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-pr-labels-test-"));
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

function samplePrRow(
  overrides: Partial<Omit<ProjectPullRequestSnapshotRow, "polledAt">> = {}
): Omit<ProjectPullRequestSnapshotRow, "polledAt"> {
  return {
    branchOrigin: "issue_branch",
    checks: "success",
    draft: false,
    headRef: "sym/alpha/246-fix-login",
    headSha: "abc123",
    labels: ["needs-human", "sym:stale"],
    mergeable: "mergeable",
    merged: false,
    open: true,
    prNumber: 246,
    reviewDecision: "approved",
    stateAvailable: true,
    title: "Triaged PR",
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

describe("GET /prs/:project/:number labels (#309 part 2, ADR 0078)", () => {
  it("renders the PR's full label set", async () => {
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
      expect(html).toContain("needs-human");
      expect(html).toContain("sym:stale");
      expect(html).toContain("managed by Symphonika — not editable here");
      expect(html).toContain('name="snapshot_owner" value="pmatos"');
      expect(html).toContain('name="snapshot_repo" value="alpha"');
    } finally {
      test.cleanup();
    }
  });

  it("offers a Remove form for a non-sym label but not for sym:stale", async () => {
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
      expect(html).toContain('name="label" value="needs-human"');
      expect(html).not.toContain('name="label" value="sym:stale"');
    } finally {
      test.cleanup();
    }
  });
});

describe("POST /prs/:project/:number/labels/(add|remove) (#309 part 2)", () => {
  it("adds a non-sym label, discriminated as pull_request, and offers poll-now back to /prs", async () => {
    const test = await setup();
    try {
      let received: unknown;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        pollNow: () => ({
          candidateIssues: 0,
          dispatching: false,
          errors: 0,
          filteredIssues: 0,
          issuePolling: { errors: [], projects: [] },
          kind: "queued",
          state: "idle"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: (input) => {
          received = input;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/prs/alpha/246/labels/add", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          label: "agent-ready",
          snapshot_owner: "pmatos",
          snapshot_repo: "alpha"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Added label "agent-ready" on GitHub');
      expect(html).toContain('name="return_to" value="/prs"');
      expect(received).toEqual({
        add: ["agent-ready"],
        kind: "pull_request",
        projectName: "alpha",
        remove: [],
        snapshotRepository: { owner: "pmatos", repo: "alpha" },
        subjectNumber: 246
      });
    } finally {
      test.cleanup();
    }
  });

  it("refuses to add or remove a sym:* label without calling writeIssueLabels", async () => {
    const test = await setup();
    try {
      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => {
          called = true;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/prs/alpha/246/labels/add", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "sym:claimed" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('Add label "sym:claimed" failed');
      expect(html).toContain("managed by Symphonika");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("surfaces a failed write honestly, without a poll-now offer", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        pollNow: () => ({
          candidateIssues: 0,
          dispatching: false,
          errors: 0,
          filteredIssues: 0,
          issuePolling: { errors: [], projects: [] },
          kind: "queued",
          state: "idle"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () =>
          Promise.resolve({ error: "GitHub API rate limited", ok: false })
      });
      const response = await app.request("/prs/alpha/246/labels/remove", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "needs-human" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('Remove label "needs-human" failed');
      expect(html).toContain("GitHub API rate limited");
      expect(html).toContain("labels shown below are unchanged");
      expect(html).not.toContain('name="return_to"');
      expect(html).toContain("needs-human");
    } finally {
      test.cleanup();
    }
  });

  it("rejects an empty label", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => Promise.resolve({ ok: true })
      });
      const response = await app.request("/prs/alpha/246/labels/add", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "   " }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("a label is required");
    } finally {
      test.cleanup();
    }
  });

  it("404s a label write for a PR outside the snapshot", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => Promise.resolve({ ok: true })
      });
      const response = await app.request("/prs/alpha/999/labels/add", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "agent-ready" }),
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

describe("POST /issues/poll-now return_to (#309 part 2)", () => {
  it("returns to /prs when triggered from the PR search flow", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        pollNow: () => ({
          candidateIssues: 0,
          dispatching: false,
          errors: 0,
          filteredIssues: 0,
          issuePolling: { errors: [], projects: [] },
          kind: "queued",
          state: "idle"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/issues/poll-now", {
        body: formBody({ csrf_token: VALID_TOKEN, return_to: "/prs" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('href="/prs"');
    } finally {
      test.cleanup();
    }
  });

  it("falls back to /issues for an unrecognized return_to", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        pollNow: () => ({
          candidateIssues: 0,
          dispatching: false,
          errors: 0,
          filteredIssues: 0,
          issuePolling: { errors: [], projects: [] },
          kind: "queued",
          state: "idle"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/issues/poll-now", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          return_to: "https://evil.example/"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('href="/issues"');
    } finally {
      test.cleanup();
    }
  });
});
