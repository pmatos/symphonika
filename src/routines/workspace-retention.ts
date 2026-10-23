import { reclaimRoutineWorkspace } from "../workspace-reclamation.js";
import type { RoutineFiringStatus, RunStore } from "../run-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Well under the ~100,000,000-day ECMAScript Date range on either side of
// `now`, so `cutoff` never produces an invalid Date/RangeError regardless of
// `now`'s value, while still comfortably exceeding any real retention need.
export const MAX_ROUTINE_WORKSPACE_RETENTION_DAYS = 36_500;

export type RoutineWorkspaceRetentionPolicy = {
  cancelledDays: number;
  enabled: boolean;
  failedDays: number;
  succeededDays: number;
};

export const DEFAULT_ROUTINE_WORKSPACE_RETENTION: RoutineWorkspaceRetentionPolicy =
  {
    cancelledDays: 14,
    enabled: true,
    failedDays: 14,
    succeededDays: 1
  };

type RoutineWorkspacePruneEntry = {
  firingId: string;
  workspacePath: string;
};

type RoutineWorkspacePruneFailure = RoutineWorkspacePruneEntry & {
  error: string;
};

export type RoutineWorkspacePruneReport = {
  candidates: RoutineWorkspacePruneEntry[];
  failures: RoutineWorkspacePruneFailure[];
  pruned: RoutineWorkspacePruneEntry[];
};

export async function pruneRoutineWorkspaces(input: {
  dryRun?: boolean;
  now?: Date;
  policy: RoutineWorkspaceRetentionPolicy;
  runStore: RunStore;
}): Promise<RoutineWorkspacePruneReport> {
  const now = input.now ?? new Date();
  const firings = input.runStore.listRoutineWorkspacePruneCandidates({
    cancelledBefore: cutoff(now, input.policy.cancelledDays),
    failedBefore: cutoff(now, input.policy.failedDays),
    succeededBefore: cutoff(now, input.policy.succeededDays)
  });
  const candidates = firings.map(pruneEntry);
  const report: RoutineWorkspacePruneReport = {
    candidates,
    failures: [],
    pruned: []
  };
  if (input.dryRun === true) {
    return report;
  }

  for (const firing of firings) {
    const entry = pruneEntry(firing);
    try {
      await reclaimRoutineWorkspace(firing);
      // A concurrent prune (daemon vs. manual `prune-workspaces`, or vice
      // versa) may have already reclaimed and marked this firing, so
      // markRoutineWorkspacePruned's write can no-op (row already has
      // workspace_pruned_at set). Either way the workspace ends up
      // reclaimed once reclaimRoutineWorkspace returns without throwing,
      // so report it as pruned regardless of which process's write won.
      input.runStore.markRoutineWorkspacePruned({
        id: firing.id,
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

function pruneEntry(firing: RoutineFiringStatus): RoutineWorkspacePruneEntry {
  return {
    firingId: firing.id,
    workspacePath: firing.workspacePath
  };
}
