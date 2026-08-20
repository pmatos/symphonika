# Service-level Routine fan-out design

Status: approved by issue #295's amended implementation brief

The provider-availability and grouped-readiness portions are superseded by ADR 0084: a blocked leg
is `held`, summary-terminal, and still claimable rather than `pending` and readiness-gating.

## Goal

A service-level Routine declaration names an explicit, non-empty list of declared Projects:

```yaml
routines:
  - path: ./routines/refactor-audit.md
    projects: [s11, rightkey, petovita, jsse, vow, forseti, pewpew]
```

The declaration file stays project-independent. Its globally unique `name` groups one durable
Routine Target row per configured Project and one Routine Fan-out per matched clock event.

## Considered approaches

### Atomic admission

Reserve capacity for every target before creating any firing. This makes summaries simple, but a
fan-out larger than the global cap can never run and one busy Project blocks unrelated targets.
It also treats per-Project caps as a group-wide scheduling policy, contrary to ADR 0053.

### Per-target admission with a durable fan-out

Create durable fan-out membership for the clock event, then apply overlap and concurrency gates to
each Routine Target independently. An admitted target creates its normal firing row; a skipped
target advances only its own schedule and counters. This preserves the existing `(project, routine)`
state model while making partial admission explicit and restart-safe.

### Ephemeral in-memory grouping

Attach one correlation id to firings started by the current process and wait in memory. This is
smaller, but a daemon restart loses expected target membership and cannot know when or whether to
send the grouped summary.

The durable per-target approach is selected.

## Configuration and identity

- Replace the transitional ADR 0063 `project: <name>` entry with
  `projects: [<name>, ...]`. The list is non-empty, explicit, and contains no duplicate names.
- Reject the transitional `project:` spelling with a migration error naming `projects:`.
- Continue rejecting nested Project `routines:` blocks.
- Load a declaration file once, enforce its name globally across service-level entries, and clone
  the validated declaration into one `TargetedRoutineDeclaration` per target.
- Keep the `routines` primary key `(project_name, name)`. Removing one target therefore
  soft-disables only that row with `removed_from_config`; removing or disabling the declaration
  affects all of its rows.
- A target must resolve to exactly one declared Dispatch Project or Routine Host. No wildcard is
  accepted.

## Clock-event dispatch

A Routine Fan-out is identified by a generated correlation id and has a uniqueness guard on
`(routine_name, scheduled_at)`. It stores the target set before provider work starts, and that
membership remains immutable. A target configured later for the same elapsed one-shot event records
an ungrouped `catch_up_window` skip instead of extending or reopening the existing group. Each
expected target is then handled independently:

1. overlap or concurrency-cap rejection advances that target's schedule, records its existing skip
   counter, and marks the fan-out target skipped;
2. an admitted target creates a `routine_firings` row carrying the fan-out id, advances only its
   Routine Target row, and reserves normal Project/global capacity;
3. admitted siblings start concurrently, so a global cap can admit a prefix and skip the rest;
4. provider/config availability failures leave the target pending and due for a later daemon tick
   rather than silently completing or losing it.

The existing workspace and branch algorithms already include Project and firing identities, so
siblings naturally receive distinct workspaces, branches, and evidence directories.

## Grouped summary policy

A fan-out is summary-ready only when every target is either skipped or has a terminal firing.
Skipped targets appear as project lines but do not count as failures. Failed and cancelled firings
count as failures; discovered Routine Pull Requests contribute to the PR count. Issue counts remain
zero until the structured outcome slice supplies verified issue actions.

If a restart leaves a target pending and that target's declaration or Project is then disabled or
removed, reconciliation completes the leg as `target_unavailable`. It does not invent a provider
firing or increment a concurrency/overlap counter, and it prevents the durable group from waiting
forever on work that is no longer schedulable.

Notification delivery is claimed durably so normal concurrent ticks emit one grouped notification.
Failures return the claim to pending for retry and never change firing state. On daemon restart,
orphan firing reconciliation makes lost live legs terminal and the next reconciliation can deliver
the pending summary. A crash after the external SMTP server accepts a message but before the local
sent marker is recorded can cause a duplicate; exactly-once delivery is not possible without an
idempotent external sink.

There is no independent partial-summary deadline. A summary waits for every admitted firing's
terminal state. The declared wall-clock firing timeout bounds live work, and daemon startup
reconciliation bounds work lost across restarts. Sending early would violate the one-glance
contract by omitting a result that is still legitimately running.

## Public seams and tests

Behavior is tested through:

- `RuntimeConfigReloader` for declaration expansion, global uniqueness, and target validation;
- `RoutineConfigEditor` / `add-routine` for service-config mutation;
- `RunStore` for reconciliation, target-local removal, durable fan-out identity, and restart-ready
  summaries;
- `dispatchDueRoutines` for per-target cap admission, concurrent sibling firings, shared
  correlation, and one grouped notifier call;
- CLI and HTTP routine readers for a globally named Routine with grouped targets.

The SQLite schema is additive. Existing single-target rows and firing history remain valid; old
firings have no fan-out id and continue to render normally.
