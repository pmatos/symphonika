import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, afterEach } from "vitest";

import Database from "better-sqlite3";

import { buildCli } from "../src/cli.js";
import { databasePath, openRunStore, type RunStore } from "../src/run-store.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import {
  prepareIssueWorkspace,
  type WorkspaceProject
} from "../src/workspace.js";
import { pruneIssueWorkspaces } from "../src/issue-workspace-retention.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("issue workspace retention", () => {
  it("supports dry-run, then reclaims the registered worktree while preserving the issue branch", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = alphaProject({ remotePath, workspaceRoot });
    const prepared = await prepareIssueWorkspace({
      configDir: root,
      issue: { number: 790, title: "Reclaim issue workspaces" },
      project
    });

    const store = openRunStore({ stateRoot });
    try {
      createTerminalRun(store, {
        id: "run-succeeded",
        issue: { number: 790, title: "Reclaim issue workspaces" },
        prepared,
        state: "succeeded"
      });

      const worktreesBefore = await worktreePaths(prepared.cachePath);
      expect(worktreesBefore).toContain(prepared.workspacePath);

      const dryRun = await pruneIssueWorkspaces({
        dryRun: true,
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: { enabled: true, failedDays: 3, succeededDays: 0 },
        runStore: store
      });
      expect(dryRun.candidates.map((entry) => entry.runId)).toEqual([
        "run-succeeded"
      ]);
      expect(dryRun.pruned).toEqual([]);
      await expect(access(prepared.workspacePath)).resolves.toBeUndefined();

      const report = await pruneIssueWorkspaces({
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: { enabled: true, failedDays: 3, succeededDays: 0 },
        runStore: store
      });

      expect(report.failures).toEqual([]);
      expect(report.pruned.map((entry) => entry.runId)).toEqual([
        "run-succeeded"
      ]);
      await expect(access(prepared.workspacePath)).rejects.toThrow();
      const worktreesAfter = await worktreePaths(prepared.cachePath);
      expect(worktreesAfter).not.toContain(prepared.workspacePath);
      await expect(
        branchExists(prepared.cachePath, prepared.branchName)
      ).resolves.toBe(true);
    } finally {
      store.close();
    }
  });

  it("withholds a workspace_path when any sibling row is still non-terminal, even one whose updated_at ranks behind a stale terminal row", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = alphaProject({ remotePath, workspaceRoot });
    const prepared = await prepareIssueWorkspace({
      configDir: root,
      issue: { number: 791, title: "Continuation in flight" },
      project
    });

    const store = openRunStore({ stateRoot });
    try {
      createTerminalRun(store, {
        id: "run-parent-failed",
        issue: { number: 791, title: "Continuation in flight" },
        prepared,
        state: "failed"
      });
      store.createContinuationRun({
        id: "run-continuation-running",
        issue: issueSnapshotFixture({
          number: 791,
          title: "Continuation in flight"
        }),
        parentRunId: "run-parent-failed",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex"
      });
      store.updateRunState("run-continuation-running", "running");
    } finally {
      store.close();
    }

    // Force the ranking window's ordinary "newest row wins" reading to point
    // at the stale terminal row: without the NOT EXISTS liveness guard, this
    // backdate alone would make run-parent-failed rn=1 and a valid candidate.
    const database = new Database(databasePath(stateRoot));
    try {
      database
        .prepare("update runs set updated_at = ? where id = ?")
        .run("2000-01-01T00:00:00.000Z", "run-continuation-running");
    } finally {
      database.close();
    }

    const reopened = openRunStore({ stateRoot });
    try {
      const report = await pruneIssueWorkspaces({
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: { enabled: true, failedDays: 0, succeededDays: 0 },
        runStore: reopened
      });

      expect(report.candidates).toEqual([]);
      await expect(access(prepared.workspacePath)).resolves.toBeUndefined();
      expect(await worktreePaths(prepared.cachePath)).toContain(
        prepared.workspacePath
      );
    } finally {
      reopened.close();
    }
  });

  it("does not reselect an already-pruned workspace on a later pass", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = alphaProject({ remotePath, workspaceRoot });
    const prepared = await prepareIssueWorkspace({
      configDir: root,
      issue: { number: 792, title: "Prune twice" },
      project
    });

    const store = openRunStore({ stateRoot });
    try {
      createTerminalRun(store, {
        id: "run-prune-twice",
        issue: { number: 792, title: "Prune twice" },
        prepared,
        state: "succeeded"
      });

      const first = await pruneIssueWorkspaces({
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: { enabled: true, failedDays: 3, succeededDays: 0 },
        runStore: store
      });
      expect(first.pruned.map((entry) => entry.runId)).toEqual([
        "run-prune-twice"
      ]);

      const second = await pruneIssueWorkspaces({
        now: new Date("2100-01-02T00:00:00.000Z"),
        policy: { enabled: true, failedDays: 3, succeededDays: 0 },
        runStore: store
      });
      expect(second.candidates).toEqual([]);
      expect(second.pruned).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("applies failedDays (not succeededDays) to blocked, cancelled, and input_required terminal states, distinctly from succeeded", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = alphaProject({ remotePath, workspaceRoot });

    const store = openRunStore({ stateRoot });
    try {
      const states = [
        "blocked",
        "cancelled",
        "input_required",
        "succeeded"
      ] as const;
      const prepareds = [];
      for (const [index, state] of states.entries()) {
        const issueNumber = 800 + index;
        const prepared = await prepareIssueWorkspace({
          configDir: root,
          issue: { number: issueNumber, title: `Terminal ${state}` },
          project
        });
        prepareds.push(prepared);
        createTerminalRun(store, {
          id: `run-${state}`,
          issue: { number: issueNumber, title: `Terminal ${state}` },
          prepared,
          state
        });
      }

      // succeededDays: 0 makes the succeeded run old enough on its own
      // bucket; failedDays: 36500 (MAX_ROUTINE_WORKSPACE_RETENTION_DAYS)
      // keeps every non-succeeded terminal state withheld regardless of how
      // far `now` is pushed. If succeeded ever routed through failedBefore
      // instead of succeededBefore, it would be withheld here too. dryRun so
      // this check does not itself reclaim run-succeeded before the next
      // assertion needs it still present.
      const withheld = await pruneIssueWorkspaces({
        dryRun: true,
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: { enabled: true, failedDays: 36_500, succeededDays: 0 },
        runStore: store
      });
      expect(withheld.candidates.map((entry) => entry.runId)).toEqual([
        "run-succeeded"
      ]);

      const released = await pruneIssueWorkspaces({
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: { enabled: true, failedDays: 0, succeededDays: 0 },
        runStore: store
      });
      expect(released.pruned.map((entry) => entry.runId).sort()).toEqual([
        "run-blocked",
        "run-cancelled",
        "run-input_required",
        "run-succeeded"
      ]);
      for (const prepared of prepareds) {
        await expect(access(prepared.workspacePath)).rejects.toThrow();
      }
    } finally {
      store.close();
    }
  });

  it("wires Issue Workspace retention into the prune-workspaces CLI command", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const configPath = path.join(root, "symphonika.yml");
    await writeServiceConfig({
      configPath,
      remotePath,
      stateRoot,
      workspaceRoot
    });
    const project = alphaProject({ remotePath, workspaceRoot });
    const prepared = await prepareIssueWorkspace({
      configDir: root,
      issue: { number: 793, title: "CLI wiring" },
      project
    });

    const store = openRunStore({ stateRoot });
    createTerminalRun(store, {
      id: "run-cli-wiring",
      issue: { number: 793, title: "CLI wiring" },
      prepared,
      state: "succeeded"
    });
    store.close();

    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });
    program.exitOverride();

    await program.parseAsync([
      "node",
      "symphonika",
      "prune-workspaces",
      "--config",
      configPath
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("pruned: run-cli-wiring");
    await expect(access(prepared.workspacePath)).rejects.toThrow();
  });
});

async function writeServiceConfig(input: {
  configPath: string;
  remotePath: string;
  stateRoot: string;
  workspaceRoot: string;
}): Promise<void> {
  await writeFile(
    input.configPath,
    [
      "state:",
      `  root: ${input.stateRoot}`,
      "retention:",
      "  issue_workspaces:",
      "    succeeded_days: 0",
      "providers:",
      "  codex:",
      '    command: "codex"',
      "  claude:",
      '    command: "claude"',
      "projects:",
      "  - name: alpha",
      "    mode: routine_host",
      "    workspace:",
      `      root: ${input.workspaceRoot}`,
      "      git:",
      `        remote: ${input.remotePath}`,
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      ""
    ].join("\n")
  );
}

function alphaProject(input: {
  remotePath: string;
  workspaceRoot: string;
}): WorkspaceProject {
  return {
    name: "alpha",
    workspace: {
      git: { base_branch: "main", remote: input.remotePath },
      root: input.workspaceRoot
    }
  };
}

function createTerminalRun(
  store: RunStore,
  input: {
    id: string;
    issue: { number: number; title: string };
    prepared: { branchName: string; branchRef: string; workspacePath: string };
    state: "succeeded" | "failed" | "blocked" | "cancelled" | "input_required";
  }
): void {
  store.createRun({
    id: input.id,
    issue: issueSnapshotFixture(input.issue),
    projectName: "alpha",
    providerCommand: "codex fake",
    providerName: "codex"
  });
  store.updateRunEvidence(input.id, {
    branchName: input.prepared.branchName,
    branchRef: input.prepared.branchRef,
    issueSnapshotPath: "/tmp/issue-snapshot.json",
    metadataPath: "/tmp/metadata.json",
    normalizedLogPath: "/tmp/normalized.log",
    promptPath: "/tmp/prompt.md",
    rawLogPath: "/tmp/raw.log",
    workflowGraphPath: "/tmp/workflow-graph.json",
    workspacePath: input.prepared.workspacePath
  });
  store.updateRunState(input.id, input.state);
}

function issueSnapshotFixture(overrides: {
  number: number;
  title: string;
}): IssueSnapshot {
  return {
    body: `${overrides.title} body.`,
    created_at: "2026-04-20T10:00:00Z",
    id: 9000 + overrides.number,
    labels: ["agent-ready"],
    number: overrides.number,
    priority: 99,
    state: "open",
    title: overrides.title,
    updated_at: "2026-04-20T10:00:00Z",
    url: `https://github.com/pmatos/symphonika/issues/${overrides.number}`
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-issue-retention-")
  );
  tempRoots.push(root);
  return root;
}

async function createRemoteRepository(root: string): Promise<string> {
  const remotePath = path.join(root, "remote.git");
  const seedPath = path.join(root, "seed");

  await git(["init", "--bare", remotePath]);
  await git(["init", "--initial-branch=main", seedPath]);
  await git(["-C", seedPath, "config", "user.email", "test@example.com"]);
  await git(["-C", seedPath, "config", "user.name", "Symphonika Test"]);
  await writeFile(path.join(seedPath, "README.md"), "# Symphonika\n");
  await git(["-C", seedPath, "add", "README.md"]);
  await git(["-C", seedPath, "commit", "-m", "Initial commit"]);
  await git(["-C", seedPath, "remote", "add", "origin", remotePath]);
  await git(["-C", seedPath, "push", "origin", "main"]);
  return remotePath;
}

async function worktreePaths(cachePath: string): Promise<string[]> {
  const output = await git([
    "-C",
    cachePath,
    "worktree",
    "list",
    "--porcelain"
  ]);
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

async function branchExists(
  cachePath: string,
  branchName: string
): Promise<boolean> {
  try {
    await git([
      "-C",
      cachePath,
      "show-ref",
      "--verify",
      `refs/heads/${branchName}`
    ]);
    return true;
  } catch {
    return false;
  }
}
