import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { contentHash } from "../src/content-hash.js";
import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-editor-test-")
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

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe("routine declaration editor (#307 part 1, ADR 0075/0076)", () => {
  it("GET /routines/:name/edit renders the raw content, its hash, and a CSRF token", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/audit/edit", {
        headers: browserHeaders()
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("name: audit");
      expect(extractHidden(html, "expected_content_hash")).toBe(
        contentHash(VALID_DECLARATION)
      );
      // #307 AC: "Routine declaration -> which Routine Targets, and their
      // next fire times."
      expect(html).toContain("This save affects");
      expect(html).toContain("alpha");
      expect(html).toContain("2026-05-22T10:00:00.000Z");
    } finally {
      test.cleanup();
    }
  });

  it("discloses inactive sibling targets of the selected declaration", async () => {
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
      test.runStore.markRoutinesInactiveForProject("beta");

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const editor = await (
        await app.request("/routines/audit/edit", {
          headers: browserHeaders()
        })
      ).text();

      expect(editor).toContain("This save affects");
      expect(editor).toContain("alpha");
      expect(editor).toContain("beta");
    } finally {
      test.cleanup();
    }
  });

  it("returns 404 for a routine name with no declaration", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/nonexistent/edit", {
        headers: browserHeaders()
      });
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("preview reports validation errors and shows no diff for invalid content", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/audit/edit/preview", {
        body: formBody({
          content: "---\nname: audit\n---\n",
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION)
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("kind is required");
      expect(html).not.toContain("Confirm save");
    } finally {
      test.cleanup();
    }
  });

  it("preview shows a diff and a confirm form for valid content", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const editedContent = VALID_DECLARATION.replace(
        "Audit the codebase.",
        "Audit the codebase thoroughly."
      );
      const response = await app.request("/routines/audit/edit/preview", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION)
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Confirm save");
      expect(html).toContain("diff-del");
      expect(html).toContain("diff-add");
      expect(extractHidden(html, "content")).toBe(editedContent);
    } finally {
      test.cleanup();
    }
  });

  it("confirm writes the file, triggers reload, and redirects to the routine page", async () => {
    const test = await setup();
    try {
      let reloadCalls = 0;
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        triggerReload: () => {
          reloadCalls++;
          return Promise.resolve({ errors: [], ok: true });
        },
        version: "0.1.0"
      });
      const editedContent = VALID_DECLARATION.replace(
        "Audit the codebase.",
        "Audit the codebase thoroughly."
      );
      const response = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content: editedContent,
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
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/routines/audit?saved=1");
      expect(await readFile(test.routinePath, "utf8")).toBe(editedContent);
      expect(reloadCalls).toBe(1);
    } finally {
      test.cleanup();
    }
  });

  it("keeps an inactive Routine reachable through a declaration save", async () => {
    const test = await setup();
    try {
      test.runStore.markRoutinesInactiveForProject("alpha");
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        triggerReload: () => Promise.resolve({ errors: [], ok: true }),
        version: "0.1.0"
      });
      const detail = await (
        await app.request("/routines/audit?include_inactive=true", {
          headers: browserHeaders()
        })
      ).text();
      expect(detail).toContain(
        'href="/routines/audit/edit?include_inactive=true"'
      );

      const editor = await (
        await app.request("/routines/audit/edit?include_inactive=true", {
          headers: browserHeaders()
        })
      ).text();
      expect(extractHidden(editor, "include_inactive")).toBe("true");

      const editedContent = VALID_DECLARATION.replace(
        "Audit the codebase.",
        "Audit the inactive target."
      );
      const preview = await app.request("/routines/audit/edit/preview", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION),
          include_inactive: "true"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const previewHtml = await preview.text();
      expect(extractHidden(previewHtml, "include_inactive")).toBe("true");

      const confirm = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION),
          include_inactive: "true"
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(confirm.status).toBe(303);
      expect(confirm.headers.get("location")).toBe(
        "/routines/audit?include_inactive=true&saved=1"
      );
      expect(
        (
          await app.request(confirm.headers.get("location") ?? "", {
            headers: browserHeaders()
          })
        ).status
      ).toBe(200);
    } finally {
      test.cleanup();
    }
  });

  it("keeps a directly opened inactive editor reachable after save", async () => {
    const test = await setup();
    try {
      test.runStore.markRoutinesInactiveForProject("alpha");
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        triggerReload: () => Promise.resolve({ errors: [], ok: true }),
        version: "0.1.0"
      });

      const editor = await (
        await app.request("/routines/audit/edit", {
          headers: browserHeaders()
        })
      ).text();
      const includeInactive = extractHidden(editor, "include_inactive");

      const editedContent = VALID_DECLARATION.replace(
        "Audit the codebase.",
        "Audit the directly opened inactive target."
      );
      const preview = await app.request("/routines/audit/edit/preview", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION),
          include_inactive: includeInactive
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const previewHtml = await preview.text();
      const confirmedIncludeInactive = extractHidden(
        previewHtml,
        "include_inactive"
      );

      const confirm = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION),
          include_inactive: confirmedIncludeInactive
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(confirm.status).toBe(303);
      expect(confirm.headers.get("location")).toBe(
        "/routines/audit?include_inactive=true&saved=1"
      );
      expect(
        (
          await app.request(confirm.headers.get("location") ?? "", {
            headers: browserHeaders()
          })
        ).status
      ).toBe(200);
    } finally {
      test.cleanup();
    }
  });

  it("refuses confirmation after the selected declaration is replaced", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        triggerReload: () => Promise.resolve({ errors: [], ok: true }),
        version: "0.1.0"
      });
      const editor = await (
        await app.request("/routines/audit/edit", {
          headers: browserHeaders()
        })
      ).text();
      const expectedSourcePath = extractHidden(editor, "expected_source_path");
      const editedContent = VALID_DECLARATION.replace(
        "Audit the codebase.",
        "Edit the originally selected declaration."
      );
      const preview = await app.request("/routines/audit/edit/preview", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION),
          expected_source_path: expectedSourcePath
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const previewHtml = await preview.text();

      test.runStore.markRoutinesInactiveForProject("alpha");
      const replacementPath = path.join(test.stateRoot, "replacement.md");
      await writeFile(replacementPath, VALID_DECLARATION, "utf8");
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit the codebase.",
          provider: null,
          projectName: "beta",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: replacementPath
        }
      ]);

      const confirm = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content: extractHidden(previewHtml, "content"),
          csrf_token: VALID_TOKEN,
          expected_content_hash: extractHidden(
            previewHtml,
            "expected_content_hash"
          ),
          expected_source_path: extractHidden(
            previewHtml,
            "expected_source_path"
          )
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(confirm.status).toBe(409);
      expect(await readFile(replacementPath, "utf8")).toBe(VALID_DECLARATION);
    } finally {
      test.cleanup();
    }
  });

  it("confirm reports a real reload failure on disk instead of redirecting as saved", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        triggerReload: () =>
          Promise.resolve({ errors: ["schedule_cron: bad cron"], ok: false }),
        version: "0.1.0"
      });
      const editedContent = VALID_DECLARATION.replace(
        "Audit the codebase.",
        "Audit the codebase thoroughly."
      );
      const response = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content: editedContent,
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
      // The write already landed (runSavePipeline writes before reload
      // runs) — the fix under test is that a failed reload no longer
      // redirects as if nothing were wrong.
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Saved, but not active");
      expect(html).toContain("schedule_cron: bad cron");
      expect(await readFile(test.routinePath, "utf8")).toBe(editedContent);
    } finally {
      test.cleanup();
    }
  });

  it("confirm refuses a stale write and does not touch the file", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      // Someone else changed the file after the editor opened.
      const changedOnDisk = VALID_DECLARATION.replace(
        "Audit the codebase.",
        "Changed via the CLI."
      );
      await writeFile(test.routinePath, changedOnDisk, "utf8");

      const response = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content:
            '---\nname: audit\nkind: report\nschedule:\n  at: "2026-05-22T10:00:00.000Z"\n---\nMy stale edit.\n',
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION)
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(409);
      expect(await readFile(test.routinePath, "utf8")).toBe(changedOnDisk);
    } finally {
      test.cleanup();
    }
  });

  it("confirm refuses a path resolveWritePath does not confirm", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        resolveWritePath: () => Promise.resolve(undefined),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/audit/edit/confirm", {
        body: formBody({
          content: VALID_DECLARATION,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION)
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(403);
      expect(await readFile(test.routinePath, "utf8")).toBe(VALID_DECLARATION);
    } finally {
      test.cleanup();
    }
  });

  it("rejects a cross-origin preview submission (CSRF gate applies to preview too)", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/audit/edit/preview", {
        body: formBody({
          content: VALID_DECLARATION,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(VALID_DECLARATION)
        }),
        headers: {
          cookie: `sym_session=${SESSION_ID}`,
          "content-type": "application/x-www-form-urlencoded",
          host: HOST,
          origin: "http://evil.example"
        },
        method: "POST"
      });
      expect(response.status).toBe(403);
    } finally {
      test.cleanup();
    }
  });

  it("shows the disambiguation page, not a bare 404, for an ambiguous name with no ?project=", async () => {
    const test = await setup();
    try {
      // A second, distinct declaration (different sourcePath) reusing the
      // same routine name -- the "stale name reuse" case groupRoutinesByName
      // documents.
      const otherPath = path.join(test.stateRoot, "audit-2.md");
      await writeFile(otherPath, VALID_DECLARATION, "utf8");
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit the codebase.",
          provider: null,
          projectName: "beta",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: otherPath
        }
      ]);

      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/audit/edit", {
        headers: browserHeaders()
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Multiple declarations share this name");
      expect(html).not.toContain("Routine not found");
    } finally {
      test.cleanup();
    }
  });

  it("the routine page links to the edit page", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/audit", {
        headers: browserHeaders()
      });
      const html = await response.text();
      expect(html).toContain('href="/routines/audit/edit"');
    } finally {
      test.cleanup();
    }
  });
});
