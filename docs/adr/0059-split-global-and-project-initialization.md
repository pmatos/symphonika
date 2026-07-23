# Split global and Project initialization

Status: Accepted

Symphonika separates initialization along its configuration ownership boundary. `init` creates only
the user Service Config and service-level defaults, with an empty Project sequence.
`init-project` registers the current GitHub repository in an existing Service Config, creates a
starter Workflow Contract when needed, and provisions that repository's missing Operational Labels.
Both commands are interactive by default and accept `--yes` for unattended default selection.

Project registration edits the YAML document so unrelated Projects, keys, and comments survive.
Duplicate Project names fail by default; `--force` replaces only the matching sequence entry. This
supersedes ADR 0026's original bootstrap command split, where `init` derived one Project and
`init-project` only provisioned labels.
