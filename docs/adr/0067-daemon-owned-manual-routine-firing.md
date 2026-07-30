# Daemon-owned manual Routine firing

Status: Accepted

## Context

Routine development needs an immediate execution path. `poll-now` runs the
ordinary scheduler and therefore fires only a Routine whose clock event is
already due. Temporarily editing cron or waiting for the next event is not a
usable prompt-iteration loop.

The daemon is the only component that owns the active-run registry, global and
per-Project concurrency caps, Routine overlap decisions, Run Store, provider
lifecycle, and shutdown drain. Firing in the CLI process would bypass those
invariants.

ADR 0027 limited v1 local web/API mutations to cancellation and `poll-now`.
Issues #189 and #296 explicitly reopen the deferred manual Routine trigger.

## Decision

`symphonika fire-now <routine>` calls
`POST /api/routines/:id/fire` on the selected daemon. The endpoint is an API
for the CLI; this decision does not add a mutating control to the
server-rendered dashboard.

The daemon resolves the Routine and performs an await-free claim:

1. refuse ambiguity, an unavailable Project/provider, disallowed Routine
   state, overlap, shutdown, or a concurrency cap;
2. insert a normal `routine_firings` row with `trigger_source = manual`;
3. reserve the same active-run slot used by issue Runs and scheduled Routine
   Firings; and
4. start the existing workspace, evidence, provider, cancellation, and
   terminal-classification lifecycle as daemon-owned asynchronous work.

Scheduled claims record `trigger_source = scheduled`. Existing database rows
default to `scheduled` during migration.

A manual claim does not update the `routines` row. In particular,
`next_fire_at`, `last_fired_at`, `last_attempted_at`, and Routine state remain
unchanged. Those fields are schedule-clock state; updating `last_fired_at`
would incorrectly expire a future one-shot and updating `next_fire_at` would
consume the next recurring event.

Manual firing respects `allow_overlap` and both concurrency caps. A refusal
creates no Routine Firing and no Routine Skip: no scheduled clock event was
attempted, so skip evidence and the schedule remain unchanged.

An active Routine can be fired manually. `--force` overrides only
`state = disabled` with `disabled_reason = operator`, the ADR 0060 state for a
declaration containing `disabled: true`. It does not override `inactive`,
`invalid`, or `expired`, and it does not revive `removed_from_config` or
`rejected_tracker_less_host` rows.

The endpoint returns the accepted firing id immediately. `--wait` polls the
existing firing-history API for that exact id until it reaches `succeeded`,
`failed`, or `cancelled`; failed and cancelled firings produce a non-zero CLI
exit.

Routine-name ambiguity returns candidate `(Project, Routine)` identities.
`--project` selects one target and is forward-compatible with service-level
fan-out.

## Consequences

- Prompt authors can iterate without changing a Routine schedule.
- A manual run can be refused as cap-reached or overlap, exactly like any
  competing provider execution, without consuming a clock event.
- Routine Firing consumers distinguish only the recorded trigger source; the
  rest of the evidence and lifecycle shape is shared.
- The local API has one additional mutating route. This supersedes the
  exhaustive action lists in ADR 0027 and the references to those lists in
  ADRs 0056 and 0057; their server-rendered, primarily read-only UI posture is
  otherwise unchanged.
