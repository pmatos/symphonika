# Progress Guard parks notify on the issue

Status: Accepted

## Context

The Progress Guard (issues #616, #619) holds a parked Run in place when re-taking a transition would
repeat work it already did on an identical observation, or when an edge exhausts its budget. Its only
signal was a dashboard banner and a daemon `warn` log. On 2026-10-03 rightkey#944's `resolve_conflicts`
run rebased locally but exited without pushing; the PR stayed conflicting, `wait_for_pr` re-selected the
same edge every poll, the guard refused it, and the issue sat `sym:claimed` with no label or comment
(symphonika#827). Three other rightkey PRs were parked the same way after `autofix` changed nothing.

## Decision

When the guard refuses an edge, Symphonika flags the issue for a human without terminalizing the Run:
it adds `sym:human-needed` and posts one comment describing the refused edge or the exhausted budget.
The Run stays parked and keeps `sym:claimed`; neither `sym:blocked` nor `sym:failed` is added.

The notification is idempotent on the persisted `state_transition_reason`: it fires only when the
park's reason changes into the guard reason, so the five-minute re-refusal and a daemon restart do not
repeat it. When the park stops being held (the observation moves on, or the edge is advanced after a
push), `sym:human-needed` is removed again.

## Why not terminalize blocked

A guard park is a resting state, not a failure. A human push changes the head SHA and lets the edge
through, and a green PR whose review threads were all triaged DEFER (issue #740) legitimately parks on
the same path while waiting for a merge. `terminalizeBlocked` would release the claim and end both.

## Consequences

- A DEFER-only park also gets `sym:human-needed` and one comment. The banner already called it manual
  attention; the label now matches.
- The label removal can also remove a `sym:human-needed` a person added by hand while the run was
  parked.
- Delivery is at-most-once. The reason is persisted before the best-effort label/comment write and is
  the dedup key, so a GitHub failure on the first refusal is logged but not retried, and the dashboard
  banner is then the only signal.
- Only a park whose reason is still the guard's is cleaned up. A `merge_pr` refusal or "no pull
  request tracked" tick that overwrites the reason, or an operator cancel, leaves the label behind.
- Advancing into a `failure` or `blocked` terminal keeps the label; only `success` removes it.
- Not addressed here: an agent that claims success without pushing (needs a remote-head-moved
  signal; `branch_advanced_since_attempt_start` is a local diff digest and cannot see a push).
