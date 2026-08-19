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

### One shared gate for issue polling and PR polling

`daemon.ts` holds a single `githubBackoffUntilMs`, checked before both the issue-dependency poll and
the fire-and-forget PR poll inside `refreshIssuePollStatus`, and engaged from either one's errors via
`applyGithubBackoffState`. They draw on the same token's budget, so a rate-limit error from either
poll backs off both rather than leaving one free to keep hammering an already-exhausted budget.

### A clean poll result only ever lets the window lapse, never clears it early

`applyGithubBackoffState` engages or extends the window on a rate-limit error; it has no "clear on
success" branch. The window instead self-expires the first time `isGithubBackoffActive` is checked
after `nowMs` has passed it (logging the transition once there, lazily, rather than from whichever
poll happens to return clean first). The PR poll is fire-and-forget and not awaited by the issue poll,
so a PR poll that started before a window existed can still resolve cleanly after a later tick's issue
poll has engaged one; if a clean result were allowed to clear the window outright, that stale result
would erase a still-current one and undo the backoff the same tick it was engaged.

### A skipped tick leaves prior poll state untouched, but still reaches the tail of the function

While backing off, `refreshIssuePollStatus` skips calling
`pollConfiguredGitHubIssuesFromConfig`/`pollConfiguredGitHubPullRequestsFromConfig` at all --
`issuePollStatus` and the persisted per-project snapshots stay exactly as the last successful poll
left them, mirroring `pollProject`'s own "leave prior snapshot untouched" contract for a single
failed project. This is expressed as an `if (!isGithubBackoffActive(...))` around the polling work,
not an early `return`, so a backed-off tick still reaches the function's tail --
`issueRunNotifications.schedulePending()` in particular, which must keep running every tick (it is
itself a cheap, debounced no-op when nothing is pending) so a run that completes while backoff is
active doesn't wait out the rest of the window before its notification is scheduled. Config reload
(`reloadConfigAndRecordOutcome`) also runs unconditionally before the backoff check, so an
`interval_ms` edit or a corrected token takes effect promptly rather than waiting out the window.

### Manual "poll now" is gated the same as a timer tick

`triggerPollNow` queues the same `tick()` a timer-driven poll runs, and `tick()` has no signal to
tell the two apart. A rate-limited token has nothing to gain from an extra manual attempt during the
window, so this ADR accepts gating both identically rather than adding plumbing to distinguish them.

## Consequences

- `src/issue-polling.ts` exports `isRateLimitError`, `backoffUntil`, and
  `GITHUB_RATE_LIMIT_BACKOFF_MS`.
- No `symphonika.yml` schema change. `polling.interval_ms` (ADR 0036) is unaffected by this decision;
  operators configuring it well below the 30-second default should still account for other traffic
  (interactive `gh`/API usage, other automation) sharing the same token's budget.
- A poll-now request issued during an active backoff window returns whatever `issuePollStatus`
  already held rather than making a fresh attempt; it is not separately flagged as skipped in the
  response.

## Numbering

ADR `0081` (issue dependency gating and the dependency graph view) is the most recent number in tree;
this ADR is `0082`.
