import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-http-csrf-test-"));
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

const TEST_SECRET: CsrfSecret = randomBytes(32);
const SESSION_ID = "a".repeat(32);
const VALID_TOKEN = csrfTokenFor(TEST_SECRET, SESSION_ID);
const HOST = "127.0.0.1:4000";
const ORIGIN = `http://${HOST}`;

function browserHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    cookie: `sym_session=${SESSION_ID}`,
    host: HOST,
    origin: ORIGIN,
    ...extra
  };
}

type MutatingRoute = {
  init: RequestInit;
  path: string;
  successStatuses: number[];
};

describe("HTTP app — mutation authentication (#306 part 1, ADR 0075)", () => {
  function routesUnderTest(test: TestSetup): MutatingRoute[] {
    test.runStore.syncRoutines([
      {
        kind: "report",
        name: "audit",
        prompt: "Audit.",
        provider: "codex",
        projectName: "alpha",
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: "/tmp/audit.md"
      }
    ]);
    test.runStore.createRun({
      id: "run-a",
      issue: sampleIssue({ number: 1 }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    return [
      {
        init: { method: "POST" },
        path: "/api/poll-now",
        successStatuses: [200, 503]
      },
      {
        init: { method: "POST" },
        path: "/api/routines/audit/fire",
        successStatuses: [202, 404, 409, 503]
      },
      {
        init: { method: "POST" },
        path: "/api/runs/run-a/cancel",
        successStatuses: [200, 503]
      },
      {
        init: { method: "POST" },
        path: "/api/update-now",
        successStatuses: [200, 503]
      }
    ];
  }

  it("allows a CLI-style request (no Origin, no Sec-Fetch-Site) on every mutating route", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, route.init);
        expect(route.successStatuses).toContain(response.status);
      }
    } finally {
      test.cleanup();
    }
  });

  it("allows a same-origin browser request carrying a valid CSRF token", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, {
          ...route.init,
          headers: browserHeaders({ "x-csrf-token": VALID_TOKEN })
        });
        expect(route.successStatuses).toContain(response.status);
      }
    } finally {
      test.cleanup();
    }
  });

  it("rejects a cross-origin browser request even with a valid token", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, {
          ...route.init,
          headers: {
            cookie: `sym_session=${SESSION_ID}`,
            host: HOST,
            origin: "http://evil.example",
            "x-csrf-token": VALID_TOKEN
          }
        });
        expect(response.status).toBe(403);
      }
    } finally {
      test.cleanup();
    }
  });

  it("rejects a DNS-rebound request even when Origin matches the reflected Host", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      // Simulates a successful DNS rebind: the attacker's own hostname
      // resolves to the daemon's loopback address, so the browser's Origin
      // and Host headers agree with each other while both name a domain
      // the attacker controls — the same-origin check must not treat that
      // agreement as proof the request actually came from this daemon.
      const reboundHost = "attacker.example:4000";
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, {
          ...route.init,
          headers: {
            cookie: `sym_session=${SESSION_ID}`,
            host: reboundHost,
            origin: `http://${reboundHost}`,
            "x-csrf-token": VALID_TOKEN
          }
        });
        expect(response.status).toBe(403);
      }
    } finally {
      test.cleanup();
    }
  });

  it("rejects a same-origin browser request with Sec-Fetch-Site: cross-site", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, {
          ...route.init,
          headers: browserHeaders({
            "sec-fetch-site": "cross-site",
            "x-csrf-token": VALID_TOKEN
          })
        });
        expect(response.status).toBe(403);
      }
    } finally {
      test.cleanup();
    }
  });

  it("rejects a same-origin browser request with no session cookie", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, {
          ...route.init,
          headers: { host: HOST, origin: ORIGIN, "x-csrf-token": VALID_TOKEN }
        });
        expect(response.status).toBe(403);
      }
    } finally {
      test.cleanup();
    }
  });

  it("rejects a same-origin browser request with a missing CSRF token", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, {
          ...route.init,
          headers: browserHeaders()
        });
        expect(response.status).toBe(403);
      }
    } finally {
      test.cleanup();
    }
  });

  it("rejects a same-origin browser request with a stale/wrong CSRF token", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      for (const route of routesUnderTest(test)) {
        const response = await app.request(route.path, {
          ...route.init,
          headers: browserHeaders({ "x-csrf-token": "0".repeat(64) })
        });
        expect(response.status).toBe(403);
      }
    } finally {
      test.cleanup();
    }
  });

  it("embeds a valid CSRF token in the real cancel-run form, and submitting it succeeds", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-a", "running");
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const page = await app.request("/runs/run-a", {
        headers: { host: HOST, origin: ORIGIN }
      });
      expect(page.status).toBe(200);
      const setCookie = page.headers.get("set-cookie") ?? "";
      const sessionMatch = /sym_session=([0-9a-f]{32})/.exec(setCookie);
      expect(sessionMatch).not.toBeNull();
      const sessionId = sessionMatch?.[1] as string;
      const html = await page.text();
      const tokenMatch = /name="csrf_token" value="([0-9a-f]{64})"/.exec(html);
      expect(tokenMatch).not.toBeNull();
      const token = tokenMatch?.[1] as string;

      const response = await app.request("/api/runs/run-a/cancel", {
        body: `csrf_token=${token}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `sym_session=${sessionId}`,
          host: HOST,
          origin: ORIGIN
        },
        method: "POST"
      });
      // A form-encoded submission gets the redirect response
      // (wantsRedirect), not the JSON one — see app.ts's cancel handler.
      expect(response.status).toBe(303);
      expect(test.runStore.getRun("run-a")?.cancelRequested).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it("rejects the real cancel-run form submitted cross-origin", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-a", "running");
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const page = await app.request("/runs/run-a", {
        headers: { host: HOST, origin: ORIGIN }
      });
      const setCookie = page.headers.get("set-cookie") ?? "";
      const sessionId = /sym_session=([0-9a-f]{32})/.exec(setCookie)?.[1];
      const token = /name="csrf_token" value="([0-9a-f]{64})"/.exec(
        await page.text()
      )?.[1];

      const response = await app.request("/api/runs/run-a/cancel", {
        body: `csrf_token=${token}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `sym_session=${sessionId}`,
          host: HOST,
          origin: "http://evil.example"
        },
        method: "POST"
      });
      expect(response.status).toBe(403);
      expect(test.runStore.getRun("run-a")?.state).toBe("running");
    } finally {
      test.cleanup();
    }
  });
});
