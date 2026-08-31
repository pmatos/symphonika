import { contentHash } from "../content-hash.js";
import type { PullRequestState } from "../pull-request-state.js";
import type {
  ExpandedWorkflowState,
  WorkflowPredicateMap
} from "../workflow/types.js";
import { collectArtifactPaths } from "./artifact-probe.js";
import type { ArtifactExistsResolver } from "./state-machine-dispatch.js";

// The `state_transition_reason` written when the progress guard holds a park in
// place. A machine token rendered into prose separately, the same split
// terminal-reason.ts makes for `cap_reached:<kind>`, so a surface can re-word
// the sentence without breaking the parse. State ids are path-safe identifiers
// (fsm-expansion.ts), so ":" cannot occur inside one and the token is
// unambiguous.
const NO_PROGRESS_PREFIX = "no_progress:";
const EDGE_BUDGET_EXHAUSTED_PREFIX = "edge_budget_exhausted:";

// Ten accepted advances leave substantially more room than the old default
// of three review follow-up dispatches while still placing a finite bound on
// a park-mediated cycle whose observation changes forever (issue #619).
export const DEFAULT_PROGRESS_GUARD_MAX_EDGE_CLAIMS = 10;

export type NoProgressEdge = {
  fromStateId: string;
  toStateId: string;
};

export type EdgeBudgetExhausted = NoProgressEdge & {
  maxClaims: number;
};

export function buildNoProgressReason(edge: NoProgressEdge): string {
  return `${NO_PROGRESS_PREFIX}${edge.fromStateId}:${edge.toStateId}`;
}

export function buildEdgeBudgetExhaustedReason(
  edge: NoProgressEdge,
  maxClaims: number
): string {
  return `${EDGE_BUDGET_EXHAUSTED_PREFIX}${edge.fromStateId}:${edge.toStateId}:${maxClaims}`;
}

export function parseEdgeBudgetExhaustedReason(
  reason: string | null
): EdgeBudgetExhausted | null {
  if (reason === null || !reason.startsWith(EDGE_BUDGET_EXHAUSTED_PREFIX)) {
    return null;
  }
  const [fromStateId, toStateId, maxClaimsText, ...rest] = reason
    .slice(EDGE_BUDGET_EXHAUSTED_PREFIX.length)
    .split(":");
  const maxClaims = Number(maxClaimsText);
  if (
    rest.length > 0 ||
    !fromStateId ||
    !toStateId ||
    !Number.isInteger(maxClaims) ||
    maxClaims <= 0
  ) {
    return null;
  }
  return { fromStateId, maxClaims, toStateId };
}

export function parseNoProgressReason(
  reason: string | null
): NoProgressEdge | null {
  if (reason === null || !reason.startsWith(NO_PROGRESS_PREFIX)) {
    return null;
  }
  const [fromStateId, toStateId, ...rest] = reason
    .slice(NO_PROGRESS_PREFIX.length)
    .split(":");
  if (rest.length > 0 || !fromStateId || !toStateId) {
    return null;
  }
  return { fromStateId, toStateId };
}

// Everything a park re-evaluation learned this tick, hashed into one value.
// Two ticks with the same fingerprint observed the same world, so re-taking a
// transition between them cannot make progress.
//
// Ordering is by code unit rather than locale: this hash is compared across
// processes and must not depend on ICU collation.
//
// `pullRequestState` covers two changes the projected signals cannot express,
// both of which would otherwise park a workflow that was in fact progressing.
// A push that changed the code while leaving check status and thread count
// untouched moves the head SHA. A reviewer resolving one thread while opening
// another moves nothing in the projected map at all — same count, same checks —
// and is caught by the review-feedback fingerprint over thread ids, comment
// bodies and review decision.
//
// `computeReviewFeedbackFingerprint` happens to fold the head SHA in too, so
// `head` is redundant today. It stays named here because push-detection is a
// property this guard depends on, and inlining that dependency into another
// module's private choice of hash inputs would let it disappear silently.
export function progressFingerprint(input: {
  artifactExists: ArtifactExistsResolver | undefined;
  pullRequestState: PullRequestState | undefined;
  signals: WorkflowPredicateMap;
  state: ExpandedWorkflowState;
}): string {
  const signals = Object.entries(input.signals).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );

  const artifactExists = input.artifactExists;
  const artifacts = [...collectArtifactPaths(input.state)]
    .sort()
    .map((candidate): [string, boolean | null] => [
      candidate,
      artifactExists === undefined ? null : artifactExists(candidate)
    ]);

  return contentHash(
    JSON.stringify({
      artifacts,
      head: input.pullRequestState?.headSha ?? null,
      reviewFeedback:
        input.pullRequestState?.reviewFollowup.feedbackFingerprint ?? null,
      signals
    })
  );
}
