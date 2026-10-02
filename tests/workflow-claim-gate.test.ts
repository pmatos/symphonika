import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { WORKFLOW_CLAIM_JSON_SCHEMA } from "../src/workflow/claim.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

// Issue #813: claim_status gates an agent state on the provider's final
// message -- schema-enforced structured output on Claude/Codex, the bare JSON
// message text on Oh My Pi -- replacing the BLOCKED.md sentinel. A missing or
// invalid claim must fail closed rather than read as success.

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND =
  "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server";
const DETERMINISTIC_RUN_ID = "run-claim-gate";

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-claim-gate-"));
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

const baseIssue = {
  body: "Do the work.",
  created_at: "2026-09-20T10:00:00Z",
  html_url: "https://github.com/pmatos/symphonika/issues/11",
  id: 5011,
  labels: ["agent-ready"],
  number: 11,
  state: "open" as const,
  title: "Claim gate fixture",
  updated_at: "2026-09-21T11:00:00Z"
};

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "11-claim-gate-fixture"
  );
  return {
    branchName: "sym/symphonika/11-claim-gate-fixture",
    branchRef: "refs/heads/sym/symphonika/11-claim-gate-fixture",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "11-claim-gate-fixture",
    reused: false,
    workspacePath
  };
}

async function writeProject(
  root: string,
  options: { claimGated: boolean } = { claimGated: true }
): Promise<void> {
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
      "  name: claim_gate_fixture",
      "  initial: working",
      "  states:",
      "    working:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: work-prompt.md",
      "      transitions:",
      ...(options.claimGated
        ? [
            "        - to: blocked_terminal",
            "          when:",
            "            claim_status: blocked",
            "        - to: done",
            "          when:",
            "            claim_status: success",
            "            provider_success: true",
            "        - to: failed"
          ]
        : [
            "        - to: done",
            "          when:",
            "            provider_success: true",
            "        - to: failed"
          ]),
      "    done:",
      "      terminal: success",
      "    blocked_terminal:",
      "      terminal: blocked",
      "    failed:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "work-prompt.md"),
    "Do the work for #{{issue.number}}.\n"
  );
}

function issuesApi() {
  let listCalls = 0;
  const claimed = { ...baseIssue, labels: ["agent-ready", "sym:claimed"] };
  return {
    addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn().mockResolvedValue(claimed),
    listOpenIssues: vi.fn(() => {
      listCalls += 1;
      return Promise.resolve(listCalls === 1 ? [baseIssue] : [claimed]);
    }),
    removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
  };
}

type RunRow = {
  state: string;
  terminal_reason: string | null;
  terminal_state_id: string | null;
};

async function runUntilTerminal(
  root: string,
  provider: AgentProvider,
  prepared: PreparedIssueWorkspace
): Promise<RunRow> {
  const daemon = await startDaemon({
    agentProviders: { codex: provider },
    createRunId: () => DETERMINISTIC_RUN_ID,
    cwd: root,
    env: { GITHUB_TOKEN: "secret-token" },
    githubIssuesApi: issuesApi(),
    logger: pino({ enabled: false }),
    port: 0,
    prepareIssueWorkspace: vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve(prepared)
    )
  });

  try {
    const deadline = Date.now() + 30_000;
    const databaseFile = path.join(root, ".symphonika", "symphonika.db");
    while (Date.now() < deadline) {
      const response = await fetch(`${daemon.url}/api/status`);
      const body = (await response.json()) as {
        runs?: Array<{ state?: string }>;
      };
      const terminal = (body.runs ?? []).some(
        (run) =>
          run.state === "succeeded" ||
          run.state === "blocked" ||
          run.state === "failed"
      );
      if (terminal) {
        const database = new Database(databaseFile, { readonly: true });
        try {
          return database
            .prepare(
              "select state, terminal_state_id, terminal_reason from runs"
            )
            .get() as RunRow;
        } finally {
          database.close();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("run did not reach a terminal state before timeout");
  } finally {
    await daemon.stop();
  }
}

type FinalTurn = Record<string, unknown> | undefined;

function providerEndingWith(
  finalTurn: FinalTurn,
  inputs: ProviderRunInput[]
): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    // eslint-disable-next-line @typescript-eslint/require-await
    async *runAttempt(input: ProviderRunInput): AsyncGenerator<ProviderEvent> {
      inputs.push(input);
      if (finalTurn !== undefined) {
        yield {
          normalized: { type: "turn_completed", ...finalTurn },
          raw: { kind: "turn_completed" }
        };
      }
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    },
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

async function runWith(
  finalTurn: FinalTurn,
  options?: { claimGated: boolean }
): Promise<{
  inputs: ProviderRunInput[];
  prompt: string;
  root: string;
  run: RunRow;
}> {
  const root = await makeTempRoot();
  const prepared = preparedWorkspaceFixture(root);
  await createGitWorkspaceAhead(prepared);
  await writeProject(root, options);
  const inputs: ProviderRunInput[] = [];
  const run = await runUntilTerminal(
    root,
    providerEndingWith(finalTurn, inputs),
    prepared
  );
  const prompt = await readFile(
    path.join(
      root,
      ".symphonika",
      "logs",
      "runs",
      DETERMINISTIC_RUN_ID,
      "prompt.md"
    ),
    "utf8"
  );
  return { inputs, prompt, root, run };
}

describe("claim_status gates an agent state's transition (issue #813)", () => {
  it("routes to the blocked terminal on a blocked structuredOutput claim, and asks the provider for the claim schema", async () => {
    const { inputs, prompt, run } = await runWith({
      structuredOutput: {
        status: "blocked",
        summary: "No open PR found for this branch."
      }
    });

    expect(run.state).toBe("blocked");
    expect(run.terminal_state_id).toBe("blocked_terminal");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.outputSchema).toEqual(WORKFLOW_CLAIM_JSON_SCHEMA);
    expect(prompt).toContain("## Final claim");
  });

  it("reads a bare-JSON final message when the provider has no structured output (Oh My Pi)", async () => {
    const { run } = await runWith({
      result: JSON.stringify({ status: "blocked", summary: "Cannot proceed." })
    });

    expect(run.state).toBe("blocked");
    expect(run.terminal_state_id).toBe("blocked_terminal");
  });

  it("advances on a success claim", async () => {
    const { run } = await runWith({
      structuredOutput: { status: "success", summary: "All done." }
    });

    expect(run.state).toBe("succeeded");
    expect(run.terminal_state_id).toBe("done");
  });

  it("fails closed when the final message is not a claim", async () => {
    const { run } = await runWith({ result: "All done, nothing to report." });

    expect(run.terminal_state_id).toBe("failed");
  });

  it("fails closed when the run emits no turn_completed at all", async () => {
    const { run } = await runWith(undefined);

    expect(run.terminal_state_id).toBe("failed");
  });

  it("fails closed on a failure claim even though the provider exited 0", async () => {
    const { run } = await runWith({
      structuredOutput: { status: "failure", summary: "Tests still red." }
    });

    expect(run.terminal_state_id).toBe("failed");
  });

  it("leaves a state that does not name claim_status unconstrained", async () => {
    const { inputs, prompt, run } = await runWith(undefined, {
      claimGated: false
    });

    expect(run.terminal_state_id).toBe("done");
    expect(inputs[0]?.outputSchema).toBeUndefined();
    expect(prompt).not.toContain("## Final claim");
  });
});
