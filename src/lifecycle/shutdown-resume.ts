import type { Logger } from "pino";

import {
  findPolledIssueSnapshot,
  tryRemoveLabelsFromIssue,
  type GitHubIssueRepositoryInput,
  type GitHubIssuesApi,
  type IssuePollStatus
} from "../issue-polling.js";
import type { RunStore } from "../run-store.js";

import type { ActiveRunRegistry } from "./active-runs.js";
import type {
  RunController,
  RunControllerProjectConfig
} from "./run-controller.js";
import { isDispatchProject } from "./run-controller.js";
import { resolveToken } from "./token.js";

const CLAIM_LABEL = "sym:claimed";
const STALE_LABEL = "sym:stale";

export type ResumeShutdownCancelledRunsInput = {
  activeRuns: ActiveRunRegistry;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger: Logger;
  pollStatus: IssuePollStatus;
  projects: Map<string, RunControllerProjectConfig>;
  runController: RunController;
  runStore: RunStore;
};

export type ShutdownResumeOutcome = {
  issueNumber: number;
  // `resumed` re-entered the raw-FSM walk at the killed Run's state;
  // `claim_released` handed the Issue back to fresh dispatch because there
  // was no walk to resume.
  kind: "claim_released" | "resumed";
  project: string;
  runId: string;
};

// Recovers the Issues a graceful shutdown cancelled mid-flight. A restart is
// routine — a self-update makes it unattended — so the Issues those Runs held
// must come back into dispatch on their own. Without this pass they keep
// `sym:claimed` with no live Run, stale-claim detection adds `sym:stale`, and
// every Project's `labels_none` then excludes them from polling forever. See
// issue #594 and docs/adr/0088.
//
// Runs from the daemon's reconcile tick, so it also runs at startup and
// retries anything it had to defer (Project reloading, poll not yet
// populated, contention at the claim) on the next tick.
export async function resumeShutdownCancelledRuns(
  input: ResumeShutdownCancelledRunsInput
): Promise<ShutdownResumeOutcome[]> {
  const outcomes: ShutdownResumeOutcome[] = [];

  for (const row of input.runStore.listResumableShutdownRuns()) {
    const project = input.projects.get(row.projectName);
    if (
      project === undefined ||
      project.disabled === true ||
      !isDispatchProject(project)
    ) {
      // Deliberately deferred rather than declined: a Project that is
      // reloading, temporarily disabled, or absent from this snapshot may be
      // back on a later tick, and declining would throw away the walk's
      // position for a condition that is not the Issue's fault.
      continue;
    }

    // The poll snapshot is the only issue-state source this pass reads.
    // `listOpenIssues` fetches every open Issue and filtering happens
    // locally, so an open Issue wearing `sym:claimed` is always present in
    // the filtered band. An absent Issue is therefore closed (nothing to
    // resume, and stale detection skips closed Issues anyway) or the
    // Project's poll failed this tick — both are handled by waiting.
    const issue = findPolledIssueSnapshot(
      input.pollStatus,
      row.projectName,
      row.issueNumber
    );
    if (issue === undefined || issue.state !== "open") {
      continue;
    }

    // Covers both live Runs and scheduled work, so a resume scheduled on an
    // earlier tick is never scheduled twice (ScheduledWorkRegistry throws on
    // a duplicate issue key) and a fresh dispatch that already picked the
    // Issue up is left alone.
    if (input.activeRuns.isIssueReserved(row.projectName, row.issueNumber)) {
      continue;
    }

    const token = resolveToken(project.tracker.token, input.env);
    if (token === undefined) {
      input.logger.warn(
        { issueNumber: row.issueNumber, project: row.projectName },
        "symphonika shutdown resume skipped: token unavailable"
      );
      continue;
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    if (row.currentStateId === null) {
      // Cancelled before the workflow state was persisted (queued, or
      // preparing its Workspace), so there is no state to re-enter. Release
      // the claim instead and let the next poll dispatch the Issue fresh —
      // the same treatment eligibility-loss cancellation gives (SPEC 12.2).
      const released = await releaseIssue({
        ...input,
        issueLabels: issue.labels,
        issueNumber: row.issueNumber,
        projectName: row.projectName,
        repository
      });
      if (!released) {
        continue;
      }
      input.runStore.markShutdownResumeDeclined(row.runId);
      input.logger.info(
        {
          issueNumber: row.issueNumber,
          project: row.projectName,
          runId: row.runId
        },
        "symphonika released claim for shutdown-cancelled run with no workflow state"
      );
      outcomes.push({
        issueNumber: row.issueNumber,
        kind: "claim_released",
        project: row.projectName,
        runId: row.runId
      });
      continue;
    }

    // Scheduled before the `sym:stale` removal below so no await separates
    // the reservation check above from the schedule call.
    input.runController.scheduleShutdownResume({
      issue,
      parentRunId: row.runId,
      projectName: row.projectName,
      toStateId: row.currentStateId
    });
    input.logger.info(
      {
        issueNumber: row.issueNumber,
        project: row.projectName,
        runId: row.runId,
        stateId: row.currentStateId
      },
      "symphonika resuming shutdown-cancelled run"
    );
    outcomes.push({
      issueNumber: row.issueNumber,
      kind: "resumed",
      project: row.projectName,
      runId: row.runId
    });

    // A boot that predated this pass may already have let stale detection
    // mark the Issue. The claim is live again, so the verdict is now false
    // and would otherwise keep the Issue out of polling after the walk ends.
    if (issue.labels.includes(STALE_LABEL)) {
      await removeLabels({
        ...input,
        issueNumber: row.issueNumber,
        labels: [STALE_LABEL],
        projectName: row.projectName,
        repository
      });
    }
  }

  return outcomes;
}

async function releaseIssue(
  input: ResumeShutdownCancelledRunsInput & {
    issueLabels: string[];
    issueNumber: number;
    projectName: string;
    repository: GitHubIssueRepositoryInput;
  }
): Promise<boolean> {
  const labels = [CLAIM_LABEL, STALE_LABEL].filter((label) =>
    input.issueLabels.includes(label)
  );
  if (labels.length === 0) {
    return true;
  }
  return removeLabels({ ...input, labels });
}

async function removeLabels(
  input: Pick<
    ResumeShutdownCancelledRunsInput,
    "githubIssuesApi" | "logger"
  > & {
    issueNumber: number;
    labels: string[];
    projectName: string;
    repository: GitHubIssueRepositoryInput;
  }
): Promise<boolean> {
  try {
    const called = await tryRemoveLabelsFromIssue(input.githubIssuesApi, {
      ...input.repository,
      issueNumber: input.issueNumber,
      labels: input.labels
    });
    if (!called) {
      input.logger.warn(
        {
          issueNumber: input.issueNumber,
          labels: input.labels,
          project: input.projectName
        },
        "symphonika shutdown resume skipped: removeLabelsFromIssue not available"
      );
    }
    return called;
  } catch (error) {
    input.logger.warn(
      {
        err: error,
        issueNumber: input.issueNumber,
        labels: input.labels,
        project: input.projectName
      },
      "symphonika shutdown resume label write failed"
    );
    return false;
  }
}
