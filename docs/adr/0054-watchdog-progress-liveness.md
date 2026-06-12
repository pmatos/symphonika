# Watchdog: progress-based liveness for active runs

Symphonika treats a Run as alive whenever its Agent Provider keeps emitting events. In practice
that is a heartbeat, not a progress signal. A real incident exposed the gap: a provider streamed
`usage_updated` and `rate_limit_updated` for over five hours while looping on a `write_stdin`
poll against a process from a different workspace, with zero `tool_call` events, no workspace
writes after the first thirty minutes, and a single `turnId` whose cumulative input crossed 20M
tokens (mostly cached). The Run stayed in `state = "running"` because no terminal event reached
the FSM, and `reconcileActiveRuns` only re-checks GitHub issue eligibility — it has no view on
whether the provider is doing useful work.

## Decision

Symphonika gains a per-Run **Watchdog** that runs on the daemon's reconciliation tick, samples
a **Progress Signal** for each active Run, and transitions the Run to the existing `stale` state
with `terminal_reason = "no_progress"` when no observed signal advances within a configured grace
window. Provider cancellation runs through the existing `activeRuns.requestCancel` path, and the
Workspace is left intact for operator inspection.

`stale` is preserved as an operator-actionable, non-auto-retried verdict (ADR 0020, ADR 0038).
`no_progress` is not a transient failure classification; the retry path defined in ADR 0020 must
not re-launch the attempt automatically. Operators clear `no_progress` Runs the same way they
clear other `stale` Runs today.

## What counts as progress

A Progress Signal is the tuple:

- `last_tool_call_at` — timestamp of the most recent `NormalizedProviderEventType = "tool_call"`
  event.
- `workspace_mtime_max` — maximum file mtime under the Run's `workspacePath`, with `.git/`,
  `target/`, `node_modules/`, and any workspace-relative glob listed in the watchdog config's
  `mtime_ignore` set excluded so build-output churn neither masks real stalls nor forces them. The
  exclude set lives in the `watchdog` service config (below), which the reload pipeline already
  validates and persists — not in the Workflow Contract, whose parsed front matter the contract
  loader discards.
- `turn_id_set_size` — distinct `turnId` values observed across `usage_updated` and
  `turn_completed` events. Only the Codex provider tags these events with a `turnId`; the Claude
  provider emits `sessionId` instead, so this signal advances for Codex Runs only. Claude Runs
  stay covered by the permissive any-of rule below via signals 1, 2, and 4.
- `output_token_growth_since_last_sample` — cumulative output tokens from `usage_updated` events
  added since the previous Watchdog sample, over the events read forward from that sample's stored
  offset (a one-`sample_interval_seconds` window, 60 s by default). Output tokens are read from the
  normalized `usage_updated.tokenUsage` object, whose shape is provider-specific —
  `tokenUsage.output_tokens` for Claude and `tokenUsage.outputTokens` for Codex — so the Watchdog
  uses a provider-neutral accessor over those keys rather than a fixed `tokenUsage.total.outputTokens`
  path, which exists for neither provider. Both providers report `tokenUsage` as a cumulative
  running total, not a per-event increment, so the Watchdog persists the last observed cumulative
  output-token total in the `WatchdogSample` and treats this signal as advancing only when the
  latest cumulative total strictly exceeds the stored one — a wedged provider re-emitting an
  unchanged total is correctly read as zero growth. The progress rule only asks whether the total
  strictly increased, so the short default interval keeps stall detection responsive without
  maintaining a longer rolling window.

A Run is making progress on tick *t* iff **any** of the following advanced since the previous
Watchdog sample:

1. `last_tool_call_at` increased, or
2. `workspace_mtime_max` advanced by at least one second, or
3. `turn_id_set_size` increased, or
4. `output_token_growth_since_last_sample` is non-zero.

The rule is deliberately permissive. A long ESBMC `make verify` emits no `tool_call` and no
`usage_updated`, but its child processes write to the workspace; the mtime check keeps it alive.
A model loop that emits `usage_updated` and `rate_limit_updated` forever without tools, writes,
new turns, or output tokens fails the rule and is stopped.

`(usage_updated + rate_limit_updated)` events alone do **not** satisfy the progress rule. That is
the entire point of the ADR: a wedged provider can emit those forever without observable
side-effects.

## Configuration

Service config grows a `watchdog` block under the daemon, with per-Project overrides:

```yaml
watchdog:
  enabled: true
  grace_minutes: 30
  sample_interval_seconds: 60
  mtime_ignore: []         # extra workspace-relative globs excluded from the mtime walk
projects:
  - name: vow
    watchdog:
      grace_minutes: 180   # ESBMC verification can legitimately silence tools for hours
```

Defaults are safe-by-default: 30 minutes of no observable progress is well above any realistic
agent latency for normal tool-using work and below the threshold at which operators have
historically intervened manually. `enabled: false` reproduces today's behavior exactly. Project
overrides are merged via the same defensive reload pipeline as the rest of the Service Config,
so a bad override falls back to the last known-good snapshot rather than disabling the Watchdog
silently.

## Sampling and persistence

The Watchdog runs alongside `reconcileActiveRuns` and `reconcileWaitingRuns` in the
reconciliation phase. For each Run in `ACTIVE_STATES` whose `state` is not `waiting` (`waiting`
Runs are in `ACTIVE_STATES` per ADR 0047 but are parked by design and excluded from sampling —
see the ADR 0047 interaction below), it:

1. Reads the previous `WatchdogSample` from the run-store (the Run's `created_at` is the implicit
   zero before the first sample).
2. Computes a fresh Progress Signal. The Normalized Event Log is read forward from the previous
   sample's stored offset; the workspace stat walk uses a single `fs.readdir` per directory with
   the exclude set applied at the directory level so an excluded `target/` tree is never
   descended.
3. If progress was observed, writes the new sample and clears any persisted `idle_since`.
4. If no progress was observed, `idle_since` is already set, and `now - idle_since >= grace_minutes`,
   transitions the Run to `stale` with `terminal_reason = "no_progress"` and calls
   `activeRuns.requestCancel`. The `idle_since`-is-set guard matters: on the first idle tick
   `idle_since` is still unset (step 3 clears it on progress), so this branch is skipped and the
   clock is started in step 5 rather than tripping the threshold immediately.
5. Otherwise persists the still-idle sample, setting `idle_since` on the first idle observation
   (when it is still unset) so the grace clock starts on first idle and survives restarts.

Sampling is bounded work: the event log is never re-scanned in full, and the workspace walk skips
known build-output directories at the top of the descent rather than per file.

## Operator surface

`no_progress` joins the terminal-reason vocabulary. `runs` and `show-run` already render
`terminal_reason`. `status` and the local UI gain a "watchdog idle" badge derived from the
persisted `idle_since` so operators can see Runs approaching the threshold before they are
stopped. `show-run` exposes the most recent Progress Signal so an operator can verify why the
Watchdog fired (e.g. "last tool_call 4h12m ago, workspace mtime 4h08m ago, single turnId,
0 output tokens since last sample").

## Interaction with existing lifecycle decisions

- **ADR 0020 (retry transient only):** `no_progress` is not classified as transient. The
  Watchdog-stopped attempt is the terminal verdict for that Run.
- **ADR 0038 (explicit stale clearing):** `stale` Runs stopped by the Watchdog follow the same
  operator-clearing path as other `stale` Runs; there is no auto-clear TTL.
- **ADR 0046 (state advance vs continuation):** State Advance walks are subject to the same
  Watchdog rule. The FSM does not need to know about Watchdog termination; `state = stale` with
  `terminal_reason = no_progress` is observable like any other terminal state.
- **ADR 0047 (poll-driven wait states):** Waiting rows are *not* sampled. A waiting Run is parked
  by design and has no provider to wedge; `reconcileWaitingRuns` already handles its lifecycle.
  Because `idle_since` is a persisted wall-clock timestamp and no sample runs while a Run is
  `waiting`, `idle_since` is cleared on entry to `waiting` so the grace window cannot accrue across
  an unsampled wait excursion — a Run returning to an active state starts its idle clock fresh on
  its next idle tick rather than inheriting pre-wait idle time.
- **ADR 0015 (full-permission agent execution):** The Watchdog observes, it does not constrain.
  It does not require sandbox isolation to function and does not change the full-permission
  posture.

## Scope of this ADR

This ADR records the decision to introduce progress-based liveness as a first-class lifecycle
concern. Two adjacent improvements identified during the same incident are intentionally **out
of scope** here and will land as separate ADRs once this slice has shipped and the operational
data it produces is in hand:

- **Per-turn token budget guard** — a different signal class that watches
  `(turnId, cumulative_input_tokens, output_token_total)` and terminates a Run when a single
  turn crosses a configured input-token ceiling. Different failure mode (degenerate within-turn
  context saturation, not absence of side-effects) and deserves its own threshold discussion.
- **Provider PID/process isolation** — running each Agent Provider in its own PID namespace so
  one Run's agent cannot observe or bind to processes belonging to another Run's workspace.
  This is a sandbox-shape decision adjacent to ADR 0015 and is independent of the Watchdog; the
  Watchdog detects the symptom regardless of whether isolation lands.

The Watchdog is the load-bearing first slice because it converts a class of currently-silent
failures (model loops, wedged shell tools, runaway polls, dead provider sessions still emitting
heartbeats) into terminal `stale` Runs that the existing operator surfaces already render.

## Numbering

ADR `0053` is the most recent number in tree; this ADR is `0054`.
