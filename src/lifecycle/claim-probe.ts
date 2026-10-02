import type { NormalizedProviderEvent } from "../provider.js";
import { parseWorkflowClaim } from "../workflow/claim.js";
import type { ExpandedWorkflowState } from "../workflow/types.js";
import { statePredicateKeys } from "./artifact-probe.js";

export function probeStateClaim(input: {
  events: readonly NormalizedProviderEvent[];
  state: ExpandedWorkflowState;
}): string | undefined {
  if (!statePredicateKeys(input.state).has("claim_status")) {
    return undefined;
  }
  return parseWorkflowClaim(input.events)?.status;
}
