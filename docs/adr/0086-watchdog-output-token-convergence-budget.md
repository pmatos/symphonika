# Watchdog: an output-token convergence budget distinct from liveness

ADR 0054 gave Symphonika a Watchdog that stops a Run when nothing observable happens. A real
incident (issue #548, underlying crash loop vow-lang/vow#1065) showed the gap on the other side:
two consecutive Runs against vow#1055 spent 6.5 and 14.2 hours re-running a failing
build/verify cycle. Both had to be killed by hand. Neither was ever idle for a single sample.

Replaying the preserved Watchdog history (78 samples for Run
`8f222c49-bd94-4f52-a5eb-fc5d628e755c`, 170 for Run `b533fbbc-56df-44c5-a4e4-c5e49bbce8d4`)
against the ADR 0054 rule produced **zero** samples where no signal advanced, and a longest
no-message streak of one sample (~5 minutes) against a 30-minute grace window. The Runs were
busy, not wedged: 560 distinct shell commands, 119 file edits, and 11 context compactions in the
second Run alone. The liveness rule worked exactly as specified and would never have fired.

Two of the three signals the incident *should* have been able to lean on were also dead:

- Codex reports cumulative output tokens at `tokenUsage.total.outputTokens`. The Watchdog's
  accessor read only a top-level `outputTokens`/`output_tokens`/`output`, so signal 4 persisted
  `0` on every sample while the Runs actually produced 194,639 and 412,731 output tokens. (ADR
  0054 states that the nested path "exists for neither provider"; the preserved provider log
  contradicts that, and this ADR corrects it.)
- The Codex provider mapped `item/completed` to a raw-only event, so no normalized `tool_call`
  event was ever emitted and signal 1 was permanently null for Codex Runs. The raw log for the
  second Run holds 3,351 such items.
- `turn_id_set_size` stayed at 1 for the whole fourteen hours, because Codex ran the work as a
  single turn.

## Decision

Symphonika gains a second, independent Watchdog rule: a **convergence budget** on the cumulative
output tokens one Run attempt may spend. When a `running` Run's sampled `output_tokens_total`
reaches the budget, the Watchdog transitions it to `stale` with
`terminal_reason = "no_convergence"` and cancels the provider through the existing
`activeRuns.requestCancel` path, leaving the Workspace intact.

The budget is **attempt-scoped**, following the rest of the Progress Signal: attempt start clears
the latest sample and a normalized-log path change resets the token baseline (ADR 0054). A
transient retry under ADR 0020 therefore starts with a fresh budget, which is correct — a retry
exists because the previous attempt failed for a reason unrelated to how much work it did. It is
not a loophole for the incident this ADR addresses: `no_convergence` is deterministic, so the
attempt it stops is never retried.

The default budget is **150,000 output tokens**, configurable at daemon scope and per Project.
Replayed against the incident, that fires at 5.3 hours into Run 1 and 3.9 hours into Run 2 —
both well before an operator had to intervene, and both after enough work that a converging Run
of ordinary size is untouched. `0` disables the guard and reproduces ADR 0054 behaviour exactly.

Replaying both preserved Normalized Event Logs through the implemented sampler reads 194,639 and
412,731 output tokens (zero under the old accessor) and terminates both Runs with
`terminal_reason = "no_convergence"` at the default budget.

A stopped Run also stays stopped. The Watchdog cancel path removes `sym:running` but deliberately
does not release `sym:claimed` (only closed-issue and eligibility-loss cancellations do), and
`sym:claimed` is one of the Operational Labels that make an Issue ineligible for dispatch. The
Issue is therefore not re-claimed on the next poll, so the guard cannot degenerate into restarting
the same non-converging work with a fresh budget. That matters here specifically: the fourteen-hour
Run was itself an auto-spawned continuation of the six-hour one.

`no_convergence` is a distinct terminal reason, not a variant of `no_progress`. The two verdicts
describe opposite failure modes — "nothing observable happened" versus "a great deal happened,
none of it finishing" — and keeping them separate is what makes the budget tunable from
operational data. Like `no_progress` it is **not** a transient failure classification: the ADR
0020 retry path must not re-launch the attempt, and operators clear it the same way they clear
any other `stale` Run (ADR 0038).

### Why a token budget and not the alternatives

| Candidate | Run 1 (6.5h) | Run 2 (14.2h) | Verdict |
| --- | --- | --- | --- |
| Output-token budget 150k | fires at 5.3h | fires at 3.9h | **chosen** |
| Wall-clock deadline 4h | fires at 4h | fires at 4h | blunt: kills legitimately long verify-heavy Runs at the same threshold |
| Wall-clock deadline 8h | never | fires at 8h | misses Run 1 |
| Context compactions >= 5 | never (4 total) | fires at 5.45h | misses Run 1; needs a new normalized event per provider |
| Repeated command fingerprint (>=10 in 2h) | ~5.2h | ~3.5h | the worst offenders were legitimate CI polls (`gh pr checks`), and 560 distinct commands is not a tight loop |

The budget scales with the work the model actually performed rather than with wall-clock time, so
a Project whose Runs legitimately sit inside a long silent `make verify` is unaffected — that Run
spends hours without spending tokens.

## What the workspace signal now means

ADR 0054's signal 2 read a bare advance of `workspace_mtime_max`. The incident's Workspace wrote
generated output into `build/` and `vow/build/` with an empty `evidence.ignore`, so a
rebuild-and-crash cycle refreshed mtimes on every pass while carrying no new information. Bare
mtime is therefore replaced by a **workspace digest**: a hash over the sorted
`relative-path:size` pairs of every non-excluded file. Progress on signal 2 is a change in that
digest — a file appearing, disappearing, or changing size — not a restamp of identical output.

`workspace_mtime_max` is still sampled and still surfaced to operators; it simply no longer
decides the signal on its own. An empty stored digest is a pre-upgrade row rather than an
observation, and is never read as a change.

The built-in directory exclusion set grows beyond `.git/`, `target/`, and `node_modules/` to
cover the build and tool output directories Symphonika's dispatch targets actually produce:
`.cache`, `.gradle`, `.mypy_cache`, `.next`, `.nyc_output`, `.pytest_cache`, `.ruff_cache`,
`.stack-work`, `.tox`, `.turbo`, `.venv`, `__pycache__`, `_build`, `build`, `coverage`, `dist`,
`out`, and `venv`. A repository still adds its own trees through the Workflow Contract's
`evidence.ignore` list, and `watchdog.mtime_ignore` still filters individual files.

Excluding a directory can only make the Watchdog stricter, never more permissive. A Run whose
sole output lands in an excluded tree keeps the other four signals, the 30-minute grace window,
and its Project's `evidence.ignore` escape hatch.

## Provider observation fixes this decision depends on

The budget is only meaningful if output tokens are actually observed, so two ADR 0054 signals are
repaired as part of this decision:

- The output-token accessor becomes shape-aware. A nested `tokenUsage.total.outputTokens` is a
  cumulative running total and is taken as an absolute value; a top-level
  `outputTokens`/`output_tokens`/`output` is one completed assistant message's output and is
  added. Both reduce to a true cumulative per attempt, which is what the budget compares against.
  This also corrects the previous top-level-only reading, under which Claude's per-message counts
  were folded with `Math.max` rather than summed.
- The Codex provider emits a normalized `tool_call` for `item/started` items of type
  `commandExecution`, `fileChange`, and `webSearch` — the analogue of Claude's `tool_use` block,
  marking the moment the model issued the call. Only a small projection of each item is
  normalized (command and cwd, changed paths, or query); diffs and aggregated command output stay
  in the raw log that already holds them verbatim.

Making signal 1 live is strictly more permissive for the liveness rule on Codex Runs. That is the
correct reading of ADR 0054, and the convergence budget is what now covers the busy-but-wedged
case that signal was never going to catch.

## Configuration

```yaml
watchdog:
  enabled: true
  grace_minutes: 30
  output_token_budget: 150000   # 0 disables the convergence guard
  sample_interval_seconds: 60
  mtime_ignore: []
projects:
  - name: vow
    watchdog:
      grace_minutes: 180
      output_token_budget: 400000
```

Both per-Project keys are optional and merge independently over the daemon-scope block through
the same defensive reload pipeline as the rest of the Service Config, so a bad override falls
back to the last known-good snapshot. As with `grace_minutes`, a Project cannot opt into a
daemon-disabled Watchdog.

## Operator surface

`no_convergence` joins the terminal-reason vocabulary everywhere `no_progress` already appears —
the `runs` listing, `show-run`, `status`, the HTTP API, and the local web UI — because those
surfaces render `terminal_reason` verbatim rather than from an allow-list. `show-run` and the web
UI's Watchdog section additionally render the Run's cumulative output tokens against its budget
whenever a budget is configured, so an operator can see a Run approaching the ceiling before it
is stopped.

## Interaction with existing decisions

- **ADR 0054 (progress liveness):** unchanged as a rule, with signal 2 redefined as above and its
  claim about Codex's `tokenUsage` shape corrected. The convergence budget is checked before the
  liveness clock and independently of it, because a non-converging Run is never idle.
- **ADR 0020 (retry transient only):** `no_convergence` is deterministic. The stopped attempt is
  the terminal verdict.
- **ADR 0038 (explicit stale clearing):** operators clear it like any other `stale` Run; there is
  no auto-clear TTL.
- **ADR 0019 (capped continuations):** a `no_convergence` Run is terminal, so it spawns no
  continuation.
- **ADR 0015 (full-permission execution):** the Watchdog still only observes.

## Deferred

The per-turn input-token budget ADR 0054 deferred stays deferred; the failure it targets
(degenerate within-turn context saturation) is distinct from a Run that keeps producing output
without converging, and the incident data does not yet justify a second threshold.

## Numbering

ADR `0085` is the most recent number in tree; this ADR is `0086`.
