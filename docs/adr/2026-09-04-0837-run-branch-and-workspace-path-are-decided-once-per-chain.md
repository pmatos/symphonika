# A Run chain's branch/workspace path is decided once, not re-derived per attempt

Status: Accepted

## Context

`planWorkspacePaths` derives `branchName`/`workspacePath` from `(project.name, issue.number,
issue.title)`. `prepareIssueWorkspace` (`src/workspace.ts`) calls it fresh on every attempt.
`run-controller.ts`'s dispatch path called `prepareIssueWorkspace` with `issue.title` taken from
whatever `IssueSnapshot` the caller passed in for *that* attempt — the issue's live title at
dispatch time, continuation-fire time, or state-advance time, re-fetched via `refreshIssue`/
`getIssue` on every continuation and FSM state advance.

If a GitHub issue's title is edited after a Run's branch/workspace already exist but before a later
continuation or state-advance re-enters an `agent` state, the recomputed branch name
(`sym/<project>/<issue>-<newslug>`) no longer matches the branch the Run chain has actually been
working on (`sym/<project>/<issue>-<oldslug>`). `ensureIssueBranch`'s `syncBranchRef(...,
forceUpdate: false)` only reuses an existing *local* ref; a branch name that has never existed
locally is silently created fresh from `origin/<base_branch>`, and the fresh-branch workspace path
does not exist either, so a brand-new worktree is created off the base branch. The continuation then
runs against a disconnected branch/workspace with none of the prior work — no error, no warning.

This is the general form of the bug PR #697 fixed narrowly for `adopt-pr`
(`docs/adr/2026-09-03-1158-adopt-pr-as-an-audited-exception-to-adr-0090.md`): that ADR's
"Known limitation, not fixed here" note names this exact gap and points at this issue (#699).

Two purely-display call sites (`src/status.ts`'s `fillMissingWorkspacePlan`, `src/cli.ts`'s
`fillMissingRunDisplayPaths`) already guard `planWorkspacePaths` behind `branchName.length === 0 &&
workspacePath.length === 0` — recompute only as a fallback when a Run row genuinely never recorded a
plan (e.g. a legacy row). The bug was that the one call site that actually creates git state — the
dispatch path in `run-controller.ts` — had no equivalent guard, so it recomputed unconditionally
every time.

## Decision

A Run chain's branch/workspace path is decided once, at whichever attempt first establishes it, and
every later attempt in the same chain reuses it verbatim rather than re-deriving it from a
(possibly-since-edited) issue title:

- `planWorkspacePaths` (`src/workspace-paths.ts`) and `prepareIssueWorkspace`
  (`src/workspace.ts`) accept an optional `existing: { branchName, workspacePath }`. When present it
  wins outright — `issue.title` is not consulted at all for that call.
- `run-controller.ts`'s dispatch path reads the Run row's own already-persisted `branchName`/
  `workspacePath` (`runStore.getRun(runId)`) before calling `prepareIssueWorkspace`, and passes them
  as `existing` whenever both are already non-empty. The very first attempt in a chain still has an
  empty Run row at this point (nothing has been decided yet), so it still derives the plan fresh from
  the issue's title at that moment — exactly the "decided once, at first attempt" semantics.
- `RunStore.createContinuationRun` inherits `branch_name`/`workspace_path` from the parent row (the
  same transaction that already inherits `current_state_id`), so a continuation's row carries the
  decision forward before dispatch even calls `prepareIssueWorkspace`. `createWaitingRun` (already
  carrying `workspace_path` for `artifact_exists` evaluation, ADR 0087) now also carries
  `branch_name`. `createAdoptedRun` now takes `branchName` as a required field alongside the existing
  required `workspacePath`, since `adopt-pr` always has the PR's own real branch by the time it calls
  this — closing the exact gap ADR-2026-09-03-1158 flagged as unfixed.

Every `runs` row that continues an existing chain therefore has its branch/workspace decided at row
creation, before any workspace preparation runs — the same "persist the deterministic plan when
claimed, before preparation" shape Routine Firings already use (`claimRoutineFiring`,
`planRoutineWorkspacePaths`, `SPEC.md` §4.13), just extended to Runs.

Other `planWorkspacePaths` callers are unaffected by design, not by oversight:

- `src/status.ts` / `src/cli.ts`: already gated the same way (recompute only when the row has no
  plan at all); unchanged.
- `src/lifecycle/file-overlap-guard.ts`: uses the derived branch name only as a best-effort GitHub PR
  lookup key when no tracked PR is already known — a stale guess here costs a missed overlap
  detection, not a corrupted workspace, so a live recompute is the right behavior.
- `src/workspace.ts`'s `prepareAdoptedPrWorkspace`: unaffected — adopt-pr derives its plan from the
  PR's own existing branch slug, never from a live title, per ADR-2026-09-03-1158.

## Consequences

- A Run row's `branch_name`/`workspace_path` are now the durable source of truth for that chain once
  set; an issue title edit after the fact changes what `symphonika` reports as the issue's title, but
  never what branch/workspace a live or future continuation writes to.
- A legacy waiting/adopted row written before this change (branch_name still null) falls through to a
  fresh recompute on its first post-upgrade continuation — the pre-existing behavior for that row, not
  a regression introduced here.
- `WorkspacePathInputs`/`PrepareIssueWorkspaceInput` gain an `existing` field call sites can ignore;
  no existing caller (`status.ts`, `cli.ts`, `file-overlap-guard.ts`) needed to change.
