import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GitHubIssuesApi,
  RawGitHubPullRequestFollowupState
} from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "../src/lifecycle/run-controller.js";
import type { ProviderEvent } from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";

// Issue #730 root cause #2: implement's completion gate only checks local
// git state (provider_success + branch_ahead_of_base), never that the
// branch reached origin or that a pull request exists. The fix inserts a
// wait_for_pr_open state (mirroring workflow.yml) between implement and
// code_review_fix, reusing the same tracked-PR-by-issue mechanism
// wait_for_pr already relies on. These tests exercise that exact predicate
// shape directly, decoupled from the rest of the real chain.

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-wait-pr-open-"));
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

function issueFixture() {
  return {
    body: "wait_for_pr_open acceptance fixture.",
    created_at: "2026-09-10T10:00:00Z",
    html_url: "https://github.com/pmatos/symphonika/issues/10",
    id: 5010,
    labels: ["agent-ready"],
    number: 10,
    priority: 99,
    state: "open" as const,
    title: "wait_for_pr_open acceptance fixture",
    updated_at: "2026-09-10T11:00:00Z",
    url: "https://github.com/pmatos/symphonika/issues/10"
  };
}

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "10-wait-for-pr-open-fixture"
  );
  return {
    branchName: "sym/symphonika/10-wait-for-pr-open-fixture",
    branchRef: "refs/heads/sym/symphonika/10-wait-for-pr-open-fixture",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "10-wait-for-pr-open-fixture",
    reused: false,
    workspacePath
  };
}

async function writeWaitForPrOpenProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      `    command: "${DEFAULT_CODEX_COMMAND}"`,
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
  // Same shape as this repo's own workflow.yml: implement hands off to a
  // wait state gated on the tracked PR actually being open before code
  // review can run against it.
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: wait_for_pr_open_fixture",
      "  initial: implement",
      "  states:",
      "    implement:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: implement-prompt.md",
      "      transitions:",
      "        - to: wait_for_pr_open",
      "    wait_for_pr_open:",
      "      action:",
      "        kind: wait",
      "      transitions:",
      "        - to: merged",
      "          when:",
      "            pr_merged: true",
      "        - to: failed",
      "          when:",
      "            pr_open: false",
      "        - to: code_review_fix",
      "          when:",
      "            pr_open: true",
      "    code_review_fix:",
      "      terminal: success",
      "    merged:",
      "      terminal: success",
      "    failed:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "implement-prompt.md"),
    "Implement #{{issue.number}}.\n"
  );
}

function prState(
  overrides: Partial<RawGitHubPullRequestFollowupState> = {}
): RawGitHubPullRequestFollowupState {
  return {
    draft: false,
    headSha: "deadbeef",
    mergeable: "MERGEABLE",
    merged: false,
    number: 99,
    reviewDecision: "APPROVED",
    state: "OPEN",
    statusCheckRollupState: "SUCCESS",
    unresolvedReviewThreads: [],
    url: "https://example.test/pr/99",
    ...overrides
  };
}

function buildController(input: {
  githubIssuesApi: GitHubIssuesApi;
  project: RunControllerProjectConfig;
  root: string;
  runStore: ReturnType<typeof openRunStore>;
}): RunController {
  let nextRun = 0;
  return new RunController({
    activeRuns: new ActiveRunRegistry(),
    agentProviders: {
      codex: {
        cancel: vi.fn().mockResolvedValue(undefined),
        name: "codex",
        runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
          await Promise.resolve();
          yield {
            normalized: { exitCode: 0, type: "process_exit" },
            raw: { code: 0, kind: "exit" }
          };
        }),
        validate: vi.fn().mockResolvedValue(undefined)
      }
    },
    configDir: input.root,
    createRunId: () => `wait-pr-open-rerun-${++nextRun}`,
    emailConfigLoader: () => undefined,
    env: { GITHUB_TOKEN: "secret-token" },
    githubIssuesApi: input.githubIssuesApi,
    lifecyclePolicy: {
      continuation: { cap: 0, delayMs: 0 },
      retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
    },
    logger: pino({ enabled: false }),
    prepareIssueWorkspace: () =>
      Promise.resolve(preparedWorkspaceFixture(input.root)),
    projectsLoader: () =>
      Promise.resolve(new Map([[input.project.name, input.project]])),
    providersLoader: (): Promise<RunControllerProvidersConfig> =>
      Promise.resolve({
        claude: { command: "claude" },
        codex: { command: DEFAULT_CODEX_COMMAND }
      }),
    runStore: input.runStore,
    schedule: () => true,
    stateRoot: path.join(input.root, ".symphonika")
  });
}

function projectFixture(workflowPath: string): RunControllerProjectConfig {
  return {
    mode: "dispatch",
    agent: { provider: "codex" },
    issue_filters: {
      labels_all: ["agent-ready"],
      labels_none: ["blocked", "needs-human"],
      states: ["open"]
    },
    name: "symphonika",
    priority: { default: 99, labels: {} },
    tracker: {
      kind: "github",
      owner: "pmatos",
      repo: "symphonika",
      token: "$GITHUB_TOKEN"
    },
    workflow: { format: "auto", path: workflowPath },
    workspace: {
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      root: "./.symphonika/workspaces/symphonika"
    }
  };
}

describe("wait_for_pr_open gates implement's handoff on an actual PR (issue #730)", () => {
  it("advances to code_review_fix once the tracked pull request is open", async () => {
    const root = await makeTempRoot();
    await writeWaitForPrOpenProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      store.createRun({
        id: "parent-run",
        issue,
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.updateRunState("parent-run", "succeeded");
      store.createWaitingRun({
        currentStateId: "wait_for_pr_open",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/10-wait-for-pr-open-fixture",
        headSha: "deadbeef",
        issueNumber: issue.number,
        prNumber: 99,
        prUrl: "https://example.test/pr/99",
        projectName: "symphonika",
        runId: "parent-run"
      });

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(prState()),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("waiting-run");

      const after = store.getRun("waiting-run");
      expect(after?.state).toBe("succeeded");
      expect(after?.terminalStateId).toBe("code_review_fix");
    } finally {
      store.close();
    }
  });

  it("terminalizes blocked when the tracked pull request closed without merging", async () => {
    const root = await makeTempRoot();
    await writeWaitForPrOpenProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      store.createRun({
        id: "parent-run",
        issue,
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.updateRunState("parent-run", "succeeded");
      store.createWaitingRun({
        currentStateId: "wait_for_pr_open",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/10-wait-for-pr-open-fixture",
        headSha: "deadbeef",
        issueNumber: issue.number,
        prNumber: 99,
        prUrl: "https://example.test/pr/99",
        projectName: "symphonika",
        runId: "parent-run"
      });

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi
          .fn()
          .mockResolvedValue(prState({ merged: false, state: "CLOSED" })),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("waiting-run");

      const after = store.getRun("waiting-run");
      expect(after?.state).toBe("blocked");
      expect(after?.terminalStateId).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("stays parked when no pull request is tracked yet", async () => {
    const root = await makeTempRoot();
    await writeWaitForPrOpenProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      store.createRun({
        id: "parent-run",
        issue,
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.updateRunState("parent-run", "succeeded");
      store.createWaitingRun({
        currentStateId: "wait_for_pr_open",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(prState()),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("waiting-run");

      const after = store.getRun("waiting-run");
      expect(after?.state).toBe("waiting");
      expect(after?.currentStateId).toBe("wait_for_pr_open");
    } finally {
      store.close();
    }
  });

  it("does not treat a stale PR tracked for a different branch as this run's PR (issue #736 review)", async () => {
    const root = await makeTempRoot();
    await writeWaitForPrOpenProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      // An earlier run on this same issue (e.g. before an issue-title edit
      // changed the branch name) already tracked and merged its own PR.
      store.createRun({
        id: "earlier-run",
        issue,
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/10-old-title-before-edit",
        headSha: "old-sha",
        issueNumber: issue.number,
        prNumber: 77,
        prUrl: "https://example.test/pr/77",
        projectName: "symphonika",
        runId: "earlier-run"
      });
      store.recordPullRequestObservation({
        headSha: "old-sha",
        id: 1,
        prUrl: "https://example.test/pr/77",
        reviewFollowupCapReached: false,
        state: "merged"
      });

      // A fresh run was redispatched onto a new branch and has not pushed or
      // opened a PR of its own yet.
      store.createRun({
        id: "parent-run",
        issue,
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.updateRunState("parent-run", "succeeded");
      store.createWaitingRun({
        branchName: "sym/symphonika/10-wait-for-pr-open-fixture",
        currentStateId: "wait_for_pr_open",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(prState()),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("waiting-run");

      // The stale, merged PR on the old branch must not resolve this wait --
      // it falls through to the untracked-wait counting path and stays
      // parked on wait_for_pr_open instead of falsely reading pr_merged.
      const after = store.getRun("waiting-run");
      expect(after?.state).toBe("waiting");
      expect(after?.currentStateId).toBe("wait_for_pr_open");
      expect(
        githubIssuesApi.getPullRequestFollowupState
      ).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("finds this run's own tracked PR even when a different branch's row is newer (issue #736 review, round 2)", async () => {
    const root = await makeTempRoot();
    await writeWaitForPrOpenProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      // This run's own PR is tracked first (lower id) ...
      store.createRun({
        id: "parent-run",
        issue,
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.updateRunState("parent-run", "succeeded");
      store.createWaitingRun({
        branchName: "sym/symphonika/10-wait-for-pr-open-fixture",
        currentStateId: "wait_for_pr_open",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/10-wait-for-pr-open-fixture",
        headSha: "deadbeef",
        issueNumber: issue.number,
        prNumber: 99,
        prUrl: "https://example.test/pr/99",
        projectName: "symphonika",
        runId: "parent-run"
      });
      // ... but a later redispatch onto a different branch tracks a second,
      // newer-by-id row for the same issue. The newest row is not this run's
      // own PR, so an issue-wide "newest row" lookup must not shadow it.
      store.createRun({
        id: "later-run",
        issue,
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/10-later-redispatch",
        headSha: "cafebabe",
        issueNumber: issue.number,
        prNumber: 100,
        prUrl: "https://example.test/pr/100",
        projectName: "symphonika",
        runId: "later-run"
      });

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(prState()),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("waiting-run");

      const after = store.getRun("waiting-run");
      expect(after?.state).toBe("succeeded");
      expect(after?.terminalStateId).toBe("code_review_fix");
      expect(githubIssuesApi.getPullRequestFollowupState).toHaveBeenCalledWith(
        expect.objectContaining({ pullNumber: 99 })
      );
    } finally {
      store.close();
    }
  });
});
