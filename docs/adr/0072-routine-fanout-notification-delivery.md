# Routine Fan-out Notification Delivery

Status: Accepted

## Context

ADR 0069 introduced the durable Routine Fan-out and its grouped summary, but wired delivery only
through an optional `notifyRoutineFanout(notification)` callback on `StartDaemonOptions`
(`src/daemon.ts`). The real `symphonika daemon` CLI path (`src/cli.ts`) never supplied it, so
`deliverReadyRoutineFanouts` (`src/routines/dispatcher.ts`) was a no-op in every production
deployment: a fan-out that became summary-ready just sat at `notification_state = 'pending'`
forever. Only tests and custom Node embedders ever passed the hook. This was flagged as a P1 by
the automated reviewer on PR #351 and filed as issue #355, deferred behind #292's SMTP sink
(ADR 0067) landing first, which it has (via PR #349/#376).

Meanwhile, `options.notificationSink` and the `notification: { createSink, resolveConfig }` object
already threaded through `dispatchDueRoutines` (`src/daemon.ts`) is the generic embedder extension
point every other notification source uses: Routine Firings (ADR 0067), terminal issue Runs, and
daemon health (ADR 0071). A second, parallel, ungated delivery path for fan-outs would bypass the
independent `email.sources` mute switches ADR 0071 established as an accepted operator-facing
guarantee.

## Decision

### Fan-out delivery is consolidated onto the shared notification path

`notifyRoutineFanout` is removed from `StartDaemonOptions` and `DispatchDueRoutinesInput`.
`deliverReadyRoutineFanouts` instead resolves a sink and config from the same
`notification: { createSink, resolveConfig }` object already used for Routine Firing delivery,
exactly as `daemon.ts` already builds it: `options.notificationSink ?? createSmtpNotificationSink(config, { env })`.
No embedder-specific wiring remains; a Node embedder that already provides `notificationSink` gets
fan-out delivery for free.

`resolveConfig()` returning `undefined` (no `email:` block configured) is resolved once per tick,
before any fan-out is claimed, and leaves every ready fan-out `pending` — matching ADR 0069's
"remain durably pending" contract. This is a "not wired yet" state, not a policy decision.

### A new independent `routine_fanouts` source switch

`email.sources` gains a fourth switch, `routine_fanouts` (default `true`), alongside
`routine_firings`, `issue_runs`, and `daemon_health`. This lets an operator keep the grouped summary
while muting per-firing mail, or vice versa, matching ADR 0071's precedent for independent source
control.

### `on` policy and `notify: false` for a grouped summary

Unlike a single Routine Firing, a fan-out has no per-target report output reachable from
`RoutineFanoutStatus` — only the group's `failureCount`, `issueCount`, and `pullRequestCount`
(already computed for the summary subject line per ADR 0069). The `on` policy is therefore defined
purely in terms of those counters:

- `always`: send regardless of counters.
- `failures`: send only when `failureCount > 0`. A group where every target succeeded or was
  skipped for overlap/cap does not count as a failure, matching ADR 0069's "skips are visible per
  Project but do not count as failures."
- `changes` (default): send when `failureCount > 0 || issueCount > 0 || pullRequestCount > 0`.

`notify: false` on a Routine's declaration is uniform across every target of its fan-out (the field
lives on the shared `RoutineDeclaration`, materialized identically per Project per ADR 0069), so it
mutes the group notification the same way it already mutes each target's own per-firing
notification — no separate per-fan-out opt-out is introduced.

### A policy-suppressed group is a distinct terminal outcome

`routine_fanouts.notification_state` gains a fourth value, `skipped`, alongside `pending`,
`sending`, and `sent` — mirroring `routine_firings.notification_state` and `runs.notification_state`,
both of which already distinguish a deliberate suppression from an actual send. Without this, a
policy-gated or source-muted or `notify: false` group would have to be recorded either as `sent`
(misleading — nothing was delivered) or left `pending` (re-evaluated and re-skipped every tick,
forever). `completeRoutineFanoutNotification` now takes a discriminated `{ error, id }` (failed,
returns to `pending` for retry, unchanged) or `{ id, state: "sent" | "skipped" }` (both terminal).

The claim ordering that makes this safe: `claimRoutineFanoutNotification` flips the row to
`sending` first, then policy is evaluated, then the outcome (`sent`, `skipped`, or back to
`pending` on a delivery error) is written. Gating *before* the claim would leave a suppressed group
`pending` and re-examined every tick; gating *after* the claim guarantees exactly one policy
decision per ready fan-out.

## Consequences

- The real `symphonika daemon` CLI path finally delivers grouped fan-out summaries in production;
  this was the sole remaining gap from ADR 0069's design.
- Fan-out delivery inherits every hardening already applied to the shared notification path:
  terminal-reason redaction (PR #376), best-effort bounded retry/timeout
  (`deliverNotificationBestEffort`), and reload-time config resolution.
- Operators get a fourth independent mute switch and can distinguish "policy decided not to send"
  from "not configured yet" and from "sent" in the fan-out's own durable state.
- `StartDaemonOptions.notifyRoutineFanout` and the raw `RoutineFanoutNotification`-shaped callback
  are removed; a Node embedder wanting fan-out delivery now supplies `notificationSink` like every
  other notification source.
- Every clock-matched Routine creates a fan-out even when it targets one Project (ADR 0069), so a
  single-target Routine now delivers both its own per-firing notification and a one-target grouped
  summary. Under `on: always` both send for every firing. In practice this rarely doubles mail under
  the default `changes` policy — a successful `kind: report` firing with output sends its own
  notification while the group's failure/issue/PR counters can still be zero, keeping the summary
  itself suppressed — but an operator who wants exactly one message per single-Project Routine
  should set `email.sources.routine_fanouts: false`.
