import { describe, expect, it } from "vitest";

import type {
  ExpandedWorkflow,
  ExpandedWorkflowState,
  WorkflowAction,
  WorkflowActionKind,
  WorkflowPredicateMap,
  WorkflowPredicateValue,
  WorkflowSourceKind,
  WorkflowTransition
} from "../src/workflow.js";
import type {
  ExpandedWorkflow as CanonicalExpandedWorkflow,
  ExpandedWorkflowState as CanonicalExpandedWorkflowState,
  WorkflowAction as CanonicalWorkflowAction,
  WorkflowActionKind as CanonicalWorkflowActionKind,
  WorkflowPredicateMap as CanonicalWorkflowPredicateMap,
  WorkflowPredicateValue as CanonicalWorkflowPredicateValue,
  WorkflowSourceKind as CanonicalWorkflowSourceKind,
  WorkflowTransition as CanonicalWorkflowTransition
} from "../src/workflow/types.js";

type TypeEquals<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (
    <Value>() => Value extends Right ? 1 : 2
  )
    ? (<Value>() => Value extends Right ? 1 : 2) extends (
        <Value>() => Value extends Left ? 1 : 2
      )
      ? true
      : false
    : false;

type AssertTrue<Value extends true> = Value;

type PublicFacadeMatchesCanonicalWorkflowTypes = [
  AssertTrue<TypeEquals<WorkflowSourceKind, CanonicalWorkflowSourceKind>>,
  AssertTrue<TypeEquals<WorkflowActionKind, CanonicalWorkflowActionKind>>,
  AssertTrue<TypeEquals<WorkflowPredicateValue, CanonicalWorkflowPredicateValue>>,
  AssertTrue<TypeEquals<WorkflowPredicateMap, CanonicalWorkflowPredicateMap>>,
  AssertTrue<TypeEquals<WorkflowAction, CanonicalWorkflowAction>>,
  AssertTrue<TypeEquals<WorkflowTransition, CanonicalWorkflowTransition>>,
  AssertTrue<TypeEquals<ExpandedWorkflowState, CanonicalExpandedWorkflowState>>,
  AssertTrue<TypeEquals<ExpandedWorkflow, CanonicalExpandedWorkflow>>
];

describe("workflow shared types", () => {
  it("keeps the public workflow facade aligned with the canonical shared types module", () => {
    const compileTimeAssertions: PublicFacadeMatchesCanonicalWorkflowTypes = [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true
    ];

    expect(compileTimeAssertions).toHaveLength(8);
  });
});
