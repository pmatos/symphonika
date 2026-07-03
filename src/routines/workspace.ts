import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureRepositoryCache, type WorkspaceProject } from "../workspace.js";

const execFileAsync = promisify(execFile);

export type PrepareRoutineWorkspaceInput = {
  configDir: string;
  firingId: string;
  project: WorkspaceProject;
  routineName: string;
};

export type PreparedRoutineWorkspace = {
  branchName: string;
  branchRef: string;
  cachePath: string;
  reused: boolean;
  workspacePath: string;
};

export async function prepareRoutineWorkspace(
  input: PrepareRoutineWorkspaceInput
): Promise<PreparedRoutineWorkspace> {
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
  const branchRef = `refs/remotes/origin/${input.project.workspace.git.base_branch}`;
  await ensureRepositoryCache(input.project, cachePath);
  if (await exists(workspacePath)) {
    return {
      branchName: input.project.workspace.git.base_branch,
      branchRef,
      cachePath,
      reused: true,
      workspacePath
    };
  }
  await mkdir(path.dirname(workspacePath), { recursive: true });
  await git([
    "-C",
    cachePath,
    "worktree",
    "add",
    "--detach",
    workspacePath,
    `origin/${input.project.workspace.git.base_branch}`
  ]);
  return {
    branchName: input.project.workspace.git.base_branch,
    branchRef,
    cachePath,
    reused: false,
    workspacePath
  };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
