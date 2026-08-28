# Operator-forced self-update through the running daemon

ADR 0079 gave Symphonika an opt-in self-update, driven entirely by `UpdateCoordinator.tick()` on a
fixed six-hour cadence. That cadence has no operator override, and its two timings surprise anyone
watching a release land (issue #582):

- **A restart does not check.** `startDaemon` calls `reconcile()` and `launchWork()` directly and
  only then arms the poll timer, so the first `updateCoordinator.tick()` happens one full
  `polling.interval_ms` after boot.
- **Then it is every six hours**, from a hardcoded constant the Service Config cannot reach.

Observed on 2026-08-28: `v0.1.8` was cut at 07:03 UTC and the service restarted at 07:03:50 UTC.
The daemon came back on 0.1.7 with no update-related journal output whatsoever, and updated at
07:09:31 — on the first tick, five minutes after boot. Nothing was broken. The operator simply had
no way to distinguish "has not checked yet" from "checked and failed", because
`UpdateCoordinator.runCycle` returned in silence when `getLatestRelease()` yielded `skipped` (no
`GITHUB_TOKEN`) or `error` (API failure).

## Decision

Symphonika gains `symphonika update`, which forces one cycle immediately and reports what it did,
plus `--check` for a dry run. Four questions had to be settled.

### 1. The forced cycle runs inside the daemon, not standalone

`symphonika update` posts to the running daemon's local `/api/update-now` (discovered via
`daemon.json`, state-root-preflighted exactly as `poll-now` and `fire-now` are), and the daemon
answers by calling `UpdateCoordinator.runNow()`.

The alternative — a standalone CLI that stages and cuts over the install path directly — would
race the drain gate that is ADR 0079's central safety property. That gate lives in the daemon
process (`launchWork` and the `fireRoutine` handler read
`updateCoordinator.isDrainRequested()`; the coordinator polls `activeRuns.countInFlight()`), and a
second process has no view of either. A standalone cutover under a live daemon would rename the
install directory out from under running work with nothing refusing new admission meanwhile.

The cost is that `symphonika update` requires a running daemon and fails without one. That is the
right failure: with no daemon running there is nothing to force, and `service install` plus a
normal start already covers the cold path.

For the same reason the command honours `self_update` rather than overriding it. An operator who
wants the daemon to update flips the config; a CLI verb that bypassed an explicitly disabled flag
would make the flag mean less than it says. `--check` is exempt — reporting that a release exists
is most useful precisely when auto-update is off — and reports the flag's state alongside.

### 2. One ladder, two drivers

`runNow()` does not duplicate the check/download/verify/stage/smoke/drain/cutover ladder; it drives
the same `runCycle` that `tick()` does, passing a `report` callback. A tick passes a no-op. The two
paths differ only in what happens to the outcome, so there is exactly one ladder to keep correct,
and `runNow()` reuses the existing `inProgress` guard to refuse a second concurrent cycle.

`runNow()` also stamps `lastCheckAtMs`, so a forced run resets the six-hour cadence instead of
being followed by a redundant scheduled check.

### 3. The forced run answers at the drain gate, not at the end

A cycle that reaches the drain gate with runs in flight can legitimately sit there for hours —
ADR 0079's drain never cancels live work. Blocking the operator's terminal (and an HTTP request)
for that whole window would be indistinguishable from a hang.

So `runNow()` resolves at the cycle's **first reportable checkpoint**. Reaching the drain gate with
`countInFlight() > 0` is the one non-terminal checkpoint: the caller is told what is staged and how
many runs it is waiting on, and the cycle carries on in the background to cutover and restart
exactly as a tick-driven one would. Every other checkpoint is terminal.

### 4. The restart waits for the response to flush

A successful forced cutover ends in `systemctl --user restart --no-block symphonika.service`,
which SIGTERMs this process's whole cgroup (ADR 0079, decision #2). Requesting that restart in the
same turn as the HTTP response would race the response out of existence, and the operator would see
a dropped connection instead of `updated 0.1.7 -> 0.1.8` — the exact ambiguity #582 exists to
remove.

A forced cycle therefore reports its outcome, then pauses `forcedRestartGraceMs` (500 ms by
default) before requesting the restart. This is a grace period, not a synchronisation: it cannot
make the flush certain, only overwhelmingly likely on a loopback socket. The restart's real
evidence surface remains what ADR 0079 said it was — daemon-start health and systemd itself, not
this call's result. Tick-driven cycles skip the pause; nobody is waiting.

The outcome carries the restart disposition (`requested` vs `unavailable`) rather than reporting a
bare success, so an operator on a non-systemd host is told to restart by hand instead of being left
to infer it.

## Outcome vocabulary

`UpdateActionResult` (`src/update/coordinator.ts`) names every branch a cycle can end or pause at:
`disabled`, `in-progress`, `up-to-date`, `available` (`--check` only), `skipped`, `halted`,
`draining`, `updated`, `refused`, `error`. Each prints a distinct line, and `disabled`, `halted`,
`refused`, and `error` exit non-zero so the command is usable from a script.

`refused` is split out from `error` deliberately: a cutover refusal (the install path is a git
checkout, say) is a stable condition the operator has to resolve, not a transient failure a retry
might clear. It still travels the existing failure path, so `DaemonHealthNotifier` sees exactly what
it saw before.

## The swallowed check result

`runCycle` now logs `skipped` and `error` from `getLatestRelease()` at `warn` before returning.
Neither is fatal and neither reaches `DaemonHealthNotifier` — that judgement from ADR 0079 stands —
but silence is not the same as "non-fatal". A missing `GITHUB_TOKEN` was previously
indistinguishable in the journal from a healthy up-to-date check, which is what made the timing
above hard to diagnose in the first place.

## Consequences

- The six-hour cadence and the no-check-on-boot behaviour are both unchanged. `symphonika update`
  makes them tolerable rather than fixing them; a configurable check interval and a boot-time check
  remain open, and ADR 0079 already lists the former as a deliberate deferral.
- `symphonika status` still does not surface self-update state. `symphonika update` answers the
  "what is happening right now?" question well enough that the deferral in ADR 0079 stands.
- `/api/update-now` sits behind the same mutation authentication as every other mutating route
  (ADR 0075), so the browser surface could later expose a force-update control without new auth
  work.

## Numbering

ADR `0086` is the most recent number in tree; this ADR is `0087`.
