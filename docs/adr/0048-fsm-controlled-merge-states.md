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
