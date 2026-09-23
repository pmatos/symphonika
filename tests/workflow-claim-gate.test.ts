import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { workflowClaimFilePath } from "../src/workflow/claim.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

// Issue #776: claim_status generalizes the Routine Outcome Claim pattern
// (#759/PR #775) to raw-FSM Workflow terminal-state signaling, reinforcing
// (not replacing) BLOCKED.md -- an agent state may opt in by naming
// claim_status in its predicates, and Symphonika reads a structured JSON
// claim back from the run evidence directory (outside the workspace) after
// the provider exits.

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
      "        - to: blocked_terminal",
      "          when:",
      "            claim_status: blocked",
      "        - to: done",
      "          when:",
      "            provider_success: true",
      "        - to: failed",
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
    "Do the work for #{{issue.number}}. Write your claim to {{claim.path}}.\n"
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

// The fake provider can't know the real runEvidenceDirectory ahead of the
// daemon assigning one -- unlike BLOCKED.md's fixed workspace-relative path,
// the claim path is outside the workspace and keyed by the run id. Injecting
// a deterministic createRunId lets the test precompute the same path
// workflowClaimFilePath derives inside the running daemon.
function providerWritingDeterministicClaim(
  root: string,
  claim: { status: string; summary: string } | undefined
): AgentProvider {
  const claimPath = workflowClaimFilePath(
    path.join(root, ".symphonika"),
    DETERMINISTIC_RUN_ID,
    1
  );
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    async *runAttempt(): AsyncGenerator<ProviderEvent> {
      if (claim !== undefined) {
        await mkdir(path.dirname(claimPath), { recursive: true });
        await writeFile(claimPath, JSON.stringify(claim));
      }
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    },
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

describe("claim_status gates an agent state's transition (issue #776)", () => {
  it("routes to the blocked terminal when the provider writes a blocked claim.json and exits 0", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const run = await runUntilTerminal(
      root,
      providerWritingDeterministicClaim(root, {
        status: "blocked",
        summary: "No open PR found for this branch."
      }),
      prepared
    );

    expect(run.state).toBe("blocked");
    expect(run.terminal_state_id).toBe("blocked_terminal");

    // Proves the path the agent was told to write to is the same path
    // Symphonika read back -- through the real startAttempt ->
    // applyWorkflowOutcome pipeline, not just a shared test-side constant.
    const promptPath = path.join(
      root,
      ".symphonika",
      "logs",
      "runs",
      DETERMINISTIC_RUN_ID,
      "prompt.md"
    );
    const prompt = await readFile(promptPath, "utf8");
    expect(prompt).toContain(
      workflowClaimFilePath(
        path.join(root, ".symphonika"),
        DETERMINISTIC_RUN_ID,
        1
      )
    );
  });

  it("advances normally when no claim file is written", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const run = await runUntilTerminal(
      root,
      providerWritingDeterministicClaim(root, undefined),
      prepared
    );

    expect(run.state).toBe("succeeded");
    expect(run.terminal_state_id).toBe("done");
  });
});
