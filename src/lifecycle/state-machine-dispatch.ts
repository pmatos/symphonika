import {
  artifactPredicatePaths,
  workflowPredicateEvaluation
} from "../workflow/predicates.js";
import type {
  ExpandedWorkflow,
  ExpandedWorkflowState,
  WorkflowAction,
  WorkflowPredicateMap,
  WorkflowPredicateValue
} from "../workflow/types.js";

export type StateMachineDecision =
  | { action: WorkflowAction; kind: "execute_action"; stateId: string }
  | { kind: "terminate"; stateId: string; terminal: string }
  | { kind: "advance"; reason: string; to: string }
  | { kind: "blocked"; reason: string }
  | { kind: "stay_waiting"; reason: string };

export type StateMachineSignals = WorkflowPredicateMap;

// Answers whether one workspace-relative path exists in the Run's Workspace.
// Callers build it from a snapshot taken before the decision so decideNextStep
// stays synchronous and pure, and so the same answer drives complete_when and
// every transition in one evaluation.
export type ArtifactExistsResolver = (relativePath: string) => boolean;

export function findWorkflowState(
  workflow: ExpandedWorkflow,
  stateId: string
): ExpandedWorkflowState | undefined {
  return workflow.states.find((state) => state.id === stateId);
}

export function decideNextStep(input: {
  actionExecuted: boolean;
  artifactExists?: ArtifactExistsResolver;
  signals: StateMachineSignals;
  state: ExpandedWorkflowState;
}): StateMachineDecision {
  const { actionExecuted, artifactExists, signals, state } = input;

  if (state.terminal !== undefined) {
    return { kind: "terminate", stateId: state.id, terminal: state.terminal };
  }

  const actionKind = state.action?.kind;
  const isParked = actionKind === "wait" || actionKind === "merge_pr";

  if (!isParked && !actionExecuted && state.action !== undefined) {
    return { action: state.action, kind: "execute_action", stateId: state.id };
  }

  const unmet = unmetPredicate(state.completeWhen, signals, artifactExists);
  if (unmet !== undefined) {
    return {
      kind: "blocked",
      reason: `state ${state.id} complete_when ${unmet}`
    };
  }

  for (const transition of state.transitions) {
    if (
      unmetPredicate(transition.when, signals, artifactExists) === undefined
    ) {
      return {
        kind: "advance",
        reason: describeTransition(state.id, transition.when, transition.to),
        to: transition.to
      };
    }
  }

  if (isParked) {
    const reason =
      actionKind === "merge_pr"
        ? `state ${state.id} merge_pr predicates not yet satisfied`
        : `state ${state.id} wait predicates not yet satisfied`;
    return {
      kind: "stay_waiting",
      reason
    };
  }

  return {
    kind: "blocked",
    reason: `state ${state.id} has no transition matching observed signals`
  };
}

// Returns a description of the first unsatisfied predicate, or undefined when
// the whole map holds. Signal predicates compare by strict equality against the
// observed map; artifact predicates ask the resolver instead, because their
// value is the query's argument rather than an expected observation.
function unmetPredicate(
  predicates: WorkflowPredicateMap,
  signals: StateMachineSignals,
  artifactExists: ArtifactExistsResolver | undefined
): string | undefined {
  for (const [key, expected] of Object.entries(predicates)) {
    if (workflowPredicateEvaluation(key) === "artifact") {
      const unmet = unmetArtifactPredicate(key, expected, artifactExists);
      if (unmet !== undefined) {
        return unmet;
      }
      continue;
    }
    const actual = signals[key];
    if (actual !== expected) {
      return `predicate ${key} not satisfied (expected ${describeValue(expected)}, got ${describeValue(actual)})`;
    }
  }
  return undefined;
}

function unmetArtifactPredicate(
  key: string,
  expected: WorkflowPredicateValue,
  artifactExists: ArtifactExistsResolver | undefined
): string | undefined {
  const paths = artifactPredicatePaths(expected);
  if (paths === undefined) {
    return `predicate ${key} not satisfied (${describeValue(expected)} is not a workspace-relative path or list of paths)`;
  }
  if (artifactExists === undefined) {
    return `predicate ${key} not satisfied (no run workspace available to check ${paths.join(", ")})`;
  }
  const missing = paths.filter((candidate) => !artifactExists(candidate));
  if (missing.length > 0) {
    return `predicate ${key} not satisfied (missing from the run workspace: ${missing.join(", ")})`;
  }
  return undefined;
}

function describeTransition(
  fromStateId: string,
  when: WorkflowPredicateMap,
  to: string
): string {
  const entries = Object.entries(when);
  if (entries.length === 0) {
    return `state ${fromStateId} advanced to ${to}`;
  }
  const predicates = entries
    .map(([key, value]) => `${key}=${describeValue(value)}`)
    .join(", ");
  return `state ${fromStateId} advanced to ${to} via ${predicates}`;
}

function describeValue(value: WorkflowPredicateValue | undefined): string {
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value);
}
