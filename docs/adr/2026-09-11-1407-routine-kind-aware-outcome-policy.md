# Routine-Kind-Aware Outcome Policy

Status: Accepted

Amends: ADR 0068 (Structured Routine Outcomes), rule 4.

## Context

ADR 0068's `reconcileRoutineOutcome` rule 4 treats any successful `kind: git` firing with commits
ahead of base, and no confirmed external action (no claim, a `none` claim, or an unconfirmed
`pr`/`issue_opened`/`issue_closed` claim), as `status: "success"` with the synthetic title `"Commit
retained in the Routine Firing workspace"`. That is the right call for workspace retention: the
independent `commitsAhead` column, not this canonical outcome, already protects the workspace from
age-based garbage collection (ADR 0068's own Consequences), so nothing here risks losing the
commit.

It is the wrong call as an operator-facing status for a routine whose contract is "produce a PR, or
explicitly say there was nothing to do." For a PR-producing routine (for example an audit routine
that delegates to a code-authoring skill), a bare commit with no verified PR and no explicit
"nothing to refactor" claim means the run didn't finish its job — a human needs to publish, discard,
or investigate it. Reporting that as a quiet `success` hides exactly the runs that most need
attention. Other routine kinds legitimately have no PR in a normal run (for example a routine that
only resolves or routes existing PRs rather than opening new ones) and must not be penalized by the
same rule.

Issue #748 / PR #751 (amending this same rule 4, ADR-2026-09-11-1001) already reduced how often the
fallback fires for reasons that are not real failures, by verifying a claimed PR/issue URL directly
against the Project's repository when the branch-scoped diff can't confirm it. That fix had to land
first: without it, this ADR's policy would have started flagging genuinely-successful off-branch
firings as `error` due to the observation gap #748 closed, rather than only the firings that
actually lack a verified PR.

### Known gap, deliberately out of scope

`RoutineOutcomeAction` (`pr | issue_opened | issue_closed | commit | none`) has no `pr_merged` or
`pr_closed`, and `diffRoutineGithubSnapshots` only detects a *newly opened* pull request, not an
existing one being merged or closed. A routine whose job is to resolve or route already-open PRs
(rather than open new ones) therefore has no vocabulary to reconcile a real "resolved existing PRs"
outcome to anything but `none` today. Because of that gap, this ADR does not attempt to give such a
routine kind a `false` "must not produce a PR" enforcement — the flag introduced here is opt-in
(`true` means "must produce a PR or explicitly claim nothing to do"), and its default (`false`)
leaves every other routine's behavior unchanged. Building out the missing action vocabulary, if a
routine ever needs `expects_pr: false` to mean something enforced rather than merely "not opted in,"
is left for a future ADR.

## Decision

Add an optional per-routine declaration flag, `expects_pr: boolean`, alongside the existing
`kind: RoutineKind` field:

- Front matter: `expects_pr: true`, valid only on a `kind: git` routine. `expects_pr: true` on a
  `kind: report` routine is a deterministic declaration-load error (`declaration-loader.ts`) — a
  `kind: report` firing never reaches rule 4's precondition (`terminalState === "succeeded" &&
  commitsAhead`, which for a `kind: report` routine's classification is never true), so the flag
  could never take effect there, matching the loader's existing pattern of rejecting other
  meaningless field combinations. Omitted, or explicit `false`, is the current, pre-existing
  behavior. Non-boolean values are rejected the same way `allow_overlap` already is.
- Persistence: `expects_pr` is stored as its own `routines.expects_pr` column
  (`integer not null default 0`), mirroring `allow_overlap` end to end — `CREATE TABLE`, the
  migration `additions` list, every routines-table insert/update, and `RoutineStatus.expectsPr`
  read back out via `mapRoutineRow`. A routine's runtime status is always read from this
  database-backed snapshot (`RoutineStatus`), never from a live in-memory declaration object, so the
  flag has to round-trip through the same store as every other declaration field to reach the
  dispatcher's reconciliation call.
- Reconciliation: `reconcileRoutineOutcome` (`src/routines/outcome.ts`) gains a required
  `expectsPr: boolean` input. When `expectsPr: true`, rule 4's fallback condition
  (`terminalState === "succeeded" && commitsAhead && (...)`) is widened: alongside the pre-existing
  disjuncts (claim absent, `"none"`, or an unconfirmed external-action claim), an explicit
  `action: "commit"` claim now also satisfies it. An agent that self-reports "I committed but didn't
  publish" is exactly the unpublished-work case this policy exists to surface, so it cannot be
  exempted from rule 4 just because it was reported rather than inferred. In every case that
  satisfies the widened condition, `expectsPr: true` persists `status: "error"` with a summary
  explaining that a commit exists with no verified external action — replacing `status: "success"`
  for the pre-existing disjuncts, and replacing whatever status the claim itself reported for an
  explicit commit claim. `action: "commit"`, `source: "git"`, `verified: true`, and the title
  (`"Commit retained in the Routine Firing workspace"`) are unchanged for every case this policy
  reclassifies — the commit itself is still a verified fact. When `expectsPr: false`, rule 4's
  condition and the claim-preservation branch that follows it are both unchanged from ADR 0068: an
  explicit commit claim keeps its own reported `status`, `source`, and `title`. Retention is
  unaffected either way: it already keys off the independent `commitsAhead` column, not outcome
  `status`.
- Wiring: both dispatcher call sites that reach rule 4 on the success/failure path
  (`runRoutineFiring`'s two `reconcileRoutineOutcome` calls) pass `input.routine.expectsPr`. The
  operator-cancel path (`cancelRunInStore`, `src/http/app.ts`) passes `expectsPr: false`
  unconditionally: its `terminalState` is always `"cancelled"`, which can never satisfy rule 4's own
  `terminalState === "succeeded"` precondition, so the flag is inert there regardless of the
  routine's declared policy.

This repository's own `routines/refactor-audit.md` is `kind: report` (it only files GitHub issues,
never opens a PR), so it cannot and does not carry `expects_pr: true` — setting it there would be
either a no-op or, after this change, a load error. The PR-producing audit routine the originating
issue describes (a `kind: git` routine delegating to a code-authoring skill) is an operator-owned
live declaration outside this repository; enabling the flag there is a follow-up for whoever owns
that declaration.

## Consequences

- A `kind: git` routine that opts in with `expects_pr: true` now reports `error`, not `success`, for
  a firing that leaves a commit with no verified PR and no explicit "nothing to do" claim — visible
  to operators through the same one-line outcome formatter (`formatRoutineOutcomeLine`) and firing
  detail views that already render `status`. This applies whether the agent's own claim under-reports
  the firing (absent, `"none"`, or an unconfirmed external-action claim) or explicitly reports the
  commit itself (`action: "commit"`) — a self-reported "I committed but didn't publish" is not
  exempt, since it is exactly the unpublished-work case this policy exists to catch.
- Every routine kind's default behavior is unchanged: `expects_pr` defaults to `false`, and rule 4's
  fallback still records `success` exactly as before ADR 0068's own text describes, unless a routine
  explicitly opts in.
- The vocabulary gap around detecting a resolved/merged/closed existing PR (see "Known gap" above)
  remains; this ADR intentionally does not attempt to close it, since the opt-in `expects_pr: true`
  policy has no need for it and a `false`-as-enforcement policy would have nothing meaningful to
  verify against yet.
