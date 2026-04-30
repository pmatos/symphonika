import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { LifecyclePolicy } from "../src/lifecycle/active-runs.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import type {
  PreparedIssueWorkspace
} from "../src/workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-retry-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
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
      '    command: "codex --dangerously-bypass-approvals-and-sandbox app-server"',
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

async function waitForCondition(
  url: string,
  predicate: (body: { runs: Array<Record<string, unknown>>; active?: unknown[] }) => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ runs: Array<Record<string, unknown>> }> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as {
      active?: unknown[];
      runs?: Array<Record<string, unknown>>;
    };
    if (body.runs !== undefined && predicate({ runs: body.runs, active: body.active ?? [] })) {
      return { runs: body.runs };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met before timeout");
}

const fastRetryPolicy: LifecyclePolicy = {
  continuation: { cap: 0, delayMs: 0 },
  retry: { cap: 3, delaysMs: [10, 20, 30], maxBackoffMs: 100 }
};

describe("dispatch retry policy", () => {
  it("retries transient failures up to the cap and records retry_count", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    await writeProject(root);

    let attempts = 0;
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        attempts += 1;
        if (attempts < 3) {
          yield {
            normalized: { exitCode: 1, type: "process_exit" },
            raw: { code: 1, kind: "exit" }
          };
          return;
        }
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
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(prepared)
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-retry",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastRetryPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      const status = await waitForCondition(
        daemon.url,
        ({ runs }) => runs.some((run) => run["state"] === "succeeded"),
        { timeoutMs: 10_000 }
      );
      const run = status.runs.find((entry) => entry["state"] === "succeeded");
      expect(run?.["retryCount"]).toBe(2);

      const failedAddCalls = githubIssuesApi.addLabelsToIssue.mock.calls
        .map(([call]) => call as { labels: string[] })
        .filter((call) => call.labels[0] === "sym:failed");
      expect(failedAddCalls).toHaveLength(0);

      const database = new Database(path.join(root, ".symphonika", "symphonika.db"), {
        readonly: true
      });
      try {
        const attemptRows = database
          .prepare("select attempt_number, state from attempts order by attempt_number")
          .all() as { attempt_number: number; state: string }[];
        expect(attemptRows.map((r) => r.attempt_number)).toEqual([1, 2, 3]);
        expect(attemptRows[2]?.state).toBe("succeeded");
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("does not retry deterministic malformed_event failures", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await mkdir(prepared.workspacePath, { recursive: true });
    await writeProject(root);

    let attempts = 0;
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        attempts += 1;
        yield {
          normalized: { line: "{", message: "bad json", type: "malformed_event" },
          raw: { kind: "malformed_json" }
        };
        yield {
          normalized: { exitCode: 1, type: "process_exit" },
          raw: { code: 1, kind: "exit" }
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
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(prepared)
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => "run-deterministic",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastRetryPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "failed")
      );

      // give a small window for any extra retry to happen (it shouldn't)
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(attempts).toBe(1);

      const status = await fetch(`${daemon.url}/api/status`).then((r) => r.json()) as {
        runs: Array<Record<string, unknown>>;
      };
      const run = status.runs[0];
      expect(run?.["retryCount"]).toBe(0);
      expect(run?.["failureClassification"]).toBe("deterministic");
      const failedAddCalls = githubIssuesApi.addLabelsToIssue.mock.calls
        .map(([call]) => call as { labels: string[] })
        .filter((call) => call.labels[0] === "sym:failed");
      expect(failedAddCalls.length).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });
});
