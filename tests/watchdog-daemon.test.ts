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
    await writeProject(root);
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    const provider = idleUsageProvider();

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-watchdog-idle",
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
        id: "run-watchdog-idle",
        state: "stale",
        terminalReason: "no_progress"
      });
      expect(provider.cancel).toHaveBeenCalledWith("run-watchdog-idle");

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

  it("keeps a provider alive when workspace mtime is the only progress signal", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    const provider = workspaceMtimeProvider();

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

function workspaceMtimeProvider(): ControllableProvider {
  return controllableProvider(async function* (
    input: ProviderRunInput,
    stopped: Promise<void>
  ): AsyncGenerator<ProviderEvent> {
    const touched = path.join(input.workspacePath, "heartbeat.txt");
    await writeFile(touched, "heartbeat\n");
    let tick = 0;
    const interval = setInterval(() => {
      tick += 1;
      const next = new Date(Date.now() + tick * 1_000);
      void utimes(touched, next, next);
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

function githubIssuesApiFixture() {
  return {
    addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
    listOpenIssues: vi.fn().mockResolvedValue([
      {
        body: "watchdog issue",
        created_at: "2026-05-22T09:00:00.000Z",
        html_url: "https://github.com/pmatos/symphonika/issues/198",
        id: 198,
        labels: ["agent-ready"],
        number: 198,
        state: "open",
        title: "Watchdog issue",
        updated_at: "2026-05-22T09:00:00.000Z"
      }
    ]),
    removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
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

async function writeProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 20",
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
    "Work on #{{issue.number}}.\n"
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

async function getRun(url: string, id: string): Promise<StatusRun | undefined> {
  const response = await fetch(`${url}/api/status`);
  const body = (await response.json()) as { runs?: StatusRun[] };
  return body.runs?.find((run) => run.id === id);
}
