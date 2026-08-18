# Issue Dependency Gating and the Dependency Graph View

Status: Accepted

## Context

`agent-ready` (and any other project-configured required label) previously gated on issue state and
label filters alone (ADR 0077) -- nothing checked whether an issue's own prerequisites were done.
An issue marked ready while it was still blocked on another open issue could be dispatched, wasting
an agent run on work that couldn't actually be finished. GitHub Issues has a native `blockedBy` /
`blocking` relationship (distinct from sub-issues' `trackedIssues`/`trackedInIssues`), reachable over
the same GraphQL API `issue-polling.ts` already calls; no free-text parsing of issue bodies is
required to know an issue is blocked. See the design spec at
`docs/specs/2026-08-18-issue-dependency-visibility-and-agent-ready-gating-design.md` for the full
design discussion; this ADR records the decisions other work in this codebase needs to know about.

This work also makes dependency state visible: a "Deps" column on `/issues`, an itemized list on the
issue detail page, and a new `/issues/graph` view clustering issues by a best-effort parsed `##
Parent` heading. The graph view is the only piece touching the React/esbuild pipeline PR #471 / ADR
0080 introduced, and lands stacked on that PR's branch as a separate PR from the gating/visibility
work, once the latter's own size made it worth splitting rather than landing both as one PR.

## Decision

### Native `blockedBy` is the gate's only source of truth -- no body-text DSL

`fetchIssueDependencies` (`src/issue-polling.ts`) batches a GraphQL query for each project's open
issues' `blockedBy` edges (aliased, chunked at 20 issues/call, capped at 25 blockers/issue with a
`truncated` flag when an issue has more), the same batching shape this file's `PullRequestFollowup`
query already uses. `SPEC.md` §2's "Parsing issue-body dependency syntax" non-goal is narrowed the
same way ADR 0056/0080 narrowed their own non-goals: Symphonika parses issue body text only for
best-effort, non-gating graph clustering (see below), never as a second, competing gating mechanism.
A hand-written "Blocked by #123" sentence in an issue body is real-world unreliable -- stale after the
blocker closes, absent from templates that don't ask for it, free-text with no canonical format -- so
it was never a candidate for the gate itself, only evidence surveyed while designing this feature.

### Resolved means closed, regardless of `stateReason` -- and gating is a hard block, no override

A blocker counts as resolved when GitHub reports its `state` as `CLOSED`, whether that closure was
`COMPLETED` or `NOT_PLANNED`; distinguishing them would mean an operator manually judging each
blocker's closure reason before Symphonika trusts it, second-guessing a decision GitHub's own UI
already recorded. There is no per-issue override for a still-open blocker: unlike a filtered/excluded
label (which a human can already fix by editing labels on GitHub), "my blocker is still open" has
exactly one correct fix -- resolve the blocker -- and an override would let an issue dispatch against
its own stated prerequisites, defeating the purpose of gating on them at all. A blocker fetch that
hits the 25-per-issue cap sets `blockedByTruncated`, which gates identically to an open blocker (fail
closed on the unfetched overflow) rather than gating only on the blockers that happened to fit.

### Two gates, one snapshot-staleness caveat

`evaluateProjectEligibility` (`src/issue-polling.ts`) is the authoritative gate: the daemon refuses to
dispatch an already-`agent-ready` issue while `blockedBy` contains a non-`CLOSED` entry or
`blockedByTruncated` is true, evaluated fresh against each poll's live GraphQL result. The
label-write route's gate (`handleIssueLabelWrite` in `src/http/pages.ts`, via
`issueDependencyGateBlocks`) is a second, independent check against the *persisted* poll snapshot --
it exists to give an operator adding the required label immediate UX feedback ("blocked by open
#123 -- resolve on GitHub, then poll now") rather than letting them add the label only to have the
daemon silently refuse to dispatch it. Because it reads the snapshot rather than live GitHub, it can
be up to one poll interval stale in either direction: an operator who just closed the blocker on
GitHub sees the block until the next poll (the rejection banner offers the existing `pollNow` action
for this), and conversely the daemon's own gate is what actually prevents dispatch if the snapshot
were ever stale in the other direction. The label-write gate is deliberately not treated as
authoritative for this reason -- `evaluateProjectEligibility` is the single source of truth for
whether an issue may actually be dispatched.

Both gates reuse `RawGitHubIssueDependencyRef`'s `state` field directly rather than introducing a
separate "resolved" boolean anywhere in the data model, keeping "is this blocker resolved" a one-line
predicate (`state !== "CLOSED"`) evaluated at each gate site instead of a persisted derived fact that
could drift from the field it's derived from.

### The dependency reason reuses the existing `reasons` → verdict pipeline, on purpose

An unresolved dependency is pushed onto the same `reasons` array `evaluateProjectEligibility` already
returns for label/state filters, so it flows through `describeIssueVerdict` /
`issueVerdictFamily` unchanged and renders as a `blocked:`-styled Verdict pill exactly like any other
ineligibility reason. This is intentional: the Deps column and the Verdict pill are two views over the
same underlying fact (per the design spec's "Show in both" decision), not two independently
maintained signals that could disagree.

### `## Parent` clustering is display-only and degrades silently

`parseParentIssueNumber` (`src/issue-polling.ts`) looks for a `## Parent` heading followed by a bare
`#N` reference and returns `undefined` for anything else -- no heading, an unparseable reference, or
(the common case for a non-agentic issue) no epic at all. This is never a gating signal: an issue with
no parseable parent still gates purely on `blockedBy`, and the graph view renders it ungrouped rather
than erroring or omitting it. The parsed number is assumed same-repo as the issue it came from (the
heading carries no `owner/repo` of its own) -- cross-repo epics are out of scope for this best-effort
convenience.

### The graph synthesizes nodes cytoscape needs but the poll snapshot doesn't carry

`buildDependencyGraphElements` (`src/client/dependency-graph-elements.ts`, bundled client-side, not
run on the server) builds real "issue" nodes only for the open issues actually in scope --
`listProjectIssueSnapshots` holds open issues only, so a closed blocker, a cross-repo blocker, or a
`## Parent` target that isn't itself open in the current project never has a matching row. Rather than
drop those relationships from the graph, the function synthesizes an "external" node straight from the
`blockedBy` entry's own `number`/`owner`/`repo`/`state`/`title` (no extra fetch), and a "cluster"
placeholder node for a `## Parent` target that isn't already a real node -- reusing the real node's own
id instead when the parent *is* itself in scope, so cytoscape's compound-node feature nests children
under the actual issue rather than a redundant synthetic container.

### The graph view is a second, independent client bundle, not a growth of `issues-bulk.js`

`scripts/build-client.mjs` moved from a single hardcoded entry point/outfile to an `entryPoints[]` +
`outdir` esbuild call so `src/client/issues-deps-graph.tsx` bundles to its own
`dist/client/issues-deps-graph.js`, served by its own `GET /assets/issues-deps-graph.js` route,
without changing `issues-bulk.js`'s existing output path or route. Cytoscape.js is bundled the same
way React already is (ADR 0080), rather than CDN+SRI the way the pre-existing `/runs/:id/graph` view
loads it (ADR 0056) -- consistent with ADR 0080's "self-contained, no external runtime dependency"
rationale, and avoiding two different script-loading strategies on one page.

### Graceful degradation is progressive enhancement, not a load-failure handler

ADR 0056's guardrail ("degrades gracefully when its visualization dependencies are unavailable") was
written for CDN scripts, where a failed `<script>` load is observable and a fallback can be triggered
from it. A bundled script has no equivalent signal if it never loads at all -- there is no second
inline `<script>` guaranteed to still run. Instead, `renderIssueDependencyGraphPage`
(`src/http/pages.ts`) always server-renders a plain nested list of open blockers first, and
`IssuesDepsGraphView` (`src/client/issues-deps-graph-view.tsx`) only hides it after cytoscape has
mounted without throwing (wrapped in `try`/`catch`). A bundle that never loads leaves the list as the
only thing rendered, by construction rather than by detecting the failure.

## Consequences

- `project_issue_snapshots` gained `blocked_by`, `blocked_by_truncated`, and `parent_issue_number`
  columns (migrated via `ensureColumn`, like every column added after the table's original shape).
  `IssueSnapshot`'s matching fields are optional (a widely-shared type with ~65 call sites) while
  `ProjectIssueSnapshotRow`'s `blockedBy`/`blockedByTruncated` are required (a narrower type with far
  fewer call sites) -- `parentIssueNumber` stays optional on both, since most issues have no epic.
- `CONTEXT.md` is updated to note dispatch eligibility also depends on resolved GitHub-native
  `blockedBy` links, not label/state filters alone.
- `SPEC.md` §2's issue-body-dependency-syntax non-goal is narrowed as described above; §3's stack list
  gains cytoscape, scoped to the `/issues/graph` bundle the same way React/esbuild is scoped to
  `issues-bulk.js`.

## Numbering

ADR `0080` (issues bulk label editing and React client island, PR #471) is the most recent number in
tree; this ADR is `0081`.
