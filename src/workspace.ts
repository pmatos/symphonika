import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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

export type PreparedIssueWorkspace = {
  branchName: string;
  branchRef: string;
  cachePath: string;
  issueDirectoryName: string;
  reused: boolean;
  workspacePath: string;
};

export type WorkspacePreparationErrorCode =
  | "branch_conflict"
  | "cache_conflict"
  | "workspace_conflict";

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
  const prepared = issueWorkspacePaths(input);

  await ensureRepositoryCache(input.project, prepared.cachePath);
  await ensureIssueBranch(input.project, prepared.cachePath, prepared.branchName);
  if (await exists(prepared.workspacePath)) {
    let currentBranch: string;
    try {
      currentBranch = await git([
        "-C",
        prepared.workspacePath,
        "rev-parse",
        "--abbrev-ref",
        "HEAD"
      ]);
    } catch (error) {
      throw new WorkspacePreparationError(
        "workspace_conflict",
        `workspace path ${prepared.workspacePath} exists but is not a reusable Git worktree for ${prepared.branchName}`,
        error
      );
    }

    if (currentBranch === prepared.branchName) {
      if (!(await isWorktreeForCache(prepared.workspacePath, prepared.cachePath))) {
        throw new WorkspacePreparationError(
          "workspace_conflict",
          `workspace path ${prepared.workspacePath} is checked out on ${prepared.branchName} but is not linked to cache ${prepared.cachePath}`
        );
      }

      return {
        ...prepared,
        reused: true
      };
    }

    throw new WorkspacePreparationError(
      "workspace_conflict",
      `workspace path ${prepared.workspacePath} is already checked out on ${currentBranch}, expected ${prepared.branchName}`
    );
  }

  const conflictingWorktreePath = await worktreePathForBranch(
    prepared.cachePath,
    prepared.branchName
  );
  if (conflictingWorktreePath !== undefined) {
    throw new WorkspacePreparationError(
      "branch_conflict",
      `issue branch ${prepared.branchName} is already checked out at ${conflictingWorktreePath}`
    );
  }

  await mkdir(path.dirname(prepared.workspacePath), { recursive: true });
  await git([
    "-C",
    prepared.cachePath,
    "worktree",
    "add",
    prepared.workspacePath,
    prepared.branchName
  ]);

  return prepared;
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
  const output = await git(["-C", cachePath, "worktree", "list", "--porcelain"]);
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

function issueWorkspacePaths(
  input: PrepareIssueWorkspaceInput
): PreparedIssueWorkspace {
  const projectSlug = slugify(input.project.name, "project");
  const issueSlug = slugify(input.issue.title, "issue");
  const issueDirectoryName = `${input.issue.number}-${issueSlug}`;
  const workspaceRoot = path.resolve(
    input.configDir ?? process.cwd(),
    input.project.workspace.root
  );
  const branchName = `sym/${projectSlug}/${issueDirectoryName}`;

  return {
    branchName,
    branchRef: `refs/heads/${branchName}`,
    cachePath: path.join(workspaceRoot, ".cache", "repo.git"),
    issueDirectoryName,
    reused: false,
    workspacePath: path.join(workspaceRoot, "issues", issueDirectoryName)
  };
}

async function ensureRepositoryCache(
  project: WorkspaceProject,
  cachePath: string
): Promise<void> {
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
}

async function ensureRepositoryCacheRemote(
  project: WorkspaceProject,
  cachePath: string
): Promise<void> {
  let originUrl: string;
  try {
    originUrl = await git(["-C", cachePath, "config", "--get", "remote.origin.url"]);
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
  if (await gitSucceeds(["-C", cachePath, "show-ref", "--verify", `refs/heads/${branchName}`])) {
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

function slugify(input: string, fallback: string): string {
  const asciiInput = Array.from(input.normalize("NFKD"))
    .filter((character) => character.charCodeAt(0) <= 0x7f)
    .join("");
  const slug = asciiInput
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length === 0 ? fallback : slug;
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
