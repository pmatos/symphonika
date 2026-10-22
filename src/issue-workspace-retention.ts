import { reclaimIssueWorkspace } from "./workspace-reclamation.js";
import type { IssueWorkspacePruneCandidate, RunStore } from "./run-store.js";

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
      await reclaimIssueWorkspace(run);
      // A concurrent prune (daemon vs. manual `prune-workspaces`, or vice
      // versa) may have already reclaimed and marked this run, so
      // markIssueWorkspacePruned's write can no-op (row already has
      // workspace_pruned_at set). Either way the workspace ends up reclaimed
      // once reclaimIssueWorkspace returns without throwing, so report it
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
