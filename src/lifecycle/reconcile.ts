import type { Logger } from "pino";

import {
  evaluateProjectEligibility,
  tryGetIssue,
  type GitHubIssuesApi,
  type IssuePollStatus,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../issue-polling.js";
import type { RunStore } from "../run-store.js";

import { ActiveRunRegistry, CANCEL_REASONS } from "./active-runs.js";
import type { RunController } from "./run-controller.js";
import { resolveToken } from "./token.js";

export type ReconcileInput = {
  activeRuns: ActiveRunRegistry;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger: Logger;
  pollStatus: IssuePollStatus;
  projects: Map<string, PollingProjectConfig>;
  runStore: RunStore;
};

export async function reconcileActiveRuns(
  input: ReconcileInput
): Promise<void> {
  for (const entry of input.activeRuns.list()) {
    if (entry.cancelRequested) {
      continue;
    }
    const project = input.projects.get(entry.projectName);
    if (project === undefined) {
      continue;
    }

    const snapshot = findIssueSnapshot(
      input.pollStatus,
      entry.projectName,
      entry.issueNumber
    );
    if (snapshot === undefined) {
      await handleMissingFromPoll({
        ...input,
        entry,
        project
      });
      continue;
    }

    if (snapshot.state !== "open") {
      await markCancelled(input, entry.runId, CANCEL_REASONS.CLOSED_ISSUE);
      continue;
    }

    // State-advance runs (raw FSM walks) intentionally do not re-evaluate
    // labels_all / labels_none — the state machine owns transitions while the
    // walk is in flight. CLOSED_ISSUE above is still honored. See ADR 0046.
    if (!entry.respectsIssueLabels) {
      continue;
    }

    const eligibility = evaluateProjectEligibility(snapshot, project, {
      ignoreOperationalLabels: true
    });
    if (!eligibility.eligible) {
      await markCancelled(input, entry.runId, CANCEL_REASONS.ELIGIBILITY_LOSS);
    }
  }
}

async function handleMissingFromPoll(
  input: ReconcileInput & {
    entry: ReturnType<ActiveRunRegistry["list"]>[number];
    project: PollingProjectConfig;
  }
): Promise<void> {
  const token = resolveToken(input.project.tracker.token, input.env);
  if (token === undefined) {
    input.logger.warn(
      { project: input.project.name, runId: input.entry.runId },
      "symphonika reconcile skipped: github token not available"
    );
    return;
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
    return;
  }

  if (raw === undefined) {
    input.logger.warn(
      { runId: input.entry.runId },
      "symphonika reconcile skipped: githubIssuesApi.getIssue not available"
    );
    return;
  }

  if (raw === null || raw.state === "closed") {
    await markCancelled(input, input.entry.runId, CANCEL_REASONS.CLOSED_ISSUE);
  }
}

async function markCancelled(
  input: ReconcileInput,
  runId: string,
  reason: (typeof CANCEL_REASONS)[keyof typeof CANCEL_REASONS]
): Promise<void> {
  input.runStore.markCancelRequested(runId, reason);
  await input.activeRuns.requestCancel(runId, reason);
}

function findIssueSnapshot(
  pollStatus: IssuePollStatus,
  projectName: string,
  issueNumber: number
): IssueSnapshot | undefined {
  for (const candidate of pollStatus.candidateIssues) {
    if (
      candidate.project === projectName &&
      candidate.issue.number === issueNumber
    ) {
      return candidate.issue;
    }
  }
  for (const filtered of pollStatus.filteredIssues) {
    if (
      filtered.project === projectName &&
      filtered.issue.number === issueNumber
    ) {
      return filtered.issue;
    }
  }
  return undefined;
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
