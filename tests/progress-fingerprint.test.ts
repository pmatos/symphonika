import { describe, expect, it } from "vitest";

import {
  buildNoProgressReason,
  parseNoProgressReason,
  progressFingerprint
} from "../src/lifecycle/progress-fingerprint.js";
import { interpretPullRequest } from "../src/pull-request-state.js";
import type { RawGitHubPullRequestFollowupState } from "../src/issue-polling.js";
import type { ExpandedWorkflowState } from "../src/workflow/types.js";

function thread(id: string, body: string) {
  return {
    comments: [
      {
        author: "reviewer",
        body,
        createdAt: "2026-08-12T09:00:00Z",
        path: "src/run-store.ts",
        url: `https://example.test/pr/99#${id}`
      }
    ],
    id,
    isResolved: false,
    path: "src/run-store.ts"
  };
}

function pr(
  overrides: Partial<RawGitHubPullRequestFollowupState> = {}
): ReturnType<typeof interpretPullRequest> {
  return interpretPullRequest({
    draft: false,
    headSha: "abc",
    mergeable: "MERGEABLE",
    merged: false,
    number: 99,
    reviewDecision: "CHANGES_REQUESTED",
    state: "OPEN",
    statusCheckRollupState: "SUCCESS",
    unresolvedReviewThreads: [thread("t1", "please rename this")],
    url: "https://example.test/pr/99",
    ...overrides
  });
}

function waitState(
  overrides: Partial<ExpandedWorkflowState> = {}
): ExpandedWorkflowState {
  return {
    action: { kind: "wait" },
    completeWhen: {},
    id: "wait_for_pr",
    transitions: [
      { to: "merge", when: { checks: "success", mergeable: true } },
      { to: "autofix", when: { has_unresolved_reviews: true } }
    ],
    ...overrides
  };
}

const baseSignals = {
  checks: "success",
  has_unresolved_reviews: true,
  mergeable: true,
  pr_open: true,
  unresolved_review_threads: 1
};

describe("progressFingerprint", () => {
  it("is stable across signal key ordering", () => {
    const state = waitState();
    const forward = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr(),
      signals: baseSignals,
      state
    });
    const reversed = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr(),
      signals: Object.fromEntries(Object.entries(baseSignals).reverse()),
      state
    });
    expect(reversed).toBe(forward);
  });

  it("changes when the head SHA moves under otherwise identical signals", () => {
    const state = waitState();
    const before = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr(),
      signals: baseSignals,
      state
    });
    const after = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr({ headSha: "def" }),
      signals: baseSignals,
      state
    });
    expect(after).not.toBe(before);
  });

  it("changes when a signal value changes", () => {
    const state = waitState();
    const before = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr(),
      signals: baseSignals,
      state
    });
    const after = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr(),
      signals: { ...baseSignals, unresolved_review_threads: 2 },
      state
    });
    expect(after).not.toBe(before);
  });

  it("changes when the review conversation moves at an unchanged thread count", () => {
    // A reviewer resolves one thread and opens another. Nothing in the
    // projected signal map moves -- same count, same checks -- and no push
    // means the head SHA is unchanged too. Without the review-feedback
    // fingerprint the guard would park a workflow with genuinely new feedback
    // to act on.
    const state = waitState();
    const before = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr({
        unresolvedReviewThreads: [thread("t1", "please rename this")]
      }),
      signals: baseSignals,
      state
    });
    const after = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr({
        unresolvedReviewThreads: [thread("t2", "this needs a test")]
      }),
      signals: baseSignals,
      state
    });
    expect(after).not.toBe(before);
  });

  it("changes when a reviewer edits a thread body in place", () => {
    const state = waitState();
    const before = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr({
        unresolvedReviewThreads: [thread("t1", "please rename this")]
      }),
      signals: baseSignals,
      state
    });
    const after = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr({
        unresolvedReviewThreads: [thread("t1", "actually, extract it")]
      }),
      signals: baseSignals,
      state
    });
    expect(after).not.toBe(before);
  });

  it("changes when an artifact the state names appears", () => {
    const state = waitState({
      transitions: [
        { to: "done", when: { artifact_exists: "reports/plan.md" } }
      ]
    });
    const absent = progressFingerprint({
      artifactExists: () => false,
      pullRequestState: undefined,
      signals: baseSignals,
      state
    });
    const present = progressFingerprint({
      artifactExists: () => true,
      pullRequestState: undefined,
      signals: baseSignals,
      state
    });
    expect(present).not.toBe(absent);
  });

  it("distinguishes an unprobed workspace from a probed-absent artifact", () => {
    const state = waitState({
      transitions: [
        { to: "done", when: { artifact_exists: "reports/plan.md" } }
      ]
    });
    const unprobed = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: undefined,
      signals: baseSignals,
      state
    });
    const absent = progressFingerprint({
      artifactExists: () => false,
      pullRequestState: undefined,
      signals: baseSignals,
      state
    });
    expect(unprobed).not.toBe(absent);
  });

  it("ignores artifacts the state's predicates do not name", () => {
    const state = waitState();
    const withResolver = progressFingerprint({
      artifactExists: () => true,
      pullRequestState: pr(),
      signals: baseSignals,
      state
    });
    const withoutResolver = progressFingerprint({
      artifactExists: undefined,
      pullRequestState: pr(),
      signals: baseSignals,
      state
    });
    expect(withResolver).toBe(withoutResolver);
  });
});

describe("no-progress reason round trip", () => {
  it("parses back the edge it formatted", () => {
    const reason = buildNoProgressReason({
      fromStateId: "wait_for_pr",
      toStateId: "autofix"
    });
    expect(parseNoProgressReason(reason)).toEqual({
      fromStateId: "wait_for_pr",
      toStateId: "autofix"
    });
  });

  it("ignores reasons written by anything but the guard", () => {
    expect(parseNoProgressReason(null)).toBeNull();
    expect(parseNoProgressReason("holding advanced to done")).toBeNull();
    expect(
      parseNoProgressReason("merge_pr merged PR #99 via squash")
    ).toBeNull();
    expect(parseNoProgressReason("cap_reached:no_commits")).toBeNull();
    expect(parseNoProgressReason("no_progress:only_one_half")).toBeNull();
    expect(parseNoProgressReason("no_progress:a:b:c")).toBeNull();
    expect(parseNoProgressReason("no_progress::autofix")).toBeNull();
  });
});
