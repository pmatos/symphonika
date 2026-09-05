export type WorkflowSourceKind = "markdown" | "raw_fsm";

export type WorkflowActionKind =
  | "agent"
  | "close_issue"
  | "comment"
  | "fail"
  | "label_issue"
  | "merge_pr"
  | "wait";

// `artifact_exists` takes a path or a list of paths; every other predicate is
// a scalar compared by strict equality. See src/workflow/predicates.ts for
// which keys evaluate which way.
export type WorkflowPredicateValue = boolean | number | string | string[];

export type WorkflowPredicateMap = Record<string, WorkflowPredicateValue>;

export type WorkflowAction = {
  kind: WorkflowActionKind;
  // `close_issue`'s closing comment, or `comment`'s posted comment body.
  body?: string;
  // `label_issue`'s labels to add.
  labels?: string[];
  method?: string;
  prompt?: string;
  provider?: AgentProviderName;
  // `close_issue`'s GitHub close reason. Defaults to "completed" when omitted
  // (see fsm-expansion.ts's parseWorkflowAction).
  stateReason?: "completed" | "not_planned";
};

export type WorkflowTransition = {
  to: string;
  when: WorkflowPredicateMap;
};

export type ExpandedWorkflowState = {
  action?: WorkflowAction;
  completeWhen: WorkflowPredicateMap;
  id: string;
  terminal?: string;
  transitions: WorkflowTransition[];
};

export type ExpandedWorkflow = {
  contentHash: string;
  initial: string;
  name: string;
  source: {
    kind: WorkflowSourceKind;
    path: string;
  };
  states: ExpandedWorkflowState[];
  templateFiles: string[];
};
import type { AgentProviderName } from "../provider.js";
