import type {
  ExpandedWorkflow,
  ExpandedWorkflowState,
  WorkflowAction,
  WorkflowPredicateMap,
  WorkflowPredicateValue
} from "../workflow.js";

export type StateMachineDecision =
  | { action: WorkflowAction; kind: "execute_action"; stateId: string }
  | { kind: "terminate"; stateId: string; terminal: string }
  | { kind: "advance"; reason: string; to: string }
  | { kind: "blocked"; reason: string };

export type StateMachineSignals = WorkflowPredicateMap;

export function findWorkflowState(
  workflow: ExpandedWorkflow,
  stateId: string
): ExpandedWorkflowState | undefined {
  return workflow.states.find((state) => state.id === stateId);
}

export function decideNextStep(input: {
  actionExecuted: boolean;
  signals: StateMachineSignals;
  state: ExpandedWorkflowState;
}): StateMachineDecision {
  const { actionExecuted, signals, state } = input;

  if (state.terminal !== undefined) {
    return { kind: "terminate", stateId: state.id, terminal: state.terminal };
  }

  if (!actionExecuted && state.action !== undefined) {
    return { action: state.action, kind: "execute_action", stateId: state.id };
  }

  const unmet = unmetPredicate(state.completeWhen, signals);
  if (unmet !== undefined) {
    return {
      kind: "blocked",
      reason: `state ${state.id} complete_when predicate ${unmet.key} not satisfied (expected ${describeValue(unmet.expected)}, got ${describeValue(unmet.actual)})`
    };
  }

  for (const transition of state.transitions) {
    if (predicateMapMatches(transition.when, signals)) {
      return {
        kind: "advance",
        reason: describeTransition(state.id, transition.when, transition.to),
        to: transition.to
      };
    }
  }

  return {
    kind: "blocked",
    reason: `state ${state.id} has no transition matching observed signals`
  };
}

function unmetPredicate(
  predicates: WorkflowPredicateMap,
  signals: StateMachineSignals
):
  | {
      actual: WorkflowPredicateValue | undefined;
      expected: WorkflowPredicateValue;
      key: string;
    }
  | undefined {
  for (const [key, expected] of Object.entries(predicates)) {
    const actual = signals[key];
    if (actual !== expected) {
      return { actual, expected, key };
    }
  }
  return undefined;
}

function predicateMapMatches(
  predicates: WorkflowPredicateMap,
  signals: StateMachineSignals
): boolean {
  return unmetPredicate(predicates, signals) === undefined;
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
