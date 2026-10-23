# Review and rebind a parked state provider override

Status: Accepted

Part of epic #844, slice #864, stage 2 of 2 (the guarded review and rebind action; the detector and
the park are stage 1). Settles the items ADR-2026-10-23-1738 listed under "What stage 2 needs".
Extends ADR-2026-10-13-0659 (per-state choices), ADR-2026-10-09-0743 (Run-Chain Provider Plan) and
ADR-2026-10-23-0903 (recovery, whose service guards and launch route this reuses).

## Decision

A Run Chain parked with `provider_override_review_required` is resolved by an operator through
`GET`/`POST /issues/:project/:number/review-override` (and `POST
/api/issues/:project/:number/review-override`, JSON, answering `202` / `409` / `422` like recovery).
Both are authenticated and CSRF-protected exactly like Start and recovery. The Issue page links to the
preview only while the Issue's newest Run is that parked Run, and shows that link **instead of** the
recovery link for it: recovery launches once and leaves the stale choice in place, so the same state
would park again the next time the walk entered it. The recovery routes themselves are unchanged and
still accept a parked Run by direct request.

The operator picks one of three resolutions for the state under review:

| Resolution | The plan entry for the state becomes | The provider that launches |
| --- | --- | --- |
| `keep` | the recorded provider, with the **current** definition | the recorded provider |
| `rebind` (to another configured provider) | the chosen provider, with the current definition | the chosen provider |
| `drop` | removed | the chain-wide provider (the plan always has one) |

No resolution is preselected in the form: keeping a provider on a definition it was never chosen for
is the dangerous outcome, so the operator must choose.

### The preview

Built from a configuration and workflow reload (`reloadConfig`), not the daemon's last hot-reloaded
snapshot. The park was decided on a forced reload at State Advance, which can be ahead of that
snapshot; judging against a stale one would show the edit as reverted or bind the choice to a
definition the launch then disagrees with. The preview shows:

- the **selected provider** (the recorded choice) and the chain-wide provider `drop` falls back to;
- the **old evidence**: the digest and canonical definition stored on the plan when the choice was
  made (the only place it can come from, per ADR-2026-10-23-1738), against the **new evidence**:
  the digest and canonical definition of the state in the current workflow, with a field-by-field
  "what changed" table (`diffStateDefinitions`) and both full definitions;
- the graph the chain last walked: the nearest Run, from the parked Run up its parents, that captured
  a `workflow-graph.json`, with its workflow name and hash and the state's digest in it. A chain
  parked at its fresh claim has none and says so;
- the parked Run, its reason, blockers (a live reservation, a claim label in the last poll snapshot,
  no available provider) and the consequences. A removed state shows no form (below).

### Guards

The resolve reuses the recovery service's guards, in the same order and with the same two-phase
shape (local checks, live GitHub read outside `dispatchMutex`, local checks again inside it): the
Run belongs to the Issue and is the open review (blocked with the review reason), it is at the
state the operator saw, the workflow is a raw FSM, the Run's repository is the Project's, it is the
head of the Issue's history (`superseded`), the Issue is open with no `sym:claimed`, `sym:running` or
`sym:stale`, and no Issue Reservation or pending shutdown resume exists (`live-run`). Because a
recovery and a review resume the same Run through the same scheduled State Advance, the reservation
check is also what refuses either one while the other is in flight; a resolved review leaves a
Continuation child, so a later recovery or resolve is `superseded`.

Review-specific refusals: `invalid-resolution` (unknown resolution, a rebind to the provider already
recorded or to an unknown name), `provider-unavailable`, `no-open-review` (the Run is not parked for
review, or the chain holds no recorded choice for the state), `state-removed`, `invalid-position`
(the state is no longer an agent state), and `evidence-changed`: the form carries the digest the
operator reviewed, and a resolve whose digest differs from the live definition is refused instead of
binding the choice to a definition nobody looked at. Every refusal renders as a titled message ending
"Nothing was written."

### A removed state is not resolvable here

If the workflow no longer has the state, the chain cannot resume at it, and the two escapes ADR-2026-10-23-1738
floated do not hold up: naming a different target state is a routing decision, not a provider
decision, and breaks "same position", and dropping the choice only moves the failure to
`workflow_state_not_found`. The preview shows the evidence and the resolve refuses with
`state-removed`. The way out is to restore the state in the workflow and review again, or to start
the Issue again. How to resolve a removed-state review is left to the maintainer.

### Where the plan is rewritten

The plan is immutable once consumed (ADR-2026-10-09-0743, ADR-2026-10-13-0659), and the detector reads
the recorded definition from it. Of the two options stage 1 left open, this ADR takes the plan
entry update, **applied by the resumed Run's claim** and by nothing earlier:

- Accepting the request writes only the `override_review` intervention row (`scheduled`), then
  schedules the State Advance. It does not touch the plan. Several exits drop an accepted resolve
  while the Run stays parked: a restart (the sweep drops `scheduled` rows), a closed or ineligible
  Issue at the launch's own refresh, a dropped Project, a shutdown. Rewriting the plan at acceptance
  would leave it mutated by each of those, and for `drop` would strand the review (the entry is gone,
  so nothing is left to resolve).
- The scheduled advance computes the plan **as it will read** (`withReviewedOverride`) and runs both
  the detector and the provider precedence against that. If the workflow moved again between the
  operator's confirm and the launch, the detector finds the new difference and parks again; the
  intervention is then settled `failed` with the new parked Run, "the state's definition changed again
  before the resumed Run launched". The provider that launches is the one the resolution names, and
  its `provider_source` is `operator_state` (keep, rebind) or `operator_chain` (drop): a review is not
  an `operator_recovery`, because it changes the standing choice rather than overriding it for one
  launch.
- The rewrite is persisted by `settleOverrideReviewLaunch` in the **same transaction** that settles
  the intervention `launched`, from the claim's `afterClaim` hook, followed by withdrawing
  `sym:blocked` and `sym:human-needed` as recovery does. Every exit before the claim leaves the plan
  and the open review exactly as they were, and the preview offers all three resolutions again.
- A later pass through the state (a loop) resolves from the rewritten plan, whose recorded digest is
  now the current one, so it does not park. A **later** edit of the state differs from that digest
  and parks again, measured against what the review recorded. `state_providers_json` is therefore
  mutable by exactly this one audited action; the plan's `provider`, graph fingerprint and status are
  never touched.

The alternative (the detector consulting resolved `override_review` rows keyed by chain, state and
digest) would have left the plan truthful about the original choice but made the detector and the
provider precedence read two sources, with `drop` and `rebind` needing a second lookup in
`resolveEffectiveProvider`. One source of truth won.

### Audit record

`chain_provider_interventions.kind = 'override_review'` is written when the operator resolves, not
at park time (the startup sweep drops every `scheduled` row, and the park is already durable in the
Run). Three nullable columns were added beside the existing ones, for this kind only: `resolution`
(`keep`, `rebind`, `drop`), `old_digest` and `new_digest`. `from_provider` is the recorded provider
and `to_provider` the provider that launches (the chain-wide one for `drop`). The row reaches
`launched` with the new Run id at the claim, or `failed` / `dropped` with the reason. As for recovery,
there is no operator identity column; `requested_via` records the channel.

### Resuming

The launch is the recovery mechanism (ADR-2026-10-23-0903): a scheduled State Advance whose parent is
the **parked Run** (for a fresh-claim park that is the chain's root), creating a new Continuation Run
that inherits the Workspace and branch, with no replay of earlier states. The parked Run keeps its
`blocked` state, reason and (for a State Advance park) no Attempts, so the timeline reads park,
review, resume as separate rows. A failed pre-provider launch (provider command missing, state gone)
settles the review intervention `failed`, as it does a recovery.

### Timeline

`recoveredRunIds` in the timeline now covers every intervention kind, so the parked Run stays a
"Blocked" row after its Continuation exists (previously it would have read "Completed"). Each
`override_review` intervention is a row after the Run it acted on, naming the decision ("kept
claude for the changed state", "rebound the state from claude to codex", "dropped the claude choice;
the state now follows the chain-wide codex"), the two digests, and the outcome; a `failed` or `dropped`
resolution says the parked Run is unchanged and the stored choice was not rewritten.

## Acceptance of #864

1. A changed agent-state definition with a persisted per-state override parks before provider launch
   (stage 1) and offers the guarded review and rebind (this stage).
2. The review shows old and new evidence and the selected provider; resolving records the decision and
   resumes the same Run Chain at the same state through the position-preserving Continuation.
3. A chain-wide choice, a workflow without operator overrides and a legacy choice never park (stage 1
   tests: "keeps a chain-wide choice across a rename, an edit and a removal of other states", "keeps
   the last-known-good workflow for a plan with no per-state choices", "does not park a choice
   recorded before definitions were captured").
4. An unrelated state edit does not park an unaffected override (stage 1 test: "does not park when
   only an unrelated state changed").

## Consequences

- The Issue page offers the review instead of the recovery for a parked Run, and a removed-state
  review has no in-product resolution.
- A review that is accepted but whose launch never claims can be resolved again; the dropped row
  stays in the timeline as the record of the failed attempt.
- Previews and resolves trigger a configuration reload, with the same side effects as an editor save
  (the health observation and the change event).
- A workflow edit between the operator's confirm and the launch parks the chain a second time rather
  than launching on a definition the operator did not see.
