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

When a tracked PR is open, non-draft, mergeable, has no unresolved review feedback, has passing
status checks when required, and satisfies the configured review policy, Symphonika merges it using
the configured method. The default policy is squash merge, require successful status checks, and do
not require explicit approval unless GitHub reports `REVIEW_REQUIRED`; branch protection still has
the final say because the merge goes through GitHub's normal pull-request merge API.
