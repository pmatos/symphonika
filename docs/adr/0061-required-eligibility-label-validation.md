# Validate and provision Required Eligibility Labels

Status: Accepted

## Decision

Every configured `issue_filters.labels_all` value is a Required Eligibility Label and must exist in
the Project's GitHub repository before dispatch. `doctor` reports missing labels as Project
validation errors and marks the Project invalid for dispatch. `init-project` uses its existing
confirm-then-create posture to offer creation of missing Required Eligibility Labels; `--yes`
creates them without prompting.

Required Eligibility Labels remain repository-owned workflow labels. Symphonika may create them
during explicit Project initialization, but it does not apply or remove them during orchestration
and does not merge them into the orchestrator-owned `sym:*` Operational Label namespace.

Validation and provisioning are limited to `labels_all`. A nonexistent required label makes the
predicate impossible for every issue and silently disables dispatch. By contrast, a nonexistent
`labels_none` label excludes nothing, and a nonexistent priority label leaves issues on the
configured default priority; neither condition makes a Project unable to dispatch. Those labels
therefore remain optional repository workflow configuration rather than Project-health
requirements.

## Consequences

- A Project cannot pass `doctor` when one of its configured Required Eligibility Labels is absent.
- `init-project --yes` leaves a newly registered Project dispatch-capable when its default
  `agent-ready` label did not previously exist.
- Operational and eligibility diagnostics, creation results, and operator surfaces remain
  separate, preserving label ownership boundaries.
