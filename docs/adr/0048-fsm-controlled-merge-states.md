# FSM-controlled merge states reuse the wait-state reconciliation path

Symphonika's raw FSM workflow contract permits `action.kind: "merge_pr"` states so a workflow can
gate the merge of a Symphonika-owned pull request on workflow-defined predicates rather than the
opaque policy loop in `runPullRequestFollowup` (§12.5). Merge states are observation-driven, must
not launch a provider, and must respect the same `pull_requests.merge` policy that operators
configure for the orchestrator-wide merge loop.

Three design choices follow.

First, a merge state is parked the same way a wait state is. The state-machine decision treats
`merge_pr` as a "no execute_action on entry" action and lets the FSM evaluate transitions against
projected predicates. The waiting Run row is created synchronously by `applyWorkflowOutcome`
inside the parent agent run's terminal phase, so a daemon restart between the agent terminating
and the first re-evaluation only costs one tick — single-daemon v1 (ADR 0012) keeps scheduler
callbacks in memory, so the durable state has to live in the run-store row. This is the same
durability argument that ADR 0047 makes for wait states; merge states reuse the same
`createWaitingRun` path rather than introducing a parallel "merge_park" lifecycle.

Second, merge attempts go through the existing `reEvaluateWaitingRun` handler rather than a
separate dispatcher. On every tick the handler refreshes the tracked PR, projects predicates with
`projectPullRequestSignals` (shared with `runPullRequestFollowup` per ADR 0047), and — only for
`merge_pr` states — additionally consults the merge policy via `pullRequestReadyToMerge` and
calls `tryMergePullRequest`. A successful merge augments the projected signals with
`pr_merged: true` before `decideNextStep` runs, so the workflow author's transitions see the same
predicate vocabulary regardless of whether the merge happened externally (PR follow-up loop) or
inside the FSM. Failed, deferred, blocked, or missing-PR outcomes are recorded as a single
`state_transition_reason` line on the merge state's Run row via a new
`RunStore.recordWaitingActivity` helper. Recording the outcome on every re-evaluation gives
operators a per-tick audit trail without creating new Run rows.

Third, the merge-state action is scoped to the workflow instance's tracked PR. The handler looks
up the tracked PR via `findTrackedPullRequestByIssue(issueNumber, projectName)`, the same lookup
that wait states use. Symphonika never reaches across issues, projects, or arbitrary GitHub PRs
to merge — that scoping is what keeps `merge_pr` aligned with ADR 0044's "Symphonika owns only
its own PRs" stance and what makes the merge state safe to run with the same full-permission
posture as the rest of the orchestrator. The merge state never calls `git` and never touches the
workspace, so workspace preservation (§10) is inherited automatically.

The `method` field on the merge_pr action overrides `pull_requests.merge.method` for that state
only — operators can keep `squash` as the daemon-wide default while a release workflow that
needs a true merge commit declares `method: merge` on its FSM state. Other policy gates
(`require_status_success`, `require_review_decision`, `merge.enabled`) stay daemon-wide. That
asymmetry keeps the workflow file focused on FSM semantics while operators retain veto power
through service config: setting `pull_requests.merge.enabled: false` defers every FSM-driven
merge attempt without changes to workflow files.

The merge state intentionally reuses the wait-state predicate vocabulary instead of inventing
merge-only predicates. Workflow authors expressing "the merge succeeded" use `pr_merged: true`,
the same predicate the wait state uses; expressing "the merge cannot proceed" uses the existing
`mergeable`, `checks`, `review_decision`, `has_unresolved_reviews`, and
`unresolved_review_threads` predicates. This keeps the predicate vocabulary small and avoids a
divergence between the orchestrator-wide PR follow-up loop and the FSM-controlled merge path,
echoing ADR 0047's reasoning for sharing `projectPullRequestSignals`.

**Widened by ADR 0090.** The deference this ADR gives the global loop was scoped to `merge_pr`
states. It now covers any raw-FSM workflow parked at a state of its own, and covers the review
feedback as well as the merge: `isIssueOwnedByWorkflow` replaces `isIssueParkedInMergePrState`.

**Amended by issue #632.** That wider ownership makes transition completeness a validation
requirement for PR-observing `wait` states. The expanded graph must cover every settled actionable
combination of checks, mergeability, unresolved feedback, PR openness, and review decision; the
global loop will not rescue an omitted branch. This validation applies to `wait`, not `merge_pr`,
whose policy-driven retry behavior remains the deliberate parked-state contract described above.

**Amended by issue #635.** Merge-state reconciliation now separates deferred observations from
deterministic merge refusals. Policy-disabled and not-yet-ready pull requests remain parked, as do
merge errors without a deterministic refusal signal. GitHub documents HTTP 405 as "merge cannot be
performed," but gives no machine-readable signal for whether that is durable (a merge method the
repo's branch protection forbids) or will clear on its own (required checks still running under a
policy that does not gate on them, or a protection dimension Symphonika's policy does not model at
all). A 405 therefore parks with a bounded, counted retry — five ticks at the default poll interval
— rather than terminalizing on the first refusal; only once the bound is exceeded does the Run
terminate as `blocked` with an actionable `merge_pr_refused: PR #<number>: <message>` terminal
reason. The count lives in a dedicated `runs.merge_refusal_count` column rather than a
`state_transition_reason`-encoded token: that field is overwritten by every other kind of merge_pr
observation, so a token there would parse back to zero — and the bound would never trip — the
moment a permanently refused merge alternates with any intervening non-405 tick (issue #635 review
feedback on the first cut of this bound). A tracker adapter that exposes no `mergePullRequest`
capability has no such ambiguity and terminates on the first observation. These terminal paths are
handled inside merge-state
observation before the ordinary `decideNextStep` guard; an unconditional workflow catch-all would
be inverted because it cannot see hard failures and would match healthy readiness deferrals. The
built-in therefore deliberately has no catch-all transition.

Terminalizing releases FSM ownership (`current_state_id` goes `null`) in the same update that
asserts operator attention via `sym:blocked`/`sym:human-needed`. For an ordinary blocked outcome
that release is correct: the global PR follow-up loop should pick up review-followup duties.
For a deterministic merge refusal it is not — `isIssueOwnedByWorkflow` alone cannot see the
difference, so the follow-up loop would read the released ownership as "nothing owns this issue"
and re-attempt the exact merge just declared refused. `RunController.isIssueMergeRefused` is a
sibling predicate the follow-up loop consults before its own merge attempt, scoped to both the
`merge_pr_refused:` terminal-reason prefix and the specific PR number: `listOpenTrackedPullRequests`
can return more than one open tracked PR for the same issue (e.g. a redispatch onto a renamed
branch while an earlier PR stays open), so keying the guard by issue alone would let one PR's
refusal shadow — or fail to shadow — a different PR on the same issue. Every other blocked outcome
keeps today's contract of releasing ownership to the follow-up loop.
