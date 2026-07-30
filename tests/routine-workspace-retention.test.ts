import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../src/cli.js";
import { openRunStore } from "../src/run-store.js";
import { prepareRoutineWorkspace } from "../src/routines/workspace.js";
import { pruneRoutineWorkspaces } from "../src/routines/workspace-retention.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("routine firing workspace retention", () => {
  it("supports dry-run, then reclaims the registered worktree while preserving state-root evidence", async () => {
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
    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "fire-retention",
      kind: "report",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName: "daily-report"
    });
    await writeFile(path.join(prepared.workspacePath, "agent-output.txt"), "x");

    const evidencePath = path.join(
      stateRoot,
      "logs",
      "routines",
      "fire-retention",
      "prompt.md"
    );
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, "durable prompt evidence\n");

    const store = openRunStore({ stateRoot });
    store.syncRoutines([
      {
        kind: "report",
        name: "daily-report",
        prompt: "Report.",
        projectName: "alpha",
        provider: null,
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: "/tmp/daily-report.md"
      }
    ]);
    store.createRoutineFiring({
      id: "fire-retention",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "daily-report"
    });
    store.completeRoutineFiring({
      id: "fire-retention",
      state: "succeeded",
      workspacePath: prepared.workspacePath
    });
    store.close();

    const worktreesBefore = await worktreePaths(prepared.cachePath);
    expect(worktreesBefore).toContain(prepared.workspacePath);

    const dryRunOutput = { stderr: "", stdout: "" };
    const dryRunProgram = buildCli({ registerSignalHandlers: false });
    dryRunProgram.configureOutput({
      writeErr: (message) => {
        dryRunOutput.stderr += message;
      },
      writeOut: (message) => {
        dryRunOutput.stdout += message;
      }
    });
    dryRunProgram.exitOverride();
    await dryRunProgram.parseAsync([
      "node",
      "symphonika",
      "prune-workspaces",
      "--dry-run",
      "--config",
      configPath
    ]);
    expect(dryRunOutput.stderr).toBe("");
    expect(dryRunOutput.stdout).toContain("would prune: fire-retention");
    await expect(access(prepared.workspacePath)).resolves.toBeUndefined();
    expect(await worktreePaths(prepared.cachePath)).toContain(
      prepared.workspacePath
    );

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
    expect(output.stdout).toContain("pruned: fire-retention");
    await expect(access(prepared.workspacePath)).rejects.toThrow();
    const worktreesAfter = await worktreePaths(prepared.cachePath);
    expect(worktreesAfter).not.toContain(prepared.workspacePath);
    expect(worktreesAfter).toHaveLength(worktreesBefore.length - 1);
    await expect(readFile(evidencePath, "utf8")).resolves.toBe(
      "durable prompt evidence\n"
    );

    const reopened = openRunStore({ stateRoot });
    try {
      const firing = reopened.getRoutineFiring("fire-retention");
      expect(firing?.workspacePath).toBe(prepared.workspacePath);
      expect(typeof firing?.workspacePrunedAt).toBe("string");
    } finally {
      reopened.close();
    }
  });

  it("deletes the deterministic kind: git branch after reclaiming its worktree, tolerating firings without one", async () => {
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
    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "fire-git-branch",
      kind: "git",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName: "dependency-update"
    });

    const store = openRunStore({ stateRoot });
    store.syncRoutines([
      {
        kind: "git",
        name: "dependency-update",
        prompt: "Update dependencies.",
        projectName: "alpha",
        provider: "codex",
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: "/tmp/dependency-update.md"
      }
    ]);
    store.createRoutineFiring({
      id: "fire-git-branch",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "dependency-update"
    });
    store.completeRoutineFiring({
      id: "fire-git-branch",
      state: "succeeded",
      workspacePath: prepared.workspacePath
    });
    store.close();

    await expect(
      branchExists(prepared.cachePath, prepared.branchName)
    ).resolves.toBe(true);

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
    expect(output.stdout).toContain("pruned: fire-git-branch");
    await expect(
      branchExists(prepared.cachePath, prepared.branchName)
    ).resolves.toBe(false);
  });

  it("reports a firing as pruned when a concurrent pruner already marked it, instead of dropping it silently", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "fire-race",
      kind: "report",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName: "daily-report"
    });

    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines([
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          projectName: "alpha",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);
      store.createRoutineFiring({
        id: "fire-race",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      store.completeRoutineFiring({
        id: "fire-race",
        state: "succeeded",
        workspacePath: prepared.workspacePath
      });

      // Simulate a concurrent pruner (daemon vs. manual `prune-workspaces`)
      // winning the database write between this call's candidate read and
      // its own markRoutineWorkspacePruned write: reclaimRegisteredWorktree
      // still runs for real (the worktree really gets removed), but the
      // mark-pruned write reports false, as it would if another process's
      // write had already flipped workspace_pruned_at.
      vi.spyOn(store, "markRoutineWorkspacePruned").mockReturnValueOnce(false);

      const report = await pruneRoutineWorkspaces({
        policy: {
          cancelledDays: 14,
          enabled: true,
          failedDays: 14,
          succeededDays: 0
        },
        runStore: store
      });

      expect(report.candidates.map((entry) => entry.firingId)).toContain(
        "fire-race"
      );
      expect(report.pruned.map((entry) => entry.firingId)).toContain(
        "fire-race"
      );
      expect(report.failures).toEqual([]);
      await expect(access(prepared.workspacePath)).rejects.toThrow();
    } finally {
      store.close();
    }
  });

  it("withholds a verified commit-only outcome from age-based pruning", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "fire-commit-only",
      kind: "git",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName: "nightly-cleanup"
    });

    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines([
        {
          kind: "git",
          name: "nightly-cleanup",
          prompt: "Clean up.",
          projectName: "alpha",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/nightly-cleanup.md"
        }
      ]);
      store.createRoutineFiring({
        id: "fire-commit-only",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "nightly-cleanup"
      });
      store.completeRoutineFiring({
        id: "fire-commit-only",
        outcome: {
          action: "commit",
          source: "git",
          status: "success",
          summary: "Observed commits ahead of the configured base branch.",
          title: "Commit retained in the Routine Firing workspace",
          url: null,
          verified: true
        },
        state: "succeeded",
        workspacePath: prepared.workspacePath
      });

      // succeededDays: 0 makes every succeeded firing old enough to prune;
      // only the verified commit-only outcome should withhold this one.
      const report = await pruneRoutineWorkspaces({
        policy: {
          cancelledDays: 14,
          enabled: true,
          failedDays: 14,
          succeededDays: 0
        },
        runStore: store
      });

      expect(report.candidates.map((entry) => entry.firingId)).not.toContain(
        "fire-commit-only"
      );
      expect(report.pruned.map((entry) => entry.firingId)).not.toContain(
        "fire-commit-only"
      );
      await expect(access(prepared.workspacePath)).resolves.toBeUndefined();
      expect(await worktreePaths(prepared.cachePath)).toContain(
        prepared.workspacePath
      );
    } finally {
      store.close();
    }
  });

  it("withholds commits ahead from age-based pruning when the canonical outcome is a verified issue closure", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "fire-commit-and-issue",
      kind: "git",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName: "nightly-cleanup"
    });

    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines([
        {
          kind: "git",
          name: "nightly-cleanup",
          prompt: "Clean up.",
          projectName: "alpha",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/nightly-cleanup.md"
        }
      ]);
      store.createRoutineFiring({
        id: "fire-commit-and-issue",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "nightly-cleanup"
      });
      store.completeRoutineFiring({
        commitsAhead: true,
        id: "fire-commit-and-issue",
        outcome: {
          action: "issue_closed",
          source: "gh",
          status: "success",
          summary: "Observed via GitHub state diff.",
          title: "Close completed migration issue",
          url: "https://github.com/pmatos/rightkey/issues/42",
          verified: true
        },
        state: "succeeded",
        workspacePath: prepared.workspacePath
      });

      const report = await pruneRoutineWorkspaces({
        policy: {
          cancelledDays: 14,
          enabled: true,
          failedDays: 14,
          succeededDays: 0
        },
        runStore: store
      });

      expect(report.candidates.map((entry) => entry.firingId)).not.toContain(
        "fire-commit-and-issue"
      );
      expect(report.pruned.map((entry) => entry.firingId)).not.toContain(
        "fire-commit-and-issue"
      );
      await expect(access(prepared.workspacePath)).resolves.toBeUndefined();
      expect(await worktreePaths(prepared.cachePath)).toContain(
        prepared.workspacePath
      );
    } finally {
      store.close();
    }
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-retention-")
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
      "  routine_workspaces:",
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
