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

**Second amendment note:** `permission_mode` was broadened from accepting only the literal `bypass`
to any non-empty string, and the Claude/OMP adapters' static command validation no longer inspects
which permission-mode value the operator chose — only the wire-protocol flags each adapter's parser
requires (see ADR 0015/SPEC.md §11.3, "protocol conformance, not policy"). The prior design
hardcoded `bypass` because it was the only value any provider CLI supported at the time and every
adapter statically rejected an authored command that used anything else; both premises turned out
false (Claude's own `--permission-mode auto` is a supported, headless-compatible mode the static
gate rejected outright) and, on principle, a value gate that must be updated by hand every time a
provider ships a new mode is exactly the kind of policy Symphonika should not be encoding in
TypeScript. `permission_mode` now works exactly like `model`/`effort`: free-form, operator-authored,
templated, and unenforced beyond "non-empty string." The complementary check for "does this command
actually work" moved to an opt-in functional probe, `doctor --live-check <provider>`, which spawns
the real command with a trivial prompt and waits for a reply — see SPEC.md §11.3. Everything else in
this ADR is unchanged.

**Third amendment note:** a Routine Firing now passes the authored provider command and its resolved
`model`, `effort`, and `permission_mode` to the adapter's `validate()` pre-flight probe. The earlier
contract passed the template without values, whose adapter-level empty-value render removed every
routine-only section; an unsupported routine-specific flag or value could therefore bypass
validation and reach `runAttempt`. `validate()` now accepts optional template values and renders the
command exactly once; issue-driven or provider-level validation still defaults to empty values.

**Fourth amendment note:** Routine Firing Deadline expiry now cooperatively cancels workspace
preparation as well as provider execution. The deadline's `AbortSignal` reaches the shared cache
clone/fetch and firing-specific branch/worktree Git commands, and the dispatcher awaits preparation
settlement before recording the timeout. First-cache clones publish atomically from an owned staging
directory so abort cleanup cannot leave a partial bare repository at the shared cache path. On
POSIX, cancellable Git commands run as separate process groups with bounded `SIGTERM` to `SIGKILL`
escalation, so transports, hooks, and helpers cannot continue executing after preparation settles;
Linux groups with only zombie members count as stopped even when PID 1 delays reaping them. Staging
modes follow the process umask, and incomplete owned-path cleanup is surfaced without replacing the
deadline's terminal classification. This resolves the temporary limitation tracked in #353.

## Context

The live ptt routines require different model, effort, permission, and 60-minute execution
settings. Symphonika previously selected only a provider name per Routine and had no wall-clock
bound for a Routine Firing. The Watchdog in ADR 0054 answers a different question—whether observable
progress stopped—and cannot substitute for a declared maximum duration.

Provider commands are operator-authored. `permission_mode` is asymmetric across providers: Claude and
OMP express it through a dedicated flag while Codex expresses full permission through different
startup settings — so `permission_mode` need not be reflected in every command, and Symphonika does
not constrain which value it takes (see second amendment note above).

## Decision

Routine front matter and the top-level `routine_defaults:` Service Config block accept `model`,
`effort`, `permission_mode`, and `timeout_minutes`. Front matter wins over service defaults. An
omitted effective value does not change the corresponding provider command behavior.

`providers.<name>.command` gains Mustache-style template syntax the operator positions themselves:
plain tags (`{{model}}`, `{{effort}}`, `{{permission_mode}}`) substitute the resolved value, and
`{{#tag}}...{{/tag}}` conditional sections keep (and substitute) their contents only when the field
resolves to a value — the section form is what lets an operator omit a whole `--model X` segment
when `X` is absent, without a dangling incomplete flag. Each provider adapter renders the authored
command exactly once before parsing it into argv: `runAttempt` uses `input.routine` (or `{}` for
issue-driven Runs), while `validate()` uses its optional template values (or `{}` for provider-level
validation). A Routine Firing passes the authored command and the same resolved values to both
entrypoints, ensuring its pre-flight probe sees the same command-template result that `runAttempt`
derives without re-parsing substituted bytes. The operator's own authored command carries all
provider-specific flag knowledge; Symphonika's TypeScript never hardcodes Codex's `-c` keys or OMP's
flag names.

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
removed from `routines:`. `permission_mode` is exempt from this check: a routine may declare it
purely as documentation of intent without its resolved provider command referencing the tag, since
no provider currently requires it to appear in the command for full permission to take effect by
default (see second amendment note above).

`permission_mode` accepts any non-empty string — the operator's own choice of provider policy,
exactly like `model`/`effort`. Symphonika's default provider commands still carry a fixed
full-permission flag literally (see SPEC.md §11.3), preserving ADR 0015's posture as a default, not
as an enforced invariant on operator-overridden commands.

Every Claude Routine Firing also ensures one `--disallowedTools` option whose variadic values merge
any operator-authored restrictions with `ScheduleWakeup`, `Monitor`, and `CronCreate`, and sets
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
provider process exists. During workspace preparation, expiry aborts the stage's Git subprocesses
and awaits preparation settlement before the firing becomes terminal or releases its concurrency
slot. POSIX Git commands use their own process groups and bounded escalation so abort covers Git's
transports, hooks, and helpers; non-POSIX hosts retain direct-child abort behavior. Cache creation
clones to an invocation-owned sibling staging directory, applies the direct-clone mode derived from
the process umask, and atomically publishes a complete bare repository; abort removes the staging
directory, while an interrupted fetch preserves the already-validated shared cache. Cleanup likewise
removes only a newly-owned firing branch/worktree, never a reused one. Worktree cleanup uses
path-scoped `git worktree remove --force --force <path>` to override an owned registration's
SIGKILL-surviving `initializing` lock without running cache-wide `git worktree prune`. It verifies no
owned directory or worktree registration remains and surfaces any incomplete cleanup in logs while
preserving `firing_timeout` as the terminal reason.

## Consequences

- Operator commands remain reusable for issue Runs and are unchanged when Routine overrides are
  omitted (rendering with `{}` is a no-op for a command with no template tags).
- Routine-specific flags and values are rejected during pre-flight validation instead of first
  failing after `runAttempt` starts.
- Provider-specific argv vocabulary lives entirely in the operator's own `providers.<name>.command`,
  not in Symphonika's TypeScript — real Codex/OMP tuning works without either adapter hardcoding a
  flag name.
- A shared `providers.<name>.command` used by both an issue-driven Project and a Routine must wrap
  any per-routine tag in a `{{#tag}}...{{/tag}}` section — a bare `{{model}}` renders to an empty
  string for the issue-Run path (which never resolves `model`), which can corrupt the surrounding
  flag once parsed into argv, rather than erroring.
- A progressing firing can still exceed its declared deadline; a non-progressing firing can still
  trip the Watchdog first. Neither policy replaces the other.
- Symphonika no longer prevents an operator from configuring a restrictive or interactive permission
  mode; it is unenforced, not unsupported. A Routine still runs headless (`-p`, no
  `--permission-prompt-tool`), so a mode that relies on a human answering a prompt cannot make
  progress on gated actions in practice — the operator's own responsibility, not a Symphonika check.
- A firing that times out during workspace preparation retains its concurrency slot until the
  aborted Git command and owned-path cleanup settle. Later callers of the same repository cache can
  then proceed without awaiting abandoned work or repairing a partial clone.
