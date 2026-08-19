import {
  evaluateProjectEligibility,
  issueStateReasons,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../issue-polling.js";
import type { IssueEligibilityQuestion } from "./eligibility-interface.js";

export type RunContinuationEligibilityScope = Extract<
  IssueEligibilityQuestion,
  { kind: "continue_run" }
>["scope"];

export type RunContinuationEligibilityDecision = {
  eligible: boolean;
  reasons: string[];
};

// fsm_owned scope keeps ownership of the walk through label and dependency
// drift and checks only issue state; label_controlled scope re-checks the
// full project filter, including dependency gating. Closed issues cancel
// work under either scope. See ADR 0046 and ADR 0082.
export function evaluateRunContinuationEligibility(
  issue: IssueSnapshot,
  project: PollingProjectConfig,
  question: { scope: RunContinuationEligibilityScope }
): RunContinuationEligibilityDecision {
  if (question.scope === "fsm_owned") {
    const reasons = issueStateReasons(issue, project);
    return { eligible: reasons.length === 0, reasons };
  }

  return evaluateProjectEligibility(issue, project, {
    ignoreOperationalLabels: true
  });
}
