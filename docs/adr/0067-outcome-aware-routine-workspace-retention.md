# Outcome-aware age retention for Routine Firing workspaces

Status: Accepted

**Amendment note:** reclamation is path-scoped. `git worktree remove --force <path>` already removes
the selected checkout and its registration, so retention no longer follows it with cache-wide
`git worktree prune`. Prune has no path filter and could deregister an unrelated worktree whose
directory is temporarily unavailable. Candidate locks retain their original meaning and are not
overridden by retention.

## Context

Every Routine Firing creates a registered Git worktree under
`<workspace.root>/routines/<routine-name>/<firing-id>/`. Leaving every terminal firing in place
grows both checkout disk usage and the shared bare repository's worktree registrations. ADR 0025
preserves workspaces by default because they may contain useful forensic state, while ADR 0030
stores provider logs and rendered prompts under the state root specifically so agent-controlled
workspaces are not the evidence boundary.

Manual-only cleanup does not bound a long-running unattended daemon. Immediate deletion would bound
growth but erase the useful post-firing inspection window. Count-based retention gives a hard
registration count, but a burst of failures can evict same-day forensic work before an operator
looks at it.

## Decision

The Service Config owns an outcome-aware age policy:

```yaml
retention:
  routine_workspaces:
    enabled: true
    succeeded_days: 1
    failed_days: 14
    cancelled_days: 14
```

Those values are the defaults when the block or individual fields are omitted. `enabled: false`
disables automatic reclamation, but `symphonika prune-workspaces [--dry-run]` remains available and
evaluates the configured age windows.

Only terminal Routine Firings (`succeeded`, `failed`, or `cancelled`) whose terminal update time is
at or before the outcome cutoff are candidates. `queued`, `preparing_workspace`, and `running`
firings cannot be selected or marked as reclaimed. Every prepared `kind: git` workspace is
inspected for commits ahead before terminal completion, independently of lifecycle classification
and the canonical Routine Outcome. Every positive inspection persists `commits_ahead = 1` and is
withheld from age-based candidates, including failed and cancelled firings. Only a verified
zero-commits inspection permits age-based collection; an inspection failure is unknown and
conservatively persists the protection signal. A verified `pr`, `issue_opened`, or `issue_closed`
outcome does not prove that the firing's commits reached durable remote state. Symphonika does not
yet persist a separate publication transition, so the conservative policy retains these workspaces
indefinitely; a future verified publication signal or explicit destructive override may release
the protection.

Reclamation uses path-scoped `git worktree remove --force <path>` and does not run cache-wide
`git worktree prune`. Force is required because report firings and failed Coding Agents can
legitimately leave dirty or untracked files. A locked worktree remains an error and is retried on a
later daemon tick; the Orchestrator does not bypass the lock or fall back to plain directory
deletion. For a `kind: git` firing, reclamation also deletes its deterministic local branch from the
shared bare cache once the worktree is gone, since that branch otherwise has no further purpose and
would otherwise grow the same shared cache this ADR bounds. A `kind: report` firing was never given
a branch, so this step is a no-op for it. The firing persists its execution-time kind so a later
declaration edit cannot change branch ownership during cleanup. Ref deletion uses `git branch -D`,
preserving Git's refusal to delete a branch checked out by another registered worktree. That refusal
is part of the deletion operation rather than a separate preflight check, so a colliding firing that
checks out the branch while retention is deciding does not lose its ref. If deletion fails because
a concurrent daemon or manual pass has already removed the ref, cleanup still succeeds and records
reclamation; a ref now held by another firing is preserved. Historical firings without trustworthy
kind and local-ref evidence do not delete a derived branch. When workspace preparation failed before
creating either the planned workspace or a usable bare cache, retention treats the absent workspace
as already reclaimed and records that outcome; an existing workspace with an absent or unusable
cache remains an error and is never removed as a plain directory.

The Run Store retains `workspace_path` and records `workspace_pruned_at`. Operator surfaces can
therefore show the historical path as `pruned` rather than interpreting a missing path as damage.
Reclamation never deletes the firing row, Routine Pull Requests, or anything under
`<state.root>/logs/routines/<firing-id>/`; it does delete the `kind: git` firing's local branch, as
described above. Provider logs, normalized events, and prompt evidence remain durable; retention for
those state-root artifacts is a separate future policy. When a database first gains the
`commits_ahead` column, its addition and backfill run atomically. Every historical firing not known
to belong to a `kind: report` routine receives `commits_ahead = 1`: successful Git firings may have
a richer canonical action, failed and cancelled Git firings were not inspected on every historical
terminal path, and an unclassifiable row is likewise unknown rather than verified zero. The
one-time backfill does not run after the column exists, so it cannot overwrite later inspected-zero
evidence. Startup orphan reconciliation applies the same conservative protection to a prepared
`kind: git` workspace whose ordinary terminal inspection was interrupted by a daemon crash. It uses
the firing's persisted execution-time kind rather than the mutable Routine declaration: a leaked
`kind: report` workspace records zero commits-ahead and remains eligible for its normal age window,
while a historical firing whose kind is unknown remains conservatively protected.

## Consequences

- Default unattended workspace growth is bounded by the firing rate within the configured windows,
  except for firings whose commits-ahead evidence requires indefinite protection.
- Failed and cancelled workspaces remain available much longer than successful workspaces.
- Dirty terminal worktrees are reclaimed without leaving stale bare-repository registrations.
- ADR 0025 continues to govern issue Workspaces and immediate lifecycle behavior. This ADR narrows
  it only for terminal Routine Firing workspaces after their configured retention window.
- Operators who disable automatic retention accept unbounded workspace growth and must run the
  manual command themselves.
