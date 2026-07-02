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
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY } from "../src/pull-request-followup.js";
import { openRunStore } from "../src/run-store.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-merge-pr-"));
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

function issueFixture(): {
  body: string;
  created_at: string;
  id: number;
  labels: string[];
  number: number;
  priority: number;
  state: "open";
  title: string;
  updated_at: string;
  url: string;
} {
  return {
    body: "merge_pr acceptance fixture.",
    created_at: "2026-05-10T10:00:00Z",
    id: 5097,
    labels: ["agent-ready"],
    number: 97,
    priority: 99,
    state: "open",
    title: "merge_pr acceptance fixture",
    updated_at: "2026-05-11T11:00:00Z",
    url: "https://github.com/pmatos/symphonika/issues/97"
  };
}

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "97-merge-pr-acceptance-fixture"
  );
  return {
    branchName: "sym/symphonika/97-merge-pr-acceptance-fixture",
    branchRef: "refs/heads/sym/symphonika/97-merge-pr-acceptance-fixture",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "97-merge-pr-acceptance-fixture",
    reused: false,
    workspacePath
  };
}

function prState(
  overrides: Partial<RawGitHubPullRequestFollowupState> = {}
): RawGitHubPullRequestFollowupState {
  return {
    draft: false,
    headSha: "abc123",
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

function projectFixture(workflowPath: string): RunControllerProjectConfig {
  return {
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

function noopCodex(): AgentProvider {
  return {
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
  };
}

function buildController(input: {
  githubIssuesApi: GitHubIssuesApi;
  project: RunControllerProjectConfig;
  pullRequestPolicy?: typeof DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY;
  root: string;
  runStore: ReturnType<typeof openRunStore>;
}): RunController {
  return new RunController({
    activeRuns: new ActiveRunRegistry(),
    agentProviders: { codex: noopCodex() },
    configDir: input.root,
    createRunId: () => "merge-pr-rerun",
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
    pullRequestPolicyLoader: () =>
      Promise.resolve(
        input.pullRequestPolicy ?? DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY
      ),
    runStore: input.runStore,
    schedule: () => undefined,
    stateRoot: path.join(input.root, ".symphonika")
  });
}

async function writeMergePrWorkflow(root: string): Promise<void> {
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: merge_when_clear",
      "  initial: merging",
      "  states:",
      "    merging:",
      "      action:",
      "        kind: merge_pr",
      "        method: squash",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            pr_merged: true",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
}

function seedWaitingMergePrRun(
  store: ReturnType<typeof openRunStore>,
  issue: ReturnType<typeof issueFixture>
): void {
  store.createRun({
    id: "parent-run",
    issue,
    projectName: "symphonika",
    providerCommand: DEFAULT_CODEX_COMMAND,
    providerName: "codex"
  });
  store.updateRunState("parent-run", "succeeded");
  store.createWaitingRun({
    currentStateId: "merging",
    id: "merge-pr-run",
    issue,
    parentRunId: "parent-run",
    projectName: "symphonika"
  });
}

describe("merge_pr state lifecycle", () => {
  it("merges the tracked PR and advances the workflow to terminal success", async () => {
    const root = await makeTempRoot();
    await writeMergePrWorkflow(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      seedWaitingMergePrRun(store, issue);
      store.trackPullRequest({
        branchName: "sym/symphonika/97-merge-pr-acceptance-fixture",
        headSha: "abc123",
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
        listOpenIssues: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined)
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("merge-pr-run");

      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledWith({
        expectedHeadSha: "abc123",
        method: "squash",
        owner: "pmatos",
        pullNumber: 99,
        repo: "symphonika",
        token: "secret-token"
      });

      const after = store.getRun("merge-pr-run");
      expect(after?.state).toBe("succeeded");
      expect(after?.terminalStateId).toBe("done");
      expect(after?.stateTransitionReason).toContain("pr_merged");

      // Tracked PR row reflects the merge so PR follow-up does not retry.
      const tracked = store.findTrackedPullRequestByIssue({
        issueNumber: issue.number,
        projectName: "symphonika"
      });
      expect(tracked?.state).toBe("merged");
    } finally {
      store.close();
    }
  });

  it("stays parked when the PR is not yet ready under the configured merge policy", async () => {
    const root = await makeTempRoot();
    await writeMergePrWorkflow(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      seedWaitingMergePrRun(store, issue);
      store.trackPullRequest({
        branchName: "sym/symphonika/97-merge-pr-acceptance-fixture",
        headSha: "abc123",
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
          .mockResolvedValue(prState({ statusCheckRollupState: "PENDING" })),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined)
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("merge-pr-run");

      expect(githubIssuesApi.mergePullRequest).not.toHaveBeenCalled();
      const after = store.getRun("merge-pr-run");
      expect(after?.state).toBe("waiting");
      expect(after?.terminalStateId).toBeNull();
      expect(after?.stateTransitionReason).toContain("not yet ready");
    } finally {
      store.close();
    }
  });

  it("records deterministic evidence when no PR is associated yet, without deleting workspace", async () => {
    const root = await makeTempRoot();
    await writeMergePrWorkflow(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      seedWaitingMergePrRun(store, issue);

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi.fn(),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined)
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("merge-pr-run");

      expect(
        githubIssuesApi.getPullRequestFollowupState
      ).not.toHaveBeenCalled();
      expect(githubIssuesApi.mergePullRequest).not.toHaveBeenCalled();
      const after = store.getRun("merge-pr-run");
      expect(after?.state).toBe("waiting");
      expect(after?.stateTransitionReason).toContain(
        "awaiting Symphonika-tracked pull request"
      );

      // Workspace evidence preserved: the parent run still holds its workspace path.
      const parent = store.getRun("parent-run");
      expect(parent?.state).toBe("succeeded");
    } finally {
      store.close();
    }
  });

  it("records a failure reason and stays parked when the merge API throws", async () => {
    const root = await makeTempRoot();
    await writeMergePrWorkflow(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      seedWaitingMergePrRun(store, issue);
      store.trackPullRequest({
        branchName: "sym/symphonika/97-merge-pr-acceptance-fixture",
        headSha: "abc123",
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
        listOpenIssues: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockRejectedValue(new Error("merge_conflict"))
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("merge-pr-run");

      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledTimes(1);
      const after = store.getRun("merge-pr-run");
      expect(after?.state).toBe("waiting");
      expect(after?.stateTransitionReason).toContain("merge_conflict");
    } finally {
      store.close();
    }
  });

  it("advances on transitions written as { pr_merged: true, pr_open: false } after a successful merge", async () => {
    const root = await makeTempRoot();
    // Workflow that uses the post-merge shape a refetch would produce — this
    // exercises the post-merge signal reprojection.
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: merge_then_done",
        "  initial: merging",
        "  states:",
        "    merging:",
        "      action:",
        "        kind: merge_pr",
        "      transitions:",
        "        - to: done",
        "          when:",
        "            pr_merged: true",
        "            pr_open: false",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      seedWaitingMergePrRun(store, issue);
      store.trackPullRequest({
        branchName: "sym/symphonika/97-merge-pr-acceptance-fixture",
        headSha: "abc123",
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
        listOpenIssues: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined)
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("merge-pr-run");

      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledTimes(1);
      const after = store.getRun("merge-pr-run");
      expect(after?.state).toBe("succeeded");
      expect(after?.terminalStateId).toBe("done");
    } finally {
      store.close();
    }
  });

  it("parks a fresh dispatch whose initial state is merge_pr without launching a provider", async () => {
    const root = await makeTempRoot();
    await writeMergePrWorkflow(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      const runAttempt = vi.fn(
        async function* (): AsyncGenerator<ProviderEvent> {
          await Promise.resolve();
          yield {
            normalized: { exitCode: 0, type: "process_exit" },
            raw: { code: 0, kind: "exit" }
          };
        }
      );
      const provider: AgentProvider = {
        cancel: vi.fn().mockResolvedValue(undefined),
        name: "codex",
        runAttempt,
        validate: vi.fn().mockResolvedValue(undefined)
      };

      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(prState()),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      const scheduled: Array<{ runId: string; kind: string }> = [];
      const project = projectFixture("./workflow.yml");
      const activeRuns = new ActiveRunRegistry();
      const controller = new RunController({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createRunId: () => "fresh-merge-pr-run",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        lifecyclePolicy: {
          continuation: { cap: 0, delayMs: 0 },
          retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
        },
        logger: pino({ enabled: false }),
        prepareIssueWorkspace: () =>
          Promise.resolve(preparedWorkspaceFixture(root)),
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        providersLoader: (): Promise<RunControllerProvidersConfig> =>
          Promise.resolve({
            claude: { command: "claude" },
            codex: { command: DEFAULT_CODEX_COMMAND }
          }),
        pullRequestPolicyLoader: () =>
          Promise.resolve(DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY),
        runStore: store,
        schedule: (item) => {
          scheduled.push({ kind: item.kind, runId: item.runId });
        },
        stateRoot: path.join(root, ".symphonika")
      });

      const result = await controller.dispatchOneFresh({
        candidateIssues: [{ issue, project: project.name }],
        errors: [],
        filteredIssues: [],
        projects: []
      });

      expect(result).toEqual({ dispatched: true, runId: "fresh-merge-pr-run" });
      expect(runAttempt).not.toHaveBeenCalled();
      expect(provider.validate).not.toHaveBeenCalled();
      expect(githubIssuesApi.mergePullRequest).not.toHaveBeenCalled();

      const after = store.getRun("fresh-merge-pr-run");
      expect(after?.state).toBe("waiting");
      expect(after?.currentStateId).toBe("merging");

      expect(scheduled).toEqual([
        { kind: "wait_park", runId: "fresh-merge-pr-run" }
      ]);
      // ADR 0052 slot-leak fix: the reserveSlot inside claimAndPersistRun
      // must be released even though runAttemptLifecycle took the parked-
      // state early-return path. If this assertion regresses, the issue
      // remains permanently locked and cap counters never decrement.
      expect(activeRuns.countInFlight()).toBe(0);
      expect(activeRuns.isIssueInFlight(project.name, issue.number)).toBe(
        false
      );
    } finally {
      store.close();
    }
  });

  it("defers the merge when pull_requests.merge.enabled is false", async () => {
    const root = await makeTempRoot();
    await writeMergePrWorkflow(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const issue = issueFixture();
      seedWaitingMergePrRun(store, issue);
      store.trackPullRequest({
        branchName: "sym/symphonika/97-merge-pr-acceptance-fixture",
        headSha: "abc123",
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
        listOpenIssues: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined)
      };
      const controller = buildController({
        githubIssuesApi,
        project: projectFixture("./workflow.yml"),
        pullRequestPolicy: {
          ...DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
          merge: {
            ...DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.merge,
            enabled: false
          }
        },
        root,
        runStore: store
      });

      await controller.reEvaluateWaitingRun("merge-pr-run");

      expect(githubIssuesApi.mergePullRequest).not.toHaveBeenCalled();
      const after = store.getRun("merge-pr-run");
      expect(after?.state).toBe("waiting");
      expect(after?.stateTransitionReason).toContain("merge.enabled is false");
    } finally {
      store.close();
    }
  });
});
