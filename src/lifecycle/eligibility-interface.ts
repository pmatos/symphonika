export type IssueEligibilityQuestion =
  | { kind: "dispatch" }
  | {
      kind: "continue_run";
      scope: "label_controlled" | "fsm_owned";
    };

export type IssueEligibilityFailure =
  | "closed_issue"
  | "label_mismatch"
  | "operational_label_blocked";

export type IssueEligibilityDecision =
  | { eligible: true; reasons: [] }
  | {
      eligible: false;
      failure: IssueEligibilityFailure;
      reasons: string[];
    };

export type ProposedIssueEligibilityExport =
  | "evaluateDispatchEligibility"
  | "evaluateRunContinuationEligibility"
  | "evaluateIssueEligibility";

export const PROPOSED_ISSUE_ELIGIBILITY_MODULE =
  "src/lifecycle/issue-eligibility.ts";

export const PROPOSED_ISSUE_ELIGIBILITY_EXPORTS = [
  "evaluateDispatchEligibility",
  "evaluateRunContinuationEligibility",
  "evaluateIssueEligibility"
] as const satisfies readonly ProposedIssueEligibilityExport[];

export type EligibilityConsumerMigration = {
  currentSmell: string;
  file: string;
  proposedRewrite: string;
};

export const ELIGIBILITY_CONSUMER_MIGRATION = [
  {
    currentSmell:
      "Owns evaluateProjectEligibility plus the ignoreOperationalLabels option.",
    file: "src/issue-polling.ts",
    proposedRewrite:
      "Import evaluateDispatchEligibility from the eligibility module for fresh candidate filtering."
  },
  {
    currentSmell:
      "Combines the respectsIssueLabels escape hatch with a direct predicate call.",
    file: "src/lifecycle/reconcile.ts",
    proposedRewrite:
      "Ask evaluateRunContinuationEligibility with a lifecycle-derived question: label_controlled or fsm_owned."
  },
  {
    currentSmell:
      "Stores respectsIssueLabels on ActiveRunEntry even though the registry only owns liveness and cancellation.",
    file: "src/lifecycle/active-runs.ts",
    proposedRewrite:
      "Remove eligibility fields; keep only active run identity, cancellation, provider, and liveness data."
  },
  {
    currentSmell:
      "Computes and threads respectsIssueLabels through active registration, retry scheduling, and scheduleNext.",
    file: "src/lifecycle/run-controller.ts",
    proposedRewrite:
      "Derive the eligibility question from lifecycle event or planned-step kind at the point of re-check."
  }
] as const satisfies readonly EligibilityConsumerMigration[];

export type EligibilityTestMigration = {
  file: string;
  rewrite: string;
};

export const ELIGIBILITY_TEST_MIGRATION_PLAN = [
  {
    file: "tests/eligibility-helpers.test.ts",
    rewrite:
      "Move assertions to the new eligibility module: dispatch includes operational labels; label-controlled continuation ignores them; FSM-owned continuation ignores label drift but not closure."
  },
  {
    file: "tests/reconcile.test.ts",
    rewrite:
      "Replace direct respectsIssueLabels setup with lifecycle-derived continuation questions and assert closed_issue still wins."
  },
  {
    file: "tests/active-runs.test.ts",
    rewrite:
      "Delete any eligibility-field expectations; ActiveRunRegistry remains a liveness and cancellation registry."
  },
  {
    file: "tests/dispatch-cancellation.test.ts",
    rewrite:
      "Keep the public daemon behavior assertion that label loss cancels a label-controlled active run."
  },
  {
    file: "tests/dispatch-retry.test.ts",
    rewrite:
      "Drive scheduled retry eligibility through label-controlled vs FSM-owned questions instead of a boolean payload."
  },
  {
    file: "tests/property-invariants.test.ts",
    rewrite:
      "Add property coverage for dispatch, label-controlled continuation, and FSM-owned continuation invariants."
  }
] as const satisfies readonly EligibilityTestMigration[];

export type IssueEligibilityAdrRule = {
  adr: "0022" | "0023" | "0046" | "0047";
  question: IssueEligibilityQuestion;
  ruleLocation: string;
  summary: string;
};

export const ISSUE_ELIGIBILITY_ADR_RULES = [
  {
    adr: "0022",
    question: { kind: "continue_run", scope: "fsm_owned" },
    ruleLocation: "All continuation questions check issue open/closed state first.",
    summary:
      "Closed issues cancel active, scheduled, state-advance, and waiting work regardless of label scope."
  },
  {
    adr: "0023",
    question: { kind: "continue_run", scope: "label_controlled" },
    ruleLocation: "Label-controlled continuation eligibility evaluates labels_all and labels_none.",
    summary:
      "Eligibility loss remains the operator control surface for normal active runs and scheduled retries."
  },
  {
    adr: "0046",
    question: { kind: "continue_run", scope: "fsm_owned" },
    ruleLocation: "Lifecycle state-advance work asks the FSM-owned continuation question.",
    summary:
      "State advances skip labels_all and labels_none re-checks while still cancelling on closed issues."
  },
  {
    adr: "0047",
    question: { kind: "continue_run", scope: "fsm_owned" },
    ruleLocation: "Waiting-row reconciliation asks the same FSM-owned continuation question.",
    summary:
      "Wait states inherit state-advance label immunity and remain poll-reconciled instead of dispatch-gated."
  }
] as const satisfies readonly IssueEligibilityAdrRule[];
