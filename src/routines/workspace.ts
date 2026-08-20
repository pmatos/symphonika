import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureRepositoryCache, type WorkspaceProject } from "../workspace.js";
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
    if (input.signal?.aborted === true) {
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
  await rm(workspacePath, { force: true, recursive: true });
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
    if (signal?.aborted === true) {
      throw error;
    }
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
