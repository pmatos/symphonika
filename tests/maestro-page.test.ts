import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { MaestroConfig } from "../src/maestro/config.js";
import type { MaestroModel, MaestroModelTurn } from "../src/maestro/model.js";
import type { MaestroWorkspace } from "../src/maestro/workspace.js";
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
  provider: "anthropic",
  repositoryContent: "none"
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

  it("still persists a reply (not an orphaned user message) when the turn throws (#874)", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        createMaestroModel: () => ({
          nextTurn: () => Promise.reject(new Error("boom"))
        }),
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

      const conversation = test.runStore.findDashboardMaestroConversation();
      expect(conversation).toBeDefined();
      const messages = test.runStore.listMaestroMessages(conversation!.id);
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant"
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("refuses a second overlapping POST while a turn is already in flight (#874)", async () => {
    const test = await setup();
    try {
      let resolveTurn: ((turn: MaestroModelTurn) => void) | undefined;
      let notifyTurnStarted: (() => void) | undefined;
      const turnStarted = new Promise<void>((resolve) => {
        notifyTurnStarted = resolve;
      });

      const app = createHttpApp({
        createMaestroModel: () => ({
          nextTurn: () =>
            new Promise<MaestroModelTurn>((resolveTurnResult) => {
              resolveTurn = resolveTurnResult;
              notifyTurnStarted?.();
            })
        }),
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => MAESTRO_CONFIG,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const firstRequest = app.request("/maestro/messages", {
        body: formBody({ csrf_token: VALID_TOKEN, message: "first" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });

      await turnStarted;

      const secondResponse = await app.request("/maestro/messages", {
        body: formBody({ csrf_token: VALID_TOKEN, message: "second" }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });

      expect(secondResponse.status).toBe(303);
      expect(secondResponse.headers.get("location")).toContain(
        "/maestro?error="
      );

      resolveTurn?.({ kind: "message", text: "done" });
      await firstRequest;
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

  it("survives a daemon restart at the HTTP layer: a new app on the same state root sees the history", async () => {
    const test = await setup();
    {
      const firstApp = createHttpApp({
        createMaestroModel: () => fakeModel("Nothing is eligible right now."),
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => MAESTRO_CONFIG,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      await firstApp.request("/maestro/messages", {
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
      test.runStore.close();

      const reopenedStore = openRunStore({ stateRoot: test.stateRoot });
      try {
        const secondApp = createHttpApp({
          csrfSecret: TEST_SECRET,
          getMaestroConfig: () => MAESTRO_CONFIG,
          runStore: reopenedStore,
          stateRoot: test.stateRoot,
          version: "0.1.0"
        });
        const html = await (
          await secondApp.request("/maestro", { headers: browserHeaders() })
        ).text();
        expect(html).toContain("What&#39;s eligible?");
        expect(html).toContain("Nothing is eligible right now.");
      } finally {
        reopenedStore.close();
      }
    }
    // test.runStore was already closed above (simulating the restart), so
    // test.cleanup() is deliberately not called here — closing a RunStore
    // twice throws. afterEach still removes the temp state root either way.
  });
});

describe("Maestro repository content over HTTP (#867)", () => {
  const SHA = "c".repeat(40);
  const readFileTurn: MaestroModelTurn = {
    kind: "tool_use",
    toolUses: [
      {
        id: "toolu_1",
        input: { path: "README.md", project_name: "symphonika" },
        name: "workspace_read_file"
      }
    ]
  };

  const workspace: MaestroWorkspace = {
    session: () => ({
      listFiles: () => Promise.reject(new Error("unused")),
      readFile: (_revision, filePath) =>
        Promise.resolve({
          content: {
            content: "hello",
            path: filePath,
            size: 5,
            truncated: false
          },
          kind: "ok"
        }),
      resolve: () =>
        Promise.resolve({
          kind: "ok",
          revision: {
            fetchedAt: "2026-10-09T12:00:00.000Z",
            owner: "pmatos",
            ref: "main",
            repo: "symphonika",
            repository: "pmatos/symphonika",
            sha: SHA,
            source: "default_branch",
            visibility: "public"
          }
        }),
      search: () => Promise.reject(new Error("unused"))
    })
  };

  function scripted(offered: string[][]): () => MaestroModel {
    return () => {
      let round = 0;
      return {
        nextTurn: (input) => {
          offered.push(input.tools.map((tool) => tool.name));
          round += 1;
          return Promise.resolve(
            round === 1
              ? readFileTurn
              : { kind: "message", text: "It says hello." }
          );
        }
      };
    };
  }

  async function ask(app: ReturnType<typeof createHttpApp>): Promise<string> {
    await app.request("/maestro/messages", {
      body: formBody({
        csrf_token: VALID_TOKEN,
        message: "What is in README?"
      }),
      headers: {
        ...browserHeaders(),
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST",
      redirect: "manual"
    });
    return await (
      await app.request("/maestro", { headers: browserHeaders() })
    ).text();
  }

  it("persists and renders an external repository citation when enabled", async () => {
    const test = await setup();
    try {
      const offered: string[][] = [];
      const app = createHttpApp({
        createMaestroModel: scripted(offered),
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => ({
          ...MAESTRO_CONFIG,
          repositoryContent: "public"
        }),
        getProjectRepo: () => ({ owner: "pmatos", repo: "symphonika" }),
        maestroWorkspace: workspace,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const html = await ask(app);

      expect(offered[0]).toContain("workspace_read_file");
      expect(html).toContain(
        `href="https://github.com/pmatos/symphonika/blob/${SHA}/README.md"`
      );
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain("It says hello.");
    } finally {
      test.cleanup();
    }
  });

  it("never offers workspace tools when repository_content is none, even with a workspace wired", async () => {
    const test = await setup();
    try {
      const offered: string[][] = [];
      const app = createHttpApp({
        createMaestroModel: scripted(offered),
        csrfSecret: TEST_SECRET,
        getMaestroConfig: () => MAESTRO_CONFIG,
        getProjectRepo: () => ({ owner: "pmatos", repo: "symphonika" }),
        maestroWorkspace: workspace,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const html = await ask(app);

      expect(offered.flat().some((name) => name.startsWith("workspace_"))).toBe(
        false
      );
      expect(html).not.toContain("github.com/pmatos/symphonika/blob");
    } finally {
      test.cleanup();
    }
  });

  it.each([
    ["none", "Repository content: off"],
    ["public", "Repository content: public repositories only"],
    ["public_and_private", "Repository content: public and private"]
  ] as const)(
    "states the %s disclosure setting and the no-shell boundary on the page",
    async (repositoryContent, expected) => {
      const test = await setup();
      try {
        const app = createHttpApp({
          csrfSecret: TEST_SECRET,
          getMaestroConfig: () => ({ ...MAESTRO_CONFIG, repositoryContent }),
          runStore: test.runStore,
          stateRoot: test.stateRoot,
          version: "0.1.0"
        });

        const html = await (
          await app.request("/maestro", { headers: browserHeaders() })
        ).text();

        expect(html).toContain(expected);
        expect(html).toContain("no GitHub-write, shell, or local-file tool");
      } finally {
        test.cleanup();
      }
    }
  );
});
