import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import {
  attemptEvidenceFileName,
  runEvidenceDirectoryPath
} from "./evidence-paths.js";

// A Workflow Claim reinforces (not replaces) the predicate-graph-driven
// terminal-state determination FSM/Workflow runs already use: an agent state
// may opt in by naming `claim_status` in complete_when/transitions, and this
// is the file the agent writes to make that claim (issue #776, generalizing
// the Routine Outcome Claim pattern from #759/PR #775). Vocabulary matches
// `terminal:` exactly so a claim can name the same three outcomes a raw-FSM
// author can already declare.
type WorkflowClaimStatus = "blocked" | "failure" | "success";

export type WorkflowClaim = {
  status: WorkflowClaimStatus;
  summary: string;
};

const workflowClaimSchema = z
  .object({
    status: z.enum(["success", "blocked", "failure"]),
    summary: z.string()
  })
  .strict();

// Deliberately self-contained rather than sharing routines/outcome.ts's
// reader: that module ships a tested, merged reliability-critical path for a
// different subsystem, and this claim's payload (two fields, no URL
// verification) does not need the routine reconciliation machinery layered
// on top of it. Same bounded-read rationale, independent blast radius.
export function parseWorkflowClaimText(text: string): WorkflowClaim | null {
  const unprefixed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let candidate: unknown;
  try {
    candidate = JSON.parse(unprefixed);
  } catch {
    return null;
  }
  const parsed = workflowClaimSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// Attempt-scoped by construction: attemptEvidenceFileName suffixes every
// attempt after the first, so a retry that reuses the same runId's evidence
// directory (persistRunEvidence, same convention) never reads an earlier
// attempt's stale claim.
export function workflowClaimFilePath(
  stateRoot: string,
  runId: string,
  attemptNumber: number
): string {
  return path.join(
    runEvidenceDirectoryPath(stateRoot, runId),
    attemptEvidenceFileName("claim", attemptNumber, "json")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// Claim text is agent-authored, not bounded structured output -- cap it well
// above a real claim's size before ever reading it, mirroring
// ROUTINE_OUTCOME_CLAIM_FILE_MAX_BYTES in routines/outcome.ts.
const WORKFLOW_CLAIM_FILE_MAX_BYTES = 64 * 1024;

// Read after the provider process has exited, so there is no concurrent
// writer. Missing, oversized, or malformed content is treated as absent: a
// state gating on claim_status simply never matches that transition, the
// same way an absent artifact or PR signal falls through today. Uses an open
// file handle's fstat/read rather than stat-then-readFile on the path twice,
// avoiding a TOCTOU window the same way readRoutineOutcomeClaimFile does.
export async function readWorkflowClaimFile(
  claimPath: string,
  logger: Logger | undefined
): Promise<WorkflowClaim | null> {
  let handle: FileHandle;
  try {
    handle = await open(claimPath, "r");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      logger?.warn(
        { claimPath, err: errorMessage(error) },
        "symphonika workflow claim file open failed; ignoring"
      );
    }
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return null;
    }
    if (stats.size > WORKFLOW_CLAIM_FILE_MAX_BYTES) {
      logger?.warn(
        { claimPath, size: stats.size },
        "symphonika workflow claim file exceeds size cap; ignoring"
      );
      return null;
    }
    const text = await handle.readFile("utf8");
    return parseWorkflowClaimText(text);
  } catch (error) {
    logger?.warn(
      { claimPath, err: errorMessage(error) },
      "symphonika workflow claim file read failed; ignoring"
    );
    return null;
  } finally {
    await handle.close();
  }
}
