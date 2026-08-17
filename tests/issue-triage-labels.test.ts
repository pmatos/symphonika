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
    rows: [
      {
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
        body: formBody({ csrf_token: VALID_TOKEN, label: "agent-ready" }),
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
        issueNumber: 7,
        projectName: "alpha",
        remove: []
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
