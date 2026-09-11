# Direct-URL Verification for Routine Outcome Claims

Status: Accepted

Amends: ADR 0068 (Structured Routine Outcomes), rules 2 and 4.

## Context

ADR 0068's `reconcileRoutineOutcome` verifies a claimed `pr` / `issue_opened` / `issue_closed`
action against a branch-scoped before/after GitHub diff (`diffRoutineGithubSnapshots`), fed from
`captureRoutineGithubSnapshot` / `listPullRequestsForBranch`. That diff only ever matches a pull
request whose `head.ref` equals the firing's own deterministic branch name
(`isPullRequestForBranch`, `isOpenPullRequestForBranch`).

In production, `forseti/refactor-audit` delegates to the `pm-deepen` skill, whose branch-adoption
step falls back to its own `pm-deepen/<slug>` branch when Symphonika's deterministic firing branch
already carries an upstream tracking ref. The skill's own prompt template documents this: branch-scoped
PR discovery will not find its PR, and the final claim is the only record of what happened.

Because the diff never observes a PR opened from a different branch, `observedAction` stays `null`
even though the claim is completely correct. Rule 4 then treats the claim as an *unconfirmed*
external action and overrides it with the synthetic `"Commit retained in the Routine Firing
workspace"` outcome, discarding a real, verifiable URL, title, and summary. Two `forseti`
firings (2026-09-03, PR #267; 2026-09-10, PR #275) hit this exact path; `pewpew/refactor-audit`,
whose adopted branch happened to match the firing branch, was unaffected. See issue #748 for full
evidence.

## Decision

Add a second, independent evidence source for `observedAction`: when the branch-scoped diff does not
already confirm the claim's own action, look the claim's `url` up directly against the Project's
configured repository before rule 4 gets to discard it.

- `parseGithubClaimUrl(url, owner, repo)` (`src/routines/outcome.ts`) is a pure parser that accepts
  only a `https://github.com/<owner>/<repo>/(pull|issues)/<number>` URL matching the firing
  Project's own configured `owner`/`repo` (case-insensitively). Any other host, repository, or path
  shape returns `null` — a claim can never trigger a lookup against an unrelated repository.
- `verifyRoutineOutcomeClaimUrl` (`src/routines/dispatcher.ts`) resolves that reference with one
  direct GitHub read: `GitHubIssuesApi.getPullRequest` (new; REST `pulls.get`) for a `pr` claim, or
  the existing `getIssue` for `issue_opened` / `issue_closed`. A `pr` claim is confirmed by the pull
  request's mere existence, matching the existing branch-scoped diff's own bar. An `issue_closed`
  claim additionally requires the issue's current `state` to be `closed`, so a claim of "closed" for
  an issue that's actually still open is refuted, not rubber-stamped. Any lookup failure (network
  error, 404, disabled API method, missing tracker/token) returns `null` — the caller's existing
  branch-scoped evidence and rule 4 fallback are unchanged.
- The dispatcher only performs this second check when it's needed: `githubObservation.action?.action
  !== claim?.action`, `outcome.kind === "succeeded"` (rule 4's own precondition — a failed or
  cancelled firing can never reach rule 4), `input.routine.kind === "git"` (a `kind: report` routine
  never observes pull requests, so its claim must not be confirmed by looking up an unrelated PR by
  number), and `claim.status !== "error"` (an error-status claim falls through to the existing
  git-evidence override regardless, so its own title/summary were never going to be trusted here).
  The result is merged as
  `observedAction: claimUrlVerification ?? githubObservation.action` before calling
  `reconcileRoutineOutcome`.
- `reconcileRoutineOutcome` itself is unchanged. Feeding a confirmed action into the same
  `observedAction` input rule 2 and rule 4 already read is sufficient: rule 2 already verifies a
  claim whose action matches `observedAction`, and rule 4 already only overrides when
  `observedAction` doesn't match. The bug was that `observedAction` was too narrow an evidence
  source, not that the reconciliation rules were wrong.
- Scope: only the success path (`runRoutineFiring`'s `try` block) performs URL verification. The
  `catch` block's failed/cancelled terminal states can never satisfy rule 4's
  `terminalState === "succeeded"` precondition, so extending verification there would add I/O and
  cancellation-race surface for no reachable behavior change.

## Consequences

- A claim naming a real PR or issue on the Project's own repository is now verified even when the
  Coding Agent (or a skill it delegates to) opens it from a branch other than Symphonika's
  deterministic firing branch, without depending on any skill adopting that branch. This is
  provider-neutral: it reads the claim's own `url`, not provider-specific output.
- `routine_pull_requests` (the tracked-PR table used for firing-detail display) remains
  branch-scoped only; this change does not populate it for an off-branch PR. A firing's canonical
  outcome and its `pullRequests` list can therefore now diverge (outcome verified, PR list empty) for
  an off-branch claim. Left out of scope here — issue #748's own proposed fix is limited to
  `reconcileRoutineOutcome`'s inputs, and populating that table would require deciding its `headSha`
  semantics for a PR Symphonika's own branch never produced.
- Workspace retention is unaffected: it keys protection on the independent `commitsAhead` column
  (`listRoutineWorkspacePruneCandidates`, `src/run-store.ts`), not on the canonical outcome `action`,
  matching ADR 0068's own Consequences section. A stale in-code comment claiming retention depended
  on a verified `commit` action was corrected alongside this change.
- A malicious or buggy claim naming a URL outside the Project's own configured repository can never
  trigger a lookup: `parseGithubClaimUrl` refuses to match it, so the existing branch-scoped/git
  fallback decides the outcome exactly as before this change.
