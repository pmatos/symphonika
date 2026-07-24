# Routine lifecycle control: cancellation, disable, removal, invalid reload

Routines slice 6 gives operators the same lifecycle control over Routine Firings and Routines that
they already have over issue Runs and Projects: cancel a misbehaving firing, disable or remove a
Routine without disrupting in-flight work, and see an invalid routine declaration without losing
the last-known-good schedule for its siblings.

## Decision

### `disabled` is distinct from `inactive`

`inactive` continues to mean exactly what it meant before this slice: the Routine's Project is
disabled or absent from the current valid Service Config snapshot (ADR-0021's cascade). `inactive`
rows are pruned from default operator listings; an operator opts in with `include_inactive`.

`disabled` is new and means the Routine itself was stopped — `disabled: true` in its own front
matter, or its path removed from a still-enabled Project's `routines:` list. Unlike `inactive`,
`disabled` routines are **visible by default**, rendered with a `disabled_reason` of `operator` or
`removed_from_config`. The two states are not merged: they answer different operator questions
("is this Project running at all" vs. "why did this specific Routine stop"), and merging them would
either break ADR-0021's default-hidden Project cascade or force reason-based filtering into every
existing `inactive` call site.

Removing a Routine's path from a still-enabled Project's `routines:` list previously hard-deleted
its `routines` row (`RunStore.syncRoutines`). This slice reverses that: the row is soft-disabled
with `disabled_reason = 'removed_from_config'` and stays visible, mirroring the Project-level
precedent (ADR-0021) that a full-permission agent's history should never disappear on a config
edit, and that "removed from config" needs its own reason distinct from an operator's explicit
`disabled: true`.

### `invalid` and its identity limit

A Routine that has never had a valid declaration — a brand-new file whose front matter is broken
from the start — gets `state = 'invalid'`. This is only possible when the front matter's `name`
field itself parsed successfully; the `routines` table's primary key is `(project_name, name)`, so
a routine with no parseable name has no identity to persist a row against. Those failures are
surfaced only through the reload-error/doctor channel, keyed by file path, never as a `routines`
row (`RunStore.upsertInvalidRoutineStub`).

`invalid` rows use sentinel values (`kind: 'report'`, empty `schedule_at`, empty `prompt_body`) for
columns the broken declaration never supplied. This is safe because `evaluateRoutineSchedule`
(`src/routines/schedule.ts`) never fires a non-`'active'` row, so the sentinels are never read as
real configuration.

### Reload isolation is scoped to Routines

Before this slice, one invalid Routine declaration anywhere aborted the entire config reload:
`loadRuntimeConfigSnapshot` reverted to the last-known-good `RuntimeConfigSnapshot` (or brought
nothing live on first load) for every Project, not just the one with the broken Routine. This
slice gives Routine declarations **per-routine** isolation: `readRoutineDeclarations` never
collapses to a snapshot-wide failure. A Routine whose declaration becomes invalid on reload but
previously had a valid one (matched by file **path**, not by the possibly-corrupted parsed `name`)
carries its last-known-good declaration forward and keeps firing; a Routine invalid from its first
appearance gets the `invalid` identity described above. Sibling Routines, sibling Projects, and
Workflow Contract / Project-detail / Watchdog-override validation all keep today's whole-snapshot
last-known-good behavior — only Routine-declaration loading changed. This is the smallest change
that satisfies the operator-visible requirement ("an invalid Routine reload does not block the
rest of the fleet") without touching the cross-cutting reload invariant documented in SPEC §5.1/§5.2
for everything else.

Carry-forward is keyed on the declaration file's path, not its parsed name, because a broken edit
can corrupt the `name` field itself while the path `symphonika.yml` references is unchanged. Keying
on name would misroute that common case into "no prior valid snapshot," soft-disabling a
still-configured Routine as `removed_from_config`.

### Cancellation reuses the Run cancellation machinery

A Routine Firing's process-kill and concurrency-slot path was already generic: `dispatchDueRoutines`
registers each firing into the same `ActiveRunRegistry` used by issue Runs, keyed by firing id, so
`activeRuns.requestCancel(firingId, "operator")` already reaches the attached provider's `cancel()`
callback with no registry change. This slice adds the missing pieces: `routine_firings` gains
`cancel_requested` / `cancel_reason` columns (mirroring `runs`), `RunStore.getRoutineFiring` /
`markRoutineFiringCancelRequested` for a single-firing lookup and intent-mark, and
`runRoutineFiring`'s outcome classification now checks the shared registry's `cancelRequested`
before writing a terminal state — mirroring `classifyFailure`'s existing cancelRequested fast path
for issue Runs, so a firing whose process happens to exit cleanly in the same race as an operator
cancel still reports `cancelled`, not `succeeded`.

`symphonika cancel <id>` and `POST /api/runs/:id/cancel` are generalized, not duplicated: the
daemon's cancel handler tries `runStore.getRun(id)` first, then `runStore.getRoutineFiring(id)`.
`RoutineFiringState`'s members are a strict subset of `RunState`'s, so no client-visible type
widening or new route was needed — one endpoint, one CLI verb, id-sniffed server-side.

## Consequences

- Operators see `disabled (operator)` / `disabled (removed_from_config)` in `symphonika routines`,
  the local dashboard, and the terminal dashboard, distinct from the hidden-by-default `inactive`.
- A single broken Routine file no longer freezes reload of the rest of the fleet; only that
  Routine (or, if brand new, nothing) fails to advance.
- `symphonika cancel <firing-id>` kills the provider process, preserves workspace and logs (no
  code path deletes them on cancellation), and records `cancel_reason = "operator"`.
- Restoring a disabled Routine always recomputes `next_fire_at` strictly after the current clock —
  it never resurrects a stale pre-disable timestamp, and a one-shot Routine whose `at` elapsed
  while disabled goes to `expired` instead of firing retroactively.
- A Routine with no parseable name can never be surfaced as a `routines` row; operators must read
  `doctor` output or the reload status to find it. This is a schema identity limit, not an
  oversight — extending it would require a path-keyed secondary identity for the `routines` table,
  out of scope for this slice.
