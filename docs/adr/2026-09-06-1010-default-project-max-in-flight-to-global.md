# An omitted Project max_in_flight defaults to the resolved global cap, not 1

Status: Accepted

## Context

ADR 0053 gave each Project an optional `max_in_flight`, defaulting the omitted case to `1`
("legacy serial-per-project behavior") independently of `global.max_in_flight`, which defaults to
unbounded. In a fleet where most Projects don't set their own `max_in_flight` but the operator has
configured a generous `global.max_in_flight` (e.g. `16`), every one of those Projects is silently
capped at 1 concurrent run regardless of the operator's intent.

That per-Project cap of 1 interacts badly with weighted round-robin (ADR 0005): per ADR 0053's own
"Interaction with weighted round-robin" section, a Project at its cap is excluded from
`pickTargetFromCandidates` and its scheduler cursor does not advance. A Project doing back-to-back
fresh dispatches/continuations can therefore stay perpetually at cap 1 and rarely re-enter the
round-robin to pick up new ready issues, starving its own backlog even though
`global.max_in_flight` has headroom fleet-wide. Observed in practice: a Project with no
`max_in_flight` override stayed continuously at cap 1 while `global.max_in_flight: 16` sat mostly
unused (1 run active fleet-wide at the time of observation). See issue #719.

## Decision

`resolveProjectMaxInFlight` (`src/lifecycle/concurrency-capacity.ts`) now resolves an omitted
per-Project `max_in_flight` to the resolved `global.max_in_flight` instead of hardcoding `1`:

```
resolveProjectMaxInFlight(configured, globalMax) = configured ?? globalMax
```

- An explicit per-Project `max_in_flight` always wins, exactly as before.
- An omitted per-Project cap now takes on whatever the global cap is.
- If both are omitted, the Project is unbounded — `resolveProjectMaxInFlight` returns `undefined`,
  and `isProjectCapReached` treats an undefined resolved cap as never reached.

An operator who wants the old serial-per-project behavior sets `max_in_flight: 1` explicitly on
that Project (or globally, which now also becomes every unconfigured Project's default).

`isProjectCapReached` and `evaluateConcurrencyCapacity` both take the resolved `globalMax` as an
additional input so the fallback can be computed at the same call site that already has both
values in scope (`run-controller.ts`'s `pickTargetFromCandidates` and its mutex-guarded
re-checks, `routines/dispatcher.ts`'s `capSkipReason`). No call site had to fetch new data — every
existing caller already resolves the global cap immediately before or alongside the per-Project
check.

### Surfacing an unbounded per-Project cap

`daemon.ts`'s `getConcurrency()` (backing `/api/status` and the per-Project capacity strip) already
represented "no global cap" as `maxInFlight: null`, distinct from `undefined` meaning "no
concurrency data available at all". The per-Project entries now follow the same convention —
`resolveProjectMaxInFlight(...) ?? null` — so an unbounded Project renders identically to an
unbounded global cap (no `/max` suffix in the in-flight count) instead of claiming a cap of 1 it
doesn't have.

`doctor.ts`'s provider-build-memory-capacity check treats an unbounded resolved Project cap as
`Number.POSITIVE_INFINITY` when summing per-Project caps toward the effective fleet-wide
`max_in_flight` estimate — the same idiom the function already used for an unbounded
`global.max_in_flight`. When that leaves the effective cap itself non-finite, the check now skips
rather than warn: an unbounded cap has no finite byte figure to compare against `MemoryMax`, so
comparing against it would produce an always-true "Infinity GiB" warning with no actionable
threshold behind it, on any fleet with no caps configured anywhere. That fleet already produced no
warning before this change (its per-Project default of 1 kept the estimate small), so the skip
preserves the same observable output for that case while fixing the *default value* the estimate
is built from for every partially-configured fleet.

## Consequences

- A fleet that sets `global.max_in_flight` but leaves most Projects unconfigured now gets the
  concurrency the operator actually configured, instead of silently serializing every
  under-configured Project to 1. This directly fixes the round-robin starvation in issue #719.
- A fleet with **no** caps configured anywhere (no `global.max_in_flight`, no per-Project
  overrides) changes behavior: every Project is now fully unbounded (limited only by candidate
  issue count and Host Pressure/overlap-guard admission, ADR 0088), rather than implicitly
  serialized to 1 concurrent run per Project. This is a deliberate behavior change, not an
  oversight — an operator who relied on the old implicit default for safety must now set
  `max_in_flight: 1` (per-Project or globally) explicitly.
- The git-fetch lock added in ADR 0053 for `max_in_flight > 1` needs no change: it's keyed by cache
  path, not by whether the effective cap came from an explicit value or a default, so it already
  covers a Project whose cap now defaults above 1.
- `dispatchOneEligibleIssue` (one-shot CLI, ADR 0026) is unaffected: it still doesn't enforce
  `max_in_flight` because it dispatches at most one Issue per invocation.
