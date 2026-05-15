import { describe, expect, it } from "vitest";

import type { RawGitHubPullRequestFollowupState } from "../src/issue-polling.js";
import { interpretPullRequest } from "../src/pull-request-state.js";

function rawPullRequestState(
  overrides: Partial<RawGitHubPullRequestFollowupState> = {}
): RawGitHubPullRequestFollowupState {
  return {
    draft: false,
    headSha: "abc123",
    mergeable: "MERGEABLE",
    merged: false,
    number: 42,
    reviewDecision: "APPROVED",
    state: "OPEN",
    statusCheckRollupState: "SUCCESS",
    unresolvedReviewThreads: [],
    url: "https://example.test/pull/42",
    ...overrides
  };
}

describe("interpretPullRequest", () => {
  it("normalizes unknown mergeability and expected checks without choosing a branch", () => {
    const state = interpretPullRequest(
      rawPullRequestState({
        mergeable: "UNKNOWN",
        statusCheckRollupState: "EXPECTED"
      })
    );

    expect(state).toMatchObject({
      checks: "pending",
      mergeable: "unknown"
    });
  });

  it("keeps unknown tracker state pollable without projecting the PR as open", () => {
    const state = interpretPullRequest(
      rawPullRequestState({
        state: "UNKNOWN"
      })
    );

    expect(state.open).toBe(false);
    expect(state.trackingState).toBe("open");
  });
});
