import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  ensureRepositoryCache,
  isAbortError,
  type WorkspaceProject
} from "../workspace.js";
import { slugifyWorkspaceSegment } from "../workspace-paths.js";
import type { RoutineKind } from "./types.js";

const execFileAsync = promisify(execFile);

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
  input.signal?.throwIfAborted();
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
    createdBranch = true;
  }
  try {
    input.signal?.throwIfAborted();
  } catch (error) {
    // The branch above was just created by this call; an abort landing here
    // would otherwise leak it in the shared cache with nothing left to claim
    // it (no worktree was created yet to trigger the cleanup below).
    if (createdBranch) {
      await cleanupAbortedRoutineBranch(cachePath, branchRef);
    }
    throw error;
  }
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
    if (isAbortError(error)) {
      await cleanupAbortedRoutineWorktree(cachePath, workspacePath);
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
  await git([
    "-C",
    cachePath,
    "worktree",
    "remove",
    "--force",
    workspacePath
  ]).catch(() => undefined);
  // Best-effort like the removal above: a failure here must not replace the
  // original abort error the caller is about to (re)throw.
  await rm(workspacePath, { force: true, recursive: true }).catch(
    () => undefined
  );
}

async function cleanupAbortedRoutineBranch(
  cachePath: string,
  branchRef: string
): Promise<void> {
  await git(["-C", cachePath, "update-ref", "-d", branchRef]).catch(
    () => undefined
  );
}

async function git(args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } =
    signal === undefined
      ? await execFileAsync("git", args)
      : await execFileAsync("git", args, { signal });
  return stdout.trim();
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
