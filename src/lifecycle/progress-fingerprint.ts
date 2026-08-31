import { contentHash } from "../content-hash.js";
import type {
  ExpandedWorkflowState,
  WorkflowPredicateMap
} from "../workflow/types.js";
import { collectArtifactPaths } from "./artifact-probe.js";
import type { ArtifactExistsResolver } from "./state-machine-dispatch.js";

// The `state_transition_reason` written when the progress guard holds a park
// in place, and its inverse. Both live here so the guard that writes the
// reason and the detail surfaces that render it as a manual-attention warning
// cannot drift apart on the format.
const NO_PROGRESS_PREFIX = "workflow made no progress: ";
const NO_PROGRESS_SUFFIX = " under an unchanged observation";

export function formatNoProgressReason(
  fromStateId: string,
  toStateId: string
): string {
  return `${NO_PROGRESS_PREFIX}${fromStateId} -> ${toStateId}${NO_PROGRESS_SUFFIX}`;
}

export function parseNoProgressReason(
  reason: string | null | undefined
): { fromStateId: string; toStateId: string } | null {
  if (
    reason === null ||
    reason === undefined ||
    !reason.startsWith(NO_PROGRESS_PREFIX) ||
    !reason.endsWith(NO_PROGRESS_SUFFIX)
  ) {
    return null;
  }
  const edge = reason.slice(
    NO_PROGRESS_PREFIX.length,
    reason.length - NO_PROGRESS_SUFFIX.length
  );
  const separator = edge.indexOf(" -> ");
  if (separator < 0) {
    return null;
  }
  return {
    fromStateId: edge.slice(0, separator),
    toStateId: edge.slice(separator + " -> ".length)
  };
}

// Everything a park re-evaluation learned this tick, hashed into one value.
// Two ticks with the same fingerprint observed the same world, so re-taking a
// transition between them cannot make progress.
//
// The head SHA is part of the observation and not merely derived from it:
// `unresolved_review_threads` is a count, so a fresh push that changed the
// code while leaving check status and thread count untouched would otherwise
// hash identically to the observation before it, and the guard would park a
// run that genuinely had new work to do.
export function progressFingerprint(input: {
  artifactExists: ArtifactExistsResolver | undefined;
  headSha: string | undefined;
  signals: WorkflowPredicateMap;
  state: ExpandedWorkflowState;
}): string {
  const signals = Object.entries(input.signals)
    .map(([key, value]): [string, unknown] => [key, value])
    .sort(([left], [right]) => left.localeCompare(right));

  const artifactExists = input.artifactExists;
  const artifacts = [...collectArtifactPaths(input.state)]
    .sort((left, right) => left.localeCompare(right))
    .map((candidate): [string, boolean | null] => [
      candidate,
      artifactExists === undefined ? null : artifactExists(candidate)
    ]);

  return contentHash(
    JSON.stringify({
      artifacts,
      head: input.headSha ?? null,
      signals
    })
  );
}
