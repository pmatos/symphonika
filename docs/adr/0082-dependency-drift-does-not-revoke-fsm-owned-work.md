# Dependency drift does not revoke FSM-owned Continuation Eligibility

Status: Accepted

## Context

ADR 0046 made an admitted raw-FSM walk immune to label drift because the FSM, rather than external
workflow labels, owns its next State Advance, retry, and wait transition. ADR 0081 later introduced
the Dependency Gate as a hard block with no override, but did not say whether a dependency linked
after a raw-FSM walk starts should revoke that ownership. Cancelling the next scheduled step can
orphan an already-opened pull request or strand `sym:claimed`, while resuming automatically would
require a new durable mid-walk suspension model.

## Decision

The Dependency Gate is an admission rule for fresh Dispatch Eligibility and label-controlled
Continuation Eligibility. "Hard block, no override" means neither of those scopes can bypass an
unresolved dependency. It is not a lease that revokes an already-admitted raw-FSM walk.

FSM-owned Continuation Eligibility checks only whether the Issue remains open. Once a raw-FSM walk
is admitted, its in-flight attempt, State Advances, waiting-row rechecks, and transient retries keep
going through label and dependency drift. Issue closure and explicit operator cancellation still
stop the walk. After the workflow instance terminates, any later fresh dispatch or label-controlled
Continuation must pass the Dependency Gate again.

The lifecycle asks this policy through the explicit `evaluateRunContinuationEligibility` interface
with `label_controlled` or `fsm_owned` scope. Dependency data remains present on refreshed Issue
snapshots; the eligibility question, rather than the availability of that data, decides whether it
applies.

## Considered options

- Cancelling the scheduled retry or State Advance reuses existing eligibility-loss behavior, but
  recreates the failure mode ADR 0046 prevents and depends on the unresolved claim-cleanup decision
  in issue #475.
- Parking until dependencies resolve best preserves both the gate and workflow ownership, but needs
  a durable suspended Planned Step distinct from raw-FSM wait/merge states. An in-memory reschedule
  would lose the walk on daemon restart and is not an acceptable substitute.
- Allowing one more step and gating a later transition makes the amount of post-drift work depend on
  timing without establishing a coherent ownership boundary.

## Consequences

An Issue can acquire an open dependency after dispatch and still finish more than one raw-FSM agent
state. This is a deliberate bounded exception for already-owned work, not a bypass operators can
use to dispatch known-blocked work. Compatibility workflows, label-controlled retries and
Continuations, and every fresh dispatch continue to fail closed on open or truncated dependency
state under ADR 0081.
