import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
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
    path.join(tmpdir(), "symphonika-config-editor-test-")
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

function validConfig(codexCommand = "codex -p symphonika"): string {
  return [
    "state:",
    "  root: ./.symphonika",
    "polling:",
    "  interval_ms: 1000",
    "providers:",
    "  codex:",
    `    command: "${codexCommand}"`,
    "  claude:",
    '    command: "claude -p"',
    "projects:",
    "  - name: symphonika",
    "    disabled: false",
    "    weight: 1",
    "    tracker:",
    "      kind: github",
    "      owner: pmatos",
    "      repo: symphonika",
    '      token: "$GITHUB_TOKEN"',
    "    issue_filters:",
    '      states: ["open"]',
    '      labels_all: ["agent-ready"]',
    '      labels_none: ["blocked"]',
    "    priority:",
    "      labels: {}",
    "      default: 99",
    "    workspace:",
    "      root: ./.symphonika/workspaces/symphonika",
    "      git:",
    "        remote: git@github.com:pmatos/symphonika.git",
    "        base_branch: main",
    "    agent:",
    "      provider: codex",
    "    workflow: ./WORKFLOW.md",
    ""
  ].join("\n");
}

type TestSetup = {
  cleanup: () => void;
  configPath: string;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  const configPath = path.join(stateRoot, "symphonika.yml");
  await writeFile(configPath, validConfig(), "utf8");
  await writeFile(path.join(stateRoot, "WORKFLOW.md"), "Work.\n", "utf8");
  return {
    cleanup: () => runStore.close(),
    configPath,
    runStore,
    stateRoot
  };
}

function appFor(
  test: TestSetup,
  overrides: Partial<HttpAppOptions> = {}
): ReturnType<typeof createHttpApp> {
  return createHttpApp({
    csrfSecret: TEST_SECRET,
    getConfigPath: () => test.configPath,
    runStore: test.runStore,
    stateRoot: test.stateRoot,
    version: "0.1.0",
    ...overrides
  });
}

describe("service config editor (#307 part 3, ADR 0076)", () => {
  it("GET /config/edit renders the content, hash, and the whole-daemon blast-radius note", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const response = await app.request("/config/edit", {
        headers: browserHeaders()
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("codex -p symphonika");
      expect(extractHidden(html, "expected_content_hash")).toBe(
        contentHash(validConfig())
      );
      expect(html).toContain("This save affects");
      expect(html).toContain("whole daemon");
    } finally {
      test.cleanup();
    }
  });

  it("GET /config/edit refuses a cross-origin request instead of serving the raw config", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      // Simulates a DNS-rebound attacker page: Origin's host equals the
      // reflected Host header, but neither is a loopback name -- without
      // this route's own same-origin guard, that page could read
      // provider-command secrets out of the response body.
      const response = await app.request("/config/edit", {
        headers: browserHeaders({
          host: "evil.example",
          origin: "http://evil.example"
        })
      });
      expect(response.status).toBe(403);
      const html = await response.text();
      expect(html).not.toContain("codex -p symphonika");
    } finally {
      test.cleanup();
    }
  });

  it("preview refuses an invalid edit with a located error, and never writes", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const brokenContent = "providers: [unterminated\n";
      const response = await app.request("/config/edit/preview", {
        body: formBody({
          content: brokenContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Confirm save");
      expect(await readFile(test.configPath, "utf8")).toBe(validConfig());
    } finally {
      test.cleanup();
    }
  });

  it("preview shows the provider-command confirmation checkbox only when providers.*.command changes", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const unchanged = await app.request("/config/edit/preview", {
        body: formBody({
          content: validConfig().replace(
            "interval_ms: 1000",
            "interval_ms: 2000"
          ),
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const unchangedHtml = await unchanged.text();
      expect(unchangedHtml).toContain("Confirm save");
      expect(unchangedHtml).not.toContain("confirm_provider_command_change");

      const changed = await app.request("/config/edit/preview", {
        body: formBody({
          content: validConfig("codex -p symphonika --danger"),
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      const changedHtml = await changed.text();
      expect(changedHtml).toContain("Confirm save");
      expect(changedHtml).toContain("confirm_provider_command_change");
      expect(changedHtml).toContain("changes what process the daemon spawns");
    } finally {
      test.cleanup();
    }
  });

  it("confirm refuses a providers.*.command change without the explicit checkbox", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const editedContent = validConfig("codex -p symphonika --danger");
      const response = await app.request("/config/edit/confirm", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(422);
      const html = await response.text();
      expect(html).toContain("confirm_provider_command_change");
      expect(await readFile(test.configPath, "utf8")).toBe(validConfig());
    } finally {
      test.cleanup();
    }
  });

  it("confirm writes a providers.*.command change once the checkbox is submitted", async () => {
    const test = await setup();
    try {
      let reloadCalls = 0;
      const app = appFor(test, {
        triggerReload: () => {
          reloadCalls++;
          return Promise.resolve({ errors: [], ok: true });
        }
      });
      const editedContent = validConfig("codex -p symphonika --danger");
      const response = await app.request("/config/edit/confirm", {
        body: formBody({
          confirm_provider_command_change: "on",
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/?saved=1");
      expect(await readFile(test.configPath, "utf8")).toBe(editedContent);
      expect(reloadCalls).toBe(1);
    } finally {
      test.cleanup();
    }
  });

  it("confirm writes an ordinary (non-provider-command) edit without requiring the checkbox", async () => {
    const test = await setup();
    try {
      const app = appFor(test, {
        triggerReload: () => Promise.resolve({ errors: [], ok: true })
      });
      const editedContent = validConfig().replace(
        "interval_ms: 1000",
        "interval_ms: 2000"
      );
      const response = await app.request("/config/edit/confirm", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });
      expect(response.status).toBe(303);
      expect(await readFile(test.configPath, "utf8")).toBe(editedContent);
    } finally {
      test.cleanup();
    }
  });

  it("confirm validates relative paths from a symlinked config's logical directory", async () => {
    const test = await setup();
    const targetDir = path.join(test.stateRoot, "shared");
    const targetConfigPath = path.join(targetDir, "symphonika.yml");
    await mkdir(targetDir);
    await rename(test.configPath, targetConfigPath);
    await symlink(targetConfigPath, test.configPath);

    try {
      const app = appFor(test, {
        resolveWritePath: (candidatePath) => realpath(candidatePath),
        triggerReload: () => Promise.resolve({ errors: [], ok: true })
      });
      const editedContent = validConfig().replace(
        "interval_ms: 1000",
        "interval_ms: 2000"
      );
      const response = await app.request("/config/edit/confirm", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST",
        redirect: "manual"
      });

      expect(response.status).toBe(303);
      expect(await readFile(targetConfigPath, "utf8")).toBe(editedContent);
      expect((await lstat(test.configPath)).isSymbolicLink()).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it("confirm reports a real reload failure on disk instead of redirecting as saved", async () => {
    const test = await setup();
    try {
      const app = appFor(test, {
        triggerReload: () =>
          Promise.resolve({ errors: ["projects: required"], ok: false })
      });
      const editedContent = validConfig().replace(
        "interval_ms: 1000",
        "interval_ms: 2000"
      );
      const response = await app.request("/config/edit/confirm", {
        body: formBody({
          content: editedContent,
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
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
      expect(html).toContain("projects: required");
      expect(await readFile(test.configPath, "utf8")).toBe(editedContent);
    } finally {
      test.cleanup();
    }
  });

  it("confirm refuses a stale write and does not touch the file", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const changedOnDisk = validConfig().replace(
        "interval_ms: 1000",
        "interval_ms: 5000"
      );
      await writeFile(test.configPath, changedOnDisk, "utf8");

      const response = await app.request("/config/edit/confirm", {
        body: formBody({
          content: validConfig().replace(
            "interval_ms: 1000",
            "interval_ms: 3000"
          ),
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(409);
      expect(await readFile(test.configPath, "utf8")).toBe(changedOnDisk);
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
      const response = await app.request("/config/edit/confirm", {
        body: formBody({
          content: validConfig(),
          csrf_token: VALID_TOKEN,
          expected_content_hash: contentHash(validConfig())
        }),
        headers: {
          ...browserHeaders(),
          "content-type": "application/x-www-form-urlencoded"
        },
        method: "POST"
      });
      expect(response.status).toBe(403);
    } finally {
      test.cleanup();
    }
  });

  it("every page links to the config editor", async () => {
    const test = await setup();
    try {
      const app = appFor(test);
      const response = await app.request("/config/edit", {
        headers: browserHeaders()
      });
      const html = await response.text();
      expect(html).toContain('href="/config/edit"');
    } finally {
      test.cleanup();
    }
  });
});
