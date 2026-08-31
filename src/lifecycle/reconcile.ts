import type { Logger } from "pino";

import {
  findPolledIssueSnapshot,
  sameIssueRepository,
  tryGetIssue,
  type GitHubIssuesApi,
  type IssuePollStatus
} from "../issue-polling.js";
import type { RunStore } from "../run-store.js";

import { ActiveRunRegistry, CANCEL_REASONS } from "./active-runs.js";
import { evaluateRunContinuationEligibility } from "./issue-eligibility.js";
import type {
  DispatchProjectConfig,
  RunController,
  RunControllerProjectConfig
} from "./run-controller.js";
import { isDispatchProject } from "./run-controller.js";
import { resolveToken } from "./token.js";

export type ReconcileInput = {
  activeRuns: ActiveRunRegistry;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger: Logger;
  pollStatus: IssuePollStatus;
  projects: Map<string, RunControllerProjectConfig>;
  runStore: RunStore;
};

export async function reconcileActiveRuns(
  input: ReconcileInput
): Promise<void> {
  const cancellations: Promise<void>[] = [];
  for (const entry of input.activeRuns.list()) {
    if (entry.cancelRequested) {
      continue;
    }
    const project = input.projects.get(entry.projectName);
    if (project === undefined || !isDispatchProject(project)) {
      continue;
    }
    if (input.runStore.getRun(entry.runId) === undefined) {
      // Not an issue-driven Run. Routine Firings share this registry (and a
      // synthetic issue number) purely for per-project concurrency-slot
      // bookkeeping -- see reserveSlot in routines/dispatcher.ts -- and have
      // no GitHub issue to reconcile against; the routine dispatcher
      // supervises their cancellation instead. Without this check, a
      // Routine Firing on a project that is also a Dispatch Project has its
      // synthetic issue number looked up on GitHub, resolves to "not
      // found", and is incorrectly cancelled with CLOSED_ISSUE.
      continue;
    }

    // Refuse to reconcile across a repository boundary. A retargeted tracker
    // makes the poll lookup below miss (it keys on the tracker's repository),
    // which sends handleMissingFromPoll's getIssue to the *new* repository:
    // a same-numbered Issue that is closed or absent there then cancels this
    // Run with CLOSED_ISSUE on evidence from an Issue it never touched.
    // Deferring costs nothing — the Project's tracker is either restored or
    // the Run reaches its own terminal state. An undetermined origin (legacy
    // row, non-GitHub URL) proves no mismatch and is reconciled as before.
    // See docs/adr/0089.
    const origin = input.runStore.getRunIssueRepository(entry.runId);
    if (origin !== undefined && !sameIssueRepository(origin, project.tracker)) {
      input.logger.warn(
        {
          issueNumber: entry.issueNumber,
          origin: `${origin.owner}/${origin.repo}`,
          project: entry.projectName,
          runId: entry.runId,
          tracker: `${project.tracker.owner}/${project.tracker.repo}`
        },
        "symphonika reconcile skipped: project tracker no longer points at the run's repository"
      );
      continue;
    }

    const snapshot = findPolledIssueSnapshot(
      input.pollStatus,
      entry.projectName,
      project.tracker,
      entry.issueNumber
    );
    if (snapshot === undefined) {
      const result = await handleMissingFromPoll({
        ...input,
        entry,
        project
      });
      if (result.cancellation !== undefined) {
        cancellations.push(result.cancellation);
      }
      continue;
    }

    if (snapshot.state !== "open") {
      cancellations.push(
        markCancelled(input, entry.runId, CANCEL_REASONS.CLOSED_ISSUE)
      );
      continue;
    }

    // CLOSED_ISSUE above still wins for every scope; see
    // evaluateRunContinuationEligibility for the fsm_owned vs
    // label_controlled policy.
    const eligibility = evaluateRunContinuationEligibility(snapshot, project, {
      scope: entry.respectsIssueLabels ? "label_controlled" : "fsm_owned"
    });
    if (!eligibility.eligible) {
      cancellations.push(
        markCancelled(input, entry.runId, CANCEL_REASONS.ELIGIBILITY_LOSS)
      );
    }
  }
  await Promise.all(cancellations);
}

async function handleMissingFromPoll(
  input: ReconcileInput & {
    entry: ReturnType<ActiveRunRegistry["list"]>[number];
    project: DispatchProjectConfig;
  }
): Promise<{ cancellation?: Promise<void> }> {
  const token = resolveToken(input.project.tracker.token, input.env);
  if (token === undefined) {
    input.logger.warn(
      { project: input.project.name, runId: input.entry.runId },
      "symphonika reconcile skipped: github token not available"
    );
    return {};
  }

  let raw;
  try {
    raw = await tryGetIssue(input.githubIssuesApi, {
      issueNumber: input.entry.issueNumber,
      owner: input.project.tracker.owner,
      repo: input.project.tracker.repo,
      token
    });
  } catch (error) {
    input.logger.warn(
      { err: error, runId: input.entry.runId },
      "symphonika reconcile getIssue failed"
    );
    return {};
  }

  if (raw === undefined) {
    input.logger.warn(
      { runId: input.entry.runId },
      "symphonika reconcile skipped: githubIssuesApi.getIssue not available"
    );
    return {};
  }

  if (raw === null || raw.state === "closed") {
    return {
      cancellation: markCancelled(
        input,
        input.entry.runId,
        CANCEL_REASONS.CLOSED_ISSUE
      )
    };
  }
  return {};
}

function markCancelled(
  input: ReconcileInput,
  runId: string,
  reason: (typeof CANCEL_REASONS)[keyof typeof CANCEL_REASONS]
): Promise<void> {
  input.runStore.markCancelRequested(runId, reason);
  return input.activeRuns.requestCancel(runId, reason);
}

export async function reconcileWaitingRuns(input: {
  logger?: Logger;
  runController: RunController;
  runStore: RunStore;
}): Promise<void> {
  const waiting = input.runStore.listWaitingRuns();
  for (const row of waiting) {
    try {
      await input.runController.reEvaluateWaitingRun(row.runId);
    } catch (error) {
      input.logger?.warn(
        { err: error, runId: row.runId },
        "symphonika wait re-eval failed"
      );
    }
  }
}
