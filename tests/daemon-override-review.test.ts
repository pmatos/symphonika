import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon, type DaemonHandle } from "../src/daemon.js";
import type {
  AgentProvider,
  AgentProviderName,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";
import { expandWorkflowDefinition } from "../src/workflow/fsm-expansion.js";
import {
  stateDefinitionEvidence,
  type StateDefinitionEvidence
} from "../src/workflow/state-definition-digest.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
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
const PLAN_ID = "plan-override-review";
const REVIEW_REASON = "provider_override_review_required:";

type Call = { prompt: string; provider: AgentProviderName; runId: string };

function recordingProvider(
  name: AgentProviderName,
  calls: Call[]
): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name,
    runAttempt: vi.fn(async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      calls.push({ prompt: input.prompt, provider: name, runId: input.run.id });
      await Promise.resolve();
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

function issueFixture(): Record<string, unknown> {
  return {
    body: "Review an override body.",
    created_at: "2026-04-20T10:00:00Z",
    html_url: `https://github.com/pmatos/symphonika/issues/${ISSUE_NUMBER}`,
    id: 5000 + ISSUE_NUMBER,
    labels: ["agent-ready"],
    number: ISSUE_NUMBER,
    state: "open",
    title: "Review an override",
    updated_at: "2026-04-21T11:00:00Z"
  };
}

function workflowYaml(
  options: {
    autofixId?: string;
    autofixPrompt?: string;
    planningPrompt?: string;
  } = {}
): string {
  const autofixId = options.autofixId ?? "autofix";
  return [
    "workflow:",
    "  name: plan_then_autofix",
    "  initial: planning",
    "  states:",
    "    planning:",
    "      action:",
    "        kind: agent",
    `        prompt: ${options.planningPrompt ?? "plan-prompt.md"}`,
    "      complete_when:",
    "        provider_success: true",
    "        branch_ahead_of_base: true",
    "      transitions:",
    `        - to: ${autofixId}`,
    `    ${autofixId}:`,
    "      action:",
    "        kind: agent",
    `        prompt: ${options.autofixPrompt ?? "autofix-prompt.md"}`,
    "      complete_when:",
    "        provider_success: true",
    "        branch_ahead_of_base: true",
    "      transitions:",
    "        - to: done",
    "    done:",
    "      terminal: success",
    ""
  ].join("\n");
}

function evidenceOf(yaml: string, stateId: string): StateDefinitionEvidence {
  const loaded = expandWorkflowDefinition(yaml, "workflow.yml", "auto");
  expect(loaded.errors).toEqual([]);
  const state = loaded.workflow.states.find((entry) => entry.id === stateId);
  if (state === undefined) {
    throw new Error(`state ${stateId} missing from the fixture workflow`);
  }
  return stateDefinitionEvidence(state);
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
      '    command: "codex app-server"',
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
  await writeFile(path.join(root, "workflow.yml"), workflow);
  for (const prompt of [
    "plan-prompt.md",
    "plan-v2-prompt.md",
    "autofix-prompt.md",
    "autofix-v2-prompt.md"
  ]) {
    await writeFile(
      path.join(root, prompt),
      `${prompt} for #{{issue.number}}.\n`
    );
  }
}

function preparedWorkspace(root: string): PreparedIssueWorkspace {
  const issueDirectoryName = `${ISSUE_NUMBER}-review-an-override`;
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

type PlanSeed = {
  // Per-state choices as recorded at Start, against `recordedWorkflow`.
  overrides?: Record<string, AgentProviderName>;
  // Rewrites state_providers_json to the pre-#864 bare-string shape.
  legacy?: boolean;
  recordedWorkflow?: string;
};

type Harness = {
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  claudeCalls: Call[];
  codexCalls: Call[];
  daemon: DaemonHandle;
  root: string;
};

async function startHarness(options: {
  // What is on disk when the daemon starts (the edited workflow).
  workflow: string;
  plan: PlanSeed;
  continuationDelayMs?: number;
}): Promise<Harness> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-override-review-")
  );
  tempRoots.push(root);
  await writeProject(root, options.workflow);
  const workspace = preparedWorkspace(root);
  await createGitWorkspaceAhead(workspace);

  const recorded = options.plan.recordedWorkflow ?? workflowYaml();
  const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
  try {
    const overrides = options.plan.overrides ?? {};
    store.createProviderPlan({
      graphFingerprint: "sha256:graph",
      id: PLAN_ID,
      issueNumber: ISSUE_NUMBER,
      projectName: "symphonika",
      provider: "codex",
      readyLabel: "agent-ready",
      repository: { owner: "pmatos", repo: "symphonika" },
      snapshotPolledAt: "2026-10-09T10:00:00.000Z",
      stateDefinitions:
        options.plan.legacy === true
          ? {}
          : Object.fromEntries(
              Object.keys(overrides).map((stateId) => [
                stateId,
                evidenceOf(recorded, stateId)
              ])
            ),
      stateProviders: overrides
    });
    store.markProviderPlanLabelResult(PLAN_ID, { ok: true });
  } finally {
    store.close();
  }

  const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
  const codexCalls: Call[] = [];
  const claudeCalls: Call[] = [];
  let runCounter = 0;
  const daemon = await startDaemon({
    agentProviders: {
      claude: recordingProvider("claude", claudeCalls),
      codex: recordingProvider("codex", codexCalls)
    },
    createRunId: () => `run-${++runCounter}`,
    cwd: root,
    env: { GITHUB_TOKEN: "secret-token" },
    githubIssuesApi: {
      addLabelsToIssue,
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issueFixture()])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    },
    lifecyclePolicy: {
      continuation: { cap: 0, delayMs: options.continuationDelayMs ?? 5 },
      retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
    },
    logger: pino({ enabled: false }),
    port: 0,
    prepareIssueWorkspace: () => Promise.resolve(workspace)
  });
  daemons.push(daemon);
  return { addLabelsToIssue, claudeCalls, codexCalls, daemon, root };
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

type RunRow = {
  continuation_parent_run_id: string | null;
  current_state_id: string | null;
  id: string;
  provider_name: string;
  provider_plan_id: string | null;
  provider_source: string | null;
  state: string;
  state_transition_reason: string | null;
  terminal_reason: string | null;
  terminal_state_id: string | null;
};

function runRows(root: string): RunRow[] {
  return query<RunRow>(
    root,
    [
      "select id, continuation_parent_run_id, current_state_id, provider_name,",
      "provider_plan_id, provider_source, state, state_transition_reason,",
      "terminal_reason, terminal_state_id from runs order by created_at, rowid"
    ].join(" ")
  );
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

function addedLabels(harness: Harness): string[] {
  return harness.addLabelsToIssue.mock.calls.flatMap(
    (call) => (call[0] as { labels: string[] }).labels
  );
}

function storedStateProviders(root: string): unknown {
  const row = query<{ state_providers_json: string }>(
    root,
    "select state_providers_json from run_chain_provider_plans where id = ?",
    PLAN_ID
  )[0];
  return JSON.parse(row?.state_providers_json ?? "null");
}

describe("reviewing a per-state provider choice after a workflow edit (#864)", () => {
  it("parks a State Advance before launch when the chosen state's definition changed", async () => {
    const harness = await startHarness({
      plan: { overrides: { autofix: "claude" } },
      workflow: workflowYaml({ autofixPrompt: "autofix-v2-prompt.md" })
    });
    await waitFor("the walk to park", () =>
      runRows(harness.root).some((run) => run.state === "blocked")
    );

    const rows = runRows(harness.root);
    expect(rows.map((run) => [run.id, run.state])).toEqual([
      ["run-1", "succeeded"],
      ["run-2", "blocked"]
    ]);
    expect(rows[1]).toMatchObject({
      continuation_parent_run_id: "run-1",
      current_state_id: "autofix",
      provider_source: null,
      terminal_state_id: "autofix"
    });
    expect(rows[1]?.terminal_reason).toContain(REVIEW_REASON);
    expect(rows[1]?.terminal_reason).toContain('state "autofix"');
    expect(rows[1]?.terminal_reason).toContain("has a different definition");
    expect(rows[1]?.state_transition_reason).toBe(rows[1]?.terminal_reason);
    expect(harness.codexCalls.map((call) => call.runId)).toEqual(["run-1"]);
    expect(harness.claudeCalls).toEqual([]);
    expect(
      query(harness.root, "select id from attempts where run_id = 'run-2'")
    ).toEqual([]);
    expect(addedLabels(harness)).toEqual(
      expect.arrayContaining(["sym:blocked", "sym:human-needed"])
    );
    // The choice itself is untouched: it is what the review resolves.
    expect(storedStateProviders(harness.root)).toMatchObject({
      autofix: { provider: "claude" }
    });
  });

  it("shows the parked Run and its reason on the Issue timeline", async () => {
    const harness = await startHarness({
      plan: { overrides: { autofix: "claude" } },
      workflow: workflowYaml({ autofixPrompt: "autofix-v2-prompt.md" })
    });
    await waitFor("the walk to park", () =>
      runRows(harness.root).some((run) => run.state === "blocked")
    );

    const page = await (
      await fetch(`${harness.daemon.url}/issues/symphonika/${ISSUE_NUMBER}`)
    ).text();

    expect(page).toContain("Blocked");
    expect(page).toContain("provider_override_review_required");
    expect(page).toContain("autofix");
  });

  it("parks when an edit removes the chosen state while the walk is on its way to it", async () => {
    const harness = await startHarness({
      continuationDelayMs: 600,
      plan: { overrides: { autofix: "claude" } },
      workflow: workflowYaml()
    });
    await waitFor("planning to finish", () =>
      runRows(harness.root).some((run) => run.state === "succeeded")
    );
    await writeFile(
      path.join(harness.root, "workflow.yml"),
      workflowYaml({ autofixId: "repair" })
    );
    await waitFor("the walk to park", () =>
      runRows(harness.root).some((run) => run.state === "blocked")
    );

    const rows = runRows(harness.root);
    expect(rows.map((run) => [run.id, run.state])).toEqual([
      ["run-1", "succeeded"],
      ["run-2", "blocked"]
    ]);
    // The position is the state the walk was entering, even though the
    // workflow no longer has it; no workflow_state_not_found failure.
    expect(rows[1]).toMatchObject({
      current_state_id: "autofix",
      terminal_state_id: "autofix"
    });
    expect(rows[1]?.terminal_reason).toContain(REVIEW_REASON);
    expect(rows[1]?.terminal_reason).toContain("no longer exists");
    expect(harness.claudeCalls).toEqual([]);
    expect(harness.codexCalls).toHaveLength(1);
  });

  it("does not park an override for a state the edited walk never enters", async () => {
    const harness = await startHarness({
      plan: { overrides: { autofix: "claude" } },
      workflow: workflowYaml({ autofixId: "repair" })
    });
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    expect(runRows(harness.root).map((run) => run.state)).toEqual([
      "succeeded",
      "succeeded"
    ]);
    expect(harness.codexCalls).toHaveLength(2);
    expect(harness.claudeCalls).toEqual([]);
  });

  it("does not park when only an unrelated state changed", async () => {
    const harness = await startHarness({
      plan: { overrides: { autofix: "claude" } },
      workflow: workflowYaml({ planningPrompt: "plan-v2-prompt.md" })
    });
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    const rows = runRows(harness.root);
    expect(rows.map((run) => run.state)).toEqual(["succeeded", "succeeded"]);
    expect(rows[1]).toMatchObject({
      provider_name: "claude",
      provider_source: "operator_state"
    });
    expect(harness.claudeCalls).toHaveLength(1);
    expect(harness.codexCalls).toHaveLength(1);
  });

  it("keeps a chain-wide choice across a rename, an edit and a removal of other states", async () => {
    const harness = await startHarness({
      plan: {},
      workflow: workflowYaml({
        autofixId: "repair",
        autofixPrompt: "autofix-v2-prompt.md",
        planningPrompt: "plan-v2-prompt.md"
      })
    });
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    expect(runRows(harness.root).map((run) => run.state)).toEqual([
      "succeeded",
      "succeeded"
    ]);
    expect(harness.codexCalls).toHaveLength(2);
    expect(harness.claudeCalls).toEqual([]);
    expect(runRows(harness.root)[1]?.provider_source).toBe("operator_chain");
  });

  it("does not park a choice recorded before definitions were captured", async () => {
    const harness = await startHarness({
      plan: { legacy: true, overrides: { autofix: "claude" } },
      workflow: workflowYaml({ autofixPrompt: "autofix-v2-prompt.md" })
    });
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    expect(storedStateProviders(harness.root)).toEqual({ autofix: "claude" });
    expect(runRows(harness.root)[1]).toMatchObject({
      provider_name: "claude",
      provider_source: "operator_state",
      state: "succeeded"
    });
    expect(harness.claudeCalls).toHaveLength(1);
  });

  it("keeps the last-known-good workflow when a delayed reload is invalid and the choice is unchanged", async () => {
    const harness = await startHarness({
      continuationDelayMs: 600,
      plan: { overrides: { autofix: "claude" } },
      workflow: workflowYaml()
    });
    await waitFor("planning to finish", () =>
      runRows(harness.root).some((run) => run.state === "succeeded")
    );
    await writeFile(
      path.join(harness.root, "workflow.yml"),
      "workflow:\n  initial:\n    -\n"
    );
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    expect(runRows(harness.root).map((run) => run.state)).toEqual([
      "succeeded",
      "succeeded"
    ]);
    expect(harness.claudeCalls).toHaveLength(1);
  });

  it("keeps the last-known-good workflow for a plan with no per-state choices", async () => {
    const harness = await startHarness({
      continuationDelayMs: 600,
      plan: {},
      workflow: workflowYaml()
    });
    await waitFor("planning to finish", () =>
      runRows(harness.root).some((run) => run.state === "succeeded")
    );
    await writeFile(
      path.join(harness.root, "workflow.yml"),
      "workflow:\n  initial:\n    -\n"
    );
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    expect(harness.codexCalls).toHaveLength(2);
    expect(harness.claudeCalls).toEqual([]);
  });

  it("parks a fresh claim whose initial state's definition changed, consuming the plan", async () => {
    const harness = await startHarness({
      plan: { overrides: { planning: "claude" } },
      workflow: workflowYaml({ planningPrompt: "plan-v2-prompt.md" })
    });
    await waitFor("the claim to park", () =>
      runRows(harness.root).some((run) => run.state === "blocked")
    );

    const rows = runRows(harness.root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      continuation_parent_run_id: null,
      current_state_id: "planning",
      id: "run-1",
      provider_plan_id: PLAN_ID,
      provider_source: null,
      state: "blocked",
      terminal_state_id: "planning"
    });
    expect(rows[0]?.terminal_reason).toContain(REVIEW_REASON);
    expect(harness.claudeCalls).toEqual([]);
    expect(harness.codexCalls).toEqual([]);
    expect(
      query<{ status: string }>(
        harness.root,
        "select status from run_chain_provider_plans where id = ?",
        PLAN_ID
      )
    ).toEqual([{ status: "consumed" }]);
    expect(addedLabels(harness)).toEqual(
      expect.arrayContaining(["sym:claimed", "sym:blocked", "sym:human-needed"])
    );
  });

  it("launches a fresh claim normally when its initial state is unchanged", async () => {
    const harness = await startHarness({
      plan: { overrides: { planning: "claude" } },
      workflow: workflowYaml({ autofixPrompt: "autofix-v2-prompt.md" })
    });
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );

    expect(runRows(harness.root)[0]).toMatchObject({
      provider_name: "claude",
      provider_source: "operator_state"
    });
    expect(harness.claudeCalls).toHaveLength(1);
  });
});
