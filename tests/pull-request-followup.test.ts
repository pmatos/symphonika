import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emptyIssuePollStatus,
  type GitHubIssuesApi,
  type RawGitHubPullRequestFollowupState
} from "../src/issue-polling.js";
import {
  ActiveRunRegistry,
  CANCEL_REASONS
} from "../src/lifecycle/active-runs.js";
import { reconcileActiveRuns } from "../src/lifecycle/reconcile.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig,
  type ScheduleHandler
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

  it("defers to the workflow when the tracked PR's run is parked at a raw_fsm state", async () => {
    // Issue #616. The run associated with a tracked PR under follow-up is by
    // construction parked at a state of its own -- that is why it is being
    // polled at all. This loop used to dispatch anyway, re-entering the
    // workflow at `expandedWorkflow.initial`, which replayed the whole
    // pipeline against a finished PR and left the Issue with two live FSM
    // positions: the untouched parked row and the fresh chain racing it.
    //
    // Supersedes the #358 regression this replaces. That fix made the
    // dispatch actually launch an agent; the agent it launched was at the
    // wrong state. The FSM position is now the only thing that decides where
    // work resumes, so the loop observes and records but does not act.
    const root = await makeTempRoot();
    await writeRawFsmReviewFollowupProject(root);
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

      seedWaitingParentRun(store, {
        branchName,
        currentStateId: "wait_for_pr",
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

      const providerInputs: ProviderRunInput[] = [];
      const provider = fakeProvider(providerInputs);
      const project = rawFsmReviewFollowupProjectConfig();
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
        listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
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
        action: "none",
        reason: "no pull request follow-up action"
      });
      expect(providerInputs).toHaveLength(0);
      expect(store.getRun("review-run-1")).toBeUndefined();

      // The one live FSM position stays exactly where it was, still owned by
      // the workflow and still eligible for its own re-evaluation.
      expect(store.getRun("parent-run")).toMatchObject({
        currentStateId: "wait_for_pr",
        state: "waiting"
      });
      expect(store.listOpenTrackedPullRequests()[0]).toMatchObject({
        reviewDispatchCount: 0
      });
    } finally {
      store.close();
    }
  });

  it("defers to the workflow regardless of what provider its initial state declares", async () => {
    // The deference is a property of the Issue being workflow-owned, not of
    // the workflow's shape. This fixture's initial state declares `claude`
    // while the project default is `codex` -- the divergence that used to
    // matter because the dispatch launched that initial state. Nothing
    // launches now, so neither provider runs. See issue #616.
    const root = await makeTempRoot();
    await writeRawFsmReviewFollowupProjectWithClaudeInitial(root);
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

      seedWaitingParentRun(store, {
        branchName,
        currentStateId: "wait_for_pr",
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

      const codexInputs: ProviderRunInput[] = [];
      const claudeInputs: ProviderRunInput[] = [];
      const codexProvider = fakeProvider(codexInputs);
      const claudeProvider: AgentProvider = {
        ...fakeProvider(claudeInputs),
        name: "claude"
      };
      const project = rawFsmReviewFollowupProjectConfig();
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
        listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };

      let nextRun = 0;
      const controller = new RunController({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { claude: claudeProvider, codex: codexProvider },
        configDir: root,
        createRunId: () => {
          nextRun += 1;
          return `review-run-${nextRun}`;
        },
        emailConfigLoader: () => undefined,
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        prepareIssueWorkspace: () =>
          Promise.resolve({
            branchName,
            branchRef: `refs/heads/${branchName}`,
            cachePath: path.join(root, ".symphonika", "workspaces", ".cache"),
            issueDirectoryName: "54-review-followup",
            reused: true,
            workspacePath
          }),
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        providersLoader: () => Promise.resolve(providersConfig()),
        runStore: store,
        schedule: () => true,
        stateRoot: path.join(root, ".symphonika")
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
        action: "none",
        reason: "no pull request follow-up action"
      });
      expect(claudeInputs).toHaveLength(0);
      expect(codexInputs).toHaveLength(0);
      expect(store.getRun("review-run-1")).toBeUndefined();
      expect(store.getRun("parent-run")).toMatchObject({
        currentStateId: "wait_for_pr",
        state: "waiting"
      });
    } finally {
      store.close();
    }
  });

  it("refuses a raw_fsm review dispatch even with no parked run to defer to", async () => {
    // The global loop's deference covers a parked run. This is the same rule
    // stated where it is enforceable: a raw FSM whose run is not parked has
    // terminated or blocked, so there is no position to resume from and
    // replaying the pipeline from `initial` is no more correct there than it
    // was for a parked one. Nothing outside the FSM picks a start state.
    // See issue #616.
    const root = await makeTempRoot();
    await writeRawFsmReviewFollowupProject(root);
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

      // A terminated run, not a parked one: nothing for the loop to defer to.
      store.createRun({
        id: "parent-run",
        issue: normalizedIssue(),
        projectName: "symphonika",
        providerCommand: DEFAULT_CODEX_COMMAND,
        providerName: "codex"
      });
      store.updateRunState("parent-run", "succeeded");

      const providerInputs: ProviderRunInput[] = [];
      const provider = fakeProvider(providerInputs);
      const project = rawFsmReviewFollowupProjectConfig();
      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi.fn().mockResolvedValue(issueFixture()),
        listOpenIssues: vi.fn().mockResolvedValue([]),
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

      const result = await controller.dispatchReviewFollowup({
        issueNumber: 54,
        parentRunId: "parent-run",
        projectName: "symphonika",
        review: {
          headSha: "abc123",
          pullRequestNumber: 81,
          pullRequestUrl: "https://example.test/pr/81",
          reviewDecision: "CHANGES_REQUESTED",
          statusCheckRollupState: "SUCCESS",
          unresolvedThreads: []
        }
      });

      expect(result).toEqual({
        dispatched: false,
        reason: "raw_fsm workflow owns its own review follow-up"
      });
      expect(providerInputs).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("keeps a markdown PR follow-up retry label-immune across the retry handoff", async () => {
    const root = await makeTempRoot();
    // writeProject writes a markdown (non-raw_fsm) WORKFLOW.md. The label-
    // immunity bug only bites non-raw_fsm workflows: for raw_fsm the retry's
    // recompute independently yields false and masks the missing handoff.
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

      const activeRuns = new ActiveRunRegistry();
      const scheduledRetries: Array<() => Promise<void>> = [];
      let attempts = 0;
      let retryEntryRespectsIssueLabels: boolean | undefined;
      const provider: AgentProvider = {
        cancel: vi.fn().mockResolvedValue(undefined),
        name: "codex",
        // eslint-disable-next-line @typescript-eslint/require-await
        async *runAttempt(
          input: ProviderRunInput
        ): AsyncGenerator<ProviderEvent> {
          attempts += 1;
          if (attempts === 1) {
            // Initial follow-up attempt fails transiently → schedules a retry.
            yield {
              normalized: { exitCode: 1, type: "process_exit" },
              raw: { code: 1, kind: "exit" }
            };
            return;
          }
          // The retry attempt: capture the label-immunity the in-flight entry
          // carries after attachProvider. reconcile.ts consumes this exact
          // field to decide eligibility_loss cancellation; the executeRetry →
          // runAttemptLifecycle handoff must keep it `false` so a reconcile
          // tick cannot cancel the retry while `agent-ready` is absent.
          retryEntryRespectsIssueLabels = activeRuns.getInFlight(
            input.run.id
          )?.respectsIssueLabels;
          yield {
            normalized: { exitCode: 0, type: "process_exit" },
            raw: { code: 0, kind: "exit" }
          };
        },
        validate: vi.fn().mockResolvedValue(undefined)
      };

      const project = projectConfig();
      // getIssue returns the issue WITHOUT `agent-ready` throughout — a PR
      // follow-up dispatches on an open issue regardless of labels, and the
      // retry must preserve that immunity.
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
        activeRuns,
        githubIssuesApi,
        project,
        provider,
        root,
        runStore: store,
        schedule: ({ fire, kind }) => {
          if (kind === "retry") {
            scheduledRetries.push(fire);
          }
          return true;
        },
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

      expect(result).toMatchObject({
        action: "review_dispatch",
        runId: "review-run-1"
      });
      // The initial attempt failed transiently and scheduled exactly one retry.
      expect(attempts).toBe(1);
      expect(scheduledRetries).toHaveLength(1);

      // Drive the scheduled retry synchronously.
      await scheduledRetries[0]!();

      expect(attempts).toBe(2);
      // Regression guard: without the executeRetry → runAttemptLifecycle
      // handoff, the markdown recompute + attachProvider flip this back to
      // `true`, re-opening the eligibility_loss cancellation storm.
      expect(retryEntryRespectsIssueLabels).toBe(false);

      const reviewRun = store.getRun("review-run-1");
      expect(reviewRun?.cancelReason ?? null).toBeNull();
      expect(reviewRun).toMatchObject({ state: "succeeded" });
    } finally {
      store.close();
    }
  });

  it("preserves label immunity through a PR follow-up retry on a non-raw_fsm workflow", async () => {
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

      const project = projectConfig();
      const activeRuns = new ActiveRunRegistry();
      let attempts = 0;
      let respectsDuringRetry: boolean | undefined;
      let cancelledDuringRetry: boolean | undefined;

      // Issue snapshot used for the mid-retry reconcile tick: it lacks
      // `agent-ready`, so evaluateProjectEligibility reports it ineligible.
      // Under the bug this cancels the retry with eligibility_loss even
      // though a PR follow-up retry must stay label-immune. See the Codex
      // review on run-controller.ts:710-723.
      const reconcilePollStatus = emptyIssuePollStatus();
      reconcilePollStatus.candidateIssues = [
        {
          issue: normalizedIssue(),
          project: project.name,
          repository: { owner: "pmatos", repo: "symphonika" }
        }
      ];

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
                    body: "Please handle this edge case.",
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

      const provider: AgentProvider = {
        cancel: vi.fn().mockResolvedValue(undefined),
        name: "codex",
        runAttempt: vi.fn(async function* (
          input: ProviderRunInput
        ): AsyncGenerator<ProviderEvent> {
          await Promise.resolve();
          attempts += 1;
          if (attempts === 1) {
            yield {
              normalized: { exitCode: 1, type: "process_exit" },
              raw: { code: 1, kind: "exit" }
            };
            return;
          }
          // Retry attempt: attachProvider has already run by this point, so
          // the active-run entry reflects whatever executeRetry propagated
          // into runAttemptLifecycle. Fire a reconcile tick right here to
          // simulate the daemon's concurrent poll racing the in-flight
          // retry attempt.
          respectsDuringRetry = activeRuns.get(
            input.run.id
          )?.respectsIssueLabels;
          await reconcileActiveRuns({
            activeRuns,
            env: { GITHUB_TOKEN: "secret-token" },
            githubIssuesApi,
            logger: pino({ enabled: false }),
            pollStatus: reconcilePollStatus,
            projects: new Map([[project.name, project]]),
            runStore: store
          });
          cancelledDuringRetry = activeRuns.get(input.run.id)?.cancelRequested;
          yield {
            normalized: { exitCode: 0, type: "process_exit" },
            raw: { code: 0, kind: "exit" }
          };
        }),
        validate: vi.fn().mockResolvedValue(undefined)
      };

      const scheduledRetries: Array<() => Promise<void>> = [];
      const controller = new RunController({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createRunId: () => "review-run-1",
        emailConfigLoader: () => undefined,
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        prepareIssueWorkspace: () =>
          Promise.resolve({
            branchName,
            branchRef: `refs/heads/${branchName}`,
            cachePath: path.join(root, ".symphonika", "workspaces", ".cache"),
            issueDirectoryName: "54-review-followup",
            reused: true,
            workspacePath
          }),
        projectsLoader: () =>
          Promise.resolve(new Map([[project.name, project]])),
        providersLoader: () => Promise.resolve(providersConfig()),
        runStore: store,
        // Capture scheduled retries instead of using real timers, so the
        // test can fire executeRetry deterministically.
        schedule: (scheduleInput) => {
          if (scheduleInput.kind === "retry") {
            scheduledRetries.push(scheduleInput.fire);
          }
          return true;
        },
        stateRoot: path.join(root, ".symphonika")
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
      expect(attempts).toBe(1);
      expect(scheduledRetries).toHaveLength(1);

      await scheduledRetries[0]!();

      expect(attempts).toBe(2);
      expect(respectsDuringRetry).toBe(false);
      expect(cancelledDuringRetry).toBe(false);
      expect(store.getRun("review-run-1")).toMatchObject({
        state: "succeeded"
      });
      // The succeeded retry is a non-raw-FSM success, so applyTerminal defers
      // its own release to scheduleNext (deferReleaseToScheduler) instead of
      // releasing eagerly. scheduleNext's continuation-scheduling eligibility
      // re-check then finds the issue ineligible (still missing `agent-ready`,
      // its normal steady state while parked on PR review) -- but label-immune
      // (PR Follow-up) work is exempt from releasing on that eligibility loss
      // (see issue #475), since a still-live parked/waiting Run may share the
      // same Issue Reservation. So the claim must survive this whole sequence
      // untouched: neither a premature release from applyTerminal itself, nor
      // one from the eligibility-loss re-check. The mid-retry reconcile tick
      // not cancelling/suppressing the in-flight attempt is asserted directly
      // above via respectsDuringRetry/cancelledDuringRetry.
      const claimRemovals = (
        githubIssuesApi.removeLabelsFromIssue as ReturnType<typeof vi.fn>
      ).mock.calls
        .map(([call]) => call as { labels: string[] })
        .filter((call) => call.labels[0] === "sym:claimed");
      expect(claimRemovals).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("releases the claim when a label-immune PR follow-up finishes after the issue closes", async () => {
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

      const project = projectConfig();
      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi
          .fn()
          .mockResolvedValueOnce(issueFixture())
          .mockResolvedValueOnce(null),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };
      const controller = runController({
        githubIssuesApi,
        project,
        provider: fakeProvider([]),
        root,
        runStore: store,
        workspacePath
      });

      const result = await controller.dispatchReviewFollowup({
        issueNumber: 54,
        parentRunId: "parent-run",
        projectName: project.name,
        review: {
          headSha: "abc123",
          pullRequestNumber: 81,
          pullRequestUrl: "https://github.com/pmatos/symphonika/pull/81",
          reviewDecision: "CHANGES_REQUESTED",
          statusCheckRollupState: "SUCCESS",
          unresolvedThreads: []
        }
      });

      expect(result).toEqual({ dispatched: true, runId: "review-run-1" });
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:claimed", "sym:stale"] })
      );
    } finally {
      store.close();
    }
  });

  it("preserves the claim when a delayed label-immune continuation loses label eligibility", async () => {
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

      const project = projectConfig();
      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi
          .fn()
          .mockResolvedValueOnce(issueFixture())
          .mockResolvedValueOnce({
            ...issueFixture(),
            labels: [{ name: "agent-ready" }, { name: "sym:claimed" }]
          })
          .mockResolvedValueOnce(issueFixture()),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      };
      const scheduledContinuations: Array<() => Promise<void>> = [];
      const controller = runController({
        githubIssuesApi,
        project,
        provider: fakeProvider([]),
        root,
        runStore: store,
        schedule: (input) => {
          if (input.kind === "continuation") {
            scheduledContinuations.push(input.fire);
          }
          return true;
        },
        workspacePath
      });

      const result = await controller.dispatchReviewFollowup({
        issueNumber: 54,
        parentRunId: "parent-run",
        projectName: project.name,
        review: {
          headSha: "abc123",
          pullRequestNumber: 81,
          pullRequestUrl: "https://github.com/pmatos/symphonika/pull/81",
          reviewDecision: "CHANGES_REQUESTED",
          statusCheckRollupState: "SUCCESS",
          unresolvedThreads: []
        }
      });

      expect(result).toEqual({ dispatched: true, runId: "review-run-1" });
      expect(scheduledContinuations).toHaveLength(1);

      await scheduledContinuations[0]!();

      // The initial dispatch's own success is deferred (deferReleaseToScheduler)
      // rather than released eagerly by applyTerminal. scheduleNext's own
      // continuation-scheduling eligibility check found the issue eligible
      // (2nd getIssue call has `agent-ready`) and scheduled this continuation;
      // by the time it fires, the issue has reverted to its steady state
      // (3rd getIssue call, no `agent-ready`) and executeContinuation's own
      // eligibility re-check finds it ineligible -- but label-immune work is
      // exempt from releasing on that eligibility loss (issue #475), since a
      // still-live parked/waiting Run may share the same Issue Reservation.
      // So the claim must survive untouched throughout.
      const claimRemovals = (
        githubIssuesApi.removeLabelsFromIssue as ReturnType<typeof vi.fn>
      ).mock.calls
        .map(([call]) => call as { labels: string[] })
        .filter((call) => call.labels[0] === "sym:claimed");
      expect(claimRemovals).toHaveLength(0);
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

  it("does not re-attempt a merge the FSM already terminalized as refused", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-clean-pr";
      // The FSM's merge_pr state already terminalized this Run as blocked
      // after a deterministic merge refusal (ADR 0058, issue #635).
      // Terminalizing released FSM ownership (current_state_id went null),
      // so isIssueOwnedByWorkflow alone would read this as "nothing owns
      // this issue" and the global loop below would re-attempt the exact
      // merge just declared refused.
      seedMergeRefusedBlockedRun(store, { runId: "merge-refused-run" });
      store.trackPullRequest({
        branchName,
        headSha: "abc123",
        issueNumber: 54,
        prNumber: 82,
        prUrl: "https://github.com/pmatos/symphonika/pull/82",
        projectName: "symphonika",
        runId: "merge-refused-run"
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

      expect(githubIssuesApi.mergePullRequest).not.toHaveBeenCalled();
      expect(result).not.toEqual({ action: "merged", prNumber: 82 });
    } finally {
      store.close();
    }
  });

  it("still merges a different open PR on the same issue despite another PR's refusal", async () => {
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
      // A different tracked PR on the SAME issue (e.g. an earlier redispatch
      // onto a renamed branch) was refused and terminalized as blocked. The
      // guard must be scoped to PR #82, not the issue as a whole, or it
      // would also shadow this unrelated, healthy PR #91.
      seedMergeRefusedBlockedRun(store, { runId: "merge-refused-run" });
      store.trackPullRequest({
        branchName: "sym/symphonika/54-clean-pr-original",
        headSha: "def456",
        issueNumber: 54,
        prNumber: 82,
        prUrl: "https://github.com/pmatos/symphonika/pull/82",
        projectName: "symphonika",
        runId: "merge-refused-run"
      });
      store.trackPullRequest({
        branchName,
        headSha: "abc123",
        issueNumber: 54,
        prNumber: 91,
        prUrl: "https://github.com/pmatos/symphonika/pull/91",
        projectName: "symphonika",
        runId: "parent-run"
      });
      const project = projectConfig();
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

      expect(result).toEqual({ action: "merged", prNumber: 91 });
      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledTimes(1);
      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledWith({
        expectedHeadSha: "abc123",
        method: "squash",
        owner: "pmatos",
        pullNumber: 91,
        repo: "symphonika",
        token: "secret-token"
      });
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

  it("auto-merges using the discovered head SHA when a custom follow-up adapter lacks one", async () => {
    // The default GraphQL adapter requires a non-empty headRefOid, but a
    // custom GitHubIssuesApi can still return an empty headSha. Sending that
    // empty string as the merge API's `sha` pin (instead of falling back to
    // a known-good head SHA) makes GitHub reject a legitimate merge.
    // Regression for #499.
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
        getPullRequestFollowupState: vi
          .fn()
          .mockResolvedValue(prState({ headSha: "" })),
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

  it("skips auto-merge without a pin when both a custom adapter and the tracked row lack a head SHA", async () => {
    // A tracked row can already have last_seen_head_sha = "" on disk from
    // before this fix landed (the pre-fix code unconditionally persisted an
    // empty adapter result). If a custom adapter reports no head SHA again
    // on a later tick, falling back to that also-empty lastSeenHeadSha must
    // not merge unpinned -- an unpinned merge could land a commit pushed
    // after this tick's checks/review state was fetched. Regression for the
    // P1 follow-up on #530.
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-corrupted-head-sha";
      seedSucceededRun(store, {
        branchName,
        runId: "parent-run",
        workspacePath: path.join(root, "workspace")
      });
      const project = projectConfig();
      // Simulates a row corrupted by the pre-fix code: last_seen_head_sha
      // already "" before this tick runs.
      store.trackPullRequest({
        branchName,
        headSha: "",
        issueNumber: 54,
        prNumber: 82,
        prUrl: "https://github.com/pmatos/symphonika/pull/82",
        projectName: "symphonika",
        runId: "parent-run"
      });
      const githubIssuesApi: GitHubIssuesApi = {
        getPullRequestFollowupState: vi
          .fn()
          .mockResolvedValue(prState({ headSha: "" })),
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
      expect(store.listOpenTrackedPullRequests()[0]).toMatchObject({
        lastSeenHeadSha: ""
      });
    } finally {
      store.close();
    }
  });

  it("dispatches review follow-up with the discovered head SHA when a custom follow-up adapter lacks one", async () => {
    // Regression for the P1 follow-up on #530: the resolved fallback head
    // SHA was threaded into recordPullRequestReviewDispatch (the DB write)
    // but not into reviewContextFromState, so the dispatched agent's
    // rendered instructions still got a blank "Head SHA:" line.
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-review-followup-empty-sha";
      const workspacePath = path.join(
        root,
        ".symphonika",
        "workspaces",
        "symphonika",
        "issues",
        "54-review-followup-empty-sha"
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
            headSha: "",
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
      expect(providerInputs[0]!.prompt).toContain("Head SHA: abc123");
      expect(providerInputs[0]!.prompt).not.toContain("Head SHA: \n");
    } finally {
      store.close();
    }
  });

  it("dispatches review follow-up with an 'unknown' head SHA placeholder when the tracked row has never observed one", async () => {
    // Regression for the second P1 follow-up on #530: unlike the merge
    // path, review-followup dispatch must not skip-and-retry on an empty
    // headSha (that would permanently strand review followup for a row
    // whose lastSeenHeadSha is genuinely empty). Render a placeholder in
    // the dispatched instructions instead, matching the adjacent
    // `?? "none"` / `?? "unknown"` fields in renderReviewFollowupInstructions.
    const root = await makeTempRoot();
    await writeProject(root);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      const branchName = "sym/symphonika/54-review-followup-never-observed";
      const workspacePath = path.join(
        root,
        ".symphonika",
        "workspaces",
        "symphonika",
        "issues",
        "54-review-followup-never-observed"
      );
      await createGitWorkspaceAhead({ branchName, workspacePath });
      seedSucceededRun(store, {
        branchName,
        runId: "parent-run",
        workspacePath
      });
      // Simulates a row corrupted by the pre-fix code: last_seen_head_sha
      // already "" before this tick runs.
      store.trackPullRequest({
        branchName,
        headSha: "",
        issueNumber: 54,
        prNumber: 81,
        prUrl: "https://github.com/pmatos/symphonika/pull/81",
        projectName: "symphonika",
        runId: "parent-run"
      });

      const providerInputs: ProviderRunInput[] = [];
      const provider = fakeProvider(providerInputs);
      const project = projectConfig();
      const githubIssuesApi: GitHubIssuesApi = {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        getIssue: vi.fn().mockResolvedValue(issueFixture()),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(
          prState({
            headSha: "",
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
        listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
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
      expect(providerInputs[0]!.prompt).toContain("Head SHA: unknown");
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
        emailConfigLoader: () => undefined,
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
        schedule: (item) =>
          activeRuns.scheduleDelayed({
            delayMs: 60_000,
            fire: item.fire,
            issueNumber: item.issueNumber,
            kind: item.kind,
            projectName: item.projectName,
            runId: item.runId
          }),
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

      await activeRuns.cancelAll(CANCEL_REASONS.DAEMON_SHUTDOWN);
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
  activeRuns?: ActiveRunRegistry;
  githubIssuesApi: GitHubIssuesApi;
  project: RunControllerProjectConfig;
  provider: AgentProvider;
  root: string;
  runStore: RunStore;
  schedule?: ScheduleHandler;
  workspacePath: string;
}): RunController {
  let nextRun = 0;
  return new RunController({
    activeRuns: input.activeRuns ?? new ActiveRunRegistry(),
    agentProviders: { codex: input.provider },
    configDir: input.root,
    createRunId: () => {
      nextRun += 1;
      return `review-run-${nextRun}`;
    },
    emailConfigLoader: () => undefined,
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
    schedule: input.schedule ?? (() => true),
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

function seedMergeRefusedBlockedRun(
  store: RunStore,
  input: { runId: string }
): void {
  store.createRun({
    id: input.runId,
    issue: normalizedIssue(),
    projectName: "symphonika",
    providerCommand: DEFAULT_CODEX_COMMAND,
    providerName: "codex"
  });
  store.recordTerminalReason(
    input.runId,
    "merge_pr_refused: PR #82: Protected branch update failed",
    "deterministic"
  );
  store.updateRunState(input.runId, "blocked");
}

function seedWaitingParentRun(
  store: RunStore,
  input: {
    branchName: string;
    currentStateId: string;
    runId: string;
    workspacePath: string;
  }
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
  store.setRunCurrentState(input.runId, input.currentStateId);
  store.updateRunState(input.runId, "waiting");
}

async function writeRawFsmReviewFollowupProject(root: string): Promise<void> {
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
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await writeFile(
    path.join(root, "prompts", "implement.md"),
    [
      "# Issue #{{issue.number}}",
      "",
      "{{issue.body}}",
      "",
      "Branch: {{branch.name}}",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: review_followup_regression",
      "  initial: implement",
      "  states:",
      "    implement:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompts/implement.md",
      "      transitions:",
      "        - to: wait_for_pr",
      "          when:",
      "            provider_success: true",
      "            branch_ahead_of_base: true",
      "        - to: failed",
      "    wait_for_pr:",
      "      action:",
      "        kind: wait",
      "      transitions:",
      "        - to: merged",
      "          when:",
      "            pr_merged: true",
      "        - to: failed",
      "          when:",
      "            pr_open: false",
      "        - to: failed",
      "          when:",
      "            mergeable: false",
      "        - to: failed",
      "          when:",
      "            checks: failure",
      "        - to: failed",
      "          when:",
      "            checks: success",
      "            mergeable: true",
      "            unresolved_review_threads: 0",
      "        - to: failed",
      "          when:",
      "            has_unresolved_reviews: true",
      "    merged:",
      "      terminal: success",
      "    failed:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
}

function rawFsmReviewFollowupProjectConfig(): RunControllerProjectConfig {
  return {
    ...projectConfig(),
    workflow: { format: "auto", path: "./workflow.yml" }
  };
}

// Same shape as writeRawFsmReviewFollowupProject, except the initial state
// declares provider: claude while the project default (projectConfig()) is
// codex — this is the divergence the two-outcome routing bug needs to bite.
async function writeRawFsmReviewFollowupProjectWithClaudeInitial(
  root: string
): Promise<void> {
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
  await mkdir(path.join(root, "prompts"), { recursive: true });
  await writeFile(
    path.join(root, "prompts", "implement.md"),
    [
      "# Issue #{{issue.number}}",
      "",
      "{{issue.body}}",
      "",
      "Branch: {{branch.name}}",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: review_followup_provider_routing",
      "  initial: implement",
      "  states:",
      "    implement:",
      "      action:",
      "        kind: agent",
      "        provider: claude",
      "        prompt: prompts/implement.md",
      "      transitions:",
      "        - to: wait_for_pr",
      "          when:",
      "            provider_success: true",
      "            branch_ahead_of_base: true",
      "        - to: failed",
      "    wait_for_pr:",
      "      action:",
      "        kind: wait",
      "      transitions:",
      "        - to: merged",
      "          when:",
      "            pr_merged: true",
      "        - to: failed",
      "          when:",
      "            pr_open: false",
      "        - to: failed",
      "          when:",
      "            mergeable: false",
      "        - to: failed",
      "          when:",
      "            checks: failure",
      "        - to: failed",
      "          when:",
      "            checks: success",
      "            mergeable: true",
      "            unresolved_review_threads: 0",
      "        - to: failed",
      "          when:",
      "            has_unresolved_reviews: true",
      "    merged:",
      "      terminal: success",
      "    failed:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
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
