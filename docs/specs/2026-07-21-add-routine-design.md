# Add-routine and Routine validation design

Issue #194 supplies the approved behavior for the Routine creation and validation surface. This
document records the implementation choices needed to apply that behavior to the current codebase.

## Public seams

- `RoutineConfigEditor` registers a declaration path in one named Project while preserving the YAML
  document's comments and key ordering.
- `runAddRoutine` and the `symphonika add-routine` command scaffold and register one declaration
  using only local filesystem operations.
- `runDoctor` validates every Routine path enumerated by an enabled or disabled Project and reports
  declaration and duplicate-name errors beside Workflow Contract errors.
- `RuntimeConfigReloader` remains the daemon boundary for defensive Routine reloads. Its existing
  last-known-good snapshot behavior and operator reload status are reused unchanged.

## File and config behavior

The command creates `<cwd>/routines/<name>.md`. The current Service Config has no separate Routine
directory setting, so the command does not infer a directory from existing declaration paths. When
the generated file is beneath the Service Config directory, the editor records a `./`-prefixed,
config-relative path. Otherwise it records an absolute path, matching `init`'s existing handling of
repository-owned Workflow Contracts in user-level Service Config.

`RoutineConfigEditor` parses `symphonika.yml` as a YAML document rather than converting it through a
plain JavaScript object. It locates the named Project, verifies that `routines` is absent or a
sequence, and loads existing Routine declarations through `RoutineDeclarationLoader`. Re-adding the
same resolved path is an unchanged, successful operation. A different path whose declaration has
the requested Routine name is rejected.

## Validation and failure handling

Generated Markdown is validated with the same declaration parser used by daemon reload and doctor.
This catches unsafe names, invalid or unknown cron forms, invalid timezones, invalid one-shot dates,
and unsupported kinds or providers without running provider or GitHub probes. Exactly one of
`--schedule` and `--at` is required, and `--tz` is valid only with `--schedule`.

The target Markdown file is created without overwriting an existing file. If config registration
then fails, the command removes only the file it just created, leaving the Service Config unchanged.
The command does not contact the daemon or trigger reload; the next normal tick observes both local
file changes together.

## Generated declaration

Front matter preserves the operator's cron expression rather than replacing aliases with their
normalized cron form. Optional `provider` and `schedule.tz` keys are emitted only when supplied. The
Markdown body contains non-empty HTML TODO comments so the declaration is valid but visibly needs
operator-authored prompt instructions.

## Tests

Tests exercise behavior through the four public seams:

1. `RoutineConfigEditor` appends or creates `routines`, rejects missing Projects and name
   collisions, is idempotent by resolved path, and preserves unrelated comments and ordering.
2. `runAddRoutine`/CLI creates valid cron and one-shot declarations, registers them, rejects invalid
   flags and collisions without partial writes, and succeeds without GitHub or provider adapters.
3. `runDoctor` reports malformed Routine declarations and duplicate Routine names through its
   existing error report and CLI failure output.
4. Existing reload tests continue to prove that an invalid Routine edit retains the last-known-good
   snapshot and exposes the structured reload error.
