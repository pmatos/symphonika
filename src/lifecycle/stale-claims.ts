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
    if (liveKeys.covers(filtered.project, filtered.repository, issue.number)) {
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
      // Label the repository the Issue was *polled from*, not the one the
      // name-keyed config resolves to. Duplicate Project declarations sharing
      // a name are not rejected at load — `projectsByName` keeps the last
      // match while the poll loop records an entry per declaration — so the
      // filtered band can hold two same-numbered Issues under one name, and
      // `project.tracker` would send the shadowed one's verdict to the
      // surviving declaration's repository. The token still comes from the
      // resolved config, which is the only place one is configured; a token
      // that cannot reach the polled repository fails the write and is
      // logged, rather than marking the wrong Issue. See docs/adr/0089.
      const called = await tryAddLabelsToIssue(input.githubIssuesApi, {
        issueNumber: issue.number,
        labels: [STALE_LABEL],
        owner: filtered.repository.owner,
        repo: filtered.repository.repo,
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

// Liveness is keyed by `(Project, repository, Issue)`, so a Run holding
// `A#42` cannot vouch for `B#42` after the Project is retargeted. Sources
// that cannot name their repository fall back to a `(Project, Issue)`
// wildcard that vouches for the number in any repository: over-covering
// leaves an Issue unmarked, while under-covering would mark a live Issue
// `sym:stale` — the permanent strand of #594 — so "unknown" has to read as
// "live", exactly as it does at the resume pass's origin gate. See
// docs/adr/0089.
class LiveIssueKeys {
  private readonly qualified = new Set<string>();
  private readonly wildcard = new Set<string>();

  add(
    projectName: string,
    repository: { owner: string; repo: string } | undefined,
    issueNumber: number
  ): void {
    if (repository === undefined) {
      this.wildcard.add(issueKey(projectName, issueNumber));
      return;
    }
    this.qualified.add(
      repositoryIssueKey(projectName, repository, issueNumber)
    );
  }

  covers(
    projectName: string,
    repository: { owner: string; repo: string },
    issueNumber: number
  ): boolean {
    return (
      this.wildcard.has(issueKey(projectName, issueNumber)) ||
      this.qualified.has(
        repositoryIssueKey(projectName, repository, issueNumber)
      )
    );
  }
}

function collectLiveKeys(input: DetectStaleClaimsInput): LiveIssueKeys {
  const keys = new LiveIssueKeys();
  // In-memory reservations (live Runs and scheduled work) carry no
  // repository: the registry is keyed by Project name and Issue number
  // alone, and Routine Firings share it with synthetic numbers. They are
  // wildcards by necessity.
  for (const entry of input.activeRuns.issueKeys()) {
    keys.add(entry.projectName, undefined, entry.issueNumber);
  }
  for (const entry of input.runStore.listActiveRunIds()) {
    keys.add(entry.projectName, entry.issueRepository, entry.issueNumber);
  }
  // Parked wait rows keep their `sym:claimed` label across the wait but have
  // no entry in `activeRuns` and no row in `listActiveRunIds`. Without this
  // pass, a long wait between `wait_park` re-evaluations would be marked
  // `sym:stale`. See ADR 0047.
  for (const entry of input.runStore.listWaitingRunIds()) {
    keys.add(entry.projectName, entry.issueRepository, entry.issueNumber);
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
    keys.add(entry.projectName, entry.issueRepository, entry.issueNumber);
  }
  return keys;
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}

// GitHub owners and repository names are case-insensitive, so the key folds
// case rather than letting a differently-cased tracker miss its own Run.
function repositoryIssueKey(
  projectName: string,
  repository: { owner: string; repo: string },
  issueNumber: number
): string {
  return `${projectName}#${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}#${issueNumber}`;
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
