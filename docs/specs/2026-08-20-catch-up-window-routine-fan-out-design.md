# Catch-up-window Routine Fan-out design

Status: approved by issue #361's autonomous implementation brief

## Problem

On daemon restart, `dispatchDueRoutines` records a `catch_up_window` Routine Skip before the normal
clock-event dispatch loop. That restart-only path advances each Routine Target independently and
does not create or settle the Routine Fan-out required for the missed clock event. A multi-Project
Routine therefore loses its durable grouped result.

## Decision

Before recording any restart catch-up skip, the dispatcher will collect every eligible persisted
Routine Target across enabled Projects. It will group that immutable snapshot by Routine name and
missed `next_fire_at`, create one Routine Fan-out per group, and pass its id into each target's
existing atomic skip operation.

The outage occurrence warrants a grouped summary because the implementation contract defines a
catch-up-window disposition as an operator-visible Routine Skip and requires every clock-matched
Routine to create a Routine Fan-out. Existing email policy controls delivery without creating a
special outage-only rule: `on: always` sends the all-skipped summary, while `changes` and `failures`
record it as policy-skipped because Routine Skips are not failures or changes.

## Alternatives considered

1. Leave restart skips ungrouped and clarify the specification. This weakens the durable
   clock-event completeness invariant and makes catch-up-window skips the only policy skips without
   a Routine Fan-out.
2. Extract a shared general-purpose fan-out batching helper for both dispatch paths. This removes
   some duplication, but it couples schedule-recomputation eligibility to normal due-event
   evaluation and broadens a narrow fix.
3. Collect restart-skip candidates, group them before mutation, then reuse the existing Run Store
   fan-out and skip operations. This preserves the pre-work membership snapshot with the smallest
   behavioral change and is the selected approach.

## Public seam and test

The behavior is tested through `dispatchDueRoutines`: two persisted targets of one recurring
Routine miss the same clock event during an outage, restart recomputation records two
`catch_up_window` skips, and `on: always` delivers exactly one grouped notification containing both
Project dispositions. The resulting Routine Fan-out is also durable and terminal, with both target
legs recorded as skipped.
