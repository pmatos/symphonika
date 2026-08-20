import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  ensureRepositoryCache,
  git,
  isAbortError,
  WorkspacePreparationCleanupError,
  type WorkspaceProject
} from "../workspace.js";
import { slugifyWorkspaceSegment } from "../workspace-paths.js";
import type { RoutineKind } from "./types.js";

export type PrepareRoutineWorkspaceInput = {
  configDir: string;
  firingId: string;
  kind: RoutineKind;
  project: WorkspaceProject;
  routineName: string;
  signal?: AbortSignal;
};

export type PreparedRoutineWorkspace = {
  branchName: string;
  branchRef: string;
  cachePath: string;
  reused: boolean;
  workspacePath: string;
};

export type RoutineWorkspacePathPlan = Omit<PreparedRoutineWorkspace, "reused">;

class RoutineWorkspaceCleanupError extends WorkspacePreparationCleanupError {
  constructor(workspacePath: string, cause: unknown) {
    super(`failed to clean aborted routine worktree ${workspacePath}`, cause);
    this.name = "RoutineWorkspaceCleanupError";
  }
}

export function planRoutineWorkspacePaths(
  input: PrepareRoutineWorkspaceInput
): RoutineWorkspacePathPlan {
  const workspaceRoot = path.resolve(
    input.configDir,
    input.project.workspace.root
  );
  const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
  const workspacePath = path.join(
    workspaceRoot,
    "routines",
    input.routineName,
    input.firingId
  );
  const baseRef = `refs/remotes/origin/${input.project.workspace.git.base_branch}`;
  const branchName =
    input.kind === "git"
      ? routineFiringBranchName({
          firingId: input.firingId,
          projectName: input.project.name,
          routineName: input.routineName
        })
      : input.project.workspace.git.base_branch;
  const branchRef = input.kind === "git" ? `refs/heads/${branchName}` : baseRef;
  return {
    branchName,
    branchRef,
    cachePath,
    workspacePath
  };
}

export async function prepareRoutineWorkspace(
  input: PrepareRoutineWorkspaceInput
): Promise<PreparedRoutineWorkspace> {
  const { branchName, branchRef, cachePath, workspacePath } =
    planRoutineWorkspacePaths(input);
  input.signal?.throwIfAborted();
  await ensureRepositoryCache(input.project, cachePath, input.signal);
  if (await exists(workspacePath)) {
    input.signal?.throwIfAborted();
    return {
      branchName,
      branchRef,
      cachePath,
      reused: true,
      workspacePath
    };
  }
  let createdBranch = false;
  if (
    input.kind === "git" &&
    !(await gitSucceeds(
      ["-C", cachePath, "show-ref", "--verify", branchRef],
      input.signal
    ))
  ) {
    try {
      await git(
        [
          "-C",
          cachePath,
          "branch",
          branchName,
          `origin/${input.project.workspace.git.base_branch}`
        ],
        input.signal
      );
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted === true) {
        try {
          await cleanupAbortedRoutineBranch(cachePath, branchRef);
        } catch (cleanupError) {
          throw new RoutineWorkspaceCleanupError(
            workspacePath,
            new AggregateError([error, cleanupError])
          );
        }
      }
      throw error;
    }
    createdBranch = true;
    if (input.signal?.aborted === true) {
      // The branch above was just created by this call; an abort landing
      // here would otherwise leak it in the shared cache with nothing left
      // to claim it (no worktree was created yet to trigger the cleanup
      // below).
      try {
        await cleanupAbortedRoutineBranch(cachePath, branchRef);
      } catch (cleanupError) {
        throw new RoutineWorkspaceCleanupError(
          workspacePath,
          new AggregateError([input.signal.reason, cleanupError])
        );
      }
    }
  }
  input.signal?.throwIfAborted();
  await mkdir(path.dirname(workspacePath), { recursive: true });
  try {
    await git(
      input.kind === "git"
        ? ["-C", cachePath, "worktree", "add", workspacePath, branchName]
        : [
            "-C",
            cachePath,
            "worktree",
            "add",
            "--detach",
            workspacePath,
            `origin/${input.project.workspace.git.base_branch}`
          ],
      input.signal
    );
    input.signal?.throwIfAborted();
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted === true) {
      const cleanupErrors: unknown[] = [];
      try {
        await cleanupAbortedRoutineWorktree(cachePath, workspacePath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (createdBranch) {
        try {
          await cleanupAbortedRoutineBranch(cachePath, branchRef);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new RoutineWorkspaceCleanupError(
          workspacePath,
          new AggregateError([error, ...cleanupErrors])
        );
      }
    }
    throw error;
  }
  return {
    branchName,
    branchRef,
    cachePath,
    reused: false,
    workspacePath
  };
}

export function routineFiringBranchName(input: {
  firingId: string;
  projectName: string;
  routineName: string;
}): string {
  return [
    "sym",
    slugifyWorkspaceSegment(input.projectName, "project"),
    "routine",
    slugifyWorkspaceSegment(input.routineName, "routine"),
    input.firingId.slice(0, 10)
  ].join("/");
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

async function cleanupAbortedRoutineWorktree(
  cachePath: string,
  workspacePath: string
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await git([
      "-C",
      cachePath,
      "worktree",
      "remove",
      "--force",
      workspacePath
    ]);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(workspacePath, { force: true, recursive: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await git(["-C", cachePath, "worktree", "prune"]);
  } catch (error) {
    cleanupErrors.push(error);
  }

  let workspaceRemains = true;
  let registrationRemains = true;
  try {
    workspaceRemains = await exists(workspacePath);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    registrationRemains = await isRoutineWorktreeRegistered(
      cachePath,
      workspacePath
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (workspaceRemains || registrationRemains) {
    throw new Error(`routine worktree cleanup remained incomplete`, {
      cause: new AggregateError(cleanupErrors)
    });
  }
}

async function cleanupAbortedRoutineBranch(
  cachePath: string,
  branchRef: string
): Promise<void> {
  await git(["-C", cachePath, "update-ref", "-d", branchRef]);
}

async function isRoutineWorktreeRegistered(
  cachePath: string,
  workspacePath: string
): Promise<boolean> {
  const output = await git([
    "-C",
    cachePath,
    "worktree",
    "list",
    "--porcelain"
  ]);
  const expectedPath = path.resolve(workspacePath);
  return output.split(/\r?\n/).some((line) => {
    return (
      line.startsWith("worktree ") &&
      path.resolve(line.slice("worktree ".length)) === expectedPath
    );
  });
}

async function gitSucceeds(
  args: string[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await git(args, signal);
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
