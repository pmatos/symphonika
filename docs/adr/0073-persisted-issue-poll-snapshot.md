# Persisted Issue Poll Snapshot

Status: Accepted

## Context

`IssuePollStatus` (`src/issue-polling.ts`) is in-memory only: `emptyIssuePollStatus` /
`replaceIssuePollStatus` hold the current tick's `candidateIssues`, `filteredIssues`, and
per-project `projects` reports on the `daemon.ts` closure, discarded on every restart. `#302`
already persists a *summary* of each tick — `project_states.last_fetched_issues` /
`last_candidate_issues` / `last_filtered_issues` (counts) plus `last_poll_ok` / `last_poll_error` /
`last_poll_started_at` / `last_poll_finished_at` — via `RunStore.recordProjectPollOutcome`. That
summary is enough for the dashboard's Projects table, but not enough to render `#303`'s
`/projects/:name` issue-keyed table: the *individual* candidate and filtered issues (numbers,
titles, filter reasons) never survive a restart, so the page — and `#308`'s triage search, which
reads the same data — would render empty until the next successful poll.

`project_states` also has a precedent worth carrying forward: `syncProjectStates` derives from a
raw config parse (`readProjectStateInputs` in `daemon.ts`), not the validated runtime config, so a
Project that currently fails validation still gets a row. The issue-snapshot decision below checks
against that precedent explicitly, because Routine Hosts and invalid Projects are exactly the cases
`#302` got wrong the first time it read from the wrong source.

## Decision

### Storage: a new Run Store table, not a snapshot file

`project_issue_snapshots`, keyed `(project_name, issue_number)`:

```sql
create table if not exists project_issue_snapshots (
  project_name text not null,
  issue_number integer not null,
  kind text not null,          -- 'candidate' | 'filtered'
  title text not null,
  priority integer not null default 0,
  reasons text,                -- json array of filter reasons; null for 'candidate'
  issue_updated_at text,
  polled_at text not null,
  created_at text not null,
  updated_at text not null,
  primary key (project_name, issue_number)
);
```

This reuses the store every other piece of durable daemon state already lives in (`runs`,
`project_states`, `routines`), gets WAL durability and the existing backup/restore story for free,
and needs no new file format, path, or lock discipline. `#308`'s triage search reads the same
table through the same `RunStore` handle it already opens — a snapshot file would mean a second
persistence mechanism for the same data with independent staleness and atomicity semantics.

### Retention: replace-on-success, no incremental diff

`RunStore.replaceProjectIssueSnapshots({ projectName, polledAt, rows })` deletes every existing row
for `projectName` and inserts the tick's `candidateIssues` ∪ `filteredIssues` for that project in
one transaction. `daemon.ts` calls it from `persistProjectPollState`, alongside
`recordProjectPollOutcome`, **only when that project's poll succeeded this tick**
(`project.ok === true`) — mirroring `recordProjectPollOutcome`'s own per-project `ok` gate.

A poll failure (tracker error, unset token, transient GitHub error) leaves the previous snapshot
rows untouched. `PRODUCT.md` principle 4 ("evidence over reassurance") argues against silently
blanking the issue table just because one tick failed — the operator should see the last known
state plus the fact that polling is currently failing (`project_states.last_poll_ok` /
`last_poll_error`, already persisted by `#302`), not an empty table that reads as "no eligible
issues" when the truth is "we don't know right now."

Aging out falls out of this for free: a closed issue stops being returned by the tracker's
`state: "open"` query, so the next *successful* poll for that project no longer includes it in
either `candidateIssues` or `filteredIssues`, and the delete-then-insert drops its row. No
separate TTL, cron, or explicit "closed" state is needed — the replace itself is the aging
mechanism, exactly as `project_states`' own counters already work.

### Routine Hosts and invalid Projects: no special case needed

Routine Hosts never reach `pollProject` (`isRoutineHostProject` filters them out before issue
polling), so they simply never get rows here — matching `#303`'s "a Routine Host has no issues"
requirement without any extra logic. A Project that fails validation before a token/tracker check
never produces `candidateIssues`/`filteredIssues` for that tick either, so it falls under the same
"leave prior rows untouched" rule as any other poll failure — consistent with, but independent of,
`project_states`' "keep a row for an invalid Project" precedent (that one small table of counters
carries no per-issue data to preserve or lose).

### Staleness display: reuse `project_states`, not a new field

The capacity strip's "poll 28s ago" / "as of 3m ago, pre-restart" reads `project_states`'
`last_poll_finished_at` / `last_poll_ok` / `last_poll_error` (already persisted by `#302`) rather
than adding an age field to every snapshot row. "Pre-restart" is derived by comparing
`last_poll_finished_at` against the current process's `startedAtMs`: if the last successful poll
predates process start, the page has never actually polled since it came up and is showing
carried-over state.

### Row source: a join, not a query that requires both sides present

`/projects/:name`'s issue table is `project_issue_snapshots` for that project **left-joined** with
that project's `runs` on `issue_number` — not an inner join, and not two separately-rendered lists.
A Run's presence takes rendering precedence over a snapshot row (the issue has been claimed;
"eligible"/"filtered" no longer describes it). An issue closed since the last poll — a Run exists,
no snapshot row — still renders, because the join is keyed on `issue_number` from either side, not
filtered down to snapshot rows: it appears as **terminal**, driven entirely by the Run's own state
and `terminal_reason` / `state_transition_reason`. An issue with neither a Run nor a snapshot row
(never dispatched, closed since a since-lost poll, e.g. across a long outage) drops off the table —
there is nothing left to say about it, and reintroducing it would mean inventing state this store
never captured.

## Consequences

- `/projects/:name` and `#308`'s triage search render real data immediately after a daemon
  restart, using whatever the last successful poll captured, instead of blocking on the first new
  poll.
- One more table to keep in sync on every successful per-project poll tick; the write is a single
  delete + bulk insert inside a transaction, matching the cost profile `recordProjectPollOutcome`
  already pays per tick.
- The "closed issue with a Run but no snapshot row" case needs no special-case code path — it's the
  natural shape of a left join — but it does mean the issue table's completeness is bounded by
  whichever Runs the Run Store still has, same as every other Run-keyed surface in this app.
- A Project whose poll has been failing for a long time (misconfigured token, revoked GitHub
  access) keeps showing its last-known issue snapshot indefinitely, correctly flagged via
  `last_poll_ok = false` — this is a deliberate "don't erase evidence" choice, not an oversight; an
  operator who wants a firm answer on "is this actually still eligible" needs a working poll, which
  `last_poll_error` on the same strip already tells them to go fix.
