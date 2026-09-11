# Explicit No-Action Claim Overrides Zero-Commits Classification Under expects_pr

Status: Accepted

Amends: ADR-2026-09-11-1407 (Routine-Kind-Aware Outcome Policy), which amends ADR 0068 rule 4.

## Context

ADR-2026-09-11-1407 gave `expects_pr: true` routines a contract: "produce a PR, or explicitly say
there was nothing to do." Its own Context section frames that second branch — an explicit
`action: "none"` Routine Outcome Claim — as a legitimate success path, not merely a fallback.

That branch was unreachable. `classifyRoutineOutcome` (`src/routines/dispatcher.ts`), on a `kind:
git` firing, calls `classifyFailure`'s `verifyWorkspaceSuccess`
(`src/lifecycle/classify-failure.ts`), which inspects commits ahead of base *before* anything reads
the provider's claim. Zero commits ahead was classified `{kind: "failed", reason:
"no_workspace_changes"}` unconditionally, for every `kind: git` firing regardless of `expects_pr`.
`reconcileRoutineOutcome` never got a `terminalState: "succeeded"` to reconcile the claim against —
its own final fallback for a `failed` terminal state always persists `status: "error"`
(`src/routines/outcome.ts` rule preceding the last return), no matter what the claim said. An agent
that correctly determined there was nothing to refactor, and said so via
`{action: "none", status: "no_action", ...}`, was indistinguishable from one that silently produced
no commits and no explanation. Filed as issue #757, deferred out of PR #754's autofix cycle because
it required breaking, not just threading a parameter through, an existing invariant (see below).

### The invariant `dispatcher.ts` relied on

`runRoutineFiring` derived the persisted `commitsAhead` retention bit for a succeeded firing as
`input.routine.kind === "git"` — i.e. it inferred "commits exist" from "this is a succeeded `kind:
git` firing" rather than reading a real bit, because `verifyWorkspaceSuccess` was the only path to a
`kind: git` success and it only ever returned `success` when commits were actually ahead. Making
zero commits reach `succeeded` without also fixing this shortcut would have made every zero-commit,
claim-honored firing get persisted with `commitsAhead: true` — the opposite of reality, and a false
retention-protection signal (ADR 0068's retention column exists specifically to protect real commits
from age-based collection; a workspace with none doesn't need it, and misreporting it here doesn't
lose data but does make the persisted signal meaningless for this firing).

## Decision

- `ClassifiedTerminal` (`src/lifecycle/classify-failure.ts`) gains a `commitsAhead?: boolean` field,
  set on both of `verifyWorkspaceSuccess`'s `success` returns: `true` when commits are ahead of
  base, `false` on the newly-added zero-commits-but-allowed path below. This is the real bit
  `dispatcher.ts` no longer has to infer.
- `ClassifyFailureInput.successWorkspace` gains `allowZeroCommits?: boolean`. When true and the
  commits-ahead inspection finds none, `verifyWorkspaceSuccess` now returns `{kind: "success",
  commitsAhead: false, reason: ""}` instead of `{kind: "failed", reason: "no_workspace_changes"}`.
  Omitted or `false` is the prior, unconditional-failure behavior — every existing caller is
  unaffected by default.
- `src/lifecycle/run-controller.ts`'s two `classifyFailure` call sites (the issue-driven Run
  lifecycle, which has no `expects_pr` concept) never set `allowZeroCommits`, so their zero-commits
  behavior is byte-for-byte unchanged. This module is shared infrastructure; only the Routine Firing
  caller opts in.
- `classifyRoutineOutcome` (`src/routines/dispatcher.ts`) gains a required `allowZeroCommits: boolean`
  input, forwarded straight to `successWorkspace`. Its caller, `runRoutineFiring`, now parses the
  Routine Outcome Claim (`parseRoutineOutcomeClaim`) *before* calling `classifyRoutineOutcome` —
  moved earlier than the pre-existing claim parse this ADR's predecessor left further down the
  function — and computes `allowZeroCommits` as `routine.expectsPr && claim !== null && claim.action
  === "none" && claim.status !== "error"`. Only this exact shape — a non-error explicit no-action
  claim, on a routine that opted into `expects_pr` — unlocks the zero-commits success path. No claim,
  a different action, or an `error`-status claim all keep the prior unconditional failure, matching
  the "explicitly say" language in ADR-2026-09-11-1407's own contract: silence is not an explicit
  claim.
- `RoutineTerminalOutcome`'s `succeeded` variant gains a required `commitsAhead: boolean` field,
  populated from `classified.commitsAhead` (git path) or `false` (a `kind: report` success, which
  never carries commits). `runRoutineFiring`'s own `commitsAhead` computation — previously `outcome.kind
  === "succeeded" ? input.routine.kind === "git" : await inspect(...)` — now reads `outcome.commitsAhead`
  directly instead of inferring it from `outcome.kind`/`routine.kind`, closing the gap described above.

Once a zero-commits, claim-honored firing reaches `reconcileRoutineOutcome` with `terminalState:
"succeeded"` and `commitsAhead: false`, rule 4 (ADR 0068, widened by ADR-2026-09-11-1407) never
fires — its own precondition requires `commitsAhead === true`, which is false here by construction.
The claim-preservation branch that follows it returns the claim as-is: `action: "none", status:
"no_action"`, `verified` true only when the before/after GitHub comparison completed, exactly ADR
0068's pre-existing "claimed no-action" rule. No change was needed in `reconcileRoutineOutcome`
itself — this ADR only changes what reaches it.

## Consequences

- An `expects_pr: true` `kind: git` routine that legitimately finds no work and reports
  `{action: "none", status: "no_action" | "success", ...}` now persists `state: "succeeded"`,
  `commitsAhead: false`, and the claimed `no_action` outcome — instead of `state: "failed"`,
  `terminal_reason: "no_workspace_changes"`, `status: "error"`.
- `expects_pr: false` (the default) and every `kind: report` routine are unaffected: zero commits
  ahead of base on a `kind: git` firing without this exact claim shape still fails deterministically
  with `no_workspace_changes`, exactly as before this ADR.
- The issue-driven Run lifecycle (`src/lifecycle/run-controller.ts`, SPEC.md §12.1) is unaffected:
  it has no `expects_pr` concept, never sets `allowZeroCommits`, and keeps its unconditional
  `no_workspace_changes` failure on zero commits.
- The persisted `commitsAhead` retention bit is now read from a real signal end to end for every
  `kind: git` Routine Firing outcome, not inferred from `outcome.kind`/`routine.kind` — removing the
  latent false-positive this ADR's Context section describes.
