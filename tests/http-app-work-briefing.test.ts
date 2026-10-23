import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import type { MaestroConfig } from "../src/maestro/config.js";
import type { MaestroModel } from "../src/maestro/model.js";
import { createMaestroEvidenceReader } from "../src/maestro/reader.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-work-briefing-test-")
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

const MAESTRO_CONFIG: MaestroConfig = {
  apiKeyEnv: "SYMPHONIKA_MAESTRO_API_KEY",
  maxOutputTokens: 1024,
  model: "claude-sonnet-5",
  provider: "anthropic",
  repositoryContent: "none"
};

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

type SnapshotRow = Parameters<
  RunStore["replaceProjectIssueSnapshots"]
>[0]["rows"][number];

function row(overrides: Partial<SnapshotRow> & { issueNumber: number }) {
  return {
    blockedBy: [],
    blockedByTruncated: false,
    kind: "candidate",
    labels: [],
    priority: 1,
    reasons: [],
    title: `issue ${overrides.issueNumber}`,
    ...overrides
  } satisfies SnapshotRow;
}

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  return { cleanup: () => runStore.close(), runStore, stateRoot };
}

function startRun(
  runStore: RunStore,
  input: { id: string; issueNumber: number; projectName: string; title: string }
): void {
  runStore.createRun({
    id: input.id,
    issue: sampleIssue({ number: input.issueNumber, title: input.title }),
    projectName: input.projectName,
    providerCommand: "x",
    providerName: "codex"
  });
}

// syncProjectStates replaces the active set, so every Project a test uses is
// declared in one call before any seeding.
function syncProjects(runStore: RunStore, names: string[]): void {
  runStore.syncProjectStates(
    names.map((name) => ({ name, validationState: "valid", weight: 1 }))
  );
}

// alpha has one Issue in each of the four groups; ready and ongoing each
// carry several so the orderings are observable.
function seedAlpha(runStore: RunStore): void {
  runStore.recordProjectPollOutcome({
    candidateIssues: 3,
    error: null,
    fetchedIssues: 8,
    filteredIssues: 5,
    ok: true,
    projectName: "alpha"
  });
  runStore.replaceProjectIssueSnapshots({
    polledAt: "2026-10-01T10:00:00.000Z",
    projectName: "alpha",
    rows: [
      row({
        issueCreatedAt: "2026-09-01T00:00:00.000Z",
        issueNumber: 10,
        priority: 2,
        title: "Lower priority, older"
      }),
      row({
        issueCreatedAt: "2026-09-20T00:00:00.000Z",
        issueNumber: 11,
        priority: 1,
        title: "Higher priority, newer"
      }),
      row({
        issueCreatedAt: "2026-09-10T00:00:00.000Z",
        issueNumber: 12,
        priority: 1,
        title: "Higher priority, older"
      }),
      row({
        issueCreatedAt: "2026-09-15T00:00:00.000Z",
        issueNumber: 20,
        kind: "filtered",
        labels: ["sym:running"],
        priority: 1,
        reasons: ["has operational label sym:running"],
        title: "Running newer"
      }),
      row({
        issueCreatedAt: "2026-09-01T00:00:00.000Z",
        issueNumber: 24,
        kind: "filtered",
        labels: ["sym:running"],
        priority: 1,
        reasons: ["has operational label sym:running"],
        title: "Running older"
      }),
      row({
        issueCreatedAt: "2026-09-25T00:00:00.000Z",
        issueNumber: 23,
        kind: "filtered",
        priority: 0,
        reasons: ["has an open pull request"],
        title: "Shipped, PR open"
      }),
      row({
        issueNumber: 30,
        kind: "filtered",
        labels: ["sym:blocked"],
        priority: 3,
        reasons: ["has operational label sym:blocked"],
        title: "Blocked by an operator decision"
      }),
      row({
        issueNumber: 40,
        kind: "filtered",
        priority: 5,
        reasons: ["missing ready label agent-ready"],
        title: "Not labelled ready"
      })
    ]
  });
  // run-24 starts before run-20, so the overview's most-recently-updated
  // ordering would list #20 first while the briefing lists #24 (older).
  startRun(runStore, {
    id: "run-24",
    issueNumber: 24,
    projectName: "alpha",
    title: "Running older"
  });
  runStore.updateRunState("run-24", "running");
  startRun(runStore, {
    id: "run-20",
    issueNumber: 20,
    projectName: "alpha",
    title: "Running newer"
  });
  runStore.updateRunState("run-20", "running");
  startRun(runStore, {
    id: "run-23",
    issueNumber: 23,
    projectName: "alpha",
    title: "Shipped, PR open"
  });
  runStore.updateRunState("run-23", "succeeded");
  runStore.trackPullRequest({
    branchName: "sym/alpha/23-shipped",
    headSha: "a".repeat(40),
    issueNumber: 23,
    projectName: "alpha",
    prNumber: 99,
    prUrl: "https://github.com/example/repo/pull/99",
    runId: "run-23"
  });
}

function seedBeta(runStore: RunStore): void {
  runStore.recordProjectPollOutcome({
    candidateIssues: 1,
    error: null,
    fetchedIssues: 1,
    filteredIssues: 0,
    ok: true,
    projectName: "beta"
  });
  runStore.replaceProjectIssueSnapshots({
    polledAt: "2026-10-01T10:00:00.000Z",
    projectName: "beta",
    rows: [row({ issueNumber: 7, title: "Beta ready issue" })]
  });
}

function makeApp(
  test: TestSetup,
  options: Partial<Parameters<typeof createHttpApp>[0]> = {}
) {
  return createHttpApp({
    csrfSecret: TEST_SECRET,
    runStore: test.runStore,
    // Started before the seeded polls, so nothing reads as pre-restart
    // unless a test asks for it.
    startedAtMs: 1,
    stateRoot: test.stateRoot,
    version: "0.1.0",
    ...options
  });
}

async function get(
  app: ReturnType<typeof createHttpApp>,
  urlPath: string
): Promise<{ html: string; status: number }> {
  const response = await app.request(urlPath, { headers: browserHeaders() });
  return { html: await response.text(), status: response.status };
}

function extractSection(html: string, anchorId: string): string {
  const start = html.indexOf(`id="${anchorId}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = html.slice(start);
  const next = tail.indexOf("<section", 1);
  return next === -1 ? tail : tail.slice(0, next);
}

function expectInOrder(html: string, markers: string[]): void {
  const indexes = markers.map((marker) => {
    const index = html.indexOf(marker);
    expect(index, `${marker} should be present`).toBeGreaterThanOrEqual(0);
    return index;
  });
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
}

describe("GET /briefing (#868)", () => {
  it("groups work into the four buckets with a cited reason for each", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const { html, status } = await get(makeApp(test), "/briefing");
      expect(status).toBe(200);

      const needs = extractSection(html, "briefing-needs-attention");
      expect(needs).toContain("Blocked by an operator decision");
      expect(needs).toContain("sym:blocked");
      expect(needs).toContain("/issues/alpha/30");

      const ready = extractSection(html, "briefing-ready");
      expect(ready).toContain("Higher priority, older");
      expect(ready).toContain("eligible");

      const ongoing = extractSection(html, "briefing-ongoing");
      expect(ongoing).toContain("Running older");
      expect(ongoing).toContain("run running");
      expect(ongoing).toContain("/runs/run-24");
      expect(ongoing).toContain("PR #99 awaiting review");
      expect(ongoing).toContain("/prs/alpha/99");

      const notReady = extractSection(html, "briefing-not-ready");
      expect(notReady).toContain("Not labelled ready");
      expect(notReady).toContain("missing ready label agent-ready");

      expect(ready).not.toContain("Not labelled ready");
      expect(notReady).not.toContain("Higher priority");
    } finally {
      test.cleanup();
    }
  });

  it("cites the evidence record a reason was read from, with its observed time", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const { html } = await get(makeApp(test), "/briefing");

      const ongoing = extractSection(html, "briefing-ongoing");
      expect(ongoing).toContain('evidence: <a href="/runs/run-24">');
      expect(ongoing).toContain(
        'evidence: <a href="/prs/alpha/99">alpha#99</a>'
      );
      expect(ongoing).toContain("alpha#99");
      expect(ongoing).toContain('<a href="/projects/alpha">alpha</a>');
      expect(ongoing).toContain("observed <time");

      const ready = extractSection(html, "briefing-ready");
      expect(ready).toContain('evidence: <a href="/issues/alpha/12">');
      expect(ready).toContain('datetime="2026-10-01T10:00:00.000Z"');
    } finally {
      test.cleanup();
    }
  });

  it("orders every group by configured priority, then age", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const { html } = await get(makeApp(test), "/briefing");

      expectInOrder(extractSection(html, "briefing-ready"), [
        "#12 ",
        "#11 ",
        "#10 "
      ]);
      // P0 first, then the two P1s oldest-first. The dashboard overview
      // would list #20 before #24 (most recently updated Run first).
      expectInOrder(extractSection(html, "briefing-ongoing"), [
        "#23 ",
        "#24 ",
        "#20 "
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("labels a stale poll and a failed GitHub read, and calls a healthy poll fresh", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha", "beta", "gamma"]);
      seedAlpha(test.runStore);
      seedBeta(test.runStore);
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 0,
        error: "GitHub token revoked",
        fetchedIssues: 0,
        filteredIssues: 0,
        ok: false,
        projectName: "gamma"
      });
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-09-01T00:00:00.000Z",
        projectName: "gamma",
        rows: [row({ issueNumber: 3, title: "Gamma issue from an old poll" })]
      });

      const fresh = await get(makeApp(test), "/briefing");
      const freshHtml = extractSection(fresh.html, "briefing-freshness");
      expect(freshHtml).toContain("GitHub read failed");
      expect(freshHtml).toContain("GitHub token revoked");
      expect(freshHtml).toContain("No GitHub poll has succeeded yet");
      expect(freshHtml).toContain("fresh");
      expect(freshHtml).not.toContain("stale poll");

      const stale = await get(
        makeApp(test, { now: () => Date.now() + 60 * 60_000 }),
        "/briefing"
      );
      const staleHtml = extractSection(stale.html, "briefing-freshness");
      expect(staleHtml).toContain("stale poll");
      expect(staleHtml).toContain("The last successful GitHub poll was");
      const ready = extractSection(stale.html, "briefing-ready");
      expect(ready).toContain("stale poll");
      expect(ready).toContain("GitHub read failed");

      const restarted = await get(
        makeApp(test, { startedAtMs: Date.now() + 60 * 60_000 }),
        "/briefing"
      );
      expect(restarted.html).toContain("pre-restart");
    } finally {
      test.cleanup();
    }
  });

  it("states that it is a persisted-snapshot read, not live", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const { html } = await get(makeApp(test), "/briefing");
      expect(html).toContain("GitHub was not called");
      expect(html).toContain("never from Maestro chat");
    } finally {
      test.cleanup();
    }
  });
});

describe("GET /projects/:name/briefing (#868)", () => {
  it("scopes the report to one Project and links back to it", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha", "beta"]);
      seedAlpha(test.runStore);
      seedBeta(test.runStore);
      const app = makeApp(test);

      const all = await get(app, "/briefing");
      expect(all.html).toContain("Beta ready issue");
      expect(all.html).toContain("Higher priority, older");

      const project = await get(app, "/projects/alpha/briefing");
      expect(project.status).toBe(200);
      expect(project.html).toContain("Work briefing: alpha");
      expect(project.html).toContain("Higher priority, older");
      expect(project.html).not.toContain("Beta ready issue");
      expect(project.html).not.toContain("/issues/beta/7");
      expect(project.html).toContain('href="/projects/alpha"');
    } finally {
      test.cleanup();
    }
  });

  it("returns 404 for an unknown Project", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const { html, status } = await get(
        makeApp(test),
        "/projects/nope/briefing"
      );
      expect(status).toBe(404);
      expect(html).toContain("Project not found");
    } finally {
      test.cleanup();
    }
  });

  it("is linked from the dashboard and from the Project page", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const app = makeApp(test);
      expect((await get(app, "/")).html).toContain('href="/briefing"');
      expect((await get(app, "/projects/alpha")).html).toContain(
        'href="/projects/alpha/briefing"'
      );
    } finally {
      test.cleanup();
    }
  });

  it("is read-only: only GET is routed", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const app = makeApp(test);
      const runsBefore = test.runStore.listRuns().map((run) => run.id);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const urlPath of ["/briefing", "/projects/alpha/briefing"]) {
          const response = await app.request(urlPath, {
            headers: browserHeaders(),
            method
          });
          expect(response.status, `${method} ${urlPath}`).toBe(404);
        }
      }
      expect(test.runStore.listRuns().map((run) => run.id)).toEqual(runsBefore);
    } finally {
      test.cleanup();
    }
  });
});

describe("Maestro get_work_briefing (#868)", () => {
  function formBody(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
  }

  async function ask(
    app: ReturnType<typeof createHttpApp>,
    urlPath: string,
    message: string
  ): Promise<void> {
    await app.request(urlPath, {
      body: formBody({
        csrf_token: csrfTokenFor(TEST_SECRET, SESSION_ID),
        message
      }),
      headers: {
        ...browserHeaders(),
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST",
      redirect: "manual"
    });
  }

  function briefingModel(
    input: unknown,
    finalText: string,
    seenResults: string[]
  ): () => MaestroModel {
    return () => {
      let round = 0;
      return {
        nextTurn: (turn) => {
          round += 1;
          if (round === 1) {
            return Promise.resolve({
              kind: "tool_use" as const,
              toolUses: [{ id: "toolu_0", input, name: "get_work_briefing" }]
            });
          }
          for (const entry of turn.history) {
            if (entry.role === "tool_result") {
              seenResults.push(...entry.results.map((r) => r.content));
            }
          }
          return Promise.resolve({ kind: "message" as const, text: finalText });
        }
      };
    };
  }

  it("returns the four groups, ordered, with cited reasons and freshness", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const results: string[] = [];
      const app = makeApp(test, {
        createMaestroModel: briefingModel({}, "Here is the briefing.", results),
        getMaestroConfig: () => MAESTRO_CONFIG
      });
      await ask(app, "/maestro/messages", "What should I do next?");

      const briefing = JSON.parse(results[0] ?? "null") as {
        groups: Record<
          string,
          {
            items: Array<{
              freshness: { labels: string[] };
              issueNumber: number;
              reason: {
                basis: string;
                citation: { href: string; observedAt: string };
                text: string;
              };
            }>;
            omitted: number;
          }
        >;
        notice: string;
        scope: { kind: string };
      };
      expect(briefing.scope).toEqual({ kind: "all" });
      expect(briefing.notice).toContain("GitHub was not called");
      expect(
        Object.keys(briefing.groups).sort((a, b) => a.localeCompare(b))
      ).toEqual(["needsAttention", "notReady", "ongoing", "ready"]);
      expect(briefing.groups.ready?.items.map((i) => i.issueNumber)).toEqual([
        12, 11, 10
      ]);
      expect(briefing.groups.ongoing?.items.map((i) => i.issueNumber)).toEqual([
        23, 24, 20
      ]);
      const pr = briefing.groups.ongoing?.items[0];
      expect(pr?.reason.basis).toBe("open_pull_request");
      expect(pr?.reason.citation.href).toBe("/prs/alpha/99");
      expect(pr?.freshness.labels).toEqual([]);
      expect(briefing.groups.needsAttention?.items[0]?.reason.text).toBe(
        "sym:blocked"
      );
      expect(briefing.groups.ready?.omitted).toBe(0);
    } finally {
      test.cleanup();
    }
  });

  it("attaches server-built Project, Issue, Run and PR citations to the reply", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const app = makeApp(test, {
        createMaestroModel: briefingModel({}, "Briefing.", []),
        getMaestroConfig: () => MAESTRO_CONFIG
      });
      await ask(app, "/maestro/messages", "What next?");
      const html = (await get(app, "/maestro")).html;

      expect(html).toContain('href="/issues/alpha/12"');
      expect(html).toContain('href="/runs/run-24"');
      expect(html).toContain('href="/prs/alpha/99"');
      expect(html).toContain('href="/projects/alpha"');
    } finally {
      test.cleanup();
    }
  });

  it("defaults an omitted project_name to the focus Project", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha", "beta"]);
      seedAlpha(test.runStore);
      seedBeta(test.runStore);
      const focused: string[] = [];
      const dashboard: string[] = [];
      const app = makeApp(test, {
        createMaestroModel: briefingModel({}, "ok", focused),
        getMaestroConfig: () => MAESTRO_CONFIG
      });
      await ask(app, "/projects/alpha/maestro/messages", "What next?");
      const appAll = makeApp(test, {
        createMaestroModel: briefingModel({}, "ok", dashboard),
        getMaestroConfig: () => MAESTRO_CONFIG
      });
      await ask(appAll, "/maestro/messages", "What next?");

      expect(focused[0]).toContain('"scope":{"kind":"project"');
      expect(focused[0]).not.toContain("Beta ready issue");
      expect(dashboard[0]).toContain("Beta ready issue");
      expect(dashboard[0]).toContain("Higher priority, older");
    } finally {
      test.cleanup();
    }
  });

  it("lets a focused conversation name another Project, and reports an unknown one as not found", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha", "beta"]);
      seedAlpha(test.runStore);
      seedBeta(test.runStore);
      const other: string[] = [];
      const unknown: string[] = [];
      await ask(
        makeApp(test, {
          createMaestroModel: briefingModel(
            { project_name: "beta" },
            "ok",
            other
          ),
          getMaestroConfig: () => MAESTRO_CONFIG
        }),
        "/projects/alpha/maestro/messages",
        "And beta?"
      );
      await ask(
        makeApp(test, {
          createMaestroModel: briefingModel(
            { project_name: "nope" },
            "ok",
            unknown
          ),
          getMaestroConfig: () => MAESTRO_CONFIG
        }),
        "/maestro/messages",
        "And nope?"
      );

      expect(other[0]).toContain("Beta ready issue");
      expect(other[0]).not.toContain("Higher priority, older");
      expect(unknown[0]).toBe('{"found":false,"projectName":"nope"}');
    } finally {
      test.cleanup();
    }
  });

  it("never turns the briefing, or a chat claim, into Run evidence", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      seedAlpha(test.runStore);
      const conversationId = test.runStore.ensureDashboardMaestroConversation({
        id: "conv-1"
      });
      test.runStore.appendMaestroMessage({
        citations: [
          {
            href: "/runs/run-fabricated",
            kind: "run",
            label: "alpha run run-fabricated",
            observedAt: "2026-10-02T00:00:00.000Z"
          }
        ],
        content: "Maestro says issue #77 shipped in run-fabricated.",
        conversationId,
        id: "m-1",
        role: "assistant"
      });
      const runsBefore = test.runStore.listRuns().map((run) => run.id);

      const app = makeApp(test, {
        createMaestroModel: briefingModel(
          {},
          "Chat summary: issue #12 is ready.",
          []
        ),
        getMaestroConfig: () => MAESTRO_CONFIG
      });
      await ask(app, "/maestro/messages", "What next?");

      const page = (await get(app, "/briefing")).html;
      const projectPage = (await get(app, "/projects/alpha/briefing")).html;
      for (const html of [page, projectPage]) {
        expect(html).not.toContain("run-fabricated");
        expect(html).not.toContain("#77");
        expect(html).not.toContain("Chat summary");
      }
      expect(test.runStore.listRuns().map((run) => run.id)).toEqual(runsBefore);
    } finally {
      test.cleanup();
    }
  });

  it("caps a group and reports how many items it omitted", async () => {
    const test = await setup();
    try {
      syncProjects(test.runStore, ["alpha"]);
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 12,
        error: null,
        fetchedIssues: 12,
        filteredIssues: 0,
        ok: true,
        projectName: "alpha"
      });
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-10-01T10:00:00.000Z",
        projectName: "alpha",
        rows: Array.from({ length: 12 }, (_, index) =>
          row({ issueNumber: index + 1, priority: 1 })
        )
      });
      const briefing = createMaestroEvidenceReader(
        test.runStore
      ).getWorkBriefing("alpha");

      expect(briefing?.groups.ready.items).toHaveLength(10);
      expect(briefing?.groups.ready.omitted).toBe(2);
      expect(briefing?.groups.needsAttention.omitted).toBe(0);
    } finally {
      test.cleanup();
    }
  });
});
