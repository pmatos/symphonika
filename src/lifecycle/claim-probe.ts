import type { Logger } from "pino";

import {
  readWorkflowClaimFile,
  workflowClaimFilePath
} from "../workflow/claim.js";
import type { ExpandedWorkflowState } from "../workflow/types.js";
import { statePredicateKeys } from "./artifact-probe.js";

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
