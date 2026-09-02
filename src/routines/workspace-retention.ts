import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { RoutineFiringStatus, RunStore } from "../run-store.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_BRANCH_REF_PREFIX = "refs/heads/";
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

type RegisteredWorktree = {
  branchRef: string | null;
  path: string;
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
      // A concurrent prune (daemon vs. manual `prune-workspaces`, or vice
      // versa) may have already reclaimed and marked this firing, so
      // markRoutineWorkspacePruned's write can no-op (row already has
      // workspace_pruned_at set). Either way the workspace ends up
      // reclaimed once reclaimRegisteredWorktree returns without throwing,
      // so report it as pruned regardless of which process's write won.
      input.runStore.markRoutineWorkspacePruned({
        id: firing.id,
        prunedAt: now.toISOString()
      });
      report.pruned.push(entry);
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
    const workspaceExists = await exists(workspacePath);
    if (!workspaceExists && !(await isUsableRepositoryCache(cachePath))) {
      return;
    }
    const registered = await listRegisteredWorktrees(cachePath);
    if (
      workspaceExists ||
      registered.some((worktree) => worktree.path === workspacePath)
    ) {
      throw removeError;
    }
    await deleteRoutineFiringBranch(cachePath, firing);
    return;
  }
  await deleteRoutineFiringBranch(cachePath, firing);
}

async function isUsableRepositoryCache(cachePath: string): Promise<boolean> {
  try {
    return (
      (await git(["-C", cachePath, "rev-parse", "--is-bare-repository"])) ===
      "true"
    );
  } catch {
    return false;
  }
}

async function deleteRoutineFiringBranch(
  cachePath: string,
  firing: RoutineFiringStatus
): Promise<void> {
  if (firing.kind !== "git") {
    return;
  }
  if (
    !firing.branchRef.startsWith(LOCAL_BRANCH_REF_PREFIX) ||
    firing.branchRef === LOCAL_BRANCH_REF_PREFIX
  ) {
    return;
  }
  const branchName = firing.branchRef.slice(LOCAL_BRANCH_REF_PREFIX.length);
  try {
    // Keep Git's own linked-worktree ownership check in the operation that
    // deletes the ref. A separate worktree-list/update-ref sequence can race
    // with another firing checking out the same truncated branch name.
    await git(["-C", cachePath, "branch", "-D", "--", branchName]);
  } catch (deleteError) {
    // A colliding live firing owns this ref now, so reclaiming the terminal
    // firing's workspace is complete without deleting the shared branch.
    const worktrees = await listRegisteredWorktrees(cachePath);
    if (worktrees.some((worktree) => worktree.branchRef === firing.branchRef)) {
      return;
    }
    // Another pruner may have deleted the ref after this process selected its
    // candidate. Treat only the documented show-ref "not found" status as
    // success; repository or subprocess failures remain retryable errors.
    if (!(await localBranchRefExists(cachePath, firing.branchRef))) {
      return;
    }
    throw deleteError;
  }
}

async function localBranchRefExists(
  cachePath: string,
  branchRef: string
): Promise<boolean> {
  try {
    await git(["-C", cachePath, "show-ref", "--verify", "--quiet", branchRef]);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) {
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
): Promise<RegisteredWorktree[]> {
  const output = await git([
    "-C",
    cachePath,
    "worktree",
    "list",
    "--porcelain"
  ]);
  const worktrees: RegisteredWorktree[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      worktrees.push({
        branchRef: null,
        path: path.resolve(line.slice("worktree ".length))
      });
      continue;
    }
    // A porcelain record lists its branch after the worktree path it belongs
    // to, and omits the line entirely when that worktree is detached.
    const current = worktrees.at(-1);
    if (current !== undefined && line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length);
    }
  }
  return worktrees;
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
