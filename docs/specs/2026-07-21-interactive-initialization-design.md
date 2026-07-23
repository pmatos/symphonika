# Interactive global and Project initialization

Issue #181 splits first-run setup along the existing domain boundary between the global Service
Config and repository-specific Projects.

## Command responsibilities

`symphonika init` creates the user Service Config with service-level settings and an empty
`projects` sequence. It can run outside a Git repository. Interactive mode prompts for the state
root, polling interval, pull-request merge policy, and both provider commands. `--yes` accepts the
displayed defaults, and `--force` remains the only way to replace an existing user config. The
command never mutates GitHub or a repository.

`symphonika init-project` requires an existing selected Service Config and runs inside a GitHub
repository with an `origin` remote. It prompts for the Project name, Agent Provider, base branch,
required and excluded issue labels, priority label mapping, and Workflow Contract path. It adds the
Project to the existing YAML document, creates a starter `WORKFLOW.md` only when the selected path
does not exist, and then creates any missing Operational Labels in that Project's repository.
`--yes` accepts defaults and is the explicit confirmation for label creation.

## YAML preservation and duplicate names

Project registration edits the parsed YAML document rather than constructing a fresh Service
Config, preserving unrelated top-level keys, Projects, and comments. A duplicate Project name is an
error by default. With `--force`, only the matching Project sequence entry is replaced in place;
unrelated Projects remain untouched. Emitting a second entry with the same name was rejected
because runtime Project lookup assumes names identify one Project.

## Interaction and validation

Prompts show defaults and accept a blank answer as the default. Label lists use comma-separated
values. Priority mappings use comma-separated `label=non-negative-integer` pairs. Invalid numeric,
boolean, provider, merge-method, or priority answers fail without writing either config or
workflow files. Git and GitHub failures are returned through the existing report/error CLI surface.

## Test seams

Behavior is tested through `runInit`, `runInitProject`, and the Commander CLI. Tests inject prompt
answers and a fake GitHub API, while using real temporary files and Git repositories. This keeps
filesystem/YAML behavior real and mocks only the GitHub system boundary.
