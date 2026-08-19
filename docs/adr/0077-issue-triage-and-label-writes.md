# Issue Triage: Snapshot-Backed Search, Verdicts, and Label Writes

Status: Accepted

## Context

`#308` asks for a dashboard surface to search the issues Symphonika already polls, see its own
eligibility verdict on each, and change the labels that verdict depends on. The issue's own ADR
pointer names "0065", allocated long before this work started — `docs/adr/0065-*` does not exist,
and the daemon-stale-banner threshold already cites a real `docs/adr/0065` elsewhere in this
codebase. This ADR is numbered 0077, the next free slot, and the issue text's own number is stale.
It also floats merging into "0064" if that ADR "ends up covering the whole mutation boundary" —
0064 is `split-daemon-provider-cgroups`, unrelated. The actual mutation-boundary ADR is
ADR-0075 (`mutation-authentication-and-superseding-0027`). This ADR's part 3 (below) narrows the
CLI-only boundary ADR-0075's own Context section describes (itself quoting ADR-0027, which it
supersedes) — SPEC.md's matching sentence is updated to say so; ADR-0075's own text is left as
written, since it is describing what ADR-0027 established at the time, not asserting an ongoing
constraint, and this repo's convention is for a later ADR to narrow a boundary by reference rather
than rewriting an earlier one's prose.

Like ADR-0076, this ADR is filled in part by part as `#308`'s slices land, rather than written once
ahead of the work.

## Decision

### Search reads the persisted snapshot, never live GitHub state

`#303`'s `project_issue_snapshots` table (ADR 0073) already stores, per project, every issue the
last successful poll returned — `kind` (`candidate`/`filtered`), `reasons`, `title`, `priority`, and
now (this slice) `labels`. The triage page reads only this table, via
`runStore.listProjectIssueSnapshots`, never `options.issuePollStatus` (the live in-process status
also available to `pages.ts`). Two reasons this is the deliberate choice, not an oversight:

- **One source, one shape.** `issuePollStatus` and the persisted snapshot normally agree — the
  daemon persists synchronously inside `persistProjectPollState`, right after each successful poll
  — so reading live buys no real freshness. Consistently reading persisted data means the page's
  snapshot-age display (see below) is meaningful for every result, not just the ones that happen to
  predate a restart.
- **AC3 is a persisted-snapshot problem by construction.** "A pre-restart snapshot is marked stale
  rather than shown as current" only makes sense against data that *can* predate the current
  process — `issuePollStatus` resets to empty on every daemon start, so it never carries pre-restart
  data to mark stale in the first place.

### The verdict is a pure transform over `kind` + `reasons`, not a recomputation

`evaluateProjectEligibility` (`src/issue-polling.ts`) already ran once, at poll time, against the
Project's own filter config, and its result is exactly what `kind`/`reasons` persist. Recomputing it
against live config for the triage page would let the page's verdict disagree with what the snapshot
row itself says — worse, not better, since the whole pitch of a snapshot-backed page is "what
Symphonika actually decided," not "what it would decide if asked again right now."

`describeIssueVerdict` (`src/issues/verdict.ts`) is a small, pure, DB-free function that turns a
snapshot row's `kind`/`reasons` into the issue text's own vocabulary: `eligible`; `filtered:
<label>` for an excluded label; `filtered: missing <label>` for a missing required label; `filtered:
state <state>` for the open/closed check; `blocked: sym:<x>` for an operational label that isn't a
claim; and `claimed by run <id>` specifically for `sym:claimed`/`sym:running`, when the caller can
resolve an actual Run id. Resolving that id is deliberately the caller's job (`pages.ts`, via
`runStore.listRuns({ project, issueNumber, limit: 1 })`) — a local Run Store read, not a GitHub call,
so it stays inside the "no GitHub Search API calls" constraint while keeping the verdict module
itself free of `RunStore` — a reason string alone can't tell candidate from filtered-for-cause, so
`kind` travels alongside it rather than being re-derived from an empty `reasons` array.

### This is not the same table as `/projects/:name`'s existing Issues section

`#303` already renders a per-project Issues table (`buildProjectIssueRow`,
`renderProjectIssuesTable`) joining the snapshot with the Project's live Runs — its `detail` column
is deliberately Run-state-rich (attempt count, cap status, tracked-PR state, retry ETA), because its
job is *ops status for one Project's queue*. `#308`'s triage page answers a narrower, different
question — *why is Symphonika not working this issue* — across every configured Project's repo, with
label add/remove attached. Folding them into one view would force the cross-project search table to
either drag in per-Run cap/retry detail it doesn't need, or force the single-Project ops view to lose
detail it depends on. They stay two views over overlapping data, not one.

### Label writes go through a new daemon-owned `GitHubIssuesApi` seam, not a second client

`writeIssueLabels` (`src/daemon.ts`, typed as `WriteIssueLabelsFn` in `src/http/app.ts`) is the only
mutation `pages.ts` performs against GitHub directly — every other `#307`/`#308` write goes through a
local file (`runSavePipeline`) or the Run Store. It reuses the exact `githubIssuesApi` instance the
poll tick already holds (so a test's injected mock API governs both polling and writes, one seam, not
two), resolves the Project's `tracker.token` via `resolveToken` (`src/lifecycle/token.ts` — a third,
already-existing implementation of the same `$VAR → env value` lookup issue-polling.ts's own
`resolveEnvBackedValue` and run-controller.ts's private `resolveTokenFromEnv` also carry; picked
because it's the one already public with the simplest signature, not because the duplication itself
is being cleaned up here — that's out of scope), and calls `tryAddLabelsToIssue` /
`tryRemoveLabelsFromIssue` (the latter added this slice, mirroring the former's existing shape in
`src/issue-polling.ts`) so a `GitHubIssuesApi` stub without label-write methods degrades to a named
error instead of a `TypeError`.

### Snapshot repository identity gates every label write

Issue and pull-request snapshot rows persist the GitHub owner/repo from the successful poll that
produced them. `writeIssueLabels` reads that identity for the requested subject and compares it,
case-insensitively, with the current Project tracker's owner/repo before resolving credentials or
calling the GitHub mutation API. A missing identity (including a row created before this migration)
or a mismatch is refused until a successful poll replaces the snapshot. This keeps the callback as
the uniform guard for single-issue, bulk, stale-claim, and pull-request label writes.

The alternative of clearing snapshots as soon as a tracker changes was rejected because ADR 0073
deliberately keeps last-good poll evidence when the next repository cannot be polled. Carrying the
identity only in HTML forms was also rejected: the JSON bulk endpoint has no form, and a
caller-supplied value would not bind the durable snapshot that makes the action available. Binding
the persisted snapshot itself preserves its diagnostic value while making stale actions fail
closed.

### `sym:*` is refused before `writeIssueLabels` is ever called, not inside it

The route handler (`handleIssueLabelWrite`, `src/http/pages.ts`) checks `isOrchestratorLabel` first
and short-circuits with a banner if the submitted label starts with `sym:` — `writeIssueLabels` is
never invoked for a refused label, verified directly in `tests/issue-triage-labels.test.ts` via a
call-count assertion. This is deliberately the single choke point: the daemon-side callback has no
equivalent check of its own, on the reasoning that `pages.ts` is its only caller and duplicating the
guard there would be exactly the kind of defensive layering with nothing to defend against that
`#307`'s own self-review already cut once (`getProjectWorkflowPath`'s unused `format`).

### A write's success or failure never changes what the page shows

`#308`'s AC: "a failed GitHub write surfaces as a failure, with the issue's displayed labels
unchanged." The label list on `/issues/:project/:number` is *always* read from the persisted
snapshot (`runStore.listProjectIssueSnapshots`), never from an in-memory optimistic update — so this
holds for a successful write too, not only a failed one, as a consequence of part 1's read-only-
snapshot design rather than a special case added for this AC. The success banner says so explicitly
("this page shows the last poll snapshot... won't reflect this until the next poll") so the operator
isn't left wondering why the label they just added isn't visible yet.

### Poll-now is a page-facing wrapper, offered not fired

`/api/poll-now` (`src/http/app.ts`) already existed as a JSON API for the CLI's `poll-now` command,
gated by `requireAuthorizedMutation` but returning `context.json(...)` — the wrong shape for a
browser form post. `POST /issues/poll-now` (`src/http/pages.ts`) is a thin page-facing wrapper that
calls the identical `options.pollNow` callback and renders the outcome as HTML instead. It is a
separate form the operator submits after seeing the write-success banner, never auto-submitted by
the label-write response itself — the AC says poll-now is *offered*, and firing it automatically
from a write handler would blur the two actions together and make a label write silently trigger
network activity the operator didn't ask for.

### "Updates the Run Store" resolves to the liveness gate, not a new claim record

`#308`'s AC: "Clear-stale-claim updates both the label and the Run Store, and is refused when a live
Run exists for that issue." Read as one sentence, not two independent obligations: the Run Store's
participation *is* the liveness check, not a separate mutation. There is no Run Store column or table
recording "this issue is claimed" as its own fact — ADR-0038 is explicit that the claim *is* label
state ("stale detection treats `sym:claimed` or `sym:running` as evidence of a claim"), and
`listActiveRunIds`/`listWaitingRunIds` derive live/parked status from `runs.state` at query time, not
from a persisted claim flag. A `claim_cleared_at`-style column was considered and rejected: nothing
would ever read it — no page, no query, no AC — which is exactly the Speculative Generality this
project's own review baseline flags (the same smell `#307` part 2 caught and cut from
`getProjectWorkflowPath`'s unused `format`). If a future slice needs an audit trail of manual clears,
that is its own slice with its own reader, not a column added speculatively now.

### The liveness check unions all three sources `detectStaleClaims` does, not the same instance

`findLiveRunIdForIssue` (`src/http/pages.ts`) checks `getActiveRuns()` (the in-process registry,
newly threaded onto `RegisterPagesOptions` this slice — it already existed on `HttpAppOptions` for
`/api/status`), `runStore.listActiveRunIds()`, and `runStore.listWaitingRunIds()`, in that order,
mirroring `collectLiveKeys` (`src/lifecycle/stale-claims.ts`) exactly. All three matter: a Run that is
`running` right now lives only in the in-process registry between DB writes; a `queued` or
`preparing_workspace` Run is a DB row with no registry entry yet; a parked `waiting` Run keeps
`sym:claimed` across the wait (ADR 0047) with neither. Checking only one source would let an operator
clear a claim out from under a Run in whichever state that source doesn't cover — the exact double
dispatch this action exists to prevent. This is a fresh implementation, not a shared call into
`collectLiveKeys` itself: that function is `async`, takes a `DetectStaleClaimsInput` bundling
`activeRuns`/`githubIssuesApi`/`pollStatus`/`projects`/`logger` the HTTP route has no reason to
assemble, and is walking every filtered issue in a poll tick rather than answering "is this one
(project, issue) pair live" — same three-source shape, different caller context, not the same
function with different plumbing.

### `runClearStale` (the CLI) is left as-is, not refactored to share this liveness check

`doctor.ts`'s `clear-stale` command predates this slice, reads config from disk itself, and calls
`GitHubApi.removeIssueLabel` — a different interface than `GitHubIssuesApi.removeLabelsFromIssue`
the polling/write path uses — and has no liveness check of its own today (a real, pre-existing gap
this UI action closes, not one it inherits). Unifying the two into one shared implementation would be
cross-cutting surgery on a working, unrelated CLI path for a slice that only asked for the web UI
action — the same call `#307` part 2 made for `validateWorkflowContractContent` vs.
`readWorkflowSnapshot`'s near-identical branch: a narrow, parallel implementation for the new caller,
with the duplication named here rather than justifying a refactor with no requesting caller.

### The action attempts all three labels, regardless of the snapshot subset

`STALE_CLEAR_LABELS` (`sym:stale`, `sym:claimed`, `sym:running`) mirrors `doctor.ts`'s own constant of
the same name and ADR-0038's rule that all three must go together (leaving `sym:claimed` or
`sym:running` behind would re-trigger `sym:stale` on the next poll). The button only renders when at
least one is present in the persisted poll snapshot, but the write always attempts the complete set
against live GitHub state. Narrowing the write to the snapshot subset can miss a label added after
that deliberately stale read. `OctokitGitHubIssuesApi.removeLabelsFromIssue` makes an already-absent
label idempotent by swallowing GitHub's absent-label 404 inside each loop iteration, so one missing
label does not prevent the remaining labels from being attempted; generic 404s and other failures
still surface honestly. This amends the original subset decision after issue #451 identified the
stale-read race.

## Consequences

- `project_issue_snapshots` gained a `labels` column (migrated via `ensureColumn`, like every other
  column added after the table's original shape). `body`/`url` were considered and left out: no
  acceptance criterion needs them (`#308`'s "free-text over title/body" line is in the *filters worth
  having* discussion, not the checklist), and persisting a full issue body for every open issue on
  every 30s poll is real write amplification for zero AC coverage. Search is title-only; this is a
  stated limit, not a silent one, alongside the page's other honest limits (open issues only, at most
  ~30s stale, scoped to configured Projects' repos).
- Part 1 is read-only: search, verdicts, snapshot-age display.
- Part 2 adds label add/remove (excluding `sym:*`, enforced server-side before `writeIssueLabels` is
  ever called) and a poll-now offer after a write, on a new per-issue page
  `GET /issues/:project/:number`.
- Part 3 adds clear-stale-claim, the one `sym:*` mutation the UI offers, gated by a three-source
  liveness check and reusing `writeIssueLabels` for the actual write (deliberately bypassing the
  generic route's `sym:*` refusal, since this handler is the one place that mutation is sanctioned).
  This closes `#308`: all 8 acceptance criteria. SPEC.md §14's closing sentence is updated — "label
  creation and workspace cleanup remain CLI-only; stale-claim reset no longer is" — while ADR-0075's
  own text is left unedited, per this ADR's Context section.
