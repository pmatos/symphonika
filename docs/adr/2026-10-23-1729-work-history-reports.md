# Work history reports: UTC half-open ranges, event-time attribution, recomputed on request

Status: Accepted

## Context

The first #868 slice added an evidence-linked work briefing: what to do next, from the current
classification. The second slice answers "what happened over the last week or month?" for all Projects
and per Project, over a rolling 7 or 30 days or an explicit date range. Three questions have to be
settled once, because every surface (the HTML reports, Maestro's `get_work_history` tool, and any
later consumer) must agree on them: what a time range means, which timestamp an action is attributed
to, and what "revisiting" a report means. A fourth, the Maestro read-only boundary
(ADR-2026-10-07-0813, snapshot-backed rule), decides how past chat may appear in a report.

## Decision

**Times are UTC and ranges are half-open `[from, to)`.** An event exactly at `from` is in the range and
one exactly at `to` is not, so adjacent ranges never double-count a boundary event. Bounds are compared
as normalized ISO-8601 strings (`Date#toISOString`, millisecond precision, `Z`), the format every event
column is written in; an un-normalized bound would sort wrongly against a stored `...:00.000Z` value. A
bound is a `YYYY-MM-DD` date (that day's UTC midnight, so `from=2026-10-01&to=2026-10-08` is exactly seven
days) or an ISO-8601 time ending in `Z` or carrying an explicit offset. A time with no zone is refused,
because JavaScript would silently read it as server-local time; an impossible calendar date is refused
rather than rolled over.

**A rolling window of N days is the request time minus N x 24 hours, up to the request time.** Only 7d and
30d are named windows. With no parameters a report is the rolling last 7 days. A rolling request prints the
`from`/`to` it resolved to, as a permalink, so the same range can be requested again exactly.

**Invalid input is a readable 400, never a guess:** an inverted or empty range, a lone `from` or `to`, a
`window` combined with `from`/`to`, an unknown window, a malformed or impossible date, and a range longer
than 366 days (the report is a row scan over its range, so one request must not read all history). An
unknown Project is a 404, and it wins over an invalid range. The tool refuses with the same reason text.

**Actions are attributed to the time of the event itself, never to `createdAt`.** A Run is attributed to the
time of each terminal state transition (`run_state_transitions`, via `listRunCompletionsBetween`), so a
Run created weeks ago and finished inside the range is in the range and a Run created inside it that is
still running is not. A tracked pull request that ended is attributed to
`tracked_pull_requests.last_observed_at` (`updated_at` is also bumped by review dispatches and re-owner
writes after a PR has ended, so it would drift a merged PR into later windows). That is the time Symphonika
last observed the merged/closed state, not GitHub's own merge time, and the report labels it that way.
A merge attempt is attributed to `pull_request_merge_attempts.attempted_at`.

**Reports are recomputed on each request; nothing is persisted.** There is no history table. A report is
"revisited" by requesting the same explicit `from`/`to` again, which yields the same recorded events for a
closed range. This keeps a report from becoming a second copy of execution evidence that could disagree
with the Run Store, and means no write path exists for a report.

**A report keeps three kinds of statement apart and labelled.**

1. *Completed work and ended without success* are recorded execution evidence: succeeded Runs, merged
   tracked pull requests and successful merge attempts, versus failed, blocked, stale, cancelled or
   input-required Runs, closed pull requests and failed merge attempts. A failed outcome is never folded
   into "completed".
2. *Current GitHub observations* are the latest persisted poll state, not events inside the range: open
   tracked pull requests and merged pull requests seen only in a poll, each with its Project's poll
   freshness (`poll_failed`, `stale`, `pre_restart`, `never_polled`, from the same logic as the briefing).
   A merged pull request with no tracked event time is shown as *observed* with its poll time and is never
   counted as completed.
3. *Maestro suggestions* are past assistant replies in the range, from `maestro_messages`.

Every item links the Project, Run, Issue and pull request evidence it rests on. The Issue and PR pages
render only from a current poll snapshot, so a report links them only when a snapshot exists and otherwise
names the Issue or PR in plain text, rather than emitting a link that returns 404.

**Past Maestro chat appears on the HTML report only, structurally apart from the evidence.** The
computation that builds sections 1 and 2 (`buildWorkHistory`) never reads a `maestro_*` table. The page calls
a separate function (`listMaestroSuggestions`), renders its rows in their own section labelled as
suggestions and not evidence, escapes them, attaches no links or citations to them, and shows only that
Project's own conversation on a Project report. `get_work_history` does not return them at all: feeding a
model's earlier prose back to it as tool output would let a chat claim return as a tool-returned
"evidence" record, which is exactly the laundering ADR-2026-10-07-0813 forbids. Reading chat for an
operator-facing page does not weaken that boundary: it adds no tool, mutates nothing, and the model-facing
`MaestroEvidenceReader` still has no way to read a chat table.

## Consequences

- The first #868 slice's briefing is unchanged; history is a separate report and there is no rolling
  7/30-day briefing.
- A tracked pull request observed as merged more than once is attributed to its latest observation. The PR
  follow-up loop reads only open tracked pull requests, so it stops observing a PR once it ends, but another
  writer (the `merge_pr` action in the run controller) can record a later observation, which would move the
  attributed time. The time is therefore "last observed in that state", as the report says.
- `run_state_transitions` gained a `created_at` index so a range query does not scan the whole table.
- The merge-attempt history that #309 deliberately left unsurfaced (`listPullRequestMergeAttempts`) is now
  reachable as a range read, but only inside the history report.
- A truncated section (the page's 200 rows, the tool's 15) states how many items it omitted; it never
  claims the omitted rows do not exist.
