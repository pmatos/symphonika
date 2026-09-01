# Slot-owned Run deadlines

ADR 0089 added `watchdog.max_run_minutes`, but its sampled enforcement applies only after a Run
reaches `running`. A Run reserves concurrency capacity earlier. A hung cache fetch, worktree command,
retry claim-label write, or running-label write could therefore retain a slot indefinitely without
ever becoming a Watchdog sampling candidate. Expanding the sampling query to preparation states
would record a verdict without stopping the work: before provider attachment, the in-flight entry
had no cancellation mechanism, and the lifecycle releases its slot only after the blocked await
settles. A retry also reserves a slot while its reused durable row may still read `failed`, so no
fixed list of active states accurately describes the resource being protected.

## Decision

Each issue Run slot reservation gets a **Run Slot Deadline** when the effective Watchdog is enabled
and `max_run_minutes` is non-zero. It is an `AbortController` plus a timer whose absolute expiry is
derived from the Run row's original `created_at`, not from the attempt or reservation time. A fresh
claim arms it immediately after `reserveSlot`; every retry reservation creates a new timer for only
the time remaining since the original claim. An already-expired retry therefore times out as soon
as it owns a slot, even while its row still reads `failed`. Delayed work that owns no slot owns no
timer.

The current effective Watchdog policy is snapshotted at each reservation. A reload can therefore
affect a later retry reservation, while it does not replace a timer already protecting preparation.
The sampled `running`-state Watchdog continues to resolve current policy on every pass. This keeps
the preparation mechanism independent of reconciliation without allowing a new attempt to reset
the Run's age. When no valid runtime snapshot has ever loaded, the policy is unavailable rather
than defaulted (ADR 0092), and an unavailable policy arms no deadline: substituting the default cap
would fabricate an expiry from configuration the operator never supplied. That state cannot admit a
Run in the first place, since a daemon without a snapshot has no Projects to dispatch.

Before provider attachment, the in-flight registry binds cancellation to the deadline's abort
handler instead of a no-op. The same signal is threaded through issue Workspace preparation and
every Git command it starts. On POSIX, the existing process-group teardown sends SIGTERM and then
SIGKILL and is awaited before the lifecycle releases the slot. Retry `sym:claimed` writes and
pre-provider `sym:running` writes carry the signal into Octokit. Local setup awaits that cannot
accept a signal are raced against the deadline so they cannot retain capacity. After provider
attachment, expiry also uses the existing provider cancellation path.

Expiry is decided by actual in-memory slot ownership, not durable Run state. In the same event-loop
turn, the controller proves that `activeRuns` still contains the Run and executes a synchronous
Run-store compare-and-set. The update:

- has no Run-state or `watchdog_generation` predicate;
- requires `cancel_requested = 0`;
- refuses to replace an existing `no_progress`, `no_convergence`, or `run_timeout` verdict;
- writes `state = "stale"`, `terminal_reason = "run_timeout"`, deterministic classification, and
  pending notification evidence together.

The CAS winner requests cancellation and emits the Watchdog-termination observer event. A sampled
Watchdog verdict, a slot timer, and any later duplicate timer therefore produce only one observer
event. If attempt setup already passed a write that changes only `state`, its finalization
reasserts the winning Watchdog state while preserving the reason and the notification's current
delivery state. This covers `queued -> stale -> preparing_workspace` and `stale -> running`
clobbers without allowing a later Watchdog reason to replace the winner or re-enqueueing an
already-sent notification.

Disabled Watchdog policy, `max_run_minutes: 0`, a missing Run row, and an unparseable `created_at`
arm no timer. A Run
Slot Deadline is Run-scoped but not Run-chain-scoped: continuations and State Advances create new
Run rows and therefore new origins, matching ADR 0089.

## Consequences

`global.max_in_flight` and per-Project capacity can no longer be retained indefinitely by a Run
wedged after reservation but before provider execution, provided its wall-clock cap is enabled.
Workspace Git processes are actually stopped rather than merely accompanied by a stale database
row. Slot release still happens in the lifecycle's unconditional `finally`, after cancellable
workspace preparation has settled, so capacity and cleanup evidence remain aligned.

The sampled Watchdog stays `running`-only. Its Progress Signal, convergence budget, and sampled
wall-clock verdict remain attempt-generation-fenced as described by ADR 0054 and ADR 0089. The
Run Slot Deadline is the deliberate exception to ADR 0054's former statement that every Watchdog
mutation is `running`- and generation-conditional: it protects a Run-scoped in-memory resource,
and its state-independent CAS is safe only while the caller synchronously proves slot ownership.

The initial fresh `sym:claimed` write still precedes Run-row creation and slot reservation, so it has
no Run origin to measure from and sits outside the Run-scoped deadline. It cannot retain concurrency
capacity, but it is not therefore harmless: it runs while `dispatchMutex` is held, so a hung request
stalls every dispatch rather than one slot. It carries its own bound under the same policy, measured
from the write rather than from the Run's origin, which the Run row records moments later. Retry
claim writes occur after reservation and are covered by the Run-scoped deadline itself.

## Alternatives considered

**Sample `queued` and `preparing_workspace`.** Rejected because it neither stops a hung subprocess
nor reaches a retry reservation whose row reads `failed`. It can create a stale row while leaving
the slot held forever.

**Start a new timeout for every attempt.** Rejected because retries could reset the outer bound and
make one Run unbounded. The original Run claim remains the time origin.

**Fence expiry with `watchdog_generation`.** Rejected because that generation identifies one
attempt's sampled Progress Signal. Slot ownership and the wall-clock origin belong to the Run, and
a newer retry must not invalidate an already-expired deadline.

**Release the slot immediately when the timer fires.** Rejected because the Git process group and
owned staging-path cleanup may still be running. The deadline aborts work; the lifecycle releases
capacity after that work settles.

## Status

Accepted.

## References

- ADR 0052: dispatch mutex and in-flight reservations
- ADR 0053: configurable concurrency caps
- ADR 0054: Watchdog progress liveness
- ADR 0067: Routine Firing deadlines
- ADR 0071: durable issue-Run notification delivery
- ADR 0089: Watchdog Run wall-clock cap
- ADR 0092: Watchdog policy unavailable without a runtime snapshot
- Issues #605, #608, and #611

## Numbering

ADR `0092` is the most recent number in tree; this ADR is `0093`.
