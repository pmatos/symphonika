# Asynchronous Routine Notification Delivery

## Problem

Routine Firing SMTP delivery starts after the firing releases its concurrency slot, but its promise
remains part of the `dispatchDueRoutines` task set. Ready Routine Fan-out summaries are also delivered
before that function returns. A slow SMTP relay therefore keeps routine dispatch open after provider
work is terminal and delays later orchestration. Simply detaching those promises would let daemon
shutdown close the Run Store while a delivery or its evidence write is still in progress.

## Decision

Add a daemon-owned in-flight notification module with two operations:

- enqueue a best-effort asynchronous delivery task; and
- settle every currently or subsequently enqueued task.

The module owns promise tracking and catches unexpected task failures so a detached delivery cannot
become an unhandled rejection. Source-specific notification code continues to own policy, rendering,
delivery-state persistence, secret redaction, and detailed failure logging.

`dispatchDueRoutines` enqueues each terminal Routine Firing notification after unregistering its
active-run slot. After every admitted firing reaches a terminal state, it enqueues the ready Routine
Fan-out delivery pass. Neither delivery is awaited by routine dispatch. `fireRoutineNow` uses the same
module and resolves its completion promise after the terminal firing has enqueued its notification,
not after SMTP settles.

The daemon creates one module for its full lifetime and passes it to scheduled and manual Routine
Firing paths. Graceful shutdown closes admission and cancels providers as it does today, waits for
scheduled work and in-flight dispatches so no producer can enqueue more routine delivery work, then
settles the notification module before closing SQLite. Daemon-health notification settlement remains
after this drain. Durable issue-Run digests retain their existing restart-oriented pending semantics;
they are not routine dispatch work.

Both per-firing and grouped fan-out SMTP delivery use the module. Leaving fan-outs synchronous would
preserve another routine-notification delay on the same dispatch interface and contradict the goal of
decoupling routine delivery from orchestration.

## Error Handling

Expected SMTP failure and timeout remain source-specific durable evidence: Routine Firings record
`notification_state = failed`, while Routine Fan-outs return to `pending` for retry. The in-flight
module logs an unexpected exception that escapes a delivery task and resolves it as best effort, so
shutdown can always finish draining. Notification failure never changes a Run, Routine Firing, or
daemon tick outcome.

## Public Test Seams

1. Through `dispatchDueRoutines`, a terminal firing can begin a blocked SMTP delivery while dispatch
   returns; settling the in-flight notification module later persists the delivery result.
2. Through `startDaemon().stop()`, shutdown remains pending while a routine SMTP delivery is in
   flight and completes only after the delivery and its evidence write settle.

These tests use a fake Notification Sink, the existing external transport seam. They do not inspect
the module's internal promise set or mock source-specific notification code.

## Rejected Alternatives

Returning a second notification promise from every routine dispatch result would spread aggregation
and shutdown ordering across scheduled dispatch, manual firing, embedders, and tests. A durable
notification worker would improve crash recovery but needs durable report-message inputs that are
not currently stored in the firing row; that larger persistence change is not required to drain
graceful shutdown safely.
