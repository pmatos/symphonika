# Claim fresh candidates in a loop per tick instead of one per tick

Status: Accepted

## Context

`daemon.ts`'s `launchWork()` called `runController.dispatchOneFresh()` exactly once per poll tick
(`polling.interval_ms`). `dispatchOneFresh` (`src/lifecycle/run-controller.ts`) picks a single
candidate via `pickTargetFromCandidates` (the ADR 0053 enforcement point for the global and
per-Project concurrency caps) and fully awaits the resulting run through `runFreshLifecycle` →
`runAttemptLifecycle` before returning.

This meant the daemon claimed at most one new fresh Issue fleet-wide per tick, regardless of how
much headroom `global.max_in_flight` left. With N eligible candidates across several Projects and
slots free, they were claimed one at a time, one per tick — filling 10 free slots out of a
`global.max_in_flight: 16` could take up to 10 poll intervals serialized, instead of dispatching
together in one tick. ADR 0053 correctly gates *readiness* (which candidates are dispatchable right
now) but nothing looped dispatch attempts within a single tick to actually fill the available
concurrency budget. Filed as issue #720.

The obvious-looking fix — loop `await dispatchOneFresh()` in `launchWork` — does not work:
`dispatchOneFresh` doesn't resolve until the claimed run's `runAttemptLifecycle` finishes (minutes),
so a naive loop would serialize dispatch 2 behind dispatch 1's entire run, the opposite of the
intended fix. The loop boundary has to be the *claim* (`pickTargetFromCandidates` +
`claimAndPersistRun`, both already invoked together under the narrow `dispatchMutex` per ADR 0052),
not the full dispatch.

## Decision

`RunController.dispatchOneFresh`'s single-target body (project/tracker/token checks, provider
resolution, and the claim-or-fail branch) is extracted into a private `resolveAndClaim` helper, and
its mutex-guarded claim step is further extracted into `claimFreshTarget` (used unchanged by
`runFreshLifecycle`, which continuation, raw-FSM state-advance, and PR-review-followup all still
call exactly as before — none of those paths change). `dispatchOneFresh` itself is unchanged in
its public contract: same signature, same return timing, same log messages, unmodified for its
existing callers (`src/dispatch.ts`'s one-shot CLI path and ~54 existing test call sites across 9
files).

A new method, `RunController.dispatchFresh(pollStatus, options)`, loops:

1. Filter the candidate list by two per-call exclusion sets (`attempted`, keyed
   `${project}#${issueNumber}`, and `excludedProjects`), then call `pickTargetFromCandidates`.
2. If it returns `undefined` (global cap reached, or no Project has a dispatchable candidate this
   tick), stop — the loop's natural termination.
3. Otherwise call `resolveAndClaim`. On success, the candidate's `runAttemptLifecycle` is kicked off
   **without awaiting it** — the promise is collected into a `lifecycles` array the caller must
   track, but the loop itself moves straight to the next `pickTargetFromCandidates` call.
4. On `RegistryShutdownError`, stop immediately (the daemon is shutting down; nothing further should
   even be attempted). On any other outcome (claimed, or any of the existing claim-boundary
   rejections: `CapBreachedError`, `FileOverlapDetectedError`, `IssueReservedError`,
   `FreshClaimDeferredError`, or a pre-claim failure via `failFreshDispatchBeforeProvider`), the
   picked candidate is added to `attempted` regardless of outcome, so the loop is bounded by
   candidate count no matter what happens.

Picks are strictly sequential — `dispatchFresh` never runs multiple `pickTargetFromCandidates`/claim
attempts concurrently (no `Promise.all`). This is required, not stylistic: `pickTargetFromCandidates`
reads each Project's `scheduler_current_weight` (ADR 0005) from a synchronous SQLite snapshot, and
`claimAndPersistRun` only persists a pick's updated weight once its mutex hold completes. Pick N+1
must observe pick N's persisted weight for the round-robin fairness ADR 0053 already establishes to
extend correctly to a multi-pick tick — a Project winning two picks in one tick is exactly as
disfavored on the next tick as winning across two separate ticks, only if the picks themselves ran
one after another.

### The project-wide exclusion

`failFreshDispatchBeforeProvider` (an existing path, unchanged) claims the `sym:claimed` label and
records a terminal `failed` Run row for a candidate whose resolved provider has no configured
command or isn't registered — but it never calls `recordProjectDispatchSelection`, so that
Project's `scheduler_current_weight` never advances. A misconfigured provider is a per-Project
config property, invariant for the whole tick, so every remaining candidate for that Project would
hit the identical path. Without `excludedProjects`, `dispatchFresh`'s `attempted`-by-candidate
bound would still terminate, but only after burning through that Project's entire candidate backlog
via real `sym:claimed` GitHub label-write calls in one tick — worse than today's one-call-per-tick
exposure. `resolveAndClaim` reports `excludeProject: true` on this path specifically, and the loop
drops every remaining candidate for that Project from `attempted` (not just the one just claimed).

### `daemon.ts` wiring and shutdown drain

`launchWork` now calls `dispatchFresh` instead of `dispatchOneFresh`, logs each terminal
(`dispatched: false`) claim the same way it logged the single result before, and — synchronously,
with no intervening `await` — registers every returned `lifecycles` promise into the existing
`inflightDispatches` Set (the same Set the outer per-tick promise already occupies), with its own
`.catch()`/`.finally()` pair mirroring the existing pattern used for API-triggered dispatch
acceptance. This matters for ADR 0052's shutdown-drain guarantee: `stop()`'s
`await Promise.allSettled(Array.from(inflightDispatches))` must wait for every detached run kicked
off mid-loop, not just for the claim loop's own (now much shorter) promise — otherwise a shutdown
could close the RunStore/HTTP server while a claimed-but-still-running provider attempt is mid-write.

## Consequences

- A single poll tick can now claim as many fresh candidates as the global cap and each Project's own
  cap and candidate pool allow, instead of exactly one. Filling N free slots across N ready
  candidates takes one tick instead of N.
- `dispatchOneFresh` is unchanged for every existing caller; only `daemon.ts`'s own per-tick call
  site was repointed to the new `dispatchFresh` method.
- Weighted round-robin fairness (ADR 0005) holds across a multi-pick tick because picks stay
  strictly sequential — this is a hard constraint on future changes to `dispatchFresh`, not just an
  implementation detail: parallelizing picks would silently break per-Project fairness.
- `pickTargetFromCandidates` re-scans every Project's remaining candidate bucket from scratch on
  each pick (already true before this change, for the single pick each tick made) — a multi-pick
  tick now pays this scan cost once per claim, i.e. O(N·M) for M claims out of N candidates. Not
  fixed here; the existing per-pick cost was already accepted.
- With `dispatch.overlap_guard: true`, each pick's overlap check is a cache-backed lookup (a real
  GitHub round-trip only on a cache miss per issue), so a multi-pick tick multiplies the *scan* cost
  above, not the network cost, beyond what a full poll cycle already paid. Not fixed here.
