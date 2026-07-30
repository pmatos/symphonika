# Provider process-group lifecycle design

Status: Approved for implementation

## Context

Claude, Codex, and Oh My Pi Runs currently spawn their configured provider
command with piped standard streams but without a new process group. Their
shutdown paths close stdin and later signal only the direct child process. A
provider-spawned test runner, build, or other grandchild can therefore survive
operator cancellation, Watchdog cancellation, or daemon shutdown and continue
using the Run's Workspace.

ADR 0064 mitigates this on hosts with a reachable `systemd --user` manager by
wrapping each Run in a transient provider scope and stopping that scope during
cleanup. Symphonika deliberately continues to run without systemd, however. Its
unwrapped fallback retains the direct-child-only behavior, so process-tree
ownership still depends on the host environment.

Issue #300 predates the OMP provider, but OMP uses the same unwrapped spawn
model. The process-lifetime contract therefore applies to all three current
Agent Providers.

## Decision

Introduce a shared provider-process lifecycle helper under `src/providers/`.
On POSIX, real provider Runs use it to spawn a lightweight supervisor with
`detached: true`, making the supervisor the leader of a new process group and
session. The supervisor starts the configured provider with inherited standard
streams and a stream-free guardian in that same group. Short-lived provider
validation probes remain ordinary child processes because they do not execute
agent work or spawn Run-owned tools.

The guardian ignores `SIGTERM`. The supervisor reports guardian readiness to
the orchestrator before launching the configured provider. If shutdown
preparation has already been requested when readiness arrives, the supervisor
keeps the guardian reserved but never launches the provider. Before any
shutdown courtesy or stdin EOF, the orchestrator sends the supervisor a
preparation request and waits for its acknowledgement. That acknowledgement
means the supervisor has latched the shutdown state and will leave the guardian
in place even if the provider exits immediately. On ordinary provider
completion without a shutdown request, the supervisor reports group release,
removes the guardian, and mirrors the provider's exit, so the group ends
immediately. Release and shutdown reservation are mutually exclusive: once
ordinary completion has settled and release begins, a later preparation
request is rejected rather than acknowledged against a disappearing group.
Once group shutdown begins, the guardian instead keeps the original
process-group identity reserved through both grace periods. This prevents
either delayed negative-PID signal from targeting an unrelated group after
numeric PID reuse.

The shared shutdown operation is idempotent and performs this sequence:

1. Ask the POSIX supervisor to reserve the process group for shutdown and wait
   for its acknowledgement. Non-POSIX direct-child shutdown skips this step.
2. Send every provider-specific protocol courtesy registered while the shared
   shutdown is reserving the group (`turn/interrupt` for Codex, `abort` for
   OMP). A concurrent idempotent shutdown call must not drop its courtesy.
3. Close the provider's stdin when it is still writable, preserving the
   existing graceful EOF path.
4. After 250 milliseconds, signal the process group with
   `process.kill(-child.pid, "SIGTERM")`.
5. When that group still exists, its guardian preserves the group identity
   while the provider and its descendants handle `SIGTERM`.
6. After a short bounded grace period, signal the preserved group with
   `SIGKILL` unconditionally, even when the provider has already exited. An
   `ESRCH` response to the `SIGTERM` attempt means the reserved group no longer
   exists, so no escalation timer is armed.

The escalation is keyed on the process group rather than the direct child's
exit state because a cooperative parent can exit on `SIGTERM` while an
uncooperative grandchild remains alive. Repeated shutdown requests reuse the
same escalation rather than arming competing timers. The returned shutdown
promise remains pending until the group is found absent or the `SIGKILL`
escalation completes, so daemon shutdown cannot exit while the final cleanup
timer is still outstanding. A courtesy registered after stdin EOF is skipped;
it is no longer safe or useful to write a protocol frame to the ended stream.
Bulk Watchdog and active-run reconciliation sweeps start independent
cancellations without awaiting each grace period in sequence, then await the
collected cleanup promises before completing the sweep.

The orchestrator records the interval between the supervisor's group-ready and
group-released messages. If the supervisor's IPC channel dies unexpectedly
during that interval, the known-live guardian still reserves the original PGID,
so shutdown safely falls back to the same group signal sequence. A disconnect
before readiness cannot strand provider work because the provider is not
launched until readiness has been reported.

`ESRCH` means the process group is already gone and is treated as successful
cleanup at either signal step. Other synchronous group-signal failures must not
escape a timer callback and crash the daemon; the helper retains a
direct-child signal fallback for platforms without POSIX negative-PID process
groups. The full descendant guarantee applies on POSIX hosts, including Linux
hosts without a usable systemd user manager and macOS.

Systemd provider scopes remain in place. They provide cgroup isolation,
resource controls, startup orphan recovery, and a second whole-tree cleanup
mechanism; process groups provide the local Run-lifetime guarantee when scope
wrapping is unavailable.

## Public seams and lifecycle integration

Tests observe the `AgentProvider` interface rather than private signal helpers:

- `runAttempt` starts a provider stub that forks a long-lived grandchild;
- `cancel(runId)` initiates the shared stdin, `SIGTERM`, and `SIGKILL`
  sequence;
- the attempt emits its existing cancelled `process_exit` evidence; and
- the test confirms the grandchild no longer exists.

Operator cancellation, Watchdog stale-run cancellation, terminal provider
events, and daemon shutdown already converge on each provider's `cancel`
method. No new daemon or Watchdog cancellation path is introduced. The daemon
shutdown ordering added for issue #324 remains responsible for cancelling all
live providers before draining dispatches.

## Provider integration

Claude and Codex replace their duplicated direct-child shutdown helpers with
the shared lifecycle helper. Their JSON protocols, normalized events, command
parsing, and validation behavior do not change.

OMP retains its protocol-level `abort` courtesy before closing stdin, then uses
the same group-scoped escalation as Claude and Codex. The supervisor reservation
acknowledgement precedes that courtesy, so an immediate provider exit cannot
release the group identity. Its existing pipe release behavior remains bounded
so inherited descriptors cannot keep the adapter waiting after escalation.

Only the actual Run spawn is detached. Claude's `--help` validation, Codex
validation and sandbox probes, and OMP's bounded startup validation remain
outside the Run process-group contract.

## TDD sequence

Implementation proceeds in vertical red-green slices:

1. Add a Claude provider regression whose fake provider forks a long-lived
   grandchild. Cancel through `AgentProvider`, prove the grandchild survives
   the current direct-child shutdown, then make detached group termination
   pass.
2. Reuse the shared lifecycle in Codex and add the equivalent public provider
   regression.
3. Reuse it in OMP while preserving the RPC `abort` courtesy, and add the
   equivalent provider regression.
4. Add focused escalation cases proving `SIGKILL` is attempted after the
   direct child exits while its group remains, and that an already-dead group
   (`ESRCH`) stops escalation harmlessly.
5. Add a public provider regression proving the original process-group
   identity remains reserved between successful `SIGTERM` and `SIGKILL`.
6. Add a public provider regression proving an immediate protocol-courtesy exit
   cannot release the group during the initial EOF grace period.
7. Add shared lifecycle regressions proving shutdown preparation preempts
   provider launch and a recorded group remains cancellable after unexpected
   supervisor IPC loss.
8. Re-run existing daemon-shutdown and Watchdog cancellation tests to confirm
   those callers still converge on `provider.cancel`.

The subprocess regressions are POSIX-only because negative-PID process groups
are a POSIX primitive. Existing provider tests continue to cover the
direct-child fallback on other platforms.

## Documentation

Amend ADR 0064 to distinguish the two cleanup layers:

- the transient systemd scope owns resource isolation and durable orphan-scope
  recovery when a user manager is available; and
- the detached POSIX process group owns cancellation-time descendant cleanup
  for every real provider Run, including the non-systemd fallback.

No Service Config, provider command, public TypeScript interface, SPEC domain
model, or CONTEXT vocabulary changes are required.

## Alternatives rejected

- Extending `ProcessScope` with spawn and signal responsibilities would
  centralize the behavior but conflate optional systemd cgroup management with
  portable child-process ownership.
- Duplicating negative-PID signal logic in all three adapters would minimize
  the first diff but preserve the lifecycle drift that already left Claude,
  Codex, and OMP with different escalation behavior.
- Relying only on ADR 0064's transient scopes would leave cancellation unsafe
  on non-systemd Linux hosts, macOS, containers, and CI.

## Success criteria

The change is complete when:

- Claude, Codex, and OMP real Run commands execute inside a detached
  process-group boundary led by the shared POSIX supervisor.
- Cancellation reserves the group, performs protocol courtesy and stdin EOF,
  signals the whole group with `SIGTERM`, and, when that group exists,
  unconditionally escalates it to `SIGKILL`.
- The guardian preserves the original group identity throughout that
  escalation window, preventing delayed signals from following a reused PID.
- Provider-specific shutdown courtesy and stdin EOF happen only after the
  supervisor acknowledges that the guardian is reserved.
- Shutdown acknowledged before guardian readiness never launches the provider,
  and a ready group remains cancellable after unexpected supervisor exit.
- Ordinary group release and shutdown reservation cannot both succeed.
- An already-dead group is harmless and repeated cancellation does not arm
  duplicate escalation sequences.
- Shutdown completion covers the forced-kill grace period, and no courtesy is
  written after stdin EOF.
- Bulk Watchdog and active-run reconciliation cancellation latency is bounded
  by the slowest independent cleanup rather than the sum of all grace periods.
- Provider-level regressions prove a forked grandchild exits after
  cancellation for all three providers.
- Existing daemon-shutdown and Watchdog tests still prove that their
  cancellation paths invoke the provider seam.
- ADR 0064 accurately describes systemd scopes and process groups as
  complementary cleanup layers.
- Formatting, lint, Knip, type checking, the focused tests, the full test
  suite, and the production build pass.
