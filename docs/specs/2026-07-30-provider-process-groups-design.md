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
Real provider Runs use it to spawn their configured command with
`detached: true`, making the direct child the leader of a new process group.
Short-lived provider validation probes remain ordinary child processes because
they do not execute agent work or spawn Run-owned tools.

The shared shutdown operation is idempotent and performs this sequence:

1. Close the provider's stdin when it is still writable, preserving the
   existing graceful EOF path.
2. After 250 milliseconds, signal the process group with
   `process.kill(-child.pid, "SIGTERM")`.
3. When that group still exists, after a short bounded grace period signal it
   with `SIGKILL` unconditionally, even when the direct child has already
   exited. An `ESRCH` response to the `SIGTERM` attempt means the group is
   already gone and no escalation timer is armed.

The escalation is keyed on the process group rather than the direct child's
exit state because a cooperative parent can exit on `SIGTERM` while an
uncooperative grandchild remains alive. Repeated shutdown requests reuse the
same escalation rather than arming competing timers.

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
the same group-scoped escalation as Claude and Codex. Its existing pipe release
behavior remains bounded so inherited descriptors cannot keep the adapter
waiting after escalation.

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
5. Re-run existing daemon-shutdown and Watchdog cancellation tests to confirm
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

- Claude, Codex, and OMP real Run commands spawn as detached process-group
  leaders.
- Cancellation closes stdin first, signals the whole group with `SIGTERM`,
  and, when that group exists, unconditionally escalates it to `SIGKILL`.
- An already-dead group is harmless and repeated cancellation does not arm
  duplicate escalation sequences.
- Provider-level regressions prove a forked grandchild exits after
  cancellation for all three providers.
- Existing daemon-shutdown and Watchdog tests still prove that their
  cancellation paths invoke the provider seam.
- ADR 0064 accurately describes systemd scopes and process groups as
  complementary cleanup layers.
- Formatting, lint, Knip, type checking, the focused tests, the full test
  suite, and the production build pass.
