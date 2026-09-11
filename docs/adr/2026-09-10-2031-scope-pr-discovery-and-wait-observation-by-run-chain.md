# Scope PR discovery suppression and wait observation by Run Chain, not branch name

Status: Accepted

## Context

`planWorkspacePaths` derives `branchName` deterministically from `(project.name, issue.number,
issue.title)` (ADR-2026-09-04-0837). Redispatching an issue whose title has not changed therefore
produces the exact same branch name as an earlier, wholly unrelated top-level dispatch chain for
that same issue — for example a chain that already merged (or had closed) its own pull request
days or weeks earlier.

Two call sites treated branch name as if it uniquely identified "this chain's own pull request":

- `RunStore.listRunsAwaitingPullRequestDiscovery` (`src/run-store.ts`) suppressed PR discovery for
  a `succeeded` run whenever *any* `tracked_pull_requests` row already existed for
  `(project_name, branch_name)`, regardless of which run tracked it. A fresh chain reusing an old
  chain's branch was therefore never even attempted for discovery — its own PR (once opened) could
  never be found.
- `RunController.observeWaitPullRequestSignals`'s tracked-PR lookup (via
  `findTrackedPullRequestByIssueAndBranch`, added in PR #736) queried by `(project, issue,
  branch)` and returned the newest matching row. Before the fresh chain's own PR was ever
  discovered (blocked by the bug above, and in any case race-prone even if discovery worked), this
  returned the earlier chain's stale, already-terminal (merged/closed) row. `wait_for_pr_open`
  then read that stale PR's state as its own and immediately terminalized the fresh chain as
  merged or blocked, even though its own implementation had not opened a PR yet.

PR #736's own fix (commit 8e3a6df) closed a *different* gap: an issue carrying more than one
tracked row on *different* branches (redispatch after a title edit), where "newest row overall"
could pick the wrong branch's row. It explicitly did not — and structurally could not, using
branch name alone — distinguish an earlier chain's terminal PR from a new chain's not-yet-opened
one when the branch is identical. That gap is issue #738.

A chain-identity signal is needed that:

- is stable across every hop of one Run Chain (root run, its Continuations, its State Advances,
  its waiting-run parks), the same way `branch_name`/`workspace_path` are already carried forward
  once decided (ADR-2026-09-04-0837), and
- is *not* shared between two independently-created chains that happen to reuse the same branch
  name.

## Decision

Scope both call sites to the waiting/candidate run's own continuation lineage instead of its
branch name, using the `runs.continuation_parent_run_id` links that already exist (no schema
change):

- `RunStore.findTrackedPullRequestForRunChain({ projectName, runId })` walks
  `continuation_parent_run_id` back from `runId` through every ancestor (including `runId`
  itself) via a `with recursive` CTE, and returns the newest `tracked_pull_requests` row whose
  `run_id` is one of those ancestors. `observeWaitPullRequestSignals` uses this instead of the
  branch-scoped/issue-scoped lookup it used before; the `branchName` input it took is no longer
  needed and has been removed. `findTrackedPullRequestByIssueAndBranch` (PR #736) is now dead and
  has been deleted.
- `listRunsAwaitingPullRequestDiscovery` and `hasPullRequestFollowupWork` (the same suppression
  shape, gating whether the poller bothers looking at all) replace their branch-name `not exists`
  check with one scoped the same way: a shared CTE (`RUN_CHAIN_ROOT_CTE`) walks
  `continuation_parent_run_id` to resolve, for every candidate run and every run that has ever
  tracked a PR, the single root run at the top of its chain, and the suppression check requires a
  tracked row whose owning run resolves to the *same root* as the candidate — not merely a row
  sharing its branch name. Root equality (rather than "the tracked row's run is among the
  candidate's own ancestors") is what catches both directions: an ancestor-only join missed the
  case where a *descendant* continuation (e.g. a review-followup run) is the one that actually
  opened the PR, leaving the earlier, already-succeeded candidate blind to its own chain's PR and
  discovery-eligible until it exhausted its attempt cap despite the PR having succeeded.

An intra-chain hop (a review-followup Continuation, or a wait state that advances to another wait
state) still correctly finds its own chain's tracked PR through this lineage — `run_id` on the
tracked row was already always the originating (`succeeded`) run's own id (`trackPullRequest`'s
upsert never touches `run_id` on conflict, by design — see the comment at its definition), and
every descendant row's `continuation_parent_run_id` chain leads back to it. Two unrelated chains
that happen to share a branch name resolve to different roots, so neither lookup crosses between
them.

### Why not a materialized `chain_root_run_id` column

An earlier version of this design added a `chain_root_run_id` column to `runs` and
`tracked_pull_requests`, populated once at row creation (mirroring how `branch_name`/
`workspace_path` are already inherited) and queried directly instead of walking
`continuation_parent_run_id` per call. It was rejected: every pre-migration row would have a NULL
chain root, and treating NULL as "self is root" silently reclassifies every in-flight chain that
happens to be parked at a wait state across the upgrade — its waiting run's resolved root (itself)
would no longer match its tracked PR's resolved root (the original implementing run), so a live,
correctly-progressing chain would misread as having no tracked PR and eventually terminalize as
blocked via the untracked-wait bound, or re-enter discovery and terminalize via the
discovery-attempt bound. Making that safe requires a one-time backfill that resolves every existing
row's chain root before first use. The recursive-CTE approach needs no such backfill: it derives
chain membership from `continuation_parent_run_id`, a link every row has always carried, so it is
already correct for every existing row the moment the code ships. Chains are short (order 10 hops
at most), so the extra query cost of the walk is not a real concern at Symphonika's scale.

### Known gap: `reassignTrackedPullRequestRun` breaks the root-equality invariant

The "`trackPullRequest`'s upsert never touches `run_id` on conflict, by design" invariant above has
exactly one exception: `RunStore.reassignTrackedPullRequestRun`, called from `daemon.ts`'s adopt-pr
flow to move a `tracked_pull_requests` row's `run_id` onto a freshly adopted run when an operator
adopts a PR whose original implementing chain has gone stale. That reassignment is intentional and
correct for the adopted run — but the donor chain's own `succeeded`/`waiting` rows still resolve to
their own original chain root, which no longer matches the tracked row's (now reassigned) root.
Root-equality suppression stops recognizing the donor chain's rows as already-tracked, so
`listRunsAwaitingPullRequestDiscovery` re-lists them on every poll tick indefinitely. Tracked as
issue #746 alongside the related "transfer a rediscovered PR to a fresh chain" gap, since both are
instances of the same open design question: what run chain should own a tracked PR row after
`run_id` moves out from under the chain that originally created it.

### Addendum (2026-09-11, issue #745): branch equality retained as defense-in-depth

Both call sites additionally require branch-name equality alongside chain membership:

- `RUN_CHAIN_TRACKED_PULL_REQUEST_SUPPRESSION` requires the tracked row's `branch_name` to equal
  the candidate run's own `branch_name`, in addition to sharing a chain root.
- `findTrackedPullRequestForRunChain` requires the tracked row's `branch_name` to equal the
  waiting run's *resolved* branch (read from its own row via `runId`, not a re-plumbed caller
  parameter — this ADR's removal of `observeWaitPullRequestSignals`'s `branchName` input stands):
  the nearest non-empty `branch_name` found by walking the waiting run's own row, then its
  ancestors, up the chain. Falls back to chain-membership alone only when no run anywhere in the
  chain has a recorded branch.

This guards chains whose rows predate this ADR's fix (branch_name inherited once per chain): before
it, a mid-chain issue-title edit could recompute a continuation's own branch per attempt, diverging
it from an ancestor's tracked PR that still shares the same chain. Chain-root/chain-membership
matching alone would treat that ancestor's PR as covering the diverged continuation too.

Ancestor resolution (2026-09-11, PR #755 review): matching only the waiting run's own row is not
enough — a chain can also predate the point where `createWaitingRun` itself started persisting a
`branch_name` on the waiting row, leaving that one row's `branch_name` NULL even though a nearer
ancestor that reached its state through workspace prep (not necessarily this row's *immediate*
parent — a wait-to-wait re-park's immediate parent is itself another waiting row, so the walk can
take more than one hop) has a perfectly good one. Treating a NULL own-row branch as "no information"
and falling back to chain-membership alone reopens exactly the false match this addendum exists to
prevent. Walking to the nearest ancestor with a recorded branch closes that gap. The remaining
fallback — chain-membership alone when *no* run anywhere in the chain has a recorded branch — is
believed unreachable in practice for this call site (some ancestor in the chain must have reached
workspace prep to ever produce a tracked PR at all, and workspace prep always sets its own branch),
but is kept rather than turned into "no match" because failing open here degrades no worse than
before this ADR, while a backfill migration to eliminate it outright was judged not worth the schema
churn for a case that already can't arise through any live code path.

Both additions can only narrow the existing chain-scoped matching, never widen it — they cannot
reopen the branch-reuse bug this ADR fixes, since every current continuation-creation path inherits
`branch_name` from a parent that has one, and so satisfies branch equality trivially in the
post-ADR-2026-09-04-0837 steady state.

## Consequences

- A redispatch of an issue whose title has not changed (reusing the same deterministic branch
  name) is no longer blind to its own pull request, and no longer at risk of reading a previous,
  unrelated chain's terminal PR as its own.
- `observeWaitPullRequestSignals` no longer takes a `branchName` input; `RunController`'s wait
  re-evaluation call site was updated accordingly.
- `RunStore.findTrackedPullRequestByIssueAndBranch` (PR #736) is removed; its only caller was the
  lookup this ADR replaces. `RunStore.findTrackedPullRequestByIssue` (unscoped by branch) is
  unaffected — it has other, unrelated callers (`src/http/pages.ts`,
  `src/lifecycle/file-overlap-guard.ts`) that intentionally want the newest tracked row for an
  issue regardless of chain.
- CONTEXT.md gains a "Run Chain" glossary entry naming this lineage explicitly, since this ADR is
  the first place chain identity (as opposed to branch identity) becomes load-bearing for
  correctness rather than just workspace continuity.
