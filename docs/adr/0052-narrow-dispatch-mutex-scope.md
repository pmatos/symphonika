# Narrow the dispatch mutex scope to the claim/persist section

`dispatchMutex` historically wrapped the entire fresh-dispatch path: candidate selection, the
`sym:claimed` label POST, the scheduler-cursor write, `runStore.createRun`, workspace preparation,
`provider.validate`, the `sym:running` label POST, attempt-row creation, and the full provider
event stream. The scheduled-callback wrapper in the daemon acquired the same mutex around every
retry/continuation/state-advance/wait-park fire. The practical effect was that at most one provider
run executed in the daemon at any time, even with multiple Projects each holding ready Project
Issues.

ADR 0047 documented the mutex's intended scope as "fresh-run dispatch and PR follow-up dispatch —
both of which create new rows or mutate `tracked_pull_requests`", which is the claim-and-persist
section, not the full provider lifecycle. The implementation drifted from the documented scope.

## Decision

`dispatchMutex` covers only the narrowed claim-and-persist critical section:

- candidate selection (`pickTargetFromCandidates`),
- token / provider validation that may fail the run before launch,
- the `sym:claimed` label POST,
- `runStore.recordProjectDispatchSelection` (scheduler cursor write),
- `runStore.createRun` / `createContinuationRun`,
- `activeRuns.reserveSlot` (the in-flight slot reservation).

Mutex acquire/release live inside `RunController.runFreshLifecycle` (and the equivalent reserved
section of `executeRetry` and `executeWaitPark`). Callers (`dispatchOneFresh`,
`executeContinuation`, `executeStateAdvance`, `dispatchReviewFollowup`) do not touch the mutex
directly. The daemon's `launchWork` no longer holds the mutex across the whole dispatch chain; it
fires `dispatchOneFresh` and lets the controller own the critical section.

Provider event streaming (`prepareIssueWorkspace`, `provider.validate`, the `sym:running` label
POST, `createAttempt`, and `iterateAttempt`'s event stream) runs **outside** the mutex.

## In-flight slot ownership

`InFlightRunRegistry.register` splits into two operations:

- `reserveSlot({ issueNumber, projectName, runId, respectsIssueLabels? })` — inserts an entry with
  a noop cancel handler. Called inside `claimAndPersistRun`, before mutex release, so subsequent
  picks (per-issue reservation and Slice-2 concurrency caps) observe the run.
- `attachProvider(runId, { cancel, provider, respectsIssueLabels? })` — binds the live provider
  cancel closure (and updates `respectsIssueLabels` once the workflow kind is known) onto the
  existing entry. Called inside `runAttemptLifecycle` once `provider.validate` has succeeded and
  the attempt row is committed.

`runAttemptLifecycle`'s `finally` unregisters the slot unconditionally so a throw between
`reserveSlot` and `attachProvider` (`loadWorkflow`, `prepareIssueWorkspace`, `provider.validate`,
the `sym:running` label POST, `createAttempt`) does not leak the slot.

If a reconcile tick flips `cancelRequested` between `reserveSlot` and `attachProvider`,
`runAttemptLifecycle` observes it at entry (`activeRuns.getInFlight(runId).cancelRequested`) and
aborts without launching the provider.

## Scheduled callbacks own their own mutex windows

The daemon's `schedule` wrapper no longer acquires `dispatchMutex` around `item.fire()`. Each
`execute*` path takes the mutex internally over its own critical section:

- `executeRetry` — re-asserts `sym:claimed` + `reserveSlot` inside the mutex; releases before
  `runAttemptLifecycle`.
- `executeContinuation` / `executeStateAdvance` / `dispatchReviewFollowup` — funnel through
  `runFreshLifecycle`, which owns the mutex.
- `executeWaitPark` — holds the mutex across the whole `reEvaluateWaitingRun` body because that
  body mutates the waiting-run row and may call `tryMergePullRequest` /
  `recordPullRequestObservation`. The daemon's `reconcileWaitingRuns` `tryAcquire` gate relies on
  this for exclusion.

## Cross-tick serialization between scheduled fire and fresh dispatch

The mutex is non-reentrant. Two paths can both acquire the (now-narrower) mutex on different ticks
without contention; the only ordering question is "can a fresh dispatch on tick N+1 claim the same
Issue that a scheduled callback fired on tick N+0 reserved?" The answer is no: the load-bearing
serialization across the tiny window between `ScheduledWorkRegistry.scheduled.delete` (line 39 in
`src/lifecycle/scheduled-work.ts`) and the new `reserveSlot` is **the `sym:claimed` operational
label filter**. `evaluateProjectEligibility` (`src/issue-polling.ts`) filters issues carrying
`sym:claimed` out of `pollStatus.candidateIssues`, so a poll tick cannot surface the issue as a
fresh-dispatch candidate while the previous attempt's claim label is still present. The
`reserveSlot` uniqueness check is a second line of defense (a duplicate would surface a real bug,
not a routine race).

## Status surface

`dispatchRuntime.dispatching: boolean` previously meant "mutex held" (i.e. anything happening at
all). After narrowing, that boolean would flicker to true for sub-millisecond windows and clients
polling `/api/status` would see `false` almost always. We redefine the existing field to mean "at
least one in-flight run" (i.e. `activeRuns.countInFlight() > 0`) so it remains the operationally
useful signal. The legacy semantics are preserved internally by the reconcile-waiting-runs and
stale-claim gates, which consult `dispatchMutex.tryAcquire()` / `.held` directly.

## What the reconcile/stale-claim gates mean now

`reconcileWaitingRuns` keeps its `dispatchMutex.tryAcquire()` gate. Under the narrowed mutex, that
gate excludes against `executeWaitPark`'s now-explicit mutex acquire (above) and against any other
claim section in flight. `detectStaleClaims` keeps its `!dispatchMutex.held` gate; the gate fires
more often now (mutex is rarely held), which is acceptable — `detectStaleClaims` is idempotent and
per-issue.

## Consequences

- Multiple provider runs can execute concurrently in the daemon when multiple Projects each have
  ready Project Issues.
- Per-Issue uniqueness still holds: `reserveSlot` rejects a duplicate `(project, issue)` lock
  inside the mutex, and the `sym:claimed` label gates fresh dispatch picks across ticks.
- Per-Issue reservation (ADR 0051) gates the picker via `activeRuns.isIssueReserved`, which now
  also reflects the early reservation.
- `dispatchRuntime.dispatching` semantically shifts from "mutex held" to "in-flight count > 0".
  `dispatchRuntime.inFlight` exposes the count directly.
- `detectStaleClaims` runs near every tick; rate-limit headroom on busy projects must be
  monitored.
- Slice 2 (ADR 0053) layers per-Project and global concurrency caps on top of this scope. The
  caps read `InFlightRunRegistry.count()` / `countByProject(...)` inside the mutex, which is only
  safe because `reserveSlot` populates the registry inside the critical section.

## Numbering

ADR `0051-*.md` already exists in three variants; the next free number is `0052`. Slice 2's ADR
is `0053-per-project-and-global-concurrency-caps.md`.
