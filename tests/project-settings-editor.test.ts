import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { contentHash } from "../src/content-hash.js";
import { createHttpApp, type HttpAppOptions } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const TEST_SECRET: CsrfSecret = randomBytes(32);
const SESSION_ID = "a".repeat(32);
const TOKEN = csrfTokenFor(TEST_SECRET, SESSION_ID);
const HOST = "127.0.0.1:4000";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `sym_session=${SESSION_ID}`,
    host: HOST,
    origin: `http://${HOST}`,
    ...extra
  };
}

function post(fields: Record<string, string>): RequestInit {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: headers({ "content-type": "application/x-www-form-urlencoded" }),
    method: "POST"
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

function project(name: string, ready: string): string[] {
  return [
    `  - name: ${name}`,
    "    # tracker comment",
    "    tracker:",
    "      kind: github",
    "      owner: pmatos",
    `      repo: ${name}`,
    '      token: "$GITHUB_TOKEN"',
    "    issue_filters:",
    '      states: ["open"]',
    `      ready_label: ${ready}`,
    '      labels_none: ["blocked"]',
    "    priority:",
    "      labels:",
    '        "priority:high": 1',
    "      default: 99",
    "    workspace:",
    `      root: ./.symphonika/workspaces/${name}`,
    "      git:",
    `        remote: git@github.com:pmatos/${name}.git`,
    "        base_branch: main",
    "    agent:",
    "      provider: codex",
    "    workflow: ./WORKFLOW.md"
  ];
}

const CONFIG = [
  "# service config",
  "state:",
  "  root: ./.symphonika",
  "polling:",
  "  interval_ms: 1000",
  "providers:",
  "  codex:",
  '    command: "codex -p symphonika"',
  "  claude:",
  '    command: "claude -p"',
  "projects:",
  ...project("alpha", "agent-ready"),
  ...project("beta", "beta-ready"),
  ""
].join("\n");

type Env = {
  app: ReturnType<typeof createHttpApp>;
  cleanup: () => void;
  configPath: string;
  reloads: number;
  runStore: RunStore;
};

async function setup(
  overrides: Partial<HttpAppOptions> = {},
  config = CONFIG
): Promise<Env> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "symphonika-pset-"));
  tempRoots.push(stateRoot);
  const runStore = openRunStore({ stateRoot });
  runStore.syncProjectStates([
    { name: "alpha", validationState: "valid", weight: 1 },
    { name: "beta", validationState: "valid", weight: 1 }
  ]);
  const configPath = path.join(stateRoot, "symphonika.yml");
  await writeFile(configPath, config, "utf8");
  await writeFile(path.join(stateRoot, "WORKFLOW.md"), "Work.\n", "utf8");
  const env = {
    cleanup: () => runStore.close(),
    configPath,
    reloads: 0,
    runStore
  } as Env;
  env.app = createHttpApp({
    csrfSecret: TEST_SECRET,
    getConfigPath: () => configPath,
    getProjectQueuePolicy: (name) =>
      name === "alpha"
        ? {
            epicLabels: [],
            priority: { default: 99, labels: { "priority:high": 1 } },
            readyLabel: "agent-ready"
          }
        : undefined,
    runStore,
    stateRoot,
    triggerReload: () => {
      env.reloads += 1;
      return Promise.resolve({ errors: [], ok: true });
    },
    version: "0.1.0",
    ...overrides
  });
  return env;
}

const VALID_FORM = {
  epic_labels: "epic",
  priority_default: "50",
  priority_labels: "priority:high=1\npriority:low=3",
  ready_label: "go-now"
};

async function openAndPreview(
  env: Env,
  form: Record<string, string> = VALID_FORM
): Promise<{ hash: string; response: Response }> {
  const page = await env.app.request("/projects/alpha/settings", {
    headers: headers()
  });
  const hash = extractHidden(await page.text(), "expected_content_hash");
  const response = await env.app.request(
    "/projects/alpha/settings/preview",
    post({ ...form, csrf_token: TOKEN, expected_content_hash: hash })
  );
  return { hash, response };
}

describe("project settings editor (#857)", () => {
  it("GET renders a form prefilled from the file, with the active values", async () => {
    const env = await setup();
    try {
      const response = await env.app.request("/projects/alpha/settings", {
        headers: headers()
      });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('name="ready_label" value="agent-ready"');
      expect(html).toContain("priority:high=1");
      expect(html).toContain(
        `value="${contentHash(await readFile(env.configPath, "utf8"))}"`
      );
      expect(html).toContain("Active now");
    } finally {
      env.cleanup();
    }
  });

  it("GET is 404 for an unknown project or one without a queue policy, and refuses cross-origin reads", async () => {
    const env = await setup();
    try {
      expect(
        (
          await env.app.request("/projects/beta/settings", {
            headers: headers()
          })
        ).status
      ).toBe(404);
      expect(
        (
          await env.app.request("/projects/nope/settings", {
            headers: headers()
          })
        ).status
      ).toBe(404);
      expect(
        (
          await env.app.request("/projects/alpha/settings", {
            headers: headers({ origin: "http://evil.example" })
          })
        ).status
      ).toBe(403);
    } finally {
      env.cleanup();
    }
  });

  it("preview shows a diff limited to the project's settings and writes nothing", async () => {
    const env = await setup();
    try {
      const before = await readFile(env.configPath, "utf8");
      const { response } = await openAndPreview(env);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Confirm changes");
      expect(html).toContain("go-now");
      expect(html).toContain("/projects/alpha/settings/confirm");
      expect(await readFile(env.configPath, "utf8")).toBe(before);
      expect(env.reloads).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("preview requires a CSRF token", async () => {
    const env = await setup();
    try {
      const response = await env.app.request(
        "/projects/alpha/settings/preview",
        {
          ...post({ ...VALID_FORM, expected_content_hash: "x" }),
          headers: headers({
            "content-type": "application/x-www-form-urlencoded"
          })
        }
      );
      expect(response.status).toBe(403);
    } finally {
      env.cleanup();
    }
  });

  it("a valid edit saves only the project's settings, preserving everything else, and reloads once", async () => {
    const env = await setup();
    try {
      const { response } = await openAndPreview(env);
      const html = await response.text();
      const confirm = await env.app.request(
        "/projects/alpha/settings/confirm",
        post({
          content: extractHidden(html, "content"),
          csrf_token: TOKEN,
          expected_content_hash: extractHidden(html, "expected_content_hash")
        })
      );
      expect(confirm.status).toBe(303);
      expect(confirm.headers.get("location")).toBe("/projects/alpha?saved=1");
      expect(env.reloads).toBe(1);

      const saved = await readFile(env.configPath, "utf8");
      const expected = CONFIG.replace(
        "      ready_label: agent-ready",
        "      ready_label: go-now"
      )
        .replace(
          '        "priority:high": 1\n      default: 99',
          '        "priority:high": 1\n        priority:low: 3\n      default: 50'
        )
        .replace(
          "    workflow: ./WORKFLOW.md\n  - name: beta",
          "    workflow: ./WORKFLOW.md\n    epic_labels:\n      - epic\n  - name: beta"
        );
      expect(saved).toBe(expected);
    } finally {
      env.cleanup();
    }
  });

  it("refuses a Service Config edited externally between open and preview (409) without writing", async () => {
    const env = await setup();
    try {
      const page = await env.app.request("/projects/alpha/settings", {
        headers: headers()
      });
      const hash = extractHidden(await page.text(), "expected_content_hash");
      const external = `${CONFIG}# external edit\n`;
      await writeFile(env.configPath, external, "utf8");
      const response = await env.app.request(
        "/projects/alpha/settings/preview",
        post({ ...VALID_FORM, csrf_token: TOKEN, expected_content_hash: hash })
      );
      expect(response.status).toBe(409);
      expect(await readFile(env.configPath, "utf8")).toBe(external);
    } finally {
      env.cleanup();
    }
  });

  it("refuses a Service Config edited externally between preview and confirm (409), keeping the external edit", async () => {
    const env = await setup();
    try {
      const { response } = await openAndPreview(env);
      const html = await response.text();
      const external = `${CONFIG}# external edit\n`;
      await writeFile(env.configPath, external, "utf8");
      const confirm = await env.app.request(
        "/projects/alpha/settings/confirm",
        post({
          content: extractHidden(html, "content"),
          csrf_token: TOKEN,
          expected_content_hash: extractHidden(html, "expected_content_hash")
        })
      );
      expect(confirm.status).toBe(409);
      expect(await readFile(env.configPath, "utf8")).toBe(external);
      expect(env.reloads).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it.each([
    ["a negative priority", { priority_labels: "a=-1" }, "non-negative"],
    ["a blank ready label", { ready_label: " " }, "Ready Label"],
    [
      "an epic label equal to the ready label",
      { epic_labels: "go-now" },
      "ready_label"
    ],
    [
      "an epic label that is a priority label",
      { epic_labels: "priority:high" },
      "priority label"
    ]
  ])(
    "rejects %s with a 422 form re-render and writes nothing",
    async (_n, override, fragment) => {
      const env = await setup();
      try {
        const before = await readFile(env.configPath, "utf8");
        const { response } = await openAndPreview(env, {
          ...VALID_FORM,
          ...override
        });
        const html = await response.text();
        expect(response.status).toBe(422);
        expect(html).toContain(fragment);
        expect(html).toContain('name="ready_label"');
        expect(await readFile(env.configPath, "utf8")).toBe(before);
        expect(env.reloads).toBe(0);
      } finally {
        env.cleanup();
      }
    }
  );

  it("a reload failure after a passing write says 'Saved but not active' and the project page keeps the old policy", async () => {
    const env = await setup({
      triggerReload: () =>
        Promise.resolve({ errors: ["boom: nope"], ok: false })
    });
    try {
      const { response } = await openAndPreview(env);
      const html = await response.text();
      const confirm = await env.app.request(
        "/projects/alpha/settings/confirm",
        post({
          content: extractHidden(html, "content"),
          csrf_token: TOKEN,
          expected_content_hash: extractHidden(html, "expected_content_hash")
        })
      );
      expect(confirm.status).toBe(200);
      expect(await confirm.text()).toContain("Saved, but not active");
      const page = await (
        await env.app.request("/projects/alpha", { headers: headers() })
      ).text();
      expect(page).toContain("<code>agent-ready</code>");
      expect(page).not.toContain("go-now");
    } finally {
      env.cleanup();
    }
  });

  it("confirm refuses a forged body that changes anything beyond the project's settings", async () => {
    const env = await setup();
    try {
      const before = await readFile(env.configPath, "utf8");
      const hash = contentHash(before);
      const forged = before.replace("codex -p symphonika", "rm -rf /");
      const confirm = await env.app.request(
        "/projects/alpha/settings/confirm",
        post({
          content: forged,
          csrf_token: TOKEN,
          expected_content_hash: hash
        })
      );
      expect(confirm.status).toBe(403);
      expect(await readFile(env.configPath, "utf8")).toBe(before);
      expect(env.reloads).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("confirm refuses a forged edit to another project's settings", async () => {
    const env = await setup();
    try {
      const before = await readFile(env.configPath, "utf8");
      const forged = before.replace("beta-ready", "hijacked");
      const confirm = await env.app.request(
        "/projects/alpha/settings/confirm",
        post({
          content: forged,
          csrf_token: TOKEN,
          expected_content_hash: contentHash(before)
        })
      );
      expect(confirm.status).toBe(403);
      expect(await readFile(env.configPath, "utf8")).toBe(before);
    } finally {
      env.cleanup();
    }
  });

  it("refuses to edit a project whose settings node is shared via a YAML anchor", async () => {
    const shared = CONFIG.replace(
      '    priority:\n      labels:\n        "priority:high": 1\n      default: 99\n    workspace:\n      root: ./.symphonika/workspaces/alpha',
      '    priority: &shared\n      labels:\n        "priority:high": 1\n      default: 99\n    workspace:\n      root: ./.symphonika/workspaces/alpha'
    );
    expect(shared).not.toBe(CONFIG);
    const env = await setup({}, shared);
    try {
      const { response } = await openAndPreview(env);
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("anchor");
      expect(await readFile(env.configPath, "utf8")).toBe(shared);
    } finally {
      env.cleanup();
    }
  });
});
