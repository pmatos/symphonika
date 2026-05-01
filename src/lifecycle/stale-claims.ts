import type { Logger } from "pino";

import type {
  GitHubIssuesApi,
  IssuePollStatus,
  PollingProjectConfig
} from "../issue-polling.js";
import type { RunStore } from "../run-store.js";

import type { ActiveRunRegistry } from "./active-runs.js";
import { resolveToken } from "./token.js";

export type DetectStaleClaimsInput = {
  activeRuns: ActiveRunRegistry;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger: Logger;
  pollStatus: IssuePollStatus;
  projects: Map<string, PollingProjectConfig>;
  runStore: RunStore;
};

export type StaleClaimMark = {
  issueNumber: number;
  project: string;
};

const STALE_LABEL = "sym:stale";
const CLAIM_LABELS = ["sym:claimed", "sym:running"] as const;

export async function detectStaleClaims(
  input: DetectStaleClaimsInput
): Promise<StaleClaimMark[]> {
  const marks: StaleClaimMark[] = [];
  const liveKeys = collectLiveKeys(input);

  for (const filtered of input.pollStatus.filteredIssues) {
    const project = input.projects.get(filtered.project);
    if (project === undefined) {
      continue;
    }
    const issue = filtered.issue;
    if (issue.state !== "open") {
      continue;
    }
    if (!hasAnyLabel(issue.labels, CLAIM_LABELS)) {
      continue;
    }
    if (issue.labels.includes(STALE_LABEL)) {
      continue;
    }
    if (liveKeys.has(issueKey(filtered.project, issue.number))) {
      continue;
    }

    const token = resolveToken(project.tracker.token, input.env);
    if (token === undefined) {
      input.logger.warn(
        { project: filtered.project, issueNumber: issue.number },
        "symphonika stale-claim detection skipped: token unavailable"
      );
      continue;
    }

    const addLabelsToIssue = input.githubIssuesApi.addLabelsToIssue;
    if (addLabelsToIssue === undefined) {
      input.logger.warn(
        { project: filtered.project, issueNumber: issue.number },
        "symphonika stale-claim detection skipped: addLabelsToIssue not available"
      );
      continue;
    }

    try {
      await addLabelsToIssue({
        issueNumber: issue.number,
        labels: [STALE_LABEL],
        owner: project.tracker.owner,
        repo: project.tracker.repo,
        token
      });
      marks.push({
        issueNumber: issue.number,
        project: filtered.project
      });
    } catch (error) {
      input.logger.warn(
        { err: error, project: filtered.project, issueNumber: issue.number },
        "symphonika stale-claim detection failed for issue"
      );
    }
  }

  return marks;
}

function collectLiveKeys(input: DetectStaleClaimsInput): Set<string> {
  const keys = new Set<string>();
  for (const entry of input.activeRuns.list()) {
    keys.add(issueKey(entry.projectName, entry.issueNumber));
  }
  for (const entry of input.activeRuns.scheduledIssueKeys()) {
    keys.add(issueKey(entry.projectName, entry.issueNumber));
  }
  for (const entry of input.runStore.listActiveRunIds()) {
    keys.add(issueKey(entry.projectName, entry.issueNumber));
  }
  return keys;
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}

function hasAnyLabel(labels: string[], targets: ReadonlyArray<string>): boolean {
  for (const target of targets) {
    if (labels.includes(target)) {
      return true;
    }
  }
  return false;
}

