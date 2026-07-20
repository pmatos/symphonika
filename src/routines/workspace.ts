import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
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
  const baseRef = `refs/remotes/origin/${input.project.workspace.git.base_branch}`;
  const branchName =
    input.kind === "git"
      ? [
          "sym",
          slugifyWorkspaceSegment(input.project.name, "project"),
          "routine",
          slugifyWorkspaceSegment(input.routineName, "routine"),
          input.firingId.slice(0, 10)
        ].join("/")
      : input.project.workspace.git.base_branch;
  const branchRef = input.kind === "git" ? `refs/heads/${branchName}` : baseRef;
  await ensureRepositoryCache(input.project, cachePath);
  if (await exists(workspacePath)) {
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
    !(await gitSucceeds(["-C", cachePath, "show-ref", "--verify", branchRef]))
  ) {
    await git([
      "-C",
      cachePath,
      "branch",
      branchName,
      `origin/${input.project.workspace.git.base_branch}`
    ]);
  }
  await mkdir(path.dirname(workspacePath), { recursive: true });
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
        ]
  );
  return {
    branchName,
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

async function gitSucceeds(args: string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
