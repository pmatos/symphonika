import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { createAsyncMutex } from "../src/lifecycle/async-mutex.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-issue-triage-clear-stale-test-")
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

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(labels: string[]): Promise<TestSetup> {
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
        issueNumber: 9,
        kind: "filtered",
        labels,
        priority: 1,
        reasons: labels.map((label) => `has operational label ${label}`),
        title: "Stale-claimed issue"
      }
    ]
  });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

describe("clear-stale-claim visibility (#308 part 3, ADR 0077)", () => {
  it("shows the Clear stale claim button when sym:stale is present", async () => {
    const test = await setup(["sym:stale"]);
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/issues/alpha/9", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("Clear stale claim");
      expect(html).toContain('action="/issues/alpha/9/clear-stale-claim"');
    } finally {
      test.cleanup();
    }
  });

  it("hides the Clear stale claim button when no claim label is present", async () => {
    const test = await setup(["bug"]);
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/issues/alpha/9", { headers: browserHeaders() })
      ).text();
      expect(html).not.toContain("Clear stale claim");
    } finally {
      test.cleanup();
    }
  });
});

describe("POST /issues/:project/:number/clear-stale-claim (#308 part 3)", () => {
  it("removes every present claim label and offers poll-now on success", async () => {
    const test = await setup(["sym:stale", "sym:claimed"]);
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
      const response = await app.request("/issues/alpha/9/clear-stale-claim", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Cleared stale claim on GitHub");
      expect(html).toContain('action="/issues/poll-now"');
      expect(received).toEqual({
        add: [],
        kind: "issue",
        projectName: "alpha",
        remove: ["sym:stale", "sym:claimed"],
        subjectNumber: 9
      });
    } finally {
      test.cleanup();
    }
  });

  it("waits for the claim mutex before checking liveness, so a claim landing concurrently isn't wiped", async () => {
    const test = await setup(["sym:stale", "sym:claimed"]);
    try {
      const claimMutex = createAsyncMutex();
      let writeIssueLabelsCalled = false;
      const app = createHttpApp({
        claimMutex,
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => {
          writeIssueLabelsCalled = true;
          return Promise.resolve({ ok: true });
        }
      });
      // Simulates RunController's retry-claim path already holding the
      // mutex (ADR 0052) when the clear-stale-claim request arrives.
      await claimMutex.acquire();
      const responsePromise = app.request("/issues/alpha/9/clear-stale-claim", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Still blocked on the mutex — the liveness check hasn't run yet, so
      // it can't have raced the (still in-flight, in this scenario) claim.
      expect(writeIssueLabelsCalled).toBe(false);

      claimMutex.release();
      const response = await responsePromise;
      const html = await response.text();
      expect(html).toContain("Cleared stale claim on GitHub");
      expect(writeIssueLabelsCalled).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it("refuses with no writeIssueLabels call when no claim label is present", async () => {
    const test = await setup(["bug"]);
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
      const response = await app.request("/issues/alpha/9/clear-stale-claim", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Clear stale claim failed");
      expect(html).toContain("no stale-claim labels to clear");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses when the in-process active-run registry shows a live Run for the issue", async () => {
    const test = await setup(["sym:claimed"]);
    try {
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
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => {
          called = true;
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/issues/alpha/9/clear-stale-claim", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Refused: run run-live-1 is live for this issue");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses when the Run Store shows an active (queued/running) Run for the issue", async () => {
    const test = await setup(["sym:claimed"]);
    try {
      let called = false;
      test.runStore.createRun({
        id: "run-active-1",
        issue: sampleIssue({ number: 9 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
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
      const response = await app.request("/issues/alpha/9/clear-stale-claim", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain(
        "Refused: run run-active-1 is live for this issue"
      );
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("refuses when the Run Store shows a parked (waiting) Run for the issue", async () => {
    const test = await setup(["sym:claimed"]);
    try {
      let called = false;
      test.runStore.createRun({
        id: "run-waiting-1",
        issue: sampleIssue({ number: 9 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-waiting-1", "waiting");
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
      const response = await app.request("/issues/alpha/9/clear-stale-claim", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain(
        "Refused: run run-waiting-1 is live for this issue"
      );
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("surfaces a failed write honestly, without a poll-now offer", async () => {
    const test = await setup(["sym:stale"]);
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
          Promise.resolve({ error: "GitHub API down", ok: false })
      });
      const response = await app.request("/issues/alpha/9/clear-stale-claim", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const html = await response.text();
      expect(html).toContain("Clear stale claim failed");
      expect(html).toContain("GitHub API down");
      expect(html).not.toContain('action="/issues/poll-now"');
    } finally {
      test.cleanup();
    }
  });

  it("404s for an issue outside the snapshot", async () => {
    const test = await setup(["sym:stale"]);
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request(
        "/issues/alpha/999/clear-stale-claim",
        {
          body: formBody({ csrf_token: VALID_TOKEN }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST"
        }
      );
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });
});
