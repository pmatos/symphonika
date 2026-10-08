// The `state_transition_reason` written when a wait is parked because the PR's
// failing checks never started (GitHub Actions billing or spending limit,
// runner startup failure). It doubles as the dedup key for the issue
// notification, the same way the progress guard's reasons do.
export const CHECKS_NOT_STARTED_REASON = "checks_not_started";

export function describeChecksNotStarted(checks: readonly string[]): string {
  return [
    `The pull request's failing checks never started: ${checks.join(", ")}.`,
    "That points at CI infrastructure (for example the GitHub Actions billing or spending limit), not at the code, so no agent was dispatched to repair it.",
    "Symphonika keeps the run parked and re-checks every poll; fix the account or runner problem and re-run the checks to resume."
  ].join(" ");
}
