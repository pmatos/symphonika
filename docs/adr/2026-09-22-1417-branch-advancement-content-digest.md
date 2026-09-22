# Branch-advancement detection compares content digest, not HEAD ancestry

Status: Accepted

## Context

`branch_advanced_since_attempt_start` proves an agent attempt did real work, distinct from
`branch_ahead_of_base`'s cumulative "any commit landed on this branch ever" signal. ADR-0085's
`refactor-swarm` template relies on it to require `red_team` and `refactoring` each produce a
genuinely distinct commit, not just reuse or amend a prior one.

The original implementation snapshotted `HEAD` before the provider ran and required
`git merge-base --is-ancestor <headShaAtStart> HEAD` at completion — the pre-attempt commit had to
remain a literal ancestor of the final `HEAD`. This broke on jsse (symphonika#806): jsse's `main`
merges generator-runtime PRs every few minutes, so a branch open for more than a few minutes is
often already stale. An agent that rebases or hard-resets onto the advanced base before pushing —
the correct response to a fast-moving base — rewrites its own earlier commits to new SHAs. The
pre-attempt SHA is no longer an ancestor of the rewritten `HEAD` even though the branch strictly
gained real work, so the ancestor check false-negatived and orphaned six otherwise-successful jsse
runs (real commits, quality gate green, PR opened) as `sym:blocked`.

A plain `HEAD !== headShaAtStart` inequality fixes the false negative but overcorrects: it also
reports "advanced" for a same-content rewrite (a bare `git commit --amend`, a no-diff
reword/squash), which is exactly what `red_team`/`refactoring` need to reject.

## Decision

Compare a content digest instead of `HEAD`'s SHA. `inspectWorkspaceContentDigest`
(`src/lifecycle/classify-failure.ts`) hashes `git diff origin/<base>...HEAD`, snapshotted once
before the provider runs and once at completion; `branch_advanced_since_attempt_start` is true iff
the two digests differ. Blob hashes are content-addressed, so a clean rebase/reset reproduces the
same diff text and digest (still correctly advanced), while a same-content rewrite also reproduces
the same digest (now correctly not advanced). Both properties fall out of one mechanism rather than
needing two.

## Consequences

- `red_team`/`refactoring`'s gate keeps requiring a genuinely distinct commit, same as before
  symphonika#806, while also surviving a mid-attempt rebase onto an advanced base.
- The `BLOCKED.md` sentinel (ADR-2026-09-10-1630) and the prompts' own instructions remain
  independent, complementary guards — this predicate was never the only line of defense against a
  mutating state skipping its required commit.
- See `docs/workflows.md`'s `branch_advanced_since_attempt_start` section for the predicate's full
  authoring reference.
