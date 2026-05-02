import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { LifecyclePolicy } from "../src/lifecycle/active-runs.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-mutex-test-"));
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

async function writeProject(root: string, workflowTemplate: string): Promise<void> {
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
  await writeFile(path.join(root, "WORKFLOW.md"), workflowTemplate);
}

const fastContinuationPolicy: LifecyclePolicy = {
  continuation: { cap: 2, delayMs: 5 },
  retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
};

async function waitForCondition(
  url: string,
  predicate: (body: { runs: Array<Record<string, unknown>> }) => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as {
      runs?: Array<Record<string, unknown>>;
    };
    if (body.runs !== undefined && predicate({ runs: body.runs })) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met before timeout");
}

describe("dispatch mutex", () => {
  it("scheduled continuation never runs concurrently with another active dispatch", async () => {
    const root = await makeTempRoot();
    await mkdir(preparedWorkspaceFixture(root).workspacePath, { recursive: true });
    await writeProject(root, "Work {{issue.number}}\n");

    let active = 0;
    let maxActive = 0;

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        active += 1;
        if (active > maxActive) {
          maxActive = active;
        }
        try {
          // Hold the run long enough to overlap with a scheduled continuation.
          await new Promise((resolve) => setTimeout(resolve, 60));
          yield {
            normalized: { exitCode: 0, type: "process_exit" },
            raw: { code: 0, kind: "exit" }
          };
        } finally {
          active -= 1;
        }
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
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
      createRunId: () => `run-mutex-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Wait for cap-reached row (1 fresh + 2 succeeded continuations + cap-reached failed)
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some(
          (run) =>
            run["state"] === "failed" &&
            run["terminalReason"] === "continuation cap reached"
        )
      );

      expect(maxActive).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it("renders run.continuation as true on continuation runs and false on the fresh run", async () => {
    const root = await makeTempRoot();
    await mkdir(preparedWorkspaceFixture(root).workspacePath, { recursive: true });
    await writeProject(
      root,
      "Continuation? {{run.continuation}} attempt={{run.attempt}}\n"
    );

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
      getIssue: vi.fn().mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
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
      createRunId: () => `run-cont-flag-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: { continuation: { cap: 1, delayMs: 5 }, retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 } },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Wait for the cap-reached failure row (fresh + 1 continuation succeed, cap=1)
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

      const fresh = status.runs.find(
        (run) =>
          run["state"] === "succeeded" && run["isContinuation"] === false
      );
      const continuation = status.runs.find(
        (run) =>
          run["state"] === "succeeded" && run["isContinuation"] === true
      );
      expect(fresh).toBeDefined();
      expect(continuation).toBeDefined();

      const freshPrompt = await readFile(fresh?.["promptPath"] as string, "utf8");
      const continuationPrompt = await readFile(
        continuation?.["promptPath"] as string,
        "utf8"
      );

      expect(freshPrompt).toContain("Continuation? false");
      expect(continuationPrompt).toContain("Continuation? true");
    } finally {
      await daemon.stop();
    }
  });
});
