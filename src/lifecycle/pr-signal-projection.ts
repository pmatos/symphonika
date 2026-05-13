import type { RawGitHubPullRequestFollowupState } from "../issue-polling.js";
import type { WorkflowPredicateMap } from "../workflow.js";

// Wait-state re-evaluation uses these signals via decideNextStep. The PR
// follow-up dispatcher in src/pull-request-followup.ts reads the same
// `RawGitHubPullRequestFollowupState` but produces binary verdicts
// (pullRequestNeedsReviewFollowup, pullRequestReadyToMerge) rather than a
// predicate map. If either side changes how it interprets a given GitHub
// state (e.g. mergeable=UNKNOWN), update both to keep them aligned. See
// ADR 0047.
export function projectPullRequestSignals(
  state: RawGitHubPullRequestFollowupState
): WorkflowPredicateMap {
  const signals: WorkflowPredicateMap = {
    pr_open: state.state === "OPEN"
  };

  if (state.merged === true) {
    signals.pr_merged = true;
  }

  if (state.mergeable === "MERGEABLE") {
    signals.mergeable = true;
  } else if (state.mergeable === "CONFLICTING") {
    signals.mergeable = false;
  }

  const checks = mapStatusCheckRollup(state.statusCheckRollupState);
  if (checks !== null) {
    signals.checks = checks;
  }

  signals.unresolved_review_threads = state.unresolvedReviewThreads.length;

  return signals;
}

function mapStatusCheckRollup(
  rollup: RawGitHubPullRequestFollowupState["statusCheckRollupState"]
): "failure" | "pending" | "success" | null {
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
      return null;
  }
}
