# PR follow-up defers to a running FSM turn, not only a parked one

Status: Accepted

## Context

Five `symphonika` issues (#783, #784, #785, #788, #790) dispatched on 2026-09-18 each ran
`implement → wait_for_pr_open → code_review_fix` and never reached `simplify`/`wait_for_pr`/`merge`.
Every one of their PRs was nonetheless merged (`mergedBy: pmatos`, the daemon's own token — no
operator clicked merge), while the FSM's own `code_review_fix` Run was still actively running.
Three of the five were then SIGKILLed by `reconcileActiveRuns`'s closed-issue watchdog and
terminalized `cancelled`; the other two started just after the merge, found no open PR left to
review, and terminalized `blocked` via their own `BLOCKED.md` safety net. The dashboard showed all
five as failure-adjacent, though the underlying work fully succeeded.

ADR 0090 already established that a raw-FSM workflow's own parked position decides what happens to
its pull request, and that `isIssueOwnedByWorkflow` — checked by the global, orchestrator-wide PR
follow-up loop before it merges or dispatches review feedback — is how that deference is expressed.
Its reasoning enumerated the alternative to "parked" as "terminated or blocked" (ADR 0090, lines
24-25) and left a third case unnamed: an agent-kind state (`code_review_fix`, `simplify`, `autofix`,
`resolve_conflicts`, `implement`) whose Run is actively `running`. `isIssueOwnedByWorkflow` asked only
`findWaitingRunByIssue` (`state = 'waiting'`), so a Run mid-turn in one of those states was invisible
to it — as unowned as a genuinely finished one. `dispatchReviewFollowup` already refuses raw_fsm
outright regardless of ownership, so the review-feedback half of the loop was never exposed to this
gap. The merge call (`pull-request-followup.ts:492`, `tryMergePullRequest`) was never gated that way;
it only checked `workflowOwned` and `pullRequestReadyToMerge`. Once `code_review_fix` pushed the
commits that made checks green and resolved threads, the very next follow-up tick saw a mergeable PR
attached to an issue nothing claimed to own, and merged it out from under the running turn.

## Decision

`isIssueOwnedByWorkflow` now also returns `true` when `activeRuns.isIssueReserved(project, issue)` is
true — the same in-flight reservation `pickProjectCandidate`'s claim guard already unions with
`isIssueParkedAtRawFsmState` for its own, separate purpose (`run-controller.ts:3852` +
`:3865-3871`). This corrects ADR 0090's enumeration rather than reversing its rule: the parked
position still decides once a Run reaches one; the fix only widens what counts as "not yet handed
this back to the global loop" to include a Run still in the middle of getting there. The raw_fsm gate
stays first — a markdown compatibility-graph workflow has no reservation-worthy position and the
global loop remains its sole follow-up path, unchanged.

This is a defer-more, not act-more change: the follow-up loop only ever gained a new reason to
`continue` earlier. ADR 0090's own incident (a second dispatcher starting a duplicate chain,
replaying from `initial`, inflating the review-dispatch counter) was a do-more failure; a do-less
change cannot reproduce that class of bug. `pickProjectCandidate`'s claim guard is untouched — it
already calls the private `isIssueParkedAtRawFsmState` directly and unions `isIssueReserved`
independently, so widening the public `isIssueOwnedByWorkflow` wrapper only changes its one other
caller, the follow-up loop.

## Consequences

- A raw-FSM issue's PR cannot be merged, review-dispatched, or claim-released by the global follow-up
  loop for as long as *any* Run for that issue — parked or actively running — holds it. The window
  where the loop could act on a PR the FSM was still mid-turn on is closed.
- `releaseClaimIfNotOwned` (`pull-request-followup.ts:372-381`) now also no-ops while a Run is merely
  running, not just while parked. This does not strand `sym:claimed`: `runAttemptLifecycle`'s own
  finally block calls `classifyFailure` → `claimLabels.applyTerminal` independently of the follow-up
  loop on every Run's own cancellation or completion, which is the same mechanism that already
  released labels correctly for the five cancelled/blocked Runs above.
- `reviewFollowupCapReached` (`pull-request-followup.ts:413-417`) now records `false` in more cases —
  an issue a Run is actively running on was never going to reach the global loop's own dispatch cap
  regardless, since the loop was not going to dispatch for it. This is the intended effect, not a new
  gap.
- Does not correct the five already-mislabeled dashboard rows from 2026-09-18; they remain accurate
  history of what happened, not evidence of an ongoing problem once this lands.
