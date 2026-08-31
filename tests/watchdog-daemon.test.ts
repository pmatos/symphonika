import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-watchdog-daemon-")
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

describe("daemon watchdog", () => {
  it("stales a provider that only emits non-progress usage and rate-limit events", async () => {
    const root = await makeTempRoot();
    await writeProject(root, { daemonHealthEmail: true });
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    const provider = idleUsageProvider();
    const deliver = vi.fn().mockResolvedValue(undefined);

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-watchdog-idle",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: githubIssuesApiFixture(),
      logger: pino({ enabled: false }),
      notificationSink: { deliver },
      port: 0,
      prepareIssueWorkspace: prepareWorkspace(prepared)
    });

    try {
      const run = await waitForRunState(daemon.url, "stale");
      expect(run).toMatchObject({
        id: "run-watchdog-idle",
        state: "stale",
        terminalReason: "no_progress"
      });
      expect(provider.cancel).toHaveBeenCalledWith("run-watchdog-idle");
      await waitForNotification(
        deliver,
        "[Symphonika] Watchdog terminated 1 issue Run"
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = await getRun(daemon.url, "run-watchdog-idle");
      expect(after).toMatchObject({
        state: "stale",
        terminalReason: "no_progress"
      });
    } finally {
      provider.stopAll();
      await daemon.stop();
    }
  });

  it("stales a busy provider that burns its output-token budget without converging", async () => {
    const root = await makeTempRoot();
    // A long grace window, so only the convergence budget can end this Run.
    await writeProject(root, { graceMinutes: 600, outputTokenBudget: 1_000 });
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    const provider = busyProvider();
    // Distinct ids per dispatch, so a re-dispatch after the stale verdict would
    // show up as a second Run rather than colliding on a fixed id.
    let dispatched = 0;
    const createRunId = (): string => {
      dispatched += 1;
      return dispatched === 1
        ? "run-watchdog-budget"
        : `run-watchdog-budget-${dispatched}`;
    };

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: githubIssuesApiFixture(),
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: prepareWorkspace(prepared)
    });

    try {
      const run = await waitForRunState(daemon.url, "stale");
      expect(run).toMatchObject({
        id: "run-watchdog-budget",
        state: "stale",
        terminalReason: "no_convergence"
      });
      expect(provider.cancel).toHaveBeenCalledWith("run-watchdog-budget");

      // The provider's own exit must not rewrite the verdict as "cancelled".
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await getRun(daemon.url, "run-watchdog-budget")).toMatchObject({
        state: "stale",
        terminalReason: "no_convergence"
      });
      // And the Issue must stay claimed: re-dispatching would start a fresh
      // Run with a fresh budget and reproduce the incident at higher cost.
      expect(dispatched).toBe(1);
      expect(await listRuns(daemon.url)).toHaveLength(1);
    } finally {
      provider.stopAll();
      await daemon.stop();
    }
  });

  it("keeps a provider alive when an undeclared vendor directory is its only progress signal", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(path.join(prepared.workspacePath, "vendor"), {
      recursive: true
    });
    const provider = workspaceMtimeProvider("vendor/heartbeat.txt");

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-watchdog-mtime",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: githubIssuesApiFixture(),
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: prepareWorkspace(prepared)
    });

    try {
      await waitForRunState(daemon.url, "running");
      await new Promise((resolve) => setTimeout(resolve, 220));
      const run = await getRun(daemon.url, "run-watchdog-mtime");
      expect(run).toMatchObject({
        id: "run-watchdog-mtime",
        state: "running",
        terminalReason: null
      });
    } finally {
      provider.stopAll();
      await daemon.stop();
    }
  });

  it("stales a provider whose only workspace changes are ignored by its Workflow Contract", async () => {
    const root = await makeTempRoot();
    await writeProject(root, { evidenceIgnore: ["vendor/"] });
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(path.join(prepared.workspacePath, "vendor"), {
      recursive: true
    });
    const provider = workspaceMtimeProvider("vendor/heartbeat.txt");

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-watchdog-ignored-vendor",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: githubIssuesApiFixture(),
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: prepareWorkspace(prepared)
    });

    try {
      const run = await waitForRunState(daemon.url, "stale");
      expect(run).toMatchObject({
        id: "run-watchdog-ignored-vendor",
        state: "stale",
        terminalReason: "no_progress"
      });
    } finally {
      provider.stopAll();
      await daemon.stop();
    }
  });

  it("stales a removed Project's active Run using its persisted evidence ignore", async () => {
    const root = await makeTempRoot();
    await writeProject(root, {
      evidenceIgnore: ["vendor/"],
      graceMinutes: 10,
      pollingIntervalMs: 60_000
    });
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(path.join(prepared.workspacePath, "vendor"), {
      recursive: true
    });
    const provider = workspaceMtimeProvider("vendor/heartbeat.txt");

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-watchdog-removed-project",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: githubIssuesApiFixture(),
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: prepareWorkspace(prepared)
    });

    try {
      await waitForRunState(daemon.url, "running");
      await replaceProjectWithRoutineHost(root);

      // Drive the two Watchdog samples explicitly. A minimum delay controls
      // its clock; poll-now, rather than scheduler responsiveness, runs it.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const baselineResponse = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(baselineResponse.status).toBe(200);
      expect(
        await getRun(daemon.url, "run-watchdog-removed-project")
      ).toMatchObject({ state: "running" });

      await new Promise((resolve) => setTimeout(resolve, 75));
      const staleResponse = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(staleResponse.status).toBe(200);
      const run = await getRun(daemon.url, "run-watchdog-removed-project");
      expect(run).toMatchObject({
        id: "run-watchdog-removed-project",
        state: "stale",
        terminalReason: "no_progress"
      });
    } finally {
      provider.stopAll();
      await daemon.stop();
    }
  });

  it("keeps a provider alive when normal workspace changes accompany ignored output", async () => {
    const root = await makeTempRoot();
    await writeProject(root, { evidenceIgnore: ["out/"] });
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(path.join(prepared.workspacePath, "out"), { recursive: true });
    const provider = workspaceMtimeProvider([
      "out/generated.txt",
      "heartbeat.txt"
    ]);

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-watchdog-ignored-out-with-progress",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: githubIssuesApiFixture(),
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: prepareWorkspace(prepared)
    });

    try {
      await waitForRunState(daemon.url, "running");
      await new Promise((resolve) => setTimeout(resolve, 220));
      const run = await getRun(
        daemon.url,
        "run-watchdog-ignored-out-with-progress"
      );
      expect(run).toMatchObject({
        state: "running",
        terminalReason: null
      });
    } finally {
      provider.stopAll();
      await daemon.stop();
    }
  });

  it("does not start the provider when a cancel lands during workspace prep", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    const provider = neverStartingProvider();

    let releasePrep: () => void = () => {};
    const prepGate = new Promise<void>((resolve) => {
      releasePrep = resolve;
    });
    const prepareIssueWorkspace = async (
      input: PrepareIssueWorkspaceInput
    ): Promise<PreparedIssueWorkspace> => {
      void input;
      await prepGate;
      return prepared;
    };

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-cancel-during-prep",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: githubIssuesApiFixture(),
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // The run parks in preparing_workspace while prep is gated. Cancel it there
      // (operator path) — before the provider is attached. (The watchdog samples
      // running rows only, so a pre-attach cancel comes from operator/closed-issue
      // paths, which the re-check must still honor.)
      await waitForRunState(daemon.url, "preparing_workspace");
      await fetch(`${daemon.url}/api/runs/run-cancel-during-prep/cancel`, {
        method: "POST"
      });
      // Releasing prep lets the lifecycle finish attaching. Because the cancel was
      // recorded before attach, the provider must NOT be launched (its cancel would
      // be a no-op against an unstarted provider and never retried), and the run
      // must settle as cancelled rather than hanging.
      releasePrep();
      const settled = await waitForSettledRun(
        daemon.url,
        "run-cancel-during-prep"
      );
      expect(settled.state).toBe("cancelled");
      expect(provider.runAttemptCalls()).toBe(0);
    } finally {
      provider.stopAll();
      await daemon.stop();
    }
  });
});

type ControllableProvider = AgentProvider & {
  cancel: ReturnType<typeof vi.fn<(runId: string) => Promise<void>>>;
  stopAll: () => void;
};

function idleUsageProvider(): ControllableProvider {
  return controllableProvider(async function* (
    input: ProviderRunInput,
    stopped: Promise<void>
  ): AsyncGenerator<ProviderEvent> {
    yield {
      normalized: {
        tokenUsage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
        type: "usage_updated"
      },
      raw: { kind: "usage" }
    };
    yield {
      normalized: {
        rateLimits: { primary: { remaining: 10 } },
        type: "rate_limit_updated"
      },
      raw: { kind: "rate_limit" }
    };
    await stopped;
    yield {
      normalized: {
        cancelled: true,
        exitCode: null,
        signal: "SIGTERM",
        type: "process_exit"
      },
      raw: { cancelled: true, kind: "exit", runId: input.run.id }
    };
  });
}

// Streams real assistant output and a climbing cumulative output-token total:
// every ADR 0054 liveness signal stays satisfied, so only the ADR 0086 budget
// can stop it. This is the shape of the vow#1055 crash loop.
function busyProvider(): ControllableProvider {
  return controllableProvider(async function* (
    input: ProviderRunInput,
    stopped: Promise<void>
  ): AsyncGenerator<ProviderEvent> {
    let outputTokens = 0;
    const pending: ProviderEvent[] = [];
    const interval = setInterval(() => {
      outputTokens += 400;
      pending.push(
        {
          normalized: { message: "still working", type: "message" },
          raw: { kind: "message", runId: input.run.id }
        },
        {
          normalized: {
            tokenUsage: { total: { outputTokens } },
            type: "usage_updated"
          },
          raw: { kind: "usage", runId: input.run.id }
        }
      );
    }, 10);
    let finished = false;
    void stopped.then(() => {
      finished = true;
    });
    try {
      while (!finished) {
        const next = pending.shift();
        if (next === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        yield next;
      }
      yield {
        normalized: {
          cancelled: true,
          exitCode: null,
          signal: "SIGTERM",
          type: "process_exit"
        },
        raw: { cancelled: true, kind: "exit", runId: input.run.id }
      };
    } finally {
      clearInterval(interval);
    }
  });
}

function workspaceMtimeProvider(
  relativePath: string | string[] = "heartbeat.txt"
): ControllableProvider {
  return controllableProvider(async function* (
    input: ProviderRunInput,
    stopped: Promise<void>
  ): AsyncGenerator<ProviderEvent> {
    const touched = (
      Array.isArray(relativePath) ? relativePath : [relativePath]
    ).map((entry) => path.join(input.workspacePath, entry));
    await Promise.all(touched.map((entry) => writeFile(entry, "heartbeat\n")));
    let tick = 0;
    const interval = setInterval(() => {
      tick += 1;
      const next = new Date(Date.now() + tick * 1_000);
      for (const entry of touched) {
        // ADR 0086: the workspace signal keys on the tree's shape, so a live
        // provider has to actually grow the file rather than only restamp it.
        void writeFile(entry, `heartbeat\n`.repeat(tick + 1)).then(() =>
          utimes(entry, next, next)
        );
      }
    }, 15);
    try {
      await stopped;
      yield {
        normalized: {
          cancelled: true,
          exitCode: null,
          signal: "SIGTERM",
          type: "process_exit"
        },
        raw: { cancelled: true, kind: "exit", runId: input.run.id }
      };
    } finally {
      clearInterval(interval);
    }
  });
}

function controllableProvider(
  generator: (
    input: ProviderRunInput,
    stopped: Promise<void>
  ) => AsyncGenerator<ProviderEvent>
): ControllableProvider {
  const stoppers = new Map<string, () => void>();
  const cancel = vi.fn((runId: string): Promise<void> => {
    stoppers.get(runId)?.();
    return Promise.resolve();
  });

  return {
    cancel,
    name: "codex",
    runAttempt(input: ProviderRunInput): AsyncGenerator<ProviderEvent> {
      let stop: (() => void) | undefined;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      stoppers.set(input.run.id, () => stop?.());
      async function* wrapped(): AsyncGenerator<ProviderEvent> {
        try {
          yield* generator(input, stopped);
        } finally {
          stoppers.delete(input.run.id);
        }
      }
      return wrapped();
    },
    stopAll: () => {
      for (const stop of stoppers.values()) {
        stop();
      }
    },
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

// Records whether its stream was ever entered. If launched it would hang on
// `stopped` (the pre-attach cancel hand-off is a no-op against an unstarted
// provider), so a passing test relies on the run never reaching runAttempt.
function neverStartingProvider(): ControllableProvider & {
  runAttemptCalls: () => number;
} {
  let calls = 0;
  const base = controllableProvider(async function* (
    input: ProviderRunInput,
    stopped: Promise<void>
  ): AsyncGenerator<ProviderEvent> {
    void input;
    calls += 1;
    await stopped;
    yield {
      normalized: {
        cancelled: true,
        exitCode: null,
        signal: "SIGTERM",
        type: "process_exit"
      },
      raw: { kind: "exit" }
    };
  });
  return Object.assign(base, { runAttemptCalls: () => calls });
}

// Label writes are reflected back into listOpenIssues, because Operational
// Labels are what actually gate re-dispatch: `sym:claimed` makes the Issue
// ineligible (issue-polling's REQUIRED_OPERATIONAL_LABELS check), and the
// Watchdog cancel path deliberately does not release it. A static fixture
// would let a terminated Run be re-dispatched forever and prove nothing.
function githubIssuesApiFixture() {
  const labels = new Set(["agent-ready"]);
  return {
    addLabelsToIssue: vi.fn(
      (input: { labels: readonly string[] }): Promise<void> => {
        for (const label of input.labels) {
          labels.add(label);
        }
        return Promise.resolve();
      }
    ),
    listOpenIssues: vi.fn(() =>
      Promise.resolve([
        {
          body: "watchdog issue",
          created_at: "2026-05-22T09:00:00.000Z",
          html_url: "https://github.com/pmatos/symphonika/issues/198",
          id: 198,
          labels: [...labels],
          number: 198,
          state: "open",
          title: "Watchdog issue",
          updated_at: "2026-05-22T09:00:00.000Z"
        }
      ])
    ),
    removeLabelsFromIssue: vi.fn(
      (input: { labels: readonly string[] }): Promise<void> => {
        for (const label of input.labels) {
          labels.delete(label);
        }
        return Promise.resolve();
      }
    )
  };
}

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "198-watchdog-issue"
  );
  return {
    branchName: "sym/symphonika/198-watchdog-issue",
    branchRef: "refs/heads/sym/symphonika/198-watchdog-issue",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "198-watchdog-issue",
    reused: false,
    workspacePath
  };
}

function prepareWorkspace(prepared: PreparedIssueWorkspace) {
  return (
    input: PrepareIssueWorkspaceInput
  ): Promise<PreparedIssueWorkspace> => {
    void input;
    return Promise.resolve(prepared);
  };
}

async function writeProject(
  root: string,
  options: {
    daemonHealthEmail?: boolean;
    evidenceIgnore?: string[];
    graceMinutes?: number;
    outputTokenBudget?: number;
    pollingIntervalMs?: number;
  } = {}
): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      `  interval_ms: ${options.pollingIntervalMs ?? 20}`,
      "watchdog:",
      "  enabled: true",
      `  grace_minutes: ${options.graceMinutes ?? 0.001}`,
      `  output_token_budget: ${options.outputTokenBudget ?? 0}`,
      "  sample_interval_seconds: 0.02",
      ...(options.daemonHealthEmail === true
        ? [
            "email:",
            '  from: "symphonika@example.com"',
            '  to: "operator@example.com"',
            '  smtp_host: "smtp.example.com"',
            "  sources:",
            "    routine_firings: false",
            "    issue_runs: false",
            "    daemon_health: true"
          ]
        : []),
      "providers:",
      "  codex:",
      '    command: "codex fake"',
      "  claude:",
      '    command: "claude fake"',
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
    options.evidenceIgnore === undefined
      ? "Work on #{{issue.number}}.\n"
      : [
          "---",
          "evidence:",
          "  ignore:",
          ...options.evidenceIgnore.map((entry) => `    - ${entry}`),
          "---",
          "Work on #{{issue.number}}.",
          ""
        ].join("\n")
  );
}

async function waitForNotification(
  deliver: ReturnType<typeof vi.fn>,
  subject: string,
  timeoutMs = 4_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      deliver.mock.calls.some(
        (call) => (call[0] as { subject?: string }).subject === subject
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`notification ${subject} was not delivered`);
}

async function replaceProjectWithRoutineHost(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 60000",
      "watchdog:",
      "  enabled: true",
      "  grace_minutes: 0.001",
      "  sample_interval_seconds: 0.02",
      "providers:",
      "  codex:",
      '    command: "codex fake"',
      "  claude:",
      '    command: "claude fake"',
      "projects:",
      "  - name: survivor",
      "    mode: routine_host",
      "    workspace:",
      "      root: ./.symphonika/workspaces/survivor",
      "      git:",
      "        remote: git@github.com:pmatos/survivor.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      ""
    ].join("\n")
  );
}

type StatusRun = {
  id: string;
  state: string;
  terminalReason: string | null;
};

async function waitForRunState(
  url: string,
  state: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<StatusRun> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as { runs?: StatusRun[] };
    const run = body.runs?.find((candidate) => candidate.state === state);
    if (run !== undefined) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`run did not reach ${state} before timeout`);
}

async function waitForSettledRun(
  url: string,
  id: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<StatusRun> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;
  const settledStates = new Set(["stale", "cancelled", "failed", "succeeded"]);

  while (Date.now() < deadline) {
    const run = await getRun(url, id);
    if (run !== undefined && settledStates.has(run.state)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`run ${id} did not settle before timeout`);
}

async function listRuns(url: string): Promise<StatusRun[]> {
  const response = await fetch(`${url}/api/status`);
  const body = (await response.json()) as { runs?: StatusRun[] };
  return body.runs ?? [];
}

async function getRun(url: string, id: string): Promise<StatusRun | undefined> {
  const response = await fetch(`${url}/api/status`);
  const body = (await response.json()) as { runs?: StatusRun[] };
  return body.runs?.find((run) => run.id === id);
}
