# discoverPullRequests escalates to blocked after exhausting pr_discovery_attempts

Status: Accepted

## Context

`discoverPullRequests` (`src/pull-request-followup.ts`) polls every `state = 'succeeded'` run with a
recorded `branch_name` and no `tracked_pull_requests` row, looking for a pull request GitHub opened
for that branch. Each miss increments `runs.pr_discovery_attempts`
(`RunStore.recordPullRequestDiscoveryAttempt`). `listRunsAwaitingPullRequestDiscovery` only selects
rows below `MAX_PULL_REQUEST_DISCOVERY_ATTEMPTS` (10), so once a run's counter reaches that ceiling
the row stops being selected at all.

Prior to PR #711, hitting the ceiling did nothing further: the run stayed `state = 'succeeded'`,
still holding `sym:claimed`, forever. PR #711 added a bounded fallback that releases the
`sym:claimed`/`sym:stale` labels once the ceiling is reached (`RunController.releaseIssueClaim`,
reason `pull-request-discovery-exhausted`) — closing the "stuck claimed forever" symptom, but the run
itself stayed `succeeded` with no signal that anything had gone wrong. Nothing marked the issue
`sym:blocked` or `sym:human-needed`, and no notification fired: an operator had no way to discover
that a run which reported success never actually produced a reviewable pull request.

This is structurally the same gap that `docs/adr/2026-09-05-1205-wait-for-pr-bounds-untracked-waits.md`
closed for `wait_for_pr`/`merge_pr` re-evaluation — a bounded wait/attempt count with no escalation —
but on the other row set that ADR explicitly deferred as a follow-up: `state = 'succeeded'` runs
whose branch never got a discoverable PR, rather than `state = 'waiting'` runs whose tracked PR
never appeared. Filed as issue #713.

## Decision

`discoverPullRequests`'s ceiling branch now calls a new `RunController` method,
`terminalizePullRequestDiscoveryExhausted`, instead of `releaseIssueClaim`. It mirrors
`terminalizeBlocked`'s shape (the same shared tail `terminateNoPullRequestTracked` uses for the
wait/merge_pr bound): it records `buildPullRequestDiscoveryExhaustedReason(branchName, attempts)` via
`RunStore.recordTerminalReason` with `"deterministic"` classification, flips `RunState` to
`"blocked"` via `RunStore.updateRunState`, adds `sym:blocked` + `sym:human-needed` via
`ClaimLabelWriter.markBlocked`, and then releases `sym:claimed`/`sym:stale` via
`ClaimLabelWriter.release` (still tagged with the existing `pull-request-discovery-exhausted` phase).

One deliberate difference from `terminateNoPullRequestTracked`: this path does **not** call
`RunStore.recordWorkflowTerminal`. That method also clears `current_state_id` and overwrites
`terminal_state_id` — correct for a *live* wait/merge_pr FSM position being converted to its first
terminal, but wrong here, since a `state = 'succeeded'` run already has its own `terminal_state_id`
from whatever state actually succeeded it. Overwriting that would destroy the record of what the run
actually did; only the `RunState` and the blocked-outcome labels need to change to reclassify an
already-terminal run's outcome.

The new reason, like `buildNoPullRequestTrackedReason`, is not added to any notification-suppression
set — a silently-stuck "succeeded but nothing to show for it" issue surfacing to an operator is the
point of this bound, so it notifies under the default failure-notification policy like any other
blocked outcome.

## Consequences

- A `succeeded` run whose branch never produces a discoverable pull request can no longer sit
  invisibly forever. The worst case is now a bounded number of discovery polls (10, at the default
  poll cadence) before `sym:blocked` + `sym:human-needed` give an operator a clear, actionable signal.
- `RunController.releaseIssueClaim`'s reason union dropped `"pull-request-discovery-exhausted"` — the
  only caller now goes through `terminalizePullRequestDiscoveryExhausted`, which calls
  `ClaimLabelWriter.release` directly with that phase tag instead.
- Together with ADR 2026-09-05-1205, both silent-give-up shapes flagged for `pull-request-followup.ts`
  and `wait_for_pr`/`merge_pr` re-evaluation are now closed.
