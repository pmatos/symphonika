# Record Claim-Verified Routine Pull Requests

Status: Accepted

Amends: ADR-2026-09-11-1001 (Direct-URL Verification for Routine Outcome Claims), one Consequences point.

## Context

ADR-2026-09-11-1001 verifies a routine outcome claim by looking its `url` up directly, so a PR opened from a branch other than the firing's own (the `pm-deepen/<slug>` fallback, issue #748) is no longer discarded by ADR 0068 rule 4. It deliberately left `routine_pull_requests` branch-scoped only, recording a divergence: the firing's canonical outcome says `pr` (verified) while its `pullRequests` list stays empty, because "populating that table would require deciding its `headSha` semantics for a PR Symphonika's own branch never produced."

Every surface except the fan-out summary — which #898 already rendered from the verified outcome — read that row table, so none of them saw a cross-branch PR.

## Decision

When `verifyRoutineOutcomeClaimUrl` confirms a `pr` claim, record the confirmed pull request into `routine_pull_requests` from the observation's assess step (`recordClaimVerifiedPullRequest`, `src/routines/github-observation.ts`), under the same contract branch-scoped recording already follows:

- Informational only: the row never enters PR Follow-up, review re-dispatch, or auto-merge (those read `tracked_pull_requests`).
- Open-only: a PR already closed or merged when the confirming GET runs is not recorded; the fan-out summary's verified-outcome rendering (#898) remains the renderer for that case.
- `head_sha` semantics — the question 1001 deferred: the PR's own observed head sha from the same GET, the same "the head this PR carried when observed" meaning branch-scoped rows carry, for a head branch the firing never produced.
- Deduplicated by the store's upsert on `(project_name, routine_name, firing_id, pr_number)`; a PR the branch-scoped pass already recorded is re-written with the same values, except `head_sha`, which refreshes to the confirming GET's observation if the PR's head moved in between.
- Guarded like fallback discovery: the recording runs after awaited network I/O, so it re-checks the firing is still `running` and abandons with a warning rather than recording onto a firing whose outcome has already been reported.

## Consequences

- All `routine_pull_requests` consumers — firing detail page, CLI status, per-firing notification, fan-out summaries and counts — see a claim-verified cross-branch PR without per-surface rendering fixes.
- The divergence 1001 recorded is closed for PRs still open at verification; a PR that already closed keeps #898's fan-out rendering as its only surface.
- A confirmed claim naming a pre-existing PR (1001's noted hallucination window) now also produces a row. Acceptable: the table is informational, and the canonical outcome, not the row, drives reconciliation and retention.
