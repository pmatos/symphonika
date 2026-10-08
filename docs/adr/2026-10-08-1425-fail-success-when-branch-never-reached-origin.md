# Fail a clean exit whose branch never reached origin

Status: Accepted

## Context

A provider run that exits 0 with commits ahead of base was recorded as `succeeded` even when its
`git push` was still running or had failed. On pmatos/rightkey (#830, #964) the agent's push hit a slow
pre-push hook, the tool call was backgrounded after the 600s timeout, and the run exited 0 with the push
unfinished. The branch never reached origin and the issue only surfaced ten PR-discovery checks later as
`pull_request_discovery_exhausted` (#833; #830/PR #831 only made that reason say whether the branch
reached origin).

## Decision

After `classifyFailure` reports a success with `commitsAhead`, and before the workflow outcome or the
retry logic read it, Symphonika asks GitHub (`listBranchCommits`, the 30 most recent commits) for the Issue Branch and
checks that the workspace `HEAD` is among them, so a branch that moved ahead (a reviewer commit, an
"Update branch" merge) still counts as published. A missing branch or a `HEAD` absent from that window reclassifies the attempt as a
`failed` / `transient` terminal with reason `branch_not_pushed: branch "<name>" has commits but never
reached origin (...)`.

- **Retry, not terminal failure.** The reason is transient, so the existing retry budget applies. A retry
  reuses the workspace, so the next attempt finds the committed work and only has to push. Once the budget
  is spent the ordinary failure path (`sym:failed`, notification) surfaces it.
- **Fail open.** If `listBranchCommits` is unavailable, throws, times out, or the local head cannot be
  read, the original success stands. A GitHub outage must not fail good runs.
- **Exemption.** A raw FSM agent state with a transition into another `agent` state is not checked: the
  two states share the workspace, and the later state is the one that publishes (e.g. the red-team and
  refactoring stages of `refactor-workflow.yml` commit without pushing). Every other state is checked —
  markdown workflows, and raw FSM states that hand off to a terminal, `wait`, `merge_pr`, or content
  action, all of which depend on the branch being on origin.

## Considered options

- **`git ls-remote` / `refs/remotes/origin/<branch>` in the workspace.** Exact, but needs a live remote and
  pushed-tracking ref in every workspace; issue worktrees do not reliably carry the remote-tracking ref,
  and the existing test fixtures have no real origin.
- **An FSM-visible `branch_on_origin` predicate** letting a workflow author opt a state in or out. A
  cleaner long-term shape, but it widens the workflow surface; deferred.
- **Retrying a bounded number of times inside the attempt** (waiting for the push). Adds a hidden wait to
  the Run Slot; the retry budget already provides the second chance.

## Consequences

`GitHubIssuesApi.listBranchCommits` now gates success. A GitHub tip that lags a just-completed push by a
few seconds would cost one retry, not a failed run.
