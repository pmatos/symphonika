import { createHash } from "node:crypto";

import type {
  RawGitHubPullRequestFollowupState,
  RawGitHubPullRequestReviewThread
} from "./issue-polling.js";

type PullRequestChecksState = "failure" | "pending" | "success" | "unknown";

export type PullRequestState = {
  headSha: string;
  open: boolean;
  merged: boolean;
  draft: boolean;
  number: number;
  url: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  // `unknown` rather than `failure` when every failing check never started
  // (billing, runner startup): no code push can fix those, so they must not
  // satisfy a `checks: failure` repair edge. Carries the check names.
  checks: PullRequestChecksState;
  checksNeverStarted: string[];
  reviewDecision:
    | "approved"
    | "changes_requested"
    | "review_required"
    | "commented"
    | "unknown";
  reviewFollowup: {
    checks: RawGitHubPullRequestFollowupState["statusCheckRollupState"];
    decision: RawGitHubPullRequestFollowupState["reviewDecision"];
    feedbackFingerprint: string;
    unresolvedThreads: RawGitHubPullRequestReviewThread[];
  };
  trackingState: "closed" | "merged" | "open";
  unresolvedReviewThreads: number;
};

export function interpretPullRequest(
  raw: RawGitHubPullRequestFollowupState
): PullRequestState {
  const checksNeverStarted = raw.neverStartedChecks ?? [];
  return {
    checks:
      checksNeverStarted.length > 0
        ? "unknown"
        : interpretChecks(raw.statusCheckRollupState),
    checksNeverStarted,
    draft: raw.draft,
    headSha: raw.headSha,
    mergeable: interpretMergeable(raw.mergeable),
    merged: raw.merged || raw.state === "MERGED",
    number: raw.number,
    open: raw.state === "OPEN",
    reviewDecision: interpretReviewDecision(raw.reviewDecision),
    reviewFollowup: {
      checks: raw.statusCheckRollupState,
      decision: raw.reviewDecision,
      feedbackFingerprint: computeReviewFeedbackFingerprint(raw),
      unresolvedThreads: raw.unresolvedReviewThreads
    },
    trackingState: interpretTrackingState(raw),
    unresolvedReviewThreads: raw.unresolvedReviewThreads.length,
    url: raw.url
  };
}

function interpretTrackingState(
  raw: RawGitHubPullRequestFollowupState
): PullRequestState["trackingState"] {
  if (raw.merged || raw.state === "MERGED") {
    return "merged";
  }
  if (raw.state === "CLOSED") {
    return "closed";
  }
  return "open";
}

function interpretMergeable(
  mergeable: RawGitHubPullRequestFollowupState["mergeable"]
): PullRequestState["mergeable"] {
  switch (mergeable) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function interpretChecks(
  rollup: RawGitHubPullRequestFollowupState["statusCheckRollupState"]
): PullRequestChecksState {
  switch (rollup) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "unknown";
  }
}

function interpretReviewDecision(
  decision: RawGitHubPullRequestFollowupState["reviewDecision"]
): PullRequestState["reviewDecision"] {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return "unknown";
  }
}

function computeReviewFeedbackFingerprint(
  raw: RawGitHubPullRequestFollowupState
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        headSha: raw.headSha,
        reviewDecision: raw.reviewDecision,
        threads: raw.unresolvedReviewThreads.map((thread) => ({
          comments: thread.comments.map((comment) => ({
            body: comment.body,
            createdAt: comment.createdAt,
            url: comment.url
          })),
          id: thread.id,
          isOutdated: thread.isOutdated,
          line: thread.line,
          path: thread.path
        }))
      })
    )
    .digest("hex")}`;
}
