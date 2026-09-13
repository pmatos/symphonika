# Autonomy contract v4: there is no asynchronous wakeup

Symphonika bumps the autonomy preamble to `autonomy-preamble-v4` and adds two contract
points after project `vow`'s `implement` state repeatedly produced real, uncommitted work and then
died waiting for a background build it believed would notify it on completion. Two consecutive
attempts at issue #1267 (`e6c2261a-166d-4796-a159-0f8446c1ac2f`, then
`c51398b8-459d-470d-b43a-a149acedfb0e` after a manual retry) show the same shape: the agent starts
vow's self-hosted bootstrap build in the background, writes real progress while it runs (test
fixtures on the first attempt; the full `checker.vow` fix plus fixtures on the second), then says
some variant of "I'll wait for the background bootstrap build's completion notification" and goes
idle. `ScheduleWakeup` was tried once and rejected with "That tool isn't applicable outside `/loop`
mode" — the agent registered the rejection but not its implication. `runClaudeTurn`
(`src/providers/claude.ts`) writes the one prompt message, calls `child.stdin.end()` immediately,
and returns the moment the child's own event stream reports `process_exit`; there is no second
message this session can ever receive, and no operator or scheduler resumes a `claude -p` process
once it decides the turn is over. Both attempts ended `turn_completed` → `process_exit 0` with zero
commits, `branch_ahead_of_base`/`branch_advanced_since_attempt_start` both false, so `implement`'s
catch-all `to: failed` (see `symphonika/workflow.yml` in the `vow` repo) fired and the run landed on
`terminal: blocked` — `sym:blocked` + `sym:human-needed`, no retry, no PR, despite a correct fix
sitting uncommitted in the reused workspace both times. Grepping other `vow` issues currently
`workflow_terminal_blocked` turned up the identical pattern on #1226 and #1222 (both waiting on a
backgrounded `scripts/full_test.sh`), so this is not specific to one issue or one kind of build.

The v4 contract adds two items rather than one — matching the preamble's established one-rule-per-item
shape (ADR 0093). Item 7 states plainly that this is a single headless turn with no
asynchronous wakeup: nothing outside the turn can resume it, regardless of what a tool's own
description promises (the `Bash` tool's `run_in_background` text is written for an interactive
session where a later turn exists to receive the notification; a raw-FSM agent run has no later
turn). It tells the agent to run long steps in the foreground with an explicit time bound, or poll
their real status itself inside the turn's own budget, rather than backgrounding and waiting idle.
Item 8 is the checkpoint rule: since a step already running when the turn ends leaves no trace the
workflow can see, the agent must commit and push whatever real progress exists before starting
anything that might outlast the turn.
That last clause is the one that would have saved both #1267 attempts: `implement`'s success edge
reads only `branch_ahead_of_base`/`branch_advanced_since_attempt_start`, never partial or in-flight
work, so an unfinished verification the agent never checkpointed is indistinguishable from no
progress at all.

This is prompt-level guidance only, same scope as v3 (ADR 0093): no change to
`workflow.yml`'s `implement` catch-all, no new terminal label, no FSM retry-on-no-progress edge.
Whether `implement`'s blanket `to: failed` should instead distinguish "ran out of turn" from a
genuine failure is a separate, larger question deferred pending evidence that the preamble fix
alone doesn't already fix the common case — most of the observed blocked runs never needed a retry
policy, they needed to stop discarding real progress they already had. ADR 0017's v1 invariants,
ADR 0043's v2 additions, and ADR 0093's v3 memory-budget items remain valid and are restated
verbatim in v4; this ADR extends them rather than supersedes them. The preamble version in
`prompt-metadata.json` remains the evidence-replay signal for distinguishing v3 from v4 attempts.
