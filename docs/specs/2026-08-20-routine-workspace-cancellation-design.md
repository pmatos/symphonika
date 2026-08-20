# Routine workspace cancellation design

## Goal

Make a Routine Firing Deadline stop workspace-preparation Git work before the firing is recorded as
`failed / firing_timeout`. Cancellation must settle the shared per-cache operation so later Routine
Firings and issue Runs do not wait for abandoned work, and an interrupted first clone must not leave
`cachePath` looking like a reusable repository.

## Considered approaches

1. Delete `cachePath` after every interrupted clone or fetch. This recovers a first clone, but it is
   unsafe after a fetch because an established bare cache can own live issue and routine worktrees.
2. Remove Git lock files after interruption. The cache-fetch serializer excludes other fetches, but
   it does not exclude provider Git commands in existing worktrees; guessing which lock files are
   stale could damage unrelated live work.
3. Thread an `AbortSignal` through the existing public workspace-preparation input and every Git
   command it starts. Clone into an invocation-owned sibling staging directory and atomically rename
   the complete bare repository into place. Remove only invocation-owned staging/worktree paths on
   abort and preserve an already-valid cache after an interrupted fetch. This is the selected
   approach because cleanup ownership is explicit and existing worktrees stay valid.

## Execution design

The firing deadline owns an `AbortController`. When its one absolute timer expires, it rejects all
deadline races with `RoutineFiringTimeoutError` and aborts the controller. The dispatcher passes the
controller's signal to `prepareRoutineWorkspace`; test and alternate implementations receive the
same optional signal through `PrepareRoutineWorkspaceInput`.

Routine workspace preparation passes the signal through the shared `ensureRepositoryCache` call and
its branch/worktree Git commands. The shared cache serializer checks the signal again after waiting
for an earlier caller, so an already-expired firing never starts a queued Git command. Git execution
uses Node's `execFile` signal support and settles only after the child exits, keeping the cache lock
owned until cancellation has reached the process.

When no cache exists, preparation clones into a unique sibling staging directory. A successful clone
is renamed atomically to `cachePath`; any failed or aborted clone removes only that staging directory.
If another owner populated `cachePath` before publication, the invocation discards its staging clone
and validates the winner normally. Fetch interruption preserves the previously validated cache;
Git's own ref updates remain atomic and the dispatcher waits for Git to exit before a later caller
can enter the cache serializer.

If cancellation interrupts creation of a new Routine Workspace, preparation removes only the
firing-specific worktree it proved absent before starting. A reused workspace is never removed. This
prevents retention from recording a timed-out firing as pruned while an orphaned `git worktree add`
later materializes the directory.

## Error handling

Abort errors remain abort errors at the workspace seam. The deadline race retains ownership of
terminal classification, so deadline-driven aborts persist `firing_timeout`; non-deadline callers
can distinguish cancellation from deterministic `WorkspacePreparationError` conflicts. Cleanup is
awaited, and a cleanup failure is propagated rather than silently publishing a partial cache.

## Public test seams

- `dispatchDueRoutines` proves that deadline expiry aborts its
  `PrepareRoutineWorkspaceInput.signal`, awaits preparation settlement, never launches a provider,
  and persists `failed / firing_timeout`.
- `prepareRoutineWorkspace` proves aborted first-clone and established-cache fetch preparations
  leave no poisoned cache/workspace, removes an aborted firing-owned worktree path without touching
  an existing firing, and allows a later preparation for the same Project to succeed.
- Existing `prepareIssueWorkspace` and Routine Workspace tests prove completed caches and worktrees
  remain reusable.

## Scope

This change covers Git subprocesses started by Routine Workspace preparation, including the shared
clone/fetch operation and firing-specific branch/worktree commands. It does not add general operator
cancellation for issue-workspace preparation or cancellation to post-provider retention inspection;
those paths do not run under a Routine Firing Deadline.
