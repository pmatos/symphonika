# Project Detail Successful-Poll Freshness

## Context

The Dispatch Project capacity strip reports the age of the issue snapshot and marks it
`(pre-restart)` when that snapshot predates the current daemon process. The page currently derives
both from `project_states.last_poll_finished_at`. That timestamp advances after failed polls even
though failed polls deliberately preserve the previous issue snapshot, so the page can present old
evidence as if the current process refreshed it.

The operator-visible contract is: after a successful poll, a daemon restart, and a failed poll, the
Project detail page keeps the prior snapshot, reports its successful-poll age, marks it
`(pre-restart)`, and separately reports that polling is failing.

## Approaches Considered

1. Persist `project_states.last_successful_poll_at` and update it only when a Project poll succeeds.
   This preserves latest-attempt timing and error evidence while giving snapshot freshness its own
   durable source. This is the selected approach.
2. Derive freshness from the greatest `project_issue_snapshots.polled_at`. This cannot represent a
   successful poll that returned zero issues and couples Project status to the contents of another
   table.
3. Stop advancing `last_poll_finished_at` on failures. This would make its name and existing CLI
   presentation misleading and would discard useful evidence about when the latest failed attempt
   finished.

## Design

Add a nullable `last_successful_poll_at` column to `project_states` and expose it as
`ProjectState.lastSuccessfulPollAt`. New databases create the column directly. Existing databases
add it through the Run Store's idempotent column migration and backfill it from
`last_poll_finished_at` only when the latest recorded poll succeeded; an earlier success behind a
newer failure cannot be reconstructed reliably, so those rows remain unknown until the next
successful poll.

`recordProjectPollOutcome` continues to advance the existing started/finished/outcome/error fields
on every attempt. Its insert initializes `last_successful_poll_at` to the completion timestamp for
a success and to null for a failure. Its conflict update replaces `last_successful_poll_at` only
for a success and otherwise preserves the stored value.

The Project detail capacity strip uses `lastSuccessfulPollAt` for the displayed poll age and the
pre-restart comparison. It continues to use `lastPollOk` and `lastPollError` for the separate
failing indicator. Other surfaces retain their existing latest-attempt semantics.

## Testing

An HTTP integration test drives the public `GET /projects/:name` seam with fixed time:

1. record a successful poll;
2. place daemon startup after that success;
3. record a failed poll after startup;
4. request the Project detail page;
5. assert that the successful-poll age and `(pre-restart)` marker remain visible alongside the
   failure indicator.

This sequence is deterministic and fails against the current implementation because the failed
poll replaces the timestamp used by the capacity strip.
