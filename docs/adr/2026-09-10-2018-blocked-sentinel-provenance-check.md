# A git-tracked-file provenance check before clearBlockedSentinel deletes BLOCKED.md

Status: Accepted

## Context

ADR-2026-09-10-1630 introduced `BLOCKED.md` as an orchestration sentinel: a raw-FSM agent prompt
writes it (uncommitted) to signal "blocked" when it cannot rely on a non-zero exit code, and
`clearBlockedSentinel` (`src/lifecycle/blocked-sentinel.ts`) removes it from the Workspace
immediately before each new attempt so a stale sentinel from an earlier blocked attempt cannot
misroute a later, genuinely successful one. PR #736 scoped the clear to only run for a state that
actually declares a `BLOCKED.md` `artifact_exists` transition, closing the "runs for every workflow"
gap.

That fix did not address a narrower but still real gap (issue #739, escalated from #736's review): a
repository that happens to track its own root `BLOCKED.md` — unrelated to symphonika, just a file
with that name — while also using one of the gated states would have that file silently deleted by
`clearBlockedSentinel` before the attempt, with the provider then able to commit the deletion of a
real, tracked source file. Nothing at that call site proved the file at that path was the
orchestration's own uncommitted sentinel rather than the repository's own tracked content.

Two options were on the table, per the issue text:

1. Move orchestration sentinel storage out of the agent Workspace entirely.
2. Prove ownership (provenance) of the file before deleting it.

## Decision

Option 2. `clearBlockedSentinel` now checks whether `BLOCKED.md` is tracked by git — `git ls-files
--error-unmatch -- BLOCKED.md` run against the Workspace — before deleting it. Tracked means it is
part of the managed repository's own history (present in the index), so it is left in place
untouched. Untracked (the ordinary case: an agent wrote it this attempt, or a prior attempt's stale
sentinel was never committed) still gets removed exactly as before.

**Rejected: moving sentinel storage out of the Workspace.** `PLAN.md` already establishes the
pattern `BLOCKED.md` follows — an orchestration-meaningful file living inside the managed repository's
own working tree — and that location was itself a deliberate, already-shipped decision (ADR 0040).
Reopening it for `BLOCKED.md` alone would be a cross-cutting redesign affecting both artifacts for a
gap only `BLOCKED.md` actually has, which is disproportionate to the problem.

**Rejected: comparing against `origin/<base_branch>`'s tree instead of the index.** The working tree
is what `clearBlockedSentinel` is about to mutate, and the index is what the working tree is checked
out against; checking the base branch ref instead would say a file is "safe to delete" when it was
newly tracked on top of base (e.g. committed by a very first attempt before a later attempt runs),
which is exactly a case this check exists to protect.

## Consequences

- A repository that tracks its own root `BLOCKED.md` no longer has it silently deleted (and
  potentially have that deletion committed) by an attempt using a gated state.
- **Known tradeoff, not fixed here**: this only protects the file from deletion. It does not change
  what the `artifact_exists: BLOCKED.md` predicate itself does — that predicate only checks
  existence, not provenance. A repository that both tracks its own `BLOCKED.md` and uses a gated
  state will now have every attempt route to that state's blocked transition, because the file
  always exists and the predicate cannot distinguish the orchestration's own signal from the
  repository's unrelated tracked content. This is a behavior change from before (silent, incorrect
  success routing under a corrupted repo state) to a loud, fail-closed one (every attempt reports
  blocked) — judged the safer direction, but still incorrect for that specific repository shape.
  Making the predicate provenance-aware too is out of scope for this ADR; revisit only if a real
  repository hits it.
- **Known limitation**: if the `git ls-files` check itself fails (git missing, not a repository,
  command timeout), the failure is indistinguishable from "untracked" and falls back to the prior
  behavior (delete). This preserves today's failure mode for every case this ADR doesn't newly cover,
  rather than introducing a new one; it is not a improvement, just a non-regression.
- An agent that accidentally `git add`s its own `BLOCKED.md` sentinel mid-attempt has, from this
  point on, turned it into a tracked file: the next attempt's clear will also leave it in place. This
  is the same fail-closed direction as the repository-owned-file case above, not a new gap.
- Downstream projects that copied the `vow_plan_tdd_pr` raw-FSM shape (vow-lang/vow, s11, modgud,
  health-connectors, pianosight, finnie) are unaffected by this change until they separately pull in
  symphonika's own `src/lifecycle/blocked-sentinel.ts`, mirroring the rollout note already on
  ADR-2026-09-10-1630.
