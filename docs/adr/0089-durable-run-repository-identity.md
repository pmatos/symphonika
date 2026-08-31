# Runs persist the repository their Issue lived in, and run history is partitioned by it

ADR 0088 gave `resumeShutdownCancelledRuns` a repository-identity gate without adding columns: it
parsed `{owner, repo}` out of the persisted `IssueSnapshot`'s `url` and refused to act when that
disagreed with the Project's current tracker. That closed the write path but left the *selection*
path keyed on `(project_name, issue_number)` alone, and the parse ran per row **after** the
newest-Run elimination — so identity was consulted only on rows that had already survived a
comparison that could not see it.

The reachable sequence: Project `P` is retargeted from repository `A` to `B`, an Issue with the
same number is shutdown-cancelled in each, and the tracker later returns to `A`. `B`'s row is
newer, so the `not exists` subquery eliminates `A`'s. `listResumableShutdownRuns()` returns only
`B`'s row, the origin gate correctly refuses it, and `A`'s valid resumable row is never returned
at all. `A#42` keeps `sym:claimed` with no live Run and nothing that will ever resume it.

The failure is fail-safe — no wrong repository is written to, and `collectLiveKeys` keying on
name+number kept the Issue out of stale detection too, so the visible symptom was a warn line per
reconcile tick — but the recovery is manual (`symphonika clear-stale`, ADR 0038) and the walk's
position is lost. ADR 0088 deferred the fix explicitly, along with extending the identity gate to
`reconcileActiveRuns` and `detectStaleClaims`, because both needed durable columns.

## Decision

**Repository identity is a persisted property of a Run, not something re-derived from its
snapshot.** `runs` gains `issue_owner` and `issue_repo`, written at insert from the Issue's
`html_url` and backfilled once, in the column-add transaction, from `issue_snapshot_json` for
every pre-existing row.

### Null is "unknown", and unknown is one bucket

Either column being null means the origin was never determined — a test fixture, a non-GitHub
tracker, a row written before `url` was populated. Two rules follow, and they pull in opposite
directions on purpose:

- **For identity gates, unknown proves no mismatch.** A Run of undetermined origin is reconciled,
  resumed, and counted as live exactly as it was before this ADR. The gates only ever *refuse* on
  a positively determined disagreement, so no existing row becomes less recoverable than it was.
- **For the newest-Run relation, unknown is a single partition.** The subquery compares with `is`
  rather than `=`, so two unparseable rows share one history. Treating null as a value that
  matches nothing would split every legacy Issue's history into one partition per row and return
  all of them as resumable — resuming the same walk several times over. `lower()` wraps both sides
  because GitHub owners and repository names are case-insensitive, and it preserves the
  null-safety (`lower(null)` is null).

### The three gates ADR 0088 left open

- **`listResumableShutdownRuns`** partitions the newest-Run relation by
  `(project_name, issue_number, owner, repo)` and reads `issueRepository` from the columns. The
  post-hoc JSON parse is gone; `parseIssueRepository` survives only to serve the one-time backfill.
- **`reconcileActiveRuns`** skips an entry whose persisted repository disagrees with the Project's
  tracker. This is not cosmetic: a retargeted tracker makes `findPolledIssueSnapshot` miss (it
  keys on the tracker's repository), which sends `handleMissingFromPoll`'s `getIssue` to the *new*
  repository, and a same-numbered Issue that is closed or absent there cancels the Run with
  `closed_issue` on evidence from an Issue it never touched. Deferring costs nothing — either the
  tracker is restored or the Run reaches its own terminal state.
- **`detectStaleClaims`** keys liveness on `(Project, repository, Issue)` and writes `sym:stale`
  to the repository the Issue was **polled from** rather than to `project.tracker`. The write
  target matters for the duplicate-declaration case ADR 0088 already documents for the poll
  lookup: two Project declarations sharing a name both appear in the filtered band while
  `projectsByName` resolves to the last, so `project.tracker` would send the shadowed Issue's
  verdict to the surviving declaration's repository. The token still comes from the resolved
  config — the only place one is configured — and a token that cannot reach the polled repository
  fails the write and is logged, which is strictly better than marking the wrong Issue.

### Liveness has a wildcard, and it has to

`collectLiveKeys` draws from four sources, and only the three durable ones can name a repository.
`activeRuns.issueKeys()` cannot: `IssueReservationRegistry` is keyed by Project name and Issue
number, Routine Firings share it with synthetic numbers, and threading repository through
`reserveSlot`/`scheduleDelayed` would touch every dispatch path for no gain here. Those entries,
and durable rows whose origin is null, register a `(Project, Issue)` wildcard that vouches for the
number in **any** repository.

The asymmetry is deliberate and matches the null rule above. Over-covering leaves an Issue
unmarked for a tick; under-covering marks a live Issue `sym:stale`, which every Project's
`labels_none` then excludes from polling with nothing to clear it automatically — the permanent
strand of #594. "Unknown" therefore has to read as "live", never as "dead".

## Consequences

- The A→B→A retarget returns each repository's newest Run independently; `A`'s row surfaces and is
  resumed, `B`'s is refused by the origin gate as before.
- A retarget mid-Run can no longer cancel a live Run with `closed_issue` on the wrong repository's
  evidence.
- One `alter table` pair plus a single-pass backfill over `runs`, inside the existing migration
  transaction. Rows whose snapshot URL is not a GitHub issue URL stay null forever, which is the
  defined "unknown" answer rather than a gap to fill later.
- `listActiveRunIds` and `listWaitingRunIds` gained an `issueRepository` field. Both other callers
  (`src/smoke.ts`, `src/http/pages.ts`) spread or project these rows and are unaffected.

## Alternatives considered

**Partition in SQL with `json_extract` plus URL parsing.** No new columns, but SQLite has no regex,
so the owner/repo split becomes nested `substr`/`instr` inside a correlated subquery that runs per
candidate row — unreadable, unindexable, and it would still leave `reconcileActiveRuns` and
`detectStaleClaims` with a JSON parse each.

**Store a single `issue_repository` string.** One column instead of two, but every reader wants the
halves, so each would re-split on `/` — pushing the parse back to exactly where this ADR removes
it.

**Normalize the columns to lowercase on write.** Would drop the `lower()` from the subquery, but it
also destroys the casing operators see in logs and in the origin/tracker warn line, and it would
make the backfilled and freshly-written rows disagree with the `url` they came from.

**Thread repository through the in-memory reservation registry so liveness needs no wildcard.**
Touches every dispatch path and every Routine Firing's synthetic key to remove a fallback that is
correct on its own terms — an in-memory reservation genuinely is live, and the Project it belongs
to has exactly one tracker at that moment.

## Interaction with existing decisions

- **ADR 0088 (resume shutdown-cancelled Runs):** superseded on one point. Its "Extending the same
  identity gate to the sibling passes is deliberately out of scope here" and its rationale for
  parsing the snapshot instead of adding columns are both resolved here. Everything else it
  decides — the resume mechanism, `shutdown_resume_declined_at`, the fire-to-claim refcount,
  deferral as the default — is unchanged.
- **ADR 0077 (Issue triage and label writes):** its repository-identity principle now covers the
  daemon passes as well as `writeIssueLabels` and the snapshot-backed dashboard actions.
- **ADR 0038 (explicit stale-claim clearing):** unchanged, and needed less often — the strand this
  removes was one of the cases that required it.
- **ADR 0047 (poll-driven wait states):** `listWaitingRunIds` now carries repository identity, so a
  parked wait vouches for its own repository rather than for the number everywhere.

## Numbering

ADR `0088` is the most recent number in tree; this ADR is `0089`.
