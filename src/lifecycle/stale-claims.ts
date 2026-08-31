import type { Logger } from "pino";

import {
  tryAddLabelsToIssue,
  type GitHubIssuesApi,
  type IssuePollStatus
} from "../issue-polling.js";
import type { RunStore } from "../run-store.js";

import type { ActiveRunRegistry } from "./active-runs.js";
import type { RunControllerProjectConfig } from "./run-controller.js";
import { isDispatchProject } from "./run-controller.js";
import { resolveToken } from "./token.js";

export type DetectStaleClaimsInput = {
  activeRuns: ActiveRunRegistry;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger: Logger;
  pollStatus: IssuePollStatus;
  projects: Map<string, RunControllerProjectConfig>;
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
    if (project === undefined || !isDispatchProject(project)) {
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

    try {
      const called = await tryAddLabelsToIssue(input.githubIssuesApi, {
        issueNumber: issue.number,
        labels: [STALE_LABEL],
        owner: project.tracker.owner,
        repo: project.tracker.repo,
        token
      });
      if (!called) {
        input.logger.warn(
          { project: filtered.project, issueNumber: issue.number },
          "symphonika stale-claim detection skipped: addLabelsToIssue not available"
        );
        continue;
      }
      issue.labels.push(STALE_LABEL);
      input.logger.info(
        { issueNumber: issue.number, project: filtered.project },
        "symphonika marked issue sym:stale"
      );
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
  for (const entry of input.activeRuns.issueKeys()) {
    keys.add(issueKey(entry.projectName, entry.issueNumber));
  }
  for (const entry of input.runStore.listActiveRunIds()) {
    keys.add(issueKey(entry.projectName, entry.issueNumber));
  }
  // Parked wait rows keep their `sym:claimed` label across the wait but have
  // no entry in `activeRuns` and no row in `listActiveRunIds`. Without this
  // pass, a long wait between `wait_park` re-evaluations would be marked
  // `sym:stale`. See ADR 0047.
  for (const entry of input.runStore.listWaitingRunIds()) {
    keys.add(issueKey(entry.projectName, entry.issueNumber));
  }
  // A Run a graceful shutdown cancelled is awaiting resumption, not dead: the
  // claim it left on the Issue is the reservation the resume pass reuses.
  // Marking such an Issue `sym:stale` is what stranded it permanently before
  // #594 — every Project's `labels_none` excludes the label, and nothing
  // clears it automatically. The resume pass registers scheduled work (which
  // `activeRuns.issueKeys()` above already covers) but only once it has run;
  // this durable source closes the window before that and across the ticks
  // where the resume has to be deferred. See docs/adr/0088.
  for (const entry of input.runStore.listResumableShutdownRuns()) {
    keys.add(issueKey(entry.projectName, entry.issueNumber));
  }
  return keys;
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}

function hasAnyLabel(
  labels: string[],
  targets: ReadonlyArray<string>
): boolean {
  for (const target of targets) {
    if (labels.includes(target)) {
      return true;
    }
  }
  return false;
}
