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
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-disable-test-"));
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

async function writeProject(
  root: string,
  overrides: { disabled?: boolean } = {}
): Promise<void> {
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
      `    disabled: ${overrides.disabled ?? false}`,
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
  continuation: { cap: 3, delayMs: 5 },
  retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
};

async function waitForCondition(
  url: string,
  predicate: (body: { runs: Array<Record<string, unknown>> }) => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 3_000;
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

describe("dispatch project disable", () => {
  it("disabling a project mid-flight does not interrupt the active run; no continuation is scheduled afterwards", async () => {
    const root = await makeTempRoot();
    await mkdir(preparedWorkspaceFixture(root).workspacePath, { recursive: true });
    await writeProject(root);

    let runAttemptCount = 0;
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        runAttemptCount += 1;
        // brief pause so the test can rewrite config mid-run
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // continuation refresh always says still eligible (so we know dispatch is the gate)
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

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-disable-${runAttemptCount + 1}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Wait until first run starts (registered in active runs)
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "running")
      );

      // Disable project mid-flight
      await writeProject(root, { disabled: true });

      // Wait for first run to succeed
      await waitForCondition(daemon.url, ({ runs }) =>
        runs.some((run) => run["state"] === "succeeded")
      );

      // Active run is preserved (succeeded, no cancellation)
      // Wait beyond continuation delay
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = (await fetch(`${daemon.url}/api/status`).then((r) => r.json())) as {
        runs: Array<Record<string, unknown>>;
      };
      // No continuation rows (project is disabled, so dequeue dropped them)
      const continuations = status.runs.filter(
        (run) => run["isContinuation"] === true
      );
      expect(continuations).toHaveLength(0);
      // Only the original succeeded run
      expect(status.runs).toHaveLength(1);
      expect(status.runs[0]?.["state"]).toBe("succeeded");

      // Provider was never cancelled
      expect(provider.cancel).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it("does not dispatch new work when the only project is disabled at startup", async () => {
    const root = await makeTempRoot();
    await mkdir(preparedWorkspaceFixture(root).workspacePath, { recursive: true });
    await writeProject(root, { disabled: true });

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: {}
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(null),
      listOpenIssues: vi
        .fn()
        .mockResolvedValue([{ ...baseIssue, labels: ["agent-ready"] }]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(preparedWorkspaceFixture(root))
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: fastContinuationPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const status = (await fetch(`${daemon.url}/api/status`).then((r) => r.json())) as {
        runs: Array<Record<string, unknown>>;
      };
      expect(status.runs).toHaveLength(0);
      expect(provider.validate).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });
});
