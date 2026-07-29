# Soft-disable persisted tracker-less `kind: git` Routine rejections

Status: Accepted

## Context

ADR 0062 rejects a `kind: git` Routine targeting a tracker-less Routine Host at declaration time.
Reload therefore omits the Routine from the host's current executable declarations. If the Routine
already has a persisted `routines` row from an earlier valid snapshot, ordinary removal detection
sees that omission and soft-disables the row as `removed_from_config`.

The safe terminal state and the reason attached to it were ambiguous. Treating the rejected name
like a brand-new invalid declaration would add it to `invalidRoutineNames`, but those names are
excluded from removal detection and absent from the valid-declaration upsert loop. A previously
active row would therefore remain active and could fire from stale persisted configuration.
`upsertInvalidRoutineStub` cannot correct that outcome: it intentionally updates only identity
stubs with an empty `prompt_body`, never a row that once held a real declaration.

## Decision

A previously persisted Routine rejected by the ADR 0062 tracker requirement is soft-disabled with:

- `state = 'disabled'`
- `disabled_reason = 'rejected_tracker_less_host'`

Reload carries the rejected Routine name separately from both executable declarations and
`invalidRoutineNames`. `RunStore.syncRoutines` excludes that name from generic removal detection,
then applies the precise rejection reason to an existing row. The dispatcher skips the resulting
non-active row. If the identity currently belongs to an invalid stub with an empty prompt, the
rejected declaration replaces the stub's sentinel kind, schedule, and prompt; a row that ever held
valid configuration is only demoted and is never overwritten by this reclamation path.

A first-appearance rejection — no prior persisted declaration — also persists a row carrying the
declared schedule and prompt. On an enabled host it is `disabled` with `disabled_reason =
'rejected_tracker_less_host'`; when the host Project is itself disabled, the Project cascade takes
precedence and the row is `inactive`. Without that row, a later tracker restoration would be
indistinguishable from a brand-new declaration: the normal insert path would create the Routine
`active`, and an elapsed one-shot would fire retroactively instead of expiring. On restore, the
elapsed disabled/inactive one-shot guard precedes schedule-change reactivation, so a one-shot whose
schedule was edited while stopped but is still elapsed also expires. The first-appearance failure
remains visible through reload errors and `doctor`. The rejection does not cancel an in-flight
Routine Firing, which continues under the snapshot it started with.

Restoring the Routine Host's tracker returns the declaration to the normal upsert path. Recurring
Routines become active with a schedule recomputed from the current tick; elapsed one-shot Routines
become expired and do not fire retroactively, matching the existing disabled-Routine restore
contract.

## Consequences

- A rejected Routine cannot keep firing from a stale active row.
- Operator surfaces distinguish an entry that is still configured but incompatible with its host
  from one actually removed from the top-level `routines:` block — for first-appearance rejections
  too, since they now persist a durable non-active row.
- An overdue one-shot rejected on first appearance cannot fire when the tracker returns; it expires
  like any other elapsed one-shot restore, even if its `at` was edited while rejected or its host
  passed through the Project-level inactive cascade.
- `invalid` remains reserved for a never-valid Routine declaration represented by an identity-only
  stub; host compatibility rejection does not overload that state.
- Removing the rejected entry later changes the persisted reason to `removed_from_config`, while
  restoring the tracker self-heals the row through ordinary synchronization.
