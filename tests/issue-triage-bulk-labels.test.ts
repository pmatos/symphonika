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
    path.join(tmpdir(), "symphonika-issue-triage-bulk-labels-test-")
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
    "x-csrf-token": VALID_TOKEN,
    ...extra
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
  runStore.replaceProjectIssueSnapshots({
    polledAt: "2026-05-22T10:00:00.000Z",
    projectName: "alpha",
    rows: [
      {
        issueNumber: 7,
        kind: "candidate",
        labels: ["needs-triage"],
        priority: 1,
        reasons: [],
        title: "First issue"
      },
      {
        issueNumber: 8,
        kind: "candidate",
        labels: ["needs-triage"],
        priority: 1,
        reasons: [],
        title: "Second issue"
      }
    ]
  });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

describe("POST /api/issues/bulk-labels", () => {
  it("rejects a sym:* label in addLabels with 400 and never calls writeIssueLabels", async () => {
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
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["sym:claimed"],
          operations: [{ issueNumber: 7, projectName: "alpha" }],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("managed by Symphonika");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("rejects a case-variant sym:* label (e.g. SYM:claimed) with 400, since GitHub matches label names case-insensitively", async () => {
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
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: [],
          operations: [{ issueNumber: 7, projectName: "alpha" }],
          removeLabels: ["SYM:claimed"]
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("managed by Symphonika");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("rejects an empty operations list with 400", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => Promise.resolve({ ok: true })
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready"],
          operations: [],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("operations");
    } finally {
      test.cleanup();
    }
  });

  it("rejects a request with no labels to add or remove with 400", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: () => Promise.resolve({ ok: true })
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: [],
          operations: [{ issueNumber: 7, projectName: "alpha" }],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("label");
    } finally {
      test.cleanup();
    }
  });

  it("writes the requested labels to every selected issue and reports per-issue success", async () => {
    const test = await setup();
    try {
      const received: unknown[] = [];
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: (input) => {
          received.push(input);
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready"],
          operations: [
            { issueNumber: 7, projectName: "alpha" },
            { issueNumber: 8, projectName: "alpha" }
          ],
          removeLabels: ["needs-triage"]
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: Array<{
          issueNumber: number;
          ok: boolean;
          projectName: string;
        }>;
      };
      expect(body.results).toEqual(
        expect.arrayContaining([
          { issueNumber: 7, ok: true, projectName: "alpha" },
          { issueNumber: 8, ok: true, projectName: "alpha" }
        ])
      );
      expect(body.results).toHaveLength(2);
      expect(received).toEqual(
        expect.arrayContaining([
          {
            add: ["agent-ready"],
            kind: "issue",
            projectName: "alpha",
            remove: ["needs-triage"],
            subjectNumber: 7
          },
          {
            add: ["agent-ready"],
            kind: "issue",
            projectName: "alpha",
            remove: ["needs-triage"],
            subjectNumber: 8
          }
        ])
      );
    } finally {
      test.cleanup();
    }
  });

  it("is best-effort: one issue failing doesn't stop the others, and reports each outcome", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0",
        writeIssueLabels: (input) =>
          input.subjectNumber === 8
            ? Promise.resolve({ error: "GitHub API rate limited", ok: false })
            : Promise.resolve({ ok: true })
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready"],
          operations: [
            { issueNumber: 7, projectName: "alpha" },
            { issueNumber: 8, projectName: "alpha" }
          ],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: Array<{
          error?: string;
          issueNumber: number;
          ok: boolean;
          projectName: string;
        }>;
      };
      expect(body.results).toEqual(
        expect.arrayContaining([
          { issueNumber: 7, ok: true, projectName: "alpha" },
          {
            error: "GitHub API rate limited",
            issueNumber: 8,
            ok: false,
            projectName: "alpha"
          }
        ])
      );
    } finally {
      test.cleanup();
    }
  });

  it("caps concurrent writeIssueLabels calls rather than firing all at once", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-05-22T10:00:00.000Z",
      projectName: "alpha",
      rows: Array.from({ length: 10 }, (_v, i) => ({
        issueNumber: i + 1,
        kind: "candidate" as const,
        labels: ["needs-triage"],
        priority: 1,
        reasons: [],
        title: `Issue ${i + 1}`
      }))
    });
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore,
        stateRoot,
        version: "0.1.0",
        writeIssueLabels: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return { ok: true };
        }
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready"],
          operations: Array.from({ length: 10 }, (_v, i) => ({
            issueNumber: i + 1,
            projectName: "alpha"
          })),
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { results: unknown[] };
      expect(body.results).toHaveLength(10);
      expect(maxInFlight).toBeGreaterThan(0);
      expect(maxInFlight).toBeLessThanOrEqual(4);
    } finally {
      runStore.close();
    }
  });

  it("reports 503 without attempting any write when label writes are unavailable", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready"],
          operations: [{ issueNumber: 7, projectName: "alpha" }],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("label writes are unavailable");
    } finally {
      test.cleanup();
    }
  });

  it("403s a same-origin browser request with a missing csrf token, without calling writeIssueLabels", async () => {
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
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready"],
          operations: [{ issueNumber: 7, projectName: "alpha" }],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders({ "x-csrf-token": "" }),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("rejects the whole request with 400 when operations mixes a valid entry with a malformed one, instead of silently writing only the valid one", async () => {
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
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready"],
          operations: [
            { issueNumber: 7, projectName: "alpha" },
            { issueNumber: "not-a-number", projectName: "beta" }
          ],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("operations");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("rejects the whole request with 400 when addLabels mixes a valid string with a non-string entry", async () => {
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
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: ["agent-ready", 42],
          operations: [{ issueNumber: 7, projectName: "alpha" }],
          removeLabels: []
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("addLabels");
      expect(called).toBe(false);
    } finally {
      test.cleanup();
    }
  });

  it("narrows each issue's removeLabels to the labels it actually has, per ADR 0077's no-needless-404 rule", async () => {
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
          kind: "candidate",
          labels: ["needs-triage", "bug"],
          priority: 1,
          reasons: [],
          title: "Has needs-triage"
        },
        {
          issueNumber: 8,
          kind: "candidate",
          labels: ["agent-ready"],
          priority: 1,
          reasons: [],
          title: "Does not have needs-triage"
        }
      ]
    });
    try {
      const received: unknown[] = [];
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore,
        stateRoot,
        version: "0.1.0",
        writeIssueLabels: (input) => {
          received.push(input);
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: [],
          operations: [
            { issueNumber: 7, projectName: "alpha" },
            { issueNumber: 8, projectName: "alpha" }
          ],
          removeLabels: ["needs-triage"]
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      expect(received).toEqual(
        expect.arrayContaining([
          {
            add: [],
            kind: "issue",
            projectName: "alpha",
            remove: ["needs-triage"],
            subjectNumber: 7
          },
          {
            add: [],
            kind: "issue",
            projectName: "alpha",
            remove: [],
            subjectNumber: 8
          }
        ])
      );
    } finally {
      runStore.close();
    }
  });

  it("matches a requested removeLabels entry against an issue's current label case-insensitively, preserving the requested spelling", async () => {
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
          kind: "candidate",
          labels: ["Needs-Triage"],
          priority: 1,
          reasons: [],
          title: "Label differs only by case"
        }
      ]
    });
    try {
      const received: unknown[] = [];
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore,
        stateRoot,
        version: "0.1.0",
        writeIssueLabels: (input) => {
          received.push(input);
          return Promise.resolve({ ok: true });
        }
      });
      const response = await app.request("/api/issues/bulk-labels", {
        body: JSON.stringify({
          addLabels: [],
          operations: [{ issueNumber: 7, projectName: "alpha" }],
          removeLabels: ["needs-triage"]
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/json"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      expect(received).toEqual([
        {
          add: [],
          kind: "issue",
          projectName: "alpha",
          remove: ["needs-triage"],
          subjectNumber: 7
        }
      ]);
    } finally {
      runStore.close();
    }
  });
});
