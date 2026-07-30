# Per-routine provider tuning and wall-clock firing timeout (issue #291)

Status: Accepted

## Context

Both live ptt routines being migrated (`new-composer`, `refactor-audit`) set `model`, `effort`,
`permission_mode`, and `timeout_minutes` per routine, and they differ from each other.
`providers.<name>.command` was a single global string per provider; a routine could override only
the provider *name* (`RoutineDeclaration.provider`), never its tuning. There was also no wall-clock
bound on a routine firing from any mechanism — the Watchdog (ADR 0054) is a progress-liveness check
scoped to the `runs` table and never observes `routine_firings` at all, so a wedged provider on a
live daemon ran forever.

Two decisions were explicitly flagged in the issue as "pick one or two implementations will fight":
how per-routine flags reach the provider, and how `permission_mode` maps across providers (Claude's
CLI-flag shape differs from Codex's, which has no equivalent CLI surface at all). This ADR records
both decisions, plus the timeout mechanism and the one-shot prompt seam that came with them.

**Reversal note:** the implementation plan's first draft recommended append-at-spawn (Symphonika
builds argv itself) and Claude-only scoping for `model`/`effort`, matching ptt's own precedent
(`build_argv` in `ptt/claude.py`). The operator explicitly chose the more general alternative for
both — command templating and provider-agnostic fields — recorded below. This is a deliberate
reversal, not an oversight.

## Decision

### Flag delivery: command templating, not append-at-spawn

`providers.<name>.command` gains Mustache-style tags the operator positions themselves: `{{model}}`,
`{{effort}}`, `{{permission_mode}}` as plain value substitutions, plus `{{#tag}}...{{/tag}}`
conditional sections that keep (and substitute) their contents when the field resolves to a value,
or are dropped entirely — delimiters included — when it does not. Plain tags alone cannot express
"omit this whole `--model X` segment when X is absent" without leaving a dangling incomplete flag in
argv; sections solve exactly this and are the one piece of syntax this engine adds beyond the
existing prompt-templating engine's flat `{{var}}` substitution (`src/workflow/autonomous-prompt.ts`).
Commands need section semantics that engine doesn't have and isn't scoped for, so this is a new,
small, self-contained module (`src/provider-command-template.ts`), not an extension of it.

Strictness matches the prompt-templating engine's existing posture (SPEC §5.3: "unknown variables
fail prompt rendering"): an unrecognized tag or an unbalanced/unterminated section throws
`ProviderCommandTemplateError` rather than being passed through as literal text — the string is
about to be spawned as a real child process argv, so silently leaving garbage in is worse than
failing loudly.

This makes Symphonika provider-agnostic by construction: it never needs to know Claude's vs. Codex's
vs. OMP's flag vocabulary. The operator encodes the mapping in their own authored command, exactly as
they already do today for Codex's `-c sandbox_mode=...`/`-c approval_policy=...` overrides. This is
what makes the next decision tractable without hardcoding any provider's flag names in TypeScript.

Rendering happens **upstream of the provider layer**, at every `validate()`/`runAttempt()` call
site — enumerated exhaustively during implementation, not "somewhere in run-controller.ts": two in
`src/routines/dispatcher.ts` (rendered with the firing's resolved values), two in
`src/lifecycle/run-controller.ts` (rendered with empty values — issue Runs never resolve
model/effort/permission_mode), and three in `src/doctor.ts` (one per-routine with resolved values,
two per-Project with empty values). Claude's `validate()` actually spawns a real `--help` probe
(`validateClaudeStreamJsonCommand`), so an unrendered template tag reaching it is a real failure, not
a harmless no-op — rendering must strictly precede all seven call sites.

### `model`/`effort`/`permission_mode` are provider-agnostic, not Claude-only

With templating, there is no Symphonika-side "does provider X support this field" code path to build
at all — whether a field has any effect is entirely determined by whether the operator's own command
template references it. Real Codex (and OMP) support falls out of this for free: an operator writes
`{{#model}}-c model="{{model}}" {{/model}}` in their own `providers.codex.command` and it works,
without Symphonika ever hardcoding Codex's `-c` key names.

A routine declaring a field its resolved provider's command template never references would
otherwise be a silent no-op — exactly the kind of unvalidated declaration the issue's acceptance
criteria warn against. `renderProviderCommandTemplate` returns `unreferencedFields` for this reason,
and the reload path (below) turns a non-empty result into a declaration-load error.

`permission_mode`'s schema still only accepts the literal `"bypass"` — this is unrelated to the
templating-vs-argv choice. `validateClaudeProtocolFlags` (`src/providers/claude.ts`) already
hard-requires `--dangerously-skip-permissions`/`--permission-mode bypassPermissions` present in
every Claude command; Codex already hardcodes `approvalPolicy: "never"`, `sandbox:
"danger-full-access"` for every `thread/start` call; OMP has its own always-bypass equivalent. No
non-bypass code path exists anywhere in this codebase to route a different value to, matching
CLAUDE.md's "keep provider execution full-permission by default" posture. Both live ptt routines only
ever declare `bypass`. The enum is forward-compatible (widen it later) without building an
unsupported code path today.

Because that enforcement is already independent of templating, `permission_mode` is the one field
**excluded** from the `unreferencedFields` check described below: an untemplated `permission_mode`
(whether declared directly on a routine or inherited from `routine_defaults:`) is redundant, not
silently inert, so it never produces a declaration-load error. `model`/`effort` remain checked — an
untemplated `model` really would be silently ignored, since nothing else in the codebase applies it.
Without this exclusion, the `routine_defaults: { permission_mode: bypass }` example below would fail
its own reload check for every routine, since `--dangerously-skip-permissions` is hardcoded rather
than templated in the shipped `providers.claude.command`.

### Reload-time cross-check replaces per-provider rejection logic

Rather than rejecting `model`/`effort` for non-Claude routines at declaration-load time (the
original Claude-only draft), `loadRuntimeConfigSnapshot` (`src/reload.ts`) renders each attached
routine's resolved provider command against its resolved `model`/`effort`/`permission_mode` once
both `routines:` and `providers:`/`routine_defaults:` are parsed — the earliest point both are known
together. A thrown `ProviderCommandTemplateError` (unknown tag, malformed section) or a non-empty
`unreferencedFields` result becomes a declaration-load error through the existing per-routine
carry-forward error surface (SPEC §5.4) — the same mechanism a bad cron expression already uses.
`doctor` performs the identical check for its own manually-invoked diagnostic pass, for routines that
declare an explicit `provider:` override. This is strictly more general than a hardcoded Claude-only
check: it works for any provider, because it asks "does the *actual authored template* use this
field" rather than "is the provider Claude." **Pre-existing gap, not introduced here:**
`validateServiceRoutines`'s provider-command validation (including this new cross-check) is gated on
`routine.provider !== null` (`src/doctor.ts`) and has never resolved a routine's *effective* provider
(`routine.provider ?? project.agent.provider`) the way `reload.ts` does — a routine relying on its
Project's provider, which is every routine in the shipped SPEC §5.1 example and both live ptt
routines, gets this cross-check from `reload` (the path the acceptance criteria actually require) but
not from a standalone `doctor` run. Closing that gap is separate follow-up, out of scope here.

### Service-level `routine_defaults:` fallback

A new top-level `routine_defaults:` block (schema: `model`, `effort`, `permission_mode`,
`timeout_minutes`, all optional) is the second fallback tier: a routine's own front-matter value
wins per-field, else `routine_defaults:`, else no flag is templated and no timeout is armed.
`resolveRoutineExecutionConfig` (`src/reload.ts`) mirrors `resolveWatchdogConfig`'s existing
per-field-fallback shape exactly.

### Wall-clock timeout via the existing cancel plumbing, not a bespoke kill

A `setTimeout`, armed inside `runRoutineFiring` immediately after `activeRuns.attachProvider` (so the
cancel handle exists before the timer can possibly fire), calls
`activeRuns.requestCancel(firingId, "firing_timeout")` on elapse — the identical mechanism operator
cancellation already uses, which resolves through `provider.cancel()` to
`shutdownProviderProcess(child, undefined, "cancellation")`, the process-group SIGTERM→SIGKILL
escalation from PR #341 (issue #300). A bespoke `child.kill()` from a raw timer would bypass the
reserved-process-group bookkeeping and race with `cancel()`/daemon shutdown.

`"firing_timeout"` is a new `CancelReason` value (`src/run-store.ts`) — a plain TypeScript union with
no DB `CHECK` constraint, so this is additive. The two outcome-determination sites in
`runRoutineFiring` (the success path and the catch block), which otherwise collapse *any*
`cancelRequested === true` into the generic `state: "cancelled", reason: "cancelled"`, now special-
case `cancelReason === "firing_timeout"` into `state: "failed", reason: "firing_timeout"` — the one
hardcoded detail the issue's acceptance criteria require overriding, so a timeout is distinguishable
from an ordinary operator/`daemon_shutdown` cancel.

**Scope boundary:** the timer bounds only the provider's execution window (armed once the firing
transitions toward `running`), not workspace preparation. `prepareRoutineWorkspace`'s git operations
have no `execFile` timeout anywhere in that path today — this matches the issue's own framing, which
is specifically about *the provider* wedging, not about git operations hanging. Bounding workspace
prep too is separate follow-up work if it becomes a real problem.

**Complementary, not overlapping, with the Watchdog (ADR 0054):** `listWatchdogCandidateRuns()`
queries only the `runs` table; `routine_firings` is never touched by `reconcileWatchdog`, and this
issue does not change that (issue #269, still open, is the separate work to make the Watchdog cover
routine firings at all). This timeout is a *declared deadline* — kill at N minutes regardless of
progress — not a liveness check.

### Anti-backgrounding guards — Claude-only, narrow mechanism

Every Claude Routine Firing passes `--disallowedTools ScheduleWakeup Monitor CronCreate` (appended
last in argv — variadic, consumes only what follows) and sets
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the spawned environment, unconditionally — not gated on
whether the routine declared `model`/`effort`/`permission_mode`. These are not declared per-routine
fields, so they do not go through `renderProviderCommandTemplate`: baking them into a shared
`providers.claude.command` string would also apply to any issue-driven Project using
`agent.provider: claude` sharing that same command. Instead, `ProviderRunInput` gains a narrow
`executionOptions?: { disableBackgroundTasks?: boolean; disallowedTools?: readonly string[] }` field
that `src/routines/dispatcher.ts` sets only when `providerName === "claude"`; issue Runs never set it
and are unaffected. `spawnProviderProcess` (`src/providers/provider-process.ts`) gained an optional
`env` parameter to carry the extra environment variable through both the POSIX supervisor-spawn path
and the win32 direct-spawn path.

### One-shot prompt notice — routine-only seam, not the shared preamble

The issue's third guard — a prompt-level statement that the run is one-shot and will not be
re-invoked — is provider-neutral, but must **not** be folded into the shared `AUTONOMY_PREAMBLE`
constant (`src/workflow/autonomous-prompt.ts`), imported verbatim by both routine prompts
(`src/routines/prompt-renderer.ts`) and issue-Run prompts. Issue Runs demonstrably are not one-shot —
`renderAutonomousPrompt` has an explicit `continuation`/`previousAttemptNotice()` path for resumed
attempts — so editing the shared constant would inject a factually wrong claim into every issue-Run
prompt. `RoutinePromptInput` instead gains an `extraInstructions?: string` field (mirroring
`renderAutonomousPrompt`'s own `extraInstructions` parameter, which `renderRoutinePrompt` previously
lacked), and `dispatcher.ts` passes a new exported `ROUTINE_ONE_SHOT_NOTICE` constant — routine
firings really are one-shot (`runRoutineFiring` has no resume/continuation concept at all).

## Consequences

- `providers.<name>.command` gains an operator-facing templating dialect (plain tags + conditional
  sections) distinct from, and not sharing an implementation with, the existing prompt-templating
  engine. Two templating dialects now exist in the codebase for two different value spaces (command
  strings vs. prompt bodies); both are strict-unknown-tag by design.
- A shared `providers.<name>.command` string used by both an issue-driven Project and a routine is
  rendered for both; a bare `{{model}}` outside a section does not throw for the issue-Run path
  (which never resolves `model`) — it silently substitutes an empty string, which can truncate or
  corrupt the surrounding flag once the string is tokenized into argv. Operators must always wrap
  optional per-routine tags in `{{#tag}}...{{/tag}}` sections unless the command is never shared with
  an issue-driven Project.
- `src/init.ts` still scaffolds untemplated `providers.<name>.command` strings for a fresh install;
  per-routine `model`/`effort`/`permission_mode` tuning requires hand-editing the generated config to
  add template tags. Post-fix, declaring a field the (still-untemplated) command never references is
  a loud, specific reload error naming the offending field and command — discoverable, not silent —
  so this is a usability gap, not a correctness one.
- `routine_firings.provider_command` stores the **unrendered** template (mirroring the issue-Run
  evidence-storage convention of storing the raw command), so a firing's durable evidence shows
  `{{#model}}...{{/model}}` rather than the command that actually ran. A future debugging aid could
  store the rendered form alongside it; not done here.
- `symphonika.example.yml` and SPEC §5.1's example show the templated `providers:` syntax and a
  `routine_defaults:` block reflecting the live ptt routines' shared `permission_mode: bypass`,
  `timeout_minutes: 60`.
- Real Codex/OMP model/effort support exists without any Codex/OMP-specific TypeScript code — the
  operator's own command template carries that knowledge.
- The ptt-migration mapping doc (the issue's "archive slice") is not produced by this work; nothing
  in `docs/` maps ptt TOML fields to Symphonika's front matter today. This ADR resolves the
  *capability* (both live routines' settings become expressible); the mapping doc is tracked
  separately under the parent epic (#289).
- #269 (Watchdog liveness for routine firings) remains open and untouched; this ADR's timeout is
  complementary, not a substitute.
