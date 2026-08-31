import { contentHash } from "../content-hash.js";
import type {
  ExpandedWorkflowState,
  WorkflowPredicateMap
} from "../workflow/types.js";
import { collectArtifactPaths } from "./artifact-probe.js";
import type { ArtifactExistsResolver } from "./state-machine-dispatch.js";

// Marks a `state_transition_reason` written because the progress guard held a
// park in place. One definition, shared by the guard that writes it and the
// detail surfaces that render it as a manual-attention warning.
export const noProgressReasonPrefix = "workflow made no progress: ";

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
