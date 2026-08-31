# Bias OOM victim selection toward provider trees

ADR 0089 removed every provider `MemoryHigh=` and per-scope memory limit after the shared soft
limit stalled all concurrent providers without killing the process at fault. The providers slice
keeps one aggregate `MemoryMax=` hard ceiling and each transient provider scope uses
`OOMPolicy=kill`, but those controls decide where an OOM happens and how much of the selected
scope dies. They do not decide which process the kernel selects first. A large browser, an IDE, or
the Symphonika daemon could still lose to a provider build tree under host-wide pressure, and
killing the daemon strands every in-flight Run.

Linux exposes that preference through `/proc/<pid>/oom_score_adj`. The value is inherited across
both `fork` and `exec`, ranges from `-1000` to `1000`, and can be raised by an unprivileged process.
Lowering a value again requires `CAP_SYS_RESOURCE`. `OOMScoreAdjust=` cannot be placed on the
transient scope: `systemd-run --user --scope -p OOMScoreAdjust=500` is rejected because a scope has
no exec context.

## Decision

The generated `symphonika.service` requests `OOMScoreAdjust=-500`. `doctor` warns when the effective
installed service content has no negative `OOMScoreAdjust=` assignment and points the operator at
the normal reinstall-and-restart path. The generator owns `-500`; an operator-authored negative
value remains valid drift-wise in the same way an operator-authored watchdog timeout does.

That negative service setting is best-effort under a user manager. A live systemd 261 probe accepted
and reported `OOMScoreAdjust=-500`, but a user manager whose own score was `100` launched the child
at `100`: lowering the host-kernel value still requires `CAP_SYS_RESOURCE`, which an ordinary user
manager does not have. The directive becomes effective when the manager is permitted to realize it;
otherwise the unprivileged provider raise still produces a real `100`-to-`500` separation. A
system-level service, privileged helper, or lowering the user manager itself would make the negative
value unconditional, but each changes the privilege and installation model beyond this decision.

On Linux, `spawnProviderProcess` interposes `/bin/sh` only in the supervisor's provider child
branch. The shim writes `500` to `/proc/self/oom_score_adj` and then `exec`s the command with its
original argv. The write uses shell positional parameters rather than interpolating the provider
command, so spaces and shell metacharacters in an authored command remain data. A failed `/proc`
write is non-fatal: the shim continues to `exec`, preserving provider availability on an unusual
Linux environment that exposes no writable `oom_score_adj`.

The shim sits outside the optional `systemd-run` wrapper:

```text
detached supervisor + guardian (inherited daemon score)
  -> oom-score shim (+500)
    -> systemd-run --user --scope (optional)
      -> provider
        -> provider descendants (inherited +500)
```

This placement gives the systemd-wrapped and unwrapped fallback paths identical behavior in one
place. `systemd-run` itself briefly inherits `+500` on wrapped hosts; that process is only the
launcher, while the provider and every build-tool descendant retain the score after it. Putting the
write in the supervisor was rejected because it would also raise the long-lived supervisor and
guardian. Those processes preserve the detached process-group identity used by ADR 0064's bounded
cancellation handshake, and an unprivileged supervisor could not lower their scores again.

Non-Linux and Windows hosts keep the existing direct spawn path. The setting has no meaning there,
and Windows already bypasses the detached POSIX supervisor.

## Values

`-500` and `+500` sit midway between neutral and the respective extremes of the kernel's allowed
adjustment range. They create a strong, explicit separation between the small control-plane daemon
and memory-consuming provider trees without using either extreme. In particular, `-1000` would make
the daemon OOM-immune, which can leave the kernel with no useful victim in a constrained cgroup,
while `+1000` would discard all size-based discrimination and make even a small provider maximally
eligible. The midpoint pair preserves the kernel's relative badness ranking within provider trees
while making the intended cross-class preference decisive under ordinary pressure.

## Consequences

- The service requests a lower daemon score, subject to the user manager's privilege and inherited
  score. Provider processes plus all descendants receive the real unprivileged `+500` raise.
- The supervisor and guardian retain the score inherited from the daemon process, so the OOM
  preference does not weaken the process-group lifetime boundary or its cancellation handshake.
- Provider fallback on hosts without a reachable systemd user manager gains the same `+500`
  preference as the scoped path.
- Linux provider spawning now depends on `/bin/sh`. The shim adds one short-lived exec before the
  provider or `systemd-run`; it does not change provider stdin/stdout/stderr, the detached process
  group, the guardian protocol, or scope cleanup.
- Installed services require `symphonika service install --force` and an explicit restart before
  the daemon-side request is present; whether the negative score takes effect remains
  manager-dependent. `doctor` exposes declaration drift.

## Numbering

ADR `0090` is the most recent number in tree; this ADR is `0091`.
