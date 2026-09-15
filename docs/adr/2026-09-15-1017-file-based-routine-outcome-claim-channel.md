# File-Based Routine Outcome Claim Channel

Status: Accepted

## Context

ADR 0068 makes the provider's final normalized `turn_completed` event the only Routine Outcome
Claim source. That event carries a claim on all three providers: Claude and Codex additionally
receive a JSON Schema (`--json-schema`, `turn/start.outputSchema`) as reinforcement, but Oh My Pi's
native RPC mode has no schema or response-format field at all, so its claim stays exactly as fragile
as "the final assistant message happens to be bare JSON" — a convention, not a contract, with no
upstream lever to reinforce it (#759, split from #750, which resolved the Codex `outputSchema` side
of the same investigation).

Symphonika already has run-evidence infrastructure outside the agent's workspace:
`routineEvidencePaths()` (`src/routines/evidence.ts`) derives a per-firing directory under
`<stateRoot>/logs/routines/<firingId>/`, guarded against ever resolving inside the workspace, that
already holds the prompt, prompt metadata, and provider logs. A tool call that writes a file to a
path Symphonika names and then reads back post-hoc is provider-agnostic — it needs no schema support
from any provider, so it closes the OMP gap without depending on an upstream flag that may never
exist for that provider.

## Decision

The routine prompt's Routine Outcome section (`src/routines/prompt-renderer.ts`) instructs the agent
to do two things as it finishes: write the claim JSON object to an absolute path inside the firing's
evidence directory (`outcome.json`, named by `RoutineEvidencePaths.outcomeClaimPath`), then also send
the same object as its final message, unchanged from ADR 0068's existing instruction. The path is
rendered into the prompt per firing, the same way `{{workspace.path}}` and other per-firing values
are; it is not a template tag a routine author can reference or override.

After the provider process exits, Symphonika reads the file (`readRoutineOutcomeClaimFile` in
`src/routines/dispatcher.ts`) before parsing the message-based claim. The file is agent-authored
text like the message claim, so it gets the same treatment:

- A read that fails, finds nothing, or exceeds a fixed size cap (64 KiB — well above any real claim)
  is treated as absent, mirroring ADR 0068's existing "missing, malformed, or schema-invalid claims
  are treated as absent" rule. The cap exists because this is unbounded agent-authored text, not a
  bounded structured-output response — nothing upstream limits how much an agent could write here.
- Its content is validated against the same `routineOutcomeClaimSchema` Zod schema the message claim
  uses (`parseRoutineOutcomeClaimText` in `src/routines/outcome.ts`, factored out of
  `parseRoutineOutcomeClaim` so both channels share one parse-and-validate path).
- It receives the same redaction pass (`redactRoutineOutcomeClaim`) as the message claim, applied
  after the two channels are resolved into one claim, so secrets are scrubbed regardless of which
  channel produced the winning claim.
- It is read in both the successful-completion path and the failure/timeout/cancellation path, since
  a provider can write the file as its last action and then crash, time out, or get cancelled before
  ever reaching a `turn_completed` event.

**Precedence**: when both channels produce a schema-valid claim and they disagree, the file wins.
Writing the file is a single, self-contained tool call — it can't be truncated, wrapped in
surrounding commentary, or otherwise mangled the way trailing prose in a final message can be before
Symphonika ever parses it. (The prompt asks for the file write before the final message, not after,
so this isn't a recency argument — an agent that revises its answer between the two would have the
stale file claim win. The reliability argument stands on its own regardless.) When the file is
absent or invalid, the message-based claim is used exactly as ADR 0068 already specifies — the file
is additive, not a replacement, so a provider or prompt that never adopts the file-write instruction
degrades to today's behavior with no code change on Symphonika's side. A disagreement between the
two channels is logged at `warn` (with both claims, after redaction upstream in the log call) so an
operator can see when a provider's final message diverges from what it actually wrote to disk.

`reconcileRoutineOutcome` and the `source`/`verified` fields are unchanged: `source` still names the
provider, not the channel, since both channels originate from the same provider's own attempt at
that firing — channel provenance is a debugging detail, not part of the reconciled evidence. The
existing precedence rules 1–6 in ADR 0068 pull one canonical `RoutineOutcomeClaim` from
`resolveRoutineOutcomeClaim` and reconcile it against observed GitHub/workspace state exactly as
before, regardless of which channel produced it.

## Consequences

- The file channel depends on SPEC.md §11.3's full-permission execution contract (Codex
  `sandbox_mode=danger-full-access`, Claude `--dangerously-skip-permissions`, OMP `--auto-approve`):
  a provider confined to writing inside its own workspace would be unable to write the file and would
  silently degrade to the message-based fallback. All three default provider commands run
  full-permission today, so this holds; a future provider or configuration that sandboxes writes to
  the workspace would need its own accommodation.
- Oh My Pi (and any future provider without a schema lever) gets an equally reliable Routine Outcome
  Claim path to Claude and Codex, without Symphonika depending on an upstream flag for it.
- A provider that ignores the new instruction, or a routine prompt template predating this change
  (the instruction is generated, not user-editable, so this only matters for evidence written by an
  older Symphonika build being replayed), sees no behavior change: an absent file falls back to the
  message-based claim exactly as before.
- The per-firing evidence directory gains one more small file (`outcome.json`), outside the
  workspace, following the same retention lifecycle as the rest of that directory's evidence.
- This does not extend to autonomous issue-driven Workflow runs (`src/workflow/`, `persistRunEvidence`
  in `src/workflow/autonomous-prompt.ts`) or their own sentinel-file conventions — those are a
  separate contract with their own terminal-state signaling and are out of scope here.
