import { describe, expect, it } from "vitest";

import {
  ELIGIBILITY_CONSUMER_MIGRATION,
  ELIGIBILITY_TEST_MIGRATION_PLAN,
  ISSUE_ELIGIBILITY_ADR_RULES,
  PROPOSED_ISSUE_ELIGIBILITY_EXPORTS,
  type IssueEligibilityDecision,
  type IssueEligibilityQuestion
} from "../src/lifecycle/eligibility-interface.js";

describe("issue eligibility interface proposal", () => {
  it("defines dispatch and continuation questions without boolean label flags", () => {
    const dispatch: IssueEligibilityQuestion = { kind: "dispatch" };
    const labelControlled: IssueEligibilityQuestion = {
      kind: "continue_run",
      scope: "label_controlled"
    };
    const fsmOwned: IssueEligibilityQuestion = {
      kind: "continue_run",
      scope: "fsm_owned"
    };

    expect([dispatch.kind, labelControlled.scope, fsmOwned.scope]).toEqual([
      "dispatch",
      "label_controlled",
      "fsm_owned"
    ]);
  });

  it("keeps proposed module exports focused on the two eligibility questions", () => {
    expect(PROPOSED_ISSUE_ELIGIBILITY_EXPORTS).toEqual([
      "evaluateDispatchEligibility",
      "evaluateRunContinuationEligibility",
      "evaluateIssueEligibility"
    ]);
  });

  it("maps every current consumer away from scattered eligibility flags", () => {
    expect(ELIGIBILITY_CONSUMER_MIGRATION.map((entry) => entry.file)).toEqual([
      "src/issue-polling.ts",
      "src/lifecycle/reconcile.ts",
      "src/lifecycle/active-runs.ts",
      "src/lifecycle/run-controller.ts"
    ]);

    expect(
      ELIGIBILITY_CONSUMER_MIGRATION.some((entry) =>
        entry.currentSmell.includes("respectsIssueLabels")
      )
    ).toBe(true);
    expect(
      ELIGIBILITY_CONSUMER_MIGRATION.some((entry) =>
        entry.currentSmell.includes("ignoreOperationalLabels")
      )
    ).toBe(true);
  });

  it("documents the test rewrite plan for each eligibility-specific suite", () => {
    expect(ELIGIBILITY_TEST_MIGRATION_PLAN.map((entry) => entry.file)).toEqual([
      "tests/eligibility-helpers.test.ts",
      "tests/reconcile.test.ts",
      "tests/active-runs.test.ts",
      "tests/dispatch-cancellation.test.ts",
      "tests/dispatch-retry.test.ts",
      "tests/property-invariants.test.ts"
    ]);

    expect(
      ELIGIBILITY_TEST_MIGRATION_PLAN.find(
        (entry) => entry.file === "tests/property-invariants.test.ts"
      )?.rewrite
    ).toContain("property");
  });

  it("places ADR cancellation rules on explicit eligibility outcomes", () => {
    expect(ISSUE_ELIGIBILITY_ADR_RULES.map((rule) => rule.adr)).toEqual([
      "0022",
      "0023",
      "0046",
      "0047"
    ]);

    const closed: IssueEligibilityDecision = {
      eligible: false,
      failure: "closed_issue",
      reasons: ["state closed is not eligible"]
    };
    expect(closed.failure).toBe("closed_issue");
  });
});
