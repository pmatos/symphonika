# Run Lifecycle Interface

Status: proposed
Date: 2026-05-15

## Context

`RunController` currently exposes seven public async entrypoints. Each one is useful, but together
they make the Run lifecycle hard to inspect: the caller chooses a dispatch flavor and the controller
finds the lifecycle rule inside private helper choreography. The proposed next shape keeps
`RunController`'s current behavior intact while introducing a smaller interface:

```ts
type RunLifecyclePlanner = (input: {
  state: RunLifecycleState;
  event: LifecycleEvent;
}) => PlannedRunLifecycleStep;
```

This proposal PR only publishes the draft value shapes in
`src/lifecycle/run-lifecycle-interface.ts`. It does not move existing runtime code.

## Proposed Values

### RunLifecycleState

`RunLifecycleState` is the durable lifecycle posture of a Run or dispatch slot:

- `idle` means no Run has been selected yet.
- `queued`, `preparing_workspace`, and `running` model provider-backed Runs with their origin
  (`fresh`, `retry`, `continuation`, `state_advance`, or `review_followup`).
- `waiting` models a persisted wait or merge state row that must be reconciled by polling.
- `terminal` models completed rows (`succeeded`, `failed`, `cancelled`, `stale`, or legacy
  `input_required`).

### LifecycleEvent

`LifecycleEvent` is the stimulus that asks the lifecycle module to decide what should happen next:

- `fresh_dispatch_requested`
- `retry_due`
- `continuation_due`
- `state_advance_due`
- `wait_park_due`
- `waiting_run_recheck_due`
- `review_followup_requested`
- `provider_attempt_completed`
- `issue_closed_observed`
- `eligibility_lost_observed`

The daemon should eventually emit events instead of constructing the current entrypoint payloads
directly.

### PlannedRunLifecycleStep

`PlannedRunLifecycleStep` is the next effect the lifecycle module wants the runtime to perform:

- start a label-eligible run
- start a retry attempt
- start an FSM-owned run
- start a review follow-up run
- schedule retry, continuation, state advance, or wait re-evaluation
- re-evaluate a waiting row
- cancel a run
- mark an issue failed
- do nothing with an explicit reason

The important grain is that policy is carried by the step kind. Label-driven steps and FSM-owned
steps are different values, so callers do not need to pass a separate `respectsIssueLabels` boolean.

## Entrypoint Mapping

| Current entrypoint | Lifecycle event | First planned step |
| --- | --- | --- |
| `dispatchOneFresh` | `fresh_dispatch_requested` | `start_label_eligible_run` |
| `executeRetry` | `retry_due` | `start_retry_attempt` |
| `executeContinuation` | `continuation_due` | `start_label_eligible_run` |
| `executeStateAdvance` | `state_advance_due` | `start_fsm_owned_run` |
| `executeWaitPark` | `wait_park_due` | `re_evaluate_waiting_run` |
| `reEvaluateWaitingRun` | `waiting_run_recheck_due` | `re_evaluate_waiting_run` |
| `dispatchReviewFollowup` | `review_followup_requested` | `start_review_followup_run` |

`executeWaitPark` and `reEvaluateWaitingRun` intentionally converge on the same planned step. The
former is just the scheduled callback for a waiting row; the latter is the actual polling
re-evaluation.

## ADR Rule Placement

| ADR | Rule owner in the new shape |
| --- | --- |
| ADR 0019, capped continuations | The `provider_attempt_completed:success` planner branch decides whether to emit `schedule_continuation` or `mark_issue_failed` with `cap_reached:*`. |
| ADR 0020, retry transient only | The failed-outcome planner branch emits `schedule_retry` only for transient classifications; `retry_due` revalidates before `start_retry_attempt`. |
| ADR 0022, closed issue cancellation | Shared refresh gates for retry, continuation, state advance, and waiting recheck emit `cancel_run` with `closed_issue`. |
| ADR 0023, eligibility-loss cancellation | Only label-eligible planned steps can emit `cancel_run` with `eligibility_loss`; FSM-owned steps skip that branch. |
| ADR 0046, state advance vs continuation | `start_fsm_owned_run` and `schedule_state_advance` bypass continuation cap and label re-check by construction. |
| ADR 0047, poll-driven wait states | `schedule_wait_park` and `re_evaluate_waiting_run` keep wait states as persisted rows reconciled by polling, not provider dispatches. |

## `respectsIssueLabels`

Today the boolean is threaded through `RunController`, `ActiveRunRegistry`, and reconciliation. The
proposal removes it from the caller-visible lifecycle interface:

- `start_label_eligible_run` means labels are part of the gate.
- `start_fsm_owned_run` means only issue open/closed state is checked.
- `re_evaluate_waiting_run` follows the waiting-row rule from ADR 0047.
- `start_retry_attempt` keeps a temporary `retryScope` because retry can apply to either a
  label-driven run or an FSM-owned run; during migration this replaces the current boolean at the
  boundary, then can collapse into separate retry step kinds if the implementation reads better.

## Test Migration

Tests expected to survive verbatim:

- `tests/property-invariants.test.ts`
- `tests/classify-failure.test.ts`
- `tests/terminal-reason.test.ts`
- `tests/pr-signal-projection.test.ts`

Tests expected to get simpler by driving events and planned steps instead of seven entrypoints:

- `tests/dispatch-continuation.test.ts`
- `tests/dispatch-retry.test.ts`
- `tests/wait-state.test.ts`
- `tests/cap-reached-context.test.ts`

Tests expected to be rewritten around the new planner boundary:

- `tests/state-machine-dispatch.test.ts`
- `tests/daemon-dispatch.test.ts`

## Migration Sketch

1. Add a planner that accepts `RunLifecycleState` and `LifecycleEvent` and returns a
   `PlannedRunLifecycleStep`.
2. Route one existing entrypoint through the planner without changing behavior.
3. Repeat for each entrypoint, keeping every PR independently reviewable.
4. Move `respectsIssueLabels` policy behind planned step kinds.
5. Let `daemon.ts` emit lifecycle events instead of constructing entrypoint-specific payloads.

No new ADR is proposed in this PR. The interface is deliberately marked `proposed`; if reviewers
accept this shape as load-bearing, the accepted follow-up can promote the decision into an ADR
before runtime migration continues.
