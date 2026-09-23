import type { Logger } from "pino";

import {
  readWorkflowClaimFile,
  workflowClaimFilePath
} from "../workflow/claim.js";
import type { ExpandedWorkflowState } from "../workflow/types.js";
import { statePredicateKeys } from "./artifact-probe.js";

// Mirrors probeStateArtifacts: only probes when the state actually names
// claim_status (most states never do), and the caller merges the result into
// the same flat signals map decideNextStep already compares by strict
// equality -- no new evaluation machinery needed there, unlike artifact_exists.
export async function probeStateClaim(input: {
  attemptNumber: number;
  logger: Logger | undefined;
  runId: string;
  state: ExpandedWorkflowState;
  stateRoot: string;
}): Promise<string | undefined> {
  if (!statePredicateKeys(input.state).has("claim_status")) {
    return undefined;
  }
  const claimPath = workflowClaimFilePath(
    input.stateRoot,
    input.runId,
    input.attemptNumber
  );
  const claim = await readWorkflowClaimFile(claimPath, input.logger);
  return claim?.status;
}
