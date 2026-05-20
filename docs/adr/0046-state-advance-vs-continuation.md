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
`RunController.executeStateAdvance` whenever the FSM predicate engine advanced the workflow to a
non-terminal next state for a `workflow.source.kind=raw_fsm` run. The per-state
`ClassifiedTerminal` does **not** gate ordinary advances: a step that exits `provider_success: true`
without committing (a deterministic `no_workspace_changes` outcome) still advances when a
transition matches on `provider_success: true` alone, because the state machine — not the
classification of the per-state result — owns the "what runs next" decision.

Transient provider/infrastructure failures are the narrow exception while retry budget remains. If
a `failed` / `transient` outcome still has retry budget, Symphonika defers non-terminal FSM effects
that match the failure signals (`state_advance` and `wait_park`) and retries the same state first.
Terminal `failure` / `blocked` transitions still take effect immediately and synthesize a
deterministic `workflow_terminal_*` outcome, because the workflow author has explicitly declared a
terminal verdict. Once the retry budget is exhausted, the final attempt's signals are evaluated by
the FSM normally, so a matching non-terminal fallback may advance the walk.

The same rule applies to `wait_park`. Two concrete consequences:

- `scheduleNext` evaluates the `stateAdvance` / `waitPark` branches before the failed-deterministic
  early-return. Otherwise a planning step that legitimately advances on `provider_success: true`
  but did not commit would never spawn its implementer.
- `applyTerminalLabels` honors an `fsmContinuing` flag (set when `workflowOutcome.advancedToState
  !== null || workflowOutcome.parkAsWait === true`) and skips `sym:failed` when the workflow is
  continuing. Subsequent applyTerminalLabels calls only remove `sym:running`, so without this
  gate a plan→implement workflow that legitimately advanced through a no-commit planning step
  would stay externally marked failed even after a later state succeeded.

State advance:

- skips the continuation cap entirely (the FSM bounds the walk via terminal states);
- yields to transient retry only while retry budget remains; the retry re-enters the same FSM state
  and carries the same mid-walk label-immunity bit when the failed state was itself reached via
  state advance;
- skips the `labels_all` / `labels_none` re-check (the FSM, not the issue label set, decides the
  next state). Only the issue's open/closed state is re-verified to avoid acting on a closed issue.
  `reconcileActiveRuns` honors the same rule for in-flight state-advance runs, and `executeRetry`
  honors it for scheduled retries of state-advance runs: both still cancel with `CLOSED_ISSUE`
  when the issue closes, but skip the labels re-check that would otherwise cancel the run with
  `ELIGIBILITY_LOSS` mid-walk;
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
