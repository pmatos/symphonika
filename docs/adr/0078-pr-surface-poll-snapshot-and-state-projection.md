# PR Surface: Poll Snapshot and State Projection

Status: Accepted

## Context

`#309` is the last slice of epic `#301`: a dashboard surface for pull requests, mirroring `#308`'s
issue triage but for PRs — list/search, Symphonika's own normalized Pull Request State
(`src/pull-request-state.ts`), follow-up tracking status, and (parts 2/3) label writes and a
guarded merge action. Unlike issues, there is no existing repo-wide PR poll: `listPullRequestsForBranch`
(`src/issue-polling.ts`) only ever fetches for one branch at a time, called per-tracked-PR by PR
Follow-up (ADR 0044). This ADR is filled in part by part as `#309`'s slices land, the same
convention ADR-0076/ADR-0077 used for `#307`/`#308`.

Part 1 (this fill-in) is poll infrastructure, a new persisted snapshot table, and a read-only
list/search/detail surface — `GET /prs` and `GET /prs/:project/:number`. No mutation of any kind
lands in part 1.

## Decision

### A new module, not a deeper `issue-polling.ts`

`src/issue-polling.ts` already stretches its own name across issues, PR-branch lookups, and PR
follow-up GraphQL fetching. Rather than add a third unrelated concern, the new per-repo PR list
(`listPullRequests` on `GitHubIssuesApi`, plus a `tryListPullRequests` wrapper mirroring the
existing `this`-binding-safe pattern) is added to `issue-polling.ts` — it's a `GitHubIssuesApi`
method, so it belongs on that interface — but the orchestration that turns a raw PR list into a
persisted snapshot lives in a new `src/pull-request-polling.ts`, parallel to how
`src/pull-request-state.ts` already keeps interpretation separate from fetching.

### Symphonika's Pull Request State is fetched at poll time, not per page load

The issue's own acceptance criteria ask for two things that pull in opposite directions: "backed
by the poll snapshot" (AC1) and "each PR shows normalized Pull Request State, not raw GitHub
fields" (AC2) — and computing that state (`interpretPullRequest`) requires the GraphQL-backed
`getPullRequestFollowupState`, a per-PR call the cheap REST bulk list doesn't include.

The alternative — fetch state live, lazily, only when a PR's detail page is opened — was
considered and rejected: a human browsing a search page with a dozen rows can trigger far more
GraphQL calls, on a far less predictable cadence, than a bounded poll tick does. A poll tick fires
N calls (N = open PRs for that Project) on a fixed schedule the daemon controls; an operator
clicking around the dashboard does not. Fetching once per poll tick and persisting the result is
strictly cheaper and more predictable for GitHub's rate limits than fetching per request would be.

This does not widen what PR Follow-up (ADR 0044) *acts on* — that loop remains scoped to PRs
discovered from Symphonika's own Issue Branches, deliberately. This is a separate, read-only poll
that fetches more data for *display* than PR Follow-up needs for *action*; ADR-0044's scoping
decision governs automatic behavior, not what a dashboard may read.

### Every PR's enrichment fetch runs concurrently within a project, and failing one never drops the row

`pollProjectPullRequests` (`src/pull-request-polling.ts`) fetches the bulk REST PR list once, then
fetches each PR's follow-up state via `Promise.all` — each fetch is independent and already
isolates its own error inside `buildSnapshot`'s `try`/`catch`, so running them concurrently only
saves wall-clock time within one project's poll tick, it changes no semantics. When a single PR's
state fetch throws, or the configured `GitHubIssuesApi` doesn't implement
`getPullRequestFollowupState` at all, `buildSnapshot` returns the cheap REST-derived fields
(`title`, `draft`, `open`, `merged`, `headRef`/`headSha`, `branchOrigin`, `url`) with
`stateAvailable: false` rather than dropping the row. This matters specifically because of AC4: the
`#259` orphans (twelve untracked PRs) are exactly the case where GitHub follow-up state might be
slow, rate-limited, or simply not yet fetched, and they are exactly the PRs this slice exists to
make visible. A poll design that silently drops a PR whose enrichment failed would defeat the
slice's own motivating example.

`stateAvailable` is persisted as its own column (`project_pull_request_snapshots.state_available`)
rather than left implicit. A row where `mergeable`/`checks`/`reviewDecision`/`trackingState` are
all `null` because GitHub genuinely returned an ambiguous state is a different fact from a row
where they're `null` because Symphonika never got to ask — collapsing the two would let the page
show "unknown" for both and mislead the operator about which case they're looking at.

### The new snapshot table mirrors `project_issue_snapshots`'s replace-wholesale rule

`project_pull_request_snapshots` (new table, `src/run-store.ts`) follows `#303`'s
`project_issue_snapshots` (ADR 0073) exactly: the daemon replaces a Project's rows wholesale on
every *successful* poll for that Project (`replaceProjectPullRequestSnapshots`), so a PR that stops
being returned (closed, merged, or simply no longer open) ages out on the next successful tick,
and a failed poll leaves the prior snapshot in place rather than blanking the table. The PR poll
runs inside its own `try`/`catch` in `startDaemon`'s tick loop, separate from the issue poll's own
try/catch — a PR-poll failure must never blank `issuePollStatus`, which dispatch eligibility
depends on; it only logs a warning and leaves the PR snapshot at its last-known state.

### Branch-origin classification is structural, not a re-derivation of either naming scheme

`classifyPullRequestBranchOrigin` (`src/pull-request-polling.ts`) classifies a PR's head ref into
`issue_branch`, `routine_firing_branch`, or `neither` using only the ref string's shape: an Issue
Branch is `sym/<project>/<issue>-<slug>` (`planWorkspacePaths`, `src/workspace-paths.ts`); a
Routine Firing branch is `sym/<project>/routine/<routine>/<firing-prefix>`
(`routineFiringBranchName`, `src/routines/workspace.ts`). Both start with `sym/`; only the
`/routine/` segment tells them apart, so the classifier checks exactly that rather than
reconstructing either naming function's own project/issue/routine-slug logic — a PR's ref is
already the literal string GitHub returns, and re-deriving what Symphonika *would* have named a
branch, to compare against what one actually is, would be strictly more code for the same answer.
A missing ref (`head.ref` is optional on `RawGitHubPullRequest`) classifies as `neither`.

### Follow-up tracking status is joined at read time, not persisted on the snapshot row

Whether a PR is tracked by PR Follow-up, and which Run owns it, comes from `tracked_pull_requests`
(`TrackedPullRequest`, `runId` directly on the row) — joined against the poll snapshot at read time
(`buildTrackedPullRequestIndex`, `src/http/pages.ts`), not copied onto
`project_pull_request_snapshots` itself. A PR's tracking status can change (review-dispatch cap
reached, the owning Run cancelled) independently of the next PR poll tick; persisting a `runId`
snapshot-side would let the two tables disagree between polls. This mirrors `resolveClaimedRunId`
in `#308`'s issue triage: read the Run Store fresh at request time rather than caching a
point-in-time join.

### Two views, not one: `/prs` is new, not folded into the existing Routine Pull Request list

`renderFiringPullRequests` (`/firings/:id`, `#304`) already renders `RoutinePullRequestStatus` rows
— but those are, by `CONTEXT.md`'s own definition, "informational associations" from a Routine
Firing's branch that never enter PR Follow-up, review re-dispatch, or auto-merge. `/prs` answers a
different, broader question: every open PR from a configured Project's repo, tracked or not,
Symphonika-originated or not (AC4's `#259` orphans are exactly the "not tracked, but Symphonika
branch" case). Folding the two would either drag PR Follow-up/merge concerns into the Firing page's
deliberately read-only informational listing, or lose the repo-wide scope `/prs` needs. They stay
separate surfaces over related but distinct data, the same reasoning ADR-0077 gave for keeping
`/issues` and `/projects/:name`'s own issue table apart.

## Consequences

- New table `project_pull_request_snapshots` (`src/run-store.ts`): one row per open PR per
  Project, replaced wholesale per successful poll. Columns: the cheap REST fields (`title`, `url`,
  `draft`, `open`, `merged`, `head_ref`, `head_sha`, `branch_origin`), plus the enrichment fields
  (`state_available`, `mergeable`, `checks`, `review_decision`, `tracking_state`,
  `unresolved_review_threads`) which are all `null` together when `state_available` is false.
- New `GitHubIssuesApi` method `listPullRequests` (bulk, paginated, `state: "open"`) plus
  `tryListPullRequests`, alongside the existing per-branch `listPullRequestsForBranch`.
- `envReferenceName` (`src/issue-polling.ts`) is now exported — `pull-request-polling.ts` reuses it
  for the identical token-resolution error message issue polling already produces, rather than a
  fourth near-duplicate of that string.
- Part 1 is read-only: `GET /prs` (search: project, origin, tracking, free-text title) and
  `GET /prs/:project/:number` (full Pull Request State, branch/origin, follow-up tracking status
  and owning Run). AC1–AC4 land this part.
- Part 2 will add label add/remove on a PR, reusing `writeIssueLabels`/`tryAddLabelsToIssue`/
  `tryRemoveLabelsFromIssue` under the same `sym:*` policy `#308` established (AC5).
- Part 3 will add the ownership-guarded merge action, evidence recording, and honest re-derivation
  of state after a merge attempt (AC6–AC9), reusing `#308`'s three-source liveness pattern
  (`getActiveRuns()` ∪ `listActiveRunIds()` ∪ `listWaitingRunIds()`) keyed by the tracked PR's
  `runId` rather than by issue number. This closes epic `#301`.
