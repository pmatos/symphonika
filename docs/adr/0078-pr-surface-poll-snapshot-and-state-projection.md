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

### Every PR's enrichment fetch runs with bounded concurrency within a project, and failing one never drops the row

`pollProjectPullRequests` (`src/pull-request-polling.ts`) fetches the bulk REST PR list once, then
fetches each PR's follow-up state through `mapWithConcurrency`, capped at
`PULL_REQUEST_ENRICHMENT_CONCURRENCY` (4) in flight at a time — each fetch is independent and
already isolates its own error inside `buildSnapshot`'s `try`/`catch`, so running a bounded batch
concurrently saves wall-clock time within one project's poll tick without changing semantics. An
unbounded `Promise.all` was tried first and self-reviewed as a real burst risk: every open PR's
GraphQL request fires at once, every poll interval, against the same token
`pull-request-followup.ts`'s primary loop depends on for its own rate limit — that loop processes
PRs sequentially by design for exactly this reason. A small concurrency cap keeps most of the
wall-clock win over fully serial fetching while never bursting more than a handful of requests at
once. When a single PR's state fetch throws, or the configured `GitHubIssuesApi` doesn't implement
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

### Label writes reuse `writeIssueLabels`, with `subjectNumber` instead of `issueNumber`

`WriteIssueLabelsFn` (`src/http/app.ts`) was `#308`'s issue-only mutation seam. GitHub's labels
endpoint treats an issue number and a PR number identically — the same `addLabelsToIssue`/
`removeLabelsFromIssue` calls work for both — so `#309` part 2 reuses the callback directly rather
than adding a parallel `writePullRequestLabels`. The input's `issueNumber` field is renamed to
`subjectNumber`, and a `kind: "issue" | "pull_request"` field is added: a PR-label call site
passing a PR number through a field literally named `issueNumber` would misname what it actually
holds, the kind of Mysterious Name a reviewer (or a later reader) would rightly flag even though it
causes no functional bug. `kind` is carried into the daemon-side implementation even though nothing
there branches on it today — clarity at the boundary, not a currently-load-bearing discriminant.
Every existing `#308` call site (`handleIssueLabelWrite`, `handleClearStaleClaim`) updates to pass
`kind: "issue"` alongside the renamed field; behavior is unchanged.

### `renderPullRequestLabelsSection`/`PullRequestLabelWriteBanner` are parallel to `#308`'s, not shared

The PR detail page's labels UI (`renderPullRequestLabelsSection`, `renderPullRequestLabelWriteBanner`,
`PullRequestLabelWriteBanner`) is structurally identical to `#308`'s issue-page equivalents but
kept as its own set of functions/types rather than genericized over "issue or PR" — the two pages'
banner unions will diverge in part 3 (a guarded-merge banner joins the PR page's union; nothing
else joins the issue page's), the same reason `#308` part 3 widened `IssueLabelWriteBanner` into a
union only once clear-stale-claim actually needed it, not ahead of time.

### Poll-now gained a `return_to`, since it now serves two search pages

`POST /issues/poll-now` predates `#309` and always rendered "Issue triage" / linked back to
`/issues`, regardless of which page's write banner triggered it. Once the PR detail page's own
successful label write also offers a poll-now trigger (`#309`'s poll tick refreshes issues and PRs
together, so one trigger genuinely serves both), that hard-coded copy and back-link became wrong
for half its callers. The route now reads an optional `return_to` form field, validated against a
fixed two-value allowlist (`POLL_NOW_RETURN_TARGETS`: `/issues`, `/prs`) — never trusted as a raw
redirect target, so a request replaying an arbitrary `return_to` value can only ever land on one of
these two known-safe internal paths, falling back to `/issues` for anything else (including no
value at all, preserving every existing caller's behavior). `renderPollNowForm` gained a second
`returnTo` parameter threaded from both detail pages' own path.

### The merge guard shares `#308`'s three-source liveness union, keyed by `runId` not `issueNumber`

`#308`'s `findLiveRunIdForIssue` matched a live entry by `(projectName, issueNumber)`; a PR-keyed
caller already knows the candidate `runId` directly (`TrackedPullRequest.runId`) and just needs
membership. Rather than a second three-source read, `findLiveRunIdForIssue` was refactored to call
a new shared `collectLiveRunEntries` (the same `getActiveRuns()` ∪ `listActiveRunIds()` ∪
`listWaitingRunIds()` union, concatenated in priority order), and a new `isRunIdLive` filters that
same union by `runId` membership instead of by `(project, issue)` match. `findLiveRunIdForIssue`'s
external behavior — same priority order, same first-match — is unchanged; only its internals moved.
`livePullRequestOwnerRunId` wraps `isRunIdLive` with the "no tracked row → never live" short
circuit, and is called from both the `GET` route (what the Merge section renders) and the `POST`
route (the actual refusal) so the button an operator sees always matches what the guard does.

### A tracked-but-terminated PR is treated as mergeable, the same as an untracked one

AC6's rule is "no *live* Run owns the PR," not "no Run has ever owned the PR." A PR whose tracked
row still exists but whose `runId` now points at a terminated Run (succeeded, failed, cancelled,
stale) is exactly as mergeable as `#259`'s never-tracked orphans — `livePullRequestOwnerRunId`
returns `undefined` for both cases, and the Merge section renders identically for both.

**On `listOpenTrackedPullRequests()`'s `state = 'open'` filter, used for this same lookup**: the
guard (and part 1's display join) both use this filtered list rather than an unfiltered lookup by
`(project, prNumber)`. This is deliberate, not an oversight: `tracked_pull_requests.state` tracks
the PR's own open/closed/merged status, not the owning Run's liveness — the two are independent
columns updated by different code paths. The only way this filter could hide a genuinely live
owner is if a row's `state` flips to `merged`/`closed` *before* its owning Run's own state
transitions out of `waiting` — and in `run-controller.ts`'s `reEvaluateWaitingRun`, those two writes
happen synchronously in the same function call with no `await` between them, so no concurrent HTTP
request can observe that intermediate state. Even in a theoretical future refactor that introduced
such a gap, the failure mode is bounded: GitHub itself refuses to merge an already-merged/closed
PR, and AC8's re-derivation reports that refusal honestly — never a silent double-dispatch.

### `method` is hardcoded to `"merge"`, not read from `pullRequestPolicyLoader()`

PR Follow-up's automatic merge (`run-controller.ts`) reads its merge method from
`pullRequestPolicyLoader()` — a policy governing the FSM's own `merge_pr` state under ADR-0044. A
dashboard click is the operator explicitly overriding that automatic path for one specific PR, not
a request to apply its policy; threading the policy loader into `pages.ts` would couple the manual
override path to the exact automatic path it exists to bypass. `expectedHeadSha` is still passed
(from the persisted snapshot's `headSha`) for the same safety property the FSM's own call has: if
new commits landed after the operator last saw the PR, GitHub refuses the merge rather than
merging code the operator never looked at — reported honestly via AC8.

### Evidence is one row per attempt, written once after the attempt completes

`recordPullRequestMergeAttempt` (AC9) is called exactly once, after both the merge call and the
post-attempt re-fetch have settled — not a two-phase "attempting" row followed by an update. A
two-phase write can leave a dangling "attempting" row if the process dies mid-merge; a single
post-attempt insert can lose the record entirely if the process dies after GitHub applies the merge
but before the write lands. The second failure mode is judged worse in principle (silent loss of
evidence for a mutation that actually happened) but is accepted here: the next poll tick's own
snapshot replacement will independently show the PR as merged regardless of whether this evidence
row exists, so the operator-facing consequence of the gap is "one attempt's evidence row is
missing," never "the PR's true state goes unnoticed." A durable two-phase design was considered and
rejected as disproportionate machinery for a gap whose only cost is a missing audit row, not a
missing fact about PR state.

A guard refusal (a live Run owns the PR) is not recorded as an attempt — `options.mergePullRequest`
is never invoked in that path, mirroring `#308`'s clear-stale-claim: `writeIssueLabels` is likewise
never called on that guard's own refusal. "The merge action is recorded" (AC9) is read as covering
an attempt that actually reached GitHub (successful or GitHub-refused), not a request the local
guard stopped before it left the process.

### Re-derivation renders the fresh fetch, never persists it

`MergePullRequestFn`'s `freshState` is rendered directly in the response banner
(`renderPullRequestFreshStateNote`) and nowhere written into `project_pull_request_snapshots` —
that table's invariant is "what the last successful poll saw," and a request-time write would
break the wholesale-replace contract every other write to that table upholds. The banner says so
implicitly by being the *only* place this fresher data appears; the Pull Request State section
below it still reads the persisted (possibly now-stale-by-one-poll) snapshot, consistent with every
other write on this page never mutating what's displayed outside its own banner.

## Consequences

- New table `project_pull_request_snapshots` (`src/run-store.ts`): one row per open PR per
  Project, replaced wholesale per successful poll. Columns: the cheap REST fields (`title`, `url`,
  `draft`, `open`, `merged`, `head_ref`, `head_sha`, `labels`, `branch_origin`), plus the enrichment
  fields (`state_available`, `mergeable`, `checks`, `review_decision`, `tracking_state`,
  `unresolved_review_threads`) which are all `null` together when `state_available` is false.
- New table `pull_request_merge_attempts` (`src/run-store.ts`): one row per dashboard-triggered
  merge attempt that actually reached GitHub, independent of any Run (AC9).
  `listPullRequestMergeAttempts` is a test-verification reader only — this slice ships no
  merge-attempt-history UI.
- New `GitHubIssuesApi` method `listPullRequests` (bulk, paginated, `state: "open"`) plus
  `tryListPullRequests`, alongside the existing per-branch `listPullRequestsForBranch`.
- `envReferenceName` and `normalizeLabels` (`src/issue-polling.ts`) are now exported —
  `pull-request-polling.ts` reuses both for the identical token-resolution error message and
  label-array normalization issue polling already implements, rather than near-duplicates of
  either.
- Part 1 is read-only: `GET /prs` (search: project, origin, tracking, free-text title) and
  `GET /prs/:project/:number` (full Pull Request State, branch/origin, follow-up tracking status
  and owning Run). AC1–AC4 land this part.
- Part 2 adds label add/remove on a PR (`POST /prs/:project/:number/labels/add|remove`), reusing
  `writeIssueLabels`/`tryAddLabelsToIssue`/`tryRemoveLabelsFromIssue` under the same `sym:*` policy
  `#308` established, and gives `POST /issues/poll-now` a `return_to` so it serves both search
  pages honestly. This closes AC5.
- Part 3 adds the ownership-guarded merge action (`POST /prs/:project/:number/merge`), reusing
  `#308`'s three-source liveness pattern refactored into `collectLiveRunEntries`/`isRunIdLive`,
  keyed by the tracked PR's `runId` rather than by issue number, plus durable evidence
  (`pull_request_merge_attempts`) and honest post-attempt state re-derivation
  (`renderPullRequestFreshStateNote`, never persisted). This closes AC6–AC9 and epic `#301`.
