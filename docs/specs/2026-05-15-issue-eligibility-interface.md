# Issue Eligibility Interface

Status: proposed
Date: 2026-05-15

## Context

Issue eligibility is currently split across three modules:

- `src/issue-polling.ts` owns `evaluateProjectEligibility(issue, project, options)`.
- `src/lifecycle/reconcile.ts` consumes the predicate and skips it for state-advance runs.
- `src/lifecycle/active-runs.ts` stores `respectsIssueLabels`, which is set from
  `src/lifecycle/run-controller.ts` and consumed only by reconciliation.

The predicate is valuable. The flags that describe which version of the predicate to ask are the
part to remove. This proposal publishes a type-only sketch in
`src/lifecycle/eligibility-interface.ts`; it does not move existing runtime code.

## Proposed Module

The implementation module should be `src/lifecycle/issue-eligibility.ts` and should expose three
functions:

```ts
evaluateDispatchEligibility(issue, project): IssueEligibilityDecision

evaluateRunContinuationEligibility(
  issue,
  project,
  question: { scope: "label_controlled" | "fsm_owned" }
): IssueEligibilityDecision

evaluateIssueEligibility(issue, project, question): IssueEligibilityDecision
```

`evaluateIssueEligibility` is the shared implementation. The two named helpers are the public
questions that callers should prefer.

## Questions

### Dispatch Eligibility

Dispatch Eligibility answers: may this Project freshly claim this Issue?

It checks:

- issue state is open
- every configured `labels_all` label is present
- no configured `labels_none` label is present
- no Symphonika operational label is present

This replaces fresh-dispatch use of `evaluateProjectEligibility`.

### Continuation Eligibility

Continuation Eligibility answers: may already-owned lifecycle work keep going?

It always checks open/closed state first. After that it depends on scope:

- `label_controlled` checks configured `labels_all` and `labels_none`, but ignores active
  operational labels such as `sym:claimed` and `sym:running` because they are expected on an
  already-owned issue.
- `fsm_owned` skips configured label re-checks. State Advance, waiting rows, and FSM-owned retries
  use this scope because the state machine owns the next step while the walk is in flight.

The current `ignoreOperationalLabels` option disappears because operational-label handling is part
of the question, not a caller-supplied predicate modifier.

## State-Advance Rule Placement

Decision: the lifecycle module passes the question, not the answer.

The eligibility module should not know `RunController` entrypoints or raw FSM internals. It only
knows the two Continuation Eligibility scopes. The lifecycle module maps its own values to the
question:

- normal active run, label-driven continuation, and label-controlled retry:
  `continue_run / label_controlled`
- state advance, waiting-row recheck, wait-park callback, and FSM-owned retry:
  `continue_run / fsm_owned`

This coordinates with PR #147 for issue #139. If the Run Lifecycle proposal lands first, Planned
Step kinds such as `start_label_eligible_run`, `start_fsm_owned_run`, and
`re_evaluate_waiting_run` become the source of the eligibility question. If this proposal lands
first, the follow-up implementation should still avoid `respectsIssueLabels` and keep any temporary
scope value local to lifecycle planning or scheduling, not on `ActiveRunEntry`.

## ActiveRunEntry

`ActiveRunEntry` should keep no eligibility-related field.

The registry owns active run identity, provider cancellation, cancellation reason, and issue
liveness locks. It may grow a general lifecycle mode later if issue #139 needs one for status or
planning, but it should not carry `respectsIssueLabels` or any replacement boolean.

## Consumer Migration

| File | Rewrite |
| --- | --- |
| `src/issue-polling.ts` | Import `evaluateDispatchEligibility` for candidate filtering. |
| `src/lifecycle/reconcile.ts` | Ask `evaluateRunContinuationEligibility` with a lifecycle-derived scope. |
| `src/lifecycle/active-runs.ts` | Remove `respectsIssueLabels`; keep cancellation and liveness only. |
| `src/lifecycle/run-controller.ts` | Stop threading `respectsIssueLabels`; derive the question from lifecycle event or planned-step kind at each re-check. |

## Test Migration

| Test | Rewrite |
| --- | --- |
| `tests/eligibility-helpers.test.ts` | Move to the new module and cover dispatch, label-controlled continuation, and FSM-owned continuation. |
| `tests/reconcile.test.ts` | Replace direct `respectsIssueLabels: false` setup with lifecycle-derived continuation questions; closed issue still wins. |
| `tests/active-runs.test.ts` | Remove any eligibility-field assertions from registry tests. |
| `tests/dispatch-cancellation.test.ts` | Keep public behavior: label loss cancels label-controlled active runs and removes only `sym:running`. |
| `tests/dispatch-retry.test.ts` | Replace boolean retry payload expectations with label-controlled vs FSM-owned retry questions. |
| `tests/property-invariants.test.ts` | Add properties: dispatch includes operational-label exclusion; label-controlled continuation preserves ADR 0023; FSM-owned continuation ignores label drift but never closure. |

## Follow-Up Implementation Slices

1. Add the real `src/lifecycle/issue-eligibility.ts` implementation behind the proposed interface.
2. Move `evaluateProjectEligibility` callers to dispatch and continuation questions without
   changing behavior.
3. Remove `ignoreOperationalLabels` after all callers use question-specific helpers.
4. Remove `respectsIssueLabels` from `ActiveRunEntry` and retry scheduling once lifecycle-derived
   scopes cover active and scheduled re-checks.
5. Add property tests for the three eligibility invariants and keep the existing daemon behavior
   tests green.
