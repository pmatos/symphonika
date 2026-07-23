# PR Follow-up Eligibility and Cap Status

Date: 2026-07-23

## Summary

PR Follow-up is an orchestrator-owned continuation of work on a tracked pull request. Once
Symphonika owns that lifecycle, repository workflow labels such as `agent-ready` no longer decide
whether the follow-up may continue. Only issue closure or an explicit operator cancellation stops
it.

Symphonika will also persist when unresolved review feedback remains after the configured PR
Follow-up dispatch cap is exhausted. A parked wait Run remains `waiting`, while its HTML and JSON
detail surfaces explain that automatic follow-up is exhausted and manual attention is required.

## Incident

Symphonika issue #181 intentionally lost `agent-ready` after its implementation Run opened PR #275.
The PR Follow-up loop subsequently created 142 Runs that reconciliation cancelled with
`eligibility_loss`. The Runs were not independent jobs: each was another attempt to address the same
tracked review feedback.

The review dispatch path correctly required only that the issue remained open. However, the
in-flight reservation initially defaulted to respecting issue labels. Raw-FSM label immunity was
applied only after workflow loading, workspace preparation, provider validation, and attempt
creation. A polling tick during that window saw the missing eligibility label and cancelled the Run
before the provider started. Because a cancelled dispatch did not advance the PR's review dispatch
fingerprint or count, the same feedback retried on the next tick.

One Run eventually completed before reconciliation won the race. It exhausted the configured third
review dispatch and parked the workflow in `wait_for_pr`. The operator surface showed only
`waiting`; the durable store did not record that unresolved feedback remained beyond the automatic
follow-up budget.

## Goals

- Make every PR Follow-up label-immune from its initial Issue Reservation onward.
- Continue honoring issue closure and explicit operator cancellation.
- Preserve label checks for fresh dispatch and ordinary label-controlled Continuations.
- Persist whether an open tracked PR has unresolved feedback after its review dispatch cap.
- Keep the associated workflow Run in `waiting`.
- Explain cap exhaustion on both `/runs/:id` and `/api/runs/:id`.
- Keep the local operator surface deterministic and free of request-time GitHub calls.

## Non-goals

- Raising or removing the review dispatch cap.
- Automatically resolving review threads.
- Changing fresh-dispatch or ordinary Continuation eligibility.
- Migrating historical cancelled or failed Runs.
- Introducing a new RunState for PR Follow-up attention.
- Changing merge policy or the wait-state transition graph.

## Approaches Considered

### 1. Explicit PR Follow-up continuation policy and durable cap status

Pass label immunity explicitly from `dispatchReviewFollowup` through reservation and attempt
startup. Persist a cap-reached bit on the tracked PR from the same live observation used by the PR
Follow-up decision.

This is the selected approach. It expresses the domain rule at the dispatch boundary, prevents the
race before it exists, and lets local operator surfaces render the latest durable observation
without network access.

### 2. Exempt every Continuation from label reconciliation

This is smaller mechanically, but it weakens ordinary label-controlled Continuations. Those Runs
still use issue labels as their continuation policy and must retain the existing cancellation
behavior.

### 3. Infer cap exhaustion or manipulate workflow labels

Inferring cap exhaustion from `review_dispatch_count` alone can warn after feedback was resolved.
Re-adding `agent-ready` around follow-ups creates tracker-label churn and risks fresh dispatches.
Fetching GitHub from the run page would make a local evidence surface network-dependent. These
options are rejected.

## Lifecycle Design

`dispatchReviewFollowup` starts `runFreshLifecycle` with an explicit
`respectsIssueLabels: false`. That value is used when reserving the issue, not only after the
workflow has loaded. Attempt startup preserves the explicit override; otherwise it derives the
existing default from the workflow source kind.

The resulting rules are:

- Fresh Markdown-compatible runs and ordinary Continuations continue to respect labels.
- Fresh raw-FSM Runs remain label-immune as established by ADR 0046.
- State Advance, wait park, and PR Follow-up are label-immune because the existing workflow or
  tracked PR owns their continuation decision.
- All paths still stop when the issue closes because closed-state reconciliation precedes the label
  policy check.
- Explicit operator cancellation remains unchanged.
- Retry scheduling carries the same policy as the Run that failed transiently.

No new dispatch kind or RunState is introduced.

## Durable PR Follow-up Attention

`tracked_pull_requests` gains:

```text
review_followup_cap_reached integer not null default 0
```

The typed `TrackedPullRequest` representation exposes this as a boolean.

Each successful PR observation computes the bit from the same normalized Pull Request State and
policy used for dispatch:

- set it when the PR is open, unresolved review feedback requires follow-up, and
  `review_dispatch_count >= max_dispatches_per_pr`;
- clear it when feedback no longer requires follow-up, when the cap is raised above the current
  count, or when the PR closes or merges;
- leave the last durable value unchanged when the GitHub observation itself fails.

The observation update writes PR tracking state and cap status together. Completing the final
allowed follow-up does not immediately claim exhaustion: the next observation must still see
unresolved feedback before the bit becomes true.

## Operator Surface

Run detail associates a `waiting` Run with the most recent tracked PR for the same Project and
Issue. When `review_followup_cap_reached` is true, the detail response includes:

```json
{
  "pullRequestFollowup": {
    "attention": "cap_reached",
    "dispatchCount": 3,
    "maxDispatches": 3,
    "prNumber": 275,
    "prUrl": "https://github.com/pmatos/symphonika/pull/275"
  }
}
```

For other Runs or tracked PRs without cap attention, `pullRequestFollowup` is `null`.

The HTML page renders an amber warning near the Run summary:

> PR follow-up cap reached. 3 of 3 automatic review follow-ups were dispatched; unresolved feedback
> still requires manual attention.

The warning links to the tracked PR. The Run remains `waiting`, retains its cancel control, and
continues to be reconciled. Manual feedback resolution, a later policy increase, PR closure, or PR
merge clears the warning on a later successful observation.

The HTTP app receives a read-only callback for the current PR Follow-up policy so hot-reloaded cap
changes are reflected without restarting the daemon.

## Public Test Seams

### Daemon HTTP seam

Start the real daemon with temporary state plus fake GitHub and Agent Provider boundaries. Seed a
succeeded Run and tracked PR, then expose an open issue whose workflow eligibility label is already
absent. Hold provider startup across one or more `/api/poll-now` requests.

Observe through `/api/runs/:id` that the review Run completes without `eligibility_loss` and that
only one follow-up is created for the feedback. The test must fail on the pre-fix reservation
default and pass only when label immunity applies from reservation onward.

### Operator HTTP seam

Seed the real Run Store with a waiting Run and tracked PR observation, then request `/runs/:id` and
`/api/runs/:id` through the Hono app. Assert the literal operator warning and structured cap context.
Also cover the clearing observation so stale attention is not shown after feedback resolves.

The database is fixture setup, not the assertion surface. Tests observe behavior only through the
public HTTP interfaces. GitHub and provider doubles remain at external system boundaries.

## Documentation

Implementation updates:

- `CONTEXT.md`: PR Follow-up is workflow-owned continuation work, not label-controlled work.
- `SPEC.md` §12.5: label immunity begins at reservation and cap exhaustion is durable operator
  attention while the Run remains waiting.
- ADR 0044: record the clarified PR Follow-up eligibility and cap-observability consequences.

## Acceptance

- Reconciliation cannot cancel an open PR Follow-up solely because required or excluded workflow
  labels drifted.
- Closing the issue still cancels an in-flight PR Follow-up.
- Ordinary label-controlled Continuations still cancel on eligibility loss.
- Repeated polling does not create a cancellation storm for one review fingerprint.
- Unresolved feedback beyond the configured cap leaves the workflow Run `waiting`.
- HTML and JSON Run detail expose the cap count, configured maximum, and tracked PR.
- Resolving feedback, closing/merging the PR, or raising the cap clears the durable warning after a
  successful observation.
- Focused regression tests, the full test suite, typecheck, lint, formatting, build, and Knip pass.
