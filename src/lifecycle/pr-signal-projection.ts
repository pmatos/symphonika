import type { PullRequestState } from "../pull-request-state.js";
import type { WorkflowPredicateMap } from "../workflow.js";

export function projectPullRequestSignals(
  state: PullRequestState
): WorkflowPredicateMap {
  const signals: WorkflowPredicateMap = {
    pr_open: state.open
  };

  if (state.merged) {
    signals.pr_merged = true;
  }

  if (state.mergeable === "mergeable") {
    signals.mergeable = true;
  } else if (state.mergeable === "conflicting") {
    signals.mergeable = false;
  }

  if (state.checks !== "unknown") {
    signals.checks = state.checks;
  }

  signals.review_decision = mapReviewDecision(state.reviewDecision);
  signals.unresolved_review_threads = state.unresolvedReviewThreads;
  signals.has_unresolved_reviews = state.unresolvedReviewThreads > 0;

  return signals;
}

function mapReviewDecision(
  reviewDecision: PullRequestState["reviewDecision"]
): "approved" | "changes_requested" | "none" | "review_required" {
  switch (reviewDecision) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes_requested";
    case "review_required":
      return "review_required";
    default:
      return "none";
  }
}
