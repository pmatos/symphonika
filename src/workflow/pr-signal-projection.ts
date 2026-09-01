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
// the one function that decides them. `merged` is pinned false because a merged
// pull request has left the wait rather than parked in it -- which is also why
// no map here can carry `pr_merged`, the projection only sets it when merged.
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
  return cases;
}
