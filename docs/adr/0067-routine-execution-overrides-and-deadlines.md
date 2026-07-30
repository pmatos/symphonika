# Routine execution overrides are adapter-owned and deadlines are absolute

Status: Accepted

## Context

The live ptt routines require different model, effort, permission, and 60-minute execution
settings. Symphonika previously selected only a provider name per Routine and had no wall-clock
bound for a Routine Firing. The Watchdog in ADR 0054 answers a different question—whether observable
progress stopped—and cannot substitute for a declared maximum duration.

Provider commands are operator-authored. Command templates would keep flag syntax in configuration,
but optional values need conditional fragments to remove both a flag and its missing value.
`permission_mode: bypass` is also asymmetric: Claude uses a dedicated flag while Codex and OMP
express full permission through different startup settings.

## Decision

Routine front matter and the top-level `routine_defaults:` Service Config block accept `model`,
`effort`, `permission_mode`, and `timeout_minutes`. Front matter wins over service defaults. An
omitted effective value does not change the corresponding provider command behavior.

Provider adapters own append-at-spawn delivery:

- Claude appends `--model` and `--effort`; `permission_mode: bypass` becomes
  `--dangerously-skip-permissions`.
- Codex inserts `-c model=...` and `-c model_reasoning_effort=...` before `app-server`.
- OMP appends `--model` and maps effort to `--thinking`.

`permission_mode` currently accepts only `bypass`. This is the portable semantic shared by all
providers and preserves ADR 0015's Full-Permission Agent Execution invariant. Codex and OMP base
commands already validate their equivalent bypass posture.

Every Claude Routine Firing also appends
`--disallowedTools ScheduleWakeup Monitor CronCreate` and sets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Every Routine prompt receives a provider-neutral notice
that the firing is one-shot and will not be re-invoked.

An effective `timeout_minutes` creates one absolute deadline when execution of the claimed firing
begins. It races workspace preparation, provider validation, and provider streaming. Expiry calls
the provider adapter's existing cancellation method and persists `failed / firing_timeout`,
regardless of the cancellation-generated process-exit event. Terminal outcome classification is
also inside the deadline; post-terminal pull-request discovery is not. The process-group
implementation from #341 and ADR 0064 makes that cancellation a whole-tree termination once a
provider process exists. Expiry during workspace preparation only stops the dispatcher from
waiting on that stage — the underlying `git` subprocesses are not cancelled and can keep running
in the background (tracked in #353).

## Consequences

- Operator commands remain reusable for issue Runs and are unchanged when Routine overrides are
  omitted.
- Provider-specific argv vocabulary remains localized to the adapters that already own protocol
  startup.
- A progressing firing can still exceed its declared deadline; a non-progressing firing can still
  trip the Watchdog first. Neither policy replaces the other.
- Restricted or interactive Routine permission modes remain unsupported by design.
- A firing that times out during workspace preparation leaves its `git` clone/fetch running
  unattended; because `ensureRepositoryCache` serializes callers per project repository cache, that
  abandoned work can delay the next firing's or Run's workspace preparation for the same project
  (#353).
