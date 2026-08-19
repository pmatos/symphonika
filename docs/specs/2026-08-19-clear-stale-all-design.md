# Clear every stale claim in one Project

Issue #478 supplies the approved behavior for extending `clear-stale`. This note records the
implementation choices needed to apply it to the current CLI and `runClearStale` public seams.

## Public interface

The command becomes:

```text
symphonika clear-stale <project> [issue-number] [--all] [--config <path>] [--yes]
```

Exactly one target selector is required: either an issue number or `--all`. Commander reports a
usage error before invoking the runner when both or neither are supplied. The runner represents the
same invariant as a discriminated TypeScript union so non-CLI callers cannot construct an ambiguous
request accidentally.

The existing `runClearStale` seam continues to own Service Config loading, Project and credential
validation, GitHub repository access validation, confirmation warnings, and label removal. Its
report gains one outcome per selected Issue with status `cleared`, `already-removed`, or `error`.
Operation-level failures, such as an inaccessible repository or a failed `--all` listing, remain
report errors and produce no Issue outcomes.

## Approaches considered

### Extend `runClearStale` with batch selection and outcomes

The runner resolves the Project once, lists stale Issues once for `--all`, and then applies the
existing three-label removal to every selected Issue. This is the selected approach. It keeps all
operator-command GitHub behavior behind one seam, avoids repeating config and access validation,
and makes best-effort per-Issue handling explicit in the report.

### Loop the single-Issue runner in the CLI

The CLI could list Issue numbers and invoke `runClearStale` once per Issue. This was rejected because
it would repeatedly load and validate the same Project and repository, and the CLI would have to
combine warnings and errors that belong in the runner's typed report.

### Reuse the daemon issue-polling adapter

The command could use `GitHubIssuesApi.listOpenIssues` and the daemon label-write path. This was
rejected because `--all` must follow current GitHub `sym:stale` label state, including closed Issues,
rather than the daemon's open-Issue polling and eligibility semantics. `clear-stale` remains an
explicit operator command using its existing GitHub adapter.

## Selection and confirmation

For `--all`, the GitHub adapter performs one paginated `issues.listForRepo` query with
`labels: "sym:stale"` and `state: "all"`. Pull requests are excluded because GitHub's REST Issues
endpoint returns them alongside Issues. Issue numbers are de-duplicated and sorted ascending for
deterministic warnings and output.

Selection happens before the `--yes` gate. Without `--yes`, the runner emits a warning naming every
affected Issue number, performs no label removals, and returns the existing confirmation error. An
empty selection is still shown honestly and still follows the explicit-confirmation rule; with
`--yes`, it succeeds without mutations.

## Per-Issue outcomes and failure handling

For each selected Issue, the runner attempts all three labels in ADR-0038 order:
`sym:stale`, `sym:claimed`, then `sym:running`. It does not stop after one label or one Issue fails.

- `cleared`: at least one label removal succeeded and no removal returned a non-404 error.
- `already-removed`: all three removals returned GitHub 404, so no target label remained by the
  time the command acted.
- `error`: at least one removal returned a non-404 error. Successful and 404 removals for that Issue
  are retained as evidence, and processing continues with the next Issue.

The overall report is successful only when selection and validation succeed and no Issue outcome is
`error`. The CLI prints every Issue outcome even when the overall exit status is non-zero, so a
partial failure never hides which Issues were cleared.

Processing is sequential. The expected batch is an operator recovery action, and stable ordering
plus modest GitHub API pressure is preferable to adding concurrency policy for this slice.

## Tests and documentation

Behavior tests use two public seams:

1. CLI tests cover single-Issue compatibility, `--all` forwarding, both mutual-exclusion usage
   errors, confirmation output, and per-Issue result rendering.
2. `runClearStale` tests cover label-based discovery, no-write confirmation, empty batches,
   `cleared` / `already-removed` / `error` classification, and continuation after an Issue error.

`SPEC.md` records the new command shape and batch semantics. The domain language and ADR-0038's
explicit cleanup decision do not change, so no `CONTEXT.md` or new ADR amendment is required.
