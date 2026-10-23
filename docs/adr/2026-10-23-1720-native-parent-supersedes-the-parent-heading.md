# Native Parent Supersedes the `## Parent` Heading

Status: Accepted

Amends: ADR 0081 (Issue Dependency Gating and the Dependency Graph View), section "`## Parent` clustering is display-only and degrades silently".

Relates to: ADR-2026-10-23-0852 (Native Parent Evidence on Issue Snapshots), ADR-2026-10-23-1112 (Epic View on the Project Page). Stage C of epic #844 / issue #858 (acceptance criterion 4).

## Context

ADR 0081 clustered `/issues/graph` by a best-effort `## Parent` heading parse because GitHub's native parent link was not recorded. Stage A recorded it as tri-state evidence on every snapshot (`present` | `none` | `unavailable`, or absent when nothing was recorded), and stage B made the Project page's Epic View native-only. The graph was the one place still driven by the heading, so a heading naming one epic and GitHub's hierarchy naming another produced two contradictory answers on two pages.

## Decision

- **Native evidence is authoritative wherever a parent is clustered or displayed.** `present` clusters the Issue under the native parent, using the parent's own `owner/repo#number`, title and state, so a cross-repository parent is a separate node from a same-numbered local Issue and a closed parent is shown with its `CLOSED` state. `none` means the Issue has no parent: the heading cannot create membership.
- **The heading survives only as a labelled legacy fallback, when native evidence is `unavailable` or absent.** A failed or partial read, a snapshot row persisted before the `native_parent` column existed, or a deployment without the hierarchy fetcher would otherwise silently un-cluster the whole graph for a poll interval; keeping the fallback avoids that flicker. It is not silent: the synthesized cluster is labelled "(legacy ## Parent heading)", each child node carries `parentSource: "legacy-heading"`, and the node detail panel says no native parent evidence was recorded. A native cluster is never downgraded: if a native child and a legacy child name the same parent, the node keeps the native label and each child keeps its own source.
- **Why not remove the heading entirely.** Removal would make every `unavailable` read, and every row from before the migration, render ungrouped, and would delete the only parent signal on hosts whose schema lacks `Issue.parent`. The cost of keeping it is bounded: it is read in exactly one place (`resolveParent` in `src/client/dependency-graph-elements.ts`) and only when native evidence says nothing. It can be deleted later, together with the `parent_issue_number` column, once `unavailable` is rare in practice; that is a separate decision.
- **One precedence rule, one place.** The server embeds `nativeParent` and `parentIssueNumber` as persisted; the graph element builder resolves them. The Epic View already ignores the heading, and no other consumer reads `parentIssueNumber`.
- **Migration safety.** No schema change. `parent_issue_number` and `native_parent` stay as they are; rows without `native_parent` read as unrecorded and take the labelled fallback until the next poll records evidence. A stored value that no longer parses still reads back as `unavailable` (ADR-2026-10-23-0852), never as a parent or `none`.
- **`blockedBy` never creates parentage**, in either the native or the fallback path.
- **Gating is untouched.** Neither `nativeParent` nor `parentIssueNumber` feeds `evaluateProjectEligibility` or the Dependency Gate.

## Consequences

- ADR 0081's heading clustering is superseded: it is no longer the primary or an override signal, only the labelled fallback above.
- The graph's fallback list (the plain server-rendered list shown when the bundle does not load) lists blockers only and does not render parents, so it has no parent source to get wrong.
- A parent the token cannot read is reported by GitHub as null and so appears as `none`; in that case a heading no longer clusters the Issue. That is the intended consequence of treating explicit `none` as authoritative (ADR-2026-10-23-0852 records the same visibility limit).
