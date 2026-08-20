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

### Concurrent enrichment workers stop starting new calls once a sibling hits a rate limit

The above closes the cross-tick gap (a rate limit is now detected and backs off the *next* tick), but
`pollProjectPullRequests` enriches a project's PR list with `PULL_REQUEST_ENRICHMENT_CONCURRENCY` (4)
concurrent workers pulling from a shared queue (`mapWithConcurrency`). Without any coordination between
them, one worker's PR hitting a rate limit doesn't stop its siblings from continuing to pull the next
PR off the queue and firing more GraphQL calls -- for a project with many open PRs, a rate limit
detected early in the list still let the remaining workers drain most of the list before
`pollProjectPullRequests` returned and the caller could react, all within the *same* tick.

`pollProjectPullRequests` now holds a `let enrichmentRateLimited = false` flag shared (via closure)
across the batch; the wrapper passed to `mapWithConcurrency` sets it the moment any worker's
`buildSnapshot` call returns an `enrichmentError`. `buildSnapshot` itself takes an
`isEnrichmentRateLimited` callback and checks it -- after the free cache-hit path, before the GraphQL
call -- returning the cheap REST-only snapshot unenriched (`stateAvailable: false`) instead of placing
another call. This only stops *new* calls from starting; a call already in flight when the flag flips
still completes (there's no way to abort a request already sent), and every PR still gets a row per the
existing "must not drop the row" contract -- only some of them go unenriched for that tick.

### Sequential issue-project polling stops on a shared token within the same tick

The daemon's window-scoped `githubBackoffUntilByToken` map cannot stop a later Project in the issue
poll's sequential loop: the map is engaged only after `pollConfiguredGitHubIssuesFromConfig`
returns its whole batch of reports. The poll function therefore owns a second, tick-local
`Set<string>` of resolved tokens. After one Project reports a rate-limit-shaped error, later
Projects resolving to that token are skipped for the remainder of that call; Projects on other
tokens continue normally. The set is discarded when the call returns, while the daemon still uses
the first Project's report to engage the longer-lived backoff window for future ticks.

An intra-tick skipped Project produces no fresh report. `refreshIssuePollStatus` consequently
derives the set of actually polled Project identities from `nextStatus.projects`, not from the
larger tick-start-pollable input list. Identity is the Project name plus its case-insensitive GitHub
owner/repository, matching ADR 0077's snapshot provenance boundary; name alone would conflate two
declarations with the same name and drop the later, skipped repository's prior status.
Persisted project state and issue snapshots remain name-keyed, so fresh reports replace them only
when their repository is the last declaration selected by the runtime name lookup. A shadowed first
declaration that rate-limits therefore cannot invalidate the selected declaration's carried-over
state while the selected declaration is skipped.
`mergeIssuePollStatus` uses those identities to carry the skipped Project's prior in-memory status
forward. Before exposing the merged candidates to dispatch, it also filters both carried-over and
fresh candidates against the same last-declaration-wins identity map. Repository-specific reports
and filtered diagnostics remain available, but an Issue from a shadowed repository cannot be
dispatched through the selected declaration's token and Workspace.

Poll-outcome and issue-snapshot persistence already iterate only fresh reports. The raw-config
`syncProjectStates` pass still has to run for every tick so removal, mode, and weight changes remain
visible, but a schema-valid Project with no report is not automatically proof of recovery:
`readProjectStateInputs` preserves its prior validation result when that exact identity was skipped
by backoff. Config-validation errors continue to take precedence, and disabled/removed declarations
are not classified as backoff skips.

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

A project excluded from a tick's pollable subset keeps its `issuePollStatus` entries, persisted poll
outcome, issue snapshot, and validation result exactly as the last attempted poll produced them,
mirroring `pollProject`'s own "leave prior snapshot untouched" contract for a single failed project.
`mergeIssuePollStatus` (`src/issue-polling.ts`) carries a skipped project's entries forward into the
in-memory status instead of a bare replace. `persistProjectPollState` reconciles raw config metadata
but retains skipped validation evidence; its poll-outcome and issue-snapshot loops, and
`persistProjectPullRequestPollState`, remain per-project writes that never receive a skipped report.
Config reload (`reloadConfigAndRecordOutcome`) runs unconditionally before partitioning, so an
`interval_ms` edit or a corrected token takes effect promptly rather than waiting out any project's
window. `issueRunNotifications.schedulePending()` at the function's tail also always runs,
independent of partitioning, so a run that completes while some (or all) projects are backing off
doesn't wait out the window before its notification is scheduled.

### Fresh dispatch filters carried-over candidates by active token backoff

The full `issuePollStatus` remains the operator-facing last-known snapshot while a Project is
backing off, including its candidate issues. Fresh dispatch derives a separate candidate view at
the daemon boundary and excludes every Project whose resolved token is still in
`githubBackoffUntilByToken` before calling `dispatchOneFresh`. This keeps snapshot/status continuity
without allowing a carried-over candidate to reach the `sym:claimed` REST write during an active
window. Projects using other tokens remain dispatchable.

That candidate filter is an early admission check, not the claim-boundary guarantee. The PR poll is
fire-and-forget, so it can report a rate limit and engage backoff while `dispatchOneFresh` is still
loading Project, provider, concurrency, or Workflow Contract state for a candidate that passed the
filter. The daemon therefore also passes a synchronous `isClaimAllowed` predicate into
`dispatchOneFresh`; the Run Controller evaluates it inside the narrowed claim section after its
other awaited re-checks and immediately before the `sym:claimed` label call. The deterministic
provider-resolution failure path performs the same final check before its own fresh-claim write.

GitHub's REST and GraphQL primary budgets are separate, so this gate is conservative when GraphQL
primary exhaustion alone engaged the window. It is still required for secondary/abuse-detection
limits, which apply across both API surfaces for the credential; the daemon intentionally treats
the established per-token window as the admission rule rather than trying to infer which budget
produced a message-shaped rate-limit error.

### Carry-over is limited to still-enabled configured projects, and preserves their own errors

`mergeIssuePollStatus` takes both `polledProjectKeys` (this tick's attempted Project identities) and
`configuredProjectKeys` (every enabled Project identity in the just-reloaded config, pollable or
not) and only carries a prior project's entries forward when that identity is in
`configuredProjectKeys` but not in `polledProjectKeys` -- i.e. it remains enabled and was
specifically skipped for backoff. Repository identity is part of each key, so one attempted
declaration cannot mark a same-name declaration for another repository as polled. A Project a
config reload disables, removes, renames, or retargets satisfies neither set once the new snapshot
is active, so its stale candidates/filtered-issues/report are dropped on the very next tick instead
of persisting in `/api/status`, poll-now summaries, and CLI/smoke output indefinitely. Disabled
Projects still retain their last persisted per-Project issue snapshot as historical operator
evidence; this rule only prevents that evidence from masquerading as current in-memory polling
status.

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

### PR Follow-up uses the same token window

The daemon's separate PR Follow-up loop also draws from the configured tracker token through branch
discovery, tracked-PR state, and merge calls. `runPullRequestFollowup` therefore receives two narrow
hooks from the daemon: a project-level call gate and a rate-limit reporter. The gate is checked before
each project's discovery or tracked-PR sequence and again before a merge call, because another
GitHub subsystem can engage backoff while the preceding state request is in flight. A
rate-limit-shaped failure at any GitHub catch boundary reports the owning Project immediately; the
daemon resolves that Project back to its token and engages or extends the same
`githubBackoffUntilByToken` entry used by issue and repository-wide PR polling.

The gate remains dynamic within one follow-up pass. If one Project hits a limit, later work sharing
its token is skipped immediately instead of waiting for the next daemon tick, while Projects using a
different token can continue. Ordinary non-rate-limit observation failures retain PR Follow-up's
existing best-effort behavior and do not engage the window.

## Consequences

- `src/issue-polling.ts` exports `isRateLimitError`, `backoffUntil`, `GITHUB_RATE_LIMIT_BACKOFF_MS`,
  `rateLimitedTokens`, `projectPollIdentityKey`, and `mergeIssuePollStatus` (taking configured and
  attempted Project-identity sets).
- Same-tick issue polling also keys its short-lived suppression set by the resolved token, so two
  different `$VAR_NAME` references resolving to the same credential share one limit.
- PR Follow-up discovery, tracked-state, and merge calls are gated by the same per-token window and
  report their own rate-limit failures back to the daemon without persisting credentials.
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
- Fresh dispatch does not claim a carried-over candidate whose token is backing off; candidates on
  other tokens remain eligible for dispatch. If asynchronous PR polling activates backoff after
  candidate filtering, the claim-boundary re-check still defers the write.

## Numbering

ADR `0081` (issue dependency gating and the dependency graph view) was the most recent number when
this ADR was drafted; `0082` (dependency drift does not revoke FSM-owned Continuation Eligibility)
landed on `main` concurrently and claimed that number first, so this ADR is `0083`.
