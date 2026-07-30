import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { RoutineFiringStatus, RunStore } from "../run-store.js";
import { routineFiringBranchName } from "./workspace.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
// Well under the ~100,000,000-day ECMAScript Date range on either side of
// `now`, so `cutoff` never produces an invalid Date/RangeError regardless of
// `now`'s value, while still comfortably exceeding any real retention need.
export const MAX_ROUTINE_WORKSPACE_RETENTION_DAYS = 36_500;

export type RoutineWorkspaceRetentionPolicy = {
  cancelledDays: number;
  enabled: boolean;
  failedDays: number;
  succeededDays: number;
};

export const DEFAULT_ROUTINE_WORKSPACE_RETENTION: RoutineWorkspaceRetentionPolicy =
  {
    cancelledDays: 14,
    enabled: true,
    failedDays: 14,
    succeededDays: 1
  };

type RoutineWorkspacePruneEntry = {
  firingId: string;
  workspacePath: string;
};

type RoutineWorkspacePruneFailure = RoutineWorkspacePruneEntry & {
  error: string;
};

export type RoutineWorkspacePruneReport = {
  candidates: RoutineWorkspacePruneEntry[];
  failures: RoutineWorkspacePruneFailure[];
  pruned: RoutineWorkspacePruneEntry[];
};

export async function pruneRoutineWorkspaces(input: {
  dryRun?: boolean;
  now?: Date;
  policy: RoutineWorkspaceRetentionPolicy;
  runStore: RunStore;
}): Promise<RoutineWorkspacePruneReport> {
  const now = input.now ?? new Date();
  const firings = input.runStore.listRoutineWorkspacePruneCandidates({
    cancelledBefore: cutoff(now, input.policy.cancelledDays),
    failedBefore: cutoff(now, input.policy.failedDays),
    succeededBefore: cutoff(now, input.policy.succeededDays)
  });
  const candidates = firings.map(pruneEntry);
  const report: RoutineWorkspacePruneReport = {
    candidates,
    failures: [],
    pruned: []
  };
  if (input.dryRun === true) {
    return report;
  }

  for (const firing of firings) {
    const entry = pruneEntry(firing);
    try {
      await reclaimRegisteredWorktree(firing);
      if (
        input.runStore.markRoutineWorkspacePruned({
          id: firing.id,
          prunedAt: now.toISOString()
        })
      ) {
        report.pruned.push(entry);
      }
    } catch (error) {
      report.failures.push({
        ...entry,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return report;
}

async function reclaimRegisteredWorktree(
  firing: RoutineFiringStatus
): Promise<void> {
  const { cachePath, workspacePath } = routineWorkspacePlan(firing);
  try {
    await git([
      "-C",
      cachePath,
      "worktree",
      "remove",
      "--force",
      workspacePath
    ]);
  } catch (removeError) {
    await git(["-C", cachePath, "worktree", "prune"]);
    const [workspaceExists, registeredPaths] = await Promise.all([
      exists(workspacePath),
      listRegisteredWorktrees(cachePath)
    ]);
    if (workspaceExists || registeredPaths.has(workspacePath)) {
      throw removeError;
    }
    await deleteRoutineFiringBranch(cachePath, firing);
    return;
  }
  await git(["-C", cachePath, "worktree", "prune"]);
  await deleteRoutineFiringBranch(cachePath, firing);
}

async function deleteRoutineFiringBranch(
  cachePath: string,
  firing: RoutineFiringStatus
): Promise<void> {
  const branchName = routineFiringBranchName({
    firingId: firing.id,
    projectName: firing.projectName,
    routineName: firing.routineName
  });
  if (!(await branchExists(cachePath, branchName))) {
    return;
  }
  await git(["-C", cachePath, "branch", "-D", branchName]);
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
      "--quiet",
      `refs/heads/${branchName}`
    ]);
    return true;
  } catch (error) {
    if (isGitExitCode(error, 1)) {
      return false;
    }
    throw error;
  }
}

function routineWorkspacePlan(firing: RoutineFiringStatus): {
  cachePath: string;
  workspacePath: string;
} {
  const workspacePath = path.resolve(firing.workspacePath);
  const routineDirectory = path.dirname(workspacePath);
  const routinesDirectory = path.dirname(routineDirectory);
  if (
    firing.workspacePath.length === 0 ||
    path.basename(workspacePath) !== firing.id ||
    path.basename(routineDirectory) !== firing.routineName ||
    path.basename(routinesDirectory) !== "routines"
  ) {
    throw new Error(
      `refusing to prune firing ${firing.id}: workspace path does not match <root>/routines/<routine>/<firing-id>`
    );
  }
  const workspaceRoot = path.dirname(routinesDirectory);
  return {
    cachePath: path.join(workspaceRoot, ".cache", "repo.git"),
    workspacePath
  };
}

async function listRegisteredWorktrees(
  cachePath: string
): Promise<Set<string>> {
  const output = await git([
    "-C",
    cachePath,
    "worktree",
    "list",
    "--porcelain"
  ]);
  return new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.resolve(line.slice("worktree ".length)))
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

function cutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

function pruneEntry(firing: RoutineFiringStatus): RoutineWorkspacePruneEntry {
  return {
    firingId: firing.id,
    workspacePath: firing.workspacePath
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isGitExitCode(error: unknown, code: number): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
