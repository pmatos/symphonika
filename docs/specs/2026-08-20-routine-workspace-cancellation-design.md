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
uses Node's signal support directly on non-POSIX hosts. On POSIX it additionally makes the direct
Git child the leader of a detached process group, signals the whole group with `SIGTERM`, and
escalates survivors to `SIGKILL` after a one-second grace period. The Git promise awaits that bounded
shutdown, keeping the cache lock owned until transports, hooks, and helpers have stopped. On Linux,
the post-`SIGKILL` check reads procfs process state and treats a zombie-only group as stopped: those
entries cannot execute, and a non-reaping container PID 1 must not turn the original abort into a
false cleanup failure.

When no cache exists, preparation clones into a unique sibling staging directory. A successful clone
is renamed atomically to `cachePath`; any failed or aborted clone removes only that staging directory.
If another owner populated `cachePath` before publication, the invocation discards its staging clone
and validates the winner normally. Because `mkdtemp` starts at `0700`, preparation changes the
staging root to `0777 & ~process.umask()` before publication, matching the mode a direct clone would
have inherited rather than hard-coding one sharing policy; that adjustment is itself inside the
owned-path cleanup scope. Fetch interruption preserves the
previously validated cache; Git's own ref updates remain atomic and the dispatcher waits for the
whole Git process group to stop before a later caller can enter the cache serializer.

If cancellation interrupts creation of a new Routine Workspace, preparation removes only the
firing-specific branch/worktree it proved absent before starting. A reused workspace is never
removed. Cleanup prunes and verifies the bare-cache registration as well as the directory. A failed
verification throws `RoutineWorkspaceCleanupError`; the dispatcher logs it after preparation
settles while retaining the deadline-owned `firing_timeout` terminal reason. This prevents retention
from recording a timed-out firing as pruned while an orphaned `git worktree add` later materializes
the directory.

## Error handling

Abort errors remain abort errors at the workspace seam when cleanup completes. The deadline race
retains ownership of terminal classification, so deadline-driven aborts persist `firing_timeout`;
non-deadline callers can distinguish cancellation from deterministic `WorkspacePreparationError`
conflicts. Cleanup is awaited, and an incomplete cleanup is propagated as
`WorkspacePreparationCleanupError` and logged rather than silently retaining owned state.
`RoutineWorkspaceCleanupError` is its firing-worktree-specific subtype; failed clone-staging removal
uses the shared base type so the deadline handler reports either cleanup boundary.

## Public test seams

- `dispatchDueRoutines` proves that deadline expiry aborts its
  `PrepareRoutineWorkspaceInput.signal`, awaits preparation settlement, never launches a provider,
  and persists `failed / firing_timeout`.
- `prepareRoutineWorkspace` proves aborted first-clone and established-cache fetch preparations kill
  their helper process trees without a test-only release signal, leave no poisoned cache/workspace,
  preserve the process-umask cache mode, remove only firing-owned branch/worktree state, surface
  incomplete cleanup, and allow a later preparation for the same Project to succeed.
- Existing `prepareIssueWorkspace` and Routine Workspace tests prove completed caches and worktrees
  remain reusable.

## Scope

This change covers Git subprocesses started by Routine Workspace preparation, including the shared
clone/fetch operation and firing-specific branch/worktree commands. It does not add general operator
cancellation for issue-workspace preparation or cancellation to post-provider retention inspection;
those paths do not run under a Routine Firing Deadline.
