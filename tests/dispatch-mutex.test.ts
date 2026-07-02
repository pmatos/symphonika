import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { LifecyclePolicy } from "../src/lifecycle/active-runs.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { createDeferred } from "./helpers/deferred.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-mutex-test-"));
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
  workflowTemplate: string
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
  const timeoutMs = options.timeoutMs ?? 10_000;
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
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
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
      getIssue: vi
        .fn()
        .mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
      listBranchCommits: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
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
            run["terminalReason"] === "cap_reached:no_commits"
        )
      );

      expect(maxActive).toBe(1);
    } finally {
      await daemon.stop();
    }
  });

  it("renders run.continuation as true on continuation runs and false on the fresh run", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
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
      getIssue: vi
        .fn()
        .mockResolvedValue({ ...baseIssue, labels: ["agent-ready"] }),
      listBranchCommits: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([{ ...baseIssue, labels: ["agent-ready"] }])
        .mockResolvedValue([]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    );

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-cont-flag-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 1, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
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
            run["terminalReason"] === "cap_reached:no_commits"
        )
      );

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        runs: Array<Record<string, unknown>>;
      };

      const fresh = status.runs.find(
        (run) => run["state"] === "succeeded" && run["isContinuation"] === false
      );
      const continuation = status.runs.find(
        (run) => run["state"] === "succeeded" && run["isContinuation"] === true
      );
      expect(fresh).toBeDefined();
      expect(continuation).toBeDefined();
      const freshId = fresh?.["id"];
      const continuationId = continuation?.["id"];
      if (typeof freshId !== "string" || typeof continuationId !== "string") {
        throw new Error("expected fresh and continuation run ids");
      }

      const freshPrompt = await fetchRunArtifact(daemon.url, freshId, "prompt");
      const continuationPrompt = await fetchRunArtifact(
        daemon.url,
        continuationId,
        "prompt"
      );

      expect(freshPrompt).toContain("Continuation? false");
      expect(continuationPrompt).toContain("Continuation? true");
    } finally {
      await daemon.stop();
    }
  });
});

describe("dispatch concurrency (slice 1 narrowing)", () => {
  it("runs two fresh dispatches concurrently when two projects have ready issues", async () => {
    const root = await makeTempRoot();

    async function preparedFor(
      projectName: string,
      issueNumber: number,
      slug: string
    ): Promise<PreparedIssueWorkspace> {
      const workspacePath = path.join(
        root,
        ".symphonika",
        "workspaces",
        projectName,
        "issues",
        `${issueNumber}-${slug}`
      );
      const prepared: PreparedIssueWorkspace = {
        branchName: `sym/${projectName}/${issueNumber}-${slug}`,
        branchRef: `refs/heads/sym/${projectName}/${issueNumber}-${slug}`,
        cachePath: path.join(
          root,
          ".symphonika",
          "workspaces",
          projectName,
          ".cache",
          "repo.git"
        ),
        issueDirectoryName: `${issueNumber}-${slug}`,
        reused: false,
        workspacePath
      };
      await createGitWorkspaceAhead(prepared);
      return prepared;
    }

    const issueA = {
      ...baseIssue,
      id: 6001,
      number: 11,
      title: "Project A issue"
    };
    const issueB = {
      ...baseIssue,
      id: 6002,
      number: 22,
      title: "Project B issue"
    };

    const preparedByIssue = new Map<number, PreparedIssueWorkspace>();
    preparedByIssue.set(
      11,
      await preparedFor("project-a", 11, "project-a-issue")
    );
    preparedByIssue.set(
      22,
      await preparedFor("project-b", 22, "project-b-issue")
    );

    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "polling:",
        "  interval_ms: 25",
        "providers:",
        "  codex:",
        '    command: "codex"',
        "  claude:",
        '    command: "claude"',
        "projects:",
        "  - name: project-a",
        "    disabled: false",
        "    weight: 1",
        "    tracker:",
        "      kind: github",
        "      owner: acme",
        "      repo: project-a",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked", "needs-human"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/project-a",
        "      git:",
        "        remote: git@github.com:acme/project-a.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        "  - name: project-b",
        "    disabled: false",
        "    weight: 1",
        "    tracker:",
        "      kind: github",
        "      owner: acme",
        "      repo: project-b",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked", "needs-human"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/project-b",
        "      git:",
        "        remote: git@github.com:acme/project-b.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n")
    );
    await writeFile(path.join(root, "WORKFLOW.md"), "Work {{issue.number}}\n");

    const gate = createDeferred<void>();
    let active = 0;
    let maxActive = 0;
    const enteredCount = createDeferred<void>();
    let enteredObserved = 0;

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        active += 1;
        if (active > maxActive) {
          maxActive = active;
        }
        enteredObserved += 1;
        if (enteredObserved >= 2) {
          enteredCount.resolve();
        }
        try {
          await gate.promise;
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

    const issuesByProject = new Map<string, typeof baseIssue>([
      ["project-a", issueA],
      ["project-b", issueB]
    ]);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi
        .fn()
        .mockImplementation(({ issueNumber }: { issueNumber: number }) => {
          const issue =
            issueNumber === 11
              ? issueA
              : issueNumber === 22
                ? issueB
                : baseIssue;
          return Promise.resolve({ ...issue, labels: ["agent-ready"] });
        }),
      listBranchCommits: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi
        .fn()
        .mockImplementation(
          ({ owner, repo }: { owner: string; repo: string }) => {
            const projectName =
              owner === "acme" && repo === "project-a"
                ? "project-a"
                : owner === "acme" && repo === "project-b"
                  ? "project-b"
                  : undefined;
            if (projectName === undefined) return Promise.resolve([]);
            const issue = issuesByProject.get(projectName);
            if (issue === undefined) return Promise.resolve([]);
            return Promise.resolve([{ ...issue, labels: ["agent-ready"] }]);
          }
        ),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };

    const prepareIssueWorkspace = vi.fn(
      ({
        issue
      }: {
        issue: { number: number };
      }): Promise<PreparedIssueWorkspace> => {
        const prepared = preparedByIssue.get(issue.number);
        if (prepared === undefined) {
          return Promise.reject(
            new Error(`no prepared workspace for issue ${issue.number}`)
          );
        }
        return Promise.resolve(prepared);
      }
    );

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-concurrent-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Drive a few ticks to ensure both projects' fresh dispatches enter the
      // provider event stream. Each pollNow triggers a single launchWork which
      // dispatches one issue; the second tick picks the other project's issue.
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });

      // Wait for both providers to be in their runAttempt body simultaneously.
      const timeoutId = setTimeout(() => {
        enteredCount.reject(
          new Error(
            `expected 2 concurrent runAttempts; observed ${enteredObserved} (active=${active}, maxActive=${maxActive})`
          )
        );
      }, 5_000);
      await enteredCount.promise.finally(() => clearTimeout(timeoutId));

      expect(maxActive).toBe(2);
    } finally {
      gate.resolve();
      await daemon.stop();
    }
  });
});

async function fetchRunArtifact(
  daemonUrl: string,
  runId: string,
  kind: string
): Promise<string> {
  const response = await fetch(
    `${daemonUrl}/logs/runs/${encodeURIComponent(runId)}/${encodeURIComponent(kind)}`
  );
  if (!response.ok) {
    throw new Error(
      `expected artifact ${kind} for ${runId}: HTTP ${response.status}`
    );
  }
  return response.text();
}
