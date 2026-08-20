# Non-gating Routine Dispatch Holds

Status: Accepted

## Context

ADRs 0069 and 0070 left a provider-blocked Routine Fan-out target `pending` so repairing a missing
Agent Provider adapter could still claim the original clock event. The same `pending` disposition
also gates grouped-summary readiness, so one permanently misconfigured target could prevent every
healthy sibling's result from ever reaching the operator. Settling the leg as a terminal skip would
unblock the summary but make the original event unclaimable.

## Decision

A scheduled target whose selected provider adapter is unregistered or whose provider command is
missing transitions its fan-out leg from `pending` to `held`. The hold stores its provider-specific
reason but leaves the Routine Target active and its original `next_fire_at`, attempt evidence, and
skip counters unchanged.

`held` is summary-terminal but schedule-claimable:

- grouped-summary readiness does not wait for held legs;
- a held leg is rendered with its reason and counts as a group failure, so both `changes` and
  `failures` notification policies surface the configuration problem;
- normal claim and skip transactions may transition either `pending` or `held` to `firing` or
  `skipped`; and
- disabling or removing the target settles either state as `target_unavailable`.

Grouped notifications remain one-shot. If delivery was already sent or policy-skipped while a leg
was held, a later firing does not reopen or amend the group; the firing's normal notification and
durable operator surfaces carry its result. If the group is still notification-pending because no
sink is configured, a late claim becomes outstanding work and the eventual first summary waits for
that firing. The notification claim's transactional readiness recheck preserves the same rule when
a repair races delivery.

This decision supersedes ADR 0069's requirement that every target have a skip or terminal firing
before summary readiness, and ADR 0070's requirement that a provider-blocked fan-out leg remain
`pending`. Their schedule-preservation and one-shot notification decisions remain in force.

## Alternatives considered

- A fixed staleness timeout would bound delivery but discard a legitimate late event after an
  arbitrary interval.
- Corrective grouped notifications would preserve every result but require notification revisions,
  delivery history, and rules for coalescing multiple late targets.
- Warning-only observability would make the fault easier to diagnose but would retain the original
  indefinite-delivery failure.

## Consequences

- One provider-misconfigured Project cannot indefinitely suppress healthy sibling results.
- Repair still executes the original due event instead of silently advancing the schedule.
- A delivered group is an explicit snapshot: it can report a held target that later succeeds.
- `pending` now means not yet evaluated for admission; `held` means evaluated, provider-blocked, and
  still claimable.
