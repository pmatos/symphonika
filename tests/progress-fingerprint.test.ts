import { describe, expect, it } from "vitest";

import {
  formatNoProgressReason,
  parseNoProgressReason,
  progressFingerprint
} from "../src/lifecycle/progress-fingerprint.js";
import type { ExpandedWorkflowState } from "../src/workflow/types.js";

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
      headSha: "abc",
      signals: baseSignals,
      state
    });
    const reversed = progressFingerprint({
      artifactExists: undefined,
      headSha: "abc",
      signals: Object.fromEntries(Object.entries(baseSignals).reverse()),
      state
    });
    expect(reversed).toBe(forward);
  });

  it("changes when the head SHA moves under otherwise identical signals", () => {
    const state = waitState();
    const before = progressFingerprint({
      artifactExists: undefined,
      headSha: "abc",
      signals: baseSignals,
      state
    });
    const after = progressFingerprint({
      artifactExists: undefined,
      headSha: "def",
      signals: baseSignals,
      state
    });
    expect(after).not.toBe(before);
  });

  it("changes when a signal value changes", () => {
    const state = waitState();
    const before = progressFingerprint({
      artifactExists: undefined,
      headSha: "abc",
      signals: baseSignals,
      state
    });
    const after = progressFingerprint({
      artifactExists: undefined,
      headSha: "abc",
      signals: { ...baseSignals, unresolved_review_threads: 2 },
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
      headSha: undefined,
      signals: baseSignals,
      state
    });
    const present = progressFingerprint({
      artifactExists: () => true,
      headSha: undefined,
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
      headSha: undefined,
      signals: baseSignals,
      state
    });
    const absent = progressFingerprint({
      artifactExists: () => false,
      headSha: undefined,
      signals: baseSignals,
      state
    });
    expect(unprobed).not.toBe(absent);
  });

  it("ignores artifacts the state's predicates do not name", () => {
    const state = waitState();
    const withResolver = progressFingerprint({
      artifactExists: () => true,
      headSha: "abc",
      signals: baseSignals,
      state
    });
    const withoutResolver = progressFingerprint({
      artifactExists: undefined,
      headSha: "abc",
      signals: baseSignals,
      state
    });
    expect(withResolver).toBe(withoutResolver);
  });
});

describe("no-progress reason round trip", () => {
  it("parses back the edge it formatted", () => {
    const reason = formatNoProgressReason("wait_for_pr", "autofix");
    expect(parseNoProgressReason(reason)).toEqual({
      fromStateId: "wait_for_pr",
      toStateId: "autofix"
    });
  });

  it("ignores reasons written by anything but the guard", () => {
    expect(parseNoProgressReason(null)).toBeNull();
    expect(parseNoProgressReason(undefined)).toBeNull();
    expect(parseNoProgressReason("holding advanced to done")).toBeNull();
    expect(
      parseNoProgressReason("merge_pr merged PR #99 via squash")
    ).toBeNull();
  });
});
