# Structured Routine Outcomes

Status: Accepted

## Context

A terminal Routine Firing records whether provider execution succeeded, failed, or was cancelled,
but that lifecycle result does not say what the Coding Agent did. Provider prose is also not enough:
an agent can claim that it opened a pull request or issue without the corresponding GitHub change,
while an agent that omits its final claim may still have created an externally visible action.

Claude can reinforce a structured final response with `--json-schema`. Codex and Oh My Pi do not
share that CLI mechanism, and all three providers are supported. The contract therefore cannot
depend on a provider-specific flag.

ptt treats commit-only work in an ephemeral clone as an error because the clone is deleted
immediately. Symphonika instead preserves Routine Firing workspaces under ADR 0025, but future
retention and garbage collection could recreate the same silent-loss problem.

## Decision

Every terminal Routine Firing may carry one canonical **Routine Outcome**:

- `status`: `success | no_action | error`
- `action`: `pr | issue_opened | issue_closed | commit | none`
- `url`: string or null
- `title`: string
- `summary`: string
- `verified`: boolean
- `source`: `codex | claude | omp | gh | git | symphonika`

The first five fields form the **Routine Outcome Claim** requested by the standard routine prompt.
The provider's final normalized `turn_completed` event is the only claim source. Claude also
receives the same JSON Schema through `--json-schema`; this is reinforcement, not the contract.
Missing, malformed, or schema-invalid claims are treated as absent and do not fail a firing.

For Projects with tracker configuration, the dispatcher reads repository issues before and after
provider execution, bounded to a window wide enough to cover any single firing rather than the
repository's entire history. Because that window can exclude an issue's last update before the
firing, the diff distinguishes an issue created or closed within the window from a pre-existing
issue merely touched inside it, using the issue's own creation/closure timestamps rather than mere
absence from the bounded before-snapshot. A `kind: git` firing additionally reads open pull requests
whose head is its deterministic firing branch. The before/after diff can observe a newly opened pull
request, a newly opened issue, or an issue changing to closed. A comparison counts as complete only
when every channel relevant to the routine's kind succeeded on both reads — issues alone for a
report routine, both issues and pull requests for a `kind: git` routine — so a silently failed
channel cannot be mistaken for "checked and found nothing changed". Tracker-less Projects skip this
observation with an informational log entry. Missing optional API support, credentials, or a failed
read similarly degrades observation without changing the firing lifecycle.

One pure reconciliation function produces the persisted outcome:

1. An observed GitHub action wins over an absent claim, an error/no-action claim, or a commit claim.
   It is verified and sourced to `gh`.
2. A claimed pull request or issue action is verified only when the same action kind was observed.
   A claimed no-action (`none`) is verified only when a completed GitHub comparison confirms no
   external action occurred; an unavailable comparison leaves it unverified. Otherwise the provider
   claim remains visible with `verified: false`.
3. A commit claim is verified whenever the successful `kind: git` workspace inspection found commits
   ahead of the configured base branch, regardless of the claim's own reported status.
4. Without a claim, an observed GitHub action is sourced to `gh`; otherwise a successful
   commits-ahead firing is a verified `git` outcome. This git evidence also overrides a `none`
   claim, or a pull-request/issue claim no GitHub observation corroborates, that under-reports a
   successful `kind: git` firing with commits ahead of the base branch — regardless of that claim's
   own status — so a self-reported "nothing to do", an unconfirmed external-action claim, or an
   "error" never suppresses the retention signal below.
5. A successful firing with no claim or observed action records `no_action`. A completed GitHub
   comparison makes it verified and sourced to `gh`; an unavailable comparison leaves it
   unverified and sourced to `symphonika`. Claim omission alone never fails the firing.
6. A failed or cancelled firing with no observed external action records an error outcome sourced
   to `symphonika` and retains the terminal reason in its summary.

Routine Outcome is evidence alongside lifecycle state and terminal reason; it does not replace or
rewrite either.

Every prepared `kind: git` workspace persists commits-ahead evidence separately from its terminal
lifecycle classification and this canonical outcome. Routine Workspace Retention uses that
independent signal, so a failure, cancellation, or richer verified GitHub action cannot hide local
commits from the retention guard. Only a verified zero-commits inspection permits age-based
collection; an inspection failure is unknown and conservatively persists the protection signal.
Until Symphonika persists a verified durable-publication transition, every commits-ahead workspace
is retained indefinitely rather than collected by age. It must not silently collect the only copy
of a commit.

## Consequences

- The Run Store, firing-history API, CLI, and dashboards share one reconciled result instead of
  independently interpreting provider output.
- Historical and non-terminal firing rows have a null outcome; terminal firings created by the new
  dispatcher have a canonical outcome even when the provider omitted its claim.
- The notification layer uses the shared one-line formatter for action, title, URL, and the
  unverified marker without duplicating reconciliation policy.
- GitHub observations remain best-effort evidence and never make an otherwise valid firing fail.
- Routine Workspace Retention keys commit protection on persisted commits-ahead evidence rather
  than the canonical outcome action.
