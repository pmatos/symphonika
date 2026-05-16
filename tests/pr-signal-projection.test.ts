import { describe, expect, it } from "vitest";

import type { RawGitHubPullRequestFollowupState } from "../src/issue-polling.js";
import { projectPullRequestSignals } from "../src/lifecycle/pr-signal-projection.js";

function makePullRequestState(
  overrides: Partial<RawGitHubPullRequestFollowupState> = {}
): RawGitHubPullRequestFollowupState {
  return {
    draft: false,
    headSha: "deadbeef",
    mergeable: null,
    merged: false,
    number: 42,
    reviewDecision: null,
    state: "OPEN",
    statusCheckRollupState: null,
    unresolvedReviewThreads: [],
    url: "https://example.test/pr/42",
    ...overrides
  };
}

describe("projectPullRequestSignals", () => {
  it("emits pr_open: true for an open pull request", () => {
    const signals = projectPullRequestSignals(makePullRequestState({ state: "OPEN" }));
    expect(signals.pr_open).toBe(true);
  });

  it("emits pr_open: false for a closed pull request", () => {
    const signals = projectPullRequestSignals(makePullRequestState({ state: "CLOSED" }));
    expect(signals.pr_open).toBe(false);
  });

  it("emits pr_merged: true when the pull request is merged", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ state: "MERGED", merged: true })
    );
    expect(signals.pr_merged).toBe(true);
    expect(signals.pr_open).toBe(false);
  });

  it("does not emit pr_merged when the pull request is not merged", () => {
    const signals = projectPullRequestSignals(makePullRequestState({ merged: false }));
    expect(signals.pr_merged).toBeUndefined();
  });

  it("emits mergeable: true for MERGEABLE state", () => {
    const signals = projectPullRequestSignals(makePullRequestState({ mergeable: "MERGEABLE" }));
    expect(signals.mergeable).toBe(true);
  });

  it("emits mergeable: false for CONFLICTING state", () => {
    const signals = projectPullRequestSignals(makePullRequestState({ mergeable: "CONFLICTING" }));
    expect(signals.mergeable).toBe(false);
  });

  it("omits mergeable when state is UNKNOWN", () => {
    const signals = projectPullRequestSignals(makePullRequestState({ mergeable: "UNKNOWN" }));
    expect("mergeable" in signals).toBe(false);
  });

  it("omits mergeable when state is null", () => {
    const signals = projectPullRequestSignals(makePullRequestState({ mergeable: null }));
    expect("mergeable" in signals).toBe(false);
  });

  it("emits checks: 'success' for SUCCESS rollup", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ statusCheckRollupState: "SUCCESS" })
    );
    expect(signals.checks).toBe("success");
  });

  it("emits checks: 'failure' for FAILURE and ERROR rollups", () => {
    for (const rollup of ["FAILURE", "ERROR"] as const) {
      const signals = projectPullRequestSignals(
        makePullRequestState({ statusCheckRollupState: rollup })
      );
      expect(signals.checks).toBe("failure");
    }
  });

  it("emits checks: 'pending' for PENDING and EXPECTED rollups", () => {
    for (const rollup of ["PENDING", "EXPECTED"] as const) {
      const signals = projectPullRequestSignals(
        makePullRequestState({ statusCheckRollupState: rollup })
      );
      expect(signals.checks).toBe("pending");
    }
  });

  it("omits checks when rollup is null", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ statusCheckRollupState: null })
    );
    expect("checks" in signals).toBe(false);
  });

  it("emits normalized review_decision states", () => {
    const cases = [
      ["APPROVED", "approved"],
      ["CHANGES_REQUESTED", "changes_requested"],
      ["REVIEW_REQUIRED", "review_required"],
      [null, "none"]
    ] as const;

    for (const [reviewDecision, expected] of cases) {
      const signals = projectPullRequestSignals(
        makePullRequestState({ reviewDecision })
      );
      expect(signals.review_decision).toBe(expected);
    }
  });

  it("emits unresolved_review_threads as the numeric count", () => {
    const zero = projectPullRequestSignals(
      makePullRequestState({ unresolvedReviewThreads: [] })
    );
    expect(zero.unresolved_review_threads).toBe(0);

    const two = projectPullRequestSignals(
      makePullRequestState({
        unresolvedReviewThreads: [
          { id: "t1", isResolved: false, comments: [] },
          { id: "t2", isResolved: false, comments: [] }
        ]
      })
    );
    expect(two.unresolved_review_threads).toBe(2);
  });

  it("emits has_unresolved_reviews from the unresolved review thread count", () => {
    const zero = projectPullRequestSignals(
      makePullRequestState({ unresolvedReviewThreads: [] })
    );
    expect(zero.has_unresolved_reviews).toBe(false);

    const one = projectPullRequestSignals(
      makePullRequestState({
        unresolvedReviewThreads: [{ id: "t1", isResolved: false, comments: [] }]
      })
    );
    expect(one.has_unresolved_reviews).toBe(true);
  });
});
