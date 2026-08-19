import {
  evaluateProjectEligibility,
  type IssueSnapshot,
  type PollingProjectConfig
} from "../issue-polling.js";

export type RunContinuationEligibilityScope = "fsm_owned" | "label_controlled";

export type RunContinuationEligibilityDecision = {
  eligible: boolean;
  reasons: string[];
};

export function evaluateRunContinuationEligibility(
  issue: IssueSnapshot,
  project: PollingProjectConfig,
  question: { scope: RunContinuationEligibilityScope }
): RunContinuationEligibilityDecision {
  if (question.scope === "fsm_owned") {
    const reasons =
      project.issue_filters.states.includes("open") && issue.state === "open"
        ? []
        : [`state ${issue.state} is not eligible`];
    return { eligible: reasons.length === 0, reasons };
  }

  return evaluateProjectEligibility(issue, project, {
    ignoreOperationalLabels: true
  });
}
