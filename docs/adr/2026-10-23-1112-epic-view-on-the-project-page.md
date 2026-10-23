# Epic View on the Project Page

Status: Accepted

Relates to: ADR-2026-10-23-0852 (Native Parent Evidence on Issue Snapshots), ADR 0081 (Issue Dependency Gating and the Dependency Graph View), ADR 0073 (issue poll snapshots). Stage B of epic #844 / issue #858. Stage C supersedes ADR 0081's `## Parent` clustering for the canonical epic view.

## Context

Stage A recorded native parent evidence on every issue snapshot. Stage B has to show it: which Issues belong to a configured epic, with `blockedBy` kept visibly separate, and honest rendering when the evidence is missing, unavailable, cross-repository, or points at a closed parent.

## Decision

- **Home: the Project page, not `/issues`.** `epic_labels` is per-Project policy and the Project page already resolves it from the live Runtime Config Snapshot, along with the Project's `lastSuccessfulPollAt` / `lastPollOk` / `lastPollError` freshness state. `/issues` is a cross-Project bulk-edit table keyed by row; grouping there would need per-Project policy lookups and the repository-alias deduplication `/issues/graph` already carries.
- **Additive section, server-rendered.** `renderEpicViewSection` (`src/http/epic-view.ts`) emits plain HTML from the persisted snapshot; no client script. The Issues table is untouched, so a failed read can never drop or relocate a child.
- **Native-only membership.** A child is listed under an epic only when its `nativeParent` is `present`, `crossRepository` is false, and the parent number is an epic-labelled row in the same snapshot. `blockedBy` and `parentIssueNumber` (the heading parse) never create membership. A cross-repository parent never matches a same-numbered local epic.
- **Blockers are a separate column.** An open blocker renders as gating, a closed one as resolved, a truncated fetch as a blocking warning, mirroring `blocker.state !== "CLOSED"` and the dependency gate. The view reads the stored verdict; it does not re-evaluate eligibility.
- **Degraded evidence is listed, not hidden.** Issues with `unavailable`, absent, cross-repository, or closed-parent evidence appear under "Not grouped under an epic" with a badge. Absent is shown as "no native parent evidence recorded", never as "no parent" (ADR-2026-10-23-0852's fourth reading). An explicit `none`, and an open same-repository parent that is not epic-labelled, produce no entry: the Issue is simply in its normal place.
- **Closed parents cannot be verified as epics.** Snapshots hold open Issues only (ADR 0081), so a closed parent has no row to check for an Epic Label. It is shown as a "closed" badge on the child and never given an epic header synthesized from `nativeParent.title`. If a parent is still an epic-labelled row while its evidence says CLOSED (a poll race), the child is grouped under it with a "parent closed" badge.
- **Freshness.** The section shows the repository, the Project's last successful poll with `(pre-restart)`, a "polling failing" pill with the error when the latest poll failed (the last successful snapshot is still rendered), and each epic and child row's own `polledAt` age.

## Consequences

- Dispatch, eligibility, and the Dependency Gate are unchanged; nothing reads `nativeParent` for decisions.
- The `/issues/graph` view still clusters by the `## Parent` heading until stage C supersedes it.
- A parent the token cannot read is reported by GitHub as null and so is indistinguishable from `none` (ADR-2026-10-23-0852); the view is only as complete as the token's visibility.
