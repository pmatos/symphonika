import { z } from "zod";

import type { NormalizedProviderEvent } from "../provider.js";

// Matches terminal:'s vocabulary exactly.
type WorkflowClaimStatus = "blocked" | "failure" | "success";

type WorkflowClaim = {
  status: WorkflowClaimStatus;
  summary: string;
};

const workflowClaimSchema = z
  .object({
    status: z.enum(["success", "blocked", "failure"]),
    summary: z.string()
  })
  .strict();

// Handed to providers that accept a response schema (Claude --json-schema,
// Codex turn/start.outputSchema). Oh My Pi's RPC mode has no such lever, so
// its claim rides on the prompt instruction alone.
export const WORKFLOW_CLAIM_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    status: {
      enum: ["success", "blocked", "failure"],
      type: "string"
    },
    summary: { type: "string" }
  },
  required: ["status", "summary"],
  type: "object"
} as const;

// Shared by every state that names claim_status, injected into the rendered
// prompt so the wording cannot drift between prompt files.
export const WORKFLOW_CLAIM_INSTRUCTIONS = [
  "## Final claim",
  "",
  'Your final message MUST be a single bare JSON object and nothing else — no prose, no markdown fence: `{"status": "success" | "blocked" | "failure", "summary": "<one or two sentences>"}`.',
  "",
  "- `success`: you completed this state's task.",
  "- `blocked`: you could not make progress and a human or an external change is needed (for example the failure requires a product decision). Explain what blocked you and what would unblock it in `summary`.",
  "- `failure`: you attempted the task and it did not work.",
  "",
  "This claim is what the workflow gates this state's advance on. It applies on top of the operating contract: when you cannot proceed, still post the explanatory comment, but then end with a `blocked` claim rather than exiting with prose. A final message that is not exactly this JSON object is treated as a failure, so never omit it."
].join("\n");

// A leading BOM is stripped first: a shell redirect or editor can prepend one
// and JSON.parse otherwise rejects an otherwise well-formed claim.
export function parseWorkflowClaimText(text: string): WorkflowClaim | null {
  const unprefixed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let candidate: unknown;
  try {
    candidate = JSON.parse(unprefixed);
  } catch {
    return null;
  }
  return parseWorkflowClaimCandidate(candidate);
}

function parseWorkflowClaimCandidate(candidate: unknown): WorkflowClaim | null {
  const parsed = workflowClaimSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// Mirrors parseRoutineOutcomeClaim: only the last turn_completed counts, its
// schema-enforced structuredOutput wins, and the final message text is the
// fallback for providers that cannot enforce a schema. A missing or
// schema-invalid claim is absent, so a transition naming claim_status simply
// does not match and the state's fallback transition applies.
export function parseWorkflowClaim(
  events: readonly NormalizedProviderEvent[]
): WorkflowClaim | null {
  let completed: NormalizedProviderEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn_completed") {
      completed = events[index];
      break;
    }
  }
  if (completed === undefined) {
    return null;
  }
  if (completed.structuredOutput !== undefined) {
    return parseWorkflowClaimCandidate(completed.structuredOutput);
  }
  if (typeof completed.result === "string") {
    return parseWorkflowClaimText(completed.result);
  }
  return null;
}
