import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The awkward-states list from #306's issue text, made concrete: a file's
// staged/unstaged status independent of the rest of the working tree
// (dirty alone can't distinguish "this file is clean but something else
// isn't" from "this file itself has uncommitted changes").
type GitFileStatus =
  | "clean"
  | "modified_staged"
  | "modified_staged_and_unstaged"
  | "modified_unstaged"
  | "untracked";

export type GitFileState =
  | { inRepo: false }
  | {
      // null when HEAD is detached -- see detachedHeadSha instead.
      branch: string | null;
      detachedHeadSha: string | null;
      // Whole-working-tree dirty state, shown alongside fileStatus (which
      // is specific to the file under edit) -- see ADR
      // 0075-mutation-authentication-and-superseding-0027.md.
      dirty: boolean;
      fileStatus: GitFileStatus;
      gitignored: boolean;
      inRepo: true;
      midRebase: boolean;
      repoRoot: string;
    };

// Detects whether filePath sits inside a git repo and, if so, every piece
// of state #306 requires be shown before a save: repo root, branch (or
// detached-HEAD SHA), whole-tree dirty state, this specific file's own
// staged/unstaged status, mid-rebase, and gitignored. Never mutates
// anything -- pure detection, safe to call on every editor page render.
export async function detectGitFileState(
  filePath: string
): Promise<GitFileState> {
  const dir = path.dirname(filePath);
  const repoRoot = await tryGit(["-C", dir, "rev-parse", "--show-toplevel"]);
  if (repoRoot === undefined) {
    return { inRepo: false };
  }

  const [branchRaw, gitDir, statusOutput, gitignored] = await Promise.all([
    tryGit(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]),
    tryGit(["-C", repoRoot, "rev-parse", "--git-dir"]),
    // Untrimmed: porcelain v1's index-status column is a leading space for
    // "no staged change," which String.trim() would otherwise eat,
    // silently turning "modified, unstaged only" into "modified, staged."
    tryGitRawOutput([
      "-C",
      repoRoot,
      "status",
      "--porcelain=v1",
      "--",
      path.relative(repoRoot, filePath)
    ]),
    gitSucceeds([
      "-C",
      repoRoot,
      "check-ignore",
      "--quiet",
      path.relative(repoRoot, filePath)
    ])
  ]);

  const detached = branchRaw === "HEAD";
  const detachedHeadSha = detached
    ? ((await tryGit(["-C", repoRoot, "rev-parse", "HEAD"])) ?? null)
    : null;
  const absoluteGitDir =
    gitDir === undefined
      ? path.join(repoRoot, ".git")
      : path.resolve(repoRoot, gitDir);
  const midRebase =
    (await pathExists(path.join(absoluteGitDir, "rebase-merge"))) ||
    (await pathExists(path.join(absoluteGitDir, "rebase-apply")));

  const wholeTreeStatus = await tryGit([
    "-C",
    repoRoot,
    "status",
    "--porcelain=v1"
  ]);

  return {
    branch: detached ? null : (branchRaw ?? null),
    detachedHeadSha,
    dirty: (wholeTreeStatus ?? "").length > 0,
    fileStatus: parseFileStatus(statusOutput ?? ""),
    gitignored,
    inRepo: true,
    midRebase,
    repoRoot
  };
}

export type CommitFileResult =
  | { kind: "committed"; sha: string }
  | { kind: "nothing_to_commit" }
  | { kind: "refused"; reason: string };

// Stages and commits exactly filePath, scoped via `commit -- <path>` so a
// separately staged, unrelated file is never swept into this commit.
// Never pushes -- there is no push call anywhere in this module, a
// structural guarantee rather than a policy the caller has to remember.
// See docs/adr/0075-mutation-authentication-and-superseding-0027.md.
export async function commitFile(input: {
  filePath: string;
  message: string;
  repoRoot: string;
}): Promise<CommitFileResult> {
  const state = await detectGitFileState(input.filePath);
  if (!state.inRepo) {
    return { kind: "refused", reason: "not inside a git repository" };
  }
  if (state.midRebase) {
    return {
      kind: "refused",
      reason:
        "repository is mid-rebase; resolve or abort the rebase before committing through the editor"
    };
  }

  const relativePath = path.relative(input.repoRoot, input.filePath);
  await git(["-C", input.repoRoot, "add", "--", relativePath]);
  try {
    await git([
      "-C",
      input.repoRoot,
      "commit",
      "-m",
      input.message,
      "--",
      relativePath
    ]);
  } catch (error) {
    if (isNothingToCommit(error)) {
      return { kind: "nothing_to_commit" };
    }
    throw error;
  }

  const sha = await git(["-C", input.repoRoot, "rev-parse", "HEAD"]);
  return { kind: "committed", sha };
}

function parseFileStatus(statusLine: string): GitFileStatus {
  if (statusLine.length === 0) {
    return "clean";
  }
  const indexStatus = statusLine[0];
  const worktreeStatus = statusLine[1];
  if (indexStatus === "?" && worktreeStatus === "?") {
    return "untracked";
  }
  const staged = indexStatus !== " " && indexStatus !== "?";
  const unstaged = worktreeStatus !== " " && worktreeStatus !== "?";
  if (staged && unstaged) {
    return "modified_staged_and_unstaged";
  }
  if (staged) {
    return "modified_staged";
  }
  if (unstaged) {
    return "modified_unstaged";
  }
  return "clean";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function isNothingToCommit(error: unknown): boolean {
  const output = errorOutput(error);
  return (
    output.includes("nothing to commit") ||
    output.includes("nothing added to commit")
  );
}

function errorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const stdout = "stdout" in error ? String(error.stdout) : "";
  const stderr = "stderr" in error ? String(error.stderr) : "";
  return `${stdout}\n${stderr}`;
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

async function tryGit(args: string[]): Promise<string | undefined> {
  try {
    return await git(args);
  } catch {
    return undefined;
  }
}

// Only stdout.trim()'s trailing newline stripped -- unlike git(), a
// leading space in the output is preserved. Porcelain v1's index-status
// column is exactly that: a leading space means "no staged change," and
// String.trim() would silently turn it into "staged change" by eating it.
async function tryGitRawOutput(args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args);
    return stdout.replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

async function gitSucceeds(args: string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}
