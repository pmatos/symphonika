# Watchdog: payload-free provider progress markers and an mtime opt-in

ADR 0054 defined the Watchdog's Progress Signal as an any-of rule over five observations, and
ADR 0086 fixed two of them for Codex — `last_tool_call_at` via the `item/started` mapping and
`output_tokens_total` via the cumulative `tokenUsage.total` accessor. Issue #584 shows what those
fixes did not reach: an agent blocked inside a long shell command is still invisible, because the
two Codex notifications that prove it is alive were discarded by the normalizer, and the workspace
signal is structurally dead for every compiled-language project.

Run `07ba3899-3da9-47c3-9357-aaae1f54af1e` (vow issue #1108, `build_pr.implementing`) is the
evidence. Its two longest windows with zero raw provider events of any kind were 29.9 minutes
(09:16:23 → 09:46:15) and 26.9 minutes (08:40:21 → 09:07:16), against a 30-minute default grace.
The agent was not idle: the commands bracketing those gaps were
`cargo test -p vow-verify emit_unwrap_panic_as_failed_obligation`,
`./target/release/vow verify tests/verify-skip/unwrap_panic_effect.vow`, and then
`ps -eo pid,ppid,stat,etime,wchan:24,cmd` — the agent diagnosing its own stuck verification. It had
already committed two real commits. The run resumed emitting at 09:46:15 and was killed at
09:46:48, **33 seconds later**. Under ADR 0086 the two `item/started` events in that final window
save it — by 33 seconds. That margin is the finding: legitimate verification work sits within a
minute of the threshold, and a gap slightly longer than the grace still kills a healthy run.

Two notification streams carried liveness through the whole gap and reached nothing.
`mapCodexJsonRpcMessage` handled seven methods and dropped everything else to a bare `{ raw }`:

- **`item/commandExecution/outputDelta`** — a build or test suite streaming output. The run above
  emitted 563; none produced a progress signal.
- **`turn/diff/updated`** — literally "the workspace diff changed", the most direct progress
  evidence in the stream. 84 in the same run, all dropped.

Separately, `WORKSPACE_EXCLUDED_DIRS` unconditionally skips `target`, `build`, `dist`, `out`,
`_build`, `node_modules` and more, and there is no way to opt back in: `mtime_ignore` globs and the
Workflow Contract's `evidence.ignore` list are both *additive*, feeding filters that only ever
remove paths from the walk. For a Rust project every byte of build progress lands in `target/`, so
`workspace_digest` is frozen for the entire duration of a `cargo build`.

## Decision

### A sixth signal: `last_progress_at`

The normalized event vocabulary gains a **`progress`** type: a payload-free, timestamped liveness
marker carrying only a `signal` field naming its source. The Codex provider emits one for
`item/commandExecution/outputDelta` (`signal: "command_output"`) and for `turn/diff/updated`
(`signal: "workspace_diff"`). The Watchdog samples `last_progress_at` the way it samples
`last_tool_call_at` and `last_message_at`, and an advance is progress under the ADR 0054 any-of
rule.

The marker deliberately carries no payload. The command output and the diff are already in the raw
log verbatim; putting them in the Normalized Event Log would duplicate whole build transcripts and
workspace diffs into a log whose readers want structure, not bulk. This is the same projection
`codexToolCallInput` already applies to `commandExecution` and `fileChange` tool calls.

Markers are **rate-limited to one per five seconds per Run attempt**. This is not cosmetic: a
normalized event costs a Normalized Event Log line *and* a `provider_events` row that stores the
originating raw notification verbatim, so an unthrottled mapping would move an entire build
transcript into the run store — the one place the projection above was designed to keep it out of.
Suppressed notifications still reach the raw log. Five seconds is far below the Watchdog's default
60-second sample interval, so no sample window that saw activity can read as idle.

Claude and Oh My Pi emit no equivalent notification today and are unaffected; the signal reads
`null` for them, which the any-of rule already tolerates.

### An mtime opt-in: `watchdog.mtime_include`

The built-in exclusion set stays. It is well-motivated — ADR 0086 records how a rebuild-and-crash
cycle kept a wedged Run's workspace signal alive for fourteen hours — and the layered ignore
filters that surround it are all subtractive by design.

What is added is a single subtractive-set escape hatch: `watchdog.mtime_include`, a list of
workspace-relative directories that stay in the walk despite the built-in names. It is configurable
at daemon scope and per Project (a Project-level list replaces the daemon list rather than adding
to it, matching how the other Project overrides merge). It is empty by default.

An included tree suppresses the built-in name exclusions for **everything beneath it**, not just
its own entry. A Rust `target/` contains `build/` and `deps/` directories that the built-in set
would otherwise prune again one level down, which would leave the opt-in doing almost nothing.
Explicit ignores still win everywhere: an `evidence.ignore` directory match or an `mtime_ignore`
glob match removes a path whether or not it sits inside an included tree, so a repository can name
a noisy subtree back out.

Opting a build tree in is a real trade, which is why it is not the default. The walk becomes
proportionally more expensive on every tick, and that tree's churn now counts as progress. The
false-positive risk is smaller than it was under ADR 0054, because ADR 0086 replaced bare mtime
advance with a digest over `relative-path:size` pairs: a rebuild that reproduces byte-identical
output no longer reads as progress. It is not zero — a crash loop that produces *differently*
sized output each cycle still looks alive — so the event-stream signals above are the preferred
answer and `mtime_include` is the fallback for a project whose build genuinely emits nothing on
its notification stream.

## Consequences

- The Codex provider gains an injectable clock so the rate limit is testable without sleeping.
- `watchdog_samples` and `watchdog_sample_history` gain a nullable `last_progress_at` column
  through the existing additive-column migration. Pre-upgrade rows read `null`, which the
  comparison treats as "no observation yet" exactly like the other timestamp signals.
- `show-run`, the HTTP run page, and the local UI render the new signal beside the others, so an
  operator can see which signal is carrying a Run.
- Replayed against the incident window, a 35-minute gap in the tool-call and message streams that
  carries command output no longer produces a `no_progress` verdict; the same window without the
  markers still does.

## Interaction with existing decisions

- **ADR 0054 (progress liveness):** unchanged as a rule; the any-of list grows a sixth signal and
  its provider-emission table is corrected to describe what each provider actually sends.
- **ADR 0086 (convergence budget):** unaffected. The budget is checked before the liveness clock
  and independently of it, so a better liveness signal cannot keep a non-converging Run alive.
- **ADR 0003 (raw and normalized events):** upheld — the raw notification stays verbatim in the raw
  log and only a projection is normalized.
- **ADR 0015 (full-permission execution):** the Watchdog still only observes.

## Alternatives considered

**Map the notifications to `tool_call`.** Cheapest change, but it corrupts a signal operators read
directly: `show-run` would report a tool call that never happened, and the status dashboard would
name a tool that does not exist.

**Raise `grace_minutes` per Project.** Already the operational workaround (vow runs at 180). It
trades detection latency on genuinely wedged Runs for survival of healthy ones. Better signals let
the grace stay short, which is the point.

**Drop the built-in exclusion set.** Rejected. It is what stops a rebuild loop from masquerading as
progress, and the incident it was written for is more recent than this one.

## Numbering

ADR `0086` is the most recent number in tree; this ADR is `0087`.
