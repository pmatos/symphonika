# Hold Routine clock events for unregistered providers

Status: Accepted

Superseded in part by ADR 0084: the due Routine Target and schedule remain claimable, but its
fan-out leg is now `held` and does not gate the one-shot grouped summary.

## Context

`dispatchDueRoutines` can select a provider name that has an operator-authored command in the
Service Config but no adapter in the daemon's Agent Provider registry. This is a persistent
configuration failure, unlike an overlap or a full concurrency cap, which are transient admission
conditions.

ADR 0058 requires overlap and concurrency-cap skips to consume the matched clock event and advance
the target. Applying that rule to an unregistered provider would make a recurring target look
current while every occurrence was discarded without launching a Coding Agent. Holding the due
timestamp without explicit evidence, however, would make the reason difficult to diagnose.

The service-level fan-out design already requires provider/config availability failures to leave a
target pending and due so a repaired target can complete the original fan-out. This decision makes
that behavior explicit for recurring targets and the operator log.

## Decision

An unregistered selected Agent Provider creates a **Routine Dispatch Hold**, not a Routine Skip.
For the due Routine Target, the dispatcher:

- leaves `state`, `next_fire_at`, `last_attempted_at`, and all Routine Skip evidence unchanged;
- creates no Routine Firing and leaves the Routine Fan-out target pending;
- returns `provider_not_registered: <provider>` in the tick's skipped-dispatch result;
- emits a structured warning containing the Project, Routine, provider, and original scheduled
  clock time; and
- re-evaluates the same due clock event on every later daemon tick.

Once the adapter is registered, normal admission claims the original event. A recurring target then
advances strictly beyond the current clock, while a one-shot expires. Manual firing keeps its
existing `unavailable` refusal because it does not represent a scheduled clock attempt.

The warning may repeat once per poll interval while the configuration remains broken. This is
intentional bounded re-surfacing of a persistent error; a future logging rate limiter may reduce
noise but must not consume the clock event or turn the condition into Routine Skip evidence.

## Alternatives considered

### Advance the clock as a Routine Skip

This matches overlap and cap mechanically, but silently discards every occurrence of a persistently
misconfigured Routine. `next_fire_at` would look healthy even though no provider ever ran.

### Add a persisted `held` or `error` Routine state

This makes the condition prominent but widens the Routine state machine, reload restoration rules,
and every operator surface. The Service Config validation and `doctor` paths already own provider
registration diagnostics. Keeping the target active and due provides automatic recovery as soon as
the registry is repaired without duplicating that configuration state in the Run Store.

### Hold without a warning

This preserves work but leaves operators to infer the cause from a stale due timestamp. A
structured warning provides direct evidence while the daemon's polling interval bounds repetition.

## Consequences

- A provider registration error cannot silently move a recurring schedule forward.
- Repairing the registry preserves and runs the original due event, including its existing fan-out
  correlation.
- Routine Skip timestamps and counters continue to mean only consumed clock events covered by ADR
  0058.
- A persistent error remains visible in daemon logs on every poll interval until repaired.
