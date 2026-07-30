# Routine execution overrides and wall-clock deadline

## Goal

Make the two live ptt Routine configurations expressible while guaranteeing that a wedged Routine
Firing cannot run past its declared duration.

## Interface

Routine Markdown front matter accepts optional `model`, `effort`, `permission_mode: bypass`, and
positive `timeout_minutes`. The Service Config accepts the same keys in `routine_defaults:`.
Resolution order is Routine, service default, then no override.

## Execution design

The Routine dispatcher persists effective settings and passes model/effort/permission data through
the public `AgentProvider.runAttempt` input only for Routine Firings. Each adapter constructs its
own final argv, allowing Codex to position `-c` settings before `app-server` and Claude/OMP to use
their native flags. Claude Routine inputs also activate the disallowed-tool and background-task
guards. Routine prompt rendering adds the one-shot statement independently of provider choice.

The dispatcher starts one deadline for the claimed firing. All async stages race the same absolute
timer rather than receiving fresh per-stage budgets. If it expires during provider streaming, the
dispatcher awaits provider cancellation and stream cleanup, then writes the deterministic
`failed / firing_timeout` outcome. Terminal classification remains inside the deadline;
post-terminal pull-request discovery does not. Provider cancellation uses the process-group
boundary delivered by #341.

## Public test seams

- `loadRoutineDeclaration` proves front-matter parsing and validation.
- `RuntimeConfigReloader` proves service-default precedence and reload exposure.
- `RunStore.syncRoutines` / `getRoutine` prove effective settings survive until a clock firing.
- `AgentProvider.runAttempt` proves final Claude, Codex, and OMP spawn arguments and Claude
  environment guards.
- `dispatchDueRoutines` proves timeout cancellation and the persisted terminal reason.
- `renderRoutinePrompt` proves the provider-neutral one-shot statement.
