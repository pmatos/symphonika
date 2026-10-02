# A structured final-message Workflow Claim replaces the BLOCKED.md sentinel in Symphonika's own workflows

Status: Accepted — supersedes the file-based channel of ADR-2026-09-23-1400

## Context

ADR-2026-09-23-1400 added `claim_status`, backed by a claim file the agent wrote to a path
Symphonika named (`{{claim.path}}`), as an opt-in reinforcement of the `BLOCKED.md` sentinel and
deliberately migrated nothing. It reasoned that the remaining weakness of `BLOCKED.md` — an agent
may forget to write it — is a compliance problem a second write location cannot fix, so it kept the
sentinel as the primary signal and asked #813 to decide whether to adopt the reinforcement.

That framing treated both channels as optional: a forgotten sentinel and a forgotten claim file
both leave the run reading as "not blocked", and `provider_success` is true regardless of what the
agent concluded, because a failing Bash call only ends that subshell, not the provider session.

Claude (`--json-schema`) and Codex (`turn/start.outputSchema`) can instead *enforce* a response
schema on the final message (ADR 0068, already used for Routine Firings). With enforcement the
agent cannot finish its turn without a valid claim, so the signal is no longer something the agent
may forget. Absence of a valid claim becomes detectable, and a workflow can treat it as failure
rather than as success.

## Decision

**The Workflow Claim is the agent's final message, not a file.** A state that names `claim_status`:

- receives a shared "Final claim" instruction section (`WORKFLOW_CLAIM_INSTRUCTIONS`,
  `src/workflow/claim.ts`) added to its rendered prompt (through the `extraInstructions` channel, so it precedes the workflow body), so the wording cannot drift between the
  seven prompt files;
- has `WORKFLOW_CLAIM_JSON_SCHEMA` passed to the provider as `outputSchema` for that attempt only;
  states that do not name `claim_status` keep a free-form final message and no schema;
- is evaluated from the last `turn_completed` event: its `structuredOutput` when the provider
  produced one, otherwise the final message text (`parseWorkflowClaim`, mirroring
  `parseRoutineOutcomeClaim`). The events are the in-memory `runtime.events` of the attempt;
  `applyWorkflowOutcome` has one caller, so no persisted-log path is needed.

**Oh My Pi relies on the prompt alone.** OMP's RPC mode exposes no response-schema lever (its
`outputSchema`/`outputSchemaMode` exist on the SDK's `createAgentSession` and on the internal
`task` tool, not on RPC or the CLI), so an OMP state's claim is "the final message happens to be
bare JSON". The parser already prefers `structuredOutput` when present, so wiring a schema into the
OMP adapter later needs no change here. Until then, an OMP state that omits the claim fails closed.

**Workflows gate on a positive claim.** Each migrated state orders `claim_status: blocked` first
(kept explicit for the audit trail in the transition reason), then advances only on
`claim_status: success` together with `provider_success: true`, with a fallback to the failure or
blocked state. A missing or malformed claim therefore never advances.

**The claim file channel is removed.** `{{claim.path}}`, `workflowClaimFilePath` and
`readWorkflowClaimFile` are deleted; `src/workflow/evidence-paths.ts` keeps serving
`persistRunEvidence`. This ADR's predecessor's argument for a file — provider independence —
no longer outweighs the reliability of an enforced schema on the two providers that have one.

**`BLOCKED.md` stays supported in `src/`.** `artifact_exists` and the pre-attempt sentinel clearing
(ADR-2026-09-10-1630, ADR-2026-09-10-2018) are unchanged, because other managed projects' workflows
use them. Only this repository's `workflow.yml`, `refactor-workflow.yml`, the seven prompts that
instructed writing it, and the skill's refactor example moved to `claim_status`.

## Consequences

- A forgotten blocked signal can no longer silently advance a run on Claude or Codex; on OMP a
  missing claim fails the state instead of advancing it.
- A schema-enforced `success` is still the agent's own verdict. `provider_success` and
  `branch_*` predicates remain required alongside it where a state's success is observable.
- Follow-up: other managed projects' FSMs still gate on `BLOCKED.md` and can migrate on their own
  schedule; surfacing the claim `summary` in the `sym:human-needed` issue comment is possible now
  that it is parsed, but is not done here.
- Follow-up: pass the schema through the OMP adapter once OMP's RPC mode accepts one.
