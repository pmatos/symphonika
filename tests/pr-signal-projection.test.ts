import { describe, expect, it } from "vitest";

import { projectPullRequestSignals } from "../src/lifecycle/pr-signal-projection.js";
import type { PullRequestState } from "../src/pull-request-state.js";

function makePullRequestState(
  overrides: Partial<PullRequestState> = {}
): PullRequestState {
  return {
    checks: "unknown",
    draft: false,
    headSha: "deadbeef",
    mergeable: "unknown",
    merged: false,
    number: 42,
    open: true,
    reviewDecision: "unknown",
    reviewFollowup: {
      checks: null,
      decision: null,
      feedbackFingerprint: "sha256:test",
      unresolvedThreads: []
    },
    trackingState: "open",
    unresolvedReviewThreads: 0,
    url: "https://example.test/pr/42",
    ...overrides
  };
}

describe("projectPullRequestSignals", () => {
  it("emits pr_open: true for an open pull request", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ open: true })
    );
    expect(signals.pr_open).toBe(true);
  });

  it("emits pr_open: false for a closed pull request", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ open: false })
    );
    expect(signals.pr_open).toBe(false);
  });

  it("emits pr_merged: true when the pull request is merged", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ merged: true, open: false })
    );
    expect(signals.pr_merged).toBe(true);
    expect(signals.pr_open).toBe(false);
  });

  it("does not emit pr_merged when the pull request is not merged", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ merged: false })
    );
    expect(signals.pr_merged).toBeUndefined();
  });

  it("emits mergeable: true for MERGEABLE state", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ mergeable: "mergeable" })
    );
    expect(signals.mergeable).toBe(true);
  });

  it("emits mergeable: false for CONFLICTING state", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ mergeable: "conflicting" })
    );
    expect(signals.mergeable).toBe(false);
  });

  it("omits mergeable when state is unknown", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ mergeable: "unknown" })
    );
    expect("mergeable" in signals).toBe(false);
  });

  it("emits checks: 'success' for successful checks", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ checks: "success" })
    );
    expect(signals.checks).toBe("success");
  });

  it("emits checks: 'failure' for failed checks", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ checks: "failure" })
    );
    expect(signals.checks).toBe("failure");
  });

  it("emits checks: 'pending' for pending checks", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ checks: "pending" })
    );
    expect(signals.checks).toBe("pending");
  });

  it("omits checks when checks are unknown", () => {
    const signals = projectPullRequestSignals(
      makePullRequestState({ checks: "unknown" })
    );
    expect("checks" in signals).toBe(false);
  });

  it("emits normalized review_decision states", () => {
    const cases = [
      ["approved", "approved"],
      ["changes_requested", "changes_requested"],
      ["review_required", "review_required"],
      ["unknown", "none"]
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
      makePullRequestState({ unresolvedReviewThreads: 0 })
    );
    expect(zero.unresolved_review_threads).toBe(0);

    const two = projectPullRequestSignals(
      makePullRequestState({ unresolvedReviewThreads: 2 })
    );
    expect(two.unresolved_review_threads).toBe(2);
  });

  it("emits has_unresolved_reviews from the unresolved review thread count", () => {
    const zero = projectPullRequestSignals(
      makePullRequestState({ unresolvedReviewThreads: 0 })
    );
    expect(zero.has_unresolved_reviews).toBe(false);

    const one = projectPullRequestSignals(
      makePullRequestState({ unresolvedReviewThreads: 1 })
    );
    expect(one.has_unresolved_reviews).toBe(true);
  });
});
