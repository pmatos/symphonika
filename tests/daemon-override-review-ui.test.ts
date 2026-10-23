import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

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
const PLAN_ID = "plan-override-review-ui";

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
  labels: readonly string[],
  state: string
): Record<string, unknown> {
  return {
    body: "Review an override body.",
    created_at: "2026-04-20T10:00:00Z",
    html_url: `https://github.com/pmatos/symphonika/issues/${ISSUE_NUMBER}`,
    id: 5000 + ISSUE_NUMBER,
    labels: [...labels],
    number: ISSUE_NUMBER,
    state,
    title: "Review an override",
    updated_at: "2026-04-21T11:00:00Z"
  };
}

type WorkflowOptions = {
  autofixId?: string;
  autofixPrompt?: string;
  // autofix loops back to itself until `done.flag` exists in the Workspace.
  loop?: boolean;
  planningPrompt?: string;
};

function workflowYaml(options: WorkflowOptions = {}): string {
  const autofixId = options.autofixId ?? "autofix";
  const autofixTransitions =
    options.loop === true
      ? [
          "        - to: done",
          "          when:",
          "            artifact_exists: done.flag",
          `        - to: ${autofixId}`
        ]
      : ["        - to: done"];
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
    ...autofixTransitions,
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
      '    command: "claude -p"',
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
    "autofix-v2-prompt.md",
    "autofix-v3-prompt.md"
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

type Harness = {
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  claudeCalls: Call[];
  codexCalls: Call[];
  daemon: DaemonHandle;
  getIssue: Mock<() => Promise<Record<string, unknown>>>;
  labels: Set<string>;
  removeLabelsFromIssue: ReturnType<typeof vi.fn>;
  root: string;
  // Makes every later Issue read answer "closed".
  state: { issueState: string };
  workspace: PreparedIssueWorkspace;
};

async function startHarness(options: {
  claude?: Behavior;
  codex?: Behavior;
  continuationDelayMs?: number;
  // What is on disk when the daemon starts (the edited workflow).
  workflow: string;
  // Per-state choices as recorded at Start, against `recordedWorkflow`.
  overrides: Record<string, AgentProviderName>;
  recordedWorkflow?: string;
}): Promise<Harness> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-override-review-ui-")
  );
  tempRoots.push(root);
  await writeProject(root, options.workflow);
  const workspace = preparedWorkspace(root);
  await createGitWorkspaceAhead(workspace);

  const recorded = options.recordedWorkflow ?? workflowYaml();
  const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
  try {
    store.createProviderPlan({
      graphFingerprint: "sha256:graph",
      id: PLAN_ID,
      issueNumber: ISSUE_NUMBER,
      projectName: "symphonika",
      provider: "codex",
      readyLabel: "agent-ready",
      repository: { owner: "pmatos", repo: "symphonika" },
      snapshotPolledAt: "2026-10-09T10:00:00.000Z",
      stateDefinitions: Object.fromEntries(
        Object.keys(options.overrides).map((stateId) => [
          stateId,
          evidenceOf(recorded, stateId)
        ])
      ),
      stateProviders: options.overrides
    });
    store.markProviderPlanLabelResult(PLAN_ID, { ok: true });
  } finally {
    store.close();
  }

  const labels = new Set<string>(["agent-ready"]);
  const state = { issueState: "open" };
  const addLabelsToIssue = vi.fn((input: { labels: string[] }) => {
    for (const label of input.labels) {
      labels.add(label);
    }
    return Promise.resolve();
  });
  const removeLabelsFromIssue = vi.fn((input: { labels: string[] }) => {
    for (const label of input.labels) {
      labels.delete(label);
    }
    return Promise.resolve();
  });
  const getIssue = vi.fn(() =>
    Promise.resolve(issueFixture([...labels], state.issueState))
  );
  const codexCalls: Call[] = [];
  const claudeCalls: Call[] = [];
  let runCounter = 0;
  const daemon = await startDaemon({
    agentProviders: {
      claude: recordingProvider(
        "claude",
        claudeCalls,
        options.claude ?? (() => 0)
      ),
      codex: recordingProvider("codex", codexCalls, options.codex ?? (() => 0))
    },
    createRunId: () => `run-${++runCounter}`,
    cwd: root,
    env: { GITHUB_TOKEN: "secret-token" },
    githubIssuesApi: {
      addLabelsToIssue,
      getIssue,
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issueFixture([...labels], "open")])
        .mockResolvedValue([]),
      removeLabelsFromIssue
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
  return {
    addLabelsToIssue,
    claudeCalls,
    codexCalls,
    daemon,
    getIssue,
    labels,
    removeLabelsFromIssue,
    root,
    state,
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

type RunRow = {
  continuation_parent_run_id: string | null;
  current_state_id: string | null;
  id: string;
  provider_name: string;
  provider_source: string | null;
  state: string;
  terminal_reason: string | null;
  terminal_state_id: string | null;
};

function runRows(root: string): RunRow[] {
  return query<RunRow>(
    root,
    [
      "select id, continuation_parent_run_id, current_state_id, provider_name,",
      "provider_source, state, terminal_reason, terminal_state_id",
      "from runs order by created_at, rowid"
    ].join(" ")
  );
}

type InterventionRow = {
  from_provider: string | null;
  from_run_id: string;
  kind: string;
  last_error: string | null;
  new_digest: string | null;
  old_digest: string | null;
  outcome: string;
  requested_via: string;
  resolution: string | null;
  state_id: string;
  to_provider: string;
  to_run_id: string | null;
};

function interventionRows(root: string): InterventionRow[] {
  return query<InterventionRow>(
    root,
    [
      "select kind, from_run_id, to_run_id, state_id, from_provider, to_provider,",
      "resolution, old_digest, new_digest, outcome, last_error, requested_via",
      "from chain_provider_interventions order by created_at, rowid"
    ].join(" ")
  );
}

function storedPlan(root: string): string | null {
  return (
    query<{ state_providers_json: string | null }>(
      root,
      "select state_providers_json from run_chain_provider_plans where id = ?",
      PLAN_ID
    )[0]?.state_providers_json ?? null
  );
}

function storedOverride(
  root: string,
  stateId: string
): { definitionDigest: string; provider: string } | undefined {
  const parsed = JSON.parse(storedPlan(root) ?? "{}") as Record<
    string,
    { definitionDigest: string; provider: string } | undefined
  >;
  return parsed[stateId];
}

const reviewUrl = (harness: Harness): string =>
  `${harness.daemon.url}/issues/symphonika/${ISSUE_NUMBER}/review-override`;
const issueUrl = (harness: Harness): string =>
  `${harness.daemon.url}/issues/symphonika/${ISSUE_NUMBER}`;

// The terminal write that parks the chain lands its labels after the Run row
// turns blocked; wait for those writes to stop so a test can tell them from
// its own.
async function waitForSettledLabelWrites(harness: Harness): Promise<void> {
  const labelWrites = (): number =>
    harness.addLabelsToIssue.mock.calls.length +
    harness.removeLabelsFromIssue.mock.calls.length;
  let previous = -1;
  while (previous !== labelWrites()) {
    previous = labelWrites();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function startParked(
  options: Omit<
    Parameters<typeof startHarness>[0],
    "overrides" | "workflow"
  > & {
    overrides?: Record<string, AgentProviderName>;
    workflow?: string;
  } = {}
): Promise<Harness> {
  const harness = await startHarness({
    overrides: { autofix: "claude" },
    workflow: workflowYaml({ autofixPrompt: "autofix-v2-prompt.md" }),
    ...options
  });
  await waitFor("the chain to park for review", () =>
    runRows(harness.root).some((run) => run.state === "blocked")
  );
  await waitForSettledLabelWrites(harness);
  return harness;
}

type ReviewPage = {
  cookie: string;
  csrfToken: string;
  html: string;
  newDigest: string;
  runId: string;
  stateId: string;
  status: number;
};

async function openReviewPage(harness: Harness): Promise<ReviewPage> {
  const response = await fetch(reviewUrl(harness));
  const html = await response.text();
  const field = (name: string): string =>
    new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    csrfToken: field("csrf_token"),
    html,
    newDigest: field("new_digest"),
    runId: field("run_id"),
    stateId: field("state_id"),
    status: response.status
  };
}

async function postReview(
  harness: Harness,
  page: ReviewPage,
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<{ html: string; status: number }> {
  const response = await fetch(reviewUrl(harness), {
    body: new URLSearchParams(fields).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: page.cookie,
      ...headers
    },
    method: "POST"
  });
  return { html: await response.text(), status: response.status };
}

function resolveFields(
  page: ReviewPage,
  resolution: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    csrf_token: page.csrfToken,
    new_digest: page.newDigest,
    resolution,
    run_id: page.runId,
    state_id: page.stateId,
    ...overrides
  };
}

const V1 = workflowYaml();
const V2 = workflowYaml({ autofixPrompt: "autofix-v2-prompt.md" });

describe("the provider override review preview and resolve page (#864 stage 2)", () => {
  it("previews the old and new evidence, the selected provider and the three options", async () => {
    const harness = await startParked();

    const page = await openReviewPage(harness);

    expect(page.status).toBe(200);
    expect(page.runId).toBe("run-2");
    expect(page.stateId).toBe("autofix");
    expect(page.newDigest).toBe(evidenceOf(V2, "autofix").digest);
    expect(page.html).toContain("Review provider choice for #8");
    expect(page.html).toContain(evidenceOf(V1, "autofix").digest);
    expect(page.html).toContain(evidenceOf(V2, "autofix").digest);
    expect(page.html).toContain("What changed in");
    expect(page.html).toContain("action.prompt");
    expect(page.html).toContain("autofix-prompt.md");
    expect(page.html).toContain("autofix-v2-prompt.md");
    expect(page.html).toContain("Selected provider");
    expect(page.html).toContain("<code>claude</code>");
    expect(page.html).toContain("Chain-wide provider");
    expect(page.html).toContain("provider_override_review_required");
    expect(page.html).toContain('<a href="/runs/run-1">');
    expect(page.html).toContain("Full definitions");
    expect(page.html).toContain("Nothing in local state blocks this review.");
    expect(page.html).toContain("Same Run Chain");
    for (const value of ["keep", "rebind:codex", "drop"]) {
      expect(page.html).toContain(
        `name="resolution" value="${value}" required`
      );
    }
    expect(page.html).not.toContain('value="rebind:claude"');
    expect(page.html).not.toMatch(/name="resolution"[^>]*checked/);
  });

  it("renders a keyboard-operable form: a labelled fieldset of required radios and a real submit button", async () => {
    const harness = await startParked();

    const { html } = await openReviewPage(harness);

    expect(html).toContain("<fieldset><legend>Provider for");
    expect(html).toMatch(/<label><input type="radio"[^>]*> Keep/);
    expect(html).toContain('<button class="btn" type="submit">');
    expect(html).toContain('aria-describedby="review-consequences"');
    expect(html).toContain('id="review-consequences"');
  });

  it("offers the review on the Issue page only while it is open, instead of recovery", async () => {
    const harness = await startHarness({
      overrides: { autofix: "claude" },
      workflow: V1
    });
    await waitFor("the walk to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );
    const unparkedResponse = await fetch(issueUrl(harness));
    expect(unparkedResponse.status).toBe(200);
    const unparked = await unparkedResponse.text();
    const unparkedPage = await fetch(reviewUrl(harness));
    expect(unparked).not.toContain("review-override");
    expect(unparkedPage.status).toBe(404);
    expect(await unparkedPage.text()).toContain("No provider override review");

    const parked = await startParked();
    const issue = await (await fetch(issueUrl(parked))).text();
    expect(issue).toContain("/issues/symphonika/8/review-override");
    expect(issue).toContain("Review the provider choice for");
    expect(issue).not.toContain("/issues/symphonika/8/recover");

    const page = await openReviewPage(parked);
    const accepted = await postReview(
      parked,
      page,
      resolveFields(page, "keep")
    );
    expect(accepted.status).toBe(202);
    await waitFor("the resumed chain to finish", () =>
      runRows(parked.root).some((run) => run.terminal_state_id === "done")
    );
    const resolvedResponse = await fetch(issueUrl(parked));
    expect(resolvedResponse.status).toBe(200);
    const resolved = await resolvedResponse.text();
    expect(resolved).toContain("Operator override review");
    expect(resolved).not.toContain("review-override");
  });

  describe.each([
    {
      choice: "keep",
      override: { provider: "claude", resolution: "keep" },
      source: "operator_state"
    },
    {
      choice: "rebind:codex",
      override: { provider: "codex", resolution: "rebind" },
      source: "operator_state"
    },
    {
      choice: "drop",
      override: undefined,
      source: "operator_chain"
    }
  ])("resolving with $choice", ({ choice, override, source }) => {
    it("resumes the same Run Chain at the same state on the right provider and records the decision", async () => {
      const harness = await startParked();
      const page = await openReviewPage(harness);

      const result = await postReview(
        harness,
        page,
        resolveFields(page, choice)
      );

      expect(result.status).toBe(202);
      expect(result.html).toContain("Review resolved");
      expect(result.html).not.toContain("<form");
      await waitFor("the resumed chain to finish", () =>
        runRows(harness.root).some((run) => run.terminal_state_id === "done")
      );

      const expectedProvider = override?.provider ?? "codex";
      const launched =
        expectedProvider === "claude"
          ? harness.claudeCalls
          : harness.codexCalls;
      const other =
        expectedProvider === "claude"
          ? harness.codexCalls
          : harness.claudeCalls;
      expect(launched.map((call) => call.runId)).toContain("run-3");
      expect(launched.find((call) => call.runId === "run-3")?.prompt).toContain(
        "autofix-v2-prompt.md"
      );
      expect(other.map((call) => call.runId)).not.toContain("run-3");
      const rows = runRows(harness.root);
      expect(rows.map((run) => [run.id, run.state])).toEqual([
        ["run-1", "succeeded"],
        ["run-2", "blocked"],
        ["run-3", "succeeded"]
      ]);
      expect(rows[2]).toMatchObject({
        continuation_parent_run_id: "run-2",
        provider_name: expectedProvider,
        provider_source: source
      });
      // The parked Run is untouched: park, review and resume stay separate.
      expect(rows[1]?.terminal_reason).toContain(
        "provider_override_review_required:"
      );
      expect(interventionRows(harness.root)).toEqual([
        {
          from_provider: "claude",
          from_run_id: "run-2",
          kind: "override_review",
          last_error: null,
          new_digest: evidenceOf(V2, "autofix").digest,
          old_digest: evidenceOf(V1, "autofix").digest,
          outcome: "launched",
          requested_via: "http",
          resolution: override?.resolution ?? "drop",
          state_id: "autofix",
          to_provider: expectedProvider,
          to_run_id: "run-3"
        }
      ]);
      const entry = storedOverride(harness.root, "autofix");
      if (override === undefined) {
        expect(entry).toBeUndefined();
      } else {
        expect(entry).toMatchObject({
          definitionDigest: evidenceOf(V2, "autofix").digest,
          provider: override.provider
        });
      }
      // The stopped verdict is withdrawn once the resumed claim lands.
      expect(harness.labels.has("sym:blocked")).toBe(false);
      expect(harness.labels.has("sym:human-needed")).toBe(false);

      const timeline = await (await fetch(issueUrl(harness))).text();
      expect(timeline).toContain("Operator override review");
      expect(timeline).toContain("Review resolved, chain resumed");
      expect(timeline).toContain("provider_override_review_required");
      expect(timeline).toContain(
        `<a href="/runs/run-3"><code>run-3</code></a> is succeeded`
      );
    });
  });

  it("resumes a chain parked at its fresh claim as a Continuation of the parked root", async () => {
    const harness = await startParked({
      overrides: { planning: "claude" },
      workflow: workflowYaml({ planningPrompt: "plan-v2-prompt.md" }),
      recordedWorkflow: V1
    });
    expect(runRows(harness.root).map((run) => [run.id, run.state])).toEqual([
      ["run-1", "blocked"]
    ]);
    const page = await openReviewPage(harness);
    expect(page.runId).toBe("run-1");
    expect(page.stateId).toBe("planning");

    const result = await postReview(harness, page, resolveFields(page, "keep"));

    expect(result.status).toBe(202);
    await waitFor("the resumed chain to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );
    const rows = runRows(harness.root);
    expect(rows[1]).toMatchObject({
      continuation_parent_run_id: "run-1",
      provider_name: "claude",
      provider_source: "operator_state"
    });
    expect(harness.claudeCalls[0]).toMatchObject({ runId: "run-2" });
    expect(harness.claudeCalls[0]?.prompt).toContain("plan-v2-prompt.md");
    // Later states keep following the chain-wide choice.
    expect(harness.codexCalls.map((call) => call.runId)).toEqual(["run-3"]);
    expect(harness.labels.has("sym:blocked")).toBe(false);
    expect(
      interventionRows(harness.root).map((row) => [row.outcome, row.to_run_id])
    ).toEqual([["launched", "run-2"]]);
  });

  describe("refusals", () => {
    const refusals: Array<{
      expectedStatus: number;
      expectedTitle: string;
      fields: (page: ReviewPage) => Record<string, string>;
      name: string;
      prepare?: (harness: Harness) => void;
    }> = [
      {
        expectedStatus: 422,
        expectedTitle: "That resolution is not valid",
        fields: (page) => {
          const fields = resolveFields(page, "");
          return { ...fields, resolution: "launch-nukes" };
        },
        name: "an unknown resolution"
      },
      {
        expectedStatus: 422,
        expectedTitle: "That resolution is not valid",
        fields: (page) => resolveFields(page, "rebind:claude"),
        name: "a rebind to the provider already recorded"
      },
      {
        expectedStatus: 422,
        expectedTitle: "That resolution is not valid",
        fields: (page) => resolveFields(page, "rebind:nope"),
        name: "a rebind to an unknown provider"
      },
      {
        expectedStatus: 422,
        expectedTitle: "That provider is not available",
        fields: (page) => resolveFields(page, "rebind:omp"),
        name: "a rebind to a provider that is not configured"
      },
      {
        expectedStatus: 422,
        expectedTitle: "This review is out of date",
        fields: (page) => resolveFields(page, "keep", { new_digest: "stale" }),
        name: "a preview whose digest no longer matches the workflow"
      },
      {
        expectedStatus: 422,
        expectedTitle: "This review is out of date",
        fields: (page) => resolveFields(page, "keep", { state_id: "planning" }),
        name: "a position the Run is not parked at"
      },
      {
        expectedStatus: 422,
        expectedTitle: "No open review for this Run",
        fields: (page) => resolveFields(page, "keep", { run_id: "run-1" }),
        name: "a Run that is not the open review"
      },
      {
        expectedStatus: 422,
        expectedTitle: "No such Run for this Issue",
        fields: (page) => resolveFields(page, "keep", { run_id: "run-99" }),
        name: "a Run that does not exist"
      },
      {
        expectedStatus: 409,
        expectedTitle: "The Issue still holds a claim",
        fields: (page) => resolveFields(page, "keep"),
        name: "an Issue that still carries a claim label",
        prepare: (harness) => harness.labels.add("sym:stale")
      },
      {
        expectedStatus: 422,
        expectedTitle: "The Issue is closed",
        fields: (page) => resolveFields(page, "keep"),
        name: "a closed Issue",
        prepare: (harness) => {
          harness.state.issueState = "closed";
        }
      }
    ];

    for (const refusal of refusals) {
      it(`refuses ${refusal.name} and writes nothing`, async () => {
        const harness = await startParked();
        const page = await openReviewPage(harness);
        refusal.prepare?.(harness);
        const runsBefore = runRows(harness.root);
        const planBefore = storedPlan(harness.root);
        const labelWritesBefore = harness.addLabelsToIssue.mock.calls.length;
        const labelRemovalsBefore =
          harness.removeLabelsFromIssue.mock.calls.length;

        const result = await postReview(harness, page, refusal.fields(page));

        expect(result.status).toBe(refusal.expectedStatus);
        expect(result.html).toContain(
          `Review not resolved: ${refusal.expectedTitle}`
        );
        expect(result.html).toContain("Nothing was written.");
        expect(runRows(harness.root)).toEqual(runsBefore);
        expect(interventionRows(harness.root)).toEqual([]);
        expect(storedPlan(harness.root)).toBe(planBefore);
        expect(harness.claudeCalls).toHaveLength(0);
        expect(harness.codexCalls).toHaveLength(1);
        expect(harness.addLabelsToIssue.mock.calls).toHaveLength(
          labelWritesBefore
        );
        expect(harness.removeLabelsFromIssue.mock.calls).toHaveLength(
          labelRemovalsBefore
        );
      });
    }

    it("refuses a missing choice from the form and keeps the review open", async () => {
      const harness = await startParked();
      const page = await openReviewPage(harness);
      const withoutChoice = Object.fromEntries(
        Object.entries(resolveFields(page, "keep")).filter(
          ([name]) => name !== "resolution"
        )
      );

      const result = await postReview(harness, page, withoutChoice);

      expect(result.status).toBe(422);
      expect(result.html).toContain("Review not resolved");
      expect(result.html).toContain('name="resolution" value="keep" required');
      expect(interventionRows(harness.root)).toEqual([]);
    });
  });

  it("leaves a removed state unresolvable and says why", async () => {
    const harness = await startHarness({
      continuationDelayMs: 600,
      overrides: { autofix: "claude" },
      workflow: V1
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
    await waitForSettledLabelWrites(harness);

    const page = await openReviewPage(harness);

    expect(page.status).toBe(200);
    expect(page.html).toContain("no longer in the workflow");
    expect(page.html).toContain(
      "The state no longer exists in the current workflow."
    );
    expect(page.html).toContain("Cannot be resolved right now");
    expect(page.html).not.toContain("<form");

    const planBefore = storedPlan(harness.root);
    const result = await postReview(
      harness,
      { ...page, newDigest: "absent" },
      {
        csrf_token: page.csrfToken,
        new_digest: "absent",
        resolution: "drop",
        run_id: "run-2",
        state_id: "autofix"
      }
    );
    expect(result.status).toBe(422);
    expect(result.html).toContain(
      "Review not resolved: The state no longer exists"
    );
    expect(result.html).toContain("Nothing was written.");
    expect(interventionRows(harness.root)).toEqual([]);
    expect(storedPlan(harness.root)).toBe(planBefore);
  });

  it("leaves the plan and the open review untouched when the resume never claims, and resolves on a retry", async () => {
    const harness = await startParked();
    const page = await openReviewPage(harness);
    const planBefore = storedPlan(harness.root);
    // The resolve's own read sees an open Issue; the scheduled launch's
    // refresh then sees it closed and drops.
    let reads = 0;
    harness.getIssue.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(
        issueFixture([...harness.labels], reads === 1 ? "open" : "closed")
      );
    });

    const accepted = await postReview(
      harness,
      page,
      resolveFields(page, "drop")
    );

    expect(accepted.status).toBe(202);
    await waitFor("the resume to be dropped", () =>
      interventionRows(harness.root).some((row) => row.outcome === "dropped")
    );
    expect(storedPlan(harness.root)).toBe(planBefore);
    expect(runRows(harness.root)).toHaveLength(2);
    expect(harness.claudeCalls).toHaveLength(0);
    const timeline = await (await fetch(issueUrl(harness))).text();
    expect(timeline).toContain("Review resolution dropped");
    expect(timeline).toContain(
      "The parked Run above is unchanged and the stored choice was not rewritten."
    );

    harness.getIssue.mockImplementation(() =>
      Promise.resolve(issueFixture([...harness.labels], "open"))
    );
    const again = await openReviewPage(harness);
    for (const value of ["keep", "rebind:codex", "drop"]) {
      expect(again.html).toContain(
        `name="resolution" value="${value}" required`
      );
    }
    const retried = await postReview(
      harness,
      again,
      resolveFields(again, "drop")
    );
    expect(retried.status).toBe(202);
    await waitFor("the resumed chain to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );
    expect(
      interventionRows(harness.root).map((row) => [row.outcome, row.resolution])
    ).toEqual([
      ["dropped", "drop"],
      ["launched", "drop"]
    ]);
  });

  it("refuses a second resolution and a recovery once the review is resolved", async () => {
    const release = createDeferred();
    const harness = await startParked({
      claude: async () => {
        await release.promise;
        return 0;
      }
    });
    const page = await openReviewPage(harness);

    const first = await postReview(harness, page, resolveFields(page, "keep"));
    const second = await postReview(harness, page, resolveFields(page, "keep"));
    const recovery = await fetch(
      `${harness.daemon.url}/api/issues/symphonika/${ISSUE_NUMBER}/recover`,
      {
        body: JSON.stringify({
          provider: "codex",
          runId: "run-2",
          stateId: "autofix"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    );

    expect(first.status).toBe(202);
    expect([409, 422]).toContain(second.status);
    expect(second.html).toContain("Nothing was written.");
    expect([409, 422]).toContain(recovery.status);
    release.resolve();
    await waitFor("the resumed chain to finish", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );
    expect(interventionRows(harness.root).map((row) => row.kind)).toEqual([
      "override_review"
    ]);
    expect(harness.claudeCalls).toHaveLength(1);
  });

  describe("authentication", () => {
    it("rejects a browser-origin resolve without the CSRF token, with a foreign origin, or with a cross-site fetch", async () => {
      const harness = await startParked();
      const page = await openReviewPage(harness);
      const sameOrigin = { origin: harness.daemon.url };
      const fields = resolveFields(page, "keep");

      const noToken = await postReview(
        harness,
        page,
        { ...fields, csrf_token: "" },
        sameOrigin
      );
      const wrongToken = await postReview(
        harness,
        page,
        { ...fields, csrf_token: "0".repeat(64) },
        sameOrigin
      );
      const foreignOrigin = await postReview(harness, page, fields, {
        origin: "https://evil.example"
      });
      const crossSite = await postReview(harness, page, fields, {
        ...sameOrigin,
        "sec-fetch-site": "cross-site"
      });

      expect(
        [noToken, wrongToken, foreignOrigin, crossSite].map((r) => r.status)
      ).toEqual([403, 403, 403, 403]);
      expect(interventionRows(harness.root)).toEqual([]);
      expect(harness.claudeCalls).toHaveLength(0);
      expect(runRows(harness.root)).toHaveLength(2);

      const accepted = await postReview(harness, page, fields, sameOrigin);
      expect(accepted.status).toBe(202);
    });

    it("serves the JSON route the same way: a stale digest is refused, the reviewed one accepted", async () => {
      const harness = await startParked();
      const page = await openReviewPage(harness);
      const post = (body: Record<string, unknown>): Promise<Response> =>
        fetch(
          `${harness.daemon.url}/api/issues/symphonika/${ISSUE_NUMBER}/review-override`,
          {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "POST"
          }
        );

      const stale = await post({
        newDigest: "stale",
        resolution: "keep",
        runId: "run-2",
        stateId: "autofix"
      });
      const malformed = await post({ resolution: "keep" });
      const forged = await fetch(
        `${harness.daemon.url}/api/issues/symphonika/${ISSUE_NUMBER}/review-override`,
        {
          body: "{}",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example"
          },
          method: "POST"
        }
      );

      expect(stale.status).toBe(422);
      expect(await stale.json()).toMatchObject({
        kind: "refused",
        reason: "evidence-changed"
      });
      expect(malformed.status).toBe(400);
      expect(forged.status).toBe(403);
      expect(interventionRows(harness.root)).toEqual([]);

      const accepted = await post({
        newDigest: page.newDigest,
        provider: "codex",
        resolution: "rebind",
        runId: "run-2",
        stateId: "autofix"
      });
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({
        kind: "accepted",
        provider: "codex",
        resolution: "rebind"
      });
    });
  });

  describe("a resolved review does not park the same state again", () => {
    const LOOP_V1 = workflowYaml({ loop: true });
    const LOOP_V2 = workflowYaml({
      autofixPrompt: "autofix-v2-prompt.md",
      loop: true
    });

    it("advances through the state again on the resolved provider, without a second park", async () => {
      const markers: string[] = [];
      const harness = await startParked({
        claude: async (call) => {
          markers.push(call.runId);
          if (markers.length >= 2) {
            await writeFile(
              path.join(harness.workspace.workspacePath, "done.flag"),
              "done\n"
            );
          } else {
            await writeFile(
              path.join(harness.workspace.workspacePath, "loop-1.txt"),
              "again\n"
            );
          }
          return 0;
        },
        recordedWorkflow: LOOP_V1,
        workflow: LOOP_V2
      });
      const page = await openReviewPage(harness);

      const result = await postReview(
        harness,
        page,
        resolveFields(page, "keep")
      );

      expect(result.status).toBe(202);
      await waitFor("the loop to finish", () =>
        runRows(harness.root).some((run) => run.terminal_state_id === "done")
      );
      // The same state ran twice on the kept provider, and nothing parked
      // after the review.
      expect(harness.claudeCalls.map((call) => call.runId)).toEqual([
        "run-3",
        "run-4"
      ]);
      expect(
        runRows(harness.root).filter((run) => run.state === "blocked")
      ).toHaveLength(1);
      expect(
        runRows(harness.root)
          .filter((run) => run.id === "run-3" || run.id === "run-4")
          .map((run) => run.provider_source)
      ).toEqual(["operator_state", "operator_state"]);
    });

    it("parks again when the state is edited again after the review", async () => {
      let calls = 0;
      const harness = await startParked({
        claude: async () => {
          calls += 1;
          await writeFile(
            path.join(harness.workspace.workspacePath, "loop-1.txt"),
            "again\n"
          );
          if (calls === 1) {
            await writeFile(
              path.join(harness.root, "workflow.yml"),
              workflowYaml({
                autofixPrompt: "autofix-v3-prompt.md",
                loop: true
              })
            );
          }
          return 0;
        },
        recordedWorkflow: LOOP_V1,
        workflow: LOOP_V2
      });
      const page = await openReviewPage(harness);
      const result = await postReview(
        harness,
        page,
        resolveFields(page, "keep")
      );
      expect(result.status).toBe(202);

      await waitFor(
        "the chain to park again",
        () =>
          runRows(harness.root).filter((run) => run.state === "blocked")
            .length === 2
      );
      await waitForSettledLabelWrites(harness);

      expect(harness.claudeCalls.map((call) => call.runId)).toEqual(["run-3"]);
      const rows = runRows(harness.root);
      expect(rows.map((run) => [run.id, run.state])).toEqual([
        ["run-1", "succeeded"],
        ["run-2", "blocked"],
        ["run-3", "succeeded"],
        ["run-4", "blocked"]
      ]);
      // The second park measures against the definition the first review
      // recorded, not the original one.
      expect(rows[3]?.terminal_reason).toContain(
        `recorded ${evidenceOf(LOOP_V2, "autofix").digest}`
      );
      expect(rows[3]?.terminal_reason).toContain(
        `now ${
          evidenceOf(
            workflowYaml({ autofixPrompt: "autofix-v3-prompt.md", loop: true }),
            "autofix"
          ).digest
        }`
      );
      const again = await openReviewPage(harness);
      expect(again.runId).toBe("run-4");
      expect(again.html).toContain("autofix-v3-prompt.md");
      const timeline = await (await fetch(issueUrl(harness))).text();
      expect(timeline.match(/Operator override review/g)).toHaveLength(1);
      expect(
        timeline.match(/provider_override_review_required/g)?.length
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
