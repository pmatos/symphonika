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

## Consequences

- `project_issue_snapshots` gained a `labels` column (migrated via `ensureColumn`, like every other
  column added after the table's original shape). `body`/`url` were considered and left out: no
  acceptance criterion needs them (`#308`'s "free-text over title/body" line is in the *filters worth
  having* discussion, not the checklist), and persisting a full issue body for every open issue on
  every 30s poll is real write amplification for zero AC coverage. Search is title-only; this is a
  stated limit, not a silent one, alongside the page's other honest limits (open issues only, at most
  ~30s stale, scoped to configured Projects' repos).
- This first slice is read-only: search, verdicts, snapshot-age display. Label writes and
  clear-stale-claim land in later slices of this same ADR.
