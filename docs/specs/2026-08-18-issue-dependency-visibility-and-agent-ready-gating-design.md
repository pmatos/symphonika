# Issue Dependency Visibility and Agent-Ready Gating

Status: proposed
Date: 2026-08-18

## Context

Symphonika has no structured dependency data today. Dependencies between issues are only ever
expressed as free text in issue bodies (`## Parent`, `Depends on #N`, `Blocked by #N`), and
`project_issue_snapshots` (ADR 0073) doesn't even persist issue body text, let alone a parsed form
of it. `SPEC.md` §2 lists "Parsing issue-body dependency syntax" as a v1 non-goal, written during
the bootstrap slice; the project is well past v1 now, so this spec treats that as needing an
update rather than a blocker, per this repo's own Workflow rule in `CLAUDE.md`.

A survey of this repo's 73 open issues during this design's brainstorm found the free text is not
reliably parseable: 8 issues use `## Parent`, 4 use "Depends on", 6 use "Blocked by", with
inconsistent phrasing (`#299`'s body says "Blocked by every other slice in #289" — prose, not a
`#N` reference a regex can resolve) and conflated semantics (`## Parent` sometimes points at an
issue deliberately kept open as a tracking epic — `#342`: "#199 (planning parent, kept open)" — so
"parent closed" would be a wrong readiness signal even where the text is parseable).

A GraphQL schema introspection during this brainstorm found GitHub has a native, structured
"issue dependencies" feature — `blockedBy`/`blocking` fields on `Issue`, distinct from sub-issues
(`trackedIssues`/`trackedInIssues`, which the project's own earlier investigation found empty on
`#295`). `blockedBy` is already populated on one issue in this repo (`#299`, all 5 blockers
closed), confirming it's real, queryable data — just barely adopted yet (1 of 73 open issues).

This work makes dependency state visible on `/issues` and a new dependency graph view, and uses it
to gate the agent-ready label: the daemon must not dispatch an issue whose dependencies are
unresolved, and the triage UI must not let an operator add the eligibility label while they're
unresolved.

**Depends on PR #471** (open, not yet merged as of this writing): that PR introduces this
codebase's first client-side framework and build step (React + esbuild, `ADR-0080`,
`scripts/build-client.mjs`, the `src/client/` pattern). This design's graph view extends that
pipeline rather than inventing a second one. The gating and data-model work in this spec has no
dependency on #471 and is separable from the graph view — see Sequencing below.

## Goals

- The daemon (`evaluateProjectEligibility`, `src/issue-polling.ts`) never dispatches an issue that
  has an unresolved dependency, regardless of what labels it carries. This is the authoritative
  gate.
- The `/issues` triage UI hard-blocks adding a project's configured eligibility label (e.g.
  `agent-ready` — whichever label is a member of that project's `issue_filters.labels_all`, not a
  hardcoded string) to an issue with an unresolved dependency. No override; the only way past it is
  to actually resolve the dependency (close the blocker, or fix a bad link) via GitHub itself.
- Dependency state is visible: an itemized count/link on the `/issues` table, full detail on the
  issue detail page, and a dedicated graph view for the whole dependency web.
- GitHub's native `blockedBy`/`blocking` relationship is the source of truth for gating. A
  dependency is resolved when the blocking issue's `state` is `CLOSED`, regardless of
  `stateReason` (`COMPLETED` or `NOT_PLANNED` both unblock — matches GitHub's own UI behavior).

## Non-Goals

- No general issue-body dependency DSL. `## Parent` gets parsed, but only as a best-effort,
  display-only signal for graph clustering — never for gating. An issue with no parseable `##
  Parent` (or none at all) just renders ungrouped in the graph; that's an expected, silent case,
  not an error.
- No override/bypass mechanism for the gate.
- No backfill tooling. Existing free-text dependencies aren't migrated automatically; operators
  re-link them via GitHub's own "blocked by" UI as needed, same as anyone adopting a GitHub feature
  after the fact.
- No polling of a foreign repo a cross-repo blocker lives in — `blockedBy`'s GraphQL response
  already carries the blocker's own `state`, so resolution works without it.
- No change to which labels are orchestrator-owned, or to `evaluateProjectEligibility`'s existing
  state/`labels_all`/`labels_none`/operational-label checks beyond adding the new dependency
  reason alongside them.

## Data Model

Per project, per poll cycle, a batched aliased GraphQL query (validated during this brainstorm at
20 issues per call) fetches, for every polled open issue:

```graphql
blockedBy(first: 25) {
  totalCount
  nodes { number title state repository { owner { login } name } }
}
```

This is inserted as an async step in the polling loop, before `evaluateProjectEligibility` runs —
today's loop maps synchronously over REST results, so this adds an `await` into that path.

Pagination handling: `first: 25` covers every case seen in this repo (`#299`'s max is 10) with
headroom. If `totalCount > 25`, the overflow is **not** silently ignored: it's treated as
unresolved and surfaced as its own reason (see Gating) rather than risking a false allow. Full
pagination (following `after` cursors) is not implemented in this pass — the truncation case is
rare enough that fail-closed-and-flag is an acceptable default, consistent with "hard block, no
override."

Both `IssueSnapshot` (`src/issue-polling.ts`) and the persisted `project_issue_snapshots` row gain
a new field, e.g.:

```ts
blockedBy: Array<{
  number: number;
  owner: string;
  repo: string;
  state: "OPEN" | "CLOSED";
  title: string;
}>;
```

stored as JSON in a new `blocked_by` column, matching the existing `labels`/`reasons` columns'
convention. This stores the full list (closed included), not just open blockers — the UI wants to
show "5 closed, 1 open," not a bare count.

## Gating

`evaluateProjectEligibility` gains a new, unconditional check (alongside state/`labels_all`/
`labels_none`/operational labels): for every blocker in `blockedBy` whose `state !== "CLOSED"`,
push a reason ``blocked by open dependency #N`` (`` blocked by open dependency owner/repo#N `` for
a cross-repo blocker). A truncation overflow (`totalCount > 25`) pushes its own reason (e.g. "has
more dependency links than can be checked — treat as unresolved until reviewed"). This is the
**authoritative** gate: it re-evaluates every poll cycle regardless of label state, so an issue
that's already `agent-ready` stops being dispatched the moment a fresh poll finds an unresolved
blocker, and resumes the moment the blocker closes and a poll picks that up.

The label-write route (`handleIssueLabelWrite` in `src/http/pages.ts`) gains a matching check: only
for the `add` action (never for `remove` — removing a required label is unaffected by dependency
state), if the label being added is a member of the current project's configured
`issue_filters.labels_all`
(threaded in via a new narrow callback on `RegisterPagesOptions`, e.g.
`getProjectRequiredLabels?: (projectName: string) => string[]`, mirroring the existing
`getProjectRepoAliases` pattern and wired by `daemon.ts` from `runtimeConfig.projectsByName()`),
and the issue's snapshot has any unresolved blocker, the write is rejected with a banner error
(hard block, no override) listing the specific blockers. This is explicitly **best-effort UX
against a snapshot that can be up to ~30s stale** (ADR 0073) — not a second authoritative gate. The
rejection banner offers the existing `pollNow` action (`RegisterPagesOptions.pollNow`, already used
for the post-label-write "poll now" offer) so an operator who just closed the blocker on GitHub can
refresh the snapshot immediately rather than waiting out the poll interval.

Because this reuses the existing `reasons` → `describeIssueVerdict` → Verdict-pill pipeline, an
unresolved dependency shows up in the Verdict pill too (`blocked: dep #301 open`), the same way any
other ineligibility reason already does. This is intentional, not a bug to suppress.

## Visibility

- **`/issues` table**: new "Deps" column — a count and link (e.g. "1 open ↗") into the graph view,
  independent of the Verdict pill (which surfaces the same fact in eligibility-reason form, per
  Gating above).
- **Issue detail page** (`/issues/:project/:number`): full itemized dependency list — number,
  title, state, `owner/repo#N` for cross-repo — alongside the existing label form.
- **Dependency graph view**: new route `GET /issues/graph`, filterable by `?project=` (matching
  `/issues`' own filter convention), reached from the Deps column link. Nodes are issues; edges are
  `blockedBy` relationships. Issues sharing a parsed `## Parent` target cluster into a compound
  node (cytoscape's compound-node feature is a direct fit for this); issues with no parseable
  parent render ungrouped. Cross-repo blocker nodes render as external (non-clickable, visually
  distinct — `owner/repo#N`, not a bare `#N`, since that would collide with local numbering).
  Follows ADR-0056's remaining guardrails: self-contained, read-only (pan/zoom/click-to-inspect
  only, no mutating actions), and degrades to a plain nested list if the client bundle fails to
  load.

## Client Architecture and Sequencing

The graph view extends PR #471 / ADR-0080's pipeline rather than starting a second one:
`scripts/build-client.mjs` moves from one hardcoded entry point/outfile to an `entryPoints[]` +
`outdir` esbuild call, adding `src/client/issues-deps-graph.tsx` → `dist/client/issues-deps-graph.js`
(served at a new `GET /assets/issues-deps-graph.js`, mirroring the existing asset route) — without
changing `issues-bulk.js`'s existing path. Cytoscape.js (~400KB minified) is bundled via esbuild
rather than CDN+SRI (the pattern `/runs/:id/graph` uses for the same library today): consistent
with ADR-0080's "self-contained, no external runtime dependency" rationale for React, and avoids
mixing two different script-loading strategies on one page.

Work splits into two independently-shippable phases; this spec covers both, but they landed as two
stacked PRs rather than one once Phase 1 alone reached a reviewable size on its own:

- **Phase 1 — no dependency on #471**: the GraphQL fetch, snapshot schema, both gates, the Deps
  column, and the issue-detail dependency list. All plain server-rendered HTML and backend logic.
  Opened as PR #472, stacked on `symphonika/session-49ed7661` (PR #471's branch) since it still
  builds on that PR's React/esbuild client tooling for Phase 2, though it has no client-side code of
  its own.
- **Phase 2 — needs #471's client pipeline**: the graph view. It's the only piece touching the
  React/esbuild pipeline, and lands as a second PR stacked on top of Phase 1's own branch.

## Docs Follow-Up

- `SPEC.md` §2: narrow "Parsing issue-body dependency syntax" the same way ADR-0056/0080 narrowed
  their own non-goals — Symphonika parses `## Parent` only for best-effort, non-gating graph
  clustering; real gating uses native GitHub `blockedBy` data, not a parsed body-text DSL.
- `CONTEXT.md`: note that dispatch eligibility now also depends on resolved GitHub-native
  `blockedBy` links, not label state alone.
- New ADR, `docs/adr/0081-issue-dependency-gating-and-graph-view.md` (numbered after `0080`, which PR
  #471 claims — renumber at merge time if landing order shifts): records the
  native-`blockedBy`-as-gate-source decision, the resolved-means-closed semantics,
  hard-block-no-override, the label-write gate's best-effort/snapshot-staleness caveat vs. the
  daemon's authoritative one, and `## Parent`-parsing's display-only clustering scope.

## Testing

- Unit tests for the batched GraphQL fetch: pagination-cap/truncation behavior, cross-repo shape,
  against a fake `octokit.graphql`.
- `evaluateProjectEligibility` unit tests for the new reason: single blocker, multiple blockers,
  cross-repo blocker, truncation-overflow case, all-closed (eligible) case.
- Route-level tests for the label-write rejection path (hard block, banner content, `pollNow`
  offer) and for the now-required `getProjectRequiredLabels` wiring.
- Snapshot schema migration test, consistent with this codebase's existing schema-evolution
  pattern in `run-store.ts`.
- A `happy-dom` test for the graph island — including the load-failure fallback path — mirroring
  `tests/client/issues-bulk-select.test.tsx` from PR #471.
- Page HTML wiring tests for the new Deps column and the `/issues/graph` route.
