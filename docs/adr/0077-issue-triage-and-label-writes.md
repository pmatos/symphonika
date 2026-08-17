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
ADR-0075 (`mutation-authentication-and-superseding-0027`), which this ADR amends instead.

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

## Consequences

- `project_issue_snapshots` gained a `labels` column (migrated via `ensureColumn`, like every other
  column added after the table's original shape). `body`/`url` were considered and left out: no
  acceptance criterion needs them (`#308`'s "free-text over title/body" line is in the *filters worth
  having* discussion, not the checklist), and persisting a full issue body for every open issue on
  every 30s poll is real write amplification for zero AC coverage. Search is title-only; this is a
  stated limit, not a silent one, alongside the page's other honest limits (open issues only, at most
  ~30s stale, scoped to configured Projects' repos).
- Part 1 (this ADR's first slice) is read-only: search, verdicts, snapshot-age display.
- Part 2 adds label add/remove (excluding `sym:*`, enforced server-side) and a poll-now offer after a
  write, on a new per-issue page `GET /issues/:project/:number`. Clear-stale-claim (the one `sym:*`
  mutation the UI offers, per ADR 0038) lands in part 3, along with amending ADR-0075/ADR-0027's
  "stale-claim reset remains CLI-only" line and SPEC.md's matching closing sentence in §14 — neither
  is amended yet, since it stays true until part 3 actually moves stale-claim clearing into the UI.
