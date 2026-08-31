import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GitHubIssuesApi,
  IssueSnapshot,
  RawGitHubPullRequestFollowupState
} from "../src/issue-polling.js";
import {
  ActiveRunRegistry,
  type ScheduledWorkInput
} from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "../src/lifecycle/run-controller.js";
import type { ProviderEvent } from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = "codex app-server";

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-progress-guard-"));
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

function issueFixture(): IssueSnapshot {
  return {
    body: "Progress guard fixture.",
    created_at: "2026-08-10T10:00:00Z",
    id: 6161,
    labels: ["agent-ready"],
    number: 616,
    priority: 99,
    state: "open",
    title: "Progress guard fixture",
    updated_at: "2026-08-11T11:00:00Z",
    url: "https://github.com/pmatos/symphonika/issues/616"
  };
}

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(root, "ws", "616-progress-guard-fixture");
  return {
    branchName: "sym/symphonika/616-progress-guard-fixture",
    branchRef: "refs/heads/sym/symphonika/616-progress-guard-fixture",
    cachePath: path.join(root, "ws", ".cache", "repo.git"),
    issueDirectoryName: "616-progress-guard-fixture",
    reused: false,
    workspacePath
  };
}

// A workflow with a real cycle: the wait routes unresolved review feedback to
// a repair agent, and the repair agent routes back to the wait. Without the
// progress guard this spins for as long as the feedback stays unresolved.
async function writeCyclingProject(root: string): Promise<void> {
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
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./ws",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./workflow.yml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: wait_repair_cycle",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      transitions:",
      "        - to: holding",
      "    holding:",
      "      action:",
      "        kind: wait",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            checks: success",
      "            mergeable: true",
      "            unresolved_review_threads: 0",
      "        - to: repair",
      "          when:",
      "            has_unresolved_reviews: true",
      "    repair:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      transitions:",
      "        - to: holding",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Work on #{{issue.number}}.\n"
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
    unresolvedReviewThreads: [
      {
        comments: [
          {
            author: "reviewer",
            body: "please rename this",
            createdAt: "2026-08-12T09:00:00Z",
            path: "src/run-store.ts",
            url: "https://example.test/pr/99#thread-1"
          }
        ],
        id: "thread-1",
        isResolved: false,
        path: "src/run-store.ts"
      }
    ],
    url: "https://example.test/pr/99",
    ...overrides
  };
}

function projectFixture(): RunControllerProjectConfig {
  return {
    mode: "dispatch",
    agent: { provider: "codex" },
    issue_filters: {
      labels_all: ["agent-ready"],
      labels_none: [],
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
    workflow: { format: "auto", path: "./workflow.yml" },
    workspace: {
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      root: "./ws"
    }
  };
}

function buildController(input: {
  githubIssuesApi: GitHubIssuesApi;
  root: string;
  runStore: ReturnType<typeof openRunStore>;
  schedule?: (item: ScheduledWorkInput) => void;
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
    createRunId: () => `guard-run-${++nextRun}`,
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
      Promise.resolve(new Map([["symphonika", projectFixture()]])),
    providersLoader: (): Promise<RunControllerProvidersConfig> =>
      Promise.resolve({
        claude: { command: "claude" },
        codex: { command: DEFAULT_CODEX_COMMAND }
      }),
    runStore: input.runStore,
    schedule: input.schedule ?? (() => undefined),
    stateRoot: path.join(input.root, ".symphonika")
  });
}

function seedPark(
  store: ReturnType<typeof openRunStore>,
  issue: IssueSnapshot,
  waitingRunId: string
): void {
  store.createWaitingRun({
    currentStateId: "holding",
    id: waitingRunId,
    issue,
    parentRunId: "parent-run",
    projectName: "symphonika"
  });
}

describe("workflow progress guard", () => {
  it("advances the first time an edge is taken, then parks on an identical observation", async () => {
    const root = await makeTempRoot();
    await writeCyclingProject(root);
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
      store.trackPullRequest({
        branchName: "sym/symphonika/616-progress-guard-fixture",
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
        root,
        runStore: store
      });

      seedPark(store, issue, "waiting-1");
      await controller.reEvaluateWaitingRun("waiting-1");

      const first = store.getRun("waiting-1");
      expect(first?.state).toBe("succeeded");
      expect(first?.currentStateId).toBe("repair");

      // The repair agent ran and routed back to the wait, but resolved
      // nothing: same head SHA, same thread still open.
      seedPark(store, issue, "waiting-2");
      await controller.reEvaluateWaitingRun("waiting-2");

      const second = store.getRun("waiting-2");
      expect(second?.state).toBe("waiting");
      expect(second?.currentStateId).toBe("holding");
      expect(second?.stateTransitionReason).toContain(
        "workflow made no progress"
      );
      expect(second?.stateTransitionReason).toContain("holding -> repair");
    } finally {
      store.close();
    }
  });

  it("re-advances the same edge once the head SHA moves", async () => {
    const root = await makeTempRoot();
    await writeCyclingProject(root);
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
      store.trackPullRequest({
        branchName: "sym/symphonika/616-progress-guard-fixture",
        headSha: "deadbeef",
        issueNumber: issue.number,
        prNumber: 99,
        prUrl: "https://example.test/pr/99",
        projectName: "symphonika",
        runId: "parent-run"
      });

      const getPullRequestFollowupState = vi
        .fn()
        .mockResolvedValueOnce(prState())
        .mockResolvedValue(prState({ headSha: "cafebabe" }));
      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState,
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        root,
        runStore: store
      });

      seedPark(store, issue, "waiting-1");
      await controller.reEvaluateWaitingRun("waiting-1");
      expect(store.getRun("waiting-1")?.currentStateId).toBe("repair");

      // The repair agent pushed a fix. The threads are still unresolved, but
      // the observation is genuinely new, so the edge is taken again.
      seedPark(store, issue, "waiting-2");
      await controller.reEvaluateWaitingRun("waiting-2");

      const second = store.getRun("waiting-2");
      expect(second?.state).toBe("succeeded");
      expect(second?.currentStateId).toBe("repair");
    } finally {
      store.close();
    }
  });

  it("clears the guard's history when the chain reaches a terminal", async () => {
    const root = await makeTempRoot();
    await writeCyclingProject(root);
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
      store.trackPullRequest({
        branchName: "sym/symphonika/616-progress-guard-fixture",
        headSha: "deadbeef",
        issueNumber: issue.number,
        prNumber: 99,
        prUrl: "https://example.test/pr/99",
        projectName: "symphonika",
        runId: "parent-run"
      });

      const getPullRequestFollowupState = vi
        .fn()
        .mockResolvedValueOnce(prState())
        .mockResolvedValueOnce(prState({ unresolvedReviewThreads: [] }))
        .mockResolvedValue(prState());
      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState,
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        root,
        runStore: store
      });

      seedPark(store, issue, "waiting-1");
      await controller.reEvaluateWaitingRun("waiting-1");
      expect(
        store.readProgressFingerprint({
          fromStateId: "holding",
          issueNumber: issue.number,
          projectName: "symphonika",
          toStateId: "repair"
        })
      ).toBeDefined();

      // The threads got resolved, so the next park terminates the chain.
      seedPark(store, issue, "waiting-2");
      await controller.reEvaluateWaitingRun("waiting-2");
      expect(store.getRun("waiting-2")?.terminalStateId).toBe("done");
      expect(
        store.readProgressFingerprint({
          fromStateId: "holding",
          issueNumber: issue.number,
          projectName: "symphonika",
          toStateId: "repair"
        })
      ).toBeUndefined();

      // A later chain on the same Issue is not held by the old history.
      seedPark(store, issue, "waiting-3");
      await controller.reEvaluateWaitingRun("waiting-3");
      expect(store.getRun("waiting-3")?.currentStateId).toBe("repair");
    } finally {
      store.close();
    }
  });

  it("does not guard an advance into a terminal state", async () => {
    const root = await makeTempRoot();
    await writeCyclingProject(root);
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
      store.trackPullRequest({
        branchName: "sym/symphonika/616-progress-guard-fixture",
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
          .mockResolvedValue(prState({ unresolvedReviewThreads: [] })),
        listOpenIssues: vi.fn().mockResolvedValue([])
      };
      const controller = buildController({
        githubIssuesApi,
        root,
        runStore: store
      });

      seedPark(store, issue, "waiting-1");
      await controller.reEvaluateWaitingRun("waiting-1");
      expect(store.getRun("waiting-1")?.terminalStateId).toBe("done");

      seedPark(store, issue, "waiting-2");
      await controller.reEvaluateWaitingRun("waiting-2");
      expect(store.getRun("waiting-2")?.terminalStateId).toBe("done");
    } finally {
      store.close();
    }
  });
});
