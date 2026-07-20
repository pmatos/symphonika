# Workflow Contract evidence-ignore design

Status: accepted by issue #201

## Goal

Let a Project declare workspace-relative directory trees in Markdown Workflow Contract front matter
whose mtimes do not count as Watchdog progress. The policy is additive to the built-in `.git/`,
`target/`, and `node_modules/` excludes and remains separate from service-config
`watchdog.mtime_ignore`, which filters individual files by glob.

## Selected design

`parseWorkflowContract` retains a validated `evidence.ignore` list on the parsed contract. Entries
must be non-empty strings, must not start with `/`, and must not contain `..`. The runtime reload
pipeline copies the policy into each Markdown `WorkflowSnapshot`; invalid edits use the existing
reload-error and last-known-good behavior.

On each daemon reconciliation tick, the Watchdog resolves the current Workflow Snapshot for the
sampled Run's Project. The workspace walker compares each directory's workspace-relative POSIX path
with the declared set before reading metadata or descending. Built-in excludes are checked
independently and therefore cannot be replaced by Workflow Contract configuration.

Raw-FSM workflow files are unchanged. Issue #201 and ADR 0054 define this policy as Markdown
Workflow Contract front matter, and no raw-FSM location for prompt-adjacent policy is specified.

## Alternatives considered

- Adding more service-config globs would not express repository-owned per-Project policy and would
  retain file-level traversal rather than pruning whole trees.
- Extending the built-in directory set would require a Symphonika release for every Project-specific
  build directory.
- Adding a raw-FSM policy location in this slice would invent syntax beyond issue #201.

## Validation and tests

Tests cover contract parsing, absolute/parent/non-string rejection, doctor surfacing, defensive
reload fallback, directory-pruning behavior, built-in excludes, ignored-only stale termination,
unignored progress, and simultaneous ignored and normal workspace changes. Daemon-level tests prove
that the current Workflow Contract snapshot reaches the Watchdog rather than only exercising the
walker in isolation.
