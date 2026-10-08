# Never-started checks park for a human instead of routing to repair

Status: Accepted

## Context

A check run that GitHub Actions refused to start (billing failure, spending limit) concludes as an
ordinary `failure`. Pull Request State saw only the rollup state, so `wait_for_pr` routed it to
`autofix`: an agent run (about $2 each) was spent on something no code push can fix, then the Progress
Guard parked the issue (symphonika#828, rightkey#994/#996/#919).

## Decision

The PR follow-up GraphQL query also reads the rollup's check-run conclusions and first annotations.
When the rollup is failing and every failing check run is a `STARTUP_FAILURE` or carries the
"job was not started" billing annotation, the raw state carries `neverStartedChecks` and Pull Request
State reports `checks: unknown` (plus `checksNeverStarted`). `unknown` is omitted from the predicate
projection, so `checks: failure` edges do not match and merge policy still refuses.

The parked wait records `state_transition_reason = checks_not_started` and flags the issue
`sym:human-needed` with one comment naming the checks, deduplicated on that persisted reason. The
label is removed when the observation moves on. The Run stays parked and claimed.

## Why not a new `checks` value

A fourth value would force every authored wait to add a transition for it (the dead-end validation
enumerates settled values), breaking existing workflows for a case they cannot sensibly handle.
Reusing `unknown` keeps the wait parked, which is the correct resting state.

## Consequences

- Classification is all-or-nothing: one real failing check, a failing commit status, or more than 100
  contexts (truncated page) keeps ordinary `failure` routing.
- Detection of billing failures relies on annotation wording; `STARTUP_FAILURE` is matched by
  conclusion. A reworded annotation falls back to the old behaviour.
- Delivery is at-most-once, like the Progress Guard notification.
