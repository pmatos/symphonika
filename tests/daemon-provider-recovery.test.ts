import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon, type DaemonHandle } from "../src/daemon.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import type {
  AgentProvider,
  AgentProviderName,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { createDeferred } from "./helpers/deferred.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];
const daemons: DaemonHandle[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop().catch(() => undefined);
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const ISSUE_NUMBER = 8;
const TITLE = "Recover a stopped state";
const PLAN_ID = "plan-recovery";
const CODEX_COMMAND = "codex app-server";
const CLAUDE_COMMAND =
  "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json";

type Call = { prompt: string; provider: AgentProviderName; runId: string };

type Behavior = (call: Call) => Promise<number> | number;

function recordingProvider(
  name: AgentProviderName,
  calls: Call[],
  behavior: Behavior
): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name,
    runAttempt: vi.fn(async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      const call = {
        prompt: input.prompt,
        provider: name,
        runId: input.run.id
      };
      calls.push(call);
      const exitCode = await behavior(call);
      yield {
        normalized: { exitCode, type: "process_exit" },
        raw: { code: exitCode, kind: "exit" }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

function issueFixture(
  overrides: { labels?: string[]; state?: string } = {}
): Record<string, unknown> {
  return {
    body: `${TITLE} body.`,
    created_at: "2026-04-20T10:00:00Z",
    html_url: `https://github.com/pmatos/symphonika/issues/${ISSUE_NUMBER}`,
    id: 5000 + ISSUE_NUMBER,
    labels: overrides.labels ?? ["agent-ready"],
    number: ISSUE_NUMBER,
    state: overrides.state ?? "open",
    title: TITLE,
    updated_at: "2026-04-21T11:00:00Z"
  };
}

function issueSnapshot(): IssueSnapshot {
  return {
    body: `${TITLE} body.`,
    created_at: "2026-04-20T10:00:00Z",
    id: 5000 + ISSUE_NUMBER,
    labels: ["agent-ready"],
    number: ISSUE_NUMBER,
    priority: 99,
    state: "open",
    title: TITLE,
    updated_at: "2026-04-21T11:00:00Z",
    url: `https://github.com/pmatos/symphonika/issues/${ISSUE_NUMBER}`
  };
}

async function writeProject(root: string, workflow: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      `    command: "${CODEX_COMMAND}"`,
      "  claude:",
      `    command: "${CLAUDE_COMMAND}"`,
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
  await writeFile(path.join(root, "workflow.yml"), workflow);
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Draft a plan for #{{issue.number}}.\n"
  );
  await writeFile(
    path.join(root, "autofix-prompt.md"),
    "Apply the autofix for #{{issue.number}}.\n"
  );
}

const PLAN_THEN_AUTOFIX = [
  "workflow:",
  "  name: plan_then_autofix",
  "  initial: planning",
  "  states:",
  "    planning:",
  "      action:",
  "        kind: agent",
  "        prompt: plan-prompt.md",
  "      complete_when:",
  "        provider_success: true",
  "        branch_ahead_of_base: true",
  "      transitions:",
  "        - to: autofix",
  "    autofix:",
  "      action:",
  "        kind: agent",
  "        prompt: autofix-prompt.md",
  "      complete_when:",
  "        provider_success: true",
  "        branch_ahead_of_base: true",
  "      transitions:",
  "        - to: done",
  "    done:",
  "      terminal: success",
  ""
].join("\n");

function preparedWorkspace(root: string): PreparedIssueWorkspace {
  const issueDirectoryName = `${ISSUE_NUMBER}-recover-a-stopped-state`;
  return {
    branchName: `sym/symphonika/${issueDirectoryName}`,
    branchRef: `refs/heads/sym/symphonika/${issueDirectoryName}`,
    cachePath: path.join(root, ".symphonika", "cache", "repo.git"),
    issueDirectoryName,
    reused: false,
    workspacePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      issueDirectoryName
    )
  };
}

type Harness = {
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  claudeCalls: Call[];
  codexCalls: Call[];
  daemon: DaemonHandle;
  getIssue: ReturnType<typeof vi.fn>;
  removeLabelsFromIssue: ReturnType<typeof vi.fn>;
  root: string;
  workspace: PreparedIssueWorkspace;
};

async function startHarness(options: {
  claude?: Behavior;
  // Replaces the recording claude provider, for a test that must hold an
  // attempt open across a daemon stop.
  claudeProvider?: AgentProvider;
  codex?: Behavior;
  // Open Issues the first poll returns; the stopped-state seeds start none.
  dispatch?: boolean;
  liveIssue?: Record<string, unknown>;
  // The Issue the first poll returns (default: the plain Ready Issue).
  polledIssue?: Record<string, unknown>;
  retryDelayMs?: number;
  root?: string;
  runIdPrefix?: string;
  seed?: (store: ReturnType<typeof openRunStore>) => void;
  seedPlan?: boolean;
  workflow?: string;
}): Promise<Harness> {
  const root =
    options.root ??
    (await mkdtemp(path.join(tmpdir(), "symphonika-provider-recovery-")));
  if (options.root === undefined) {
    tempRoots.push(root);
    await writeProject(root, options.workflow ?? PLAN_THEN_AUTOFIX);
  }
  const workspace = preparedWorkspace(root);
  if (options.root === undefined) {
    await createGitWorkspaceAhead(workspace);
  }

  if (options.seedPlan === true || options.seed !== undefined) {
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      if (options.seedPlan === true) {
        store.createProviderPlan({
          graphFingerprint: "sha256:graph",
          id: PLAN_ID,
          issueNumber: ISSUE_NUMBER,
          projectName: "symphonika",
          provider: "codex",
          readyLabel: "agent-ready",
          repository: { owner: "pmatos", repo: "symphonika" },
          snapshotPolledAt: "2026-10-09T10:00:00.000Z"
        });
        store.markProviderPlanLabelResult(PLAN_ID, { ok: true });
      }
      options.seed?.(store);
    } finally {
      store.close();
    }
  }

  const liveIssue = options.liveIssue ?? issueFixture();
  const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
  const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
  const getIssue = vi.fn().mockResolvedValue(liveIssue);
  const codexCalls: Call[] = [];
  const claudeCalls: Call[] = [];
  let runCounter = 0;
  const daemon = await startDaemon({
    agentProviders: {
      claude:
        options.claudeProvider ??
        recordingProvider("claude", claudeCalls, options.claude ?? (() => 0)),
      codex: recordingProvider("codex", codexCalls, options.codex ?? (() => 0))
    },
    createRunId: () => `${options.runIdPrefix ?? "run"}-${++runCounter}`,
    cwd: root,
    env: { GITHUB_TOKEN: "secret-token" },
    githubIssuesApi: {
      addLabelsToIssue,
      getIssue,
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce(
          options.dispatch === false
            ? []
            : [options.polledIssue ?? issueFixture()]
        )
        .mockResolvedValue([]),
      removeLabelsFromIssue
    },
    lifecyclePolicy: {
      continuation: { cap: 0, delayMs: 5 },
      retry:
        options.retryDelayMs === undefined
          ? { cap: 0, delaysMs: [], maxBackoffMs: 0 }
          : {
              cap: 1,
              delaysMs: [options.retryDelayMs],
              maxBackoffMs: options.retryDelayMs
            }
    },
    logger: pino({ enabled: false }),
    port: 0,
    prepareIssueWorkspace: () => Promise.resolve(workspace)
  });
  daemons.push(daemon);
  return {
    addLabelsToIssue,
    claudeCalls,
    codexCalls,
    daemon,
    getIssue,
    removeLabelsFromIssue,
    root,
    workspace
  };
}

function query<T>(root: string, sql: string, ...params: unknown[]): T[] {
  const database = new Database(
    path.join(root, ".symphonika", "symphonika.db"),
    { readonly: true }
  );
  try {
    return database.prepare(sql).all(...params) as T[];
  } finally {
    database.close();
  }
}

async function waitFor(
  description: string,
  condition: () => boolean,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (condition()) {
        return;
      }
    } catch {
      // The daemon may still be creating its store.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function recover(
  harness: Harness,
  body: { provider: string; runId: string; stateId: string }
): Promise<{ body: Record<string, unknown>; status: number }> {
  const response = await fetch(
    `${harness.daemon.url}/api/issues/symphonika/${ISSUE_NUMBER}/recover`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    }
  );
  return {
    body: (await response.json()) as Record<string, unknown>,
    status: response.status
  };
}

type RunRow = {
  branch_name: string | null;
  continuation_parent_run_id: string | null;
  current_state_id: string | null;
  id: string;
  provider_name: string;
  provider_source: string | null;
  state: string;
  terminal_reason: string | null;
  terminal_state_id: string | null;
  workspace_path: string | null;
};

function runRows(root: string): RunRow[] {
  return query<RunRow>(
    root,
    [
      "select id, continuation_parent_run_id, current_state_id, provider_name,",
      "provider_source, state, terminal_reason, terminal_state_id,",
      "workspace_path, branch_name from runs order by created_at, rowid"
    ].join(" ")
  );
}

type InterventionRow = {
  chain_root_run_id: string;
  from_provider: string | null;
  from_run_id: string;
  kind: string;
  last_error: string | null;
  outcome: string;
  requested_via: string;
  state_id: string;
  to_provider: string;
  to_run_id: string | null;
};

function interventionRows(root: string): InterventionRow[] {
  return query<InterventionRow>(
    root,
    "select * from chain_provider_interventions order by created_at, rowid"
  );
}

function planRows(root: string): unknown[] {
  return query(root, "select * from run_chain_provider_plans order by id");
}

// A first attempt at `autofix` that fails: planning completes on codex, then
// codex exits non-zero for autofix, leaving the Run failed at that state.
const codexFailsAutofix: Behavior = (call) =>
  call.prompt.includes("autofix") ? 1 : 0;

describe("recovering a stopped FSM state with a different provider (#863)", () => {
  it("re-enters the failed state on the new provider without replaying earlier states", async () => {
    const harness = await startHarness({
      codex: codexFailsAutofix,
      seedPlan: true
    });
    await waitFor("autofix to fail", () =>
      runRows(harness.root).some((run) => run.state === "failed")
    );
    const before = runRows(harness.root);
    expect(before.map((run) => [run.id, run.state])).toEqual([
      ["run-1", "succeeded"],
      ["run-2", "failed"]
    ]);
    const planBefore = planRows(harness.root);
    const failedAttempts = query<{ id: string; provider_name: string }>(
      harness.root,
      "select id, provider_name from attempts where run_id = 'run-2'"
    );
    harness.getIssue.mockResolvedValue(
      issueFixture({
        labels: ["agent-ready", "sym:failed", "sym:human-needed"]
      })
    );

    const response = await recover(harness, {
      provider: "claude",
      runId: "run-2",
      stateId: "autofix"
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      fromRunId: "run-2",
      kind: "accepted",
      stateId: "autofix",
      toProvider: "claude"
    });
    await waitFor("the walk to reach done", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    const rows = runRows(harness.root);
    expect(rows.map((run) => run.id)).toEqual(["run-1", "run-2", "run-3"]);
    const [planning, failed, recovered] = rows;
    // Chain, position, branch and Workspace carry over onto a Continuation of
    // the stopped Run, and the new Run records why its provider was chosen.
    expect(recovered).toMatchObject({
      branch_name: failed?.branch_name,
      continuation_parent_run_id: "run-2",
      provider_name: "claude",
      provider_source: "operator_recovery",
      state: "succeeded",
      terminal_state_id: "done",
      workspace_path: harness.workspace.workspacePath
    });
    // The earlier Runs and their evidence are exactly as they were.
    expect(rows.slice(0, 2)).toEqual(before);
    expect(planning).toMatchObject({
      provider_name: "codex",
      state: "succeeded"
    });
    expect(
      query(
        harness.root,
        "select id, provider_name from attempts where run_id = 'run-2'"
      )
    ).toEqual(failedAttempts);
    // planning is not replayed: codex ran it once and autofix once, and the
    // recovery is the only claude call.
    expect(
      harness.codexCalls.map((call) => call.prompt.includes("Draft a plan"))
    ).toEqual([true, false]);
    expect(harness.claudeCalls).toHaveLength(1);
    expect(harness.claudeCalls[0]?.prompt).toContain("autofix");
    expect(harness.claudeCalls[0]?.runId).toBe("run-3");
    // The consumed plan is not rewritten by the recovery.
    expect(planRows(harness.root)).toEqual(planBefore);
    expect(
      query<{ provider_source: string }>(
        harness.root,
        "select provider_source from runs where id = 'run-1'"
      )[0]?.provider_source
    ).toBe("operator_chain");
    // The audit row names the chain, the position and both providers, and is
    // settled against the Run it produced.
    expect(interventionRows(harness.root)).toMatchObject([
      {
        chain_root_run_id: "run-1",
        from_provider: "codex",
        from_run_id: "run-2",
        kind: "recovery",
        last_error: null,
        outcome: "launched",
        requested_via: "http",
        state_id: "autofix",
        to_provider: "claude",
        to_run_id: "run-3"
      }
    ]);
    // The stopped verdict is withdrawn once the recovery owns the Issue again.
    const removed = harness.removeLabelsFromIssue.mock.calls.flatMap(
      (call) => (call[0] as { labels: string[] }).labels
    );
    expect(removed).toEqual(
      expect.arrayContaining(["sym:failed", "sym:human-needed"])
    );
  });

  it("refuses while a retry of the stopped state is still scheduled", async () => {
    const harness = await startHarness({
      codex: codexFailsAutofix,
      retryDelayMs: 60_000,
      seedPlan: true
    });
    await waitFor("autofix to fail and schedule its retry", () =>
      runRows(harness.root).some((run) => run.state === "failed")
    );

    const response = await recover(harness, {
      provider: "claude",
      runId: "run-2",
      stateId: "autofix"
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      kind: "refused",
      liveRunId: "run-2",
      reason: "live-run"
    });
    expect(harness.claudeCalls).toHaveLength(0);
    expect(interventionRows(harness.root)).toEqual([]);
    expect(runRows(harness.root)).toHaveLength(2);
  });

  it("refuses to switch the provider of an attempt that is executing", async () => {
    const release = createDeferred();
    const harness = await startHarness({
      codex: async (call) => {
        if (call.prompt.includes("autofix")) {
          await release.promise;
        }
        return 0;
      },
      seedPlan: true
    });
    await waitFor("autofix to be running", () =>
      runRows(harness.root).some(
        (run) => run.id === "run-2" && run.state === "running"
      )
    );
    const planBefore = planRows(harness.root);

    const response = await recover(harness, {
      provider: "claude",
      runId: "run-2",
      stateId: "autofix"
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      kind: "refused",
      reason: "run-not-stopped"
    });
    release.resolve();
    await waitFor("the walk to reach done", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );
    expect(harness.claudeCalls).toHaveLength(0);
    expect(interventionRows(harness.root)).toEqual([]);
    expect(planRows(harness.root)).toEqual(planBefore);
  });

  it("accepts exactly one of two concurrent submissions", async () => {
    const harness = await startHarness({ codex: codexFailsAutofix });
    await waitFor("autofix to fail", () =>
      runRows(harness.root).some((run) => run.state === "failed")
    );

    const responses = await Promise.all([
      recover(harness, {
        provider: "claude",
        runId: "run-2",
        stateId: "autofix"
      }),
      recover(harness, {
        provider: "claude",
        runId: "run-2",
        stateId: "autofix"
      })
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409
    ]);
    await waitFor("the walk to reach done", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );
    expect(harness.claudeCalls).toHaveLength(1);
    expect(interventionRows(harness.root)).toHaveLength(1);
  });

  it("settles the intervention as dropped when the Issue closes before the launch", async () => {
    const harness = await startHarness({
      codex: codexFailsAutofix,
      seedPlan: true
    });
    await waitFor("autofix to fail", () =>
      runRows(harness.root).some((run) => run.state === "failed")
    );
    harness.getIssue.mockReset();
    harness.getIssue
      .mockResolvedValueOnce(issueFixture())
      .mockResolvedValue(issueFixture({ state: "closed" }));

    const response = await recover(harness, {
      provider: "claude",
      runId: "run-2",
      stateId: "autofix"
    });

    expect(response.status).toBe(202);
    await waitFor(
      "the intervention to be dropped",
      () => interventionRows(harness.root)[0]?.outcome === "dropped"
    );
    expect(interventionRows(harness.root)[0]?.last_error).toContain(
      "before a Run was created"
    );
    expect(runRows(harness.root)).toHaveLength(2);
    expect(harness.claudeCalls).toHaveLength(0);
  });

  it("keeps the operator's provider when a shutdown resumes the recovered Run", async () => {
    let releaseProvider: (() => void) | undefined;
    const providerStopped = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const heldClaude: AgentProvider = {
      cancel: vi.fn(() => {
        releaseProvider?.();
        return Promise.resolve();
      }),
      name: "claude",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { sessionId: "held-session", type: "session_started" },
          raw: { id: "held-session", kind: "session" }
        };
        await providerStopped;
        yield {
          normalized: { cancelled: true, exitCode: 143, type: "process_exit" },
          raw: { code: 143, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const first = await startHarness({
      claudeProvider: heldClaude,
      codex: codexFailsAutofix,
      seedPlan: true
    });
    await waitFor("autofix to fail", () =>
      runRows(first.root).some((run) => run.state === "failed")
    );
    expect(
      (
        await recover(first, {
          provider: "claude",
          runId: "run-2",
          stateId: "autofix"
        })
      ).status
    ).toBe(202);
    await waitFor("the recovered attempt to run", () =>
      runRows(first.root).some(
        (run) => run.id === "run-3" && run.state === "running"
      )
    );
    await first.daemon.stop();
    releaseProvider?.();
    expect(
      query<{ cancel_reason: string; state: string }>(
        first.root,
        "select cancel_reason, state from runs where id = 'run-3'"
      )
    ).toEqual([{ cancel_reason: "daemon_shutdown", state: "cancelled" }]);

    const second = await startHarness({
      codex: codexFailsAutofix,
      liveIssue: issueFixture({ labels: ["agent-ready", "sym:claimed"] }),
      polledIssue: issueFixture({ labels: ["agent-ready", "sym:claimed"] }),
      root: first.root,
      runIdPrefix: "boot2-run"
    });
    await waitFor("the resumed walk to reach done", () =>
      runRows(second.root).some((run) => run.terminal_state_id === "done")
    );

    // The resume would otherwise fall back to the plan's codex and fail
    // autofix again, silently undoing the operator's choice.
    expect(second.codexCalls).toHaveLength(0);
    expect(second.claudeCalls).toHaveLength(1);
    expect(
      runRows(second.root).find((run) => run.id === "boot2-run-1")
    ).toMatchObject({
      continuation_parent_run_id: "run-3",
      provider_name: "claude",
      provider_source: "operator_recovery",
      state: "succeeded"
    });
  });

  describe("refusals leave no trace", () => {
    function seedStopped(
      store: ReturnType<typeof openRunStore>,
      input: {
        currentStateId?: string | null;
        id?: string;
        state: "cancelled" | "failed" | "succeeded" | "waiting";
      }
    ): void {
      const id = input.id ?? "run-seed";
      store.createRun({
        id,
        issue: issueSnapshot(),
        projectName: "symphonika",
        providerCommand: CODEX_COMMAND,
        providerName: "codex"
      });
      if (input.currentStateId !== null) {
        store.setRunCurrentState(id, input.currentStateId ?? "autofix");
      }
      store.updateRunState(id, input.state);
    }

    type Case = {
      body?: Partial<{ provider: string; runId: string; stateId: string }>;
      liveIssue?: Record<string, unknown>;
      name: string;
      reason: string;
      seed: (store: ReturnType<typeof openRunStore>) => void;
      status: number;
    };

    const cases: Case[] = [
      {
        liveIssue: issueFixture({ state: "closed" }),
        name: "a closed Issue",
        reason: "issue-closed",
        seed: (store) => seedStopped(store, { state: "failed" }),
        status: 422
      },
      {
        liveIssue: issueFixture({ labels: ["agent-ready", "sym:stale"] }),
        name: "a stale claim",
        reason: "claim-held",
        seed: (store) => seedStopped(store, { state: "failed" }),
        status: 409
      },
      {
        liveIssue: issueFixture({ labels: ["agent-ready", "sym:claimed"] }),
        name: "a held claim",
        reason: "claim-held",
        seed: (store) => seedStopped(store, { state: "failed" }),
        status: 409
      },
      {
        name: "a cancelled Run",
        reason: "run-not-stopped",
        seed: (store) => seedStopped(store, { state: "cancelled" }),
        status: 422
      },
      {
        name: "a succeeded Run",
        reason: "run-not-stopped",
        seed: (store) => seedStopped(store, { state: "succeeded" }),
        status: 422
      },
      {
        name: "a parked waiting Run",
        reason: "run-not-stopped",
        seed: (store) => seedStopped(store, { state: "waiting" }),
        status: 422
      },
      {
        name: "a Run that reached a workflow terminal",
        reason: "invalid-position",
        seed: (store) =>
          seedStopped(store, { currentStateId: null, state: "failed" }),
        status: 422
      },
      {
        name: "a position that is a terminal state, not an agent state",
        body: { stateId: "done" },
        reason: "invalid-position",
        seed: (store) =>
          seedStopped(store, { currentStateId: "done", state: "failed" }),
        status: 422
      },
      {
        name: "a state the workflow no longer has",
        body: { stateId: "ghost" },
        reason: "invalid-position",
        seed: (store) =>
          seedStopped(store, { currentStateId: "ghost", state: "failed" }),
        status: 422
      },
      {
        name: "a position that differs from the one reviewed",
        body: { stateId: "planning" },
        reason: "position-mismatch",
        seed: (store) => seedStopped(store, { state: "failed" }),
        status: 422
      },
      {
        name: "a Run that a later Run superseded",
        reason: "superseded",
        seed: (store) => {
          seedStopped(store, { state: "failed" });
          seedStopped(store, { id: "run-later", state: "failed" });
        },
        status: 422
      },
      {
        name: "a provider that is not configured",
        body: { provider: "omp" },
        reason: "provider-unavailable",
        seed: (store) => seedStopped(store, { state: "failed" }),
        status: 422
      },
      {
        name: "a provider name that does not exist",
        body: { provider: "gpt" },
        reason: "provider-unavailable",
        seed: (store) => seedStopped(store, { state: "failed" }),
        status: 422
      },
      {
        name: "a Run that does not exist",
        body: { runId: "nope" },
        reason: "run-not-found",
        seed: () => undefined,
        status: 422
      }
    ];

    for (const refusal of cases) {
      it(`refuses ${refusal.name}`, async () => {
        const harness = await startHarness({
          dispatch: false,
          ...(refusal.liveIssue === undefined
            ? {}
            : { liveIssue: refusal.liveIssue }),
          seed: refusal.seed
        });
        const runsBefore = runRows(harness.root);
        const labelWritesBefore = harness.addLabelsToIssue.mock.calls.length;

        const response = await recover(harness, {
          provider: "claude",
          runId: "run-seed",
          stateId: "autofix",
          ...refusal.body
        });

        expect(response.status).toBe(refusal.status);
        expect(response.body).toMatchObject({
          kind: "refused",
          reason: refusal.reason
        });
        expect(runRows(harness.root)).toEqual(runsBefore);
        expect(interventionRows(harness.root)).toEqual([]);
        expect(harness.claudeCalls).toHaveLength(0);
        expect(harness.addLabelsToIssue.mock.calls).toHaveLength(
          labelWritesBefore
        );
        expect(harness.removeLabelsFromIssue).not.toHaveBeenCalled();
      });
    }

    it("refuses a recovery when the workflow is not a raw FSM", async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-recovery-")
      );
      tempRoots.push(root);
      await writeProject(root, PLAN_THEN_AUTOFIX);
      const configPath = path.join(root, "symphonika.yml");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8")).replace(
          "./workflow.yml",
          "./WORKFLOW.md"
        )
      );
      await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");
      const harness = await startHarness({
        dispatch: false,
        root,
        seed: (store) => seedStopped(store, { state: "failed" })
      });

      const response = await recover(harness, {
        provider: "claude",
        runId: "run-seed",
        stateId: "autofix"
      });

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ reason: "workflow-not-fsm" });
      expect(interventionRows(harness.root)).toEqual([]);
    });
  });

  it("answers 400 for a malformed body", async () => {
    const harness = await startHarness({ dispatch: false });
    const malformed = await fetch(
      `${harness.daemon.url}/api/issues/symphonika/${ISSUE_NUMBER}/recover`,
      {
        body: JSON.stringify({ provider: "claude" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    );
    expect(malformed.status).toBe(400);
  });
});
