import type { Logger } from "pino";

import {
  resolveEnvBackedValue,
  tryGetPullRequest,
  tryListIssues,
  tryListPullRequestsForBranch,
  type GitHubIssuesApi,
  type RawGitHubIssue,
  type RawGitHubPullRequest
} from "../issue-polling.js";
import type { RunControllerProjectConfig } from "../lifecycle/run-controller.js";
import type { RunStore } from "../run-store.js";
import {
  diffRoutineGithubSnapshots,
  parseGithubClaimUrl,
  type ObservedRoutineAction,
  type RoutineGithubSnapshot,
  type RoutineOutcomeClaim
} from "./outcome.js";
import type { RoutineStatus } from "./types.js";

const EPOCH_ISO = new Date(0).toISOString();

type RoutineGithubStore = Pick<
  RunStore,
  "getRoutineFiring" | "recordRoutinePullRequest"
>;

export type RoutineGithubCapture = {
  issuesAvailable: boolean;
  pullRequests: RawGitHubPullRequest[];
  pullRequestsAvailable: boolean;
  snapshot: RoutineGithubSnapshot;
};

type ObservationInput = {
  branchName: string;
  env: NodeJS.ProcessEnv;
  firingId: string;
  githubIssuesApi: GitHubIssuesApi | undefined;
  kind: RoutineStatus["kind"];
  logger: Logger | undefined;
  project: RunControllerProjectConfig;
  routineName: string;
  runStore: RoutineGithubStore;
  since: string;
  claimUrlVerificationTimeoutMs: number;
};

export type RoutineGithubEvidence = {
  githubObservationAvailable: boolean;
  observedAction: ObservedRoutineAction | null;
  pullRequestObserved: boolean;
};

export function createRoutineGithubObservation(input: ObservationInput) {
  return {
    capture: () => captureRoutineGithubSnapshot(input),
    assess: async (
      assessment:
        | {
            phase: "failure";
            before: RoutineGithubCapture | null;
            after: RoutineGithubCapture | null;
          }
        | {
            phase: "success";
            before: RoutineGithubCapture | null;
            after: RoutineGithubCapture | null;
            claim: RoutineOutcomeClaim | null;
          }
    ): Promise<RoutineGithubEvidence> => {
      const { before, after } = assessment;
      const comparison = routineGithubObservation(
        before,
        after,
        input.kind,
        input.since
      );
      if (assessment.phase === "failure") {
        return {
          githubObservationAvailable: comparison.available,
          observedAction: comparison.action,
          pullRequestObserved: comparison.action?.action === "pr"
        };
      }

      const beforePullRequests =
        before?.pullRequestsAvailable === true
          ? before.snapshot.pullRequests
          : undefined;
      let discoveryDone: Promise<boolean> = Promise.resolve(false);
      if (input.kind === "git") {
        if (after?.pullRequestsAvailable === true) {
          discoveryDone = Promise.resolve(
            observedNewPullRequestForBranch(
              after.pullRequests,
              input.branchName,
              beforePullRequests
            )
          );
          recordRoutinePullRequests({
            branchName: input.branchName,
            firingId: input.firingId,
            projectName: input.project.name,
            pullRequests: after.pullRequests,
            routineName: input.routineName,
            runStore: input.runStore
          });
        } else {
          discoveryDone = discoverRoutinePullRequests({
            beforePullRequests,
            branchName: input.branchName,
            env: input.env,
            firingId: input.firingId,
            githubIssuesApi: input.githubIssuesApi,
            logger: input.logger,
            project: input.project,
            routineName: input.routineName,
            runStore: input.runStore
          });
        }
      }
      const claim = assessment.claim;
      const verification =
        input.kind === "git" &&
        claim !== null &&
        claim.status !== "error" &&
        comparison.action?.action !== claim.action
          ? verifyRoutineOutcomeClaimUrl({
              beforeIssuesSnapshot:
                before?.issuesAvailable === true
                  ? before.snapshot.issues
                  : undefined,
              claim,
              env: input.env,
              githubIssuesApi: input.githubIssuesApi,
              issuesSnapshot:
                after?.issuesAvailable === true
                  ? after.snapshot.issues
                  : undefined,
              logger: input.logger,
              project: input.project,
              timeoutMs: input.claimUrlVerificationTimeoutMs,
              windowStart: input.since
            })
          : Promise.resolve(null);
      const [fallbackDiscoveredPr, claimUrlVerification] = await Promise.all([
        discoveryDone,
        verification
      ]);
      return {
        githubObservationAvailable: comparison.available,
        observedAction: claimUrlVerification ?? comparison.action,
        pullRequestObserved:
          comparison.action?.action === "pr" ||
          claimUrlVerification?.action === "pr" ||
          fallbackDiscoveredPr
      };
    }
  };
}

async function captureRoutineGithubSnapshot(input: {
  branchName: string;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi | undefined;
  kind: RoutineStatus["kind"];
  logger: Logger | undefined;
  project: RunControllerProjectConfig;
  routineName: string;
  since: string;
}): Promise<RoutineGithubCapture | null> {
  if (input.project.tracker === undefined) {
    input.logger?.info(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine issue observation skipped: tracker absent"
    );
    return null;
  }
  if (input.githubIssuesApi === undefined) {
    input.logger?.info(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine GitHub observation skipped: API unavailable"
    );
    return null;
  }
  const token = resolveEnvBackedValue(input.project.tracker.token, input.env);
  if (token === undefined) {
    input.logger?.warn(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine GitHub observation token unavailable"
    );
    return null;
  }

  let issues: RawGitHubIssue[] = [];
  let issuesAvailable = false;
  try {
    const listed = await tryListIssues(input.githubIssuesApi, {
      owner: input.project.tracker.owner,
      repo: input.project.tracker.repo,
      since: input.since,
      state: "all",
      token
    });
    if (listed === undefined) {
      input.logger?.info(
        { project: input.project.name, routine: input.routineName },
        "symphonika routine issue observation skipped: API unsupported"
      );
    } else {
      issues = listed;
      issuesAvailable = true;
    }
  } catch (error) {
    input.logger?.warn(
      { err: error, project: input.project.name, routine: input.routineName },
      "symphonika routine issue observation failed"
    );
  }

  let pullRequests: RawGitHubPullRequest[] = [];
  let pullRequestsAvailable = false;
  if (input.kind === "git") {
    try {
      const listed = await tryListPullRequestsForBranch(input.githubIssuesApi, {
        branch: input.branchName,
        owner: input.project.tracker.owner,
        repo: input.project.tracker.repo,
        token
      });
      if (listed !== undefined) {
        pullRequests = listed;
        pullRequestsAvailable = true;
      }
    } catch (error) {
      input.logger?.warn(
        { branch: input.branchName, err: error },
        "symphonika routine PR observation failed"
      );
    }
  }

  if (!issuesAvailable && !pullRequestsAvailable) {
    return null;
  }
  return {
    issuesAvailable,
    pullRequests,
    pullRequestsAvailable,
    snapshot: {
      issues: routineIssueObservations(issues),
      pullRequests: routinePullRequestObservations(
        pullRequests,
        input.branchName
      )
    }
  };
}

function routineGithubObservation(
  before: RoutineGithubCapture | null,
  after: RoutineGithubCapture | null,
  kind: RoutineStatus["kind"],
  windowStart: string
): {
  action: ReturnType<typeof diffRoutineGithubSnapshots>;
  available: boolean;
} {
  if (before === null || after === null) {
    return { action: null, available: false };
  }
  const issuesAvailable = before.issuesAvailable && after.issuesAvailable;
  const pullRequestsAvailable =
    before.pullRequestsAvailable && after.pullRequestsAvailable;
  if (!issuesAvailable && !pullRequestsAvailable) {
    return { action: null, available: false };
  }
  // A `kind: git` firing's primary evidence channel is its branch's PRs, so
  // a silently-failed PR read must not be masked by a succeeding issue read
  // (or vice versa); report firings never observe PRs, so issues alone
  // suffice there.
  const available =
    kind === "git" ? issuesAvailable && pullRequestsAvailable : issuesAvailable;
  return {
    action: diffRoutineGithubSnapshots(
      {
        issues: issuesAvailable ? before.snapshot.issues : {},
        pullRequests: pullRequestsAvailable ? before.snapshot.pullRequests : {}
      },
      {
        issues: issuesAvailable ? after.snapshot.issues : {},
        pullRequests: pullRequestsAvailable ? after.snapshot.pullRequests : {}
      },
      windowStart
    ),
    available
  };
}

// Independently confirms (or refutes) a claimed pr/issue_opened/issue_closed
// action by looking its own URL up directly, rather than relying on the
// branch-scoped before/after diff above. That diff only ever matches a
// PR/issue whose head is this firing's own deterministic branch, so a real
// action taken from a different branch (see #748) is otherwise invisible to
// it. Scoped to the firing's own configured owner/repo by
// parseGithubClaimUrl, so a claim can't trigger a lookup against an
// unrelated repository. A `pr` claim is confirmed by the pull request's mere
// existence via a fresh single-PR GET — there's no reliable "before" state
// for a branch this firing never observed, so this matches the
// branch-scoped diff's own bar for PRs. An `issue_opened`/`issue_closed`
// claim, by contrast, is answered only from captureRoutineGithubSnapshot's
// own before/after issue snapshots (never a fresh GET — see
// confirmIssueClaimAction below for why), applying the same
// absent-from-before (or not-already-closed-there) bar
// diffRoutineGithubSnapshots itself uses, so a stale or hallucinated URL
// naming an issue that predates this firing is refuted rather than
// rubber-stamped. Errors and "not found" both return null — a claim this
// can't confirm is left for the caller's existing branch-scoped evidence to
// decide, not treated as refuted.
async function verifyRoutineOutcomeClaimUrl(input: {
  beforeIssuesSnapshot: RoutineGithubSnapshot["issues"] | undefined;
  claim: RoutineOutcomeClaim | null;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi | undefined;
  issuesSnapshot: RoutineGithubSnapshot["issues"] | undefined;
  logger: Logger | undefined;
  project: RunControllerProjectConfig;
  // Bounds only the live single-PR GET below, not the issue_opened/
  // issue_closed branches, which answer from already-captured snapshots and
  // issue no network call of their own.
  timeoutMs: number;
  windowStart: string;
}): Promise<ObservedRoutineAction | null> {
  const claim = input.claim;
  if (
    claim === null ||
    claim.url === null ||
    claim.status === "error" ||
    (claim.action !== "pr" &&
      claim.action !== "issue_opened" &&
      claim.action !== "issue_closed") ||
    input.githubIssuesApi === undefined ||
    input.project.tracker === undefined
  ) {
    return null;
  }
  const { owner, repo, token: tokenConfig } = input.project.tracker;
  const reference = parseGithubClaimUrl(claim.url, owner, repo);
  if (reference === null) {
    return null;
  }
  const token = resolveEnvBackedValue(tokenConfig, input.env);
  if (token === undefined) {
    input.logger?.warn(
      { project: input.project.name },
      "symphonika routine claim URL verification token unavailable"
    );
    return null;
  }
  try {
    if (claim.action === "pr") {
      if (reference.kind !== "pull") {
        return null;
      }
      const pullRequest = await tryGetPullRequest(input.githubIssuesApi, {
        owner,
        pullNumber: reference.number,
        repo,
        signal: AbortSignal.timeout(input.timeoutMs),
        token
      });
      if (pullRequest?.number === undefined) {
        return null;
      }
      return {
        action: "pr",
        title: pullRequestTitle(pullRequest),
        url: pullRequest.html_url ?? claim.url
      };
    }
    if (reference.kind !== "issue") {
      return null;
    }
    // Answered from captureRoutineGithubSnapshot's own before/after issue
    // snapshots only — never a fresh single-issue GET. Those snapshots are
    // each bound to a specific, recorded capture time; a live GET has no
    // such bound; performed here (after githubAfter and PR discovery), it
    // could observe an issue opened/closed in the gap between the
    // after-snapshot's capture and this very call, which is real but did not
    // happen during this firing's recorded observation window. `windowStart`
    // is also only the broad pagination cutoff diffRoutineGithubSnapshots
    // uses (githubSnapshotSince), not this firing's own start, so a
    // timestamp check alone would additionally confirm an issue opened or
    // closed hours before this firing began but still inside that rolling
    // window. diffRoutineGithubSnapshots' actual protection against both is
    // requiring absence from the *before* snapshot (or, for a close, that it
    // wasn't already closed there) — mirrored here via
    // confirmIssueClaimAction. Either snapshot missing, or the issue simply
    // absent from the after one (it predates the window, or wasn't observed
    // by it), leaves the claim unconfirmed rather than risk a false
    // positive.
    if (
      input.beforeIssuesSnapshot === undefined ||
      input.issuesSnapshot === undefined
    ) {
      return null;
    }
    const cachedIssue = input.issuesSnapshot[String(reference.number)];
    if (cachedIssue === undefined) {
      return null;
    }
    const beforeIssue = input.beforeIssuesSnapshot[String(reference.number)];
    const confirmed = confirmIssueClaimAction(
      claim.action,
      cachedIssue,
      beforeIssue,
      Date.parse(input.windowStart)
    );
    if (confirmed === null) {
      return null;
    }
    return {
      action: claim.action,
      title: confirmed.title,
      url: confirmed.url ?? claim.url
    };
  } catch (error) {
    input.logger?.warn(
      {
        err: error,
        number: reference.number,
        project: input.project.name,
        referenceKind: reference.kind
      },
      "symphonika routine claim URL verification failed"
    );
    return null;
  }
}

function issueTitle(issue: RawGitHubIssue): string {
  return issue.title ?? `Issue #${issue.number}`;
}

function pullRequestTitle(pullRequest: RawGitHubPullRequest): string {
  return pullRequest.title ?? `Pull request #${pullRequest.number}`;
}

// Mirrors diffRoutineGithubSnapshots' newlyOpenedIssue/newlyClosedIssue
// predicates so the direct-URL fallback confirms a claim only under the
// same "actually happened during this firing" bar the branch-scoped diff
// already enforces, rather than a looser existence-plus-timestamp check.
function confirmIssueClaimAction(
  action: "issue_opened" | "issue_closed",
  issue: RoutineGithubSnapshot["issues"][string],
  beforeIssue: RoutineGithubSnapshot["issues"][string] | undefined,
  windowStartMs: number
): RoutineGithubSnapshot["issues"][string] | null {
  if (action === "issue_opened") {
    if (
      beforeIssue !== undefined ||
      !(Date.parse(issue.createdAt) >= windowStartMs)
    ) {
      return null;
    }
    return issue;
  }
  if (issue.state.toLowerCase() !== "closed") {
    return null;
  }
  if (beforeIssue === undefined) {
    if (
      issue.closedAt === null ||
      !(Date.parse(issue.closedAt) >= windowStartMs)
    ) {
      return null;
    }
    return issue;
  }
  if (beforeIssue.state.toLowerCase() === "closed") {
    return null;
  }
  return issue;
}

function routineIssueObservations(
  issues: RawGitHubIssue[]
): RoutineGithubSnapshot["issues"] {
  const observations: RoutineGithubSnapshot["issues"] = {};
  for (const issue of issues) {
    if (
      issue.pull_request !== undefined ||
      issue.number === undefined ||
      issue.number <= 0
    ) {
      continue;
    }
    observations[String(issue.number)] = {
      closedAt: issue.closed_at ?? null,
      // A missing created_at is treated as "always predates the window" so
      // an issue never falsely counts as newly opened for lack of evidence.
      createdAt: issue.created_at ?? EPOCH_ISO,
      state: issue.state ?? "",
      title: issueTitle(issue),
      url: issue.html_url ?? null
    };
  }
  return observations;
}

function routinePullRequestObservations(
  pullRequests: RawGitHubPullRequest[],
  branchName: string
): RoutineGithubSnapshot["pullRequests"] {
  const observations: RoutineGithubSnapshot["pullRequests"] = {};
  for (const pullRequest of pullRequests) {
    if (!isPullRequestForBranch(pullRequest, branchName)) {
      continue;
    }
    observations[String(pullRequest.number)] = {
      title: pullRequestTitle(pullRequest),
      url: pullRequest.html_url ?? null
    };
  }
  return observations;
}

// Returns whether a PR new to this firing (absent from `beforePullRequests`
// when available, any state — see observedNewPullRequestForBranch) was found
// for the firing's own branch, so the caller can propagate a fallback
// discovery into `pullRequestObserved`'s exemption for expects_pr (#758).
// What gets recorded into the run store stays open-only regardless (SPEC.md)
// — this path's own recording remains informational only otherwise: it never
// enters PR Follow-up, review re-dispatch, or auto-merge.
async function discoverRoutinePullRequests(input: {
  beforePullRequests: RoutineGithubSnapshot["pullRequests"] | undefined;
  branchName: string;
  env: NodeJS.ProcessEnv;
  firingId: string;
  githubIssuesApi: GitHubIssuesApi | undefined;
  logger: Logger | undefined;
  project: RunControllerProjectConfig;
  routineName: string;
  runStore: RoutineGithubStore;
}): Promise<boolean> {
  if (
    input.githubIssuesApi === undefined ||
    input.project.tracker === undefined
  ) {
    return false;
  }
  const token = resolveEnvBackedValue(input.project.tracker.token, input.env);
  if (token === undefined) {
    input.logger?.warn(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine PR discovery token unavailable"
    );
    return false;
  }

  let pullRequests: RawGitHubPullRequest[] | undefined;
  try {
    pullRequests = await tryListPullRequestsForBranch(input.githubIssuesApi, {
      branch: input.branchName,
      owner: input.project.tracker.owner,
      repo: input.project.tracker.repo,
      token
    });
  } catch (error) {
    input.logger?.warn(
      { branch: input.branchName, err: error },
      "symphonika routine PR discovery failed"
    );
    return false;
  }

  // The cancellation settlement window races this call rather than aborting
  // it: a discovery abandoned there keeps running and can resolve after the
  // firing already went terminal and its fan-out summary was sent. Re-check
  // the firing is still `running` before writing so a late discovery never
  // records PRs onto a firing whose outcome has already been reported.
  if (input.runStore.getRoutineFiring(input.firingId)?.state !== "running") {
    input.logger?.warn(
      { firingId: input.firingId, routine: input.routineName },
      "symphonika routine PR discovery abandoned after firing already completed"
    );
    return false;
  }

  const listedPullRequests = pullRequests ?? [];
  recordRoutinePullRequests({
    branchName: input.branchName,
    firingId: input.firingId,
    projectName: input.project.name,
    pullRequests: listedPullRequests,
    routineName: input.routineName,
    runStore: input.runStore
  });
  return observedNewPullRequestForBranch(
    listedPullRequests,
    input.branchName,
    input.beforePullRequests
  );
}

function recordRoutinePullRequests(input: {
  branchName: string;
  firingId: string;
  projectName: string;
  pullRequests: RawGitHubPullRequest[];
  routineName: string;
  runStore: RoutineGithubStore;
}): void {
  for (const pullRequest of input.pullRequests) {
    if (!isOpenPullRequestForBranch(pullRequest, input.branchName)) {
      continue;
    }
    input.runStore.recordRoutinePullRequest({
      firingId: input.firingId,
      headSha: pullRequest.head.sha,
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url ?? null,
      projectName: input.projectName,
      routineName: input.routineName
    });
  }
}

// Unlike isOpenPullRequestForBranch, this admits a closed/merged PR: outcome
// observation needs to detect a PR that was opened AND closed within the same
// firing window, not just associate currently-open ones (see
// routinePullRequestObservations).
function isPullRequestForBranch(
  pullRequest: RawGitHubPullRequest,
  branchName: string
): pullRequest is RawGitHubPullRequest & {
  head: { ref: string; sha: string };
  number: number;
} {
  return (
    pullRequest.number !== undefined &&
    pullRequest.number > 0 &&
    pullRequest.head?.ref === branchName &&
    pullRequest.head.sha !== undefined &&
    pullRequest.head.sha.length > 0
  );
}

function isOpenPullRequestForBranch(
  pullRequest: RawGitHubPullRequest,
  branchName: string
): pullRequest is RawGitHubPullRequest & {
  head: { ref: string; sha: string };
  number: number;
} {
  return (
    pullRequest.state === "open" &&
    pullRequest.number !== undefined &&
    pullRequest.number > 0 &&
    pullRequest.head?.ref === branchName &&
    pullRequest.head.sha !== undefined &&
    pullRequest.head.sha.length > 0
  );
}

// Mirrors diffRoutineGithubSnapshots' own newPullRequest bar (reusing the same
// raw->snapshot conversion, routinePullRequestObservations): a PR counts as
// observed only when it's new to this firing, not merely present in a raw
// listing. Without `beforePullRequests` (its own read failed or wasn't
// captured), any state-matching PR counts — the same permissive fallback the
// diff itself has no equivalent for, since it simply can't compute without
// both snapshots. Deliberately independent of isOpenPullRequestForBranch,
// which gates only what gets recorded (open-only, per SPEC): a PR opened and
// then merged/closed within the same firing window must still exempt
// expects_pr's rule 4 (#758), and a PR that already existed before this
// firing began (e.g. a reused branch carrying over a prior firing's PR) must
// not.
function observedNewPullRequestForBranch(
  pullRequests: RawGitHubPullRequest[],
  branchName: string,
  beforePullRequests: RoutineGithubSnapshot["pullRequests"] | undefined
): boolean {
  const afterPullRequests = routinePullRequestObservations(
    pullRequests,
    branchName
  );
  return Object.keys(afterPullRequests).some(
    (number) =>
      beforePullRequests === undefined ||
      beforePullRequests[number] === undefined
  );
}
