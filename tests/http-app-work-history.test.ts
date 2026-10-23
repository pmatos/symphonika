import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import type { MaestroConfig } from "../src/maestro/config.js";
import type { MaestroModel } from "../src/maestro/model.js";
import { databasePath, openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-work-history-test-")
  );
  tempRoots.push(root);
  return root;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const TEST_SECRET: CsrfSecret = randomBytes(32);
const SESSION_ID = "a".repeat(32);
const HOST = "127.0.0.1:4000";

const NOW = "2026-10-23T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
// The rolling 7-day window resolved at NOW.
const FROM_7D = "2026-10-16T12:00:00.000Z";

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

function at<T>(iso: string, action: () => T): T {
  vi.setSystemTime(new Date(iso));
  return action();
}

// Creates a Run at `createdAt` and, when `endedAt` is given, moves it to
// `state` at that instant, through the real write path.
function seedRun(
  runStore: RunStore,
  input: {
    createdAt: string;
    endedAt?: string;
    id: string;
    issueNumber: number;
    projectName: string;
    state?: Parameters<RunStore["updateRunState"]>[1];
    title: string;
  }
): void {
  at(input.createdAt, () =>
    runStore.createRun({
      id: input.id,
      issue: sampleIssue({ number: input.issueNumber, title: input.title }),
      projectName: input.projectName,
      providerCommand: "x",
      providerName: "codex"
    })
  );
  if (input.endedAt !== undefined) {
    at(input.endedAt, () =>
      runStore.updateRunState(input.id, input.state ?? "succeeded")
    );
  }
}

function seedPoll(
  runStore: RunStore,
  projectName: string,
  at_: string,
  outcome: { error?: string; ok: boolean } = { ok: true }
): void {
  at(at_, () =>
    runStore.recordProjectPollOutcome({
      candidateIssues: 0,
      error: outcome.error ?? null,
      fetchedIssues: 0,
      filteredIssues: 0,
      ok: outcome.ok,
      projectName
    })
  );
}

function syncProjects(runStore: RunStore, names: string[]): void {
  runStore.syncProjectStates(
    names.map((name) => ({ name, validationState: "valid", weight: 1 }))
  );
}

function pullRequestRow(
  overrides: Partial<
    Parameters<
      RunStore["replaceProjectPullRequestSnapshots"]
    >[0]["rows"][number]
  > & { prNumber: number }
) {
  return {
    branchOrigin: "issue_branch" as const,
    checks: "success" as const,
    draft: false,
    headRef: `sym/branch-${overrides.prNumber}`,
    headSha: "a".repeat(40),
    labels: [],
    mergeable: "mergeable" as const,
    merged: false,
    open: true,
    reviewDecision: null,
    stateAvailable: true,
    title: `PR ${overrides.prNumber}`,
    trackingState: null,
    unresolvedReviewThreads: 0,
    url: `https://github.com/example/repo/pull/${overrides.prNumber}`,
    ...overrides
  };
}

// alpha: the boundary Runs, a failed Run, an old Run, a tracked merged PR
// with merge attempts, an untracked merged PR and a pending open PR. beta has
// one Run of its own. Event times are chosen around the 7-day window
// [2026-10-16T12:00:00.000Z, NOW).
function seedHistory(runStore: RunStore): void {
  syncProjects(runStore, ["alpha", "beta"]);

  // Created long before the window, finished inside it: attributed to the
  // finish time.
  seedRun(runStore, {
    createdAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-10-20T08:00:00.000Z",
    id: "run-event-in",
    issueNumber: 1,
    projectName: "alpha",
    title: "Created old, finished in window"
  });
  seedRun(runStore, {
    createdAt: "2026-10-10T00:00:00.000Z",
    endedAt: FROM_7D,
    id: "run-at-from",
    issueNumber: 2,
    projectName: "alpha",
    title: "Finished exactly at from"
  });
  seedRun(runStore, {
    createdAt: "2026-10-10T00:00:00.000Z",
    endedAt: "2026-10-16T11:59:59.999Z",
    id: "run-before-from",
    issueNumber: 3,
    projectName: "alpha",
    title: "Finished a millisecond before from"
  });
  seedRun(runStore, {
    createdAt: "2026-10-10T00:00:00.000Z",
    endedAt: NOW,
    id: "run-at-to",
    issueNumber: 4,
    projectName: "alpha",
    title: "Finished exactly at to"
  });
  // Created inside the window but never finished.
  seedRun(runStore, {
    createdAt: "2026-10-22T00:00:00.000Z",
    id: "run-created-in-only",
    issueNumber: 5,
    projectName: "alpha",
    title: "Created in window, still queued"
  });
  seedRun(runStore, {
    createdAt: "2026-10-18T00:00:00.000Z",
    endedAt: "2026-10-19T00:00:00.000Z",
    id: "run-failed",
    issueNumber: 6,
    projectName: "alpha",
    state: "failed",
    title: "Failed in window"
  });
  seedRun(runStore, {
    createdAt: "2026-10-04T00:00:00.000Z",
    endedAt: "2026-10-05T00:00:00.000Z",
    id: "run-old",
    issueNumber: 7,
    projectName: "alpha",
    title: "Finished in the 30 day window only"
  });
  seedRun(runStore, {
    createdAt: "2026-10-20T00:00:00.000Z",
    endedAt: "2026-10-21T00:00:00.000Z",
    id: "run-beta",
    issueNumber: 8,
    projectName: "beta",
    title: "Beta finished in window"
  });

  // Run-event-in opened PR #50; its merge was last observed in the window.
  at("2026-10-20T08:30:00.000Z", () => {
    runStore.trackPullRequest({
      branchName: "sym/alpha/1",
      headSha: "b".repeat(40),
      issueNumber: 1,
      projectName: "alpha",
      prNumber: 50,
      prUrl: "https://github.com/example/repo/pull/50",
      runId: "run-event-in"
    });
  });
  const tracked = runStore.findTrackedPullRequestByProjectAndNumber({
    prNumber: 50,
    projectName: "alpha"
  });
  at("2026-10-21T09:00:00.000Z", () =>
    runStore.recordPullRequestObservation({
      headSha: "b".repeat(40),
      id: tracked?.id ?? 0,
      prUrl: "https://github.com/example/repo/pull/50",
      reviewFollowupCapReached: false,
      state: "merged"
    })
  );
  // A tracked PR that is still open.
  at("2026-10-22T09:00:00.000Z", () =>
    runStore.trackPullRequest({
      branchName: "sym/alpha/6",
      headSha: "c".repeat(40),
      issueNumber: 6,
      projectName: "alpha",
      prNumber: 51,
      prUrl: "https://github.com/example/repo/pull/51",
      runId: "run-failed"
    })
  );

  at("2026-10-21T09:05:00.000Z", () =>
    runStore.recordPullRequestMergeAttempt({
      error: null,
      freshTrackingState: "merged",
      method: "squash",
      ok: true,
      prNumber: 50,
      projectName: "alpha"
    })
  );
  at("2026-10-20T07:00:00.000Z", () =>
    runStore.recordPullRequestMergeAttempt({
      error: "required status check failed",
      freshTrackingState: "open",
      method: "squash",
      ok: false,
      prNumber: 50,
      projectName: "alpha"
    })
  );

  // Issue snapshot for #1 so the Issue page exists; PR snapshots for #50,
  // #51 and an untracked merged #60.
  seedPoll(runStore, "alpha", "2026-10-23T10:00:00.000Z");
  at("2026-10-23T10:00:00.000Z", () => {
    runStore.replaceProjectIssueSnapshots({
      polledAt: "2026-10-23T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        {
          blockedBy: [],
          blockedByTruncated: false,
          issueNumber: 1,
          kind: "filtered",
          labels: [],
          priority: 1,
          reasons: ["has an open pull request"],
          title: "Created old, finished in window"
        }
      ]
    });
    runStore.replaceProjectPullRequestSnapshots({
      polledAt: "2026-10-23T10:00:00.000Z",
      projectName: "alpha",
      rows: [
        pullRequestRow({ merged: true, open: false, prNumber: 50 }),
        pullRequestRow({ prNumber: 51 }),
        pullRequestRow({
          merged: true,
          open: false,
          prNumber: 60,
          title: "Merged outside Symphonika tracking"
        })
      ]
    });
  });
  seedPoll(runStore, "beta", "2026-10-23T11:00:00.000Z", {
    error: "GitHub token revoked",
    ok: false
  });
  vi.setSystemTime(new Date(NOW));
}

function makeApp(
  test: TestSetup,
  options: Partial<Parameters<typeof createHttpApp>[0]> = {}
) {
  return createHttpApp({
    csrfSecret: TEST_SECRET,
    now: () => NOW_MS,
    runStore: test.runStore,
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

function section(html: string, anchorId: string): string {
  const start = html.indexOf(`id="${anchorId}"`);
  expect(start, `${anchorId} should be present`).toBeGreaterThanOrEqual(0);
  const tail = html.slice(start);
  const next = tail.indexOf("<section", 1);
  return next === -1 ? tail : tail.slice(0, next);
}

function tableCounts(test: TestSetup): Record<string, number> {
  const database = new Database(databasePath(test.stateRoot), {
    readonly: true
  });
  try {
    const count = (table: string): number =>
      (
        database.prepare(`select count(*) as n from ${table}`).get() as {
          n: number;
        }
      ).n;
    return Object.fromEntries(
      [
        "runs",
        "run_state_transitions",
        "tracked_pull_requests",
        "pull_request_merge_attempts",
        "maestro_messages",
        "maestro_conversations"
      ].map((table) => [table, count(table)])
    );
  } finally {
    database.close();
  }
}

describe("GET /history windows (#868)", () => {
  it("attributes completed work to event time, with an inclusive from and an exclusive to", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { html, status } = await get(makeApp(test), "/history?window=7d");
      expect(status).toBe(200);
      const completed = section(html, "history-completed");

      expect(completed).toContain("Created old, finished in window");
      expect(completed).toContain("Finished exactly at from");
      expect(completed).toContain("Beta finished in window");
      expect(completed).not.toContain("Finished a millisecond before from");
      expect(completed).not.toContain("Finished exactly at to");
      expect(completed).not.toContain("Created in window, still queued");
      expect(completed).not.toContain("Finished in the 30 day window only");
      expect(completed).not.toContain("Failed in window");
      expect(html).toContain(`<code>${FROM_7D}</code> (inclusive)`);
      expect(html).toContain(`<code>${NOW}</code> (exclusive)`);
    } finally {
      test.cleanup();
    }
  });

  it("lets a 30-day window reach Runs that finished earlier", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      const week = section(
        (await get(app, "/history?window=7d")).html,
        "history-completed"
      );
      const month = await get(app, "/history?window=30d");

      expect(week).not.toContain("Finished in the 30 day window only");
      expect(section(month.html, "history-completed")).toContain(
        "Finished in the 30 day window only"
      );
      expect(month.html).toContain("2026-09-23T12:00:00.000Z");
    } finally {
      test.cleanup();
    }
  });

  it("defaults to the rolling last 7 days when no range is given", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { html } = await get(makeApp(test), "/history");
      expect(html).toContain(`<code>${FROM_7D}</code> (inclusive)`);
    } finally {
      test.cleanup();
    }
  });

  it("honours a custom UTC range: date-only bounds and ISO times with Z", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      const days = await get(app, "/history?from=2026-10-19&to=2026-10-21");
      const completed = section(days.html, "history-completed");
      expect(completed).toContain("Created old, finished in window");
      expect(completed).not.toContain("Beta finished in window");
      expect(days.html).toContain("<code>2026-10-19T00:00:00.000Z</code>");
      expect(days.html).toContain("<code>2026-10-21T00:00:00.000Z</code>");

      const exact = await get(
        app,
        `/history?from=${FROM_7D}&to=2026-10-16T12:00:00.001Z`
      );
      expect(section(exact.html, "history-completed")).toContain(
        "Finished exactly at from"
      );
      const excluded = await get(
        app,
        `/history?from=2026-10-10T00:00:00Z&to=${FROM_7D}`
      );
      const excludedCompleted = section(excluded.html, "history-completed");
      expect(excludedCompleted).not.toContain("Finished exactly at from");
      expect(excludedCompleted).toContain("Finished a millisecond before from");
    } finally {
      test.cleanup();
    }
  });

  it("includes the Run that finished exactly at a later range's to once the range covers it", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { html } = await get(
        makeApp(test),
        "/history?from=2026-10-23&to=2026-10-24"
      );
      expect(section(html, "history-completed")).toContain(
        "Finished exactly at to"
      );
    } finally {
      test.cleanup();
    }
  });

  it("prints the resolved range of a rolling request as an exact permalink that reproduces it", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      const rolling = await get(app, "/history?window=7d");
      const permalink = /href="(\/history\?from=[^"]+)"/.exec(
        rolling.html
      )?.[1];
      expect(permalink).toBeDefined();
      const later = makeApp(test, { now: () => NOW_MS + 3 * 86_400_000 });
      const revisited = await get(
        later,
        (permalink ?? "").replace(/&amp;/g, "&")
      );

      expect(section(revisited.html, "history-completed")).toEqual(
        section(rolling.html, "history-completed")
      );
      expect(revisited.html).toContain("Custom range.");
    } finally {
      test.cleanup();
    }
  });
});

describe("GET /projects/:name/history (#868)", () => {
  it("scopes the report to one Project", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      const alpha = await get(app, "/projects/alpha/history?window=7d");
      const beta = await get(app, "/projects/beta/history?window=7d");

      expect(alpha.status).toBe(200);
      expect(section(alpha.html, "history-completed")).toContain(
        "Created old, finished in window"
      );
      expect(alpha.html).not.toContain("Beta finished in window");
      expect(section(beta.html, "history-completed")).toContain(
        "Beta finished in window"
      );
      expect(beta.html).not.toContain("Created old, finished in window");
      expect(alpha.html).toContain('href="/projects/alpha/briefing"');
      expect(alpha.html).toContain('href="/history"');
    } finally {
      test.cleanup();
    }
  });

  it("returns 404 for an unknown Project, even with an invalid range", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      expect((await get(app, "/projects/nope/history")).status).toBe(404);
      expect(
        (await get(app, "/projects/nope/history?from=bad&to=worse")).status
      ).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("is GET-only", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const urlPath of ["/history", "/projects/alpha/history"]) {
          const response = await app.request(urlPath, {
            headers: browserHeaders(),
            method
          });
          expect(
            response.status,
            `${method} ${urlPath}`
          ).toBeGreaterThanOrEqual(400);
        }
      }
    } finally {
      test.cleanup();
    }
  });
});

describe("invalid history ranges (#868)", () => {
  const cases: Array<[string, string, string]> = [
    ["an inverted range", "from=2026-10-21&to=2026-10-19", "earlier than to"],
    ["an empty range", "from=2026-10-21&to=2026-10-21", "earlier than to"],
    [
      "a time without a zone",
      "from=2026-10-19T00:00:00&to=2026-10-21",
      "ambiguous"
    ],
    [
      "a calendar date that does not exist",
      "from=2026-02-30&to=2026-03-05",
      "calendar"
    ],
    ["garbage", "from=yesterday&to=today", "must be a UTC date"],
    ["a lone from", "from=2026-10-19", "both from and to"],
    ["a lone to", "to=2026-10-19", "both from and to"],
    [
      "a window with a range",
      "window=7d&from=2026-10-19&to=2026-10-21",
      "not both"
    ],
    ["an unknown window", "window=90d", "window must be one of"],
    ["a range over a year", "from=2025-01-01&to=2026-10-01", "at most 366 days"]
  ];

  for (const [name, query, message] of cases) {
    it(`answers ${name} with a readable 400`, async () => {
      const test = await setup();
      try {
        seedHistory(test.runStore);
        const app = makeApp(test);
        for (const urlPath of ["/history", "/projects/alpha/history"]) {
          const { html, status } = await get(app, `${urlPath}?${query}`);
          expect(status, urlPath).toBe(400);
          expect(html).toContain("Invalid history range");
          expect(html).toContain(message);
          expect(html).toContain("window=7d");
        }
      } finally {
        test.cleanup();
      }
    });
  }
});

describe("history report sections (#868)", () => {
  it("keeps completed work, unsuccessful outcomes, GitHub observations and chat suggestions apart", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { html } = await get(makeApp(test), "/history?window=7d");

      const completed = section(html, "history-completed");
      expect(completed).toContain("PR #50");
      expect(completed).toContain("merge ok");
      expect(completed).toContain("state last observed by Symphonika");
      expect(completed).not.toContain("Merged outside Symphonika tracking");

      const unsuccessful = section(html, "history-unsuccessful");
      expect(unsuccessful).toContain("Failed in window");
      expect(unsuccessful).toContain("required status check failed");
      expect(unsuccessful).toContain("merge failed");
      expect(unsuccessful).not.toContain("Beta finished in window");

      const observations = section(html, "history-observations");
      expect(observations).toContain("Merged outside Symphonika tracking");
      expect(observations).toContain("seen merged in a poll");
      expect(observations).toContain("PR #51");
      expect(observations).not.toContain("Failed in window");
    } finally {
      test.cleanup();
    }
  });

  it("labels a stale poll and a failed GitHub read in the observations", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { html } = await get(makeApp(test), "/history?window=7d");
      const observations = section(html, "history-observations");

      expect(observations).toContain("GitHub read failed");
      expect(observations).toContain("GitHub token revoked");
      expect(observations).toContain("No GitHub poll has succeeded yet");

      const stale = await get(
        makeApp(test, { now: () => NOW_MS + 60 * 60_000 }),
        "/projects/alpha/history?window=7d"
      );
      const staleObservations = section(stale.html, "history-observations");
      expect(staleObservations).toContain("stale poll");
      expect(staleObservations).toContain(
        "The last successful GitHub poll was"
      );
    } finally {
      test.cleanup();
    }
  });

  it("shows past Maestro chat only as a labelled suggestion, never as completed work or Run evidence", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const dashboard = test.runStore.ensureDashboardMaestroConversation({
        id: "conv-dashboard"
      });
      const alphaChat = test.runStore.ensureProjectMaestroConversation({
        id: "conv-alpha",
        projectName: "alpha"
      });
      at("2026-10-20T10:00:00.000Z", () => {
        test.runStore.appendMaestroMessage({
          citations: [
            {
              href: "/runs/run-fabricated",
              kind: "run",
              label: "alpha run run-fabricated",
              observedAt: "2026-10-20T10:00:00.000Z"
            }
          ],
          content: "Maestro says issue #77 shipped in run-fabricated.",
          conversationId: dashboard,
          id: "m-dash",
          role: "assistant"
        });
        test.runStore.appendMaestroMessage({
          citations: [],
          content: "<script>alert(1)</script> alpha is done",
          conversationId: alphaChat,
          id: "m-alpha",
          role: "assistant"
        });
        test.runStore.appendMaestroMessage({
          citations: [],
          content: "operator question mentioning issue #88",
          conversationId: dashboard,
          id: "m-user",
          role: "user"
        });
      });
      at("2026-10-01T10:00:00.000Z", () =>
        test.runStore.appendMaestroMessage({
          citations: [],
          content: "too old to show",
          conversationId: dashboard,
          id: "m-old",
          role: "assistant"
        })
      );
      vi.setSystemTime(new Date(NOW));
      const before = tableCounts(test);
      const runsBefore = test.runStore.listRuns().map((run) => run.id);

      const app = makeApp(test);
      const all = (await get(app, "/history?window=7d")).html;
      const project = (await get(app, "/projects/alpha/history?window=7d"))
        .html;
      const beta = (await get(app, "/projects/beta/history?window=7d")).html;

      const suggestions = section(all, "history-suggestions");
      expect(suggestions).toContain("run-fabricated");
      expect(suggestions).toContain("Suggestion, not evidence");
      expect(suggestions).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(suggestions).not.toContain("<script>alert(1)");
      expect(suggestions).not.toContain("operator question");
      expect(suggestions).not.toContain("too old to show");
      expect(suggestions).not.toContain('href="/runs/run-fabricated"');

      for (const html of [all, project, beta]) {
        for (const anchor of [
          "history-completed",
          "history-unsuccessful",
          "history-observations"
        ]) {
          const body = section(html, anchor);
          expect(body).not.toContain("run-fabricated");
          expect(body).not.toContain("#77");
          expect(body).not.toContain("alpha is done");
        }
      }
      const projectSuggestions = section(project, "history-suggestions");
      expect(projectSuggestions).toContain("alpha is done");
      expect(projectSuggestions).not.toContain("run-fabricated");
      expect(section(beta, "history-suggestions")).not.toContain(
        "alpha is done"
      );

      expect(tableCounts(test)).toEqual(before);
      expect(test.runStore.listRuns().map((run) => run.id)).toEqual(runsBefore);
    } finally {
      test.cleanup();
    }
  });

  it("writes nothing when a report is requested", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const before = tableCounts(test);
      const app = makeApp(test);
      await get(app, "/history?window=30d");
      await get(app, "/projects/alpha/history?from=2026-10-01&to=2026-10-30");
      expect(tableCounts(test)).toEqual(before);
    } finally {
      test.cleanup();
    }
  });

  it("links Run, PR, Issue and observation evidence, and none of the internal links is dead", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      const { html } = await get(app, "/history?window=7d");
      const completed = section(html, "history-completed");

      expect(completed).toContain('href="/runs/run-event-in"');
      expect(completed).toContain('href="/issues/alpha/1"');
      expect(completed).toContain('href="/prs/alpha/50"');
      expect(completed).toContain('href="/projects/alpha"');
      expect(completed).toContain("observed");
      // Issue #2 has no current snapshot: shown as text, not a dead link.
      expect(completed).not.toContain('href="/issues/alpha/2"');

      const hrefs = new Set(
        [...html.matchAll(/href="(\/[^"#]*)"/g)].map((match) =>
          (match[1] ?? "").replace(/&amp;/g, "&")
        )
      );
      for (const href of hrefs) {
        if (!/^\/(runs|issues|prs|projects)\b/.test(href)) {
          continue;
        }
        const response = await app.request(href, { headers: browserHeaders() });
        expect(response.status, href).not.toBe(404);
      }
    } finally {
      test.cleanup();
    }
  });

  it("is reachable from the dashboard, the briefing pages and the Project page", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const app = makeApp(test);
      expect((await get(app, "/")).html).toContain('href="/history"');
      expect((await get(app, "/briefing")).html).toContain('href="/history"');
      expect((await get(app, "/projects/alpha/briefing")).html).toContain(
        'href="/projects/alpha/history"'
      );
      expect((await get(app, "/projects/alpha")).html).toContain(
        'href="/projects/alpha/history"'
      );
    } finally {
      test.cleanup();
    }
  });
});

describe("Maestro get_work_history (#868)", () => {
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

  function historyModel(
    input: unknown,
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
              toolUses: [{ id: "toolu_0", input, name: "get_work_history" }]
            });
          }
          for (const entry of turn.history) {
            if (entry.role === "tool_result") {
              seenResults.push(...entry.results.map((r) => r.content));
            }
          }
          return Promise.resolve({ kind: "message" as const, text: "done" });
        }
      };
    };
  }

  type ToolHistory = {
    completed: {
      items: Array<{
        citations: Array<{ href: string; kind: string; observedAt: string }>;
        eventAt: string;
        outcome: string;
        runId: string | null;
      }>;
      omitted: number;
    };
    notice: string;
    observations: {
      freshness: Array<{ labels: string[]; projectName: string }>;
      observedMergedPullRequests: { items: Array<{ prNumber: number }> };
    };
    range: { from: string; kind: string; to: string; window: string | null };
    scope: { kind: string; projectName?: string };
    unsuccessful: { items: Array<{ outcome: string; runId: string | null }> };
  };

  async function run(
    test: TestSetup,
    urlPath: string,
    input: unknown
  ): Promise<{ app: ReturnType<typeof createHttpApp>; results: string[] }> {
    const results: string[] = [];
    const app = makeApp(test, {
      createMaestroModel: historyModel(input, results),
      getMaestroConfig: () => MAESTRO_CONFIG
    });
    await ask(app, urlPath, "What got done?");
    return { app, results };
  }

  it("returns completed work by event time with evidence links and freshness", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { results } = await run(test, "/maestro/messages", {
        window: "7d"
      });
      const history = JSON.parse(results[0] ?? "null") as ToolHistory;

      expect(history.scope).toEqual({ kind: "all" });
      expect(history.range).toEqual({
        from: FROM_7D,
        kind: "rolling",
        to: NOW,
        window: "7d"
      });
      expect(history.notice).toContain("GitHub was not called");
      const runIds = history.completed.items.map((item) => item.runId);
      expect(runIds).toContain("run-event-in");
      expect(runIds).toContain("run-at-from");
      expect(runIds).not.toContain("run-before-from");
      expect(runIds).not.toContain("run-at-to");
      expect(history.unsuccessful.items.map((item) => item.outcome)).toContain(
        "failed"
      );
      const runItem = history.completed.items.find(
        (item) => item.runId === "run-event-in" && item.outcome === "succeeded"
      );
      expect(runItem?.eventAt).toBe("2026-10-20T08:00:00.000Z");
      const runCitation = runItem?.citations.find((c) => c.kind === "run");
      expect(runCitation).toMatchObject({
        href: "/runs/run-event-in",
        observedAt: "2026-10-20T08:00:00.000Z"
      });
      expect(runItem?.citations.map((c) => c.kind)).toEqual(
        expect.arrayContaining(["project", "run", "issue", "pull_request"])
      );
      expect(
        history.observations.observedMergedPullRequests.items.map(
          (item) => item.prNumber
        )
      ).toEqual([60]);
      const labels = Object.fromEntries(
        history.observations.freshness.map((entry) => [
          entry.projectName,
          entry.labels
        ])
      );
      expect(labels.beta).toEqual(
        expect.arrayContaining(["poll_failed", "never_polled"])
      );
    } finally {
      test.cleanup();
    }
  });

  it("attaches server-built citations to the reply", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { app } = await run(test, "/maestro/messages", { window: "7d" });
      const html = (await get(app, "/maestro")).html;

      expect(html).toContain('href="/runs/run-event-in"');
      expect(html).toContain('href="/prs/alpha/50"');
      expect(html).toContain('href="/projects/alpha"');
    } finally {
      test.cleanup();
    }
  });

  it("accepts an explicit from and to and reports the resolved range", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { results } = await run(test, "/maestro/messages", {
        from: "2026-10-19",
        to: "2026-10-21"
      });
      const history = JSON.parse(results[0] ?? "null") as ToolHistory;

      expect(history.range).toEqual({
        from: "2026-10-19T00:00:00.000Z",
        kind: "custom",
        to: "2026-10-21T00:00:00.000Z",
        window: null
      });
      expect(history.completed.items.map((item) => item.runId)).toContain(
        "run-event-in"
      );
    } finally {
      test.cleanup();
    }
  });

  it("defaults an omitted project_name to the focus Project, and lets the model name another", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const focused = await run(test, "/projects/alpha/maestro/messages", {
        window: "7d"
      });
      const other = await run(test, "/projects/alpha/maestro/messages", {
        project_name: "beta",
        window: "7d"
      });
      const unknown = await run(test, "/maestro/messages", {
        project_name: "nope",
        window: "7d"
      });

      const focusedHistory = JSON.parse(
        focused.results[0] ?? "null"
      ) as ToolHistory;
      expect(focusedHistory.scope).toEqual({
        kind: "project",
        projectName: "alpha"
      });
      expect(focused.results[0]).not.toContain("run-beta");
      expect(other.results[0]).toContain("run-beta");
      expect(unknown.results[0]).toBe('{"found":false,"projectName":"nope"}');
    } finally {
      test.cleanup();
    }
  });

  it("refuses an invalid range with a readable reason", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const { results } = await run(test, "/maestro/messages", {
        from: "2026-10-21",
        to: "2026-10-19"
      });
      expect(results[0]).toContain("earlier than to");
    } finally {
      test.cleanup();
    }
  });

  it("never returns past Maestro chat as tool output", async () => {
    const test = await setup();
    try {
      seedHistory(test.runStore);
      const dashboard = test.runStore.ensureDashboardMaestroConversation({
        id: "conv-dashboard"
      });
      at("2026-10-20T10:00:00.000Z", () =>
        test.runStore.appendMaestroMessage({
          citations: [],
          content: "Maestro says issue #77 shipped in run-fabricated.",
          conversationId: dashboard,
          id: "m-dash",
          role: "assistant"
        })
      );
      vi.setSystemTime(new Date(NOW));
      const { results } = await run(test, "/maestro/messages", {
        window: "7d"
      });

      expect(results[0]).not.toContain("run-fabricated");
      expect(results[0]).not.toContain("#77");
    } finally {
      test.cleanup();
    }
  });
});
