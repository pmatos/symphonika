# Watchdog policy is unavailable without a valid runtime snapshot

Status: Accepted

## Context

The Watchdog operator surfaces resolve one effective policy from the daemon-level configuration and
the Run's Project override. `RuntimeConfigReloader.watchdogServiceConfig()` previously returned the
default Watchdog policy when the reloader had no snapshot. That state occurs on a first-load failure
with no last-known-good snapshot, including an unrelated failure such as a missing Workflow
Contract.

Substituting defaults made the surfaces contradict operator configuration. A Service Config with
`watchdog.enabled: false` appeared enabled, and a configured Project grace override disappeared in
favor of 30 minutes. The daemon had no accepted snapshot from which it could enforce either the
configured values or the defaults.

## Decision

Watchdog policy is **unavailable** whenever `RuntimeConfigReloader` has no valid runtime snapshot.
Defaults are applied while constructing a valid candidate snapshot, not when reading an absent
snapshot.

The unavailable state is projected consistently:

- `status` and its dashboard name the Watchdog configuration as unavailable and omit Run idle/grace
  indicators.
- `show-run` names the Watchdog policy as unavailable and does not calculate grace, convergence
  budget, or wall-clock deadline fields.
- `GET /api/status` sets each active Run's `watchdog` field to JSON `null`.
- `GET /api/runs/:id` sets the top-level `watchdog` field to JSON `null`.
- The server-rendered Run page shows an unavailable notice and no calculated Watchdog fields.

JSON `null` is deliberately distinct from `{ "enabled": false }`: null means no accepted policy is
known, while the object means a valid effective snapshot explicitly disabled the Watchdog.

An invalid reload after a successful load is unchanged. The last-known-good snapshot remains the
effective snapshot, so every surface continues to resolve and show its Watchdog policy while the
reload error is reported separately.

## Alternatives considered

**Preserve Watchdog fields parsed before an unrelated failure.** Rejected because Project Watchdog
overrides are part of the atomic defensive reload snapshot. Salvaging selected fields from a
rejected candidate would create a partial effective configuration and contradict SPEC §5.1.

**Persist a CLI-only last-known-good cache across invocations.** Rejected because it would introduce
a second configuration cache with independent freshness and invalidation rules. The daemon already
owns last-known-good state for its lifetime; a fresh CLI process should report that its own load has
no accepted snapshot rather than imply durable cache semantics that do not exist.

**Continue substituting defaults while reporting the reload error separately.** Rejected because a
validation error does not make a contradictory, calculated policy truthful. Operator surfaces must
distinguish unknown policy from both defaulted valid policy and explicit disablement.

## Consequences

- Snapshot atomicity stays intact: no field from a rejected first candidate becomes effective.
- API consumers gain one explicit nullable state for Watchdog policy.
- Status surfaces remain useful during configuration failure without presenting unenforced defaults
  as live policy.
- Direct HTTP-app callers that do not supply a Watchdog resolver retain the valid default-policy
  behavior used by standalone/test construction; a supplied resolver returning `undefined` is the
  explicit unavailable signal.

## Numbering

ADR `0091` is the most recent number in tree; this ADR is `0092`.
