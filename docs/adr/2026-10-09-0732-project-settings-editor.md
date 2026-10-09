# Focused Project settings editor and Epic Labels

Status: Accepted

Part of epic #844, slice #857 (builds on ADR-2026-10-08-1426).

## Decision

`GET /projects/:name/settings` edits one Dispatch Project's Ready Label, priority policy, and a new
`epic_labels` list. It reuses the Service Config editor's pipeline instead of adding a write path:
the preview builds a whole-file candidate by a comment-preserving YAML edit of those keys, validates
it with `validateServiceConfigContent`, and the confirm hands it to `runSavePipeline` (hash check,
atomic write, real reload). A reload failure after the write is "Saved, but not active"; the Project
page reads the runtime snapshot, so a rejected configuration is never presented as active.

The confirm form carries the whole candidate file, which would let a forged POST bypass the
provider-command confirmation of `/config/edit`. The confirm route therefore refuses any submitted
content that differs from disk outside the named Project's `issue_filters.ready_label`,
`issue_filters.labels_all`, `priority.labels`, `priority.default` and `epic_labels` keys. Preview and
confirm also refuse a stale file themselves (`409`) rather than diffing against someone else's edit.
A Project whose settings are shared through a YAML anchor or alias is refused, since editing it would
silently change sibling Projects.

`epic_labels` is a top-level Dispatch Project key (default: absent), not part of `issue_filters`,
because it is not a filter. It is display vocabulary: the schema rejects an Epic Label that equals the
`ready_label` or appears in `priority.labels`, so an epic label cannot carry eligibility or priority
meaning. A Routine Host rejects it as a dispatch-only key.

## Consequences

- Using Epic Labels to mark rows on `/issues`, the dependency graph or Maestro is a follow-up.
- Edited priority maps keep existing entries in place and append new ones; the Project page sorts
  them lower-number-first for display.
- The pre-existing gap between `runSavePipeline`'s hash check and its write is unchanged.
