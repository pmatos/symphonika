export type WorkflowSourceKind = "markdown" | "raw_fsm";

export type WorkflowActionKind =
  | "agent"
  | "close_issue"
  | "comment"
  | "fail"
  | "label_issue"
  | "merge_pr"
  | "wait";

export type WorkflowPredicateValue = boolean | number | string;

export type WorkflowPredicateMap = Record<string, WorkflowPredicateValue>;

export type WorkflowAction = {
  kind: WorkflowActionKind;
  method?: string;
  prompt?: string;
  provider?: "codex" | "claude";
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
