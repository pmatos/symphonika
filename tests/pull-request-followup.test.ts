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
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import {
  pullRequestNeedsReviewFollowup,
  pullRequestReadyToMerge,
  runPullRequestFollowup
} from "../src/pull-request-followup.js";
import { interpretPullRequest } from "../src/pull-request-state.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-pr-followup-"));
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

describe("pull request follow-up", () => {
  it("re-dispatches review feedback against the existing branch and records the follow-up run", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-review-followup";
      const workspacePath = path.join(
        root,
        ".symphonika",
        "workspaces",
        "symphonika",
        "issues",
        "54-review-followup"
      );
      await createGitWorkspaceAhead({ branchName, workspacePath });
      seedSucceededRun(store, {
        branchName,
        runId: "parent-run",
        workspacePath
      });

      const providerInputs: ProviderRunInput[] = [];
      const provider = fakeProvider(providerInputs);
      const project = projectConfig();
      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi.fn().mockResolvedValue(issueFixture()),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(
          prState({
            reviewDecision: "CHANGES_REQUESTED",
            unresolvedReviewThreads: [
              {
                comments: [
                  {
                    author: "reviewer",
                    body: "Please wire this into the daemon poll loop.",
                    createdAt: "2026-05-04T10:00:00Z",
                    line: 24,
                    path: "src/daemon.ts",
                    url: "https://github.com/pmatos/symphonika/pull/81#discussion_r1"
                  }
                ],
                id: "PRRT_kwDO",
                isResolved: false,
                line: 24,
                path: "src/daemon.ts"
              }
            ]
          })
        ),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        listPullRequestsForBranch: vi.fn().mockResolvedValue([
          {
            draft: false,
            head: { ref: branchName, sha: "abc123" },
            html_url: "https://github.com/pmatos/symphonika/pull/81",
            number: 81,
            state: "open"
          }
        ]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };
      const controller = runController({
        githubIssuesApi,
        project,
        provider,
        root,
        runStore: store,
        workspacePath
      });

      const result = await runPullRequestFollowup({
        configPath: path.join(root, "symphonika.yml"),
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        logger: pino({ enabled: false }),
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        runController: controller,
        runStore: store
      });

      expect(result).toEqual({
        action: "review_dispatch",
        prNumber: 81,
        runId: "review-run-1"
      });
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]!.branchName).toBe(branchName);
      expect(providerInputs[0]!.prompt).toContain(
        "Pull request review follow-up"
      );
      expect(providerInputs[0]!.prompt).toContain(
        "Please wire this into the daemon poll loop."
      );
      expect(providerInputs[0]!.prompt).toContain(
        "Do not open a second pull request"
      );

      const reviewRun = store.getRun("review-run-1");
      expect(reviewRun).toMatchObject({
        continuationParentRunId: "parent-run",
        isContinuation: true,
        issueNumber: 54,
        state: "succeeded"
      });
      const [tracked] = store.listOpenTrackedPullRequests();
      expect(tracked).toMatchObject({
        lastFollowupRunId: "review-run-1",
        prNumber: 81,
        reviewDispatchCount: 1
      });
    } finally {
      store.close();
    }
  });

  it("persists that unresolved review feedback exhausted the dispatch cap", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-review-followup";
      const workspacePath = path.join(root, "workspace");
      seedSucceededRun(store, {
        branchName,
        runId: "parent-run",
        workspacePath
      });
      store.trackPullRequest({
        branchName,
        headSha: "abc123",
        issueNumber: 54,
        prNumber: 81,
        prUrl: "https://example.test/pr/81",
        projectName: "symphonika",
        runId: "parent-run"
      });
      const tracked = store.listOpenTrackedPullRequests()[0]!;
      for (let dispatch = 1; dispatch <= 3; dispatch += 1) {
        store.recordPullRequestReviewDispatch({
          fingerprint: `feedback-${dispatch}`,
          headSha: "abc123",
          id: tracked.id,
          runId: `review-run-${dispatch}`
        });
      }

      const project = projectConfig();
      const getPullRequestFollowupState = vi.fn().mockResolvedValue(
        prState({
          reviewDecision: "CHANGES_REQUESTED",
          unresolvedReviewThreads: [
            {
              comments: [],
              id: "PRRT_cap_reached",
              isResolved: false,
              line: 24,
              path: "src/daemon.ts"
            }
          ]
        })
      );
      const githubIssuesApi: GitHubIssuesApi = {
        getPullRequestFollowupState,
        listOpenIssues: vi.fn().mockResolvedValue([]),
        listPullRequestsForBranch: vi.fn().mockResolvedValue([])
      };

      const result = await runPullRequestFollowup({
        configPath: path.join(root, "symphonika.yml"),
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        runController: runController({
          githubIssuesApi,
          project,
          provider: fakeProvider([]),
          root,
          runStore: store,
          workspacePath
        }),
        runStore: store
      });

      expect(result).toEqual({
        action: "none",
        reason: "no pull request follow-up action"
      });
      expect(store.listOpenTrackedPullRequests()[0]).toMatchObject({
        reviewDispatchCount: 3,
        reviewFollowupCapReached: true
      });

      getPullRequestFollowupState.mockRejectedValueOnce(
        new Error("transient GitHub failure")
      );
      await runPullRequestFollowup({
        configPath: path.join(root, "symphonika.yml"),
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        runController: runController({
          githubIssuesApi,
          project,
          provider: fakeProvider([]),
          root,
          runStore: store,
          workspacePath
        }),
        runStore: store
      });
      expect(store.listOpenTrackedPullRequests()[0]).toMatchObject({
        reviewFollowupCapReached: true
      });

      getPullRequestFollowupState.mockResolvedValueOnce(
        prState({
          reviewDecision: "APPROVED",
          statusCheckRollupState: "PENDING",
          unresolvedReviewThreads: []
        })
      );
      await runPullRequestFollowup({
        configPath: path.join(root, "symphonika.yml"),
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        runController: runController({
          githubIssuesApi,
          project,
          provider: fakeProvider([]),
          root,
          runStore: store,
          workspacePath
        }),
        runStore: store
      });
      expect(store.listOpenTrackedPullRequests()[0]).toMatchObject({
        reviewFollowupCapReached: false
      });
    } finally {
      store.close();
    }
  });

  it("defers auto-merge when the issue has a waiting merge_pr run so the workflow's method override wins", async () => {
    const root = await makeTempRoot();
    await writeMergePrProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-merge-pr-precedence";
      seedSucceededRun(store, {
        branchName,
        runId: "parent-run",
        workspacePath: path.join(root, "workspace")
      });
      const project = mergePrProjectConfig();
      // Existing tracked PR row that the global follow-up loop would otherwise
      // happily merge on this very tick.
      store.trackPullRequest({
        branchName,
        headSha: "abc123",
        issueNumber: 54,
        prNumber: 82,
        prUrl: "https://example.test/pr/82",
        projectName: "symphonika",
        runId: "parent-run"
      });
      // A waiting merge_pr run parked on the same issue must claim the merge.
      store.createWaitingRun({
        currentStateId: "merging",
        id: "merge-pr-run",
        issue: normalizedIssue(),
        parentRunId: "parent-run",
        projectName: "symphonika"
      });

      const githubIssuesApi: GitHubIssuesApi = {
        getPullRequestFollowupState: vi.fn().mockResolvedValue(prState()),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined)
      };
      const controller = runController({
        githubIssuesApi,
        project,
        provider: fakeProvider([]),
        root,
        runStore: store,
        workspacePath: path.join(root, "workspace")
      });

      const result = await runPullRequestFollowup({
        configPath: path.join(root, "symphonika.yml"),
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        runController: controller,
        runStore: store
      });

      expect(result).toEqual({
        action: "none",
        reason: "no pull request follow-up action"
      });
      expect(githubIssuesApi.mergePullRequest).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("auto-merges a tracked PR when reviews are clear, checks pass, and GitHub says it is mergeable", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-clean-pr";
      seedSucceededRun(store, {
        branchName,
        runId: "parent-run",
        workspacePath: path.join(root, "workspace")
      });
      const project = projectConfig();
      const githubIssuesApi: GitHubIssuesApi = {
        getPullRequestFollowupState: vi.fn().mockResolvedValue(prState()),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        listPullRequestsForBranch: vi.fn().mockResolvedValue([
          {
            draft: false,
            head: { ref: branchName, sha: "abc123" },
            html_url: "https://github.com/pmatos/symphonika/pull/82",
            number: 82,
            state: "open"
          }
        ]),
        mergePullRequest: vi.fn().mockResolvedValue(undefined)
      };
      const controller = runController({
        githubIssuesApi,
        project,
        provider: fakeProvider([]),
        root,
        runStore: store,
        workspacePath: path.join(root, "workspace")
      });

      const result = await runPullRequestFollowup({
        configPath: path.join(root, "symphonika.yml"),
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        runController: controller,
        runStore: store
      });

      expect(result).toEqual({ action: "merged", prNumber: 82 });
      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledWith({
        expectedHeadSha: "abc123",
        method: "squash",
        owner: "pmatos",
        pullNumber: 82,
        repo: "symphonika",
        token: "secret-token"
      });
      expect(store.listOpenTrackedPullRequests()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("skips the review-followup dispatch when a state_advance is already scheduled for the same issue", async () => {
    // Regression for the wait→agent race: reconcileWaitingRuns advances a
    // wait state into an agent state and schedules a state_advance, but the
    // scheduled item is only in `activeRuns.scheduled` (not `entries`). PR
    // follow-up runs later in the same tick and must NOT dispatch a parallel
    // review-followup for the same issue.
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-review-followup-race";
      const workspacePath = path.join(root, "workspace");
      seedSucceededRun(store, {
        branchName,
        runId: "parent-run",
        workspacePath
      });

      const providerInputs: ProviderRunInput[] = [];
      const provider = fakeProvider(providerInputs);
      const project = projectConfig();
      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi.fn().mockResolvedValue(issueFixture()),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(
          prState({
            reviewDecision: "CHANGES_REQUESTED",
            unresolvedReviewThreads: [
              {
                comments: [],
                id: "PRRT_kwDO",
                isResolved: false,
                line: 24,
                path: "src/daemon.ts"
              }
            ]
          })
        ),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        listPullRequestsForBranch: vi.fn().mockResolvedValue([
          {
            draft: false,
            head: { ref: branchName, sha: "abc123" },
            html_url: "https://github.com/pmatos/symphonika/pull/82",
            number: 82,
            state: "open"
          }
        ]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      // Use a controller whose schedule handler actually goes through
      // ActiveRunRegistry.scheduleDelayed so the scheduled state_advance is
      // visible to the issue-reservation facade. Keep the timeouts long enough
      // that the fire() never runs during the test.
      const activeRuns = new ActiveRunRegistry();
      let nextRun = 0;
      const controller = new RunController({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createRunId: () => {
          nextRun += 1;
          return `race-run-${nextRun}`;
        },
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        prepareIssueWorkspace: () =>
          Promise.resolve({
            branchName,
            branchRef: `refs/heads/${branchName}`,
            cachePath: path.join(root, ".symphonika", "workspaces", ".cache"),
            issueDirectoryName: "54-review-followup-race",
            reused: true,
            workspacePath
          }),
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        providersLoader: () => Promise.resolve(providersConfig()),
        runStore: store,
        schedule: (item) => {
          activeRuns.scheduleDelayed({
            delayMs: 60_000,
            fire: item.fire,
            issueNumber: item.issueNumber,
            kind: item.kind,
            projectName: item.projectName,
            runId: item.runId
          });
        },
        stateRoot: path.join(root, ".symphonika")
      });

      // Simulate the wait→agent advance: pretend the reconciler just
      // scheduled a state_advance for issue 54.
      activeRuns.scheduleDelayed({
        delayMs: 60_000,
        fire: () => Promise.resolve(),
        issueNumber: 54,
        kind: "state_advance",
        projectName: project.name,
        runId: "parent-run"
      });

      const result = await runPullRequestFollowup({
        configPath: path.join(root, "symphonika.yml"),
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        runController: controller,
        runStore: store
      });

      // PR follow-up either declined explicitly or did not produce a
      // review_dispatch — what matters is that no provider attempt fired.
      expect(result.action).not.toBe("review_dispatch");
      expect(providerInputs).toHaveLength(0);

      activeRuns.cancelAll();
    } finally {
      store.close();
    }
  });

  it("does not merge when status checks are missing under the default policy", () => {
    expect(
      pullRequestReadyToMerge(
        interpretPullRequest(
          prState({
            statusCheckRollupState: null
          })
        )
      )
    ).toBe(false);
  });

  it("needs review follow-up when requested changes are unresolved", () => {
    expect(
      pullRequestNeedsReviewFollowup(
        interpretPullRequest(
          prState({
            reviewDecision: "CHANGES_REQUESTED"
          })
        )
      )
    ).toBe(true);
  });

  it("needs review follow-up when unresolved review threads remain", () => {
    expect(
      pullRequestNeedsReviewFollowup(
        interpretPullRequest(
          prState({
            unresolvedReviewThreads: [
              {
                comments: [],
                id: "PRRT_kwDO",
                isResolved: false,
                line: 24,
                path: "src/daemon.ts"
              }
            ]
          })
        )
      )
    ).toBe(true);
  });
});

function runController(input: {
  githubIssuesApi: GitHubIssuesApi;
  project: RunControllerProjectConfig;
  provider: AgentProvider;
  root: string;
  runStore: RunStore;
  workspacePath: string;
}): RunController {
  let nextRun = 0;
  return new RunController({
    activeRuns: new ActiveRunRegistry(),
    agentProviders: { codex: input.provider },
    configDir: input.root,
    createRunId: () => {
      nextRun += 1;
      return `review-run-${nextRun}`;
    },
    env: { GITHUB_TOKEN: "secret-token" },
    githubIssuesApi: input.githubIssuesApi,
    prepareIssueWorkspace: () =>
      Promise.resolve({
        branchName: input.project.workspace.git.remote.includes("symphonika")
          ? "sym/symphonika/54-review-followup"
          : "unused",
        branchRef: "refs/heads/sym/symphonika/54-review-followup",
        cachePath: path.join(input.root, ".symphonika", "workspaces", ".cache"),
        issueDirectoryName: "54-review-followup",
        reused: true,
        workspacePath: input.workspacePath
      }),
    projectsLoader: () =>
      Promise.resolve(new Map([[input.project.name, input.project]])),
    providersLoader: () => Promise.resolve(providersConfig()),
    runStore: input.runStore,
    schedule: () => undefined,
    stateRoot: path.join(input.root, ".symphonika")
  });
}

function fakeProvider(providerInputs: ProviderRunInput[]): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    runAttempt: vi.fn(async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      providerInputs.push(input);
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

function providersConfig(): RunControllerProvidersConfig {
  return {
    claude: {
      command:
        "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"
    },
    codex: { command: DEFAULT_CODEX_COMMAND }
  };
}

function projectConfig(): RunControllerProjectConfig {
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
    workflow: { format: "auto", path: "./WORKFLOW.md" },
    workspace: {
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      root: "./.symphonika/workspaces/symphonika"
    }
  };
}

function seedSucceededRun(
  store: RunStore,
  input: { branchName: string; runId: string; workspacePath: string }
): void {
  store.createRun({
    id: input.runId,
    issue: normalizedIssue(),
    projectName: "symphonika",
    providerCommand: DEFAULT_CODEX_COMMAND,
    providerName: "codex"
  });
  store.updateRunEvidence(input.runId, {
    branchName: input.branchName,
    branchRef: `refs/heads/${input.branchName}`,
    issueSnapshotPath: "/tmp/issue-snapshot.json",
    metadataPath: "/tmp/prompt-metadata.json",
    normalizedLogPath: "/tmp/provider.normalized.jsonl",
    promptPath: "/tmp/prompt.md",
    rawLogPath: "/tmp/provider.raw.jsonl",
    workflowGraphPath: "/tmp/workflow-graph.json",
    workspacePath: input.workspacePath
  });
  store.updateRunState(input.runId, "succeeded");
}

async function writeProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "providers:",
      "  codex:",
      `    command: "${DEFAULT_CODEX_COMMAND}"`,
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects: []",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    [
      "# Issue #{{issue.number}}",
      "",
      "{{issue.body}}",
      "",
      "Branch: {{branch.name}}",
      ""
    ].join("\n")
  );
}

async function writeMergePrProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "providers:",
      "  codex:",
      `    command: "${DEFAULT_CODEX_COMMAND}"`,
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects: []",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: merge_pr_precedence",
      "  initial: merging",
      "  states:",
      "    merging:",
      "      action:",
      "        kind: merge_pr",
      "        method: merge",
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

function mergePrProjectConfig(): RunControllerProjectConfig {
  return {
    ...projectConfig(),
    workflow: { format: "auto", path: "./workflow.yml" }
  };
}

function issueFixture() {
  return {
    body: "Original issue body",
    created_at: "2026-05-03T10:00:00Z",
    html_url: "https://github.com/pmatos/symphonika/issues/54",
    id: 5054,
    labels: [{ name: "sym:claimed" }],
    number: 54,
    state: "open",
    title: "Re-dispatch on PR review feedback",
    updated_at: "2026-05-04T10:00:00Z"
  };
}

function normalizedIssue() {
  return {
    body: "Original issue body",
    created_at: "2026-05-03T10:00:00Z",
    id: 5054,
    labels: ["sym:claimed"],
    number: 54,
    priority: 99,
    state: "open",
    title: "Re-dispatch on PR review feedback",
    updated_at: "2026-05-04T10:00:00Z",
    url: "https://github.com/pmatos/symphonika/issues/54"
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
    number: 81,
    reviewDecision: "APPROVED",
    state: "OPEN",
    statusCheckRollupState: "SUCCESS",
    unresolvedReviewThreads: [],
    url: "https://github.com/pmatos/symphonika/pull/81",
    ...overrides
  };
}
