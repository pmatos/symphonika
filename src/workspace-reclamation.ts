import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  IssueWorkspacePruneCandidate,
  RoutineFiringStatus
} from "./run-store.js";

const execFileAsync = promisify(execFile);
const LOCAL_BRANCH_REF_PREFIX = "refs/heads/";

type RoutineWorkspaceToReclaim = Pick<
  RoutineFiringStatus,
  "id" | "routineName" | "workspacePath" | "kind" | "branchRef"
>;

type RegisteredWorktree = {
  branchRef: string | null;
  path: string;
};

type WorktreePlan = {
  cachePath: string;
  workspacePath: string;
};

// Retention selects eligible rows and records success only after this resolves.
// Issue Branches are deliberately preserved for retries and continuations.
export async function reclaimIssueWorkspace(
  candidate: Pick<IssueWorkspacePruneCandidate, "workspacePath">
): Promise<void> {
  await removeRegisteredWorktree(
    issueWorkspacePlan(candidate.workspacePath),
    "issue"
  );
}

export async function reclaimRoutineWorkspace(
  firing: RoutineWorkspaceToReclaim
): Promise<void> {
  const plan = routineWorkspacePlan(firing);
  if (await removeRegisteredWorktree(plan, "routine")) {
    await deleteRoutineFiringBranch(plan.cachePath, firing);
  }
}

// False means preparation never produced a workspace or usable cache; there
// is no repository in which to attempt Routine branch cleanup.
async function removeRegisteredWorktree(
  { cachePath, workspacePath }: WorktreePlan,
  kind: "issue" | "routine"
): Promise<boolean> {
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
      return false;
    }
    // Preserve the existing error precedence: Issue retention refuses an
    // existing directory immediately; Routine retention first lists records.
    if (workspaceExists && kind === "issue") {
      throw removeError;
    }
    const registered = await listRegisteredWorktrees(cachePath);
    if (
      workspaceExists ||
      registered.some((worktree) => worktree.path === workspacePath)
    ) {
      throw removeError;
    }
  }
  return true;
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
  firing: RoutineWorkspaceToReclaim
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

function routineWorkspacePlan(firing: RoutineWorkspaceToReclaim): {
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

// Issue leaves are derived from issue number and title, so unlike Routine
// paths they have no firing-id identity check.
function issueWorkspacePlan(workspacePath: string): {
  cachePath: string;
  workspacePath: string;
} {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const issuesDirectory = path.dirname(resolvedWorkspacePath);
  if (
    workspacePath.length === 0 ||
    path.basename(issuesDirectory) !== "issues"
  ) {
    throw new Error(
      `refusing to prune run workspace ${workspacePath}: path does not match <root>/issues/<issue-dir>`
    );
  }
  const workspaceRoot = path.dirname(issuesDirectory);
  return {
    cachePath: path.join(workspaceRoot, ".cache", "repo.git"),
    workspacePath: resolvedWorkspacePath
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
