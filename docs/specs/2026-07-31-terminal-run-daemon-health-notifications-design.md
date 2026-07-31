# Terminal Run and Daemon Health Notifications

## Scope

Extend the existing SMTP Notification Sink to terminal issue Runs and daemon
health events without changing Routine Firing delivery semantics. The sources
are independently configurable.

## Configuration

The existing service-level `email:` block gains:

```yaml
email:
  sources:
    routine_firings: true
    issue_runs: true
    daemon_health: true
  digest_window_seconds: 60
```

All source switches default to `true`, preserving existing Routine Firing mail
while allowing either new source to be muted. The digest window defaults to 60
seconds.

## Terminal Run Delivery

Runs carry a durable notification delivery marker. Historical rows are
backfilled as skipped; a Run is set to pending only when it reaches a genuine
terminal outcome. A transient failed attempt remains deferred while a retry is
scheduled and becomes pending only when its retry budget is exhausted.

A daemon-owned coordinator claims all pending terminal Runs at the end of one
digest window and sends at most one message. The renderer includes at most 50
Run details and reports how many additional Runs were omitted. Thus a
cancellation or cap-exhaustion burst has bounded mail frequency and bounded
message size. Interrupted claims return to pending on daemon startup.

Policy is terminal-reason based:

- `always` includes every terminal Run, including success, block, and
  cancellation.
- `changes` includes successful Runs, whose success proves commits ahead of
  the base branch.
- `failures` includes genuinely bad terminal reasons. In particular,
  `no_workspace_changes` and `workflow_terminal_blocked` are not failures even
  if a legacy database row calls them failed. Cancellation is not a failure.
  `no_progress`, `cap_reached:*`, leaked-run recovery, and provider or
  infrastructure failure reasons are failures.

Policy-suppressed rows are durably skipped. Delivery success or final
best-effort failure is recorded without changing Run state.

## Daemon Health Delivery

Health delivery is edge-triggered in the live daemon:

- Service Config reload health tracks the transition into or out of
  last-known-good fallback.
- invalid-new-Routine health tracks the transition between no invalid
  declarations and one or more invalid declarations.
- daemon start includes counts from orphaned Run and Routine Firing startup
  reconciliation.
- Watchdog terminations are grouped per reconciliation pass.

Reload and Routine health are separate components so one existing failure
cannot mask a transition in the other. Repeated observations of the same
broken state do not send again.

## Failure Isolation

All new delivery runs through the existing bounded best-effort retry contract.
Sink construction, rendering, delivery, and status recording are caught at the
notification boundary. No error can change a Run or Routine Firing outcome or
escape a daemon tick.

## Test Seams

- `IssueRunNotificationCoordinator`: policy, rendering, persistence, and one
  bounded digest for a burst.
- `DaemonHealthNotifier`: transition suppression and recovery behavior.
- `RuntimeConfigReloader`: independent source switches and digest validation.
- daemon Watchdog integration: daemon-health notification for a termination
  even when issue-Run mail is disabled.
