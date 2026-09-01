import type { PullRequestState } from "../pull-request-state.js";
import type { WorkflowPredicateMap } from "./types.js";

// The observations a signal projection actually reads. Narrower than
// PullRequestState so the coverage enumeration below can build cases without
// inventing a head SHA, a URL, or the other identity fields no predicate looks
// at. A full PullRequestState still satisfies it structurally.
export type PullRequestSignalSource = Pick<
  PullRequestState,
  | "checks"
  | "merged"
  | "mergeable"
  | "open"
  | "reviewDecision"
  | "unresolvedReviewThreads"
>;

export function projectPullRequestSignals(
  state: PullRequestSignalSource
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

// Whether a wait has to be able to act on an observation. `may_park` values are
// the ones a wait may legitimately sit on: `pending` while checks are still
// running, and the `unknown` values the projection omits from the signal map
// entirely rather than giving them a value. Every member of every source union
// is spelled out rather than only the actionable ones, so widening one of those
// unions is a compile error here instead of a silent hole in wait coverage.
type SignalCoverage = "may_park" | "must_advance";

const checksCoverage = {
  success: "must_advance",
  failure: "must_advance",
  pending: "may_park",
  unknown: "may_park"
} as const satisfies Record<PullRequestState["checks"], SignalCoverage>;

const mergeableCoverage = {
  mergeable: "must_advance",
  conflicting: "must_advance",
  unknown: "may_park"
} as const satisfies Record<PullRequestState["mergeable"], SignalCoverage>;

// `commented` and `unknown` both project to `none`, so they contribute repeats
// rather than extra coverage. Listing them anyway is the point: the exhaustive
// Record is what fails to compile when a new decision is added upstream.
const reviewDecisionCoverage = {
  approved: "must_advance",
  changes_requested: "must_advance",
  commented: "must_advance",
  review_required: "must_advance",
  unknown: "must_advance"
} as const satisfies Record<PullRequestState["reviewDecision"], SignalCoverage>;

function mustAdvance<Key extends string>(
  coverage: Record<Key, SignalCoverage>
): Key[] {
  return (Object.keys(coverage) as Key[]).filter(
    (key) => coverage[key] === "must_advance"
  );
}

// Every signal map a poll can project that a wait must have somewhere to go
// from. Built by driving projectPullRequestSignals rather than by transcribing
// what it emits, so the projected key set, the omitted-when-unknown keys, and
// the has_unresolved_reviews/unresolved_review_threads coupling all come from
// the one function that decides them.
export function enumerateActionablePullRequestSignals(): WorkflowPredicateMap[] {
  const cases: WorkflowPredicateMap[] = [];
  for (const checks of mustAdvance(checksCoverage)) {
    for (const mergeable of mustAdvance(mergeableCoverage)) {
      // The projection derives has_unresolved_reviews from this count, so one
      // case either side of zero covers both of the boolean's values.
      for (const unresolvedReviewThreads of [1, 0]) {
        for (const open of [true, false]) {
          for (const reviewDecision of mustAdvance(reviewDecisionCoverage)) {
            cases.push(
              projectPullRequestSignals({
                checks,
                merged: false,
                mergeable,
                open,
                reviewDecision,
                unresolvedReviewThreads
              })
            );
          }
        }
      }
    }
  }
  // A wait state re-evaluates against the tracked PR's current state
  // regardless of what state the run parked in (observeWaitPullRequestSignals
  // uses the all-states lookup precisely so a merge landing while a run sits
  // in an ordinary `wait` -- not just `merge_pr` -- is still seen), so a
  // merged, closed PR is itself a settled observation a wait must have
  // somewhere to go from -- the shipped wait_for_pr's own
  // `pr_merged: true -> merged` catch-all exists for exactly this case.
  // GitHub always reports a merged PR as closed, so `open` is pinned false.
  // Unlike an open PR, GitHub does not keep recomputing mergeability once a
  // PR is merged, so `mergeable: unknown` (the key omitted) is itself a
  // permanent, actionable outcome here rather than the transient one it is
  // for an open PR -- every mergeable value is enumerated, not only the
  // must_advance ones.
  for (const checks of mustAdvance(checksCoverage)) {
    for (const mergeable of Object.keys(
      mergeableCoverage
    ) as (keyof typeof mergeableCoverage)[]) {
      for (const unresolvedReviewThreads of [1, 0]) {
        for (const reviewDecision of mustAdvance(reviewDecisionCoverage)) {
          cases.push(
            projectPullRequestSignals({
              checks,
              merged: true,
              mergeable,
              open: false,
              reviewDecision,
              unresolvedReviewThreads
            })
          );
        }
      }
    }
  }
  // Closed-without-merging is symmetric to closed-by-merging above, for the
  // same reason: GitHub stops recomputing mergeability once a PR leaves the
  // merge-eligibility pipeline, whether it left by merging or by closing
  // unmerged, so mergeable: unknown (the key omitted) is a permanent,
  // actionable outcome here too. The main loop above only samples the two
  // must_advance mergeable values while open is false; appended rather than
  // folded in, so it only adds the previously-missing combination without
  // reordering the enumeration the existing tests' error messages are
  // pinned to.
  for (const checks of mustAdvance(checksCoverage)) {
    for (const unresolvedReviewThreads of [1, 0]) {
      for (const reviewDecision of mustAdvance(reviewDecisionCoverage)) {
        cases.push(
          projectPullRequestSignals({
            checks,
            merged: false,
            mergeable: "unknown",
            open: false,
            reviewDecision,
            unresolvedReviewThreads
          })
        );
      }
    }
  }
  return cases;
}
