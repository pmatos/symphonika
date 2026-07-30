# Provider PID namespace isolation

During the 2026-05-22 incident that also motivated the Watchdog (ADR 0054), an Agent Provider
running for one Run observed a PID belonging to a different Run's workspace and bound a
`write_stdin` watcher onto it. Workspace isolation in Symphonika is by `cwd` only (each Run gets its
own git worktree); the PID namespace is shared across every provider the daemon spawns, on the same
host. That is a coincidence, not a guarantee: any provider process can enumerate `/proc`, discover a
PID it does not own, and interact with it — mistakenly (a stale watch target reused across Runs) or,
in a future adversarial framing, deliberately. The Watchdog (ADR 0054) detects the *symptom* of this
class of failure (a wedged Run making no progress); it does not prevent the cross-Run visibility that
caused this particular wedge. ADR 0054 explicitly deferred this as a separate, adjacent sandbox-shape
decision, and this ADR is that decision.

This ADR is planning-only: it records the decision and its boundaries. No provider-spawning code
changes in this slice; the decided primitive is implemented in follow-up issues (see below).

## Decision

Each Agent Provider process (and its full descendant tree) runs inside its own **Linux PID
namespace**, created with:

```
unshare --pid --user --map-current-user --fork --mount-proc -- <provider command>
```

This wraps the provider command in `src/lifecycle/process-scope.ts`, composing with the isolation
that already exists there rather than replacing it:

- The existing detached POSIX process-group boundary (the supervisor/guardian pair described in
  ADR 0064) still owns the provider's process-group lifetime and signal-based shutdown.
- The existing optional `systemd-run --user --scope --slice=symphonika-providers.slice` cgroup
  wrapping (ADR 0064) still owns memory accounting, when a reachable `systemd --user` manager is
  available.
- `unshare` becomes an additional innermost wrap: `systemd-run` (cgroup, optional) →
  process-group supervisor/guardian (ADR 0064) → `unshare --pid --user ...` (this ADR) → the
  provider command.

Each flag is load-bearing, verified empirically against this repo's actual kernel/util-linux
version (util-linux 2.42.2) before writing this decision down, not merely asserted from the `man`
page:

- `--pid --fork` creates the new PID namespace; `--fork` is required because the namespace only
  takes effect for children of the unshared process, not the process calling `unshare` itself.
- `--mount-proc` is not optional. A PID namespace alone does not hide anything: `ps -e` inside an
  `unshare --pid` process without `--mount-proc` still lists host PIDs, because it reads the
  inherited host `/proc`. `--mount-proc` remounts a fresh `/proc` scoped to the new PID namespace,
  which is what actually makes `ps -e` inside the provider report only its own descendants. Measured
  on this host: `ps -e --no-headers | wc -l` inside `unshare --pid --user --fork --mount-proc`
  reports `1` (itself) versus `5` (through 6, without `--mount-proc`) on the unwrapped host. This
  implies a private mount namespace, but scoped to remounting `/proc` — the rest of the mount table
  is inherited unchanged, so filesystem visibility is untouched. Filesystem and network isolation
  are explicitly out of scope for this ADR (see Scope, below) and this side effect does not
  introduce either.
- `--user` is required for this to run unprivileged: the daemon runs as an ordinary user
  (`systemd-run --user`, `XDG_RUNTIME_DIR`-scoped), and a bare `unshare --pid` needs `CAP_SYS_ADMIN`
  in the caller's user namespace. `--user` creates a fresh user namespace in which the calling,
  unprivileged UID holds full capabilities, which is what makes `--pid`/`--mount-proc` possible
  without root or a setuid helper.
- `--map-current-user` (not `--map-root-user`) maps the daemon's real UID to itself inside the new
  user namespace, so the provider still runs as its normal UID rather than appearing as UID 0. Some
  tools change behavior when they believe they are root (package managers refusing `--unsafe-perm`
  workarounds, build tools dropping privilege-sensitive steps); mapping identity rather than
  granting apparent root avoids that class of surprise. `--map-current-user` requires util-linux
  ≥ 2.38; hosts on an older util-linux fall back to the status-quo (unwrapped) path via the same
  probe-and-degrade mechanism described below, rather than falling back to `--map-root-user`.

## Interaction with ADR 0015 (full-permission agent execution)

ADR 0015 says future sandboxing must be implemented "outside the provider as host, container, VM,
network, or credential isolation rather than as provider-level approval policy," and that provider
commands must still speak their adapter's expected protocol unmodified. This ADR is exactly that
shape: `unshare` wraps the provider's argv the same way `systemd-run --user --scope` already does
(ADR 0064) — it changes what process/PID-namespace boundary the command executes inside, not the
provider's own approval policy or sandbox flags. The Codex `-c sandbox_mode=danger-full-access
-c approval_policy=never --dangerously-bypass-approvals-and-sandbox`, Claude
`--dangerously-skip-permissions`, and OMP `--auto-approve` flags are untouched. A provider inside its
own PID namespace is still full-permission within that namespace: it can still see, signal, and
interact with its own child processes exactly as before. What changes is that it can no longer see or
touch processes outside its namespace — i.e. another Run's provider tree. This is host-level process
isolation, not a provider sandbox restriction, and does not require or imply any change to ADR 0015's
posture.

## Operator visibility

PID namespace isolation is one-directional: a process inside the namespace cannot see outside it, but
the host (and therefore the daemon) can still see everything inside it, because namespaced
descendants retain ordinary host-visible PIDs and process-group membership. Verified empirically: a
process tree started via `unshare --pid --user --fork --mount-proc` is fully visible in the host's own
`ps -e -o pid,ppid,pgid,cmd`, under the same PGID as the rest of the Run's detached process group, and
`kill -KILL -- -<pgid>` (the same negative-PGID group-kill ADR 0064 already relies on for cancellation)
successfully terminates every process in the namespace, including the `unshare` wrapper itself acting
as the namespace's PID 1. This means:

- **`cancel` / shutdown** — no change to ADR 0064's cancellation path. The existing supervisor/guardian
  group-signal mechanism (`SIGTERM` then `SIGKILL` escalation) reaches the provider and all of its
  descendants whether or not they are inside a nested PID namespace, because group signaling operates
  on the host PGID, which namespacing does not hide or renumber.
- **`show-run` process-tree diagnostics** — any future host-side process-tree walk (e.g. for
  diagnostics) continues to work unmodified: it observes host PIDs and the host's own `/proc`, which
  still lists every provider descendant regardless of the namespace boundary. Nothing about this
  decision requires `nsenter` or reading the namespace's private `/proc` from the operator side.
- Killing the namespace's PID-1 process (the `unshare` wrapper) tears down the entire namespace and
  every process inside it — the kernel destroys a PID namespace's remaining tasks once its init
  process exits. This is a strengthening of, not a regression from, the leaked-grandchild problem
  ADR 0064 documented for `systemd-run --user --scope` (a detached `cargo build &` surviving its
  wrapped parent): a namespaced grandchild has no path to detach from its PID namespace's init and
  outlive it.

## Fallback when the primitive is unavailable

Some hosts lack working unprivileged user namespaces (disabled via
`kernel.unprivileged_userns_clone=0`, an old util-linux without `--map-current-user`, or a hardened
LSM policy that blocks `unshare`). Consistent with the precedent this repo already established twice
— `probeSystemdRunAvailable` in `src/lifecycle/process-scope.ts` (ADR 0064) and `doctor`'s warn-not-fail
posture for unit drift (ADR 0065) — the daemon probes PID-namespace availability once, caches the
result for the process lifetime, and gracefully degrades to the unwrapped status-quo path (the
provider runs in the shared host PID namespace, exactly as it does today) rather than refusing to
start. `symphonika doctor` gains a warning (not a failure) when the host cannot provide PID namespace
isolation, so an operator can see the gap instead of silently losing it. There is no per-Project
opt-in/opt-out in this slice: the wrap is attempted host-wide and falls back host-wide when
unavailable, matching the existing `systemd-run` probe's scope rather than introducing a new
per-Project configuration axis this ADR does not otherwise need.

## Rejected alternatives

- **cgroup** — already in tree for memory accounting (ADR 0064). cgroups constrain resource usage;
  they do not affect `/proc` visibility or process signaling scope at all. This does not address the
  incident's actual failure mode (one provider observing and binding to another's PID) and was
  rejected as a non-answer to the question this ADR exists to resolve.
- **Per-Run user (separate UID per Run)** — PIDs are visible process-tree-wide regardless of the
  owning UID; a different UID does not hide `/proc/<pid>` entries from `ps`/`/proc` enumeration by
  another UID unless `/proc` is mounted with `hidepid=`, and a private `hidepid=` mount itself
  requires a private mount namespace — at which point the isolation is coming from the mount
  namespace, not the UID split. Rejected as insufficient on its own, and as strictly more complex than
  directly namespacing PIDs once a private mount namespace is required either way.
- **Full container/sandbox runtime (e.g. bubblewrap, podman)** — provides PID namespace isolation and
  more (mount, and optionally network/user isolation). Rejected for this slice because the issue this
  ADR resolves explicitly bounds itself to PID/process isolation only ("Decisions about network or
  filesystem isolation ... are separate sandbox shapes"), and a container runtime is a heavier,
  additional host dependency (not universally present, unlike `unshare`, which ships in util-linux —
  present on essentially every Linux host already running the daemon) to solve a narrower problem than
  it's capable of solving. A container runtime remains a reasonable future direction if a later ADR
  decides Symphonika also needs filesystem or network sandboxing; it is not justified by this
  incident alone.
- **Status quo, documented limitation only** — considered and rejected as the primary decision,
  because the motivating incident is a concrete, already-observed cross-Run interaction, not a
  theoretical risk, and a working unprivileged primitive exists on the daemon's actual deployment
  target at negligible implementation cost. Status quo remains the automatic fallback behavior on
  hosts that cannot support the primitive (see Fallback, above), which preserves today's behavior
  exactly where isolation genuinely cannot be provided.

## Scope of this ADR

In scope: the PID/process visibility isolation decision described above, and its boundary with ADR
0015 and ADR 0064. Out of scope, and left for later ADRs if ever pursued:

- Filesystem isolation (a private or read-only mount namespace beyond the `/proc` remount
  `--mount-proc` already requires).
- Network isolation (a private network namespace, `--net`).
- Any change to Codex/Claude/OMP provider approval policy or sandbox flags — this ADR does not touch
  ADR 0015's full-permission posture.
- Implementation in `src/lifecycle/process-scope.ts` or elsewhere — this ADR is planning-only. See
  the follow-up implementation slice, #342, tracked under the parent issue.

## Consequences

- Once implemented, an Agent Provider process tree for one Run can no longer enumerate or interact
  with PIDs belonging to a different Run's provider tree, closing the specific cross-Run interaction
  the 2026-05-22 incident exposed.
- No change to operator-facing cancellation, `show-run` diagnostics, or ADR 0015's full-permission
  posture — see Operator visibility and Interaction with ADR 0015, above.
- Hosts without unprivileged user namespace support silently keep today's shared-PID-namespace
  behavior, surfaced only as a `doctor` warning, not a startup failure.
- This ADR does not change `src/lifecycle/process-scope.ts` or any other code; implementation is
  tracked in follow-up issue #342 under the parent umbrella (#197 / #199).

## Numbering

ADR `0066` is the most recent number in tree; this ADR is `0067`.
