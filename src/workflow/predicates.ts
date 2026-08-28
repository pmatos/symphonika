import path from "node:path";

import { isPathInside } from "../path-safety.js";
import type { WorkflowPredicateValue } from "./types.js";

// How a predicate key becomes a yes/no answer at decision time. Every key the
// parser accepts must name one of these, so a key cannot be allowlisted
// without an evaluator behind it -- issue #583's `artifact_exists` was
// allowlisted for months with nothing evaluating it, and a `when` clause using
// it silently never matched. Adding a key here without teaching
// state-machine-dispatch how to evaluate its kind is a type error, and
// tests/workflow-predicates.test.ts pins each signal kind to the projection
// that actually emits it.
export type WorkflowPredicateEvaluation =
  "agent_signal" | "artifact" | "pr_signal";

export const workflowPredicateEvaluations = {
  artifact_exists: "artifact",
  branch_advanced_since_attempt_start: "agent_signal",
  branch_ahead_of_base: "agent_signal",
  checks: "pr_signal",
  has_unresolved_reviews: "pr_signal",
  mergeable: "pr_signal",
  pr_merged: "pr_signal",
  pr_open: "pr_signal",
  provider_success: "agent_signal",
  review_decision: "pr_signal",
  unresolved_review_threads: "pr_signal"
} as const satisfies Record<string, WorkflowPredicateEvaluation>;

type WorkflowPredicateKey = keyof typeof workflowPredicateEvaluations;

export function workflowPredicateEvaluation(
  key: string
): WorkflowPredicateEvaluation | undefined {
  return Object.hasOwn(workflowPredicateEvaluations, key)
    ? workflowPredicateEvaluations[key as WorkflowPredicateKey]
    : undefined;
}

export type ArtifactPredicateParse = { error: string } | { paths: string[] };

// A synthetic root standing in for the Run Workspace at validation time, when
// no Workspace has been prepared yet. Containment is a property of the authored
// path, not of the directory it will later resolve against, so the same
// isPathInside guard fsm-expansion uses for Template paths answers it here.
const validationWorkspaceRoot = path.resolve(path.sep, "symphonika-workspace");

export function parseArtifactExistsPaths(
  rawValue: unknown
): ArtifactPredicateParse {
  const entries = Array.isArray(rawValue) ? rawValue : [rawValue];
  if (entries.length === 0) {
    return { error: "must list at least one path" };
  }

  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      return {
        error: "must be a path string or a sequence of path strings"
      };
    }
    const candidate = entry.trim();
    const failure = artifactPathFailure(candidate);
    if (failure !== undefined) {
      return { error: failure };
    }
    paths.push(candidate);
  }
  return { paths };
}

function artifactPathFailure(candidate: string): string | undefined {
  if (candidate.length === 0) {
    return "must not contain an empty path";
  }
  if (candidate.includes("\0")) {
    return "must not contain a null byte";
  }
  if (path.isAbsolute(candidate)) {
    return `path ${candidate} must be workspace-relative, not absolute`;
  }
  if (
    !isPathInside(
      path.resolve(validationWorkspaceRoot, candidate),
      validationWorkspaceRoot
    )
  ) {
    return `path ${candidate} must stay inside the run workspace`;
  }
  return undefined;
}

// The authored paths an artifact predicate names, or undefined when the value
// is not a shape the parser would have accepted. Callers treat undefined as
// "unsatisfiable" rather than "matches", so a hand-built graph that skipped
// validation blocks instead of advancing on a predicate nobody can check.
export function artifactPredicatePaths(
  value: WorkflowPredicateValue
): string[] | undefined {
  const parsed = parseArtifactExistsPaths(value);
  return "paths" in parsed ? parsed.paths : undefined;
}

// Resolves an authored path against the real Workspace, refusing anything that
// lands outside it. parsePredicateMap already rejects escaping paths, so this
// re-check is defence in depth at the join itself: a graph assembled in code
// rather than parsed from a Contract cannot turn the predicate into a probe of
// an arbitrary filesystem path.
export function resolveArtifactPath(
  workspacePath: string,
  candidate: string
): string | undefined {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, candidate);
  return isPathInside(resolved, workspaceRoot) ? resolved : undefined;
}
