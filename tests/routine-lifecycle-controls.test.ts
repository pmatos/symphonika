import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { contentHash } from "../src/content-hash.js";
import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

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

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-lifecycle-test-")
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

function extractHidden(html: string, name: string): string {
  const match = new RegExp(
    `<input type="hidden" name="${name}" value="([^"]*)"`
  ).exec(html);
  if (match?.[1] === undefined) {
    throw new Error(`hidden field "${name}" not found in: ${html}`);
  }
  return match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const VALID_DECLARATION = `---
name: audit
kind: report
schedule:
  at: "2026-05-22T10:00:00.000Z"
---
Audit the codebase.
`;

type TestSetup = {
  cleanup: () => void;
  routinePath: string;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  const routinePath = path.join(stateRoot, "audit.md");
  await writeFile(routinePath, VALID_DECLARATION, "utf8");
  runStore.syncRoutines([
    {
      kind: "report",
      name: "audit",
      prompt: "Audit the codebase.",
      provider: null,
      projectName: "alpha",
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: routinePath
    }
  ]);
  return {
    cleanup: () => runStore.close(),
    routinePath,
    runStore,
    stateRoot
  };
}

describe("routine disable/enable (#307 part 4, ADR 0076)", () => {
  it("the routine page shows a Disable button for an active routine", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('action="/routines/audit/disable"');
      expect(html).toContain("Disable routine");
      expect(html).not.toContain("Enable routine");
    } finally {
      test.cleanup();
    }
  });

  it("shows lifecycle controls when the first target was removed but a live target remains", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit the codebase.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: test.routinePath
        },
        {
          kind: "report",
          name: "audit",
          prompt: "Audit the codebase.",
          provider: null,
          projectName: "beta",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: test.routinePath
        }
      ]);
      test.runStore.syncRoutines(
        [
          {
            kind: "report",
            name: "audit",
            prompt: "Audit the codebase.",
            provider: null,
            projectName: "beta",
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: test.routinePath
          }
        ],
        { projects: ["alpha", "beta"] }
      );

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('action="/routines/audit/disable"');
      expect(html).toContain("Disable routine");
      expect(html).not.toContain("Enable routine");
    } finally {
      test.cleanup();
    }
  });

  it("shows Enable when an inactive target sorts before an operator-disabled target", async () => {
    const test = await setup();
    try {
      const disabledDeclaration = {
        disabled: true,
        kind: "report" as const,
        name: "audit",
        prompt: "Audit the codebase.",
        provider: null,
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: test.routinePath
      };
      test.runStore.syncRoutines([
        { ...disabledDeclaration, projectName: "alpha" },
        { ...disabledDeclaration, projectName: "beta" },
        { ...disabledDeclaration, projectName: "gamma" }
      ]);
      test.runStore.syncRoutines(
        [
          { ...disabledDeclaration, projectName: "beta" },
          { ...disabledDeclaration, projectName: "gamma" }
        ],
        { projects: ["alpha", "beta", "gamma"] }
      );
      test.runStore.markRoutinesInactiveForProject("beta");

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('action="/routines/audit/enable"');
      expect(html).toContain("Enable routine");
      expect(html).not.toContain("Disable routine");
    } finally {
      test.cleanup();
    }
  });

  it("POST /disable renders a confirm-diff page whose confirm posts to /edit/confirm", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/audit/disable", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Confirm disabling audit");
      expect(html).toContain('action="/routines/audit/edit/confirm"');
      expect(html).toContain("diff-add");
      expect(extractHidden(html, "content")).toContain("disabled: true");
      expect(extractHidden(html, "expected_content_hash")).toBe(
        contentHash(VALID_DECLARATION)
      );
    } finally {
      test.cleanup();
    }
  });

  it("confirming the disable toggle writes disabled: true and preserves the prompt body", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        triggerReload: () => Promise.resolve({ errors: [], ok: true }),
        version: "0.1.0"
      });
      const preview = await app.request("/routines/audit/disable", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const previewHtml = await preview.text();
      const toggledContent = extractHidden(previewHtml, "content");

      const confirm = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content: toggledContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION)
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(confirm.status).toBe(303);

      const written = await readFile(test.routinePath, "utf8");
      expect(written).toContain("disabled: true");
      expect(written).toContain("Audit the codebase.");

      // The write itself takes effect on the next dispatch tick's
      // syncRoutines call (#307 AC), which triggerReload's no-op mock
      // above deliberately doesn't simulate -- reproduce that tick here to
      // verify the page reflects it once it happens.
      test.runStore.syncRoutines([
        {
          disabled: true,
          kind: "report",
          name: "audit",
          prompt: "Audit the codebase.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: test.routinePath
        }
      ]);
      const routinePage = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(routinePage).toContain("Enable routine");
      expect(routinePage).not.toContain("Disable routine");
    } finally {
      test.cleanup();
    }
  });

  it("does not offer a toggle button for a routine removed from config", async () => {
    const test = await setup();
    try {
      // Removing the routine from the sync set (with the project still
      // present) soft-disables it with disabled_reason = removed_from_config.
      test.runStore.syncRoutines([], { projects: ["alpha"] });

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).not.toContain("Disable routine");
      expect(html).not.toContain("Enable routine");
    } finally {
      test.cleanup();
    }
  });
});

describe("firing cancellation redirect (#307 part 4, ADR 0060/0076)", () => {
  async function setupWithFiring(state: "queued" | "succeeded") {
    const test = await setup();
    test.runStore.createRoutineFiring({
      branchName: "sym/audit-fire-1",
      branchRef: "refs/heads/sym/audit-fire-1",
      id: "fire-1",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "audit",
      workspacePath: "/tmp/ws"
    });
    if (state === "succeeded") {
      test.runStore.updateRoutineFiringState("fire-1", "running");
      test.runStore.updateRoutineFiringState("fire-1", "succeeded");
    }
    return test;
  }

  it("shows a Cancel firing button for a live firing, not for a terminal one", async () => {
    const live = await setupWithFiring("queued");
    const terminal = await setupWithFiring("succeeded");
    try {
      const liveApp = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: live.runStore,
        stateRoot: live.stateRoot,
        version: "0.1.0"
      });
      const liveHtml = await (
        await liveApp.request("/firings/fire-1", { headers: browserHeaders() })
      ).text();
      expect(liveHtml).toContain("Cancel firing");

      const terminalApp = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: terminal.runStore,
        stateRoot: terminal.stateRoot,
        version: "0.1.0"
      });
      const terminalHtml = await (
        await terminalApp.request("/firings/fire-1", {
          headers: browserHeaders()
        })
      ).text();
      expect(terminalHtml).not.toContain("Cancel firing");
    } finally {
      live.cleanup();
      terminal.cleanup();
    }
  });

  it("cancelling a firing redirects to /firings/:id, not /runs/:id", async () => {
    const test = await setupWithFiring("queued");
    try {
      const app = createHttpApp({
        cancelRun: () => ({ kind: "cancelled" }),
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/api/runs/fire-1/cancel", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/firings/fire-1");
    } finally {
      test.cleanup();
    }
  });

  it("cancelling a run still redirects to /runs/:id", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      const app = createHttpApp({
        cancelRun: () => ({ kind: "cancelled" }),
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/api/runs/run-a/cancel", {
        body: formBody({ csrf_token: VALID_TOKEN }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/runs/run-a");
    } finally {
      test.cleanup();
    }
  });
});
