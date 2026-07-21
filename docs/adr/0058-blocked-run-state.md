# Split "agent correctly declined" out of the `failed` RunState

`RunState` (`src/run-store.ts`) had one value, `failed`, for two very different situations: a
provider crash, malformed event, workspace-prep error, or unexpected exit code (something actually
broke), and an agent that inspected the issue, correctly decided the task was not actionable (most
often because another Run had already superseded it), commented on the issue, and exited cleanly
with zero commits (nothing broke — the autonomy contract in ADR 0043 working as intended). Both
rendered identically: `sym:failed` on the GitHub issue, a red "failed" pill in the web UI
(`stateFamily()` in `src/http/pages.ts`), and the same line in the CLI status dashboard's Attention
section.

A sample of the last 50 Runs across all Projects found 17 `failed` Runs, of which 16 (94%) carried
`terminal_reason = "no_workspace_changes"` — the deterministic-no-commits outcome from
`classifyFailure` (`src/lifecycle/classify-failure.ts`), not a crash. Spending the alarming "failed"
signal on routine, correct declines trains operators to stop trusting it — including for the 6%
that are real failures. See issue #271 for the full incident writeup.

## Decision

`RunState` gains a `blocked` value, with a matching `sym:blocked` GitHub label (added to
`REQUIRED_OPERATIONAL_LABELS` in `src/operational-labels.ts`, alongside `sym:claimed`,
`sym:running`, `sym:failed`, `sym:stale`). `blocked` is the umbrella for "nothing broke, but an
operator still needs to look" — it covers both:

- **`no_workspace_changes`** — the agent exited 0 with zero commits ahead of base (§12.1 of
  `SPEC.md`). This is the common case from the incident data above.
- **`workflow_terminal_blocked`** — a raw FSM workflow reached a state whose `terminal` is
  `blocked` (`fsm-expansion.ts` already distinguishes `success` / `failure` / `blocked` terminal
  labels; only the last two were previously fused into RunState `failed` in
  `fuseWorkflowTerminal`). This covers the broader "stuck, needs a human decision" case — e.g. a
  PR follow-up workflow that cannot resolve merge conflicts or clear failing checks on its own.

`workspace_inspection_failed` (the `git rev-list` inspection command itself erroring) stays
`failed` — that is a real infrastructure problem, not a decline.

**Detection is reason-based, not a new outcome kind, and unconditional.** `ClassifiedTerminal.kind`
is untouched: both blocked reasons keep `kind: "failed"`, so every existing branch that reads
`kind`/`classification` for retry and scheduling decisions
(`deferRetryableTransientAdvance`, `willRetry`, `signalsFromTerminal`, the `fsmContinuing`
suppression, the transient-retry branch in `scheduleNext`) is provably unaffected — this issue is
explicit that retry/continuation scheduling must not change. A single reason-keyed helper,
`isBlockedOutcome` in `src/lifecycle/run-controller.ts`, checks
`outcome.reason ∈ {no_workspace_changes, workflow_terminal_blocked}` and is consulted only at the
points that decide the RunState to persist (`mapOutcomeToRunState`) and which GitHub label to write
(`applyTerminalLabels`, and its bail-out restore path in `scheduleNext`).

The mapping is unconditional on the reason string alone — there is no attempt to detect "the agent
left an explanatory issue comment" before downgrading a decline from `failed` to `blocked`. That
would require either a GitHub API round-trip during classification or pattern-matching on
provider tool-call events for a `gh issue comment` invocation; both are fragile, and a missed
detection would silently re-hide exactly the declines this ADR exists to surface. The reason string
is already a clean, race-free signal computed at classification time.

## Consequences

- **Eligibility is unchanged in shape.** `sym:blocked` is a required operational label exactly like
  `sym:failed`: present, it blocks re-dispatch (`evaluateProjectEligibility` in
  `src/issue-polling.ts` iterates `REQUIRED_OPERATIONAL_LABELS` uniformly); `init-project` /
  `doctor` provision it the same way (`OPERATIONAL_LABEL_DESCRIPTIONS` in `src/doctor.ts`). Whatever
  redispatch behavior an operator observed for `failed` issues today, they now observe for `blocked`
  issues under the new label — this ADR only renames which label/state represents the outcome, not
  when re-dispatch can happen.
- **Closed-issue cleanup** removes `sym:blocked` alongside `sym:failed` and `sym:claimed`, so a
  blocked issue that gets closed doesn't retain a stale label.
- **UI**: `stateFamily()` gains a `blocked` family with its own pill color (violet, distinct from
  the amber "in progress" and red "fail" families) in both the web dashboard and the CLI status
  dashboard's Attention/Recent sections. The run-detail outcome banner renders calmer copy ("Run
  blocked" instead of "Run failed") but still surfaces `terminal_reason`, since that's exactly what
  an operator needs to decide whether to close the issue, relabel it, or leave it as-is.
- **Not in scope**: Routine Firings (`src/routines/dispatcher.ts`, `RoutineFiringState`) have their
  own independent `queued`/`preparing_workspace`/`running`/`succeeded`/`failed`/`cancelled` states
  and their own `no_workspace_changes` handling (`SPEC.md` §8). They are a separate concept from
  issue-dispatched Runs and are untouched here; a future ADR can decide whether the same split
  applies there.
- **Not in scope**: this ADR does not change what counts as eligible, does not auto-close or
  auto-relabel GitHub issues based on agent verdicts, and does not touch the pre-existing
  `input_required` RunState (declared in the `RunState` union but never actually written by any
  code path today — a separate, older gap, out of scope for this issue).

## Numbering

ADR `0057` is the most recent number in tree; this ADR is `0058`.
