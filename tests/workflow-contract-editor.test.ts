import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { contentHash } from "../src/content-hash.js";
import { createHttpApp, type HttpAppOptions } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-workflow-editor-test-")
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

const VALID_MARKDOWN_WORKFLOW = "Work on {{issue.title}}.\n";

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
  workflowPath: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  const workflowPath = path.join(stateRoot, "WORKFLOW.md");
  await writeFile(workflowPath, VALID_MARKDOWN_WORKFLOW, "utf8");
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot,
    workflowPath
  };
}

function appFor(
  test: TestSetup,
  overrides: Partial<HttpAppOptions> = {}
): ReturnType<typeof createHttpApp> {
  return createHttpApp({
    csrfSecret: TEST_SECRET,
    getProjectWorkflowPath: (projectName) =>
      projectName === "alpha"
        ? { format: "auto", path: test.workflowPath }
        : undefined,
    runStore: test.runStore,
    stateRoot: test.stateRoot,
    version: "0.1.0",
    ...overrides
  });
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

describe("workflow contract editor (#307 part 2, ADR 0076)", () => {
  it("GET /projects/:name/workflow/edit renders the content, hash, and the in-flight-Runs blast-radius note", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const response = await app.request("/projects/alpha/workflow/edit", {
        headers: browserHeaders()
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Work on {{issue.title}}.");
      expect(extractHidden(html, "expected_content_hash")).toBe(
        contentHash(VALID_MARKDOWN_WORKFLOW)
      );
      expect(html).toContain("This save affects");
      expect(html).toContain("keeps the workflow graph it started with");
    } finally {
      test.cleanup();
    }
  });

  it("returns 404 for a Project with no workflow (Routine Host or unknown)", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const response = await app.request("/projects/beta/workflow/edit", {
        headers: browserHeaders()
      });
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("preview accepts a raw_fsm .yml workflow that opens with --- (#307's readWorkflowSnapshot parity fix)", async () => {
    const test = await setup();
    const yamlPath = path.join(test.stateRoot, "workflow.yml");
    await writeFile(yamlPath, "workflow:\n  name: x\n", "utf8");
    try {
      const app = appFor(test, {
        getProjectWorkflowPath: (projectName) =>
          projectName === "gamma"
            ? { format: "auto", path: yamlPath }
            : undefined
      });
      const rawFsmContent = [
        "---",
        "workflow:",
        "  name: minimal",
        "  initial: done",
        "  states:",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n");
      const response = await app.request(
        "/projects/gamma/workflow/edit/preview",
        {
          body: formBody({
            content: rawFsmContent,
            csrf_token: VALID_TOKEN,
            expected_content_hash: contentHash("workflow:\n  name: x\n")
          }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST"
        }
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Confirm save");
      expect(html).not.toContain("missing a closing ---");
    } finally {
      test.cleanup();
    }
  });

  it("preview validates against the project's configured format, not the file extension's guess", async () => {
    const test = await setup();
    // .md would auto-infer as markdown; the project explicitly declares
    // raw_fsm to override that guess (the case the doc comment on
    // validateWorkflowContractContent calls out) -- validation must
    // honor the declared format, matching what reload would use.
    const overriddenPath = path.join(test.stateRoot, "workflow.md");
    await writeFile(overriddenPath, "workflow:\n  name: x\n", "utf8");
    try {
      const app = appFor(test, {
        getProjectWorkflowPath: (projectName) =>
          projectName === "delta"
            ? { format: "raw_fsm", path: overriddenPath }
            : undefined
      });
      const rawFsmContent = [
        "---",
        "workflow:",
        "  name: minimal",
        "  initial: done",
        "  states:",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n");
      const response = await app.request(
        "/projects/delta/workflow/edit/preview",
        {
          body: formBody({
            content: rawFsmContent,
            csrf_token: VALID_TOKEN,
            expected_content_hash: contentHash("workflow:\n  name: x\n")
          }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST"
        }
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Confirm save");
    } finally {
      test.cleanup();
    }
  });

  it("preview reports validation errors for a broken template expression", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const response = await app.request(
        "/projects/alpha/workflow/edit/preview",
        {
          body: formBody({
            content: "Work on {{not.a.real.field}}.\n",
            csrf_token: VALID_TOKEN,
            expected_content_hash: contentHash(VALID_MARKDOWN_WORKFLOW)
          }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST"
        }
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Confirm save");
    } finally {
      test.cleanup();
    }
  });

  it("confirm writes the file, triggers reload, and redirects to the project page", async () => {
    const test = await setup();
    try {
      let reloadCalls = 0;
      const app = appFor(test, {
        triggerReload: () => {
          reloadCalls++;
          return Promise.resolve({ errors: [], ok: true });
        }
      });
      const editedContent = "Work on {{issue.title}} carefully.\n";
      const response = await app.request(
        "/projects/alpha/workflow/edit/confirm",
        {
          body: formBody({
            content: editedContent,
            csrf_token: VALID_TOKEN,
            expected_content_hash: contentHash(VALID_MARKDOWN_WORKFLOW)
          }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST",
          redirect: "manual"
        }
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/projects/alpha?saved=1");
      expect(await readFile(test.workflowPath, "utf8")).toBe(editedContent);
      expect(reloadCalls).toBe(1);
    } finally {
      test.cleanup();
    }
  });

  it("confirm validates relative prompt paths from a symlinked workflow's logical directory", async () => {
    const test = await setup();
    const logicalDir = path.join(test.stateRoot, "configured");
    const targetDir = path.join(test.stateRoot, "shared");
    const logicalWorkflowPath = path.join(logicalDir, "workflow.yml");
    const targetWorkflowPath = path.join(targetDir, "workflow.yml");
    const originalContent = [
      "workflow:",
      "  name: original",
      "  initial: done",
      "  states:",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n");
    const editedContent = [
      "workflow:",
      "  name: symlinked",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        prompt: prompts/plan.md",
      "      transitions:",
      "        - to: done",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n");
    await mkdir(path.join(logicalDir, "prompts"), { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      path.join(logicalDir, "prompts", "plan.md"),
      "Plan the work.\n",
      "utf8"
    );
    await writeFile(targetWorkflowPath, originalContent, "utf8");
    await symlink(targetWorkflowPath, logicalWorkflowPath);

    try {
      const app = appFor(test, {
        getProjectWorkflowPath: (projectName) =>
          projectName === "alpha"
            ? { format: "raw_fsm", path: logicalWorkflowPath }
            : undefined,
        resolveWritePath: (candidatePath) => realpath(candidatePath)
      });
      const form = {
        content: editedContent,
        csrf_token: VALID_TOKEN,
        expected_content_hash: contentHash(originalContent)
      };
      const headers = {
        ...browserHeaders(),
        "content-type": "application/x-www-form-urlencoded"
      };

      const previewResponse = await app.request(
        "/projects/alpha/workflow/edit/preview",
        { body: formBody(form), headers, method: "POST" }
      );
      expect(await previewResponse.text()).toContain("Confirm save");

      const confirmResponse = await app.request(
        "/projects/alpha/workflow/edit/confirm",
        {
          body: formBody(form),
          headers,
          method: "POST",
          redirect: "manual"
        }
      );

      expect(confirmResponse.status).toBe(303);
      expect(await readFile(targetWorkflowPath, "utf8")).toBe(editedContent);
      expect((await lstat(logicalWorkflowPath)).isSymbolicLink()).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it("confirm reports a real reload failure on disk instead of redirecting as saved", async () => {
    const test = await setup();
    try {
      const app = appFor(test, {
        triggerReload: () =>
          Promise.resolve({ errors: ["bad prompt reference"], ok: false })
      });
      const editedContent = "Work on {{issue.title}} carefully.\n";
      const response = await app.request(
        "/projects/alpha/workflow/edit/confirm",
        {
          body: formBody({
            content: editedContent,
            csrf_token: VALID_TOKEN,
            expected_content_hash: contentHash(VALID_MARKDOWN_WORKFLOW)
          }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST",
          redirect: "manual"
        }
      );
      // The write already landed (runSavePipeline writes before reload
      // runs) — the fix under test is that a failed reload no longer
      // redirects as if nothing were wrong.
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Saved, but not active");
      expect(html).toContain("bad prompt reference");
      expect(await readFile(test.workflowPath, "utf8")).toBe(editedContent);
    } finally {
      test.cleanup();
    }
  });

  it("confirm refuses a path resolveWritePath does not confirm", async () => {
    const test = await setup();
    try {
      const app = appFor(test, {
        resolveWritePath: () => Promise.resolve(undefined)
      });
      const response = await app.request(
        "/projects/alpha/workflow/edit/confirm",
        {
          body: formBody({
            content: VALID_MARKDOWN_WORKFLOW,
            csrf_token: VALID_TOKEN,
            expected_content_hash: contentHash(VALID_MARKDOWN_WORKFLOW)
          }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST"
        }
      );
      expect(response.status).toBe(403);
      expect(await readFile(test.workflowPath, "utf8")).toBe(
        VALID_MARKDOWN_WORKFLOW
      );
    } finally {
      test.cleanup();
    }
  });

  it("the project page links to the workflow edit page only for a Project with a workflow", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      test.runStore.syncProjectStates([{ name: "alpha" }]);
      const response = await app.request("/projects/alpha", {
        headers: browserHeaders()
      });
      const html = await response.text();
      expect(html).toContain('href="/projects/alpha/workflow/edit"');
    } finally {
      test.cleanup();
    }
  });
});
