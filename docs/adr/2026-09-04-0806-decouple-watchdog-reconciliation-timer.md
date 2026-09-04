# Decouple Watchdog reconciliation from the daemon poll tick

Status: Accepted

## Context

`reconcileWatchdog` — the pass that samples running Issue Runs and Routine Firings for liveness,
enforces the convergence budget and wall-clock cap, and drains a settled Routine Firing's durable
pending-notification bit (ADR 0091) — ran only from inside the daemon's `reconcile()`, itself
called once per poll tick. A `lastWatchdogSampleAt` timestamp throttled how often the block
*acted* within a tick, but it could never make `reconcileWatchdog` run more often than the tick
itself fires. `startDaemon`'s tick loop is scheduled by `pollTimer = setInterval(scheduleTick,
polling.interval_ms)`, and `polling.interval_ms` has no relationship to
`watchdog.sample_interval_seconds` — SPEC.md §6 and §12.4 document them as independent knobs. An
installation polling hourly with the default 60-second Watchdog sample interval delayed a settled
Routine Firing's grouped alert up to an hour, not the one sample interval SPEC.md §12.4 promised.

This was filed against PR #686 (`chatgpt-codex-connector`, P2) and deferred as issue #690: fixing
it needs an independent schedule for Watchdog reconciliation, decoupled from the poll tick's own
scheduling and shutdown-draining logic, which is materially larger than #686's own durability
fixes. ADR 0091 recorded the deferral in its Consequences section and pointed at this issue.

## Decision

Watchdog reconciliation gets its own `setInterval`, `watchdogTimer`, armed at
`watchdog.sample_interval_seconds` and completely independent of `pollTimer` /
`polling.interval_ms`. The block that used to live inline in `reconcile()` — resolve the current
service config, call `reconcileWatchdog`, forward terminations to `daemonHealthNotifications` — is
now `reconcileWatchdogPass()`, a standalone function no longer gated by the elapsed-time throttle
`lastWatchdogSampleAt` used to provide; the timer's own cadence *is* the gate now, so re-adding an
elapsed-time check on top would double-gate and (per the interaction between `setInterval`'s
monotonic clock and `Date.now()`) intermittently skip a fire, silently doubling the effective
interval — precisely the "looser than promised" failure mode this ADR fixes.

The timer's callback does not call `reconcileWatchdogPass()` directly. It calls
`scheduleWatchdogPass()`, which enqueues the pass onto the daemon's existing `scheduledWork`
promise chain (the same chain `scheduleTick` and `RunController`'s scheduled retry/continuation
callbacks already serialize through) and guards against re-entry with a `watchdogPassQueued` flag:
a timer fire that lands while a pass is already queued or running is dropped rather than piling up
a second queued pass. This preserves, without a new mutex, the invariant that held implicitly
before this change — at most one reconcile-family pass in flight at a time, because every one of
them used to run from inside the same serialized `tick()`. `stop()`'s existing `await
scheduledWork` therefore drains an in-flight or queued Watchdog pass for free; the only addition
`stop()` needed was `clearInterval(watchdogTimer)` alongside its existing `pollTimer` /
`systemdWatchdogTimer` clears.

`refreshWatchdogTimer()` re-arms the interval whenever it changes, called from the one place every
reload path already funnels through: `reloadConfigAndRecordOutcome()`. That covers the poll tick's
own reload, an editor save, the manual reload HTTP route, and the daemon's startup load, without a
second, parallel "did the config change" check. The timer is armed regardless of
`watchdog.enabled`: SPEC.md §12.4 requires terminal pending Routine Firing notifications to keep
draining even while sampling itself is disabled, and `reconcileWatchdog` already implements that
distinction internally (`sampleAndTerminate` returns early when disabled; the pending-notification
drain that follows it does not).

## Consequences

- Watchdog reconciliation's cadence is now `max(watchdog.sample_interval_seconds, pass duration)`
  from daemon startup onward, regardless of `polling.interval_ms`. A restart still waits up to one
  `sample_interval_seconds` for the timer to arm and produce its first pass, matching the prior
  restart behavior `lastWatchdogSampleAt = Date.now()` gave at process start.
- A manual poll trigger (`/api/poll-now`) no longer directly forces a Watchdog pass — the pass used
  to live inside the code path `/api/poll-now` shares with the scheduled tick, so triggering a poll
  incidentally triggered a Watchdog check too. It still indirectly speeds up cadence *changes*
  (a `sample_interval_seconds` edit takes effect as soon as the next reload, tick-driven or manual,
  runs `refreshWatchdogTimer()`), just not an individual pass.
- SPEC.md §12.4's bound is simplified from `ceil(sample_interval_seconds / (polling.interval_ms /
  1000)) * (polling.interval_ms / 1000)` seconds to a true one-sample-interval bound; ADR 0091's
  Consequences section is updated to match and to point here instead of at issue #690 directly.
- Concurrent reconciliation is still impossible by construction (the `scheduledWork` chain), so the
  fencing SPEC.md §12.4 already documents (state/generation-conditioned writes) continues to be a
  defense against an old attempt's async I/O finishing late, not against two simultaneous passes.

## Alternatives considered

**Keep the elapsed-time throttle and call the shared function from both the tick and the new
timer.** Rejected. Two independent triggers converging on one clock-based gate is exactly the setup
that intermittently skips a fire when `setInterval`'s monotonic timing and `Date.now()` disagree by
a millisecond — the timer already *is* the schedule; gating it again only reintroduces a smaller
version of the bug being fixed.

**Give the watchdog pass its own dedicated mutex instead of routing through `scheduledWork`.**
Rejected. It would work, but it adds a second concurrency primitive to reason about for no benefit
over reusing the chain every other scheduled daemon pass already serializes through, and it would
need its own `stop()` drain instead of getting one for free from the existing `await
scheduledWork`.

**Track the in-flight promise in `inflightDispatches` instead of `scheduledWork`.** Considered,
since `inflightDispatches` already exists for shutdown draining of work that runs *outside* the
mutex. Rejected because it does not serialize concurrent passes against each other or against
`reconcile()`'s other work the way `scheduledWork` does — it only tracks membership for draining,
so a slow pass and a fresh tick's `reconcile()` could still run concurrently, the exact new failure
mode this decision avoids.

## Numbering

New-format ADRs are named `YYYY-MM-DD-HHMM-slug.md` per `AGENTS.md`; this one is
`2026-09-04-0806`.
