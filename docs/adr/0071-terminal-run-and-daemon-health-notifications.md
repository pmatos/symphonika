# Durable Run Digests and Edge-Triggered Daemon Health Notifications

Status: Accepted

## Context

The SMTP Notification Sink initially served terminal Routine Firings. Issue
Runs and daemon health remained visible only through operator surfaces. Sending
one message at each lifecycle write would make cancellation or cap-exhaustion
storms noisy, while tracking terminal rows only in memory would lose events
across restart.

## Decision

Terminal issue Runs use a durable per-Run notification delivery marker and a
daemon-owned digest coordinator. The coordinator sends at most one message per
window, defaults the window to 60 seconds, renders at most 50 Run details, and
records success, suppression, or final delivery failure separately from Run
state. A transient attempt is not pending while it still has a retry; exhausted
transient failures and every other genuine terminal outcome are pending.

The `failures` policy is keyed by `terminal_reason`, not `RunState`.
`no_workspace_changes` and `workflow_terminal_blocked` are non-failures;
`no_progress`, `cap_reached:*`, orphan recovery, and provider or
infrastructure reasons are failures. Cancellation is not failure.

Daemon-health notifications are edge-triggered for last-known-good reload
fallback and invalid-new-Routine declarations. Daemon start reports startup
reconciliation counts, and one Watchdog reconciliation reports its terminated
Runs as a group.

The Service Config exposes independent `routine_firings`, `issue_runs`, and
`daemon_health` source switches under `email.sources`. All default enabled.

Every new path reuses bounded best-effort delivery and catches notification
errors outside Run, Routine Firing, and daemon-tick control flow.

## Consequences

- A terminal Run pending at daemon exit is delivered after restart rather than
  lost.
- A burst has bounded mail frequency and message size.
- Operators may keep Routine Firing mail while muting Run or daemon-health
  mail independently.
- Health transitions are process-local; daemon start is itself the recovery
  signal after a process restart.
- The Run Store gains delivery evidence, but notifications remain evidence
  rather than lifecycle state.
