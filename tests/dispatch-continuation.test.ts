import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import {
  ActiveRunRegistry,
  type LifecyclePolicy
} from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cont-test-"));
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

const baseIssue = {
  body: "issue body",
  created_at: "2026-04-20T10:00:00Z",
  html_url: "https://github.com/pmatos/symphonika/issues/8",
  id: 5008,
  number: 8,
  state: "open",
  title: "Lifecycle test issue",
  updated_at: "2026-04-21T11:00:00Z"
};

function preparedWorkspaceFixture(
  root: string,
  reused = false
): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "8-lifecycle-test-issue"
  );
  return {
    branchName: "sym/symphonika/8-lifecycle-test-issue",
    branchRef: "refs/heads/sym/symphonika/8-lifecycle-test-issue",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "8-lifecycle-test-issue",
    reused,
    workspacePath
  };
}

async function writeProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 25",
      "providers:",
      "  codex:",
      `    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"`,
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
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
      '      labels_none: ["blocked", "needs-human"]',
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
    ].join("\n")
  );
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    [
      "Work on #{{issue.number}}: {{issue.title}}.",
      "Use {{workspace.path}} on {{branch.name}}.",
      ""
    ].join("\n")
  );
}

const fastContinuationPolicy: LifecyclePolicy = {
  continuation: { cap: 2, delayMs: 5 },
  retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
};

async function waitForCondition(
  url: string,
  predicate: (body: {
    runs: Array<Record<string, unknown>>;
    active?: unknown[];
  }) => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ runs: Array<Record<string, unknown>> }> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as {
      active?: unknown[];
      runs?: Array<Record<string, unknown>>;
    };
    if (
      body.runs !== undefined &&
      predicate({ runs: body.runs, active: body.active ?? [] })
    ) {
      return { runs: body.runs };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met before timeout");
}

describe("dispatch continuation cap", () => {
  it("schedules continuations up to the cap, then writes a cap-reached failure row", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // every refresh returns the issue still eligible
      getIssue: vi
        .fn()
        .mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
      listBranchCommits: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    let createCount = 0;
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> => {
      createCount += 1;
      return Promise.resolve({ ...prepared, reused: createCount > 1 });
    });
    let runCounter = 0;
    const createRunId = (): string => {
      runCounter += 1;
      return `run-cont-${runCounter}`;
    };

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Wait until cap-reached failure row appears
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some(
          (run) =>
            run["state"] === "failed" &&
            run["terminalReason"] === "cap_reached:no_commits"
        )
      );

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        runs: Array<Record<string, unknown>>;
      };

      const successfulContinuations = status.runs.filter(
        (run) => run["state"] === "succeeded" && run["isContinuation"] === true
      );
      const successfulFresh = status.runs.filter(
        (run) => run["state"] === "succeeded" && run["isContinuation"] === false
      );

      // 1 fresh + 2 continuations succeed (cap=2)
      expect(successfulFresh).toHaveLength(1);
      expect(successfulContinuations).toHaveLength(2);

      // Workspace reused from second attempt onward
      expect(prepareIssueWorkspace).toHaveBeenCalledTimes(3);

      // Cap-reached failure row visible
      const capRow = status.runs.find(
        (run) => run["terminalReason"] === "cap_reached:no_commits"
      );
      expect(capRow).toMatchObject({
        state: "failed",
        isContinuation: true,
        failureClassification: "deterministic"
      });

      // sym:failed added once for the cap-reached event
      const failedAdds = githubIssuesApi.addLabelsToIssue.mock.calls
        .map(([call]) => call as { labels: string[] })
        .filter((call) => call.labels[0] === "sym:failed");
      expect(failedAdds.length).toBeGreaterThanOrEqual(1);

      // This is a non-raw-FSM (markdown) workflow, so every one of the 3
      // successful runs above (1 fresh + 2 continuations) is a
      // deferReleaseToScheduler=true success: applyTerminal must NOT release
      // sym:claimed for any of them -- scheduleNext's own continuation-
      // scheduling logic owns that decision instead, and here it kept
      // scheduling a next continuation each time (this is exactly the
      // "continuation actually scheduled" fall-through, which correctly does
      // nothing since the new continuation run is about to own the claim).
      // Only once the cap is finally reached does scheduleNext's cap-reached
      // branch release the claim -- so exactly one release call, not zero
      // (the pre-fix bug) and not one-per-success (the race this fix closes).
      const claimedRemoveLabelArgs =
        githubIssuesApi.removeLabelsFromIssue.mock.calls
          .map(([call]) => (call as { labels: string[] }).labels)
          .filter((labels) => labels[0] === "sym:claimed");
      expect(claimedRemoveLabelArgs).toEqual([["sym:claimed", "sym:stale"]]);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        {
          readonly: true
        }
      );
      try {
        const totalSucceeded = database
          .prepare("select count(*) as c from runs where state = 'succeeded'")
          .get() as { c: number };
        expect(totalSucceeded.c).toBe(3);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  // Regression for #709 on a non-raw-FSM (markdown) workflow with
  // continuations disabled entirely (cap <= 0): applyTerminal defers the
  // release for a non-raw-FSM success (deferReleaseToScheduler), expecting
  // scheduleNext to release it once scheduleNext itself knows no
  // continuation is coming. The `cap <= 0` early return is exactly such a
  // point -- it must release too, or a plain single-shot success would never
  // give back its claim, leaving the issue permanently undispatchable.
  it("releases the claim on success when continuations are disabled (cap <= 0)", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // Still eligible (agent-ready) after the run finishes -- the point is
      // that a disabled continuation cap must release regardless.
      getIssue: vi
        .fn()
        .mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-cont-disabled",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "succeeded")
      );

      // Give scheduleNext's cap<=0 early return a moment to run past the
      // applyTerminal call it follows.
      await new Promise((resolve) => setTimeout(resolve, 80));

      const claimedRemoveLabelArgs =
        githubIssuesApi.removeLabelsFromIssue.mock.calls
          .map(([call]) => (call as { labels: string[] }).labels)
          .filter((labels) => labels[0] === "sym:claimed");
      expect(claimedRemoveLabelArgs).toEqual([["sym:claimed", "sym:stale"]]);
    } finally {
      await daemon.stop();
    }
  });

  it("reuses the original branch/workspace plan on a continuation even after the issue title changes", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    let getIssueCalls = 0;
    const renamedTitle = "Renamed after the first attempt";
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // The first refresh (deciding whether to schedule the continuation)
      // still sees the original title; the second refresh (the scheduled
      // continuation actually firing) sees a title edited in the meantime.
      getIssue: vi.fn(() => {
        getIssueCalls += 1;
        return Promise.resolve({
          ...baseIssue,
          labels: ["agent-ready"],
          title: getIssueCalls === 1 ? baseIssue.title : renamedTitle
        });
      }),
      listBranchCommits: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve({ ...prepared, reused: true })
    );

    let runCounter = 0;
    const createRunId = (): string => {
      runCounter += 1;
      return `run-title-drift-${runCounter}`;
    };

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some(
          (run) =>
            run["state"] === "succeeded" && run["isContinuation"] === true
        )
      );

      expect(prepareIssueWorkspace.mock.calls.length).toBeGreaterThanOrEqual(2);
      const [freshCallInput] = prepareIssueWorkspace.mock
        .calls[0] as unknown as [
        { existing?: unknown; issue: { title: string } }
      ];
      const [continuationCallInput] = prepareIssueWorkspace.mock
        .calls[1] as unknown as [
        {
          existing?: { branchName: string; workspacePath: string };
          issue: { title: string };
        }
      ];

      // Sanity check the fixture: the continuation really did observe the
      // edited title, so a passing `existing` assertion below proves the
      // controller ignored it rather than the mock never having changed.
      expect(freshCallInput.issue.title).toBe(baseIssue.title);
      expect(continuationCallInput.issue.title).toBe(renamedTitle);
      expect(continuationCallInput.existing).toEqual({
        branchName: prepared.branchName,
        workspacePath: prepared.workspacePath
      });
    } finally {
      await daemon.stop();
    }
  });

  it("does not schedule continuation when refreshed issue is closed", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(null),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-cont-closed",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "succeeded")
      );

      // wait beyond continuation delay to confirm no extra scheduling
      await new Promise((resolve) => setTimeout(resolve, 80));

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        runs: Array<Record<string, unknown>>;
      };
      const continuations = status.runs.filter(
        (run) => run["isContinuation"] === true
      );
      expect(continuations).toHaveLength(0);
      const failedAdds = githubIssuesApi.addLabelsToIssue.mock.calls
        .map(([call]) => call as { labels: string[] })
        .filter((call) => call.labels[0] === "sym:failed");
      expect(failedAdds).toHaveLength(0);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:claimed", "sym:stale"] })
      );
    } finally {
      await daemon.stop();
    }
  }, 70_000);

  it("releases the claim when a dependency refresh rejects continuation scheduling", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    let runAttemptCount = 0;
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        runAttemptCount += 1;
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi
        .fn()
        .mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
      getIssueDependencies: vi
        .fn()
        .mockResolvedValueOnce(
          new Map([[baseIssue.number, { blockedBy: [], truncated: false }]])
        )
        .mockRejectedValue(new Error("transient GraphQL failure")),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-cont-dependency-refresh",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "succeeded")
      );

      await new Promise((resolve) => setTimeout(resolve, 80));

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        runs: Array<Record<string, unknown>>;
      };
      expect(status.runs).toHaveLength(1);
      expect(runAttemptCount).toBe(1);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:claimed", "sym:stale"] })
      );
    } finally {
      await daemon.stop();
    }
  });

  it("releases the claim without starting a scheduled continuation when the issue closes during the delay", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    let runAttemptCount = 0;
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        runAttemptCount += 1;
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi
        .fn()
        // First refresh schedules the continuation.
        .mockResolvedValueOnce({ ...baseIssue, labels: ["agent-ready"] })
        // Second refresh happens when the scheduled continuation fires: the
        // issue was closed during the delay.
        .mockResolvedValue(null),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-cont-closed-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "succeeded")
      );

      await new Promise((resolve) => setTimeout(resolve, 80));

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        runs: Array<Record<string, unknown>>;
      };
      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]?.["isContinuation"]).toBe(false);
      expect(runAttemptCount).toBe(1);
      expect(prepareIssueWorkspace).toHaveBeenCalledTimes(1);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:claimed", "sym:stale"] })
      );
    } finally {
      await daemon.stop();
    }
  });

  it("terminalizes a scheduled continuation when its provider command disappears", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const project: RunControllerProjectConfig = {
      agent: { provider: "omp" },
      issue_filters: {
        labels_all: ["agent-ready"],
        labels_none: ["blocked", "needs-human"],
        states: ["open"]
      },
      mode: "dispatch",
      name: "symphonika",
      priority: { default: 99, labels: {} },
      tracker: {
        kind: "github",
        owner: "pmatos",
        repo: "symphonika",
        token: "$GITHUB_TOKEN"
      },
      workflow: { format: "auto", path: "./WORKFLOW.md" },
      workspace: {
        git: {
          base_branch: "main",
          remote: "git@github.com:pmatos/symphonika.git"
        },
        root: "./.symphonika/workspaces/symphonika"
      }
    };
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "omp",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue({
        ...baseIssue,
        labels: ["agent-ready", "sym:claimed"]
      }),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn();
    const controller = new RunController({
      activeRuns: new ActiveRunRegistry(),
      agentProviders: { omp: provider },
      configDir: root,
      createRunId: () => "run-cont-missing-omp",
      emailConfigLoader: () => undefined,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      prepareIssueWorkspace,
      projectsLoader: () => Promise.resolve(new Map([[project.name, project]])),
      providersLoader: () =>
        Promise.resolve({
          claude: { command: "claude" },
          codex: { command: "codex" }
        }),
      runStore,
      schedule: () => true,
      stateRoot
    });

    try {
      await controller.executeContinuation({
        issue: {
          body: baseIssue.body,
          created_at: baseIssue.created_at,
          id: baseIssue.id,
          labels: ["agent-ready", "sym:claimed"],
          number: baseIssue.number,
          priority: 99,
          state: baseIssue.state,
          title: baseIssue.title,
          updated_at: baseIssue.updated_at,
          url: baseIssue.html_url
        },
        parentRunId: "parent-run",
        projectName: project.name
      });

      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(prepareIssueWorkspace).not.toHaveBeenCalled();
      expect(runStore.getRun("run-cont-missing-omp")).toMatchObject({
        continuationParentRunId: "parent-run",
        failureClassification: "deterministic",
        isContinuation: true,
        state: "failed",
        terminalReason: "provider_command_missing: omp"
      });
      expect(
        githubIssuesApi.addLabelsToIssue.mock.calls.some(([input]) =>
          (input as { labels: string[] }).labels.includes("sym:failed")
        )
      ).toBe(true);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:running"] })
      );
    } finally {
      runStore.close();
    }
  });

  it("releases the claim without starting a scheduled continuation when the issue loses eligibility during the delay", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    let runAttemptCount = 0;
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        runAttemptCount += 1;
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi
        .fn()
        // First refresh schedules the continuation.
        .mockResolvedValueOnce({ ...baseIssue, labels: ["agent-ready"] })
        // Second refresh happens when the scheduled continuation fires.
        .mockResolvedValue({
          ...baseIssue,
          labels: ["agent-ready", "needs-human"]
        }),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-cont-loss-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "succeeded")
      );

      await new Promise((resolve) => setTimeout(resolve, 80));

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        runs: Array<Record<string, unknown>>;
      };
      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]?.["isContinuation"]).toBe(false);
      expect(runAttemptCount).toBe(1);
      expect(prepareIssueWorkspace).toHaveBeenCalledTimes(1);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:claimed", "sym:stale"] })
      );
    } finally {
      await daemon.stop();
    }
  });

  it("suppresses continuations after a raw FSM workflow reaches a terminal node", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeRawFsmTracerBulletProject(root);

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    // Issue stays agent-ready after the run — without the raw-FSM terminal
    // suppression, scheduleNext would refresh, see the label, and dispatch a
    // continuation. Later polls include the operational claim so the issue is
    // still excluded from a second fresh dispatch.
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue({
        ...baseIssue,
        labels: ["agent-ready"]
      }),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([
          { ...baseIssue, labels: ["agent-ready", "sym:claimed"] }
        ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );
    const logger = pino({ enabled: false });
    const logInfo = vi.spyOn(logger, "info");

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-fsm-terminal",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger,
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "succeeded")
      );

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        runs: Array<Record<string, unknown>>;
      };
      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]?.["isContinuation"]).toBe(false);
      expect(status.runs[0]?.["state"]).toBe("succeeded");
    } finally {
      // stop() drains the dispatch lifecycle, so the assertion below observes
      // scheduleNext's decision without racing a wall-clock delay.
      await daemon.stop();
    }

    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: baseIssue.number,
        project: "symphonika",
        runId: "run-fsm-terminal"
      }),
      "symphonika workflow suppressed label-driven continuation"
    );

    // Regression guard for deferReleaseToScheduler's raw-FSM half
    // (`!isRawFsm && outcome.kind === "success"`): a genuine raw-FSM terminal
    // success must still release the claim immediately from applyTerminal
    // itself, since scheduleNext's suppressContinuation short-circuit above
    // means it will never reach any of its own release branches. If that
    // condition were ever flipped to `isRawFsm`, this run would defer to a
    // scheduleNext call that never happens, and the claim would dangle
    // forever.
    const claimedRemoveLabelArgs =
      githubIssuesApi.removeLabelsFromIssue.mock.calls
        .map(([call]) => (call as { labels: string[] }).labels)
        .filter((labels) => labels[0] === "sym:claimed");
    expect(claimedRemoveLabelArgs).toEqual([["sym:claimed", "sym:stale"]]);
  });
});

async function writeRawFsmTracerBulletProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 25",
      "providers:",
      "  codex:",
      `    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"`,
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
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
      '      labels_none: ["blocked", "needs-human"]',
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
      "    workflow: ./workflow.yml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: tracer_bullet",
      "  initial: run_agent",
      "  states:",
      "    run_agent:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
      "      transitions:",
      "        - to: done",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}
