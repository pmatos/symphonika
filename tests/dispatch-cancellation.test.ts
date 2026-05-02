import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  PreparedIssueWorkspace
} from "../src/workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cancel-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
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
      "  interval_ms: 25",
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server"',
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
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> =>
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
      await provider.ready;
      const status = await waitForRunState(daemon.url, "cancelled");
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
      expect(addCalls.some((call) => call.labels[0] === "sym:failed")).toBe(false);

      // Workspace preserved.
      await expect(stat(prepared.workspacePath)).resolves.toBeDefined();
    } finally {
      await daemon.stop();
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
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> =>
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
      await provider.ready;
      const status = await waitForRunState(daemon.url, "cancelled");
      const run = status.runs[0] as Record<string, unknown>;

      expect(provider.cancel).toHaveBeenCalledWith("run-cancel-eligibility");
      expect(run["cancelReason"]).toBe("eligibility_loss");

      const removeCalls = githubIssuesApi.removeLabelsFromIssue.mock.calls.map(
        ([call]) => call as { labels: string[] }
      );
      expect(removeCalls.some((call) => call.labels[0] === "sym:running")).toBe(true);
      expect(removeCalls.some((call) => call.labels[0] === "sym:claimed")).toBe(false);

      const addCalls = githubIssuesApi.addLabelsToIssue.mock.calls.map(
        ([call]) => call as { labels: string[] }
      );
      expect(addCalls.some((call) => call.labels[0] === "sym:failed")).toBe(false);

      const database = new Database(path.join(root, ".symphonika", "symphonika.db"), {
        readonly: true
      });
      try {
        const stored = database
          .prepare("select state, cancel_reason from runs where id = ?")
          .get("run-cancel-eligibility") as { state: string; cancel_reason: string };
        expect(stored.state).toBe("cancelled");
        expect(stored.cancel_reason).toBe("eligibility_loss");
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });
});
