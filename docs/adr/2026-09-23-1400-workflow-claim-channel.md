# A file-based Workflow Claim channel, reinforcing (not replacing) BLOCKED.md

Status: Accepted

## Context

#759 (PR #775) gave Routine Firings a second, file-based claim channel: the routine prompt
instructs the agent to write its Routine Outcome Claim (`{status, action, url, title, summary}`) to
a fixed path outside the workspace as a deliberate tool call, in addition to the existing
final-message claim, with the file winning when both are present and valid — a file write cannot be
truncated or wrapped in trailing commentary the way a final message can, and it needs no
provider-specific schema/response-format lever, so it works identically across Codex, Claude, and
Oh My Pi.

#776 asked whether the same pattern generalizes to autonomous issue-driven Workflow (raw-FSM) runs,
specifically citing `BLOCKED.md` — the sentinel some workflow states already use to signal a
blocked/failed terminal (ADR-2026-09-10-1630) — as a sentinel convention an agent "may or may not
remember to write."

Investigating that claim against the current implementation surfaces an architectural difference
between the two subsystems that the issue's framing did not fully anticipate:

- **A Routine Firing has no predicate graph.** It is a single free-form agent turn with no FSM
  states or transitions. Symphonika has no independent way to know what the agent did beyond
  diffing GitHub state before/after the firing, so the Routine Outcome Claim is the *primary* signal
  for the firing's semantic outcome (`action`, `title`, `url`), reconciled against — not replaced
  by — the GitHub diff (ADR 0068).
- **A Workflow run's terminal state is already predicate-graph-driven, not self-report-driven.**
  `signalsFromTerminal` (`src/lifecycle/outcome-projection.ts`) projects only `provider_success`,
  `branch_ahead_of_base`, and `branch_advanced_since_attempt_start` from the classified terminal —
  all three are Symphonika's own observations (process exit, git state), never anything the agent
  claims about itself. `artifact_exists` (including `BLOCKED.md`) is evaluated the same way: file
  existence, not parsed content. `wait`/`merge_pr` states project PR signals from GitHub's own API.
  Nothing in the current design asks the agent to self-report its own terminal verdict and trusts
  it directly.
- **`BLOCKED.md` already has the reliability property #759 introduced for Routines.** It is a
  deliberate, out-of-band file write, checked post-hoc by `artifact_exists`, not a process exit code
  or trailing prose — ADR-2026-09-10-1630 adopted exactly that shape, before #759 generalized it for
  Routines. The remaining risk it names ("an agent may forget to write it") is a prompting/compliance
  concern, not a channel-reliability one a second write location would fix on its own: an agent that
  forgets a sentinel file would equally forget to include a claim in a second channel.

Given that, a wholesale replacement of `BLOCKED.md`, or introducing a full
`RoutineOutcomeClaim`-shaped self-reported outcome record (`action`, `url`, `title`) for Workflow
runs, would reintroduce exactly the kind of unverified self-report the predicate-graph design was
built to avoid trusting for terminal-state determination — Workflow states already have a more
reliable source of truth (observed git/PR/artifact state) than an agent's own claim about itself.

## Decision

Add a narrower, opt-in reinforcement instead: a `claim_status` predicate, backed by a Workflow
Claim file `{status, summary}` (`src/workflow/claim.ts`), where `status` is one of `success`,
`blocked`, `failure` — the same three-value vocabulary `terminal:` already uses. An agent state
opts in by naming `claim_status` in its `complete_when`/`transitions`, exactly the same declarative
mechanism `artifact_exists` already uses; a state that never names it pays no cost and sees no
behavior change.

- **The claim file lives outside the Run Workspace**, in the same per-run evidence directory
  `persistRunEvidence` already writes `prompt.md`/`prompt-metadata.json` to, named
  `claim.json`/`claim.attempt-N.json` using that same per-attempt naming convention
  (`src/workflow/evidence-paths.ts`, extracted from `autonomous-prompt.ts` so `claim.ts` and
  `autonomous-prompt.ts` can both depend on it without a cycle). This is a deliberate improvement
  over `BLOCKED.md`'s workspace-relative path: no git-tracked-file provenance check
  (ADR-2026-09-10-2018) is needed, no collision with a managed repository's own files is possible,
  and no pre-attempt clearing step is needed — the file is already attempt-scoped by its filename,
  so a retry naturally never reads a prior attempt's stale claim.
- **The path is exposed as a new `{{claim.path}}` template variable**, available unconditionally to
  every Workflow prompt (like `{{workspace.path}}` or `{{run.id}}`) rather than only when the
  current state declares `claim_status` — computing that path needs only `stateRoot` and `run.id`/
  `run.attempt`, both already known before prompt rendering, so no state-conditional templating
  machinery was added for this.
- **Reading is bounded the same way the Routine Outcome Claim file is**: capped at 64KB, BOM-tolerant,
  schema-validated (`zod`, `.strict()`), read via an open file handle's `fstat`/`read` to avoid a
  stat-then-read TOCTOU window. `src/workflow/claim.ts` is deliberately self-contained rather than
  sharing `routines/outcome.ts`'s reader: that module is a tested, merged, reliability-critical path
  for a different subsystem with a materially larger payload (URL verification, GitHub
  reconciliation); this claim's two-field payload does not need it, and duplicating ~40 lines of
  bounded-read logic keeps this change's blast radius independent of Routines'.
- **A missing, oversized, or schema-invalid claim leaves `claim_status` absent**, the same way an
  absent artifact or PR signal already behaves — a transition naming it simply does not match. A
  state gating on it should still declare its own `provider_success`/`artifact_exists` fallback;
  `claim_status` is additive, not a required signal.
- **`BLOCKED.md` is unchanged.** It keeps working exactly as ADR-2026-09-10-1630 and
  ADR-2026-09-10-2018 left it. This ADR does not migrate `workflow.yml`, `refactor-swarm`, or any of
  the seven `prompts/*.md` files that reference `BLOCKED.md` today — adopting `claim_status` in an
  existing state is a per-workflow-author decision, tracked as follow-up work (#813) rather than
  forced by this change, the same incremental-adoption posture #759 took for the Routine Outcome
  Claim.

## Consequences

- Any raw-FSM Workflow state can now opt into a structured, schema-validated terminal-state claim
  without changing the FSM's existing predicate-graph architecture: `claim_status` composes with
  `provider_success`, `artifact_exists`, and PR-signal predicates exactly like any other predicate
  key (`src/workflow/predicates.ts`'s `workflowPredicateEvaluations` registry, extended with a third
  `claim_signal` evaluation kind alongside `agent_signal` and `pr_signal`).
- `close_issue`/`label_issue`/`comment` states, which launch no provider and so can never produce a
  claim, are rejected by `workflow validate`/`doctor`/reload if they name `claim_status`
  (`fsm-expansion.ts`'s `unreachablePredicateKeys`, extended the same way it already rejects a stray
  `agent_signal`/`pr_signal` predicate on those three action kinds).
- `docs/workflows.md` and `SPEC.md` §5.3 document `claim_status` and `{{claim.path}}`; `CONTEXT.md`
  adds a "Workflow Claim" term distinguishing it from "Routine Outcome Claim."
- **Not done here**: migrating any existing prompt or built-in template to use `claim_status`. The
  seven `prompts/*.md` files, `workflow.yml`, and `refactor-swarm` keep using `BLOCKED.md` alone
  until #813 adopts the new predicate somewhere concrete.
- **Not done here**: a full self-reported Workflow outcome record analogous to `RoutineOutcomeClaim`
  (`action`, `url`, `title`). The investigation above concluded that would duplicate information the
  predicate graph already derives more reliably from observed git/PR/artifact state; revisit only if
  a concrete gap emerges that `provider_success`/`branch_ahead_of_base`/`artifact_exists`/PR signals
  cannot express.
