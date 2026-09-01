# Derive a make/cmake build-parallelism ceiling for provider environments

Routine Firing `01M1CCTRHJT5SV17WQWV3RD7BA` launched a default-parallelism C++ build on a 24-core
host. Its provider scope peaked at 22.6 GiB, the shared `symphonika-providers.slice` reached its
32 GiB `MemoryMax=`, and `OOMPolicy=kill` correctly killed the provider tree. ADR 0093 added
prompt-level guidance, but advice cannot constrain a build script the Coding Agent did not author.

ADR 0088 already gives every provider attempt a mechanical environment through
`providerScratchEnvironment()`, used identically by the Codex, Claude, and OMP adapters. This is
the narrowest existing seam for a provider-neutral build constraint. ADR 0089 remains controlling:
the provider slice keeps one aggregate hard ceiling and provider scopes gain no memory limits.

## Decision

When `global.max_in_flight` is configured, every issue Run, Routine Firing, and explicit one-shot
dispatch carries that daemon-wide ceiling into its Agent Provider input. Each adapter adds these
values to the provider process environment alongside `TMPDIR`/`TMP`/`TEMP`:

```text
MAKEFLAGS=-jN
CMAKE_BUILD_PARALLEL_LEVEL=N
```

The job count is conservative against both resources implicated in the incident:

```text
cpu_share    = floor(availableParallelism() / global.max_in_flight)
memory_share = floor(32 GiB / (1.5 GiB * global.max_in_flight))
N            = max(1, min(cpu_share, memory_share))
```

`availableParallelism()` is used instead of the host's raw CPU count so affinity and CPU quotas
participate in the ceiling. The 32 GiB value is one constant shared with generated
`symphonika-providers.slice` output. The 1.5 GiB allowance is the approximate peak RSS per compiler
process measured in the incident and recorded by follow-up #644. The configured maximum, rather
than the current in-flight count, deliberately reserves a share for every attempt the daemon may
admit; the ceiling does not become more aggressive merely because peers have not started yet.

If `global.max_in_flight` is omitted, the build variables remain unset. Treating an unbounded fleet
as one attempt would manufacture a share the configuration does not promise. The one-shot dispatcher
reads the cap for environment sizing but continues ADR 0053's admission posture: it does not turn
that value into a one-shot concurrency gate.

This subset is still worth implementing. `make` and `cmake --build` are common build entry points,
and environment injection is small, provider-neutral, and useful even though it cannot cover every
tool. The boundary stays explicit:

- bare `ninja -C build` has no parallelism environment variable and is unaffected;
- an explicit command-line `-j`/`--parallel` can override an environment default;
- the 1.5 GiB allowance is a workload-derived heuristic, not proof that a job cannot use more;
- an operator-edited installed `MemoryMax=` is not discovered at provider launch. A higher budget
  makes this conservative; a lower budget can make it optimistic. Follow-up #644 owns installed
  budget/core/config diagnosis.

Enforcing a ceiling against explicit flags or bare Ninja requires command interposition and policy
for flag precedence. That is a materially larger boundary and remains out of scope. Prompt-level
guidance from ADR 0093 continues to cover those invocations.

## Consequences

- Codex, Claude, and OMP receive identical make/cmake environment constraints for issue Runs and
  Routine Firings, including retries; the explicit one-shot dispatch path receives them too.
- With the incident-class inputs (24 available CPUs, 32 GiB slice, eight possible attempts), each
  attempt receives `N = 2` rather than inheriting machine-scale parallelism.
- A plain make invocation may become parallel up to `N`; this is intentional and bounded. Builds
  that were already explicitly more conservative may retain their command-line value according to
  the build tool's normal option precedence.
- No cgroup property, admission rule, Host Pressure threshold, or per-scope memory policy changes.

## Alternatives considered

**Do nothing because bare Ninja caused the incident.** Rejected: the limitation is real but does
not erase the protection available at an established, low-cost seam for make and CMake builds.

**Hardcode one `-j` value.** Rejected: one number cannot compose with the fleet's declared
concurrency or a CPU-constrained host, and the discarded `-j6` prompt draft would have permitted 48
jobs under `max_in_flight: 8` on the 24-core incident host.

**Read the live systemd slice limit before every launch.** Deferred: it would make provider startup
depend on systemd-specific installed state and drop-in precedence, while providers also run on
non-systemd hosts. The generated default and calculation share one source constant; #644 owns
reporting installation drift.

**Divide the slice into per-provider cgroup limits.** Rejected by ADR 0089: a legitimate ESBMC
verification has measured roughly 21 GiB resident, so a fair per-scope share either kills valid
work or is too large to isolate concurrent attempts.
