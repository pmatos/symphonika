# Watchdog: a wall-clock cap on a Run's lifetime

Routine Firings can declare `timeout_minutes` and are cut off at a real deadline (ADR 0067). Issue
Runs had no equivalent. Their only bound was the Watchdog, and both of the Watchdog's rules are
*conditional* on what the Run is doing: `no_progress` (ADR 0054) fires when nothing observable
happens, `no_convergence` (ADR 0086) fires when a Run's cumulative output tokens cross a budget. A
Run that keeps trickling real output, slowly, indefinitely, satisfies the first on every tick and
can stay far below the second forever.

Issue #605 is that Run. Three vow Runs claimed on 2026-08-30 between 15:55 and 16:05 were still in
flight the next morning:

| run | issue | claimed | terminated | elapsed |
| --- | --- | --- | --- | --- |
| `601b78ff-4d27-422a-9057-55eb30fd2461` | vow#1113 | 15:55:53Z | 05:25:54Z | 13h30m |
| `fef25024-8267-43a4-b1c9-5b7dcbef4a74` | vow#1114 | 16:00:53Z | 04:32:53Z | 12h32m |
| `92cf4e59-0e1e-4412-b1d2-0fa325f86c1b` | vow#1124 | 16:05:54Z | 05:10:55Z | 13h05m |

The Watchdog behaved correctly. `watchdog_sample_history` over 22:30–23:30Z shows `92cf4e59`
growing its normalized log about 1 KB per five minutes; `601b78ff` and `fef25024` sat unchanged for
forty-minute stretches and repeatedly re-armed `idle_since` without ever crossing vow's configured
180-minute grace window. They were making progress — just not at a rate worth a slot.

A slow Run is not free. Those three held three of the eight `global.max_in_flight` slots for half a
day, which is why four Projects in the 01:00 `refactor-audit` fanout were skipped with
`concurrency_cap`, and they each kept roughly 21 GB resident in `symphonika-providers.slice`,
saturating it and stalling the five firings that did launch (issue #603).

## Decision

The Watchdog gains a third, independent rule: a **wall-clock cap** on how long one Run may live.
When a sampled Run's age — `now` minus its `runs.created_at`, the instant it claimed its Issue —
reaches `watchdog.max_run_minutes`, the Watchdog transitions it to `stale` with
`terminal_reason = "run_timeout"` and cancels the provider through the existing
`activeRuns.requestCancel` path, leaving the Workspace intact. The cancellation is *issued* under
its own `CancelReason` (`run_timeout`), which the in-flight registry renders while the Run is still
live, so the three Watchdog verdicts are distinguishable there too. The durable distinguisher on
the finished row is `terminal_reason`, written in the same statement that marks the Run stale —
`markRunWatchdogStale` does not write the `cancel_requested` / `cancel_reason` columns, and
deliberately so: it reads `cancel_requested = 0` as its guard against a competing operator or
closed-issue cancel, so a Watchdog verdict that set that column would make itself
indistinguishable from the cancel it is meant to yield to.

The default is **360 minutes**, configurable at daemon scope and per Project. `0` disables the cap
and reproduces pre-0089 behaviour exactly.

### Run-scoped, not attempt-scoped

The rest of the Progress Signal is attempt-scoped: attempt start clears the latest sample and
advances the Watchdog generation, so a transient retry starts every baseline fresh (ADR 0054). The
cap deliberately is not. Its origin is the Run row's claim, so the age it measures accumulates
across workspace preparation, provider validation, and every retry attempt — because the resource
it protects is held for exactly that long: `reserveSlot` runs once per Run at claim time, not once
per attempt, and the provider memory follows the same shape. An attempt-scoped cap would be reset
by the retry path and could not bound what issue #605 actually describes.

**Measured from claim, enforced while running.** The origin spans preparation; enforcement does
not. The verdict is reached inside the Watchdog's sampling pass, and ADR 0054 restricts sampling to
`state = 'running'`, so a Run wedged before its provider starts is never evaluated against the cap.
That asymmetry is deliberate here rather than an oversight, and the reason is that widening the
state scope would not fix it: `reserveSlot` registers a no-op cancel handler, the slot is released
only by the lifecycle's `finally`, and `prepareIssueWorkspace` threads no `AbortSignal` into its
git calls — so marking a wedged `preparing_workspace` Run `stale` would record a timeout while the
slot, the subprocess, and the memory stay exactly as held. It would convert an unbounded slot hold
into an unbounded slot hold plus a `stale` row.

The pre-`running` window is a real gap, and it predates this ADR — nothing bounded a hung
preparation before it either. Closing it needs a genuinely cancellable deadline (an
`AbortController` armed at claim and threaded through `prepareIssueWorkspace`, whose git helpers
already accept a signal), sourced from actual slot ownership rather than from a fixed state list —
a hung retry claim, for instance, holds a slot while its row reads `failed`. That is its own slice
with its own race surface, and it amends ADR 0054's "every Watchdog mutation is conditional on the
`running` state" invariant, so it is tracked separately rather than folded in here.

It does not span a Run *chain*. A continuation (ADR 0019), an FSM state advance, and a shutdown
resume (ADR 0088) each write their own `runs` row through `claimAndPersistRun`, so each starts a
fresh cap. That is the right granularity: those are separate agent invocations that each re-claim
a slot, and the continuation cap already bounds how many of them there can be.

### Checked before the other two rules

The cap is evaluated first, ahead of the convergence budget and the idle clock, for the same reason
ADR 0086 put the budget ahead of the idle clock: a Run gets exactly one terminal reason, and it
should be the outermost bound it breached. Telling an operator "no progress" about a Run that ran
out of time hides the rule that actually stopped it and makes the cap impossible to tune from
operational data.

### An unparseable claim timestamp never ages a Run

`run_timeout` is the only Watchdog verdict that could fire against a Run doing everything right, on
the strength of one bad column. A `created_at` that does not parse is therefore read as "age
unknown" and never as "infinitely old", and clock skew that places the claim in the future floors
the age at zero rather than handing the cap a negative number.

## Why this does not contradict ADR 0086

ADR 0086 evaluated a wall-clock deadline as an alternative to the convergence budget and rejected
it: "blunt: kills legitimately long verify-heavy Runs at the same threshold." That judgement stands
and is not reversed here. The cap is not an alternative to the budget — it is an outer backstop
underneath it, and the two differences that matter are the threshold and the escape hatch:

- ADR 0086 measured a 4-hour deadline, which fires on a Run doing honest verification work. 360
  minutes sits above every healthy Run this orchestrator has produced, and still catches both
  incidents that motivated ADR 0086 (6.5h and 14.2h) as well as all three Runs in issue #605.
- A Project whose Runs legitimately take a working day raises or waives its own cap, exactly as vow
  already raises `grace_minutes` to 180 and `output_token_budget` to 400000. The blunt-instrument
  objection applies to a single global deadline with no override; it does not apply to a per-Project
  ceiling whose default only fires on Runs that have already stopped being worth their slot.

The budget remains the rule that catches a busy non-converging Run early and proportionally. The
cap catches only what nothing else can: a Run that is neither idle nor expensive, just endless.

## What this does not do

Issue #605 also suggests a *rate-of-progress* signal — "the current watchdog only asks whether
progress happened since the last sample, not whether the rate is viable". That is a genuinely
separate rule with its own threshold and its own false-positive profile (a long silent `make
verify` is a legitimate zero-rate window), and it needs replayed sample history to calibrate the
way ADR 0086 calibrated the budget. It stays deferred. The wall-clock cap bounds the damage in the
meantime, which is what the incident needed.

## Configuration

```yaml
watchdog:
  enabled: true
  grace_minutes: 30
  output_token_budget: 150000
  max_run_minutes: 360 # 0 disables the wall-clock cap
  sample_interval_seconds: 60
projects:
  - name: vow
    watchdog:
      grace_minutes: 180
      output_token_budget: 400000
      max_run_minutes: 720
```

`max_run_minutes` is a non-negative integer at both scopes and merges independently over the
daemon-scope block through the same defensive reload pipeline as the rest of the Service Config, so
a bad override falls back to the last known-good snapshot. As with `grace_minutes`, a Project cannot
opt into a daemon-disabled Watchdog.

## Operator surface

`run_timeout` joins the terminal-reason vocabulary everywhere `no_progress` and `no_convergence`
already appear — the `runs` listing, `show-run`, `status`, the HTTP API, and the local web UI —
because those surfaces render `terminal_reason` verbatim rather than from an allow-list. The Issue
keeps the state-derived `sym:stale` label it already gets for the other two verdicts; the reason,
not the label, is what distinguishes them.

`show-run` and the web UI's Watchdog section additionally render the Run's remaining time against
its cap whenever a cap is configured, so an operator can see a Run approaching the deadline before
it is stopped. `GET /api/runs/:id` exposes the same as `maxRunMs` and `runRemainingMs`. All of these
read the same effective clock as the rest of the Progress Signal — live for a `running` Run, pinned
to the last sample otherwise — so a terminated Run's countdown does not drift the longer nobody
looks at it.

## Interaction with existing decisions

- **ADR 0054 (progress liveness):** unchanged. The cap is checked before the liveness clock and
  independently of it, because a slow Run is never idle.
- **ADR 0086 (convergence budget):** unchanged, and still the earlier and more proportional of the
  two absolute bounds. See the section above.
- **ADR 0067 (routine deadlines):** Runs gain a wall-clock bound, but not the same mechanism, and
  the difference matters. A Routine Firing's deadline is declared per Routine and enforced by an
  `AbortController` the dispatcher races against every await, so it actually aborts workspace
  preparation. A Run's cap is Watchdog policy resolved per Project and reached by sampling, so it
  bounds a Run only once its provider is running. A Run that is *executing* is no longer unbounded;
  one wedged in preparation still is, per the section above.
- **ADR 0020 (retry transient only):** `run_timeout` is deterministic. The stopped Run is the
  terminal verdict, and a retry cannot hand the work a fresh cap.
- **ADR 0019 (capped continuations):** a `run_timeout` Run is terminal, so it spawns no
  continuation.
- **ADR 0038 (explicit stale clearing):** operators clear it like any other `stale` Run.
- **ADR 0053 (concurrency caps):** the cap is what makes `global.max_in_flight` a bound on
  throughput rather than only on instantaneous count.

## Numbering

ADR `0088` is the most recent number in tree; this ADR is `0089`.
