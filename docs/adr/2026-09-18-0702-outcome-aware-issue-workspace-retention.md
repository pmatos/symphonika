# Outcome-aware age retention for Issue Workspaces

Status: Accepted

## Context

Every Issue run creates a registered Git worktree under
`<workspace.root>/issues/<issue-number>-<issue-slug>/`, reused across retries and continuations on
the same branch until explicit cleanup (ADR 0040). ADR 0025 preserves workspaces by default because
they may contain useful forensic or in-progress state, and deferred a general reclamation policy to
"future CLI or UI commands." ADR 0067 later narrowed that default for terminal Routine Firing
workspaces only. Issue Workspaces had no equivalent, and on a long-running host they never shrink:
one operator's `~/.local/state/symphonika/workspaces` reached 1.4T, almost entirely `issues/`
directories, because nothing had ever reclaimed them.

PR #782 added a "copy resume command" affordance for `failed`/`blocked`/`stale` runs
(`cd <workspace path> && <provider> --resume <session id>`) that depends on the workspace still
being on disk. Any retention policy for Issue Workspaces must keep that window usable, not delete on
the first terminal state.

## Decision

The Service Config owns an outcome-aware age policy, alongside `retention.routine_workspaces`:

```yaml
retention:
  issue_workspaces:
    enabled: true
    succeeded_days: 0
    failed_days: 3
```

Those values are the defaults when the block or individual fields are omitted. `enabled: false`
disables automatic reclamation, but `symphonika prune-workspaces [--dry-run]` remains available and
evaluates the configured age windows for both Routine Firing and Issue Workspaces in the same pass.

Only runs whose `workspace_path` is set are candidates, and only the newest run sharing a
`workspace_path` (continuations and retries reuse the parent's `workspace_path`, per ADR 0040)
decides eligibility: a `succeeded` newest run is a candidate once its `updated_at` crosses
`succeeded_days`; every other terminal state (`failed`, `stale`, `blocked`, `cancelled`,
`input_required`) shares the `failed_days` window. `cancelled` and `input_required` are not
mentioned by the issue that motivated this ADR; both are treated the same as `failed` because
neither is meaningfully different for the purpose of "how long might an operator still want to
inspect or resume this workspace" — `cancelled` is an operator- or daemon-initiated stop, not a
success, and `input_required` is exactly the kind of state where an operator may want to attach a
session. A workspace path is withheld regardless of the newest row's age if **any** run sharing that
path — including a just-created continuation — is still non-terminal, so an in-flight chain is never
reclaimed out from under itself.

Reclamation uses path-scoped `git worktree remove --force <path>` and does not run cache-wide `git
worktree prune`, for the same reason ADR 0067's amendment gives: prune has no path filter and could
deregister an unrelated worktree whose directory is temporarily unavailable.

**Unlike Routine Firing retention, reclamation never deletes the issue branch ref.** ADR 0040 makes
branch/worktree reuse the deliberate, ongoing identity of an Issue's work across every retry and
continuation until explicit cleanup — a Routine Firing branch has no further purpose once its firing
is terminal (ADR 0067 says so explicitly), but an Issue's branch is exactly what a later attempt on
the same issue checks back out. Symphonika also does not yet verify that a succeeded run's commits
reached durable remote state before reclaiming its worktree (the `commits_ahead` publication signal
ADR 0067's amendment introduced for Routine Firings has no Issue Workspace equivalent). Combined with
`succeeded_days: 0` — a run can become a candidate on the same tick it turns terminal, racing a
continuation scheduled roughly one second later (see the continuation-delay default) — deleting the
branch would risk silently resetting a reused branch name back to the base branch if a continuation
re-synced it from scratch. Leaving the ref in place costs a few kilobytes per issue in the shared
bare cache and keeps every reuse path safe: a later `git worktree add` on the preserved branch name
just checks its existing history back out, unaffected by whether the previous worktree was ever
reclaimed. This protection is deliberately deferred, the same posture ADR 0067 took for
commits-ahead-protected Routine Firings, pending a future verified-publication signal.

The Run Store retains `workspace_path` and records `workspace_pruned_at` on `runs`, mirroring
`routine_firings`. Reclamation never deletes the run row or anything under
`<state.root>/logs/runs/`; provider logs, normalized events, and prompt evidence remain durable.

## Consequences

- Default unattended Issue Workspace growth is bounded by the run rate within the configured
  windows, at the cost of the branch ref itself growing unboundedly in the shared bare cache (a few
  kilobytes each) until a future publication-aware policy can safely delete it.
- Failed, blocked, stale, cancelled, and input-required workspaces all get the same forensic/resume
  window; only `succeeded` is treated as "nothing left to resume" by default.
- `symphonika prune-workspaces` now reclaims both Routine Firing and Issue Workspaces in one pass.
- PR #782's resume-command UI is not gated on `workspace_pruned_at` in this change: once a workspace
  is reclaimed, the rendered resume command becomes stale (it still names the now-deleted path) until
  a future change threads that column through the dashboard's `RunStatus`. This is a known,
  accepted rough edge, not a correctness issue — resuming a stale command simply fails visibly at the
  shell.
- ADR 0025 no longer describes Issue Workspace lifecycle unconditionally; this ADR narrows it the
  same way ADR 0067 narrowed it for Routine Firing workspaces.
- Operators who disable automatic retention accept unbounded workspace growth and must run the
  manual command themselves.
