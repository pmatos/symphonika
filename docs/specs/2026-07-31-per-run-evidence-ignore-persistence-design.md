# Per-Run evidence-ignore persistence design

Status: accepted by issue #266

## Goal

Keep a running Run's Workflow Contract `evidence.ignore` policy after its Project is removed from
the current Service Config, including across an Orchestrator restart. A removed Project's active
Run must continue under SPEC §8.4 without ignored build-output churn becoming Watchdog progress.

## Selected design

The Run Store persists the validated `evidence.ignore` directory list with each newly created Run
as JSON on the `runs` row. Fresh Runs and Continuations capture the effective Workflow Snapshot
used at claim time. Rows created through compatibility or non-provider paths default to an empty
list.

`listWatchdogCandidateRuns()` returns the persisted list with every running candidate. During
Watchdog reconciliation, a Project that is still present uses its current valid Workflow Snapshot,
preserving hot-reload behavior. When the Project is absent, reconciliation falls back to the
candidate Run's persisted list.

The schema migration adds a non-null column with `[]` as its default. Pre-existing rows therefore
retain the historical behavior without inventing policy that was never recorded.

## Alternatives considered

- Extending the persisted Expanded Workflow Graph would mix prompt-adjacent Watchdog policy into
  the execution graph and require artifact reads during reconciliation.
- Retaining removed Workflow Snapshots in daemon memory would not survive restart and could miss a
  Project removed before the first Watchdog sample populated the cache.
- Always using the persisted value would survive removal but would discard the existing contract
  that valid Workflow Contract edits affect active Runs while their Project remains configured.

## Validation and tests

Run Store coverage proves that creation and reopening retain the policy and that legacy rows migrate
to an empty list. Watchdog coverage proves that current configuration overrides the persisted value
when present and that absence falls back to the Run. A daemon regression removes a Project while
its provider remains running and verifies that churn confined to the persisted ignored directory
still reaches `no_progress`.
