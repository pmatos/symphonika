# Outcome-aware age retention for Routine Firing workspaces

Status: Accepted

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
firings cannot be selected or marked as reclaimed. Reclamation uses
`git worktree remove --force <path>` and then `git worktree prune` against the Project's shared bare
cache. Force is required because report firings and failed Coding Agents can legitimately leave
dirty or untracked files. A locked worktree remains an error and is retried on a later daemon tick;
the Orchestrator does not bypass the lock or fall back to plain directory deletion. For a `kind: git`
firing, reclamation also deletes its deterministic local branch (`git branch -D`) from the shared
bare cache once the worktree is gone, since that branch otherwise has no further purpose and would
otherwise grow the same shared cache this ADR bounds. A `kind: report` firing was never given a
branch, so this step is a no-op for it.

The Run Store retains `workspace_path` and records `workspace_pruned_at`. Operator surfaces can
therefore show the historical path as `pruned` rather than interpreting a missing path as damage.
Reclamation never deletes the firing row, Routine Pull Requests, or anything under
`<state.root>/logs/routines/<firing-id>/`; it does delete the `kind: git` firing's local branch, as
described above. Provider logs, normalized events, and prompt evidence remain durable; retention for
those state-root artifacts is a separate future policy.

## Consequences

- Default unattended workspace growth is bounded by the firing rate within the configured windows.
- Failed and cancelled workspaces remain available much longer than successful workspaces.
- Dirty terminal worktrees are reclaimed without leaving stale bare-repository registrations.
- ADR 0025 continues to govern issue Workspaces and immediate lifecycle behavior. This ADR narrows
  it only for terminal Routine Firing workspaces after their configured retention window.
- Operators who disable automatic retention accept unbounded workspace growth and must run the
  manual command themselves.
