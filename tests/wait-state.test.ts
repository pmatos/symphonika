import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
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
import { openRunStore } from "../src/run-store.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { createDeferred } from "./helpers/deferred.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-wait-state-"));
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
  html_url: string;
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
    body: "Wait state acceptance fixture.",
    created_at: "2026-05-10T10:00:00Z",
    html_url: "https://github.com/pmatos/symphonika/issues/8",
    id: 5008,
    labels: ["agent-ready"],
    number: 8,
    priority: 99,
    state: "open",
    title: "Wait state acceptance fixture",
    updated_at: "2026-05-11T11:00:00Z",
    url: "https://github.com/pmatos/symphonika/issues/8"
  };
}

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "8-wait-state-acceptance-fixture"
  );
  return {
    branchName: "sym/symphonika/8-wait-state-acceptance-fixture",
    branchRef: "refs/heads/sym/symphonika/8-wait-state-acceptance-fixture",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "8-wait-state-acceptance-fixture",
    reused: false,
    workspacePath
  };
}

function recordingCodexProvider(
  providerInputs: ProviderRunInput[]
): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    runAttempt: vi.fn(async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      providerInputs.push(input);
      await Promise.resolve();
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

type GatedProvider = AgentProvider & {
  cancel: ReturnType<typeof vi.fn>;
  ready: Promise<void>;
  release: () => void;
};

// Provider that yields session_started, then blocks until released — modelling
// an agent that is still "running" (e.g. mid-way through removing agent-ready
// and opening its PR) so a reconcile tick can fire while the run is in-flight.
// Releasing yields a clean exit 0. cancel() also releases the gate so a
// (regressed) eligibility_loss cancel unwinds the generator instead of hanging
// the test; the assertion that cancel was never called is what catches the bug.
function gatedSuccessProvider(): GatedProvider {
  const readyGate = createDeferred<void>();
  const releaseGate = createDeferred<void>();
  const cancel = vi.fn((): Promise<void> => {
    releaseGate.resolve();
    return Promise.resolve();
  });
  return {
    cancel,
    name: "codex",
    ready: readyGate.promise,
    release: () => releaseGate.resolve(),
    runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
      readyGate.resolve();
      yield {
        normalized: { sessionId: "fake", type: "session_started" },
        raw: { kind: "session" }
      };
      await releaseGate.promise;
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

async function writeWaitStateProject(root: string): Promise<void> {
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
      "    workflow: ./workflow.yml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: agent_then_wait",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
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
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Plan work on #{{issue.number}}.\n"
  );
}

async function waitForWaitingRow(
  databasePath: string,
  timeoutMs = 15_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const database = new Database(databasePath, { readonly: true });
      try {
        const row = database
          .prepare(
            [
              "select id, state, current_state_id, continuation_parent_run_id,",
              "provider_name, prompt_path",
              "from runs where state = 'waiting' limit 1"
            ].join(" ")
          )
          .get() as Record<string, unknown> | undefined;
        if (row !== undefined) {
          return row;
        }
      } finally {
        database.close();
      }
    } catch {
      // db may not be readable yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waiting row not observed before timeout");
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
    createRunId: () => `wait-rerun-${++nextRun}`,
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
    schedule: () => undefined,
    stateRoot: path.join(input.root, ".symphonika")
  });
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

describe("wait state lifecycle", () => {
  it("parks the workflow in a waiting row when an agent state advances into a wait state", async () => {
    const root = await makeTempRoot();
    await writeWaitStateProject(root);

    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const issue = issueFixture();
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };

    const providerInputs: ProviderRunInput[] = [];
    const codexProvider = recordingCodexProvider(providerInputs);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-wait-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const waitingRow = await waitForWaitingRow(
        path.join(root, ".symphonika", "symphonika.db")
      );

      expect(waitingRow).toMatchObject({
        state: "waiting",
        current_state_id: "holding"
      });
      expect(waitingRow.continuation_parent_run_id).toBe("run-wait-1");
      expect(waitingRow.provider_name).toBeNull();
      expect(waitingRow.prompt_path).toBeNull();

      // Only the planning state ran a provider attempt. The wait state must
      // NOT spawn an agent.
      expect(providerInputs).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it("does not cancel a fresh raw FSM run whose agent removes agent-ready before it parks (issue #258)", async () => {
    const root = await makeTempRoot();
    await writeWaitStateProject(root);

    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const eligibleIssue = issueFixture();
    // The implement agent opens its PR and removes agent-ready as its terminal
    // action. Every poll after dispatch therefore surfaces the issue as
    // ineligible (labels_all no longer satisfied), landing it in
    // pollStatus.filteredIssues where reconcileActiveRuns re-checks it. Pre-fix
    // this cancelled the still-running run as eligibility_loss.
    const ineligibleIssue = {
      ...eligibleIssue,
      labels: ["sym:claimed", "sym:running"]
    };

    let listCalls = 0;
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue({
        ...ineligibleIssue,
        labels: ineligibleIssue.labels.map((name) => ({ name }))
      }),
      getPullRequestFollowupState: vi
        .fn()
        .mockResolvedValue(prState({ statusCheckRollupState: "PENDING" })),
      listOpenIssues: vi.fn(() => {
        listCalls += 1;
        return Promise.resolve([
          listCalls === 1 ? eligibleIssue : ineligibleIssue
        ]);
      }),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([
        {
          draft: false,
          head: { ref: preparedWorkspace.branchName, sha: "abc123def456" },
          html_url: "https://github.com/pmatos/symphonika/pull/256",
          number: 256,
          state: "open"
        }
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };

    const provider = gatedSuccessProvider();

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-258-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const databasePath = path.join(root, ".symphonika", "symphonika.db");

      // Startup dispatched the implement run; it is now blocked inside the
      // provider (agent still "running"). Its in-flight entry is registered
      // with the label-immunity bit already resolved.
      await provider.ready;

      // Drive ticks whose polls no longer contain agent-ready. Each tick runs
      // reconcileActiveRuns against the still-in-flight run with the issue
      // ineligible — the exact ordering that used to cancel it.
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });

      expect(provider.cancel).not.toHaveBeenCalled();
      const midRun = new Database(databasePath, { readonly: true });
      try {
        const row = midRun
          .prepare("select state, cancel_reason from runs where id = ?")
          .get("run-258-1") as
          { state: string; cancel_reason: string | null } | undefined;
        expect(row?.state).not.toBe("cancelled");
        expect(row?.cancel_reason).toBeNull();
      } finally {
        midRun.close();
      }

      // The agent finishes: exit 0 with the branch ahead of base. The run must
      // advance into the label-immune wait state instead of dying.
      provider.release();

      const waitingRow = await waitForWaitingRow(databasePath);
      expect(waitingRow).toMatchObject({
        state: "waiting",
        current_state_id: "holding"
      });
      expect(waitingRow.continuation_parent_run_id).toBe("run-258-1");

      // Acceptance: the implement run is recorded as succeeded (advanced to the
      // wait state), never cancelled, with its branch persisted so PR discovery
      // can pick it up.
      const parentDb = new Database(databasePath, { readonly: true });
      try {
        const parent = parentDb
          .prepare(
            "select state, cancel_reason, branch_name from runs where id = ?"
          )
          .get("run-258-1") as {
          state: string;
          cancel_reason: string | null;
          branch_name: string | null;
        };
        expect(parent.state).toBe("succeeded");
        expect(parent.cancel_reason).toBeNull();
        expect(parent.branch_name).toBe(preparedWorkspace.branchName);
      } finally {
        parentDb.close();
      }
      expect(provider.cancel).not.toHaveBeenCalled();

      // Acceptance: the PR is registered in tracked_pull_requests. PR follow-up
      // is throttled to once per second after startup, so drive ticks until the
      // discovery loop records the row.
      const deadline = Date.now() + 6000;
      let tracked: Record<string, unknown> | undefined;
      while (Date.now() < deadline) {
        await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
        const trackedDb = new Database(databasePath, { readonly: true });
        try {
          tracked = trackedDb
            .prepare(
              "select pr_number, branch_name, state from tracked_pull_requests limit 1"
            )
            .get() as Record<string, unknown> | undefined;
        } finally {
          trackedDb.close();
        }
        if (tracked !== undefined) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      expect(tracked).toMatchObject({
        branch_name: preparedWorkspace.branchName,
        pr_number: 256
      });
    } finally {
      await daemon.stop();
    }
  });

  it("advances a waiting run to a terminal state when PR predicates match", async () => {
    const root = await makeTempRoot();
    await writeWaitStateProject(root);
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
        currentStateId: "holding",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/8-wait-state-acceptance-fixture",
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
      expect(after?.terminalStateId).toBe("done");
      expect(after?.stateTransitionReason).toContain(
        "holding advanced to done"
      );
    } finally {
      store.close();
    }
  });

  it("advances a wait state targeting pr_merged: true after the tracked PR has been merged", async () => {
    const root = await makeTempRoot();
    // Workflow uses `pr_merged: true` on the wait transition. Predicate
    // projection only emits `pr_merged: true` from the live GitHub follow-up
    // state, so the wait reconciler must still be able to find the tracked
    // PR row after PR follow-up has marked its tracked state "merged".
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
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: wait_for_merge",
        "  initial: awaiting_merge",
        "  states:",
        "    awaiting_merge:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: merged",
        "          when:",
        "            pr_merged: true",
        "    merged:",
        "      terminal: success",
        ""
      ].join("\n")
    );

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
        currentStateId: "awaiting_merge",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/8-wait-state-acceptance-fixture",
        headSha: "deadbeef",
        issueNumber: issue.number,
        prNumber: 99,
        prUrl: "https://example.test/pr/99",
        projectName: "symphonika",
        runId: "parent-run"
      });
      // PR follow-up has already observed the merge: tracked row's state
      // becomes "merged" and listOpenTrackedPullRequests would filter it out.
      const tracked = store
        .listOpenTrackedPullRequests()
        .find((pr) => pr.prNumber === 99);
      if (tracked === undefined) {
        throw new Error("tracked PR row missing in fixture setup");
      }
      store.recordPullRequestObservation({
        headSha: "deadbeef",
        id: tracked.id,
        prUrl: tracked.prUrl,
        state: "merged"
      });
      expect(store.listOpenTrackedPullRequests()).toHaveLength(0);

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi
          .fn()
          .mockResolvedValue(prState({ state: "MERGED", merged: true })),
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
      expect(after?.terminalStateId).toBe("merged");
      expect(githubIssuesApi.getPullRequestFollowupState).toHaveBeenCalledTimes(
        1
      );
    } finally {
      store.close();
    }
  });

  it("keeps the run waiting when PR predicates do not match", async () => {
    const root = await makeTempRoot();
    await writeWaitStateProject(root);
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
        currentStateId: "holding",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/8-wait-state-acceptance-fixture",
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
          .mockResolvedValue(prState({ statusCheckRollupState: "PENDING" })),
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
      expect(after?.terminalStateId).toBeNull();
    } finally {
      store.close();
    }
  });

  it("stays parked when no PR is tracked yet", async () => {
    const root = await makeTempRoot();
    await writeWaitStateProject(root);
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
        currentStateId: "holding",
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
        getPullRequestFollowupState: vi.fn(),
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
      expect(
        githubIssuesApi.getPullRequestFollowupState
      ).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("daemon tick reconciles a waiting run forward when PR predicates become satisfied", async () => {
    const root = await makeTempRoot();
    await writeWaitStateProject(root);

    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const issue = issueFixture();
    const githubIssue = {
      ...issue,
      labels: issue.labels.map((name) => ({ name }))
    };

    let prStateValue = prState({ statusCheckRollupState: "PENDING" });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(githubIssue),
      getPullRequestFollowupState: vi.fn(() => Promise.resolve(prStateValue)),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([githubIssue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };

    const providerInputs: ProviderRunInput[] = [];
    const codexProvider = recordingCodexProvider(providerInputs);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `tick-wait-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const databasePath = path.join(root, ".symphonika", "symphonika.db");
      const waitingRow = await waitForWaitingRow(databasePath);
      expect(waitingRow.state).toBe("waiting");

      // Manually seed a tracked PR so the wait reconciler can find it.
      const tickDatabase = new Database(databasePath);
      try {
        const now = new Date().toISOString();
        tickDatabase
          .prepare(
            [
              "insert into tracked_pull_requests (",
              "project_name, issue_number, run_id, pr_number, pr_url,",
              "branch_name, head_sha_at_dispatch, last_seen_head_sha, state,",
              "last_observed_at, created_at, updated_at",
              ") values (?,?,?,?,?,?,?,?,?,?,?,?)"
            ].join(" ")
          )
          .run(
            "symphonika",
            issue.number,
            "tick-wait-1",
            99,
            "https://example.test/pr/99",
            preparedWorkspace.branchName,
            "deadbeef",
            "deadbeef",
            "open",
            now,
            now,
            now
          );
      } finally {
        tickDatabase.close();
      }

      // Predicates become satisfied. The next daemon tick should advance.
      prStateValue = prState();
      const pollResponse = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(pollResponse.ok).toBe(true);

      const deadline = Date.now() + 5000;
      let advanced = false;
      while (Date.now() < deadline) {
        const database = new Database(databasePath, { readonly: true });
        try {
          const row = database
            .prepare("select state, terminal_state_id from runs where id = ?")
            .get(waitingRow.id) as
            { state: string; terminal_state_id: string | null } | undefined;
          if (row?.state === "succeeded" && row.terminal_state_id === "done") {
            advanced = true;
            break;
          }
        } finally {
          database.close();
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(advanced).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("routes wait → autofix agent state on unresolved review feedback", async () => {
    const root = await makeTempRoot();
    // Custom workflow: planning → review_check (wait) → autofix (agent) on
    // unresolved reviews; → merged (terminal) on clean.
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
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: review_branch",
        "  initial: review_check",
        "  states:",
        "    review_check:",
        "      action:",
        "        kind: wait",
        "      transitions:",
        "        - to: autofix",
        "          when:",
        "            unresolved_review_threads: 1",
        "        - to: merged",
        "          when:",
        "            checks: success",
        "            mergeable: true",
        "    autofix:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: autofix-prompt.md",
        "      transitions:",
        "        - to: merged",
        "    merged:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "autofix-prompt.md"),
      "Autofix #{{issue.number}}.\n"
    );

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
        currentStateId: "review_check",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });
      store.trackPullRequest({
        branchName: "sym/symphonika/8-wait-state-acceptance-fixture",
        headSha: "deadbeef",
        issueNumber: issue.number,
        prNumber: 99,
        prUrl: "https://example.test/pr/99",
        projectName: "symphonika",
        runId: "parent-run"
      });

      const reviewThread = {
        comments: [],
        id: "PRRT_kwDO",
        isResolved: false
      };
      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          labels: issue.labels.map((name) => ({ name }))
        }),
        getPullRequestFollowupState: vi.fn().mockResolvedValue(
          prState({
            mergeable: "MERGEABLE",
            reviewDecision: "CHANGES_REQUESTED",
            statusCheckRollupState: "SUCCESS",
            unresolvedReviewThreads: [reviewThread]
          })
        ),
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
      expect(after?.currentStateId).toBe("autofix");
      expect(after?.stateTransitionReason).toContain(
        "review_check advanced to autofix"
      );
    } finally {
      store.close();
    }
  });

  it("cancels a waiting run when the issue has been closed", async () => {
    const root = await makeTempRoot();
    await writeWaitStateProject(root);
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
        currentStateId: "holding",
        id: "waiting-run",
        issue,
        parentRunId: "parent-run",
        projectName: "symphonika"
      });

      const githubIssuesApi: GitHubIssuesApi = {
        getIssue: vi.fn().mockResolvedValue({
          ...issue,
          state: "closed",
          labels: issue.labels.map((name) => ({ name }))
        }),
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
      expect(after?.state).toBe("cancelled");
      expect(after?.cancelReason).toBe("closed_issue");
    } finally {
      store.close();
    }
  });
});
