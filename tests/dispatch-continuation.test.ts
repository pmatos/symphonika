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
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cont-test-"));
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

function preparedWorkspaceFixture(root: string, reused = false): PreparedIssueWorkspace {
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
}

const fastContinuationPolicy: LifecyclePolicy = {
  continuation: { cap: 2, delayMs: 5 },
  retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
};

async function waitForCondition(
  url: string,
  predicate: (body: { runs: Array<Record<string, unknown>>; active?: unknown[] }) => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ runs: Array<Record<string, unknown>> }> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 4_000;
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

describe("dispatch continuation cap", () => {
  it("schedules continuations up to the cap, then writes a cap-reached failure row", async () => {
    const root = await makeTempRoot();
    await mkdir(preparedWorkspaceFixture(root).workspacePath, { recursive: true });
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
      getIssue: vi.fn().mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    let createCount = 0;
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> => {
        createCount += 1;
        return Promise.resolve(preparedWorkspaceFixture(root, createCount > 1));
      }
    );
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
            run["terminalReason"] === "continuation cap reached"
        )
      );

      const status = (await fetch(`${daemon.url}/api/status`).then((r) => r.json())) as {
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
        (run) => run["terminalReason"] === "continuation cap reached"
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

      const database = new Database(path.join(root, ".symphonika", "symphonika.db"), {
        readonly: true
      });
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

  it("does not schedule continuation when refreshed issue is closed", async () => {
    const root = await makeTempRoot();
    await mkdir(preparedWorkspaceFixture(root).workspacePath, { recursive: true });
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
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(preparedWorkspaceFixture(root))
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

      const status = (await fetch(`${daemon.url}/api/status`).then((r) => r.json())) as {
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
    } finally {
      await daemon.stop();
    }
  });

  it("does not start scheduled continuation when issue loses eligibility during delay", async () => {
    const root = await makeTempRoot();
    await mkdir(preparedWorkspaceFixture(root).workspacePath, { recursive: true });
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
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(preparedWorkspaceFixture(root))
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

      const status = (await fetch(`${daemon.url}/api/status`).then((r) => r.json())) as {
        runs: Array<Record<string, unknown>>;
      };
      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]?.["isContinuation"]).toBe(false);
      expect(runAttemptCount).toBe(1);
      expect(prepareIssueWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      await daemon.stop();
    }
  });
});
