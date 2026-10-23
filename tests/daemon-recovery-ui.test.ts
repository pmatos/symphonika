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
const PLAN_ID = "plan-recovery-ui";

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

const WORKFLOW = [
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

async function writeProject(root: string): Promise<void> {
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
  await writeFile(path.join(root, "workflow.yml"), WORKFLOW);
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Draft a plan for #{{issue.number}}.\n"
  );
  await writeFile(
    path.join(root, "autofix-prompt.md"),
    "Apply the autofix for #{{issue.number}}.\n"
  );
}

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
  codex?: Behavior;
  retryDelayMs?: number;
}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-recovery-ui-"));
  tempRoots.push(root);
  await writeProject(root);
  const workspace = preparedWorkspace(root);
  await createGitWorkspaceAhead(workspace);
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
      snapshotPolledAt: "2026-10-09T10:00:00.000Z"
    });
    store.markProviderPlanLabelResult(PLAN_ID, { ok: true });
  } finally {
    store.close();
  }

  const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
  const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
  const getIssue = vi.fn().mockResolvedValue(issueFixture());
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
        .mockResolvedValueOnce([issueFixture()])
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

type RunRow = { id: string; state: string; terminal_state_id: string | null };

function runRows(root: string): RunRow[] {
  return query<RunRow>(
    root,
    "select id, state, terminal_state_id from runs order by created_at, rowid"
  );
}

function interventionRows(root: string): Array<{
  last_error: string | null;
  outcome: string;
  requested_via: string;
  to_run_id: string | null;
}> {
  return query(
    root,
    "select outcome, last_error, requested_via, to_run_id from chain_provider_interventions order by created_at, rowid"
  );
}

const codexFailsAutofix: Behavior = (call) =>
  call.prompt.includes("autofix") ? 1 : 0;

const recoverUrl = (harness: Harness): string =>
  `${harness.daemon.url}/issues/symphonika/${ISSUE_NUMBER}/recover`;
const issueUrl = (harness: Harness): string =>
  `${harness.daemon.url}/issues/symphonika/${ISSUE_NUMBER}`;

// The terminal failure writes its labels after the Run row turns failed; wait
// for those writes to stop so a test can tell them from its own.
async function waitForStoppedAutofix(harness: Harness): Promise<void> {
  await waitFor("autofix to fail", () =>
    runRows(harness.root).some((run) => run.state === "failed")
  );
  const labelWrites = (): number =>
    harness.addLabelsToIssue.mock.calls.length +
    harness.removeLabelsFromIssue.mock.calls.length;
  let previous = -1;
  while (previous !== labelWrites()) {
    previous = labelWrites();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

type RecoverPage = {
  cookie: string;
  csrfToken: string;
  html: string;
  runId: string;
  stateId: string;
  status: number;
};

async function openRecoverPage(harness: Harness): Promise<RecoverPage> {
  const response = await fetch(recoverUrl(harness));
  const html = await response.text();
  const field = (name: string): string =>
    new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    csrfToken: field("csrf_token"),
    html,
    runId: field("run_id"),
    stateId: field("state_id"),
    status: response.status
  };
}

async function postRecover(
  harness: Harness,
  page: RecoverPage,
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<{ html: string; status: number }> {
  const response = await fetch(recoverUrl(harness), {
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

function confirmFields(
  page: RecoverPage,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    csrf_token: page.csrfToken,
    provider: "claude",
    run_id: page.runId,
    state_id: page.stateId,
    ...overrides
  };
}

describe("the recovery preview and confirm page (#863 stage B)", () => {
  it("previews the position, the stopped attempt, the Workspace, the proposed provider and the consequences", async () => {
    const harness = await startHarness({ codex: codexFailsAutofix });
    await waitForStoppedAutofix(harness);
    const page = await openRecoverPage(harness);

    expect(page.status).toBe(200);
    expect(page.runId).toBe("run-2");
    expect(page.stateId).toBe("autofix");
    expect(page.html).toContain("pmatos/symphonika#8");
    expect(page.html).toContain("plan_then_autofix");
    expect(page.html).toMatch(/Current FSM position<\/dt><dd><code>autofix/);
    expect(page.html).toContain("/runs/run-2");
    expect(page.html).toContain("attempt 1 on codex");
    expect(page.html).toContain(harness.workspace.workspacePath);
    expect(page.html).toContain(harness.workspace.branchName);
    expect(page.html).toMatch(/Terminal reason<\/dt><dd>[^<—]/);
    // codex stopped, so the form proposes the other configured provider.
    expect(page.html).toMatch(
      /<input type="radio" name="provider" value="claude" checked>/
    );
    expect(page.html).toMatch(
      /<input type="radio" name="provider" value="codex">/
    );
    expect(page.html).not.toContain('value="omp"');
    expect(page.html).toContain("Same Run Chain");
    expect(page.html).toContain("not replayed");
    expect(page.html).toContain("new Continuation Run");
    expect(page.html).toContain("Previous evidence is preserved");
    expect(page.html).toContain("with no reset");
    expect(interventionRows(harness.root)).toEqual([]);
  });

  it("renders a keyboard-operable form: a labelled fieldset of radios and a real submit button", async () => {
    const harness = await startHarness({ codex: codexFailsAutofix });
    await waitForStoppedAutofix(harness);

    const { html } = await openRecoverPage(harness);

    expect(html).toMatch(
      /<form method="post" action="\/issues\/symphonika\/8\/recover" aria-describedby="recover-consequences">/
    );
    expect(html).toContain("<fieldset><legend>Provider to recover");
    expect(html).toContain('id="recover-consequences"');
    expect(html.match(/<label><input type="radio"/g)).toHaveLength(2);
    expect(html.match(/ checked>/g)).toHaveLength(1);
    expect(html).toContain('<button class="btn" type="submit">');
  });

  it("offers the entry point on the Issue page only while a recovery is possible", async () => {
    const release = createDeferred();
    const harness = await startHarness({
      codex: async (call) => {
        if (call.prompt.includes("autofix")) {
          await release.promise;
          return 1;
        }
        return 0;
      }
    });
    await waitFor("autofix to be running", () =>
      runRows(harness.root).some(
        (run) => run.id === "run-2" && run.state === "running"
      )
    );
    const link = "/issues/symphonika/8/recover";

    const whileRunning = await (await fetch(issueUrl(harness))).text();
    expect(whileRunning).not.toContain(link);

    release.resolve();
    await waitForStoppedAutofix(harness);
    const stopped = await (await fetch(issueUrl(harness))).text();
    expect(stopped).toContain(`href="${link}"`);
    expect(stopped).toContain("on another provider");

    const page = await openRecoverPage(harness);
    await postRecover(harness, page, confirmFields(page));
    await waitFor("the walk to settle", () =>
      interventionRows(harness.root).every((row) => row.outcome !== "scheduled")
    );
    await waitFor("the recovery Run to finish", () =>
      runRows(harness.root).every(
        (run) => run.state !== "queued" && run.state !== "running"
      )
    );
    const afterRecovery = await (await fetch(issueUrl(harness))).text();
    expect(afterRecovery).not.toContain(`href="${link}"`);
  });

  it("confirms a recovery and shows the failure, the intervention and the new Run in the timeline", async () => {
    const harness = await startHarness({ codex: codexFailsAutofix });
    await waitForStoppedAutofix(harness);
    const page = await openRecoverPage(harness);

    const confirmed = await postRecover(harness, page, confirmFields(page));

    expect(confirmed.status).toBe(202);
    expect(confirmed.html).toContain("Recovery accepted");
    expect(confirmed.html).not.toContain("<form");
    await waitFor("the walk to reach done", () =>
      runRows(harness.root).some((run) => run.terminal_state_id === "done")
    );
    expect(harness.claudeCalls).toHaveLength(1);
    expect(interventionRows(harness.root)).toMatchObject([
      { outcome: "launched", requested_via: "http", to_run_id: "run-3" }
    ]);

    const issuePage = await (await fetch(issueUrl(harness))).text();
    const rows = [
      ...issuePage.matchAll(/<tr id="chain-run-1-[^"]*">.*?<\/tr>/g)
    ]
      .map((match) => match[0])
      .join("\n");
    // The original failure stays a Failed row of its own, with its reason.
    const failedRow = rows
      .split("\n")
      .find((row) => row.includes("/runs/run-2"));
    expect(failedRow).toContain("Failed");
    expect(failedRow).not.toContain("Completed");
    expect(failedRow).toContain("<td>codex ");
    // The intervention is its own row, between the failed Run and the new one.
    expect(issuePage).toMatch(
      /class="chain-intervention"[^>]*><td colspan="8"><strong>Operator recovery<\/strong> at <code>autofix<\/code>: codex → claude/
    );
    expect(issuePage).toContain("Recovery launched");
    expect(issuePage).toMatch(
      /New Run <a href="\/runs\/run-3">.*?is succeeded/
    );
    expect(issuePage).toContain("operator recovery of this state");
    const order = [
      issuePage.indexOf("/runs/run-2"),
      issuePage.indexOf('class="chain-intervention"'),
      issuePage.indexOf("/runs/run-3")
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((index) => index > 0)).toBe(true);
  });

  it("shows a recovery that itself fails as a second failure with the operator-recovery source, and offers recovery again", async () => {
    const harness = await startHarness({
      claude: codexFailsAutofix,
      codex: codexFailsAutofix
    });
    await waitForStoppedAutofix(harness);
    const page = await openRecoverPage(harness);

    await postRecover(harness, page, confirmFields(page));
    await waitFor("the recovery Run to fail", () =>
      runRows(harness.root).some(
        (run) => run.id === "run-3" && run.state === "failed"
      )
    );
    await waitFor("the intervention to settle", () =>
      interventionRows(harness.root).every((row) => row.outcome === "launched")
    );

    const issuePage = await (await fetch(issueUrl(harness))).text();
    const rows = [
      ...issuePage.matchAll(/<tr id="chain-run-1-[^"]*">.*?<\/tr>/g)
    ].map((match) => match[0]);
    const original = rows.find((row) => row.includes("/runs/run-2"));
    const recovered = rows.find((row) => row.includes("/runs/run-3"));
    expect(original).toContain("Failed");
    expect(recovered).toContain("Failed");
    expect(recovered).toContain("<td>claude ");
    expect(recovered).toContain("operator recovery of this state");
    expect(issuePage).toMatch(/New Run <a href="\/runs\/run-3">.*?is failed/);
    // The second stop can be recovered in turn, from the new head Run.
    const again = await openRecoverPage(harness);
    expect(again.runId).toBe("run-3");
    expect(again.html).toMatch(
      /<input type="radio" name="provider" value="codex" checked>/
    );
  });

  it("shows a recovery that was accepted but dropped, beside the failure it tried to recover", async () => {
    const harness = await startHarness({ codex: codexFailsAutofix });
    await waitForStoppedAutofix(harness);
    const page = await openRecoverPage(harness);
    harness.getIssue.mockReset();
    harness.getIssue
      .mockResolvedValueOnce(issueFixture())
      .mockResolvedValue(issueFixture({ state: "closed" }));

    const confirmed = await postRecover(harness, page, confirmFields(page));

    expect(confirmed.status).toBe(202);
    await waitFor(
      "the intervention to be dropped",
      () => interventionRows(harness.root)[0]?.outcome === "dropped"
    );
    const issuePage = await (await fetch(issueUrl(harness))).text();
    expect(issuePage).toContain("Recovery dropped");
    expect(issuePage).toContain("before a Run was created");
    expect(issuePage).toContain("The stopped Run above is unchanged");
    const failedRow = [
      ...issuePage.matchAll(/<tr id="chain-run-1-[^"]*">.*?<\/tr>/g)
    ]
      .map((match) => match[0])
      .find((row) => row.includes("/runs/run-2"));
    expect(failedRow).toContain("Failed");
    expect(runRows(harness.root)).toHaveLength(2);
  });

  describe("refusals render as operator messages and leave no trace", () => {
    type Case = {
      expectedStatus: number;
      expectedTitle: string;
      fields?: (page: RecoverPage) => Record<string, string>;
      name: string;
      prepare?: (harness: Harness) => void;
    };

    const cases: Case[] = [
      {
        expectedStatus: 422,
        expectedTitle: "The Issue is closed",
        name: "a closed Issue",
        prepare: (harness) =>
          harness.getIssue.mockResolvedValue(issueFixture({ state: "closed" }))
      },
      {
        expectedStatus: 409,
        expectedTitle: "The Issue still holds a claim",
        name: "a stale claim",
        prepare: (harness) =>
          harness.getIssue.mockResolvedValue(
            issueFixture({ labels: ["agent-ready", "sym:stale"] })
          )
      },
      {
        expectedStatus: 409,
        expectedTitle: "The Issue still holds a claim",
        name: "a live claim",
        prepare: (harness) =>
          harness.getIssue.mockResolvedValue(
            issueFixture({ labels: ["agent-ready", "sym:claimed"] })
          )
      },
      {
        expectedStatus: 422,
        expectedTitle: "That provider is not available",
        fields: () => ({ provider: "omp" }),
        name: "an unavailable provider"
      },
      {
        expectedStatus: 422,
        expectedTitle: "That provider is not available",
        fields: () => ({ provider: "" }),
        name: "no provider chosen"
      },
      {
        expectedStatus: 422,
        expectedTitle: "This preview is out of date",
        fields: () => ({ state_id: "planning" }),
        name: "a position other than the one previewed"
      },
      {
        expectedStatus: 422,
        expectedTitle: "No such Run for this Issue",
        fields: () => ({ run_id: "run-nope" }),
        name: "a Run that does not exist"
      }
    ];

    for (const refusal of cases) {
      it(`refuses ${refusal.name}`, async () => {
        const harness = await startHarness({ codex: codexFailsAutofix });
        await waitForStoppedAutofix(harness);
        const page = await openRecoverPage(harness);
        refusal.prepare?.(harness);
        const runsBefore = runRows(harness.root);
        const labelWritesBefore = harness.addLabelsToIssue.mock.calls.length;
        const labelRemovalsBefore =
          harness.removeLabelsFromIssue.mock.calls.length;

        const result = await postRecover(
          harness,
          page,
          confirmFields(page, refusal.fields?.(page))
        );

        expect(result.status).toBe(refusal.expectedStatus);
        expect(result.html).toContain(
          `Recovery refused: ${refusal.expectedTitle}`
        );
        expect(result.html).toContain("Nothing was written.");
        expect(runRows(harness.root)).toEqual(runsBefore);
        expect(interventionRows(harness.root)).toEqual([]);
        expect(harness.claudeCalls).toHaveLength(0);
        expect(harness.addLabelsToIssue.mock.calls).toHaveLength(
          labelWritesBefore
        );
        expect(harness.removeLabelsFromIssue.mock.calls).toHaveLength(
          labelRemovalsBefore
        );
      });
    }

    it("refuses while a retry of the stopped state is still scheduled, and the preview says so", async () => {
      const harness = await startHarness({
        codex: codexFailsAutofix,
        retryDelayMs: 60_000
      });
      await waitForStoppedAutofix(harness);

      const page = await openRecoverPage(harness);

      expect(page.status).toBe(200);
      expect(page.html).toContain("Cannot be recovered right now");
      expect(page.html).toContain("reserved by live Run run-2");
      expect(page.html).not.toContain("<form");
      const result = await postRecover(harness, page, {
        csrf_token: page.csrfToken,
        provider: "claude",
        run_id: "run-2",
        state_id: "autofix"
      });
      expect(result.status).toBe(409);
      expect(result.html).toContain(
        "Recovery refused: Work is still executing or scheduled"
      );
      expect(interventionRows(harness.root)).toEqual([]);
      expect(harness.claudeCalls).toHaveLength(0);
    });

    it("refuses to switch the provider of an attempt that is executing", async () => {
      const release = createDeferred();
      const harness = await startHarness({
        codex: async (call) => {
          if (call.prompt.includes("autofix")) {
            await release.promise;
          }
          return 0;
        }
      });
      await waitFor("autofix to be running", () =>
        runRows(harness.root).some(
          (run) => run.id === "run-2" && run.state === "running"
        )
      );

      const page = await openRecoverPage(harness);
      const result = await postRecover(harness, page, {
        csrf_token: page.csrfToken,
        provider: "claude",
        run_id: "run-2",
        state_id: "autofix"
      });

      expect(page.html).toContain("Cannot be recovered right now");
      expect(page.html).not.toContain("<form");
      expect(result.status).toBe(422);
      expect(result.html).toContain("Recovery refused: The Run is not stopped");
      release.resolve();
      expect(interventionRows(harness.root)).toEqual([]);
      expect(harness.claudeCalls).toHaveLength(0);
    });
  });

  describe("authentication", () => {
    it("rejects a browser-origin confirm without the CSRF token, with a foreign origin, or with a cross-site fetch", async () => {
      const harness = await startHarness({ codex: codexFailsAutofix });
      await waitForStoppedAutofix(harness);
      const page = await openRecoverPage(harness);
      const sameOrigin = { origin: harness.daemon.url };

      const noToken = await postRecover(
        harness,
        page,
        confirmFields(page, { csrf_token: "" }),
        sameOrigin
      );
      const wrongToken = await postRecover(
        harness,
        page,
        confirmFields(page, { csrf_token: "0".repeat(64) }),
        sameOrigin
      );
      const foreignOrigin = await postRecover(
        harness,
        page,
        confirmFields(page),
        { origin: "https://evil.example" }
      );
      const crossSite = await postRecover(harness, page, confirmFields(page), {
        ...sameOrigin,
        "sec-fetch-site": "cross-site"
      });

      expect(
        [noToken, wrongToken, foreignOrigin, crossSite].map((r) => r.status)
      ).toEqual([403, 403, 403, 403]);
      expect(interventionRows(harness.root)).toEqual([]);
      expect(harness.claudeCalls).toHaveLength(0);
      expect(runRows(harness.root)).toHaveLength(2);

      const accepted = await postRecover(
        harness,
        page,
        confirmFields(page),
        sameOrigin
      );
      expect(accepted.status).toBe(202);
    });
  });

  it("answers 404 for an Issue with no Run to recover", async () => {
    const harness = await startHarness({ codex: codexFailsAutofix });
    await waitForStoppedAutofix(harness);

    const response = await fetch(
      `${harness.daemon.url}/issues/symphonika/99/recover`
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Recovery unavailable");
  });
});
