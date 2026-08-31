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

export type NoProgressEdge = {
  fromStateId: string;
  toStateId: string;
};

export function buildNoProgressReason(edge: NoProgressEdge): string {
  return `${NO_PROGRESS_PREFIX}${edge.fromStateId}:${edge.toStateId}`;
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
  if (
    rest.length > 0 ||
    fromStateId === undefined ||
    toStateId === undefined ||
    fromStateId === "" ||
    toStateId === ""
  ) {
    return null;
  }
  return { fromStateId, toStateId };
}

// Everything a park re-evaluation learned this tick, hashed into one value.
// Two ticks with the same fingerprint observed the same world, so re-taking a
// transition between them cannot make progress.
//
// `pullRequestState` contributes two things the projected signals cannot say on
// their own. Its head SHA distinguishes a push that changed the code while
// leaving check status and thread count untouched. Its review feedback
// fingerprint — thread ids, comment bodies, review decision — distinguishes a
// changed conversation at an unchanged count: a reviewer resolving one thread
// and opening another moves nothing in the projected map, and without it the
// guard would park a workflow that had genuinely new feedback to act on.
export function progressFingerprint(input: {
  artifactExists: ArtifactExistsResolver | undefined;
  pullRequestState: PullRequestState | undefined;
  signals: WorkflowPredicateMap;
  state: ExpandedWorkflowState;
}): string {
  const signals = Object.entries(input.signals).sort(([left], [right]) =>
    left.localeCompare(right)
  );

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
      head: input.pullRequestState?.headSha ?? null,
      reviewFeedback:
        input.pullRequestState?.reviewFollowup.feedbackFingerprint ?? null,
      signals
    })
  );
}
