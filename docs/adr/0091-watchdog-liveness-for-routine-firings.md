# Watchdog liveness for running Routine Firings

Status: Accepted

Routine Firings consume the same global and per-Project in-flight capacity as issue Runs. They also
participate in the non-overlap gate: while a firing remains non-terminal, a recurring Routine whose
`allow_overlap` is false advances each later clock event as an `overlap` skip.

The first Routine slices had no live-daemon liveness path. `reconcileWatchdog` sampled only `runs`,
while `reconcileLeakedRoutineFirings` swept `routine_firings` only at startup. If a provider wedged
without crashing the daemon, the firing stayed `running` forever, every later event was skipped,
and the dispatch promise never reached the `finally` that releases its `ActiveRunRegistry` slot.

## Decision

The Watchdog samples every Routine Firing in `state = 'running'` whose cancellation has not already
been requested. It uses the same Progress Signal as an issue Run: tool calls, provider progress or
thinking markers, Workspace Digest changes, distinct turn ids, output-token growth, and streamed
assistant messages. The firing target's effective Project `watchdog.grace_minutes`,
`watchdog.mtime_ignore`, and `watchdog.mtime_include` apply. Routine prompts have no Workflow
Contract, so there is no Routine `evidence.ignore` layer.

Routine samples use dedicated durable tables keyed by `firing_id`:

- `routine_watchdog_samples` holds the latest sample;
- `routine_watchdog_sample_history` keeps append-only evidence; and
- `routine_watchdog_turn_ids` remembers distinct provider turn ids.

The tables are separate from the Run-keyed equivalents because `watchdog_samples.run_id` has a
foreign key to `runs`, and a Routine Firing is deliberately not a Run. A firing has one provider
attempt and no retry generation. Sample writes, turn-id writes, and the terminal cancellation latch
are conditional on the firing still being running and not already cancelled, fencing provider
completion and operator-cancellation races.

When the idle grace expires, the Watchdog atomically records `cancel_requested = 1` and
`cancel_reason = 'no_progress'`, then requests cancellation through the shared active-run registry.
The Routine dispatcher treats that reason differently from an operator or shutdown cancellation:
it preserves `failed / no_progress` over the provider's cancellation-produced exit, completes the
ordinary outcome and commits-ahead evidence path, and releases capacity in its existing `finally`.
The firing remains non-terminal until that lifecycle settles, so Routine Fan-out delivery cannot
observe a prematurely terminal leg with incomplete outcome evidence.

Routine Firings do not gain a `stale` state. `stale` is an issue-Run verdict coupled to operational
labels and explicit stale-claim recovery; Routine Firings have no corresponding claim label to
clear. A provider that violated the firing's liveness contract is a terminal failed firing, with
the shared `no_progress` reason carrying the precise classification.

The output-token convergence budget and `max_run_minutes` remain issue-Run-only. Output-token
growth still contributes to a firing's liveness signal, but an absolute Routine bound is the
Routine declaration's optional `timeout_minutes`. This preserves ADR 0067's distinction between a
declared firing deadline and progress liveness.

## Consequences

- A provider wedge on a live daemon is cancelled after the configured grace instead of suppressing
  every future Routine clock event.
- Once cancellation settles, both the in-memory concurrency slot and the durable non-overlap gate
  are released, so the next due recurring event can launch a replacement.
- A daemon restart is no longer required for recovery; the startup orphan sweep remains responsible
  only for work whose owning daemon process was actually lost.
- Operators can distinguish the failure from a declared deadline (`firing_timeout`) and from an
  explicit cancellation (`cancelled`) through `terminal_reason = 'no_progress'`.

## Alternatives considered

**Run the startup orphan sweep periodically.** Rejected. It cannot distinguish healthy live
firings from abandoned ones and would fail every queued, preparing, or running firing on a live
daemon.

**Add a dispatcher-local staleness timer.** Rejected. It would duplicate the Watchdog's Progress
Signal, grace policy, Project overrides, and sampling races while producing a second definition of
liveness.

**Add `stale` to `RoutineFiringState`.** Rejected. It would imply the issue-Run stale-label and
operator-clear workflow where none exists. `failed / no_progress` carries the needed terminal
classification without widening every Routine state surface.

**Apply the convergence budget and Run wall-clock cap too.** Rejected for this slice. The budget is
defined per issue-Run attempt, and the cap is defined from an issue Run's claim. Routine Firings
already have an explicit per-declaration absolute deadline; silently layering a second absolute
policy over them would change that contract.

## Numbering

ADR `0090` is the most recent number in tree; this ADR is `0091`.
