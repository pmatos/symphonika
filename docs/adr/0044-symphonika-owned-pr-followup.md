# Symphonika-owned PR follow-up

Symphonika will run a poll-based PR Follow-up loop for pull requests discovered from deterministic
Symphonika Issue Branches. It will not inspect arbitrary repository PRs or use PRs to decide initial
issue eligibility. The association boundary is intentionally narrow: a succeeded Run with a recorded
Issue Branch may discover an open PR for that branch, then store the PR number and head SHA in the
Run Store.

Review feedback is considered unaddressed when GitHub reports `CHANGES_REQUESTED` or GraphQL review
threads whose `isResolved` flag is false. This chooses resolved threads over "was there a reply" as
the v1 source of truth because replies alone do not prove that the reviewer accepted the fix.

The trigger model is daemon polling rather than webhooks. Polling matches the existing scheduler,
keeps the bootstrap slice single-process, and avoids introducing a public webhook endpoint or
delivery-secret lifecycle before the local operator surface needs it.

When unaddressed feedback appears, Symphonika starts a follow-up Run in the same Workspace and Issue
Branch. The rendered prompt includes a PR review follow-up section with the review thread context and
explicitly tells the Coding Agent not to open a second PR. The follow-up run is stored as a
Continuation so existing status surfaces show it without a separate run-state model. To avoid loops,
Symphonika fingerprints the head SHA plus unresolved feedback and does not dispatch the same
fingerprint twice; it also caps review follow-ups per PR, defaulting to three.

PR review follow-up is workflow-owned continuation work, not label-controlled work. Once
`dispatchReviewFollowup` confirms that the Issue is open, the Run's reservation is label-immune
before workspace preparation or provider validation begins. Reconciliation may still cancel it for
Issue closure or an operator request, but it must not cancel it because `labels_all` or
`labels_none` drifted. Ordinary Continuations retain their label checks.

The tracked-PR row durably records whether the latest successful observation found unresolved
feedback after the configured review-dispatch cap. Observation failures preserve the prior value;
resolved feedback, a raised cap, PR closure, or PR merge clears it on a later successful
observation. Cap exhaustion leaves a parked workflow Run in `waiting`. The Run JSON detail exposes
structured cap context, and the server-rendered detail page shows an amber manual-attention warning
linked to the tracked PR. Request handling reads persisted state plus the current loaded policy and
does not perform a GitHub request.

When a tracked PR is open, non-draft, mergeable, has no unresolved review feedback, has passing
status checks when required, and satisfies the configured review policy, Symphonika merges it using
the configured method. The default policy is squash merge, require successful status checks, and do
not require explicit approval unless GitHub reports `REVIEW_REQUIRED`; branch protection still has
the final say because the merge goes through GitHub's normal pull-request merge API.
