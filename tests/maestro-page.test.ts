import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { MaestroConfig } from "../src/maestro/config.js";
import type { MaestroModel } from "../src/maestro/model.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-maestro-page-"));
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

const MAESTRO_CONFIG: MaestroConfig = {
  apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
  maxOutputTokens: 1024,
  model: "claude-sonnet-5",
  provider: "anthropic"
};

function fakeModel(text: string): MaestroModel {
  return { nextTurn: () => Promise.resolve({ kind: "message", text }) };
}

async function setup(): Promise<{
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
}> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  return { cleanup: () => runStore.close(), runStore, stateRoot };
}

describe("Maestro dashboard chat page (#865)", () => {
  it("explains the read-only boundary and offers no form when Maestro is not configured", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/maestro", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("read-only");
      expect(html).toContain("not configured");
      expect(html).not.toContain('name="message"');
    } finally {
      test.cleanup();
    }
  });

  it("shows an empty conversation with a chat form when configured", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => MAESTRO_CONFIG,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/maestro", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('name="message"');
      expect(html).toContain('action="/maestro/messages"');
    } finally {
      test.cleanup();
    }
  });

  it("posts a message, runs a turn, persists both messages, and redirects back", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        createMaestroModel: () => fakeModel("Nothing is eligible right now."),
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => MAESTRO_CONFIG,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/maestro/messages", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          message: "What's eligible?"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/maestro");

      const html = await (
        await app.request("/maestro", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("What&#39;s eligible?");
      expect(html).toContain("Nothing is eligible right now.");
    } finally {
      test.cleanup();
    }
  });

  it("rejects a POST with a missing or stale CSRF token and persists nothing", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        createMaestroModel: () => fakeModel("should never run"),
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => MAESTRO_CONFIG,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/maestro/messages", {
        body: formBody({ csrf_token: "wrong", message: "hello" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });

      expect(response.status).toBe(403);
      expect(test.runStore.findDashboardMaestroConversation()).toBeUndefined();
    } finally {
      test.cleanup();
    }
  });

  it("refuses to post when Maestro is not configured, persisting nothing", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/maestro/messages", {
        body: formBody({ csrf_token: VALID_TOKEN, message: "hello" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });

      expect(response.status).toBe(303);
      expect(test.runStore.findDashboardMaestroConversation()).toBeUndefined();
    } finally {
      test.cleanup();
    }
  });

  it("keeps a chat exchange out of run counts and the runs listing (AC2)", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        createMaestroModel: () => fakeModel("Nothing is eligible right now."),
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => MAESTRO_CONFIG,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      await app.request("/maestro/messages", {
        body: formBody({
          csrf_token: VALID_TOKEN,
          message: "What's eligible?"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });

      const status = (await (await app.request("/api/status")).json()) as {
        active: unknown[];
        candidateIssues: unknown[];
      };
      expect(status.active).toEqual([]);
      expect(status.candidateIssues).toEqual([]);
      expect(test.runStore.listRuns()).toEqual([]);
    } finally {
      test.cleanup();
    }
  });
});
