# Safe Routine retention branch reclamation

## Goal

Routine Workspace Retention must delete a reclaimed firing's deterministic
local branch only when that firing executed as `kind: git`. A report firing
must never delete a branch, even if an unrelated ref happens to match the
branch name that could be derived from its identity. Concurrent pruners must
also treat a branch that has already disappeared as successfully reclaimed.

The public behavior seam is `pruneRoutineWorkspaces`. Run Store readers are
the persistence seam that proves a firing retains its execution-time kind even
if its Routine declaration later changes.

## Considered approaches

### Persist firing kind and retain Git's worktree-aware deletion

Snapshot the Routine kind onto each `routine_firings` row when the firing is
claimed. After reclaiming the worktree, delete its local branch with
`git branch -D` only when the persisted kind is `git`.

This is the selected approach. Persisting kind prevents later Routine
declaration edits from changing cleanup ownership. `git branch -D` keeps Git's
native refusal to delete a branch checked out by another linked worktree in
the deletion operation itself. On deletion failure, retention distinguishes a
branch held by another worktree, an already-absent ref, and a genuine Git
error. A live holder and a concurrent deletion both let workspace reclamation
finish; genuine failures remain eligible for retry.

A firing branch name carries only the truncated firing id, so two firings of
one Routine created in the same millisecond can derive the same name. Keeping
the worktree-aware refusal prevents reclaiming the terminal one from deleting
the branch out from under the live one, including when preparation completes
immediately before deletion begins.

Historical rows created before kind persistence remain unclassified unless
their stored branch identity proves they were git firings. Retention does not
delete a branch for an unclassified row. This may leave a legacy branch behind,
but it cannot delete unrelated work based on mutable configuration.

### Delete with `git update-ref -d` and preflight worktree ownership

An atomic low-level ref deletion treats an absent ref as success, but it does
not preserve Git's checked-out-worktree refusal. A separate
`worktree list --porcelain` preflight still races with a firing that checks out
the ref between the preflight process and the deletion process.

### Serialize every pruner

Add a cross-process lock around automatic and manual retention. This would
prevent the known overlap but adds lock ownership and crash-recovery policy,
and it would not protect against an external Git process deleting the ref.

## Persistence and compatibility

New Routine Firings persist `kind` at claim time. The firing status and prune
candidate readers return that persisted value; cleanup never joins the mutable
`routines.kind` declaration to decide branch ownership.

The schema migration adds a nullable column for existing databases. It
backfills `git` only for historical rows with a recorded local branch ref and
leaves other historical rows unknown. Fresh databases and all new inserts
persist a non-null kind.

## Cleanup flow

Retention continues to remove the registered worktree and prune stale
registrations first. It then:

1. returns without touching refs unless the firing's persisted kind is `git`;
2. uses the firing's persisted branch ref, rejecting an absent or non-local ref
   as no branch deletion; and
3. force-deletes the branch through Git's worktree-aware command, preserving a
   ref held by another worktree and treating an already-absent ref as success.

Successful cleanup still marks `workspace_pruned_at`, while a genuine Git
failure remains in the retention failure report for retry.

## Test strategy

The TDD slices exercise behavior through `pruneRoutineWorkspaces` with real Git
repositories:

- a report firing whose derived git-firing branch name collides with an
  unrelated branch reclaims its worktree but preserves that branch;
- a git firing whose branch disappears concurrently is still reported and
  marked as pruned;
- a colliding firing that checks out the branch immediately before deletion
  keeps both its worktree and branch ref; and
- the Run Store persists the firing kind independently of later declaration
  changes, protects leaked git workspaces, permits age retention for leaked
  report workspaces, and migrates legacy branch evidence conservatively.

The cleanup tutorial explicitly discloses that git-firing reclamation also
force-deletes the deterministic local branch while report reclamation does not.
