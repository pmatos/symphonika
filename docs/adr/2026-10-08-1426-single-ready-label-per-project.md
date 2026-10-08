# One Ready Label per Dispatch Project

Status: Accepted

Amends ADR 0061 (Required Eligibility Label validation). Part of epic #844, slice #845.

## Decision

A Dispatch Project declares exactly one **Ready Label** as `issue_filters.ready_label`: a singular,
nonempty string. An issue is label-eligible only when it carries that label; excluded labels
(`labels_none`), Operational Labels, native dependency gating, and durable suppression/ownership
rules apply unchanged. The jointly-required `issue_filters.labels_all` list is retired as an
eligibility concept.

`ready_label` lives inside `issue_filters`, next to `labels_none`, rather than at the top of the
Project: every consumer already reads `project.issue_filters.*`, and the legacy-key conflict check
stays local to one object. A later Project-settings slice (#850) edits the same key.

### Load-time migration

One shared schema (`issueFiltersSchema` in `src/config-schemas.ts`) is used by `reload`, issue
polling, dispatch and `doctor`, so none of them can disagree. It normalizes before any consumer sees
the config:

| Input | Result |
| --- | --- |
| `ready_label: X` | `X` |
| `labels_all: [X]` | `ready_label: X`, value unchanged |
| `labels_all: [X, Y, ...]` | `ready_label: X`; the distinct, trimmed list is kept as `migrated_from_labels_all` so the broadening can be reported |
| `labels_all: [X, X]` (repeats of one label) | `ready_label: X`; a single distinct label is not a broadening, so no marker and no warning |
| `labels_all: []` | validation error (the operator must choose a label) |
| `labels_all` and `ready_label` both set | validation error (ambiguous) |
| neither key | validation error — existing configs are **not** silently defaulted |

Parsed output carries no `labels_all`, so there is no second legacy eligibility path. Re-parsing
parsed output is idempotent and preserves the broadening marker.

Taking the first of several labels *broadens* eligibility (issues that lacked the other labels now
qualify). It is reported on every surface an operator watches: a `doctor` warning, a daemon log
warning when a config load first produces it or its content changes (not on every unchanged reload),
`warnings` on the reload status (`/api/status`), and a dashboard banner. The migration never
rewrites the operator's `symphonika.yml`.

### Defaults

`init-project` prompts for a single Ready Label defaulting to `ready-for-agent` and writes
`ready_label`. The default applies only to newly registered Projects; it does not rename labels on
existing Projects. The repository's own `agent-ready` tracker label is unrelated to this default.

### Validation and provisioning

ADR 0061 carries over with "every `labels_all` value" replaced by "the Ready Label": `doctor`
errors when it is missing from the repository and `init-project` offers to create it (`--yes`
creates it). It stays a repository-owned workflow label, outside the `sym:*` namespace.

## Consequences

- Existing single-label configs keep working with no edit; multi-label configs keep working but
  warn until the operator picks the intended label.
- The eligibility-reason text `missing required label X` is unchanged, so downstream parsing of
  triage verdicts is unaffected.
- The only multi-label test (`init-project` collecting several required labels) became a
  single-label prompt test; multi-label behavior is otherwise exercised only through the migration
  above.
