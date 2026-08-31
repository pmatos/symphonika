import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import {
  emptyIssuePollStatus,
  type IssueSnapshot
} from "../src/issue-polling.js";
import { routineEvidencePaths } from "../src/routines/evidence.js";
import type { RunState } from "../src/run-store.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { buildStatusSnapshot } from "../src/status.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-http-runs-test-"));
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

// `createRun` stamps `created_at` from the wall clock, and the Watchdog's
// wall-clock countdown (ADR 0089) is measured from it — so a fixture that
// asserts an exact countdown has to pin the claim instant instead of letting
// it float to whenever the suite happens to run. Only Date is faked, so
// timers and the event loop are untouched.
function withClaimTime(instant: string, create: () => void): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
  try {
    create();
  } finally {
    vi.useRealTimers();
  }
}

describe("HTTP app — runs API and pages", () => {
  it("shows each Run's current workflow state on /runs", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-current-state",
        issue: sampleIssue({ number: 484, title: "Visible workflow state" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.setRunCurrentState("run-current-state", "code_review_fix");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/runs");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("<th>Current state</th>");
      expect(body).toContain("<code>code_review_fix</code>");
    } finally {
      test.cleanup();
    }
  });

  it("keeps a recorded terminal workflow state visible across run pages", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(
        test.stateRoot,
        "logs",
        "runs",
        "run-terminal-state"
      );
      await mkdir(evidenceDir, { recursive: true });
      const graphPath = path.join(evidenceDir, "workflow-graph.json");
      await writeFile(
        graphPath,
        JSON.stringify({
          contentHash: "sha256:" + "e".repeat(64),
          initial: "implement",
          name: "terminal_state_workflow",
          source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
          states: [
            {
              action: { kind: "agent", prompt: "Implement" },
              completeWhen: {},
              id: "implement",
              transitions: [{ to: "done", when: { provider_success: true } }]
            },
            {
              completeWhen: {},
              id: "done",
              terminal: "success",
              transitions: []
            }
          ],
          templateFiles: []
        })
      );

      test.runStore.createRun({
        id: "run-terminal-state",
        issue: sampleIssue({ number: 485, title: "Terminal workflow state" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.setRunCurrentState("run-terminal-state", "implement");
      test.runStore.recordWorkflowTerminal("run-terminal-state", {
        terminalStateId: "done",
        transitionReason: "implement -> done"
      });
      test.runStore.updateRunState("run-terminal-state", "succeeded");
      test.runStore.updateRunEvidence("run-terminal-state", {
        branchName: "sym/run-terminal-state",
        branchRef: "refs/heads/sym/run-terminal-state",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const runsBody = await (await app.request("/runs")).text();
      expect(runsBody).toContain("<code>done</code>");

      const detailBody = await (
        await app.request("/runs/run-terminal-state")
      ).text();
      expect(detailBody).toContain(
        "<dt>Current state</dt><dd><code>done</code></dd>"
      );

      const graphBody = await (
        await app.request("/runs/run-terminal-state/graph")
      ).text();
      expect(graphBody).toContain(
        'window.__WORKFLOW_CURRENT_STATE__ = "done";'
      );
      expect(graphBody).toContain("Current state <code>done</code>");
    } finally {
      test.cleanup();
    }
  });

  it("filters /api/runs by state and project", async () => {
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
      test.runStore.createRun({
        id: "run-b",
        issue: sampleIssue({ number: 2 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-b", "failed");
      test.runStore.createRun({
        id: "run-c",
        issue: sampleIssue({ number: 3 }),
        projectName: "beta",
        providerCommand: "x",
        providerName: "claude"
      });
      test.runStore.updateRunState("run-c", "failed");
      test.runStore.createRun({
        id: "run-d",
        issue: sampleIssue({ number: 4 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-d", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request(
        "/api/runs?state=failed&project=alpha"
      );
      const body = (await response.json()) as { runs: { id: string }[] };
      expect(response.status).toBe(200);
      expect(body.runs.map((r) => r.id)).toEqual(["run-b"]);

      const blockedResponse = await app.request(
        "/api/runs?state=blocked&project=alpha"
      );
      const blockedBody = (await blockedResponse.json()) as {
        runs: { id: string }[];
      };
      expect(blockedResponse.status).toBe(200);
      expect(blockedBody.runs.map((r) => r.id)).toEqual(["run-d"]);
    } finally {
      test.cleanup();
    }
  });

  it("renders Cap context on the /runs/:id HTML page for cap_reached:* runs", async () => {
    const test = await setup();
    try {
      const issue = sampleIssue({ number: 65, title: "Capped" });
      test.runStore.createRun({
        id: "fresh",
        issue,
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("fresh", "succeeded");
      test.runStore.createContinuationRun({
        id: "cont-1",
        issue,
        parentRunId: "fresh",
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("cont-1", "succeeded");
      test.runStore.createCapReachedFailureRun({
        id: "cap",
        issue,
        parentRunId: "cont-1",
        projectName: "alpha",
        reason: "cap_reached:no_commits"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/runs/cap");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<dt>Terminal reason</dt>");
      expect(html).toContain("cap_reached:no_commits");
      expect(html).toContain(
        "<strong>Cap context:</strong> continuation cap reached after 1 continuation: no commits on issue branch"
      );
    } finally {
      test.cleanup();
    }
  });

  it("shows and clears manual attention when PR review follow-up exhausts its cap", async () => {
    const test = await setup();
    try {
      const issue = sampleIssue({
        number: 54,
        title: "Review follow-up cap"
      });
      test.runStore.createRun({
        id: "parent-run",
        issue,
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("parent-run", "succeeded");
      test.runStore.createWaitingRun({
        currentStateId: "holding",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "alpha"
      });
      test.runStore.trackPullRequest({
        branchName: "sym/alpha/54-review-followup-cap",
        headSha: "abc123",
        issueNumber: issue.number,
        prNumber: 81,
        prUrl: "https://github.com/pmatos/symphonika/pull/81",
        projectName: "alpha",
        runId: "parent-run"
      });
      const tracked = test.runStore.listOpenTrackedPullRequests()[0]!;
      for (let dispatch = 1; dispatch <= 3; dispatch += 1) {
        test.runStore.recordPullRequestReviewDispatch({
          fingerprint: `feedback-${dispatch}`,
          headSha: "abc123",
          id: tracked.id,
          runId: `review-run-${dispatch}`
        });
      }
      test.runStore.recordPullRequestObservation({
        headSha: "abc123",
        id: tracked.id,
        prUrl: tracked.prUrl,
        reviewFollowupCapReached: true,
        state: "open"
      });

      const app = createHttpApp({
        getPullRequestFollowupPolicy: () => ({
          maxReviewDispatchesPerPr: 3
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const detailResponse = await app.request("/api/runs/waiting-run");
      const detail = (await detailResponse.json()) as {
        pullRequestFollowup: null | {
          attention: string;
          dispatchCount: number;
          maxDispatches: number;
          prNumber: number;
          prUrl: string;
        };
      };
      expect(detail.pullRequestFollowup).toEqual({
        attention: "cap_reached",
        dispatchCount: 3,
        maxDispatches: 3,
        prNumber: 81,
        prUrl: "https://github.com/pmatos/symphonika/pull/81"
      });

      const pageResponse = await app.request("/runs/waiting-run");
      const page = await pageResponse.text();
      expect(page).toContain('class="banner banner--attention"');
      expect(page).toContain("Manual attention required");
      expect(page).toContain(
        "PR review follow-up reached its dispatch cap (3 of 3) while unresolved feedback remains."
      );
      expect(page).toContain(
        'href="https://github.com/pmatos/symphonika/pull/81"'
      );

      const raisedCapApp = createHttpApp({
        getPullRequestFollowupPolicy: () => ({
          maxReviewDispatchesPerPr: 4
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const raisedCapDetail = (await (
        await raisedCapApp.request("/api/runs/waiting-run")
      ).json()) as { pullRequestFollowup: unknown };
      expect(raisedCapDetail.pullRequestFollowup).toBeNull();

      test.runStore.recordPullRequestObservation({
        headSha: "abc123",
        id: tracked.id,
        prUrl: tracked.prUrl,
        reviewFollowupCapReached: false,
        state: "open"
      });

      const clearedDetail = (await (
        await app.request("/api/runs/waiting-run")
      ).json()) as { pullRequestFollowup: unknown };
      expect(clearedDetail.pullRequestFollowup).toBeNull();
      const clearedPage = await (await app.request("/runs/waiting-run")).text();
      expect(clearedPage).not.toContain("Manual attention required");
    } finally {
      test.cleanup();
    }
  });

  it("returns 404 for /api/runs/:id when missing and detail otherwise", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      expect((await app.request("/api/runs/missing")).status).toBe(404);

      test.runStore.createRun({
        id: "have-run",
        issue: sampleIssue({ number: 7 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("have-run", "running");
      const ok = await app.request("/api/runs/have-run");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        run: { id: string; state: RunState };
        attempts: unknown[];
        transitions: unknown[];
        events: unknown[];
      };
      expect(body.run.id).toBe("have-run");
      expect(body.run.state).toBe("running");
    } finally {
      test.cleanup();
    }
  });

  it("exposes the persisted watchdog sample on /api/runs/:id", async () => {
    const test = await setup();
    try {
      withClaimTime("2026-05-22T13:01:00.000Z", () => {
        test.runStore.createRun({
          id: "watchdog-detail",
          issue: sampleIssue({ number: 202 }),
          projectName: "alpha",
          providerCommand: "x",
          providerName: "codex"
        });
      });
      test.runStore.updateRunState("watchdog-detail", "running");
      test.runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T11:25:30.000Z",
        lastMessageAt: "2026-05-22T11:25:45.000Z",
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T11:25:00.000Z",
        normalizedLogOffset: 123,
        normalizedLogPath: "/tmp/provider.normalized.jsonl",
        outputTokensTotal: 36_365,
        runId: "watchdog-detail",
        sampledAt: "2026-05-22T14:01:00.000Z",
        turnIdSetSize: 1,
        workspaceDigest: "",
        workspaceMtimeMax: Date.parse("2026-05-22T11:25:30.000Z")
      });

      const app = createHttpApp({
        now: () => Date.parse("2026-05-22T14:01:00.000Z"),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/api/runs/watchdog-detail");
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.watchdog).toEqual({
        enabled: true,
        graceMs: 1_800_000,
        graceRemainingMs: -7_530_000,
        idleSince: "2026-05-22T11:25:30.000Z",
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T11:25:00.000Z",
        maxRunMs: 21_600_000,
        outputTokenBudget: 150_000,
        outputTokensTotal: 36_365,
        // Claimed an hour before this view, against the default six-hour cap.
        runRemainingMs: 18_000_000,
        sampledAt: "2026-05-22T14:01:00.000Z",
        turnIdSetSize: 1,
        workspaceMtimeMax: "2026-05-22T11:25:30.000Z"
      });
    } finally {
      test.cleanup();
    }
  });

  it("omits watchdog sample fields when the watchdog is disabled", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "watchdog-disabled",
        issue: sampleIssue({ number: 202 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T11:45:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T11:40:00.000Z",
        normalizedLogOffset: 0,
        normalizedLogPath: "",
        outputTokensTotal: 10,
        runId: "watchdog-disabled",
        sampledAt: "2026-05-22T11:59:00.000Z",
        turnIdSetSize: 1,
        workspaceDigest: "",
        workspaceMtimeMax: Date.parse("2026-05-22T11:41:00.000Z")
      });

      const app = createHttpApp({
        getWatchdogConfig: () => ({
          enabled: false,
          graceMinutes: 30,
          maxRunMinutes: 0,
          outputTokenBudget: 0
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/api/runs/watchdog-disabled");
      const body = (await response.json()) as { watchdog?: unknown };

      expect(body.watchdog).toEqual({ enabled: false });
    } finally {
      test.cleanup();
    }
  });

  it("streams /api/runs/:id/files/provider_raw only for artifacts inside the run evidence dir", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(
        test.stateRoot,
        "logs",
        "runs",
        "run-files"
      );
      await mkdir(evidenceDir, { recursive: true });
      const rawLogPath = path.join(evidenceDir, "provider.raw.jsonl");
      await writeFile(rawLogPath, '{"x":1}\n', "utf8");

      test.runStore.createRun({
        id: "run-files",
        issue: sampleIssue({ number: 4 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunEvidence("run-files", {
        branchName: "branch",
        branchRef: "refs/heads/branch",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath,
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });

      // Empty path → 404
      test.runStore.createRun({
        id: "run-empty",
        issue: sampleIssue({ number: 5 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });

      // Path escapes evidence dir → 404
      const escaping = path.join(test.stateRoot, "outside.jsonl");
      await writeFile(escaping, "evil\n", "utf8");
      test.runStore.createRun({
        id: "run-escape",
        issue: sampleIssue({ number: 6 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunEvidence("run-escape", {
        branchName: "branch",
        branchRef: "refs/heads/branch",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: escaping,
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const ok = await app.request("/api/runs/run-files/files/provider_raw");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("application/x-ndjson");
      expect(await ok.text()).toContain('{"x":1}');

      const log = await app.request("/logs/runs/run-files/provider_raw");
      expect(log.status).toBe(200);
      expect(log.headers.get("content-type")).toContain("application/x-ndjson");
      expect(await log.text()).toContain('{"x":1}');

      expect(
        (await app.request("/api/runs/run-empty/files/provider_raw")).status
      ).toBe(404);
      expect(
        (await app.request("/api/runs/run-escape/files/provider_raw")).status
      ).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("POST /api/runs/:id/cancel cancels run-store backed active runs", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "live",
        issue: sampleIssue({ number: 11 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("live", "running");
      test.runStore.createRun({
        id: "done",
        issue: sampleIssue({ number: 12 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("done", "succeeded");
      test.runStore.createRun({
        id: "needs-input",
        issue: sampleIssue({ number: 13 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("needs-input", "input_required");
      test.runStore.createRun({
        id: "blocked-run",
        issue: sampleIssue({ number: 14 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.recordTerminalReason(
        "blocked-run",
        "no_workspace_changes",
        "deterministic"
      );
      test.runStore.updateRunState("blocked-run", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const ok = await app.request("/api/runs/live/cancel", { method: "POST" });
      expect(ok.status).toBe(200);
      const okBody = (await ok.json()) as { kind: string };
      expect(okBody.kind).toBe("cancelled");
      const detail = test.runStore.getRun("live");
      expect(detail?.state).toBe("cancelled");
      expect(detail?.cancelRequested).toBe(true);
      expect(detail?.cancelReason).toBe("operator");
      expect(detail?.terminalReason).toBe("operator");

      const missing = await app.request("/api/runs/missing/cancel", {
        method: "POST"
      });
      expect(missing.status).toBe(404);

      const done = await app.request("/api/runs/done/cancel", {
        method: "POST"
      });
      expect(done.status).toBe(409);
      expect(await done.json()).toMatchObject({
        kind: "already-terminal",
        state: "succeeded"
      });

      const inputRequired = await app.request("/api/runs/needs-input/cancel", {
        method: "POST"
      });
      expect(inputRequired.status).toBe(409);
      expect(await inputRequired.json()).toMatchObject({
        kind: "already-terminal",
        state: "input_required"
      });

      // Regression: cancelling an already-blocked run must not overwrite its
      // terminal verdict with "cancelled" — see issue #271 / ADR 0058.
      const blocked = await app.request("/api/runs/blocked-run/cancel", {
        method: "POST"
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        kind: "already-terminal",
        state: "blocked"
      });
      expect(test.runStore.getRun("blocked-run")?.state).toBe("blocked");

      const form = await app.request("/api/runs/live/cancel", {
        body: "",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual"
      });
      expect(form.status).toBe(303);
      expect(form.headers.get("location")).toBe("/runs/live");
    } finally {
      test.cleanup();
    }
  });

  it("asks for confirmation before cancelling an active Run and reflects the cancellation", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "web-cancel",
        issue: sampleIssue({ number: 15 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("web-cancel", "running");
      test.runStore.createRun({
        id: "web-cancel-done",
        issue: sampleIssue({ number: 16 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("web-cancel-done", "succeeded");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const activePage = await app.request("/runs/web-cancel");
      const activeBody = await activePage.text();
      expect(activePage.status).toBe(200);
      expect(activeBody).toContain('action="/api/runs/web-cancel/cancel"');
      expect(activeBody).toContain(
        `onsubmit="return window.confirm('Cancel this run? Any active provider process will be stopped. This action cannot be undone.')"`
      );

      const terminalBody = await (
        await app.request("/runs/web-cancel-done")
      ).text();
      expect(terminalBody).not.toContain(
        'action="/api/runs/web-cancel-done/cancel"'
      );

      const cancelResponse = await app.request("/api/runs/web-cancel/cancel", {
        body: "",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        redirect: "manual"
      });
      expect(cancelResponse.status).toBe(303);
      expect(cancelResponse.headers.get("location")).toBe("/runs/web-cancel");

      const cancelledBody = await (
        await app.request("/runs/web-cancel")
      ).text();
      expect(cancelledBody).toContain(">cancelled</span>");
      expect(cancelledBody).toContain(
        "<strong>Cancel requested</strong> (reason: operator)"
      );
      expect(cancelledBody).toContain(
        "<dt>Terminal reason</dt><dd><code>operator</code></dd>"
      );
      expect(cancelledBody).not.toContain(
        'action="/api/runs/web-cancel/cancel"'
      );
    } finally {
      test.cleanup();
    }
  });

  it("renders the dashboard and run detail page with HTML escaping", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "<script>x</script>",
        issue: sampleIssue({ number: 99, title: "<img src=x>" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("<script>x</script>", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const dashboard = await app.request("/");
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get("content-type")).toContain("text/html");
      const body = await dashboard.text();
      expect(body).not.toContain("<script>x</script>");
      expect(body).toContain("&lt;script&gt;x&lt;/script&gt;");
      expect(body).not.toContain("<img src=x>");
      expect(body).toContain("&lt;img src=x&gt;");

      const runs = await app.request("/runs");
      expect(runs.status).toBe(200);
      const runsBody = await runs.text();
      expect(runsBody).toContain("All runs");

      const missing = await app.request("/runs/missing");
      expect(missing.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("renders polling projects, timestamps, and stable log links on pages", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(test.stateRoot, "logs", "runs", "run-page");
      await mkdir(evidenceDir, { recursive: true });
      const rawLogPath = path.join(evidenceDir, "provider.raw.jsonl");
      await writeFile(rawLogPath, '{"type":"message"}\n', "utf8");

      test.runStore.createRun({
        id: "run-page",
        issue: sampleIssue({ number: 77, title: "Visible run" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-page", "running");
      test.runStore.updateRunEvidence("run-page", {
        branchName: "sym/run-page",
        branchRef: "refs/heads/sym/run-page",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath,
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });
      test.runStore.createAttempt({
        attemptNumber: 1,
        branchName: "sym/run-page",
        branchRef: "refs/heads/sym/run-page",
        id: "run-page-attempt-1",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "x",
        providerName: "codex",
        rawLogPath,
        runId: "run-page",
        state: "running",
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });
      const detail = test.runStore.getRun("run-page");

      const app = createHttpApp({
        issuePollStatus: {
          candidateIssues: [],
          errors: [],
          filteredIssues: [],
          projects: [
            {
              fetchedIssues: 4,
              name: "alpha",
              ok: true,
              repository: { owner: "pmatos", repo: "symphonika" }
            }
          ]
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const dashboard = await app.request("/");
      expect(dashboard.status).toBe(200);
      const dashboardBody = await dashboard.text();
      expect(dashboardBody).toContain("Projects");
      expect(dashboardBody).toContain("poll ok");
      expect(dashboardBody).toContain("4 fetched");
      expect(dashboardBody).toContain(detail?.createdAt);
      expect(dashboardBody).toContain(detail?.updatedAt);

      const runPage = await app.request("/runs/run-page");
      expect(runPage.status).toBe(200);
      const runPageBody = await runPage.text();
      expect(runPageBody).toContain("Started");
      expect(runPageBody).toContain("Updated");
      expect(runPageBody).toContain("Attempt started");
      expect(runPageBody).toContain("run-page-attempt-1");
      expect(runPageBody).toContain(detail?.attempts[0]?.createdAt);
      expect(runPageBody).toContain("/logs/runs/run-page/provider_raw");
    } finally {
      test.cleanup();
    }
  });

  it("renders Codex thinking boundaries and reasoning summaries on the run page", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-thinking",
        issue: sampleIssue({ number: 590, title: "Visible thinking" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-thinking", "running");
      test.runStore.createAttempt({
        attemptNumber: 1,
        branchName: "sym/run-thinking",
        branchRef: "refs/heads/sym/run-thinking",
        id: "run-thinking-attempt-1",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "x",
        providerName: "codex",
        rawLogPath: "",
        runId: "run-thinking",
        state: "running",
        workflowGraphPath: "",
        workspacePath: test.stateRoot
      });
      test.runStore.recordProviderEvent({
        attemptId: "run-thinking-attempt-1",
        normalized: {
          itemId: "rs-1",
          status: "started",
          summary: [],
          threadId: "thread-1",
          timestamp: "2026-08-28T13:43:00.000Z",
          turnId: "turn-1",
          type: "thinking"
        },
        raw: {},
        runId: "run-thinking",
        sequence: 1
      });
      test.runStore.recordProviderEvent({
        attemptId: "run-thinking-attempt-1",
        normalized: {
          itemId: "rs-1",
          status: "completed",
          summary: ["Solving the congruences"],
          threadId: "thread-1",
          timestamp: "2026-08-28T13:44:30.000Z",
          turnId: "turn-1",
          type: "thinking"
        },
        raw: {},
        runId: "run-thinking",
        sequence: 2
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/runs/run-thinking");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("thinking since");
      expect(body).toContain('datetime="2026-08-28T13:43:00.000Z"');
      expect(body).toContain("thinking completed");
      expect(body).toContain("Solving the congruences");
    } finally {
      test.cleanup();
    }
  });

  it("renders the workflow graph summary and link on the run-detail page", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(
        test.stateRoot,
        "logs",
        "runs",
        "run-graph"
      );
      await mkdir(evidenceDir, { recursive: true });
      const graphPath = path.join(evidenceDir, "workflow-graph.json");
      await writeFile(
        graphPath,
        JSON.stringify(
          {
            contentHash: "sha256:" + "b".repeat(64),
            initial: "run_agent",
            name: "single_agent_workflow",
            source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
            states: [
              { id: "run_agent", completeWhen: {}, transitions: [] },
              {
                id: "done",
                completeWhen: {},
                terminal: "success",
                transitions: []
              }
            ],
            templateFiles: []
          },
          null,
          2
        )
      );

      test.runStore.createRun({
        id: "run-graph",
        issue: sampleIssue({ number: 88, title: "Graph visible" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-graph", "running");
      test.runStore.setRunCurrentState("run-graph", "code_review_fix");
      test.runStore.updateRunEvidence("run-graph", {
        branchName: "sym/run-graph",
        branchRef: "refs/heads/sym/run-graph",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const runPage = await app.request("/runs/run-graph");
      expect(runPage.status).toBe(200);
      const body = await runPage.text();
      expect(body).toContain("single_agent_workflow");
      expect(body).toContain("markdown");
      expect(body).toContain("run_agent");
      expect(body).toContain(
        "<dt>Current state</dt><dd><code>code_review_fix</code></dd>"
      );
      expect(body).toContain(`href="/logs/runs/run-graph/workflow_graph"`);
      expect(body).toContain(`href="/runs/run-graph/graph"`);
    } finally {
      test.cleanup();
    }
  });

  it("renders the interactive workflow-graph page", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(
        test.stateRoot,
        "logs",
        "runs",
        "run-graph-page"
      );
      await mkdir(evidenceDir, { recursive: true });
      const graphPath = path.join(evidenceDir, "workflow-graph.json");
      await writeFile(
        graphPath,
        JSON.stringify({
          contentHash: "sha256:" + "d".repeat(64),
          initial: "implement",
          name: "self_driving",
          source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
          states: [
            {
              id: "implement",
              completeWhen: {},
              action: {
                kind: "agent",
                provider: "codex",
                prompt: "WORKFLOW.md<x>"
              },
              transitions: [
                {
                  to: "wait_for_pr",
                  when: { provider_success: true, branch_ahead_of_base: true }
                },
                { to: "failed", when: {} }
              ]
            },
            {
              id: "wait_for_pr",
              completeWhen: {},
              action: { kind: "wait" },
              transitions: [{ to: "implement", when: { checks: "failure" } }]
            },
            {
              id: "failed",
              completeWhen: {},
              terminal: "blocked",
              transitions: []
            }
          ],
          templateFiles: []
        })
      );

      test.runStore.createRun({
        id: "run-graph-page",
        issue: sampleIssue({ number: 91, title: "Graph page" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.setRunCurrentState("run-graph-page", "wait_for_pr");
      test.runStore.updateRunEvidence("run-graph-page", {
        branchName: "sym/run-graph-page",
        branchRef: "refs/heads/sym/run-graph-page",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const page = await app.request("/runs/run-graph-page/graph");
      expect(page.status).toBe(200);
      const body = await page.text();
      // Interactive renderer wiring.
      expect(body).toContain("window.__WORKFLOW_GRAPH__");
      expect(body).toContain(
        'window.__WORKFLOW_CURRENT_STATE__ = "wait_for_pr";'
      );
      expect(body).toContain("cytoscape.min.js");
      expect(body).toContain("integrity=");
      // Inlined graph data and navigation.
      expect(body).toContain("self_driving");
      expect(body).toContain("wait_for_pr");
      expect(body).toContain("Current state <code>wait_for_pr</code>");
      expect(body).toContain("Legend");
      expect(body).toContain(`href="/logs/runs/run-graph-page/workflow_graph"`);
      // Angle brackets in inlined JSON values are unicode-escaped so a
      // value cannot break out of the <script> block.
      expect(body).not.toContain("WORKFLOW.md<x>");
      expect(body).toContain("WORKFLOW.md\\u003cx\\u003e");

      // Unknown run and runs without graph evidence 404.
      expect((await app.request("/runs/missing/graph")).status).toBe(404);

      test.runStore.createRun({
        id: "run-no-graph",
        issue: sampleIssue({ number: 92 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      const noGraph = await app.request("/runs/run-no-graph/graph");
      expect(noGraph.status).toBe(404);
      expect(await noGraph.text()).toContain("No workflow graph");
    } finally {
      test.cleanup();
    }
  });

  it("serves the workflow-graph.json file for runs with graph evidence", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(
        test.stateRoot,
        "logs",
        "runs",
        "run-graph-serve"
      );
      await mkdir(evidenceDir, { recursive: true });
      const graphPath = path.join(evidenceDir, "workflow-graph.json");
      const graphJson = JSON.stringify({
        contentHash: "sha256:" + "c".repeat(64),
        initial: "run_agent",
        name: "single_agent_workflow",
        source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
        states: [],
        templateFiles: []
      });
      await writeFile(graphPath, graphJson);

      test.runStore.createRun({
        id: "run-graph-serve",
        issue: sampleIssue({ number: 90 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunEvidence("run-graph-serve", {
        branchName: "sym/run-graph-serve",
        branchRef: "refs/heads/sym/run-graph-serve",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        rawLogPath: "",
        workflowGraphPath: graphPath,
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request(
        "/logs/runs/run-graph-serve/workflow_graph"
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ name: "single_agent_workflow" });
    } finally {
      test.cleanup();
    }
  });

  it("serves the latest workflow graph artifact after a retry updates the run", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(
        test.stateRoot,
        "logs",
        "runs",
        "run-graph-retry"
      );
      await mkdir(evidenceDir, { recursive: true });
      const attempt1Path = path.join(evidenceDir, "workflow-graph.json");
      const attempt2Path = path.join(
        evidenceDir,
        "workflow-graph.attempt-2.json"
      );
      const attempt1Prompt = path.join(evidenceDir, "prompt.md");
      const attempt2Prompt = path.join(evidenceDir, "prompt.attempt-2.md");
      const attempt1Metadata = path.join(evidenceDir, "prompt-metadata.json");
      const attempt2Metadata = path.join(
        evidenceDir,
        "prompt-metadata.attempt-2.json"
      );
      const attempt1Snapshot = path.join(evidenceDir, "issue-snapshot.json");
      const attempt2Snapshot = path.join(
        evidenceDir,
        "issue-snapshot.attempt-2.json"
      );
      await writeFile(
        attempt1Path,
        JSON.stringify({
          contentHash: "sha256:" + "1".repeat(64),
          initial: "run_agent",
          name: "single_agent_workflow",
          source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
          states: [],
          templateFiles: []
        })
      );
      await writeFile(attempt1Prompt, "attempt 1 prompt\n");
      await writeFile(attempt2Prompt, "attempt 2 prompt\n");
      await writeFile(attempt1Metadata, JSON.stringify({ attempt: 1 }));
      await writeFile(attempt2Metadata, JSON.stringify({ attempt: 2 }));
      await writeFile(
        attempt1Snapshot,
        JSON.stringify({ number: 93, title: "attempt 1" })
      );
      await writeFile(
        attempt2Snapshot,
        JSON.stringify({ number: 93, title: "attempt 2" })
      );
      await writeFile(
        attempt2Path,
        JSON.stringify({
          contentHash: "sha256:" + "2".repeat(64),
          initial: "run_agent",
          name: "single_agent_workflow_v2",
          source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
          states: [],
          templateFiles: []
        })
      );

      test.runStore.createRun({
        id: "run-graph-retry",
        issue: sampleIssue({ number: 93 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      const baseAttempt = {
        branchName: "sym/run-graph-retry",
        branchRef: "refs/heads/sym/run-graph-retry",
        normalizedLogPath: "",
        providerCommand: "x",
        providerName: "codex" as const,
        rawLogPath: "",
        runId: "run-graph-retry",
        state: "running" as const,
        workspacePath: test.stateRoot
      };
      test.runStore.createAttempt({
        ...baseAttempt,
        attemptNumber: 1,
        id: "run-graph-retry-attempt-1",
        issueSnapshotPath: attempt1Snapshot,
        metadataPath: attempt1Metadata,
        promptPath: attempt1Prompt,
        workflowGraphPath: attempt1Path
      });
      test.runStore.createAttempt({
        ...baseAttempt,
        attemptNumber: 2,
        id: "run-graph-retry-attempt-2",
        issueSnapshotPath: attempt2Snapshot,
        metadataPath: attempt2Metadata,
        promptPath: attempt2Prompt,
        workflowGraphPath: attempt2Path
      });
      test.runStore.updateRunEvidence("run-graph-retry", {
        branchName: baseAttempt.branchName,
        branchRef: baseAttempt.branchRef,
        issueSnapshotPath: attempt2Snapshot,
        metadataPath: attempt2Metadata,
        normalizedLogPath: "",
        promptPath: attempt2Prompt,
        rawLogPath: "",
        workflowGraphPath: attempt2Path,
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const latest = await app.request(
        "/logs/runs/run-graph-retry/workflow_graph"
      );
      expect(latest.status).toBe(200);
      const latestBody = await latest.text();
      expect(JSON.parse(latestBody)).toMatchObject({
        name: "single_agent_workflow_v2"
      });

      const attempt1Response = await app.request(
        "/logs/runs/run-graph-retry/attempts/run-graph-retry-attempt-1/workflow_graph"
      );
      expect(attempt1Response.status).toBe(200);
      expect(JSON.parse(await attempt1Response.text())).toMatchObject({
        name: "single_agent_workflow"
      });
      const attempt1PromptResponse = await app.request(
        "/logs/runs/run-graph-retry/attempts/run-graph-retry-attempt-1/prompt"
      );
      expect(attempt1PromptResponse.status).toBe(200);
      expect(await attempt1PromptResponse.text()).toBe("attempt 1 prompt\n");
      const attempt1MetadataResponse = await app.request(
        "/logs/runs/run-graph-retry/attempts/run-graph-retry-attempt-1/prompt_metadata"
      );
      expect(attempt1MetadataResponse.status).toBe(200);
      expect(JSON.parse(await attempt1MetadataResponse.text())).toMatchObject({
        attempt: 1
      });
      const attempt1SnapshotResponse = await app.request(
        "/logs/runs/run-graph-retry/attempts/run-graph-retry-attempt-1/issue_snapshot"
      );
      expect(attempt1SnapshotResponse.status).toBe(200);
      expect(JSON.parse(await attempt1SnapshotResponse.text())).toMatchObject({
        title: "attempt 1"
      });

      const attempt2Response = await app.request(
        "/logs/runs/run-graph-retry/attempts/run-graph-retry-attempt-2/workflow_graph"
      );
      expect(attempt2Response.status).toBe(200);
      expect(JSON.parse(await attempt2Response.text())).toMatchObject({
        name: "single_agent_workflow_v2"
      });

      const wrongRun = await app.request(
        "/logs/runs/missing-run/attempts/run-graph-retry-attempt-1/workflow_graph"
      );
      expect(wrongRun.status).toBe(404);

      const wrongAttempt = await app.request(
        "/logs/runs/run-graph-retry/attempts/missing-attempt/workflow_graph"
      );
      expect(wrongAttempt.status).toBe(404);

      const wrongKind = await app.request(
        "/logs/runs/run-graph-retry/attempts/run-graph-retry-attempt-1/not_a_kind"
      );
      expect(wrongKind.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("does not expose per-attempt workflow graph filenames as log assets", async () => {
    const test = await setup();
    try {
      const evidenceDir = path.join(
        test.stateRoot,
        "logs",
        "runs",
        "run-graph-attempt"
      );
      await mkdir(evidenceDir, { recursive: true });
      const attemptGraphPath = path.join(
        evidenceDir,
        "workflow-graph.attempt-2.json"
      );
      await writeFile(
        attemptGraphPath,
        JSON.stringify({
          contentHash: "sha256:" + "d".repeat(64),
          initial: "run_agent",
          name: "single_agent_workflow",
          source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
          states: [],
          templateFiles: []
        })
      );

      test.runStore.createRun({
        id: "run-graph-attempt",
        issue: sampleIssue({ number: 91 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.createAttempt({
        attemptNumber: 2,
        branchName: "sym/run-graph-attempt",
        branchRef: "refs/heads/sym/run-graph-attempt",
        id: "run-graph-attempt-attempt-2",
        issueSnapshotPath: "",
        metadataPath: "",
        normalizedLogPath: "",
        promptPath: "",
        providerCommand: "x",
        providerName: "codex",
        rawLogPath: "",
        runId: "run-graph-attempt",
        state: "running",
        workflowGraphPath: attemptGraphPath,
        workspacePath: test.stateRoot
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request(
        "/logs/runs/run-graph-attempt/workflow-graph.attempt-2.json"
      );
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("returns 404 for an unknown workflow-graph attempt number", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-no-attempt",
        issue: sampleIssue({ number: 92 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request(
        "/logs/runs/run-no-attempt/workflow-graph.attempt-5.json"
      );
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("renders the run-detail page without the workflow graph block when no graph evidence exists", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-nograph",
        issue: sampleIssue({ number: 89, title: "Legacy run" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-nograph", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const runPage = await app.request("/runs/run-nograph");
      expect(runPage.status).toBe(200);
      const body = await runPage.text();
      expect(body).not.toContain("workflow-graph.json");
      expect(body).toContain("Legacy run");
    } finally {
      test.cleanup();
    }
  });

  it("shows the Run's current FSM state on the run-detail page even without workflow-graph evidence", async () => {
    const test = await setup();
    try {
      const issue = sampleIssue({
        number: 90,
        title: "Waiting on human input"
      });
      test.runStore.createRun({
        id: "waiting-nograph-parent",
        issue,
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("waiting-nograph-parent", "succeeded");
      test.runStore.createWaitingRun({
        currentStateId: "holding",
        id: "waiting-nograph",
        issue,
        parentRunId: "waiting-nograph-parent",
        projectName: "alpha"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const runPage = await app.request("/runs/waiting-nograph");
      expect(runPage.status).toBe(200);
      const body = await runPage.text();
      expect(body).not.toContain("workflow-graph.json");
      expect(body).toContain(
        "<dt>Current state</dt><dd><code>holding</code></dd>"
      );
    } finally {
      test.cleanup();
    }
  });

  it("renders stale issues on the dashboard with project and issue number", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        issuePollStatus: {
          candidateIssues: [],
          errors: [],
          filteredIssues: [
            {
              issue: sampleIssue({
                labels: ["agent-ready", "sym:claimed", "sym:stale"],
                number: 44,
                title: "Stale claim",
                url: "https://github.com/pmatos/symphonika/issues/44"
              }),
              project: "alpha",
              reasons: ["has operational label sym:stale"],
              repository: { owner: "pmatos", repo: "symphonika" }
            }
          ],
          projects: []
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("Stale issues");
      expect(body).toContain("alpha");
      expect(body).toContain("#44");
      expect(body).toContain("Stale claim");
    } finally {
      test.cleanup();
    }
  });

  it("shows a daemon-stale banner on the dashboard when the last tick is too old", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getLastTickAtMonotonic: () => 0,
        monotonicNow: () => 10 * 60_000, // 10 minutes since the last tick
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).toContain("banner--attention");
      expect(body).toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  it("shows a daemon-stale banner when monotonic time is stale after the wall clock steps backward", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getLastTickAt: () => 1_000_000,
        getLastTickAtMonotonic: () => 0,
        monotonicNow: () => 10 * 60_000,
        now: () => 500_000,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).toContain("banner--attention");
      expect(body).toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  it("shows no daemon-stale banner when monotonic time is recent after the wall clock steps forward", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getLastTickAt: () => 0,
        getLastTickAtMonotonic: () => 0,
        monotonicNow: () => 5_000,
        now: () => 10 * 60_000,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).not.toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  it("shows no daemon-stale banner when the last tick is recent", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getLastTickAtMonotonic: () => 0,
        monotonicNow: () => 5_000, // 5 seconds since the last tick
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).not.toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  it("shows no daemon-stale banner before the daemon has completed a first tick", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        monotonicNow: () => 10 * 60_000,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).not.toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  // Regression: if the very first scheduled tick hangs (e.g. stuck in issue
  // polling or reconciliation), the last-tick reference never gets set --
  // the dashboard
  // saw only that field and suppressed the banner indefinitely, even though
  // the systemd watchdog's own liveness gate (isTickRecentEnoughForSystemd-
  // Watchdog) already treats this exact case as eventually stale via a
  // tick-loop-start fallback. The dashboard must use the same fallback
  // so this failure mode is visible before the systemd watchdog eventually
  // restarts the unit, not just after.
  it("shows a daemon-stale banner when the tick loop started but the first tick never completed", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getPollingIntervalMs: () => 10 * 60_000,
        getTickLoopStartedAtMonotonic: () => 0,
        monotonicNow: () => 31 * 60_000, // past 3x the 10-minute interval
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).toContain("banner--attention");
      expect(body).toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  it("shows no daemon-stale banner while the first tick is still within its grace window", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getPollingIntervalMs: () => 10 * 60_000,
        getTickLoopStartedAtMonotonic: () => 0,
        monotonicNow: () => 8 * 60_000, // within 3x the 10-minute interval
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).not.toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  // Regression: polling.interval_ms has no configured upper bound, but the
  // stale banner's threshold used to be a fixed 5 minutes -- a healthy
  // daemon with a longer configured interval would show a permanent false
  // "may be unresponsive" banner between ticks. The threshold now scales
  // with the live polling interval (the same 3x bound already used by
  // isTickRecentEnoughForSystemdWatchdog), floored at the original 5 minutes so a
  // fast-polling daemon's grace period doesn't shrink.
  it("shows no daemon-stale banner when tick age is within the scaled polling-interval bound", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getLastTickAtMonotonic: () => 0,
        getPollingIntervalMs: () => 10 * 60_000,
        // 8 minutes: past the fixed 5-minute floor, but well within 3x a
        // 10-minute interval (30 minutes) -- a healthy daemon on this config.
        monotonicNow: () => 8 * 60_000,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).not.toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  it("shows a daemon-stale banner once tick age exceeds the scaled polling-interval bound", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        getLastTickAtMonotonic: () => 0,
        getPollingIntervalMs: () => 10 * 60_000,
        monotonicNow: () => 31 * 60_000, // past 3x the 10-minute interval
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(body).toContain("banner--attention");
      expect(body).toMatch(/daemon.*(stopped ticking|stale|unresponsive)/i);
    } finally {
      test.cleanup();
    }
  });

  it("renders a blocked run with the calmer blocked pill and banner, not the failed styling", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-blocked",
        issue: sampleIssue({ number: 271, title: "Declined, superseded" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.recordTerminalReason(
        "run-blocked",
        "no_workspace_changes",
        "deterministic"
      );
      test.runStore.updateRunState("run-blocked", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const detail = await app.request("/runs/run-blocked");
      expect(detail.status).toBe(200);
      const body = await detail.text();
      expect(body).toContain('pill pill--blocked"');
      expect(body).not.toContain('pill pill--fail"');
      expect(body).toContain("banner--blocked");
      expect(body).toContain("Run blocked");
      expect(body).toContain("no_workspace_changes");

      const runsList = await app.request("/runs?state=blocked");
      expect(runsList.status).toBe(200);
      const runsListBody = await runsList.text();
      expect(runsListBody).toContain("run-blocked");
      expect(runsListBody).toContain('pill pill--blocked"');
    } finally {
      test.cleanup();
    }
  });

  it("shows the watchdog idle badge on the dashboard and runs list only for idle active runs", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "idle-active",
        issue: sampleIssue({ number: 202, title: "Idle run" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("idle-active", "running");
      test.runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T11:45:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: "",
        outputTokensTotal: 0,
        runId: "idle-active",
        sampledAt: "2026-05-22T11:45:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: 0
      });

      test.runStore.createRun({
        id: "progressing-active",
        issue: sampleIssue({ number: 203, title: "Still progressing" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("progressing-active", "running");

      // A retry after a transient failure re-enters preparing_workspace and
      // clears the prior attempt's latest sample before the state is exposed.
      test.runStore.createRun({
        id: "retrying-preparing",
        issue: sampleIssue({ number: 204, title: "Retrying after failure" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("retrying-preparing", "running");
      test.runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T11:00:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: "prior-attempt.ndjson",
        outputTokensTotal: 0,
        runId: "retrying-preparing",
        sampledAt: "2026-05-22T11:00:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: 0
      });
      test.runStore.updateRunState("retrying-preparing", "failed");
      test.runStore.updateRunState("retrying-preparing", "preparing_workspace");

      const app = createHttpApp({
        getWatchdogConfig: () => ({
          enabled: true,
          graceMinutes: 30,
          maxRunMinutes: 0,
          outputTokenBudget: 0
        }),
        now: () => Date.parse("2026-05-22T12:00:00.000Z"),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const dashboardBody = await (await app.request("/")).text();
      const runsListBody = await (await app.request("/runs")).text();
      for (const body of [dashboardBody, runsListBody]) {
        const matches = body.match(/watchdog idle since/g) ?? [];
        expect(matches).toHaveLength(1);
        expect(body).toContain(
          'class="badge badge--watchdog">watchdog idle since 15m ago (15m remaining)</span>'
        );
        expect(body).toContain("idle-active");
        expect(body).toContain("progressing-active");
        expect(body).toContain("retrying-preparing");
      }

      const disabledApp = createHttpApp({
        getWatchdogConfig: () => ({
          enabled: false,
          graceMinutes: 30,
          maxRunMinutes: 0,
          outputTokenBudget: 0
        }),
        now: () => Date.parse("2026-05-22T12:00:00.000Z"),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const disabledDashboardBody = await (
        await disabledApp.request("/")
      ).text();
      expect(disabledDashboardBody).not.toContain("watchdog idle since");
    } finally {
      test.cleanup();
    }
  });

  it("renders the run-detail Watchdog section across not-yet-idle, idle, and terminated states", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "progressing-run",
        issue: sampleIssue({ number: 210, title: "Progressing" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("progressing-run", "running");
      test.runStore.upsertWatchdogSample({
        idleSince: null,
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T11:55:00.000Z",
        normalizedLogOffset: 0,
        normalizedLogPath: "progressing-run.ndjson",
        outputTokensTotal: 120,
        runId: "progressing-run",
        sampledAt: "2026-05-22T11:59:00.000Z",
        turnIdSetSize: 3,
        workspaceDigest: "",
        workspaceMtimeMax: Date.parse("2026-05-22T11:50:00.000Z")
      });

      const app = createHttpApp({
        getWatchdogConfig: () => ({
          enabled: true,
          graceMinutes: 30,
          maxRunMinutes: 0,
          outputTokenBudget: 0
        }),
        now: () => Date.parse("2026-05-22T12:00:00.000Z"),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const progressingBody = await (
        await app.request("/runs/progressing-run")
      ).text();
      expect(progressingBody).toContain("<h2>Watchdog</h2>");
      expect(progressingBody).toContain(
        "<dt>Last tool_call</dt><dd>5m ago</dd>"
      );
      expect(progressingBody).toContain(
        "<dt>Workspace mtime</dt><dd>10m ago</dd>"
      );
      expect(progressingBody).toContain("<dt>turn_ids observed</dt><dd>3</dd>");
      expect(progressingBody).toContain(
        "<dt>Output tokens / 5m</dt><dd>0</dd>"
      );
      expect(progressingBody).not.toContain("idle_since");
      expect(progressingBody).not.toContain("Grace remaining");

      test.runStore.createRun({
        id: "no-sample-run",
        issue: sampleIssue({ number: 213, title: "No sample yet" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("no-sample-run", "running");

      const noSampleBody = await (
        await app.request("/runs/no-sample-run")
      ).text();
      expect(noSampleBody).toContain("<h2>Watchdog</h2>");
      expect(noSampleBody).toContain("No sample yet");
      expect(noSampleBody).not.toContain("idle_since");
      expect(noSampleBody).not.toContain("Grace remaining");

      const dashboardBody = await (await app.request("/")).text();
      expect(dashboardBody).toContain("no-sample-run");
      expect(dashboardBody).not.toContain("watchdog idle since");

      test.runStore.createRun({
        id: "idle-run",
        issue: sampleIssue({ number: 211, title: "Idle within grace" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("idle-run", "running");
      test.runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T11:45:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T11:45:00.000Z",
        normalizedLogOffset: 0,
        normalizedLogPath: "idle-run.ndjson",
        outputTokensTotal: 0,
        runId: "idle-run",
        sampledAt: "2026-05-22T11:45:00.000Z",
        turnIdSetSize: 1,
        workspaceDigest: "",
        workspaceMtimeMax: Date.parse("2026-05-22T11:45:00.000Z")
      });

      const idleBody = await (await app.request("/runs/idle-run")).text();
      expect(idleBody).toContain(
        '<dt>idle_since</dt><dd><code><time datetime="2026-05-22T11:45:00.000Z" data-local-time>2026-05-22T11:45:00.000Z</time></code></dd>'
      );
      expect(idleBody).toContain("<dt>Grace remaining</dt><dd>15m</dd>");

      test.runStore.createRun({
        id: "terminated-run",
        issue: sampleIssue({ number: 212, title: "Terminated by watchdog" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("terminated-run", "running");
      test.runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T09:00:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T09:00:00.000Z",
        normalizedLogOffset: 0,
        normalizedLogPath: "terminated-run.ndjson",
        outputTokensTotal: 0,
        runId: "terminated-run",
        // A real watchdog reconciliation only fires once
        // `now - idleSince >= graceMinutes`, so a realistic terminal sample's
        // sampledAt sits just past idleSince + grace (09:30), not at
        // idleSince itself.
        sampledAt: "2026-05-22T09:31:00.000Z",
        turnIdSetSize: 1,
        workspaceDigest: "",
        workspaceMtimeMax: Date.parse("2026-05-22T09:00:00.000Z")
      });
      // updatedAt is deliberately set to a different timestamp than
      // sampledAt: runs.updated_at is not a safe "as of termination" anchor
      // (e.g. PR-discovery polling keeps bumping it for succeeded Runs), so
      // the Progress Signal must freeze at the last persisted watchdog
      // sample's sampledAt, not at updatedAt. This distinguishes the two.
      test.runStore.markRunNoProgressStale(
        "terminated-run",
        "2026-05-22T10:15:00.000Z"
      );

      const terminatedBody = await (
        await app.request("/runs/terminated-run")
      ).text();
      expect(terminatedBody).toContain(
        "<dt>Terminal reason</dt><dd><code>no_progress</code></dd>"
      );
      // The Progress Signal must freeze at the run's last watchdog sample
      // (09:31) rather than updatedAt (10:15) or the live app clock (12:00)
      // — otherwise these values would keep drifting on every reload long
      // after the Run terminated.
      expect(terminatedBody).toContain(
        "<dt>Last tool_call</dt><dd>31m ago</dd>"
      );
      expect(terminatedBody).toContain(
        "<dt>Workspace mtime</dt><dd>31m ago</dd>"
      );
      expect(terminatedBody).toContain(
        '<dt>idle_since</dt><dd><code><time datetime="2026-05-22T09:00:00.000Z" data-local-time>2026-05-22T09:00:00.000Z</time></code></dd>'
      );
      expect(terminatedBody).toContain("<dt>Grace remaining</dt><dd>-1m</dd>");

      // GET /api/runs/:id must report the exact same frozen watchdog values
      // as the HTML page for the same terminated Run — the two surfaces
      // must derive from one effective clock, not disagree with each other.
      const terminatedApiBody = (await (
        await app.request("/api/runs/terminated-run")
      ).json()) as {
        watchdog: {
          graceRemainingMs?: number;
          idleSince?: string;
        };
      };
      expect(terminatedApiBody.watchdog.idleSince).toBe(
        "2026-05-22T09:00:00.000Z"
      );
      expect(terminatedApiBody.watchdog.graceRemainingMs).toBe(-60_000);

      // A retry clears the prior attempt's latest Watchdog sample as it enters
      // preparing_workspace. Both detail surfaces report that attempt 2 has
      // no Progress Signal yet.
      test.runStore.createRun({
        id: "retrying-preparing-detail",
        issue: sampleIssue({
          number: 214,
          title: "Retrying, viewed on detail"
        }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("retrying-preparing-detail", "running");
      test.runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T08:55:00.000Z",
        lastMessageAt: null,
        lastProgressAt: null,
        lastToolCallAt: "2026-05-22T08:50:00.000Z",
        normalizedLogOffset: 0,
        normalizedLogPath: "prior-attempt.ndjson",
        outputTokensTotal: 0,
        runId: "retrying-preparing-detail",
        sampledAt: "2026-05-22T09:00:00.000Z",
        turnIdSetSize: 1,
        workspaceDigest: "",
        workspaceMtimeMax: Date.parse("2026-05-22T08:50:00.000Z")
      });
      test.runStore.updateRunState("retrying-preparing-detail", "failed");
      test.runStore.updateRunState(
        "retrying-preparing-detail",
        "preparing_workspace"
      );

      const preparingBody = await (
        await app.request("/runs/retrying-preparing-detail")
      ).text();
      expect(preparingBody).toContain("<strong>No sample yet</strong>");
      expect(preparingBody).not.toContain("<dt>Last tool_call</dt>");
      expect(preparingBody).not.toContain("<dt>idle_since</dt>");

      const preparingApiBody = (await (
        await app.request("/api/runs/retrying-preparing-detail")
      ).json()) as {
        watchdog: {
          graceMs: number;
          graceRemainingMs?: number;
          idleSince?: string;
          sampledAt?: string;
        };
      };
      expect(preparingApiBody.watchdog).toEqual({
        enabled: true,
        graceMs: 1_800_000,
        maxRunMs: 0,
        outputTokenBudget: 0
      });

      const disabledApp = createHttpApp({
        getWatchdogConfig: () => ({
          enabled: false,
          graceMinutes: 30,
          maxRunMinutes: 0,
          outputTokenBudget: 0
        }),
        now: () => Date.parse("2026-05-22T12:00:00.000Z"),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const disabledBody = await (
        await disabledApp.request("/runs/idle-run")
      ).text();
      expect(disabledBody).not.toContain("<h2>Watchdog</h2>");
    } finally {
      test.cleanup();
    }
  });
});

describe("HTTP app — dashboard IA shell (#302)", () => {
  it("lists in-flight Runs and Routine Firings in the active-now band, labelled by kind, and excludes waiting Runs", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-running",
        issue: sampleIssue({ number: 11, title: "In flight" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-running", "running");

      test.runStore.createRun({
        id: "run-waiting",
        issue: sampleIssue({ number: 12, title: "Parked for review" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-waiting", "waiting");

      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "refactor-audit",
          prompt: "Audit.",
          provider: null,
          projectName: "beta",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/refactor-audit.md"
        }
      ]);
      test.runStore.createRoutineFiring({
        id: "fire-running",
        projectName: "beta",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "refactor-audit"
      });
      test.runStore.updateRoutineFiringState("fire-running", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/")).text();

      expect(body).toContain("Active now");
      expect(body).toContain('<span class="count">2</span>');
      expect(body).toContain('<h3 class="subhead">Runs</h3>');
      expect(body).toContain("run-running");
      expect(body).toContain('<h3 class="subhead">Routine firings</h3>');
      expect(body).toContain("refactor-audit");
      expect(body).toContain("beta");
      // A waiting Run is parked for external state, not "happening right
      // now" — it must not appear in the band, only on /runs.
      expect(body).not.toContain("run-waiting");
      const runsListBody = await (await app.request("/runs")).text();
      expect(runsListBody).toContain("run-waiting");
    } finally {
      test.cleanup();
    }
  });

  it("shows a domain-teaching empty state when nothing is active", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/")).text();

      expect(body).toContain("Active now");
      expect(body).toContain("Nothing running right now");
      expect(body).toContain(
        "Active means queued, preparing its workspace, or running."
      );
    } finally {
      test.cleanup();
    }
  });

  it("renders an N-target Routine as one row with a target count linking to its page", async () => {
    const test = await setup();
    try {
      const declaration = {
        kind: "report" as const,
        name: "refactor-audit",
        prompt: "Audit.",
        provider: null,
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: "/tmp/refactor-audit.md"
      };
      test.runStore.syncRoutines([
        { ...declaration, projectName: "alpha" },
        { ...declaration, projectName: "beta" },
        { ...declaration, projectName: "gamma" }
      ]);

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/")).text();

      // The routine name link contributes it twice (href + link text); the
      // target-count link's href contributes a third — one row, not three.
      expect(body.match(/refactor-audit/g)).toHaveLength(3);
      expect(body).toContain('<a href="/routines/refactor-audit">3</a>');
    } finally {
      test.cleanup();
    }
  });

  it("splits Projects into Dispatch Projects and a subdued Routine Hosts group", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-alpha",
        issue: sampleIssue({ number: 21, title: "Working" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-alpha", "running");

      // A Routine Host has no Runs, only Routine Firings — but a Firing
      // consumes the same in-flight capacity slot (ADR 0053/0069), so it
      // must still show up as "in-flight" for the host.
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: null,
          projectName: "s11-host",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);
      test.runStore.createRoutineFiring({
        id: "fire-s11",
        projectName: "s11-host",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });
      test.runStore.updateRoutineFiringState("fire-s11", "running");

      function projectState(
        overrides: Partial<
          ReturnType<RunStore["listProjectStates"]>[number]
        > = {}
      ): ReturnType<RunStore["listProjectStates"]>[number] {
        return {
          active: true,
          createdAt: "2026-05-22T10:00:00.000Z",
          lastCandidateIssues: 0,
          lastDispatchedAt: null,
          lastDispatchedIssueNumber: null,
          lastFetchedIssues: 0,
          lastFilteredIssues: 0,
          lastPollError: null,
          lastPollFinishedAt: null,
          lastPollOk: null,
          lastPollStartedAt: null,
          lastSuccessfulPollAt: null,
          projectName: "alpha",
          schedulerCurrentWeight: 0,
          updatedAt: "2026-05-22T10:00:00.000Z",
          validationMessage: null,
          validationState: "valid",
          weight: 1,
          ...overrides
        };
      }

      const app = createHttpApp({
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [
              {
                issue: sampleIssue({ number: 22 }),
                project: "alpha",
                repository: { owner: "pmatos", repo: "symphonika" }
              }
            ],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([
            ["alpha", "dispatch"],
            ["s11-host", "routine_host"]
          ]),
          projectStates: [
            projectState({ projectName: "alpha" }),
            projectState({ projectName: "s11-host" })
          ],
          projects: [],
          reload: {
            errors: [],
            lastAttemptedAt: null,
            lastLoadedAt: null,
            ok: true,
            routineErrors: [],
            usingLastKnownGood: false
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/")).text();

      const projectsIndex = body.indexOf(">Projects<");
      const hostsIndex = body.indexOf(">Routine hosts<");
      expect(projectsIndex).toBeGreaterThan(-1);
      expect(hostsIndex).toBeGreaterThan(projectsIndex);
      expect(body).toContain('class="subdued"');
      expect(body).toContain("alpha");
      expect(body).toContain("s11-host");
      // Dispatch Projects carries eligible/in-flight counts sourced from
      // issue polling and the active-now query. Routine Hosts never
      // dispatch, so "Eligible" is dropped there, but "In-flight" stays —
      // a Host has no Runs, only Routine Firings, and a Firing consumes the
      // same in-flight capacity slot.
      const dispatchSection = body.slice(projectsIndex, hostsIndex);
      expect(dispatchSection).toContain("<th>Eligible</th>");
      expect(dispatchSection).toContain("<th>In-flight</th>");
      const hostsSection = body.slice(hostsIndex);
      expect(hostsSection).not.toContain("<th>Eligible</th>");
      expect(hostsSection).toContain("<th>In-flight</th>");
      expect(hostsSection).toMatch(
        /<tr><td><a href="\/projects\/s11-host">s11-host<\/a><\/td><td>.*?<\/td><td>1<\/td><\/tr>/
      );
    } finally {
      test.cleanup();
    }
  });

  it("keeps the last-run age anchored to terminal completion across PR-discovery retries", async () => {
    const test = await setup();
    try {
      vi.useFakeTimers();
      vi.setSystemTime("2026-05-22T10:00:00.000Z");
      test.runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);
      test.runStore.createRun({
        id: "run-terminal-age",
        issue: sampleIssue({ number: 23, title: "Completed earlier" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-terminal-age", "succeeded");

      vi.setSystemTime("2026-05-22T11:00:00.000Z");
      test.runStore.recordPullRequestDiscoveryAttempt("run-terminal-age");

      const app = createHttpApp({
        getStatusSnapshot: () =>
          buildStatusSnapshot({
            configPath: "/tmp/symphonika.yml",
            issuePollStatus: emptyIssuePollStatus(),
            runStore: test.runStore,
            stateRoot: test.stateRoot
          }),
        now: () => Date.parse("2026-05-22T12:00:00.000Z"),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/")).text();

      // Anchored on alpha's own row so the age cell is matched directly,
      // rather than asserting over a hand-bounded slice of the page.
      expect(body).toMatch(
        /<a href="\/projects\/alpha">alpha<\/a>.*?<code>2h ago<\/code>/
      );
    } finally {
      vi.useRealTimers();
      test.cleanup();
    }
  });
});

describe("HTTP app — project detail page (#303)", () => {
  it("404s for an unconfigured Project name", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/projects/nope");
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("keeps the next-poll ETA anchored to the periodic timer after a manual poll", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      // A manual poll just completed, nine minutes into a ten-minute
      // automatic interval. It refreshes poll evidence but does not reset
      // the periodic timer, whose next trigger remains one minute away.
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 0,
        fetchedIssues: 0,
        filteredIssues: 0,
        ok: true,
        projectName: "alpha"
      });
      const nowMs = Date.now();

      const app = createHttpApp({
        getNextPollAtMonotonic: () => 10 * 60_000,
        getPollingIntervalMs: () => 10 * 60_000,
        monotonicNow: () => 9 * 60_000,
        now: () => nowMs,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain(
        '<span class="k">next poll</span><span class="v">in 1m</span>'
      );
    } finally {
      test.cleanup();
    }
  });

  it("keeps pre-restart snapshot freshness after a poll fails", async () => {
    const test = await setup();
    vi.useFakeTimers();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);

      vi.setSystemTime(new Date("2026-08-21T10:00:00.000Z"));
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 1,
        fetchedIssues: 1,
        filteredIssues: 0,
        ok: true,
        projectName: "alpha"
      });

      const startedAtMs = Date.parse("2026-08-21T10:01:00.000Z");
      const failedPollAtMs = Date.parse("2026-08-21T10:02:00.000Z");
      vi.setSystemTime(failedPollAtMs);
      test.runStore.recordProjectPollOutcome({
        candidateIssues: 0,
        error: "tracker unavailable",
        fetchedIssues: 0,
        filteredIssues: 0,
        ok: false,
        projectName: "alpha"
      });

      const app = createHttpApp({
        now: () => failedPollAtMs,
        runStore: test.runStore,
        startedAtMs,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain(
        '<span class="k">poll</span><span class="v">2m ago <span class="muted">(pre-restart)</span></span>'
      );
      expect(body).toContain("tracker unavailable");
      expect(body).toContain("failing");
    } finally {
      vi.useRealTimers();
      test.cleanup();
    }
  });

  it("links each issue number to its Issue detail page", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedBy: [],
            blockedByTruncated: false,
            issueNumber: 286,
            kind: "candidate",
            labels: ["agent-ready"],
            priority: 1,
            reasons: [],
            title: "Eligible issue"
          }
        ]
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain('<a href="/issues/alpha/286">#286</a>');
      // The "Edit labels" note follows the Issues section for both the
      // populated and empty-state branches, not just one of them.
      expect(body).toContain(
        '<p class="note"><a href="/issues?project=alpha">Edit labels →</a></p>'
      );
    } finally {
      test.cleanup();
    }
  });

  it("offers project-filtered label editing from the Issues section", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain(
        '<p class="note"><a href="/issues?project=alpha">Edit labels →</a></p>'
      );
    } finally {
      test.cleanup();
    }
  });

  it("renders the capacity strip and every issue-keyed row bucket with its reason, for a Dispatch Project", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedByTruncated: false,
            blockedBy: [],
            issueNumber: 286,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Eligible issue"
          },
          {
            blockedByTruncated: false,
            blockedBy: [],
            issueNumber: 231,
            kind: "filtered",
            labels: ["needs-human"],
            priority: 1,
            reasons: ["needs-human"],
            title: "Filtered issue"
          }
        ]
      });

      test.runStore.createRun({
        id: "run-running",
        issue: sampleIssue({ number: 291, title: "Running issue" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-running", "running");

      test.runStore.createRun({
        id: "run-waiting",
        issue: sampleIssue({ number: 285, title: "Waiting issue" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-waiting", "waiting");

      test.runStore.createRun({
        id: "run-blocked",
        issue: sampleIssue({ number: 279, title: "Blocked issue" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-blocked", "blocked");

      test.runStore.createRun({
        id: "run-succeeded",
        issue: sampleIssue({ number: 259, title: "Succeeded issue" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-succeeded", "succeeded");
      test.runStore.trackPullRequest({
        branchName: "sym/259",
        headSha: "abc123",
        issueNumber: 259,
        prNumber: 248,
        prUrl: "https://github.com/pmatos/symphonika/pull/248",
        projectName: "alpha",
        runId: "run-succeeded"
      });

      const app = createHttpApp({
        getConcurrency: () => ({
          global: { inFlight: 1, maxInFlight: null },
          perProject: [{ inFlight: 1, maxInFlight: 2, projectName: "alpha" }]
        }),
        getScheduled: () => [
          {
            dueAt: Date.now() + 3 * 60_000,
            issueNumber: 285,
            kind: "wait_park",
            projectName: "alpha",
            runId: "run-waiting"
          }
        ],
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["alpha", "dispatch"]]),
          projectStates: test.runStore.listProjectStates(),
          projects: [],
          reload: {
            errors: [],
            lastAttemptedAt: null,
            lastLoadedAt: null,
            ok: true,
            routineErrors: [],
            usingLastKnownGood: false
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      // Eligible: a candidate snapshot row with no Run yet.
      expect(body).toContain("Eligible issue");
      expect(body).toMatch(/#286[\s\S]{0,200}eligible/);
      // Filtered: excluded-label reason carried into the detail column.
      expect(body).toContain("Filtered issue");
      expect(body).toContain("needs-human");
      // Running: the Run's own state pill, with an attempt/duration detail.
      expect(body).toContain("Running issue");
      expect(body).toContain("attempt 1");
      // Waiting: retry ETA sourced from the scheduled wait_park callback.
      expect(body).toContain("Waiting issue");
      expect(body).toContain("recheck");
      // Blocked: the Run's own blocked pill.
      expect(body).toContain("Blocked issue");
      // Terminal: succeeded, with the tracked PR surfaced in the detail.
      expect(body).toContain("Succeeded issue");
      expect(body).toContain("PR #248 open");
      // The capacity strip is present and load-bearing.
      expect(body).toContain('class="capacity-strip"');
      expect(body).toContain("1/2");
    } finally {
      test.cleanup();
    }
  });

  it("shows a capped Project's eligible issue as capped, not idle", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedByTruncated: false,
            blockedBy: [],
            issueNumber: 300,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Blocked behind cap"
          }
        ]
      });
      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-a", "running");
      test.runStore.createRun({
        id: "run-b",
        issue: sampleIssue({ number: 2 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-b", "running");

      const app = createHttpApp({
        getConcurrency: () => ({
          global: { inFlight: 2, maxInFlight: null },
          perProject: [{ inFlight: 2, maxInFlight: 2, projectName: "alpha" }]
        }),
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["alpha", "dispatch"]]),
          projectStates: test.runStore.listProjectStates(),
          projects: [],
          reload: {
            errors: [],
            lastAttemptedAt: null,
            lastLoadedAt: null,
            ok: true,
            routineErrors: [],
            usingLastKnownGood: false
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain("queued behind cap (2/2)");
    } finally {
      test.cleanup();
    }
  });

  it("shows an eligible issue as capped when the global concurrency cap is full", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.replaceProjectIssueSnapshots({
        polledAt: "2026-05-22T10:00:00.000Z",
        projectName: "alpha",
        rows: [
          {
            blockedByTruncated: false,
            blockedBy: [],
            issueNumber: 301,
            kind: "candidate",
            labels: [],
            priority: 1,
            reasons: [],
            title: "Blocked behind global cap"
          }
        ]
      });
      const app = createHttpApp({
        getConcurrency: () => ({
          global: { inFlight: 2, maxInFlight: 2 },
          perProject: [{ inFlight: 0, maxInFlight: 2, projectName: "alpha" }]
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain("queued behind global cap (2/2)");
    } finally {
      test.cleanup();
    }
  });

  it("shows a blocked Run's terminalReason as its detail, not a blank cell", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      test.runStore.createRun({
        id: "run-blocked",
        issue: sampleIssue({ number: 400, title: "Blocked by workflow" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      // Mirrors lifecycle/run-controller.ts's own
      // `recordTerminalReason(runId, "workflow_terminal_blocked", ...)`
      // followed by `updateRunState(runId, "blocked")` — a blocked Run's
      // reason lives in terminalReason, not stateTransitionReason.
      test.runStore.recordTerminalReason(
        "run-blocked",
        "workflow_terminal_blocked",
        "deterministic"
      );
      test.runStore.updateRunState("run-blocked", "blocked");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain("Blocked by workflow");
      expect(body).toContain("workflow_terminal_blocked");
    } finally {
      test.cleanup();
    }
  });

  it("shows an issue closed since the last poll — a Run but no snapshot row — as terminal", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "alpha", validationState: "valid", weight: 1 }
      ]);
      // No replaceProjectIssueSnapshots call: this issue never has a
      // snapshot row, matching "closed since the last poll."
      test.runStore.createRun({
        id: "run-closed",
        issue: sampleIssue({ number: 900, title: "Closed since last poll" }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-closed", "succeeded");

      const app = createHttpApp({
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["alpha", "dispatch"]]),
          projectStates: test.runStore.listProjectStates(),
          projects: [],
          reload: {
            errors: [],
            lastAttemptedAt: null,
            lastLoadedAt: null,
            ok: true,
            routineErrors: [],
            usingLastKnownGood: false
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/alpha")).text();

      expect(body).toContain("Closed since last poll");
      expect(body).toContain("succeeded");
      // The row still renders (with a plain, unlinked issue number) --
      // /issues/:project/:number only resolves snapshot-backed issues, and
      // this one has no snapshot row, so linking it would 404.
      expect(body).toContain("#900");
      expect(body).not.toContain('href="/issues/alpha/900"');
    } finally {
      test.cleanup();
    }
  });

  it("shows a Routine Host's firings and explains the absence of issue work", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([
        { name: "s11-host", validationState: "valid", weight: 1 }
      ]);
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: null,
          projectName: "s11-host",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);
      test.runStore.createRoutineFiring({
        id: "fire-s11",
        projectName: "s11-host",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });
      test.runStore.updateRoutineFiringState("fire-s11", "running");

      const app = createHttpApp({
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["s11-host", "routine_host"]]),
          projectStates: test.runStore.listProjectStates(),
          projects: [],
          reload: {
            errors: [],
            lastAttemptedAt: null,
            lastLoadedAt: null,
            ok: true,
            routineErrors: [],
            usingLastKnownGood: false
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/projects/s11-host")).text();

      expect(body).toContain("No issues — this is a Routine Host");
      expect(body).toContain("audit");
      expect(body).not.toContain(
        'class="capacity-strip"><span class="kv"><span class="k">in-flight</span><span class="v">1/'
      );
    } finally {
      test.cleanup();
    }
  });
});

describe("HTTP app — routine detail page (#304)", () => {
  it("404s for an unknown Routine name", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/routines/nope");
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("shows an inactive Routine only when include_inactive is requested", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);
      test.runStore.markRoutinesInactiveForProject("alpha");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const hiddenResponse = await app.request("/routines/audit");
      const includedResponse = await app.request(
        "/routines/audit?include_inactive=true"
      );
      const includedBody = await includedResponse.text();

      expect(hiddenResponse.status).toBe(404);
      expect(includedResponse.status).toBe(200);
      expect(includedBody).toContain(
        'aria-hidden="true"></span>inactive</span>'
      );
    } finally {
      test.cleanup();
    }
  });

  it("shows the declaration, prompt, per-target row, skip counters, and firing history for a single-target Routine", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          allowOverlap: true,
          catchUp: "fire_once_if_missed",
          kind: "report",
          name: "audit",
          prompt: "Audit the codebase for smells.",
          provider: "codex",
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);
      test.runStore.createRoutineFiring({
        id: "fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });
      test.runStore.updateRoutineFiringState("fire-1", "succeeded");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/audit")).text();

      expect(body).toContain("Audit the codebase for smells.");
      expect(body).toContain("report");
      expect(body).toContain("codex");
      expect(body).toContain("2026-05-22T10:00:00.000Z");
      expect(body).toContain(">yes<"); // allow overlap
      expect(body).toContain("fire_once_if_missed");
      expect(body).toContain("/tmp/audit.md");
      expect(body).toContain("alpha");
      expect(body).toContain("overlap 0 · cap 0 · pressure 0 · catch-up 0");
      expect(body).toContain("fire-1");
      expect(body).toContain("single");
      expect(body).toContain('href="/routines/audit/edit"');
      expect(body).toContain('action="/api/routines/audit/fire?project=alpha"');
    } finally {
      test.cleanup();
    }
  });

  it("shows a reload error while keeping the last-known-good Routine declaration active", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Last-known-good prompt.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);

      const app = createHttpApp({
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["alpha", "dispatch"]]),
          projectStates: [],
          projects: [],
          reload: {
            errors: [
              'routine "audit" at /tmp/audit.md declares model, but providers.claude.command never references it'
            ],
            lastAttemptedAt: "2026-05-22T09:00:00.000Z",
            lastLoadedAt: "2026-05-22T08:00:00.000Z",
            ok: false,
            routineErrors: [
              {
                message:
                  'routine "audit" at /tmp/audit.md declares model, but providers.claude.command never references it',
                sourcePaths: ["/tmp/audit.md"]
              }
            ],
            usingLastKnownGood: true
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/audit")).text();

      expect(body).toContain(
        '<div class="alert" role="alert"><strong>Reload error</strong><ul><li>routine &quot;audit&quot; at /tmp/audit.md declares model, but providers.claude.command never references it</li></ul></div>'
      );
      expect(body).toContain("Last-known-good prompt.");
    } finally {
      test.cleanup();
    }
  });

  it("shows a reload error keyed by source path, not by routine name", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "weekly-audit",
          prompt: "Last-known-good prompt.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/r1.md"
        }
      ]);

      const app = createHttpApp({
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["alpha", "dispatch"]]),
          projectStates: [],
          projects: [],
          reload: {
            errors: ["routine at /tmp/r1.md prompt body must not be empty"],
            lastAttemptedAt: "2026-05-22T09:00:00.000Z",
            lastLoadedAt: "2026-05-22T08:00:00.000Z",
            ok: false,
            routineErrors: [
              {
                message: "routine at /tmp/r1.md prompt body must not be empty",
                sourcePaths: ["/tmp/r1.md"]
              }
            ],
            usingLastKnownGood: true
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/weekly-audit")).text();

      expect(body).toContain(
        '<div class="alert" role="alert"><strong>Reload error</strong><ul><li>routine at /tmp/r1.md prompt body must not be empty</li></ul></div>'
      );
      expect(body).toContain("Last-known-good prompt.");
    } finally {
      test.cleanup();
    }
  });

  it("does not show another declaration's reload error on this Routine's page", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "git",
          prompt: "Last-known-good prompt.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/git.md"
        }
      ]);

      const app = createHttpApp({
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["alpha", "dispatch"]]),
          projectStates: [],
          projects: [],
          reload: {
            errors: ["routine at /tmp/other.md kind must be git or report"],
            lastAttemptedAt: "2026-05-22T09:00:00.000Z",
            lastLoadedAt: "2026-05-22T08:00:00.000Z",
            ok: false,
            routineErrors: [
              {
                message: "routine at /tmp/other.md kind must be git or report",
                sourcePaths: ["/tmp/other.md"]
              }
            ],
            usingLastKnownGood: true
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/git")).text();

      expect(body).toContain("Last-known-good prompt.");
      expect(body).not.toContain("Reload error");
    } finally {
      test.cleanup();
    }
  });

  it("does not match a reload error from a declaration whose path extends this Routine's path", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Last-known-good prompt.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/r1"
        }
      ]);

      const app = createHttpApp({
        getStatusSnapshot: () => ({
          configPath: "/tmp/symphonika.yml",
          doctorErrors: [],
          issuePolling: {
            candidateIssues: [],
            errors: [],
            filteredIssues: [],
            projects: []
          },
          projectModes: new Map([["alpha", "dispatch"]]),
          projectStates: [],
          projects: [],
          reload: {
            errors: ["routine at /tmp/r10 prompt body must not be empty"],
            lastAttemptedAt: "2026-05-22T09:00:00.000Z",
            lastLoadedAt: "2026-05-22T08:00:00.000Z",
            ok: false,
            routineErrors: [
              {
                message: "routine at /tmp/r10 prompt body must not be empty",
                sourcePaths: ["/tmp/r10"]
              }
            ],
            usingLastKnownGood: true
          },
          runs: { active: [], failed: [], recent: [], stale: [] },
          stateRoot: test.stateRoot
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/audit")).text();

      expect(body).toContain("Last-known-good prompt.");
      expect(body).not.toContain("Reload error");
    } finally {
      test.cleanup();
    }
  });

  it("shows sibling firings from one clock event as one event, not N unrelated rows", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        },
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: null,
          projectName: "beta",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);
      test.runStore.createRoutineFiring({
        fanoutId: "fanout-1",
        id: "fire-alpha",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });
      test.runStore.createRoutineFiring({
        fanoutId: "fanout-1",
        id: "fire-beta",
        projectName: "beta",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/audit")).text();

      const firingHistoryIndex = body.indexOf(">Firing history<");
      const historySection = body.slice(firingHistoryIndex);
      expect(historySection.match(/fan-out · 2 targets/g)).toHaveLength(2);
      expect(historySection).toContain("fire-alpha");
      expect(historySection).toContain("fire-beta");
    } finally {
      test.cleanup();
    }
  });

  it("shows an operator-disabled target's disabled_reason", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          disabled: true,
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/audit")).text();

      expect(body).toContain("operator");
    } finally {
      test.cleanup();
    }
  });

  it("shows an invalid target's stub state without losing a sibling target's real schedule and prompt", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Real prompt body.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);
      // A second target for the same (name, sourcePath) declaration that
      // failed reload — upsertInvalidRoutineStub's placeholder row has
      // prompt_body/schedule_at = ''. Sharing sourcePath is what keeps it
      // in the same group as "alpha" rather than groupRoutinesByName's
      // stale-name-reuse case.
      test.runStore.upsertInvalidRoutineStub({
        name: "audit",
        projectName: "beta",
        sourcePath: "/tmp/audit.md"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/routines/audit")).text();

      // The group's declaration card must resolve from "alpha" (the real
      // target), not blank out because "beta" is invalid and alphabetically
      // first.
      expect(body).toContain("Real prompt body.");
      expect(body).toContain("2026-05-22T10:00:00.000Z");
      // Both targets still appear in the per-target table.
      expect(body).toContain("alpha");
      expect(body).toContain("beta");
      expect(body).toContain("invalid");
    } finally {
      test.cleanup();
    }
  });

  it("lists a disambiguation page when two unrelated declarations share a name, resolved by ?project=", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Old declaration.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/old-audit.md"
        }
      ]);
      // Remove it from config (soft-disables to disabled_reason
      // 'removed_from_config', not 'inactive' — still visible by default)
      // and declare an unrelated Routine reusing the same name for a
      // different Project.
      test.runStore.syncRoutines(
        [
          {
            kind: "report",
            name: "audit",
            prompt: "New declaration.",
            provider: null,
            projectName: "gamma",
            schedule: { at: "2026-05-22T11:00:00.000Z" },
            sourcePath: "/tmp/new-audit.md"
          }
        ],
        { projects: ["alpha", "gamma"] }
      );

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const disambigBody = await (await app.request("/routines/audit")).text();
      expect(disambigBody).toContain("Multiple declarations share this name");
      expect(disambigBody).toContain("/tmp/old-audit.md");
      expect(disambigBody).toContain("/tmp/new-audit.md");

      const gammaBody = await (
        await app.request("/routines/audit?project=gamma")
      ).text();
      expect(gammaBody).toContain("New declaration.");
      expect(gammaBody).not.toContain("Old declaration.");

      const alphaBody = await (
        await app.request("/routines/audit?project=alpha")
      ).text();
      expect(alphaBody).toContain("removed_from_config");
    } finally {
      test.cleanup();
    }
  });

  it("keeps the inactive opt-in in disambiguation links", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Old declaration.",
          provider: null,
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/old-audit.md"
        }
      ]);
      test.runStore.syncRoutines(
        [
          {
            kind: "report",
            name: "audit",
            prompt: "New declaration.",
            provider: null,
            projectName: "gamma",
            schedule: { at: "2026-05-22T11:00:00.000Z" },
            sourcePath: "/tmp/new-audit.md"
          }
        ],
        { projects: ["alpha", "gamma"] }
      );
      test.runStore.markRoutinesInactiveForProject("alpha");
      test.runStore.markRoutinesInactiveForProject("gamma");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (
        await app.request("/routines/audit?include_inactive=true")
      ).text();

      expect(body).toContain(
        "/routines/audit?project=alpha&amp;include_inactive=true"
      );
      expect(body).toContain(
        "/routines/audit?project=gamma&amp;include_inactive=true"
      );
    } finally {
      test.cleanup();
    }
  });
});

describe("HTTP app — firing detail page (#304 part 2/2)", () => {
  it("404s for an unknown firing id", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/firings/nope");
      expect(response.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });

  it("shows summary, transitions, coalesced events, PR association, and file links, sourced from evidence on disk", async () => {
    const test = await setup();
    try {
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
      test.runStore.updateRoutineFiringState("fire-1", "running");
      test.runStore.updateRoutineFiringState("fire-1", "succeeded");
      test.runStore.recordRoutinePullRequest({
        firingId: "fire-1",
        headSha: "abc123",
        prNumber: 248,
        projectName: "alpha",
        routineName: "audit"
      });

      const evidence = routineEvidencePaths(test.stateRoot, "fire-1");
      await mkdir(evidence.directory, { recursive: true });
      await writeFile(evidence.promptPath, "# Prompt\nDo the audit.", "utf8");
      await writeFile(
        evidence.promptMetadataPath,
        JSON.stringify({ model: "codex" }),
        "utf8"
      );
      await writeFile(
        evidence.normalizedLogPath,
        [
          JSON.stringify({ type: "message", message: "Hello " }),
          JSON.stringify({ type: "message", message: "world." }),
          JSON.stringify({ command: "ls", tool: "bash", type: "tool_call" })
        ].join("\n") + "\n",
        "utf8"
      );
      await writeFile(evidence.rawLogPath, "{}\n", "utf8");
      await writeFile(evidence.stderrLogPath, "codex: retrying\n", "utf8");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/firings/fire-1")).text();

      expect(body).toContain('<a href="/routines/audit">audit</a>');
      expect(body).toContain("alpha");
      expect(body).toContain("sym/audit-fire-1");
      expect(body).toContain("no per-run workflow graph");
      expect(body).toContain("State transitions");
      expect(body).toContain("Hello world.");
      expect(body).toContain("tool_call");
      expect(body).toContain("PR #248");
      expect(body).toContain("not a PR Follow-up");
      // fire-1 is in a terminal state (succeeded) -- no cancel form for it.
      expect(body).not.toContain("Cancel firing");
      expect(body).toContain("/logs/firings/fire-1/prompt");
      expect(body).toContain("/logs/firings/fire-1/prompt_metadata");
      expect(body).toContain("/logs/firings/fire-1/provider_raw");
      expect(body).toContain("/logs/firings/fire-1/provider_normalized");
      expect(body).toContain("/logs/firings/fire-1/provider_stderr");
    } finally {
      test.cleanup();
    }
  });

  it("shows a failed firing's terminal reason as legibly as a failed Run's", async () => {
    const test = await setup();
    try {
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
      test.runStore.createRoutineFiring({
        id: "fire-failed",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });
      test.runStore.completeRoutineFiring({
        id: "fire-failed",
        state: "failed",
        terminalReason: "provider_exit_nonzero"
      });

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const body = await (await app.request("/firings/fire-failed")).text();

      expect(body).toContain("Terminal reason");
      expect(body).toContain("provider_exit_nonzero");
    } finally {
      test.cleanup();
    }
  });

  it("streams a present evidence file and 404s a missing one", async () => {
    const test = await setup();
    try {
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
      test.runStore.createRoutineFiring({
        id: "fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });
      const evidence = routineEvidencePaths(test.stateRoot, "fire-1");
      await mkdir(evidence.directory, { recursive: true });
      await writeFile(evidence.promptPath, "# Prompt\nDo it.", "utf8");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const present = await app.request("/logs/firings/fire-1/prompt");
      expect(present.status).toBe(200);
      expect(present.headers.get("content-type")).toContain("text/markdown");
      expect(await present.text()).toContain("Do it.");

      await writeFile(evidence.stderrLogPath, "codex: boom\n", "utf8");
      const stderrLog = await app.request(
        "/logs/firings/fire-1/provider_stderr"
      );
      expect(stderrLog.status).toBe(200);
      expect(stderrLog.headers.get("content-type")).toContain("text/plain");
      expect(await stderrLog.text()).toBe("codex: boom\n");

      const missing = await app.request("/logs/firings/fire-1/provider_raw");
      expect(missing.status).toBe(404);

      const unknownFiring = await app.request("/logs/firings/nope/prompt");
      expect(unknownFiring.status).toBe(404);

      const unknownKind = await app.request(
        "/logs/firings/fire-1/workflow_graph"
      );
      expect(unknownKind.status).toBe(404);
    } finally {
      test.cleanup();
    }
  });
});
