import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  planWorkspacePaths,
  type WorkspacePathPlan
} from "./workspace-paths.js";

const execFileAsync = promisify(execFile);

export type WorkspaceProject = {
  name: string;
  workspace: {
    git: {
      base_branch: string;
      remote: string;
    };
    root: string;
  };
};

export type WorkspaceIssue = {
  number: number;
  title: string;
};

export type PrepareIssueWorkspaceInput = {
  configDir?: string;
  issue: WorkspaceIssue;
  project: WorkspaceProject;
};

export type PreparedIssueWorkspace = WorkspacePathPlan & { reused: boolean };

export type WorkspacePreparationErrorCode =
  "branch_conflict" | "cache_conflict" | "workspace_conflict";

export class WorkspacePreparationError extends Error {
  readonly code: WorkspacePreparationErrorCode;

  constructor(
    code: WorkspacePreparationErrorCode,
    message: string,
    cause?: unknown
  ) {
    if (cause === undefined) {
      super(message);
    } else {
      super(message, { cause });
    }
    this.name = "WorkspacePreparationError";
    this.code = code;
  }
}

export async function prepareIssueWorkspace(
  input: PrepareIssueWorkspaceInput
): Promise<PreparedIssueWorkspace> {
  const plan = planWorkspacePaths(input);

  await ensureRepositoryCache(input.project, plan.cachePath);
  await ensureIssueBranch(input.project, plan.cachePath, plan.branchName);
  if (await exists(plan.workspacePath)) {
    let currentBranch: string;
    try {
      currentBranch = await git([
        "-C",
        plan.workspacePath,
        "rev-parse",
        "--abbrev-ref",
        "HEAD"
      ]);
    } catch (error) {
      throw new WorkspacePreparationError(
        "workspace_conflict",
        `workspace path ${plan.workspacePath} exists but is not a reusable Git worktree for ${plan.branchName}`,
        error
      );
    }

    if (currentBranch === plan.branchName) {
      if (!(await isWorktreeRoot(plan.workspacePath))) {
        throw new WorkspacePreparationError(
          "workspace_conflict",
          `workspace path ${plan.workspacePath} is checked out on ${plan.branchName} but is not the Git worktree root`
        );
      }

      if (!(await isWorktreeForCache(plan.workspacePath, plan.cachePath))) {
        throw new WorkspacePreparationError(
          "workspace_conflict",
          `workspace path ${plan.workspacePath} is checked out on ${plan.branchName} but is not linked to cache ${plan.cachePath}`
        );
      }

      return {
        ...plan,
        reused: true
      };
    }

    throw new WorkspacePreparationError(
      "workspace_conflict",
      `workspace path ${plan.workspacePath} is already checked out on ${currentBranch}, expected ${plan.branchName}`
    );
  }

  const conflictingWorktreePath = await worktreePathForBranch(
    plan.cachePath,
    plan.branchName
  );
  if (conflictingWorktreePath !== undefined) {
    throw new WorkspacePreparationError(
      "branch_conflict",
      `issue branch ${plan.branchName} is already checked out at ${conflictingWorktreePath}`
    );
  }

  await mkdir(path.dirname(plan.workspacePath), { recursive: true });
  await git([
    "-C",
    plan.cachePath,
    "worktree",
    "add",
    plan.workspacePath,
    plan.branchName
  ]);

  return {
    ...plan,
    reused: false
  };
}

async function isWorktreeRoot(workspacePath: string): Promise<boolean> {
  const topLevel = await git([
    "-C",
    workspacePath,
    "rev-parse",
    "--show-toplevel"
  ]);
  const [actualTopLevel, expectedTopLevel] = await Promise.all([
    realpath(topLevel),
    realpath(workspacePath)
  ]);

  return actualTopLevel === expectedTopLevel;
}

async function isWorktreeForCache(
  workspacePath: string,
  cachePath: string
): Promise<boolean> {
  const commonDirectory = await git([
    "-C",
    workspacePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir"
  ]);
  const [actualCommonDirectory, expectedCommonDirectory] = await Promise.all([
    realpath(commonDirectory),
    realpath(cachePath)
  ]);

  return actualCommonDirectory === expectedCommonDirectory;
}

async function worktreePathForBranch(
  cachePath: string,
  branchName: string
): Promise<string | undefined> {
  const output = await git([
    "-C",
    cachePath,
    "worktree",
    "list",
    "--porcelain"
  ]);
  let currentWorktreePath: string | undefined;
  const expectedBranchLine = `branch refs/heads/${branchName}`;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentWorktreePath = line.slice("worktree ".length);
      continue;
    }

    if (line === expectedBranchLine) {
      return currentWorktreePath;
    }
  }

  return undefined;
}

// Per-cache-path serialization for ensureRepositoryCache. `git fetch` on the
// same bare repo is not safe under concurrent invocations — git tries to
// create the same packed-refs.lock and one of the two fetches fails. Once a
// project sets max_in_flight > 1, two prepareIssueWorkspace calls hit the
// same cachePath, so we serialize them per-cache-path here. Per-issue
// worktree creation (the rest of prepareIssueWorkspace) remains concurrent.
// See ADR 0053.
const fetchLocks = new Map<string, Promise<unknown>>();

export async function ensureRepositoryCache(
  project: WorkspaceProject,
  cachePath: string
): Promise<void> {
  const prior = fetchLocks.get(cachePath) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(async () => {
      if (!(await exists(cachePath))) {
        await mkdir(path.dirname(cachePath), { recursive: true });
        await git(["clone", "--bare", project.workspace.git.remote, cachePath]);
      } else {
        await ensureRepositoryCacheRemote(project, cachePath);
      }
      await git([
        "-C",
        cachePath,
        "fetch",
        "origin",
        `${project.workspace.git.base_branch}:refs/remotes/origin/${project.workspace.git.base_branch}`
      ]);
    });
  fetchLocks.set(cachePath, next);
  try {
    await next;
  } finally {
    // Only clear the slot if no later caller has overwritten it.
    if (fetchLocks.get(cachePath) === next) {
      fetchLocks.delete(cachePath);
    }
  }
}

async function ensureRepositoryCacheRemote(
  project: WorkspaceProject,
  cachePath: string
): Promise<void> {
  let originUrl: string;
  try {
    originUrl = await git([
      "-C",
      cachePath,
      "config",
      "--get",
      "remote.origin.url"
    ]);
  } catch (error) {
    throw new WorkspacePreparationError(
      "cache_conflict",
      `repository cache ${cachePath} is not a reusable Git repository with origin ${project.workspace.git.remote}`,
      error
    );
  }

  if (originUrl !== project.workspace.git.remote) {
    throw new WorkspacePreparationError(
      "cache_conflict",
      `repository cache ${cachePath} has origin ${originUrl}, expected ${project.workspace.git.remote}`
    );
  }
}

async function ensureIssueBranch(
  project: WorkspaceProject,
  cachePath: string,
  branchName: string
): Promise<void> {
  if (
    await gitSucceeds([
      "-C",
      cachePath,
      "show-ref",
      "--verify",
      `refs/heads/${branchName}`
    ])
  ) {
    return;
  }

  await git([
    "-C",
    cachePath,
    "branch",
    branchName,
    `origin/${project.workspace.git.base_branch}`
  ]);
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
