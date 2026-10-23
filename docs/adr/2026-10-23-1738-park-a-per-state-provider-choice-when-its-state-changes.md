# Park a per-state provider choice when its state's definition changes

Status: Accepted

Part of epic #844, slice #864, stage 1 of 2 (the detector and the park; the review and rebind action
and its page are stage 2, recorded under "What stage 2 needs"). Extends ADR-2026-10-13-0659
(per-state choices), ADR-2026-10-09-0743 (Run-Chain Provider Plan) and ADR-2026-10-23-0903
(recovery).

## Problem

An operator's per-state provider choice is keyed by state id. ADR-2026-10-13-0659 accepted that a
choice is "not re-validated at claim or advance": if a workflow edit renames or removes the state,
the choice silently stops matching, and if the edit keeps the id but changes what the state does,
the choice silently binds to a state the operator never saw. The second case is the dangerous one:
"use claude for `review`" was said about one `review`, and the id now names another.

## Decision

A per-state choice records the **definition of its state** when the operator makes it. At the two
launch boundaries that already resolve a per-state choice, Symphonika compares that record with the
workflow it is about to launch from. If the state is gone or its definition differs, the Run Chain
**parks before any provider starts**, with its position preserved, and waits for an operator.

### What counts as a changed definition

The definition digest (`src/workflow/state-definition-digest.ts`, version `state-def-v1`) is a
SHA-256 over a canonical form of the *parsed* state, not of the YAML text. It covers:

| Part | How it is normalised |
| --- | --- |
| `action.kind` | as parsed |
| `action.prompt` | the path the state points at, with separators, `.` and `..` resolved (`./prompts//a.md` equals `prompts/a.md`) |
| `action.provider` | as parsed |
| `action.method`, `action.stateReason` | as parsed, after the parser's defaults (so an omitted `method` and the default are equal) |
| `action.labels` | a set: sorted and de-duplicated |
| `action.body` | line endings normalised to `\n`, trimmed |
| `complete_when` | predicate keys sorted; list values (`artifact_exists`) sorted |
| `transitions` | in order (the first matching transition wins, so order is meaning), each `to` plus its predicates normalised as above |
| `terminal` | as parsed |

Anything the parser discards is therefore never a change: comments, key order, quoting and flow
versus block style, and whitespace. Deliberately **not** part of the definition:

- **The state's id.** A rename is "the state is gone", not a changed definition.
- **The prompt file's content.** Only *which* prompt the state points at. Iterating on a prompt's
  wording is the normal way to improve a state and must not park every chain that picked a provider
  for it; pointing the state at a different file is a change of meaning and does.
- **Other states.** Editing state `Y` never changes the digest of `X`. A rename of `Y` rewrites the
  `to:` of every transition that targeted it, so those states do change; that is correct, because
  their routing changed.
- **The workflow's name, `initial`, or file-level hash.** The whole-file `graph_fingerprint` still
  guards the Start preview and is unchanged.

The digest string is prefixed with its scope version. A stored digest of another version is
*unverifiable*, exactly like a legacy row below, so changing what counts as a definition later never
parks the chains already in flight.

### Storage

`run_chain_provider_plans.state_providers_json` keeps `{stateId: ...}`, but a value is now either

- the legacy bare provider string (`"claude"`), written by plans from before this change, or
- `{ "provider": "claude", "definitionDigest": "state-def-v1:sha256:...", "definition": {...} }`.

`definition` is the canonical form that was hashed. It is stored beside the digest so the review has
the *old* definition to show: it cannot be recovered from a Run's captured `workflow-graph.json`,
because a park at the fresh claim has no captured graph yet, and a graph captured later already
shows the edit. The reader accepts both shapes. `ProviderPlan.stateProviders` keeps its
`{stateId: provider}` shape (precedence, the plan display and Retry's revalidation are unchanged);
`ProviderPlan.stateDefinitions` is the new parallel `{stateId: {digest, definition}}`, with entries
only for choices that recorded one.

Start records the digest of every chosen state from the loaded workflow, which the existing
graph-fingerprint check already guarantees is the previewed one. Retry of a `label_failed` plan
rewrites nothing: its fingerprint check guarantees the recorded definitions still hold.

### Detector

`findStaleStateOverride` (`src/lifecycle/chain-provider.ts`) returns a finding when the chain's plan
holds a per-state choice **with a recorded digest of the current version** for the state being
launched, and either the state no longer exists (`state_removed`) or it is still an `agent` state
whose current digest differs (`definition_changed`). It runs:

1. **At State Advance**, right after the target state is looked up in the reloaded workflow (or the
   last-known-good fallback, whichever will actually launch), before the not-found failure, the
   recovery branch and the terminal short-circuit. A removed state with a choice therefore parks
   instead of failing with `workflow_state_not_found`; a removed state *without* one still fails as
   before.
2. **At the fresh claim**, for the initial state of a raw FSM, after the provider is resolved and
   before any provider command or registration check.

It does **not** park, by construction:

| Case | Why |
| --- | --- |
| A chain-wide choice | It names no state; it stays unambiguous across any graph edit. |
| A workflow with no operator choices | There is nothing to compare; the existing defensive reload and last-known-good behaviour is untouched. |
| An unrelated state edit | Only the launched state's own digest is compared. |
| A legacy choice (bare string) or a digest of another version | *Unverifiable*: no baseline was recorded. Parking would suddenly stop every chain already in flight, so it keeps the previous behaviour (choice applied by id). The exposure of those choices is the one ADR-2026-10-13-0659 accepted. |
| A state that is still present but no longer an `agent` state | A per-state choice is already inert for a non-agent state (`resolveEffectiveProvider`), so there is no provider decision to be ambiguous. |
| A state the edited walk never enters | Only a launch is a boundary. A choice for a state nothing transitions to is never consulted, and never reviewed. |
| A recovery launch (ADR-2026-10-23-0903) | The operator has just named a provider for this exact launch against the current workflow; it outranks the choice. |
| An Attempt retry | A retry keeps the Run's provider (ADR-2026-10-13-0659); the detector is a launch-boundary check, not a mid-state one. |

A shutdown resume is a State Advance and is checked: a definition edited while the daemon was down
parks the resumed chain.

### The parked state

The chain stops in a Run that is `blocked`, using the same machinery as a workflow-blocked Run:

- `current_state_id` is the state under review (kept even when the workflow no longer has it) and
  `terminal_state_id` the same, as `recordWorkflowBlocked` leaves them, so the position survives.
- `terminal_reason` and `state_transition_reason` are
  `provider_override_review_required: state "<id>" has a different definition | no longer exists in the
  workflow since the operator chose <provider> for it (recorded <old digest>, now <new digest|absent>)`.
  The prefix is the dedicated reason: `isBlockedOutcome` classifies it as blocked, so the Run is
  `blocked`, the Issue gets `sym:blocked` and `sym:human-needed` with the reason posted as a comment,
  `sym:claimed` is released, and the Run appears in the attention list and on the Issue timeline as a
  Blocked row like any other blocked state. Durable and non-terminal here means the *chain* did not end:
  the Issue stays open, the position is kept and a Continuation can resume it; `blocked` is the Run's
  state, as for every Run that needs an operator.
- **State Advance**: a child Continuation Run of the advancing Run holds the park. It is created
  directly, as `recordStateAdvanceTerminalTarget` does, under `dispatchMutex`; nothing is launched and
  no in-flight slot is taken. It is *not* `failScheduledRunBeforeProvider`, which ends the Run as
  `failed`. `provider_source` stays `NULL`, as for any Run that never launched a provider.
- **Fresh claim**: the chain's root Run is created in `blocked` and consumes the plan in the same
  `dispatchMutex` hold, after re-checking the plan id and the claim guards a real claim re-checks. The
  consumption matters twice: a plan left consumable would park the Issue again on every poll, and
  stage 2 finds the plan through the root Run's `provider_plan_id`, like every later State Advance.

The plan is not rewritten: the choice and its recorded definition stay exactly as the operator saved
them, as the thing the review resolves.

The #863 recovery already accepts a `blocked` Run with a position, so an operator can today resolve a
parked chain by recovering that state on a provider of their choosing. That is an interim way out, not
the review: it does not touch the stored choice, and a removed state is refused by recovery
(`invalid-position`).

## What stage 2 needs

Stage 2 is the guarded review and rebind action (`POST` plus a page) and the timeline entry. This
stage leaves it everything it must read and one thing it must add:

- **Find the review.** A Run with `state = blocked` and a `terminal_reason` starting
  `provider_override_review_required:` is the open review. `current_state_id` is the state,
  `continuation_parent_run_id` the Run to resume from (null for a fresh-claim park, where the Run
  itself is the root). The Issue's newest Run must still be that Run (the `superseded` rule of
  recovery).
- **Old evidence.** `getChainProviderPlan(runId).stateDefinitions[stateId]` is the recorded
  `{digest, definition}` and `stateProviders[stateId]` the chosen provider. The Run's captured
  `workflow-graph.json` (on the parent Run) is the graph the chain walked, for context.
- **New evidence.** Recompute the digest and canonical definition from the live workflow with
  `stateDefinitionEvidence`; `null` means the state is gone, in which case a rebind needs the operator
  to name a target state or to drop the choice.
- **Resolution record.** `chain_provider_interventions.kind = 'override_review'`, which the table
  reserves, written when the operator acts, not at park time (the startup sweep drops every
  `scheduled` row, and the park itself is already durable in the Run). The row has no digest columns;
  stage 2 should add nullable `old_digest` / `new_digest` (or an evidence column) rather than overload
  `last_error`.
- **Rebinding is a write the immutable plan cannot take.** The plan is immutable once consumed
  (ADR-2026-10-09-0743, ADR-2026-10-13-0659) and the detector reads `stateDefinitions` from it, so a
  rebind that only inserts an intervention would park again at the next entry to the state. Stage 2
  must either update the plan entry's `definitionDigest`/`definition` (and `provider` when changed),
  or have the detector consult resolved `override_review` rows keyed by (chain, state, new digest)
  before it parks. Either is compatible with the fields stored here; the plan entry update is the
  simpler one and keeps a single source of truth, at the cost of making `state_providers_json`
  mutable by one audited action.
- **Resuming safely.** Launch through the recovery primitive: a Continuation Run of the parked Run,
  scheduled through State Advance, with the same guards (no live Reservation, no held claim, newest
  Run). The parked Run keeps its `blocked` state and reason, so the timeline reads park, review,
  resume as separate rows. Withdraw `sym:blocked` and `sym:human-needed` once the resume's own claim
  lands, as recovery does.
- **Timeline.** `pages.ts` filters `recoveredRunIds` to `recovery` and labels every other kind with
  the operator-recovery source text; an `override_review` row needs its own wording.

## Consequences

- A per-state choice made before this change keeps its previous, id-only behaviour until the operator
  chooses again; the "silently stops matching" consequence of ADR-2026-10-13-0659 stands for those
  legacy rows only, and is replaced by the park above for every choice made from now on.
- A rename of a state that an override names parks the chain only when the walk is still heading for
  the old id (an in-flight advance, a resume). A walk that the edit already routes elsewhere never
  enters the old id and keeps running on the chain-wide choice.
- Pointing a state at a different prompt file, changing its provider, kind, transitions or
  `complete_when` parks a chain with a choice for it; editing the prompt file's text does not.
- A park at State Advance leaves a child Run that never ran. Its parent's Attempt evidence and
  captured graph are untouched.
- The parked Issue carries `sym:blocked`, so it is not re-claimed by dispatch. An operator who clears
  the labels by hand re-enters the normal paths: a fresh claim finds no live plan (consumed) and uses
  Project routing.
