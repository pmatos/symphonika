import type { NormalizedProviderEvent } from "../provider.js";
import { parseWorkflowClaim } from "../workflow/claim.js";
import type { ExpandedWorkflowState } from "../workflow/types.js";
import { statePredicateKeys } from "./artifact-probe.js";

// The one definition of "this state gates on a Workflow Claim": it decides
// both whether the provider is asked for one and whether it is read back.
export function stateGatesOnClaim(state: ExpandedWorkflowState): boolean {
  return statePredicateKeys(state).has("claim_status");
}

export function probeStateClaim(input: {
  events: readonly NormalizedProviderEvent[];
  state: ExpandedWorkflowState;
}): string | undefined {
  return stateGatesOnClaim(input.state)
    ? parseWorkflowClaim(input.events)?.status
    : undefined;
}
