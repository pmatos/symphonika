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
import {
  prepareRoutineWorkspace,
  routineFiringBranchName
} from "../src/routines/workspace.js";
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

  it("preserves an unrelated branch whose name collides with a report firing", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const firingId = "fire-report-collision";
    const routineName = "daily-report";
    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId,
      kind: "report",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName
    });
    const unrelatedBranch = routineFiringBranchName({
      firingId,
      projectName: "alpha",
      routineName
    });
    await git([
      "-C",
      prepared.cachePath,
      "branch",
      unrelatedBranch,
      "origin/main"
    ]);

    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines([
        {
          kind: "report",
          name: routineName,
          prompt: "Report.",
          projectName: "alpha",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);
      store.createRoutineFiring({
        id: firingId,
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName
      });
      store.completeRoutineFiring({
        id: firingId,
        state: "succeeded",
        workspacePath: prepared.workspacePath
      });
      store.syncRoutines([
        {
          kind: "git",
          name: routineName,
          prompt: "Report, then update the declaration.",
          projectName: "alpha",
          provider: "codex",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);
      expect(store.getRoutineFiring(firingId)?.kind).toBe("report");

      const report = await pruneRoutineWorkspaces({
        policy: {
          cancelledDays: 14,
          enabled: true,
          failedDays: 14,
          succeededDays: 0
        },
        runStore: store
      });

      expect(report.failures).toEqual([]);
      expect(report.pruned.map((entry) => entry.firingId)).toContain(firingId);
      await expect(
        branchExists(prepared.cachePath, unrelatedBranch)
      ).resolves.toBe(true);
    } finally {
      store.close();
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
      branchName: prepared.branchName,
      branchRef: prepared.branchRef,
      id: "fire-git-branch",
      kind: "git",
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

  it("treats a concurrently deleted kind: git branch as reclaimed", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const firingId = "fire-branch-race";
    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId,
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
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    const wrapperDirectory = path.join(root, "bin");
    await mkdir(wrapperDirectory, { recursive: true });
    await writeFile(
      path.join(wrapperDirectory, "git"),
      [
        "#!/bin/sh",
        'if [ "$3" = "branch" ] && [ "$4" = "-D" ]; then',
        '  "$REAL_GIT_PATH" -C "$2" update-ref -d "refs/heads/$5"',
        'elif [ "$3" = "update-ref" ] && [ "$4" = "-d" ]; then',
        '  "$REAL_GIT_PATH" -C "$2" update-ref -d "$5"',
        "fi",
        'exec "$REAL_GIT_PATH" "$@"',
        ""
      ].join("\n"),
      { mode: 0o755 }
    );

    const store = openRunStore({ stateRoot });
    try {
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
        branchName: prepared.branchName,
        branchRef: prepared.branchRef,
        id: firingId,
        kind: "git",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "dependency-update"
      });
      store.completeRoutineFiring({
        id: firingId,
        state: "succeeded",
        workspacePath: prepared.workspacePath
      });
      vi.stubEnv("REAL_GIT_PATH", realGitOutput.trim());
      vi.stubEnv(
        "PATH",
        `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ""}`
      );

      const report = await pruneRoutineWorkspaces({
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: {
          cancelledDays: 0,
          enabled: true,
          failedDays: 0,
          succeededDays: 0
        },
        runStore: store
      });

      expect(report.failures).toEqual([]);
      expect(report.pruned.map((entry) => entry.firingId)).toContain(firingId);
      expect(store.getRoutineFiring(firingId)?.workspacePrunedAt).toBe(
        "2100-01-01T00:00:00.000Z"
      );
      await expect(
        branchExists(prepared.cachePath, prepared.branchName)
      ).resolves.toBe(false);
    } finally {
      vi.unstubAllEnvs();
      store.close();
    }
  });

  it.each(["missing", "invalid"] as const)(
    "marks an absent planned workspace reclaimed when its cache is %s",
    async (cacheState) => {
      const root = await makeTempRoot();
      const stateRoot = path.join(root, "state");
      const workspaceRoot = path.join(root, "workspaces", "alpha");
      const firingId = `fire-${cacheState}-cache`;
      const workspacePath = path.join(
        workspaceRoot,
        "routines",
        "daily-report",
        firingId
      );
      if (cacheState === "invalid") {
        const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
        await mkdir(cachePath, { recursive: true });
        await writeFile(path.join(cachePath, "partial-clone"), "not a repo\n");
      }

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
          id: firingId,
          projectName: "alpha",
          providerCommand: "codex fake",
          providerName: "codex",
          routineName: "daily-report",
          workspacePath
        });
        store.completeRoutineFiring({ id: firingId, state: "failed" });

        const first = await pruneRoutineWorkspaces({
          now: new Date("2100-01-01T00:00:00.000Z"),
          policy: {
            cancelledDays: 0,
            enabled: true,
            failedDays: 0,
            succeededDays: 0
          },
          runStore: store
        });

        expect(first).toEqual({
          candidates: [{ firingId, workspacePath }],
          failures: [],
          pruned: [{ firingId, workspacePath }]
        });
        expect(store.getRoutineFiring(firingId)).toMatchObject({
          workspacePath,
          workspacePrunedAt: "2100-01-01T00:00:00.000Z"
        });

        const second = await pruneRoutineWorkspaces({
          now: new Date("2100-01-02T00:00:00.000Z"),
          policy: {
            cancelledDays: 0,
            enabled: true,
            failedDays: 0,
            succeededDays: 0
          },
          runStore: store
        });
        expect(second).toEqual({
          candidates: [],
          failures: [],
          pruned: []
        });
      } finally {
        store.close();
      }
    }
  );

  it("does not mark an existing planned workspace reclaimed when its cache is invalid", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, "state");
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const firingId = "fire-existing-workspace";
    const workspacePath = path.join(
      workspaceRoot,
      "routines",
      "daily-report",
      firingId
    );
    const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
    await mkdir(workspacePath, { recursive: true });
    await mkdir(cachePath, { recursive: true });
    await writeFile(path.join(cachePath, "partial-clone"), "not a repo\n");

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
        id: firingId,
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report",
        workspacePath
      });
      store.completeRoutineFiring({ id: firingId, state: "failed" });

      const report = await pruneRoutineWorkspaces({
        now: new Date("2100-01-01T00:00:00.000Z"),
        policy: {
          cancelledDays: 0,
          enabled: true,
          failedDays: 0,
          succeededDays: 0
        },
        runStore: store
      });

      expect(report.pruned).toEqual([]);
      expect(report.failures).toEqual([
        expect.objectContaining({ firingId, workspacePath })
      ]);
      expect(store.getRoutineFiring(firingId)).toMatchObject({
        workspacePath,
        workspacePrunedAt: null
      });
      await expect(access(workspacePath)).resolves.toBeUndefined();
    } finally {
      store.close();
    }
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
