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

// Issue #730: a raw-FSM agent prompt that determines it is blocked cannot
// actually fail the run by exiting non-zero from a Bash tool call -- that
// only ends the subshell, not the provider session, so provider_success
// still reads true. The fix is the same artifact_exists mechanism that
// already gates planning -> implementing on PLAN.md (issue #583): the agent
// writes a BLOCKED.md sentinel instead, and the FSM gates on its presence.
// Unlike PLAN.md, BLOCKED.md must NOT persist across attempts in a reused
// workspace (ADR 0040) -- a stale sentinel from an earlier blocked attempt
// must not block a later, genuinely successful one.

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND =
  "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server";

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-blocked-gate-"));
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
  created_at: "2026-08-20T10:00:00Z",
  html_url: "https://github.com/pmatos/symphonika/issues/9",
  id: 5009,
  labels: ["agent-ready"],
  number: 9,
  state: "open" as const,
  title: "Blocked sentinel gate fixture",
  updated_at: "2026-08-21T11:00:00Z"
};

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "9-blocked-sentinel-gate-fixture"
  );
  return {
    branchName: "sym/symphonika/9-blocked-sentinel-gate-fixture",
    branchRef: "refs/heads/sym/symphonika/9-blocked-sentinel-gate-fixture",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "9-blocked-sentinel-gate-fixture",
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
  // Mirrors the real workflow.yml's post-implement agent states: an
  // artifact_exists: BLOCKED.md check ordered before the provider_success
  // advance, so a blocked-but-exit-0 attempt routes to the blocked terminal
  // instead of a false-positive success.
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: blocked_gate_fixture",
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
      "            artifact_exists: BLOCKED.md",
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
    "Do the work for #{{issue.number}}.\n"
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
    createRunId: () => "run-blocked-gate",
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

describe("BLOCKED.md sentinel gates an agent state's transition (issue #730)", () => {
  it("routes to the blocked terminal when the provider writes BLOCKED.md and exits 0", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);

    const run = await runUntilTerminal(
      root,
      providerWriting(
        [
          {
            contents: "# Blocked\nNo open PR found for this branch.\n",
            relativePath: "BLOCKED.md"
          }
        ],
        prepared.workspacePath
      ),
      prepared
    );

    expect(run.state).toBe("blocked");
    expect(run.terminal_state_id).toBe("blocked_terminal");
  });

  it("clears a stale BLOCKED.md left in a reused workspace before a new attempt starts", async () => {
    const root = await makeTempRoot();
    const prepared = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(prepared);
    await writeProject(root);
    // Simulate a workspace reused from an earlier attempt that determined it
    // was blocked and left BLOCKED.md behind (ADR 0040 workspace reuse).
    // This attempt's provider does not touch the file at all -- it just
    // succeeds -- so a leftover sentinel must not survive into this attempt.
    await writeFile(
      path.join(prepared.workspacePath, "BLOCKED.md"),
      "# Blocked\nStale sentinel from a previous attempt.\n"
    );

    const run = await runUntilTerminal(
      root,
      providerWriting([], prepared.workspacePath),
      prepared
    );

    expect(run.state).toBe("succeeded");
    expect(run.terminal_state_id).toBe("done");
  });
});
