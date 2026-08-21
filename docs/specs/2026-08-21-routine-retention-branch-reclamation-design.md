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

### Persist firing kind and atomically delete the ref

Snapshot the Routine kind onto each `routine_firings` row when the firing is
claimed. After reclaiming the worktree, delete `refs/heads/<branch>` with
`git update-ref -d` only when the persisted kind is `git`.

This is the selected approach. `update-ref -d` is idempotent when the ref is
already absent, so overlapping daemon and manual passes do not need a
check-then-delete sequence. Persisting kind prevents later Routine declaration
edits from changing cleanup ownership.

Historical rows created before kind persistence remain unclassified unless
their stored branch identity proves they were git firings. Retention does not
delete a branch for an unclassified row. This may leave a legacy branch behind,
but it cannot delete unrelated work based on mutable configuration.

### Recheck after `git branch -D` fails

Keep the current existence check and force-delete command, then run a second
existence check after failure. This can distinguish an already-absent ref from
a real deletion error, but it retains three Git processes and requires special
error recovery around the race.

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
3. atomically deletes that local ref, treating an already-absent ref as success.

Successful cleanup still marks `workspace_pruned_at`, while a genuine Git
failure remains in the retention failure report for retry.

## Test strategy

The TDD slices exercise behavior through `pruneRoutineWorkspaces` with real Git
repositories:

- a report firing whose derived git-firing branch name collides with an
  unrelated branch reclaims its worktree but preserves that branch;
- a git firing whose branch disappears concurrently is still reported and
  marked as pruned; and
- the Run Store persists the firing kind independently of later declaration
  changes and migrates legacy branch evidence conservatively.

The cleanup tutorial will explicitly disclose that git-firing reclamation also
force-deletes the deterministic local branch while report reclamation does not.
