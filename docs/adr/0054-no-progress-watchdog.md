# No-progress Watchdog

Symphonika will run a daemon-scope Watchdog during reconciliation to stop active provider runs that
have stopped doing observable work. The Watchdog is configured by `watchdog.enabled`
(default `true`), `watchdog.grace_minutes` (default `30`), and
`watchdog.sample_interval_seconds` (default `60`). Per-Project overrides are deferred.

The Watchdog samples Run rows in `queued`, `preparing_workspace`, and `running`. It deliberately
does not sample `waiting` rows; wait and merge states are already poll-reconciled by ADR 0047.

Each sampled Run has one durable `watchdog_samples` row keyed by `run_id` with `sampled_at`,
`last_tool_call_at`, `workspace_mtime_max`, `turn_id_set_size`, `output_tokens_total`,
`normalized_log_offset`, and `idle_since`. `idle_since` is persisted so daemon restart resumes the
grace window from the first observed idle sample instead of process boot. A companion
`watchdog_turn_ids` table records seen turn ids so `turn_id_set_size` can remain exact while the
sampler reads the Normalized Event Log only forward from the stored byte offset.

Progress is the four-signal any-advance rule:

- `last_tool_call_at` increased
- `workspace_mtime_max` advanced by at least one second
- `turn_id_set_size` increased
- `output_tokens_total` increased

`usage_updated` and `rate_limit_updated` alone do not count. Workspace sampling walks the tree once
per Watchdog tick and skips `.git/`, `target/`, and `node_modules/` at the directory-entry level so
those trees are never descended. Workflow-contract `evidence.ignore` integration is deferred.

When a Run remains idle until `now - idle_since >= grace_minutes`, the Watchdog records
`state = "stale"`, `terminal_reason = "no_progress"`, deterministic failure classification, and
requests provider cancellation through `ActiveRunRegistry`. The provider unwind must preserve this
Watchdog verdict rather than overwriting it with `cancelled`. Workspaces remain on disk for
inspection, and `no_progress` is not retryable under ADR 0020.
