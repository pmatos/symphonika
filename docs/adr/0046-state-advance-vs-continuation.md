# Multi-state raw FSM dispatch is distinct from continuations

Symphonika executes raw FSM workflows by advancing one agent state per Run and linking sequential
states through `continuation_parent_run_id`. After ADR 0045 raw FSM workflows could run a single
agent state, but multi-state walking went through the same dispatch path as label-driven
continuations, which gated state advancement on `lifecycle.continuation.cap` and re-evaluated the
full issue eligibility filter (`labels_all` / `labels_none`) between states. Both gates are wrong
for FSM walking: the state machine is the source of truth for "what runs next", not the issue
labels, and the continuation cap is intended to bound repeated end-to-end attempts on the same
workflow rather than the length of a single workflow walk.

Symphonika models state advancement as a distinct dispatch kind, `state_advance`, scheduled by
`RunController.executeStateAdvance` whenever an agent state finishes with `outcome=success`,
`workflow.source.kind=raw_fsm`, and the FSM advanced to a non-terminal next state. State advance:

- skips the continuation cap entirely (the FSM bounds the walk via terminal states);
- skips the `labels_all` / `labels_none` re-check (the FSM, not the issue label set, decides the
  next state). Only the issue's open/closed state is re-verified to avoid acting on a closed issue.
  `reconcileActiveRuns` honors the same rule for in-flight state-advance runs: it still cancels
  with `CLOSED_ISSUE` when the issue closes, but skips the labels re-check that would otherwise
  cancel the run with `ELIGIBILITY_LOSS` mid-walk;
- creates the next Run via the existing `createContinuationRun` helper so the new row inherits
  `current_state_id` (the next state id was already persisted by `applyWorkflowOutcome`) and
  records `continuation_parent_run_id`, keeping linkage compatible with existing status surfaces;
- preserves the issue's `sym:claimed` label across the gap between states. Operational labels
  remain the fresh-dispatch guard that prevents a second daemon polling tick from claiming the
  same issue mid-walk.

Label-driven continuations remain a distinct concept. They keep the cap, the eligibility re-check,
and the `executeContinuation` path because their purpose is to re-dispatch the same workflow when
an operator (or the workflow itself) decides the issue should run again, not to advance the state
machine.

When a raw FSM agent state succeeds but no transition's `when` predicates match the observed
signals, the workflow instance is recorded as blocked: `terminal_state_id` is the stuck state id
and `state_transition_reason` describes the missing predicates. The Run row itself stays
`succeeded` because the agent state completed; the "blocked" status is a property of the workflow
instance, not the agent execution. No further state advance or continuation is scheduled. This
keeps the two-level model — Run is per-attempt evidence, workflow instance is the FSM walk —
visible to operators inspecting `current_state_id`, `terminal_state_id`, and the run state column
side by side.
