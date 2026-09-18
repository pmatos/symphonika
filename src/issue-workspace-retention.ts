import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { IssueWorkspacePruneCandidate, RunStore } from "./run-store.js";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

export type IssueWorkspaceRetentionPolicy = {
  enabled: boolean;
  failedDays: number;
  succeededDays: number;
};

export const DEFAULT_ISSUE_WORKSPACE_RETENTION: IssueWorkspaceRetentionPolicy =
  {
    enabled: true,
    failedDays: 3,
    succeededDays: 0
  };

type IssueWorkspacePruneEntry = {
  runId: string;
  workspacePath: string;
};

type IssueWorkspacePruneFailure = IssueWorkspacePruneEntry & {
  error: string;
};

export type IssueWorkspacePruneReport = {
  candidates: IssueWorkspacePruneEntry[];
  failures: IssueWorkspacePruneFailure[];
  pruned: IssueWorkspacePruneEntry[];
};

// The branch ref is deliberately left in place -- unlike a Routine Firing
// branch, an Issue Workspace branch is reused across retries and
// continuations until explicit cleanup (ADR 0040), and Symphonika does not
// yet verify that a succeeded run's commits reached durable remote state
// before reclaiming its worktree. Removing only the worktree keeps that
// branch's history recoverable (a later attempt's `addWorktree` just checks
// it back out) while still reclaiming the checkout, which is where the disk
// usage this feature targets actually lives.
export async function pruneIssueWorkspaces(input: {
  dryRun?: boolean;
  now?: Date;
  policy: IssueWorkspaceRetentionPolicy;
  runStore: RunStore;
}): Promise<IssueWorkspacePruneReport> {
  const now = input.now ?? new Date();
  const runs = input.runStore.listIssueWorkspacePruneCandidates({
    failedBefore: cutoff(now, input.policy.failedDays),
    succeededBefore: cutoff(now, input.policy.succeededDays)
  });
  const candidates = runs.map(pruneEntry);
  const report: IssueWorkspacePruneReport = {
    candidates,
    failures: [],
    pruned: []
  };
  if (input.dryRun === true) {
    return report;
  }

  for (const run of runs) {
    const entry = pruneEntry(run);
    try {
      await reclaimRegisteredWorktree(run);
      // A concurrent prune (daemon vs. manual `prune-workspaces`, or vice
      // versa) may have already reclaimed and marked this run, so
      // markIssueWorkspacePruned's write can no-op (row already has
      // workspace_pruned_at set). Either way the workspace ends up reclaimed
      // once reclaimRegisteredWorktree returns without throwing, so report it
      // as pruned regardless of which process's write won.
      input.runStore.markIssueWorkspacePruned({
        id: run.runId,
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
  candidate: IssueWorkspacePruneCandidate
): Promise<void> {
  const { cachePath, workspacePath } = issueWorkspacePlan(
    candidate.workspacePath
  );
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
    if (workspaceExists) {
      throw removeError;
    }
    const registered = await listRegisteredWorktreePaths(cachePath);
    if (registered.includes(workspacePath)) {
      throw removeError;
    }
    return;
  }
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

// Mirrors routines/workspace-retention.ts's routineWorkspacePlan, but Issue
// Workspaces have no per-run identity check available: the worktree's leaf
// directory name is derived from the issue number and title (see
// planWorkspacePaths), not the run id, so there is no analogous
// basename-matches-id assertion to make here.
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

async function listRegisteredWorktreePaths(
  cachePath: string
): Promise<string[]> {
  const output = await git([
    "-C",
    cachePath,
    "worktree",
    "list",
    "--porcelain"
  ]);
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      paths.push(path.resolve(line.slice("worktree ".length)));
    }
  }
  return paths;
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

function pruneEntry(
  candidate: IssueWorkspacePruneCandidate
): IssueWorkspacePruneEntry {
  return {
    runId: candidate.runId,
    workspacePath: candidate.workspacePath
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
