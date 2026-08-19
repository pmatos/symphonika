import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-issue-triage-labels-test-")
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
  runStore.replaceProjectIssueSnapshots({
    polledAt: "2026-05-22T10:00:00.000Z",
    projectName: "alpha",
    repository: { owner: "pmatos", repo: "alpha" },
    rows: [
      {
        blockedByTruncated: false,
        blockedBy: [],
        issueNumber: 7,
        kind: "filtered",
        labels: ["needs-human", "sym:stale"],
        priority: 1,
        reasons: [
          "has excluded label needs-human",
          "has operational label sym:stale"
        ],
        title: "Triaged issue"
      }
    ]
  });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

describe("GET /issues/:project/:number (#308 part 2, ADR 0077)", () => {
  it("renders the issue's verdict and full label set", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/issues/alpha/7", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("Triaged issue");
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
        await app.request("/issues/alpha/7", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('name="label" value="needs-human"');
      expect(html).not.toContain('name="label" value="sym:stale"');
    } finally {
      test.cleanup();
    }
  });

  it("renders a not-found page for an issue outside the snapshot", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/issues/alpha/999", {
        headers: browserHeaders()
      });
      expect(response.status).toBe(404);
      const html = await response.text();
      expect(html).toContain("Issue not found");
    } finally {
      test.cleanup();
    }
  });

  it("lists blockers with number, title, state, and owner/repo for a cross-repo one", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-08-18T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        {
          blockedByTruncated: false,
          blockedBy: [
            {
              number: 301,
              owner: "pmatos",
              repo: "symphonika",
              state: "OPEN",
              title: "sibling slice"
            },
            {
              number: 295,
              owner: "pmatos",
              repo: "symphonika",
              state: "CLOSED",
              title: "slice 6"
            },
            {
              number: 4,
              owner: "someone-else",
              repo: "other-repo",
              state: "OPEN",
              title: "external blocker"
            }
          ],
          issueNumber: 299,
          kind: "filtered",
          labels: ["agent-ready"],
          priority: 1,
          reasons: ["blocked by open dependency #301"],
          title: "Migrate live routines"
        }
      ]
    });
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore,
        stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/issues/alpha/299", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("sibling slice");
      expect(html).toContain("#301");
      expect(html).toContain("OPEN");
      expect(html).toContain("slice 6");
      expect(html).toContain("CLOSED");
      expect(html).toContain("someone-else/other-repo#4");
    } finally {
      runStore.close();
    }
  });

  it("shows a truncated-overflow row even when every fetched blocker is closed", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-08-18T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        {
          blockedByTruncated: true,
          blockedBy: [
            {
              number: 295,
              owner: "pmatos",
              repo: "symphonika",
              state: "CLOSED",
              title: "slice 6"
            }
          ],
          issueNumber: 299,
          kind: "filtered",
          labels: ["agent-ready"],
          priority: 1,
          reasons: [
            "has more dependency links than could be checked - treat as unresolved until reviewed"
          ],
          title: "Migrate live routines"
        }
      ]
    });
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore,
        stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/issues/alpha/299", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("Dependencies");
      expect(html).toContain("slice 6");
      expect(html).toContain("more dependency links than could be checked");
    } finally {
      runStore.close();
    }
  });

  it("shows a truncated-overflow row even for an issue with no fetched blockers at all", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-08-18T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        {
          blockedByTruncated: true,
          blockedBy: [],
          issueNumber: 299,
          kind: "filtered",
          labels: ["agent-ready"],
          priority: 1,
          reasons: [
            "has more dependency links than could be checked - treat as unresolved until reviewed"
          ],
          title: "Migrate live routines"
        }
      ]
    });
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore,
        stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/issues/alpha/299", { headers: browserHeaders() })
      ).text();
      // Must not silently omit the section (the pre-fix behavior for an
      // empty blockedBy array) even though the gate treats this issue as
      // blocked.
      expect(html).toContain("Dependencies");
      expect(html).toContain("more dependency links than could be checked");
    } finally {
      runStore.close();
    }
  });

  it("shows no dependencies section for an issue with no blockers", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/issues/alpha/7", { headers: browserHeaders() })
      ).text();
      expect(html).not.toContain("Dependencies");
    } finally {
      test.cleanup();
    }
  });
});

describe("POST /issues/:project/:number/labels/(add|remove) (#308 part 2)", () => {
  it("adds a non-sym label and offers poll-now on success", async () => {
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
      const response = await app.request("/issues/alpha/7/labels/add", {
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
      expect(html).toContain('action="/issues/poll-now"');
      expect(received).toEqual({
        add: ["agent-ready"],
        kind: "issue",
        projectName: "alpha",
        remove: [],
        snapshotRepository: { owner: "pmatos", repo: "alpha" },
        subjectNumber: 7
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
      const response = await app.request("/issues/alpha/7/labels/add", {
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
          Promise.resolve({
            error: "GitHub API rate limited",
            ok: false
          })
      });
      const response = await app.request("/issues/alpha/7/labels/remove", {
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
      expect(html).not.toContain('action="/issues/poll-now"');
      // The displayed labels are read from the untouched persisted
      // snapshot, so a failed write can't silently render as a change.
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
      const response = await app.request("/issues/alpha/7/labels/add", {
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

  it("404s a label write for an issue outside the snapshot", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => Promise.resolve({ ok: true })
      });
      const response = await app.request("/issues/alpha/999/labels/add", {
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

describe("POST /issues/:project/:number/labels/add dependency gate", () => {
  async function setupBlocked(): Promise<TestSetup> {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-08-18T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        {
          blockedByTruncated: false,
          blockedBy: [
            {
              number: 301,
              owner: "pmatos",
              repo: "symphonika",
              state: "OPEN",
              title: "sibling slice"
            }
          ],
          issueNumber: 8,
          kind: "filtered",
          labels: ["needs-triage"],
          priority: 1,
          reasons: ["blocked by open dependency #301"],
          title: "Blocked issue"
        }
      ]
    });
    return {
      cleanup: () => runStore.close(),
      runStore,
      stateRoot
    };
  }

  it("refuses to add the project's required label while a dependency is unresolved, without calling writeIssueLabels", async () => {
    const test = await setupBlocked();
    try {
      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getProjectRequiredLabels: () => ["agent-ready"],
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
        writeIssueLabels: () => {
          called = true;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/issues/alpha/8/labels/add", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "agent-ready" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('Add label "agent-ready" failed');
      expect(html).toContain("#301");
      expect(html).toContain('action="/issues/poll-now"');
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses a case-variant spelling of the required label the same as the canonical spelling", async () => {
    const test = await setupBlocked();
    try {
      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getProjectRequiredLabels: () => ["agent-ready"],
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
        writeIssueLabels: () => {
          called = true;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/issues/alpha/8/labels/add", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "Agent-Ready" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('Add label "Agent-Ready" failed');
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses to add the required label when the dependency fetch was truncated, even if every fetched blocker is closed", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-08-18T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        {
          blockedBy: [
            {
              number: 295,
              owner: "pmatos",
              repo: "symphonika",
              state: "CLOSED",
              title: "one of many"
            }
          ],
          blockedByTruncated: true,
          issueNumber: 50,
          kind: "filtered",
          labels: ["needs-triage"],
          priority: 1,
          reasons: [
            "has more dependency links than could be checked - treat as unresolved until reviewed"
          ],
          title: "Truncated fetch"
        }
      ]
    });
    try {
      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getProjectRequiredLabels: () => ["agent-ready"],
        runStore,
        stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => {
          called = true;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/issues/alpha/50/labels/add", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "agent-ready" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('Add label "agent-ready" failed');
      expect(called).toBe(false);
    } finally {
      runStore.close();
    }
  });

  it("allows adding a label that isn't the project's required label even while blocked", async () => {
    const test = await setupBlocked();
    try {
      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getProjectRequiredLabels: () => ["agent-ready"],
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => {
          called = true;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/issues/alpha/8/labels/add", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "needs-triage" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('Added label "needs-triage" on GitHub');
      expect(called).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it("allows removing the required label from a blocked issue (removal is unaffected)", async () => {
    const test = await setupBlocked();
    try {
      let called = false;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getProjectRequiredLabels: () => ["agent-ready"],
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => {
          called = true;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/issues/alpha/8/labels/remove", {
        body: formBody({ csrf_token: VALID_TOKEN, label: "agent-ready" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain('Removed label "agent-ready" on GitHub');
      expect(called).toBe(true);
    } finally {
      test.cleanup();
    }
  });
});

describe("POST /issues/poll-now (#308 part 2)", () => {
  it("triggers a poll and reports its outcome", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        pollNow: () => ({
          candidateIssues: 1,
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
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Poll queued");
    } finally {
      test.cleanup();
    }
  });

  it("reports unavailable when no pollNow trigger is wired", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/issues/poll-now", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Poll-now trigger unavailable");
    } finally {
      test.cleanup();
    }
  });
});
