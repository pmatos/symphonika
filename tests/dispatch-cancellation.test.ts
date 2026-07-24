import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { DaemonHandle } from "../src/daemon.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cancel-test-"));
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

type ControllableProvider = AgentProvider & {
  cancel: ReturnType<typeof vi.fn<(runId: string) => Promise<void>>>;
  ready: Promise<void>;
  validate: ReturnType<typeof vi.fn<(command: string) => Promise<void>>>;
};

function controllableProvider(): ControllableProvider {
  const cancellers = new Map<string, () => void>();
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let activeCount = 0;

  const cancel = vi.fn((runId: string): Promise<void> => {
    const stop = cancellers.get(runId);
    if (stop !== undefined) {
      stop();
    }
    return Promise.resolve();
  });

  const validate = vi.fn().mockResolvedValue(undefined);

  return {
    cancel,
    name: "codex",
    ready,
    runAttempt(input: ProviderRunInput): AsyncGenerator<ProviderEvent> {
      let stop: (() => void) | undefined;
      const cancelled = new Promise<void>((resolve) => {
        stop = resolve;
      });
      cancellers.set(input.run.id, () => stop?.());

      activeCount += 1;
      if (activeCount === 1) {
        resolveReady?.();
      }

      async function* generator(): AsyncGenerator<ProviderEvent> {
        try {
          yield {
            normalized: { sessionId: "fake", type: "session_started" },
            raw: { kind: "session" }
          };
          await cancelled;
          yield {
            normalized: {
              cancelled: true,
              exitCode: null,
              signal: "SIGTERM",
              type: "process_exit"
            },
            raw: { cancelled: true, kind: "exit" }
          };
        } finally {
          cancellers.delete(input.run.id);
          activeCount -= 1;
        }
      }

      return generator();
    },
    validate
  } satisfies ControllableProvider;
}

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

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
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
    reused: false,
    workspacePath
  };
}

async function writeProject(root: string): Promise<string> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      // Large enough that the background poll timer never fires on its own
      // during the test; both tests drive ticks explicitly via /api/poll-now
      // so the mock's call-count-based responses stay deterministic. See
      // issue #283.
      "  interval_ms: 60000",
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
  return path.join(root, "symphonika.yml");
}

async function waitForRunState(
  url: string,
  state: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ runs: Array<Record<string, unknown>> }> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as {
      runs?: Array<Record<string, unknown>>;
    };
    if (body.runs?.some((run) => run["state"] === state)) {
      return { runs: body.runs };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`run did not reach ${state} before timeout`);
}

// Diagnostic-only, added while chasing issue #283 (intermittent Node-24-only
// hang in this file). Dumps whether the mock provider's cancel() was ever
// invoked, the run row straight from the DB, and a live /api/status snapshot
// when waitForRunState fails to observe "cancelled" in time — narrows down
// whether cancellation was silently dropped vs. delivered-but-not-persisted
// vs. something else entirely (see issue #283 for the three candidate
// branches). Remove once the root cause is confirmed and fixed.
async function dumpCancellationDiagnostics(input: {
  daemon: DaemonHandle;
  provider: ControllableProvider;
  root: string;
  runId: string;
}): Promise<void> {
  const lines = [
    `--- dispatch-cancellation diagnostic dump (${input.runId}) ---`,
    `provider.cancel.mock.calls: ${JSON.stringify(input.provider.cancel.mock.calls)}`
  ];
  try {
    const response = await fetch(`${input.daemon.url}/api/status`);
    lines.push(`GET /api/status: ${JSON.stringify(await response.json())}`);
  } catch (error) {
    lines.push(`GET /api/status failed: ${String(error)}`);
  }
  try {
    const database = new Database(
      path.join(input.root, ".symphonika", "symphonika.db"),
      { readonly: true }
    );
    try {
      const row = database
        .prepare(
          "select state, cancel_requested, cancel_reason from runs where id = ?"
        )
        .get(input.runId);
      lines.push(`DB row: ${JSON.stringify(row)}`);
    } finally {
      database.close();
    }
  } catch (error) {
    lines.push(`DB read failed: ${String(error)}`);
  }
  // console.error (not the disabled pino logger) so this reaches the CI job
  // log even though vitest normally captures per-test stdout/stderr.
  console.error(lines.join("\n"));
}

// Diagnostic-only (see comment above): bounds daemon.stop() so a stuck
// in-flight dispatch can't ride the whole test to the global 35s vitest
// timeout — it fails fast with an attributable message instead.
async function stopDaemonWithDiagnosticTimeout(
  daemon: DaemonHandle,
  timeoutMs = 3_000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `daemon.stop() did not resolve within ${timeoutMs}ms — an in-flight dispatch is likely stuck (issue #283)`
        )
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([daemon.stop(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("dispatch cancellation", () => {
  it("cancels active run when issue is closed and removes operational labels best-effort", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    await writeProject(root);

    const provider = controllableProvider();
    let listCallCount = 0;
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(null),
      listOpenIssues: vi.fn(() => {
        listCallCount += 1;
        if (listCallCount === 1) {
          return Promise.resolve([{ ...baseIssue, labels: ["agent-ready"] }]);
        }
        // Issue closed for subsequent polls.
        return Promise.resolve([]);
      }),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-cancel-closed",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Drive ticks explicitly instead of racing the background poll
      // interval: the first dispatches the issue, the second observes it has
      // become ineligible and cancels. Relying on the passive setInterval
      // under contended CI load left this racing an unbounded delay before
      // the run was ever cancelled (issue #283).
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await provider.ready;
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      let status: { runs: Array<Record<string, unknown>> };
      try {
        status = await waitForRunState(daemon.url, "cancelled");
      } catch (error) {
        await dumpCancellationDiagnostics({
          daemon,
          provider,
          root,
          runId: "run-cancel-closed"
        });
        throw error;
      }
      const run = status.runs[0] as Record<string, unknown>;

      expect(provider.cancel).toHaveBeenCalledWith("run-cancel-closed");
      expect(run["state"]).toBe("cancelled");
      expect(run["cancelReason"]).toBe("closed_issue");
      expect(run["cancelRequested"]).toBe(true);

      const removeCalls = githubIssuesApi.removeLabelsFromIssue.mock.calls.map(
        ([call]) => call as { labels: string[] }
      );
      expect(removeCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ labels: ["sym:running"] }),
          expect.objectContaining({ labels: ["sym:claimed"] }),
          expect.objectContaining({ labels: ["sym:failed"] })
        ])
      );

      const addCalls = githubIssuesApi.addLabelsToIssue.mock.calls.map(
        ([call]) => call as { labels: string[] }
      );
      expect(addCalls.some((call) => call.labels[0] === "sym:failed")).toBe(
        false
      );

      // Workspace preserved.
      await expect(stat(prepared.workspacePath)).resolves.toBeDefined();
    } finally {
      await stopDaemonWithDiagnosticTimeout(daemon);
    }
  });

  it("cancels active run on eligibility loss and removes only sym:running", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    await writeProject(root);

    const provider = controllableProvider();
    let listCallCount = 0;
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(null),
      listOpenIssues: vi.fn(() => {
        listCallCount += 1;
        if (listCallCount === 1) {
          return Promise.resolve([{ ...baseIssue, labels: ["agent-ready"] }]);
        }
        // Excluded label appears.
        return Promise.resolve([
          {
            ...baseIssue,
            labels: ["agent-ready", "needs-human", "sym:claimed", "sym:running"]
          }
        ]);
      }),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-cancel-eligibility",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Drive ticks explicitly instead of racing the background poll
      // interval: the first dispatches the issue, the second observes it has
      // become ineligible and cancels. Relying on the passive setInterval
      // under contended CI load left this racing an unbounded delay before
      // the run was ever cancelled (issue #283).
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await provider.ready;
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      let status: { runs: Array<Record<string, unknown>> };
      try {
        status = await waitForRunState(daemon.url, "cancelled");
      } catch (error) {
        await dumpCancellationDiagnostics({
          daemon,
          provider,
          root,
          runId: "run-cancel-eligibility"
        });
        throw error;
      }
      const run = status.runs[0] as Record<string, unknown>;

      expect(provider.cancel).toHaveBeenCalledWith("run-cancel-eligibility");
      expect(run["cancelReason"]).toBe("eligibility_loss");

      const removeCalls = githubIssuesApi.removeLabelsFromIssue.mock.calls.map(
        ([call]) => call as { labels: string[] }
      );
      expect(removeCalls.some((call) => call.labels[0] === "sym:running")).toBe(
        true
      );
      expect(removeCalls.some((call) => call.labels[0] === "sym:claimed")).toBe(
        false
      );

      const addCalls = githubIssuesApi.addLabelsToIssue.mock.calls.map(
        ([call]) => call as { labels: string[] }
      );
      expect(addCalls.some((call) => call.labels[0] === "sym:failed")).toBe(
        false
      );

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        {
          readonly: true
        }
      );
      try {
        const stored = database
          .prepare("select state, cancel_reason from runs where id = ?")
          .get("run-cancel-eligibility") as {
          state: string;
          cancel_reason: string;
        };
        expect(stored.state).toBe("cancelled");
        expect(stored.cancel_reason).toBe("eligibility_loss");
      } finally {
        database.close();
      }
    } finally {
      await stopDaemonWithDiagnosticTimeout(daemon);
    }
  });
});
