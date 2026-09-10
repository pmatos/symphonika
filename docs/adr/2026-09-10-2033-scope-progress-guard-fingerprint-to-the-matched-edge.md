# Scoping the workflow progress-guard fingerprint to the matched transition's own predicate

Status: Accepted

## Context

Issue #740 reported that `wait_for_pr`'s `has_unresolved_reviews: true -> autofix` transition
cannot distinguish a review thread the reviewer has already triaged (a DEFER reply with a linked,
open tracking issue, left deliberately unresolved so the reviewer can push back) from genuinely
unaddressed feedback: both look identical to the detector as `isResolved: false`. Three fixes were
proposed, none code-only:

1. Teach the detector to treat a DEFER-shaped reply as "addressed" despite `isResolved: false`.
2. Have `pm-autofix-pr` resolve DEFER threads itself once replied-to.
3. Have the `wait_for_pr -> autofix` transition/dispatcher suppress re-dispatch when the prior run
   already terminated blocked and the review-thread signal is unchanged since.

Reconstructing the actual incident (issue #731 / PR #735) from `symphonika.db`'s `runs` and
`workflow_progress` tables and PR #735's GitHub review-thread history showed the concrete mechanism.
The one unresolved thread (`PRRT_kwDOSPnIlc6hHojv`) was triaged as DEFER at 14:59:04Z and never
received another comment; the branch's last commit landed at 15:05:31Z and checks were green
shortly after. Despite that, `wait_for_pr -> autofix` was re-claimed **six times** between 14:38
and 18:44 before the progress guard (`workflow_progress`, keyed on `(project, issue, from_state,
to_state)`) finally recognized "no progress" and parked the run — roughly four hours and six wasted
`pm-autofix-pr` invocations after the thread was already settled.

The root cause was in the guard itself, not the detector. `progressFingerprint`
(`src/lifecycle/progress-fingerprint.ts`) hashes `headSha`, the review-feedback fingerprint, and
the **entire projected signal map** (`pr_open`, `mergeable`, `checks`, `review_decision`,
`unresolved_review_threads`, `has_unresolved_reviews`) for every re-evaluation of a parked `wait`
state. `wait_for_pr -> autofix` is gated solely on `has_unresolved_reviews: true`, but the
fingerprint that decides whether retaking that edge counts as "progress" also includes `mergeable`
and `checks` — both of which can (and, against this repository's own fast-moving `main`, routinely
do) flip transiently for reasons that have nothing to do with review feedback: GitHub recomputing
mergeability against a base branch that just advanced, or a check re-running. Each such flip changed
the hash even though the one fact the edge's own predicate depends on — whether the thread was still
unresolved — never changed, so `claimProgressEdge`'s exact-fingerprint comparison kept reading
"new observation" and re-dispatched `autofix` again.

## Decision

Scope the progress-guard fingerprint, for a `wait`/`merge_pr` re-evaluation that advances to a
non-terminal state, to the **matched transition's own `when` predicate** instead of the full
projected signal map. `StateMachineDecision`'s `advance` variant now carries `when: WorkflowPredicateMap`
— the literal predicate `decideNextStep` already matched against the observed signals — and
`run-controller.ts`'s wait-reevaluation path passes `decision.when` (not the full `signals` object)
into `progressFingerprint`. `headSha` and the review-feedback fingerprint remain unconditionally
included, unchanged: they are the documented safety net for the case the projected signal map
cannot express at all (a reviewer resolving one thread while opening another moves nothing in
`unresolved_review_threads`'s count).

This is a generic fix, not one special-cased to review feedback: any edge's progress is now judged
only by the observation its own predicate actually depends on. A `checks: failure -> autofix` edge
stops caring whether `mergeable` churned in between; a `has_unresolved_reviews: true -> autofix`
edge stops caring whether `checks` or `mergeable` churned. Where two transitions with different
predicates target the same state (e.g. `wait_for_pr`'s `checks: failure -> autofix` and
`has_unresolved_reviews: true -> autofix`), they still share one `workflow_progress` row (keyed by
`from_state`/`to_state` only, unchanged), but a change from one matched predicate to a materially
different one is itself real information and correctly still perturbs the fingerprint, since
`decision.when` differs between them.

### Why not the other two options

Option 1 (detect DEFER text) was rejected as inconsistent with SPEC §4.3 ("Symphonika does not
parse issue body text, task lists, GitHub Projects fields, or linked PRs to infer blockers") and
§12.1 ("Symphonika does not infer the same verdict from comment text"). Option 2 (resolve DEFER
threads automatically) was rejected because it trades away `pm-autofix-pr`'s deliberate
leave-it-unresolved-so-the-reviewer-can-push-back convention — an explicit non-goal in the issue.
Both would also have left the six-redundant-dispatch waste in place for any *other* cause of
transient signal churn, not just DEFER threads specifically; this fix addresses the general
mechanism instead.

## Consequences

- A DEFER-triaged (or otherwise stable) review thread now stops re-dispatching `autofix` after the
  first observation that nothing relevant changed, instead of waiting for `checks`/`mergeable`
  churn from unrelated repository activity to coincidentally repeat.
- `tests/workflow-progress-guard.test.ts` gained a regression test asserting that a `checks` flip
  between two identical-thread observations does not reset the guard's memory of the
  `has_unresolved_reviews`-gated edge.
- `tests/state-machine-dispatch.test.ts`'s exact-equality assertion on an `advance` decision was
  updated for the new `when` field; every other consumer already used `toMatchObject` and is
  unaffected.
- Not fixed here: the detector still cannot itself express "this thread was triaged" as a distinct
  state — it remains a binary `isResolved`. That remains open if a future need arises to distinguish
  those states for a purpose other than loop suppression (e.g. dashboard display).
