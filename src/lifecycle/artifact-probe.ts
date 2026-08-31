import { stat } from "node:fs/promises";

import {
  artifactPredicatePaths,
  resolveArtifactPath,
  workflowPredicateEvaluation
} from "../workflow/predicates.js";
import type {
  ExpandedWorkflowState,
  WorkflowPredicateMap
} from "../workflow/types.js";
import type { ArtifactExistsResolver } from "./state-machine-dispatch.js";

// Probes the Run Workspace once for every path the state's artifact predicates
// name, so decideNextStep can stay synchronous and every predicate in the state
// -- complete_when and each transition -- answers from the same observation.
// Undefined means "nothing to probe or nowhere to probe it": a state with no
// artifact predicate never consults the resolver, and a state that has one but
// no prepared Workspace must block rather than advance, which is what
// decideNextStep does with an absent resolver.
export async function probeStateArtifacts(input: {
  state: ExpandedWorkflowState;
  workspacePath: string | undefined;
}): Promise<ArtifactExistsResolver | undefined> {
  const candidates = collectArtifactPaths(input.state);
  const workspacePath = input.workspacePath;
  if (
    candidates.size === 0 ||
    workspacePath === undefined ||
    workspacePath.length === 0
  ) {
    return undefined;
  }

  const present = new Set<string>();
  await Promise.all(
    [...candidates].map(async (candidate) => {
      const resolved = resolveArtifactPath(workspacePath, candidate);
      if (resolved === undefined) {
        return;
      }
      try {
        await stat(resolved);
        present.add(candidate);
      } catch {
        // Absent, unreadable, or a dangling symlink all read the same way: the
        // stage did not produce the artefact.
      }
    })
  );
  return (candidate: string) => present.has(candidate);
}

// Every predicate key the state references, across complete_when and each
// transition. A caller with only some signal sources available uses this to ask
// whether the state is decidable at all from what it has -- reEvaluateWaitingRun
// polls an artifact-only wait before a pull request exists, but must leave a
// state that also names PR predicates parked, since an absent PR signal is
// "unmet" and would otherwise drop the state onto a catch-all transition.
export function statePredicateKeys(state: ExpandedWorkflowState): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(state.completeWhen)) {
    keys.add(key);
  }
  for (const transition of state.transitions) {
    for (const key of Object.keys(transition.when)) {
      keys.add(key);
    }
  }
  return keys;
}

// Exported so the progress fingerprint can observe exactly the paths this
// state's predicates name -- a second, independently derived path list would
// let the fingerprint miss an artifact the decision actually turned on.
export function collectArtifactPaths(
  state: ExpandedWorkflowState
): Set<string> {
  const paths = new Set<string>();
  addArtifactPaths(state.completeWhen, paths);
  for (const transition of state.transitions) {
    addArtifactPaths(transition.when, paths);
  }
  return paths;
}

function addArtifactPaths(
  predicates: WorkflowPredicateMap,
  into: Set<string>
): void {
  for (const [key, value] of Object.entries(predicates)) {
    if (workflowPredicateEvaluation(key) !== "artifact") {
      continue;
    }
    for (const candidate of artifactPredicatePaths(value) ?? []) {
      into.add(candidate);
    }
  }
}
