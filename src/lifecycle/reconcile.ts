import type { Logger } from "pino";

import {
  evaluateProjectEligibility,
  type GitHubIssuesApi,
  type IssuePollStatus,
  type IssueSnapshot,
  type PollingProjectConfig,
  type RawGitHubIssue
} from "../issue-polling.js";
import type { RunStore } from "../run-store.js";

import { ActiveRunRegistry, CANCEL_REASONS } from "./active-runs.js";

export type ReconcileInput = {
  activeRuns: ActiveRunRegistry;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger: Logger;
  pollStatus: IssuePollStatus;
  projects: Map<string, PollingProjectConfig>;
  runStore: RunStore;
};

export async function reconcileActiveRuns(input: ReconcileInput): Promise<void> {
  for (const entry of input.activeRuns.list()) {
    if (entry.cancelRequested) {
      continue;
    }
    const project = input.projects.get(entry.projectName);
    if (project === undefined) {
      continue;
    }

    const snapshot = findIssueSnapshot(input.pollStatus, entry.projectName, entry.issueNumber);
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

    const eligibility = evaluateProjectEligibility(snapshot, project, {
      ignoreOperationalLabels: true
    });
    if (!eligibility.eligible) {
      await markCancelled(input, entry.runId, CANCEL_REASONS.ELIGIBILITY_LOSS);
    }
  }
}

async function handleMissingFromPoll(input: ReconcileInput & {
  entry: ReturnType<ActiveRunRegistry["list"]>[number];
  project: PollingProjectConfig;
}): Promise<void> {
  const token = resolveToken(input.project.tracker.token, input.env);
  if (token === undefined) {
    input.logger.warn(
      { project: input.project.name, runId: input.entry.runId },
      "symphonika reconcile skipped: github token not available"
    );
    return;
  }

  const fetcher = input.githubIssuesApi.getIssue;
  if (fetcher === undefined) {
    input.logger.warn(
      { runId: input.entry.runId },
      "symphonika reconcile skipped: githubIssuesApi.getIssue not available"
    );
    return;
  }

  let raw: RawGitHubIssue | null;
  try {
    raw = await fetcher({
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
    if (candidate.project === projectName && candidate.issue.number === issueNumber) {
      return candidate.issue;
    }
  }
  for (const filtered of pollStatus.filteredIssues) {
    if (filtered.project === projectName && filtered.issue.number === issueNumber) {
      return filtered.issue;
    }
  }
  return undefined;
}

function resolveToken(reference: string, env: NodeJS.ProcessEnv): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
  if (match === null) {
    return undefined;
  }
  const value = env[match[1] ?? ""];
  return value === undefined || value.length === 0 ? undefined : value;
}
