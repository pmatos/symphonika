# GitHub Polling Rate-Limit Backoff

Status: Accepted

## Context

On 2026-08-19 the daemon's issue-dependency GraphQL polling failed across every tracked project at
once with GitHub's "API rate limit already exceeded" error. `polling.interval_ms` in a live
deployment was configured well below ADR 0036's 30-second default, and every tick swept every
enabled project's GraphQL dependency-check (`fetchIssueDependencies`) plus a separate fire-and-forget
PR poll (`pollConfiguredGitHubPullRequestsFromConfig`) -- both drawing on the same configured
`GITHUB_TOKEN`'s hourly GraphQL budget an interactive `gh` CLI session under the same token also
draws from. There was no backoff: once the budget was exhausted, `refreshIssuePollStatus` retried the
identical expensive call on the very next tick, so the outage tended to persist rather than recover on
its own once the hourly window reset.

## Decision

### Message-based rate-limit detection, not error shape

`isRateLimitError` (`src/issue-polling.ts`) matches `/rate limit|abuse detection/i` against a
rendered error message. REST and GraphQL clients surface GitHub's primary (hourly budget) and
secondary (abuse-detection/rapid-request) rate limits as message text rather than a common
`status`/`type` field the way `isOctokitNotFound` can key off `status === 404`, and the only place a
poll failure is visible to the daemon is already the wrapped string in `IssuePollStatus.errors` /
`PullRequestPollStatus.errors` (e.g. `pollProject`'s `"... issue dependencies could not be checked:
${errorMessage(error)}"`). A test locks the exact wrapped shape so a future reformat of that message
can't silently disable backoff.

### A fixed backoff window, not exponential

`backoffUntil`/`GITHUB_RATE_LIMIT_BACKOFF_MS` add a flat 5 minutes from the time a rate-limit error is
observed, unlike ADR 0020's exponential provider-retry policy. GitHub's primary limit resets on a
fixed hourly clock that doubling delays can't influence either way; the window's only job is to stop
the daemon from flailing against an already-exhausted budget (and tripping the secondary/abuse limit
in the process) between resets, not to time the reset itself.

### A per-PR enrichment failure still counts toward detection, even though the row is kept

`pollProjectPullRequests` lists a project's open PRs, then enriches each one individually
(`buildSnapshot`) with Symphonika's own Pull Request State -- a second GraphQL round-trip per PR. A
single PR's enrichment failing must not drop that PR's row (#259: an orphaned PR whose state can't be
fetched is exactly the case AC4 needs visible), so `buildSnapshot` has always swallowed enrichment
errors and returned the row with `stateAvailable: false`. Left alone, that swallowing also hid a
rate-limited enrichment call from the project-level report `pollProjectPullRequests` returns (which
listed the PRs fine, so it reported `ok: true` with no `error`) -- `rateLimitedTokens` never saw it,
backoff never engaged, and every subsequent tick repeated the same GraphQL calls against an
already-exhausted budget, for what is normally the larger share of a tick's GraphQL volume (one
follow-up call per open PR, vs. one dependency check per project).

`buildSnapshot` now also returns an `enrichmentError` alongside the (always-kept) snapshot when the
underlying failure is rate-limit-shaped (per `isRateLimitError`); `pollProjectPullRequests` surfaces
the first one it sees as `error` on that project's `ProjectPullRequestPollReport`, and also pushes it
onto `status.errors`. This produces a new report shape -- `ok: true` alongside a populated `error` --
that means "the project polled successfully overall, but a rate limit was hit during enrichment,"
distinct from the existing `ok: false` shape used for a project the poll couldn't process at all
(token unresolved, PR list itself failed). Both consumers that read `.error` were checked against
this: `persistProjectPullRequestPollState` (`daemon.ts`) gates persistence on `.ok`, not `.error`, so
the fetched rows still persist; `rateLimitedTokens` (`src/issue-polling.ts`) no longer short-circuits
on `report.ok` being true, specifically so this shape is still detected.

### Backoff is keyed by resolved GitHub token, not global

`daemon.ts` holds `githubBackoffUntilByToken: Map<string, number>`, keyed by the token
`resolveEnvBackedValue` resolves for a project's `tracker.token` -- not a single process-wide scalar.
SPEC.md §6 lets each project's tracker reference an independent `$VAR_NAME`, and GitHub tracks
rate-limit budgets per token, so a rate limit on one project's credential must not suppress polling
for a project on a different one. `rateLimitedTokens` (`src/issue-polling.ts`) maps each rate-limited
project's poll report back to its resolved token; `engageGithubBackoff` (`daemon.ts`) engages the
window for every token that function returns. The map's values are only ever used as opaque keys and
never logged -- the resolved token is a secret (SPEC.md §6's redaction requirement).

### A clean poll result only ever lets a token's window lapse, never clears it early

`engageGithubBackoff` engages or extends a token's window on a rate-limit error; there is no "clear on
success" path for any token. A window instead self-expires the first time `isGithubBackoffActive` is
checked for that token after `nowMs` has passed it (logging the transition once there, lazily, rather
than from whichever poll happens to return clean first). The PR poll is fire-and-forget and not
awaited by the issue poll, so a PR poll that started before a window existed can still resolve cleanly
after a later tick's issue poll has engaged one for the same token; if a clean result were allowed to
clear the window outright, that stale result would erase a still-current one and undo the backoff the
same tick it was engaged.

### Each tick partitions projects into pollable and currently-backed-off, and polls the pollable subset

`partitionProjectsForPolling` filters the configured projects down to those whose resolved token isn't
currently backing off; `refreshIssuePollStatus` polls only that subset (for both issues and PRs,
re-partitioned before the PR poll so a token the issue poll just engaged is excluded from the same
tick's PR poll too). The issue poll is still called even when the pollable subset is empty -- an
empty `config.projects` loop is a cheap no-op, and `persistProjectPollState` afterward must run every
tick regardless of how many projects were actually polled, since it also derives `projectModes` (the
Routine Host dashboard state) from the full config file, independent of GitHub polling. The PR poll,
which has no such side effect, is skipped outright when nothing is pollable.

A project excluded from a tick's pollable subset keeps its `issuePollStatus` entries and persisted
snapshot exactly as the last successful poll produced them, mirroring `pollProject`'s own "leave prior
snapshot untouched" contract for a single failed project -- `mergeIssuePollStatus`
(`src/issue-polling.ts`) carries a skipped project's entries forward into the in-memory status instead
of a bare replace, while `persistProjectPollState`/`persistProjectPullRequestPollState` naturally
leave a skipped project's DB rows untouched since both already write per-project rather than doing a
destructive full-project-list sync. Config reload (`reloadConfigAndRecordOutcome`) runs unconditionally
before partitioning, so an `interval_ms` edit or a corrected token takes effect promptly rather than
waiting out any project's window. `issueRunNotifications.schedulePending()` at the function's tail
also always runs, independent of partitioning, so a run that completes while some (or all) projects
are backing off doesn't wait out the window before its notification is scheduled.

### Carry-over is limited to still-configured projects, and preserves their own errors

`mergeIssuePollStatus` takes both `polledProjectNames` (this tick's pollable subset) and
`configuredProjectNames` (every project in the just-reloaded config, pollable or not) and only carries
a prior project's entries forward when that project is in `configuredProjectNames` but not in
`polledProjectNames` -- i.e. it still exists in config and was specifically skipped for backoff. A
project a config reload removes or renames satisfies neither set once its old name is
gone, so its stale candidates/filtered-issues/report are dropped on the very next tick instead of
persisting in `/api/status`, poll-now summaries, and CLI/smoke output indefinitely.

The merge also no longer does a bare `errors: fresh.errors` replace. `fresh.errors` only ever reflects
the projects actually polled this tick, so a carried-over (backed-off) project's own rate-limit
message -- recorded on its carried-over `ProjectIssuePollReport.error` -- is concatenated back in.
Without this, the first *other* project to poll clean on the same tick would wipe a still-backed-off
project's error from `issuePollStatus.errors` and the daemon's "polling errors cleared" log line, even
though that project never got a chance to recover.

### Manual "poll now" is gated the same as a timer tick

`triggerPollNow` queues the same `tick()` a timer-driven poll runs, and `tick()` has no signal to
tell the two apart. A rate-limited token has nothing to gain from an extra manual attempt during the
window, so this ADR accepts gating both identically rather than adding plumbing to distinguish them.

## Consequences

- `src/issue-polling.ts` exports `isRateLimitError`, `backoffUntil`, `GITHUB_RATE_LIMIT_BACKOFF_MS`,
  `rateLimitedTokens`, and `mergeIssuePollStatus` (now taking a `configuredProjectNames` parameter in
  addition to `polledProjectNames`).
- A `PullRequestPollStatus.projects` entry can now be `ok: true` with a populated `error` -- "polled
  successfully, but enrichment hit a rate limit" -- distinct from the pre-existing `ok: false` shape
  for a project the poll couldn't process at all. Any future reader of that field must not assume
  `error` implies `ok: false`.
- No `symphonika.yml` schema change. `polling.interval_ms` (ADR 0036) is unaffected by this decision;
  operators configuring it well below the 30-second default should still account for other traffic
  (interactive `gh`/API usage, other automation) sharing a project's token's budget.
- A poll-now request issued while every configured project is backing off returns whatever
  `issuePollStatus` already held rather than making a fresh attempt; it is not separately flagged as
  skipped in the response. A poll-now request while only *some* projects are backing off still polls
  the rest.

## Numbering

ADR `0081` (issue dependency gating and the dependency graph view) is the most recent number in tree;
this ADR is `0082`.
