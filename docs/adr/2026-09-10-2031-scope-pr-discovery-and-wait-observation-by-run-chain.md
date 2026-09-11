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

### `trackPullRequest`'s conflict path now reassigns a dead owner's row (issue #746)

The "`trackPullRequest`'s upsert never touches `run_id` on conflict" invariant above was too
strong: a fresh, unrelated chain that reuses an earlier chain's branch name can rediscover that
earlier chain's still-open PR (its own pushed commits land on the same PR), and the unconditional
preserve-on-conflict behavior left the row pointing at the earlier chain forever — the fresh chain
could never find its own PR (`findTrackedPullRequestForRunChain`), and discovery kept
"rediscovering" it every poll tick without ever incrementing `pr_discovery_attempts`.
`trackPullRequest`'s upsert now reassigns `run_id` to the rediscovering candidate only when every
run in the existing owner's chain — the whole tree reachable via `continuation_parent_run_id`,
walked up to the chain root and back down, not just forward from the owner row — has gone terminal
(`TERMINAL_RUN_STATES`). Checking the whole chain rather than just the owner run matters because the
owner run is always `succeeded` (itself terminal) by construction —
`listRunsAwaitingPullRequestDiscovery` only considers `succeeded` runs — so a check of the owner run
alone would reassign unconditionally, reintroducing the exact hazard this hedge exists to avoid: a
still-live descendant (e.g. parked at `wait_for_pr_open`) depending on that ownership. Walking up to
the root and back down, rather than only forward from the owner row, matters separately because the
owner row can itself be a descendant continuation: a forward-only walk would miss a live run on a
*different* branch of the same tree (e.g. a sibling continuation off a shared ancestor), wrongly
reporting the chain as fully terminal.

Reassigning away from a fully terminal donor reintroduces the same root-equality gap described
below for `reassignTrackedPullRequestRun`, but automatically and repeatably: root-equality
suppression only protects the row's *current* owner, so the instant ownership moves, the donor's
root no longer matches and it falls back into `listRunsAwaitingPullRequestDiscovery` — rediscovers
the same still-open PR, and (being terminal too) reclaims the row right back, oscillating with the
new owner every poll tick, forever, with neither chain's `pr_discovery_attempts` ever advancing (it
is only incremented on the "PR not found" path). `trackPullRequest` now closes this for its own
conflict path by retiring the displaced donor at transfer time: every run sharing the donor's chain
root — walked up to the root and back down, not just forward from the owner row, since the owner
row can be a descendant continuation rather than the root itself — has `pr_discovery_attempts`
pinned at `MAX_PULL_REQUEST_DISCOVERY_ATTEMPTS`, permanently excluding it from
`PULL_REQUEST_DISCOVERY_ELIGIBLE_RUN_PREDICATE`. Both current callers of that predicate
(`listRunsAwaitingPullRequestDiscovery`, `hasPullRequestFollowupWork`) always use the default cap,
so this reliably retires the chain; it is a pinned sentinel, not a real attempt count, once used
this way.

Reassignment must also clear `last_followup_run_id`, not just `run_id`. That column caches the most
recent review-dispatch run so `dispatchReviewFollowupIfNeeded` can parent the next dispatch onto it
(falling back to `run_id` only when unset); left pointing at the retired donor chain after transfer,
it would re-parent the next dispatch onto that dead chain instead of the new owner, and
`findTrackedPullRequestForRunChain` — scoped to the new owner's chain — would never see the
resulting run. Both `trackPullRequest`'s conflict path and `reassignTrackedPullRequestRun` clear it
whenever `run_id` moves.

### Known gap: `reassignTrackedPullRequestRun` still breaks the root-equality invariant

`RunStore.reassignTrackedPullRequestRun`, called from `daemon.ts`'s adopt-pr flow to move a
`tracked_pull_requests` row's `run_id` onto a freshly adopted run when an operator adopts a PR
whose original implementing chain has gone stale, remains a second, deliberately unconditional
exception to the invariant above — an operator's adopt-pr decision overrides whatever the
donor chain's own `RunState` says, so it cannot wait for the same liveness check `trackPullRequest`
now applies. That reassignment is intentional and correct for the adopted run — but the donor
chain's own `succeeded`/`waiting` rows still resolve to their own original chain root, which no
longer matches the tracked row's (now reassigned) root. Root-equality suppression stops
recognizing the donor chain's rows as already-tracked, so `listRunsAwaitingPullRequestDiscovery`
re-lists them on every poll tick indefinitely. This half of issue #746 is intentionally left open:
it needs the donor chain's own rows to be superseded or re-linked at adopt-pr time, in
`daemon.ts`/`createAdoptedRun`, not a change to `trackPullRequest`'s conflict path.

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
