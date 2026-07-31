# Routine execution overrides are template-delivered and deadlines are absolute

Status: Accepted

**Amendment note:** the delivery mechanism below was revised from this ADR's original
append-at-spawn design (Symphonika's adapters building `--model`/`-c model=...`/`--thinking` argv
themselves) to command templating (the operator positions `{{model}}`/`{{effort}}`/
`{{permission_mode}}` tags directly in `providers.<name>.command`). Two independent implementations
of this issue landed with opposite choices on the "pick one" question the issue explicitly flagged;
templating was chosen because it keeps Symphonika provider-agnostic by construction — it never needs
to know any provider's flag vocabulary, matching how `-c sandbox_mode=...`/`-c approval_policy=...`
already work today. Everything else in this ADR (the config surface, the deadline mechanism, the
anti-backgrounding guards, the one-shot notice) is unchanged.

## Context

The live ptt routines require different model, effort, permission, and 60-minute execution
settings. Symphonika previously selected only a provider name per Routine and had no wall-clock
bound for a Routine Firing. The Watchdog in ADR 0054 answers a different question—whether observable
progress stopped—and cannot substitute for a declared maximum duration.

Provider commands are operator-authored. `permission_mode: bypass` is asymmetric across providers:
Claude uses a dedicated flag while Codex and OMP express full permission through different startup
settings — but every provider already independently hard-enforces full-permission execution
regardless of this field (ADR 0015), so `permission_mode` need not be reflected in every command.

## Decision

Routine front matter and the top-level `routine_defaults:` Service Config block accept `model`,
`effort`, `permission_mode`, and `timeout_minutes`. Front matter wins over service defaults. An
omitted effective value does not change the corresponding provider command behavior.

`providers.<name>.command` gains Mustache-style template syntax the operator positions themselves:
plain tags (`{{model}}`, `{{effort}}`, `{{permission_mode}}`) substitute the resolved value, and
`{{#tag}}...{{/tag}}` conditional sections keep (and substitute) their contents only when the field
resolves to a value — the section form is what lets an operator omit a whole `--model X` segment
when `X` is absent, without a dangling incomplete flag. Each provider adapter renders
`input.provider.command` through this template using `input.routine` (or `{}` for issue-driven Runs
and for `validate()`, which never resolves per-routine values) before parsing it into argv — the
operator's own authored command carries all provider-specific flag knowledge; Symphonika's
TypeScript never hardcodes Codex's `-c` keys or OMP's flag names.

An unrecognized or malformed template tag throws rather than passing through as literal text — the
string is about to be spawned as a real child-process argv. Section validity is checked structurally
(a stack keyed by field name), not by comparing per-field open/close counts: a reordered closer
before its opener, or crossed different-field sections, throws instead of corrupting the rendered
output with leftover literal template syntax.

Independent of that, `loadRuntimeConfigSnapshot` (`src/reload.ts`) renders every configured
`providers.<name>.command` against empty values unconditionally at reload time — whether or not any
routine currently resolves to that provider — so a malformed tag on a provider used only by
issue-driven Projects is still caught at config-load time. This sits at the same tier as a malformed
`watchdog:`/`routine_defaults:` mapping: any failure here rejects the whole candidate snapshot
through the normal Service Config last-known-good path, before per-routine attach ever runs.

`loadRuntimeConfigSnapshot` separately cross-checks each routine's resolved `model`/`effort` against
its resolved provider's authored command template: a routine declaring a field its provider's
command template never references is a declaration-load error (the field would otherwise be
silently inert), checked before the routine is attached. Unlike a malformed provider command, a
rejected routine does not abort the whole snapshot — it is excluded from `project.routines` and
tracked in a dedicated `project.templateRejectedRoutines` list (mirroring
`project.trackerlessGitRoutines`), which `syncRoutines` soft-disables with `disabled_reason =
"rejected_provider_template_mismatch"` instead of the generic `removed_from_config` a bare `continue`
would otherwise produce — a still-configured-but-rejected routine must never be mistaken for one
removed from `routines:`. `permission_mode` is exempt from this check for the reason given in
Context: it is redundant, not inert, when untemplated.

`permission_mode` currently accepts only `bypass`. This is the portable semantic shared by all
providers and preserves ADR 0015's Full-Permission Agent Execution invariant. Codex and OMP base
commands already validate their equivalent bypass posture.

Every Claude Routine Firing also appends
`--disallowedTools ScheduleWakeup Monitor CronCreate` and sets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, unconditionally whenever `input.routine !== undefined` —
these are not declared per-routine fields, so they bypass the template entirely rather than risk
being baked into a `providers.claude.command` shared with an issue-driven Project. Every Routine
prompt receives a provider-neutral notice that the firing is one-shot and will not be re-invoked.

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
  omitted (rendering with `{}` is a no-op for a command with no template tags).
- Provider-specific argv vocabulary lives entirely in the operator's own `providers.<name>.command`,
  not in Symphonika's TypeScript — real Codex/OMP tuning works without either adapter hardcoding a
  flag name.
- A shared `providers.<name>.command` used by both an issue-driven Project and a Routine must wrap
  any per-routine tag in a `{{#tag}}...{{/tag}}` section — a bare `{{model}}` renders to an empty
  string for the issue-Run path (which never resolves `model`), which can corrupt the surrounding
  flag once parsed into argv, rather than erroring.
- A progressing firing can still exceed its declared deadline; a non-progressing firing can still
  trip the Watchdog first. Neither policy replaces the other.
- Restricted or interactive Routine permission modes remain unsupported by design.
- A firing that times out during workspace preparation leaves its `git` clone/fetch running
  unattended; because `ensureRepositoryCache` serializes callers per project repository cache, that
  abandoned work can delay the next firing's or Run's workspace preparation for the same project
  (#353).
