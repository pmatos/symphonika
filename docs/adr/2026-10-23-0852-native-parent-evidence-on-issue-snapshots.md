# Native Parent Evidence on Issue Snapshots

Status: Accepted

Relates to: ADR 0081 (Issue Dependency Gating and the Dependency Graph View), ADR-2026-10-07-0813 (Maestro Read-Only Boundary). Stage A of epic #844 / issue #858; the stage that makes native hierarchy win over the `## Parent` heading, and the amendment to ADR 0081's `## Parent` clustering section, land with later stages.

## Context

ADR 0081 clusters the `/issues/graph` view by a best-effort `## Parent` heading parse. GitHub also exposes a native parent/sub-issue relationship (`Issue.parent`), distinct from `blockedBy`. Before any view can prefer it, the poll has to record it as evidence, and the record has to survive three failure shapes without lying: the read failed, the parent is in another repository, and the parent is closed.

## Decision

- **Separate fetch, not an extension of the dependency query.** `fetchIssueHierarchy` (`src/issue-polling.ts`) batches `parent { number title state repository { owner name } }` per open issue, using the same aliasing and 20-issues-per-call chunking as `fetchIssueDependencies`, behind its own optional `GitHubIssuesApi.getIssueHierarchy`. The dependency result gates dispatch and fails the project poll when it cannot be read; hierarchy is display evidence and must not inherit that failure mode or put the gate's query at risk (for example on a host whose schema lacks `Issue.parent`).
- **Tri-state evidence, `IssueNativeParent`.** `present` (with `owner`, `repo`, `number`, `state`, `title`, `crossRepository`), `none` (GitHub returned an explicit null parent), `unavailable` (the batch call failed, the issue could not be resolved, the `parent` key was missing, or a parent node lacked a number or repository). `unavailable` is never collapsed into `none`, and a malformed node never produces a parent.
- **Degrade, never drop.** A failed batch marks only its own issues `unavailable`; a failed hierarchy fetch never fails the poll and never removes an issue from the candidate or filtered lists. Closed and cross-repository parents are recorded as `present` with `state: "CLOSED"` / `crossRepository: true`, so a later view can badge them rather than hide them.
- **Absent is a fourth, distinct reading.** `IssueSnapshot.nativeParent` and `ProjectIssueSnapshotRow.nativeParent` are optional. Absent means no evidence was recorded (fetcher not configured, or a row persisted before the column existed); it is not `none`.
- **Persistence.** One nullable JSON column, `project_issue_snapshots.native_parent`, added by `ensureColumn`. A value that no longer parses to a known shape reads back as `unavailable`, never as a parent or `none`. Freshness provenance is the row's existing `polled_at`.
- **Independence.** `blockedBy` never feeds `nativeParent`, `nativeParent` never enters `evaluateProjectEligibility`, and the `## Parent` heading parse and `parentIssueNumber` column are unchanged and stored alongside.

## Consequences

- No user-visible change in this stage: no page, graph, or gate reads `nativeParent` yet.
- One extra GraphQL call per 20 open issues per poll.
- GitHub reports a parent the token cannot read as null, so such a parent is indistinguishable from `none`; the evidence is only as complete as the token's visibility.
