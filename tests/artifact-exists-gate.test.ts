import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND =
  "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server";

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-artifact-gate-"));
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
  body: "Plan then implement.",
  created_at: "2026-08-20T10:00:00Z",
  html_url: "https://github.com/pmatos/symphonika/issues/8",
  id: 5008,
  labels: ["agent-ready"],
  number: 8,
  state: "open" as const,
  title: "Artifact gate fixture",
  updated_at: "2026-08-21T11:00:00Z"
};

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "8-artifact-gate-fixture"
  );
  return {
    branchName: "sym/symphonika/8-artifact-gate-fixture",
    branchRef: "refs/heads/sym/symphonika/8-artifact-gate-fixture",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "8-artifact-gate-fixture",
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
  // The planning stage advances only on the plan file existing. Without the
  // gate, provider_success alone carried the transition and an empty planning
  // run handed nothing to the implementer (#583).
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: gated_planning",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      transitions:",
      "        - to: planned",
      "          when:",
      "            provider_success: true",
      "            artifact_exists: PLAN.md",
      "        - to: needs_plan",
      "    planned:",
      "      terminal: success",
      "    needs_plan:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Draft a plan for #{{issue.number}}.\n"
  );
}

function providerWriting(
  artifacts: Array<{ contents: string; relativePath: string }>,
  workspacePath: string
): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    async *runAttempt(): AsyncGenerator<ProviderEvent> {
      for (const artifact of artifacts) {
        await writeFile(
          path.join(workspacePath, artifact.relativePath),
          artifact.contents
        );
      }
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    },
    validate: vi.fn().mockResolvedValue(undefined)
  };
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
  state_transition_reason: string | null;
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
    createRunId: () => "run-artifact-gate",
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
              "select state, terminal_state_id, terminal_reason, state_transition_reason from runs"
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

describe("artifact_exists gates an agent state's transition", () => {
  it("advances when the planner wrote the plan, even uncommitted", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const run = await runUntilTerminal(
      root,
      providerWriting(
        [{ contents: "# Plan\n1. do the work\n", relativePath: "PLAN.md" }],
        prepared.workspacePath
      ),
      prepared
    );

    expect(run.state).toBe("succeeded");
    expect(run.terminal_state_id).toBe("planned");
    expect(run.state_transition_reason).toContain("artifact_exists");
  });

  it("routes a successful planner that wrote no plan to the blocked terminal", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const run = await runUntilTerminal(
      root,
      providerWriting([], prepared.workspacePath),
      prepared
    );

    expect(run.state).toBe("blocked");
    expect(run.terminal_state_id).toBe("needs_plan");
    expect(run.terminal_reason).toBe("workflow_terminal_blocked");
  });
});
