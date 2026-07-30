# Routine Outcome design

## Context

Routine Firings currently persist lifecycle state, terminal reason, provider
logs, and discovered pull requests. They do not persist the Coding Agent's claim
about what it did, cannot distinguish a missing claim from a genuine no-op, and
cannot cross-check opened or closed issues. This leaves routine notifications
and operator surfaces with little more than "firing succeeded."

The provider contract must remain provider-neutral. Claude can reinforce the
claim with `--json-schema`, but Codex and Oh My Pi must still work from the
prompt-level contract and their normalized final event.

## Considered approaches

### Persist only the provider claim

This is the smallest schema change, but an omitted claim loses useful actions
that GitHub can observe. It also cannot mark a claimed pull request unverified.

### Persist claim and observations, reconcile in every reader

This retains the most structured intermediate data, but makes the HTTP, CLI,
dashboard, and notification paths repeat policy. Those paths could disagree on
whether an action is verified.

### Persist one canonical reconciled outcome

Keep raw provider events in the existing logs, observe repository state around
the firing, reconcile through one pure function, and persist the canonical
result on the Routine Firing. This is the selected approach. It preserves the
evidence needed to debug parsing while giving every reader one stable contract.

## Outcome contract

A canonical `RoutineOutcome` contains:

- `status`: `success | no_action | error`
- `action`: `pr | issue_opened | issue_closed | commit | none`
- `url`: string or null
- `title`: string
- `summary`: string
- `verified`: boolean
- `source`: `codex | claude | omp | gh | git | symphonika`

The first five fields are also the provider's claim shape. `verified` and
`source` are added by reconciliation. The actual provider name is used instead
of a generic `provider` source because it is the provider-neutral extension of
ptt's existing `claude | gh` source and remains useful when reading an exported
firing record.

Routine Outcome status does not replace Routine Firing lifecycle state or
terminal reason. The lifecycle records whether execution completed; the outcome
records what the execution did or claimed to do.

## Provider claim flow

The Routine prompt ends with a provider-neutral instruction to return exactly
one JSON object matching the claim shape. The schema is passed in
`ProviderRunInput` as optional structured-output reinforcement.

Claude appends `--json-schema <schema>` to the spawned routine command. The
provider normalizes the result event's `structured_output` onto the final
`turn_completed` event.

Codex collects the authoritative final `agentMessage` item (with streamed
deltas as a compatibility fallback) and places its text on the normalized
`turn_completed` event. Oh My Pi similarly accumulates assistant text deltas
and places the final text on `turn_completed`. Claim parsing reads only the
last normalized `turn_completed` event. Missing, non-JSON, or schema-invalid
content becomes no claim and never fails the firing by itself.

## Observation flow

When tracker credentials and the required API operations are available, the
dispatcher snapshots pull requests on the firing branch and repository issues
before provider execution, repeats the reads afterward, and derives:

- a newly observed pull request;
- a newly opened issue; or
- an issue whose state changed to closed.

Pull requests returned by the post-snapshot continue to be recorded as Routine
Pull Request associations even when they predated the snapshot. The outcome
observation uses only the before/after delta.

The GitHub issues endpoint returns both issues and pull requests, so issue
snapshots exclude entries carrying `pull_request`. Missing tracker
configuration, token, optional API support, or a failed snapshot produces a
structured log line and an unavailable observation, not a firing failure.

Successful `kind: git` workspace inspection also supplies a local commit
observation. This lets a firing with no provider claim still report a verified
commit when no GitHub action was observed.

## Reconciliation

Reconciliation is a pure function over the provider claim, provider identity,
Routine Firing terminal result, GitHub observation, and local-commit
observation.

Rules are evaluated in this order:

1. An observed PR or issue wins over a missing claim, an error/no-action claim,
   or a commit claim. It is successful, verified, and sourced to `gh`.
2. A claimed PR/opened issue/closed issue is kept. It is verified only when the
   same action kind appears in the GitHub delta.
3. A commit claim is verified only when the `kind: git` success inspection
   observed commits ahead of base.
4. A success with no claim but with local commits becomes a verified,
   `git`-sourced commit.
5. A successful firing with neither claim nor observed action becomes
   `no_action`; it is verified and sourced to `gh` when GitHub comparison
   completed, otherwise unverified and sourced to `symphonika`. Omission alone
   never changes the firing to failed.
6. A failed or cancelled firing with no observed external action becomes an
   error sourced to `symphonika`, retaining its terminal reason in the summary.

When a GitHub snapshot is unavailable, a remote-action claim is retained but
unverified. Reconciliation never changes the Routine Firing lifecycle state.

## Commit-only retention rule

ADR 0025 preserves workspaces today, so a verified commit-only outcome is
valuable and is not an error. Its durable `action: commit` is also a retention
signal: future workspace GC must not silently delete that workspace. Slice 9
must either retain commit-only workspaces, observe later publication as a PR,
or require an explicit destructive operator override before collection.

This chooses preservation over ptt's rule because ptt's clone is ephemeral at
the moment reconciliation runs, while Symphonika's workspace is durable.

## Persistence and readers

The Run Store adds nullable Routine Outcome columns to `routine_firings`.
Nullable columns preserve compatibility with historical firings and
intermediate lifecycle rows.

`getRoutineFiring` and `listRoutineFirings` expose `outcome`. Therefore
`GET /api/routines/:id/firings` exposes the same object without route-specific
mapping. `symphonika routines` renders the latest firing outcome in a compact
one-line form including action, title, URL, and an `(unverified)` marker.

Slice 3's SMTP sink was implemented independently in PR #347. This slice stacks
that prerequisite commit and integrates the shared one-line Routine Outcome
formatter into its plain-text and escaped HTML bodies. The renderer therefore
includes action, title, URL, and the unverified marker without duplicating
reconciliation policy.

## Test seams

Behavior-focused tests cover:

- the pure reconciliation truth table without network access;
- provider `runAttempt` final-event normalization and Claude schema
  reinforcement;
- `dispatchDueRoutines` claim parsing, GitHub issue/PR observation, missing
  tracker degradation, and persisted fallback outcomes;
- Run Store migration and firing readers;
- the firing-history HTTP response and CLI rendering.
