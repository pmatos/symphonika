# A wait/merge_pr state gives up after a bounded number of ticks with no tracked pull request

Status: Accepted

## Context

`wait_for_pr` (and any raw-FSM `wait`/`merge_pr` state naming PR predicates) is re-evaluated every
daemon tick against the tracked pull request for its issue. In `observeWaitPullRequestSignals`
(`src/lifecycle/run-controller.ts`), when `RunStore.findTrackedPullRequestByIssue` returns
`undefined` and the state isn't artifact-only (ADR 0087), the function logged `"no PR tracked yet"`
at debug level and returned `undefined` — forever, with no counter and no escalation.

Two runs against an external fan-out target (`pmatos/jsse` issues #314, #584) surfaced this: both
ended up parked here with no PR ever tracked, and stayed `sym:claimed` with no `sym:blocked` /
`sym:human-needed` for days, invisible to an operator. `detectStaleClaims`
(`src/lifecycle/stale-claims.ts`) doesn't catch this either — it explicitly skips any issue with a
live tracked run, and a parked `waiting` run is live.

Two distinct upstream causes fed the same parked state:

- The `implement` stage correctly determined an issue was a duplicate of already-merged work and
  deliberately opened no PR — a sanctioned exit. But `implement`'s FSM transition
  (`workflow.yml`) only checks `provider_success` + `branch_ahead_of_base`, with no notion of
  whether a PR exists, so the run still advanced through `code_review_fix` and `simplify` (each just
  discovering "no PR" and commenting) before parking here.
- `implement` committed a real fix locally but never pushed the branch or opened a PR (root cause
  not visible in orchestrator code).

Either way, nothing ever told the FSM to stop waiting. Symphonika already has the exact pattern
needed: a deterministic `merge_pr` refusal is bounded by a dedicated counter
(`RunStore.incrementMergeRefusalCount` / `MAX_MERGE_REFUSAL_ATTEMPTS`, ADR 0058's issue #635
amendment) that terminalizes to `blocked` after repeated permanent refusals. The "no PR ever
tracked" branch had no equivalent bound.

## Decision

`observeWaitPullRequestSignals`'s "no tracked PR" branch now counts attempts
(`RunStore.incrementPrUntrackedWaitCount`, a dedicated `runs.pr_untracked_wait_count` column — a
`state_transition_reason`-encoded token would be overwritten by every other kind of wait
observation, the same reason `merge_refusal_count` is dedicated). Below
`MAX_PR_UNTRACKED_WAIT_ATTEMPTS` (120 — about an hour at the default 30s poll interval, or a
project's configured `pollingIntervalMs`; comfortably above the ~10-attempt bound the separate
PR-discovery poller in `pull-request-followup.ts` gives itself), the wait records its attempt count
via `RunStore.recordWaitingActivity` and stays parked exactly as before. At the threshold, it
terminalizes the run directly from waiting-state reconciliation — mirroring
`terminateMergePrRefusal` → `terminalizeBlocked` exactly: `RunStore.recordWorkflowTerminal` with
`terminalStateId` set to the wait state's own id, then `terminalizeBlocked`, which cascades through
`ClaimLabelWriter` to `RunState = blocked`, `sym:blocked`, and `sym:human-needed` — the same
established "blocked" outcome ADR 0058 defines. The reason string is
`buildNoPullRequestTrackedReason(waitStateId, attempts)` (`src/lifecycle/terminal-reason.ts`),
following the `merge_pr_refused:`-prefix pattern that ADR 0058's issue #635 amendment established.

The counter applies uniformly to every non-artifact-only wait/merge_pr state with no tracked PR,
`merge_pr` included: a `merge_pr` state losing its tracked PR is already anomalous, and bounding it
the same way closes that gap too rather than adding another special case.

Unlike `merge_pr_refused:`, this new reason is **not** added to any notification-suppression set
(`src/notifications/issue-run.ts`'s `NON_FAILURE_TERMINAL_REASONS` / `isMergePrRefusedReason`
check). A silently-stuck issue surfacing to an operator is exactly the point of this bound, so it
notifies under the default "failures" email policy like any other blocked outcome.

## Consequences

- A wait/merge_pr state can no longer park forever when its pull request never materializes. The
  worst case is now a bounded wait (~1 hour by default) before `sym:blocked` + `sym:human-needed`
  give an operator a clear signal and the usual blocked-outcome affordances (UI pill, notification,
  eligibility guard).
- The two motivating `pmatos/jsse` runs (issues #314, #584) are confirmed parked at exactly
  `state = 'waiting'`, `current_state_id = 'wait_for_pr'` in the live run-store. Once this change
  ships (merged, released, and the daemon running against them upgraded) they resume ticking and
  cross the threshold on their own; no manual cleanup needed.
- **Not fixed here**: `discoverPullRequests`'s own silent exhaustion of `pr_discovery_attempts`
  (`src/pull-request-followup.ts`) has the same shape of gap on a different row set
  (`state = 'succeeded'`, not `'waiting'`) and isn't what parked #314/#584 — this bound is a
  sufficient, independent backstop regardless. Filed as a follow-up issue.
- **Not fixed here**: teaching the `WORKFLOW.md` prompt template to close an issue itself when it
  determines "no PR needed, duplicate" would resolve that specific case immediately instead of
  waiting out this bound, but touches a prompt template rolled out separately to each fan-out target
  (jsse/vow/s11/forseti) — a materially different scope/risk than this orchestrator-only fix. Filed
  as a follow-up issue.
