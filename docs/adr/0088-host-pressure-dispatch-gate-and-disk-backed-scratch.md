# Gate dispatch on host pressure, and keep provider scratch off tmpfs

Symphonika's admission decision has only ever counted: ADR 0053 gave it a daemon-wide and a
per-Project `max_in_flight`, and nothing else. Those caps say how many Runs may exist; they say
nothing about whether the machine underneath them can still make progress. `grep -rn
"loadavg\|os.loadavg\|cpuCount\|availableParallelism" src/` returned nothing before this change.

Issue #599 is what that costs. A vow `plan`-stage Run lost **54 minutes** to a
`commitlint --edit` invocation. Re-running that exact command — same node, same message, same
repository — takes 0.30s and exits 0. Nothing was broken. Each layer of the process tree took
10–16 minutes merely to spawn its child:

| pid | process | elapsed |
|---|---|---|
| 2776163 | `git commit -m docs: add implementation plan…` | 1:28:40 |
| 2784418 | `python -mpre_commit hook-impl --hook-type=commit-msg` | 1:12:30 |
| 2790375 | `node …/commitlint --edit …/COMMIT_EDITMSG` | 1:01:03 |

Load average was ~19.7 on 24 cores while `commitlint` used 0.4% CPU. That is not CPU contention:
Linux load average counts uninterruptible (D-state) tasks, so those two numbers together are the
signature of tasks blocked on memory reclaim and I/O. The kernel's pressure-stall counters said so
directly, measured on an otherwise quiet box:

```
/proc/pressure/cpu     full avg300=0.00     <- CPU is never the constraint
/proc/pressure/memory  full avg300=23.53    <- every task stalled 23% of the time
/proc/pressure/io      full avg300=60.62    <- every task stalled 60% of the time
/proc/vmstat           pswpout 19820077  pgmajfault 84418775
```

The cause of the memory pressure was Symphonika's own agents. `/tmp` on that host is a 63G
**tmpfs** — RAM — holding 45G, much of it stale build output written by orchestrated work
(`vow1114-target-partial`, `pr508-main-target`, `jsse-main-target`, several multi-gigabyte
`tmp.XXXXXXXX` trees). Nothing pruned any of it, so every Run that spilled into `/tmp`
permanently removed memory from the host until an operator cleared it by hand.

The Watchdog cannot catch this. A thrashing Run keeps emitting tokens, so neither ADR 0054's
liveness rule nor ADR 0086's convergence budget sees anything wrong — the Run is alive and
producing output, just at a thousandth of its normal rate. Two such episodes burned 11.5 hours /
$4.57 and 12.3 hours / $9.48 and still failed to commit.

## Decision

### 1. Dispatch admission consults the host, not only the count

Symphonika reads Linux's pressure-stall information (PSI) and refuses to admit a new Run while the
host is stalled. The signal is the `full` line of `/proc/pressure/<resource>` — the share of the
window during which **every** non-idle task was blocked on that resource. It is the right signal
precisely because it does not conflate "busy" with "stuck", which is the mistake load average and
core count both make.

The gate is a distinct check from the concurrency caps, evaluated before them, with its own reason
strings and its own Routine skip reason (`host_pressure`). Collapsing it into
`evaluateConcurrencyCapacity` would have made a stalled host indistinguishable from a full cap on
every operator surface — exactly the diagnosis #599 spent hours getting wrong.

Configuration lives beside the existing cap, because both answer the same question:

```yaml
global:
  max_in_flight: 8
  pressure:
    enabled: true
    memory_full_avg60_max: 10
    io_full_avg60_max: 80
    sample_interval_seconds: 10
```

**Memory is gated by default at `full avg60` ≥ 10%; I/O is opt-in.** That asymmetry is measured,
not assumed. A healthy host reads a memory `full avg60` of 0.00–0.20 and the incident measured
23.53, so 10 sits far above the noise and well below the failure. I/O does not behave that way: on
the development workstation, during ordinary compilation with nothing wrong, `/proc/pressure/io`
read `full avg60=50.08`. Any I/O default low enough to catch a genuine stall would refuse dispatch
on a perfectly healthy build host, so operators set `io_full_avg60_max` from their own measured
numbers or not at all. Setting either threshold to `null` ungates that resource explicitly;
omitting the whole `pressure:` block keeps the defaults.

The gate **fails open**. A resource whose counter cannot be read — no `/proc/pressure` at all
(non-Linux), a kernel without `CONFIG_PSI`, an unparsable `full` line — admits. A gate that
deadlocked dispatch on hosts where it cannot measure anything would be strictly worse than no gate.

Sampling is TTL-cached at `sample_interval_seconds`, refreshed once per daemon tick before any
admission decision that tick makes, and concurrent refreshes collapse onto one read. That gives
every decision within a tick a single consistent reading of the host and keeps `/proc` reads to
one per interval rather than one per candidate.

Three admission points consult it:

- `dispatchOneFresh` checks before candidate selection, so a stalled host also skips the overlap
  guard's GitHub round-trips, and the returned `reason` names the machine rather than the config.
- `runFreshLifecycle` re-checks inside the dispatch mutex. Every claim path funnels through there
  — fresh dispatch, continuation and PR review follow-up alike — so this is the check that
  actually guarantees no claim starts against a stalled host. It raises `CapBreachedError`, which
  scheduled callers already treat as "reschedule", the correct response to transient pressure.
- The scheduled-retry re-admission block checks alongside the cap re-check for the same reason.

Routine Firings are gated too, since they consume the same slots (ADR 0053) and spawn the same
providers. A scheduled firing records a `host_pressure` skip; a manual fire is refused with
HTTP 429, like a cap breach, because both mean "come back later" rather than "this request is
wrong".

The current verdict and the sample behind it are exposed on `/api/status`, and a deferral is
logged at `info`. A gate that silently stops dispatch would trade one hard-to-diagnose stall for
another.

`global.pressure` is validated in `reload.ts` only, matching how `global.max_in_flight` already
works: `dispatch.ts`, `doctor.ts` and `issue-polling.ts` keep `global` under `.passthrough()`. The
one-shot `symphonika dispatch` CLI builds its RunController without a gate, exactly as it already
builds one without a global cap — a single explicit operator dispatch is not the thing that stacks
agents onto a thrashing host.

### 2. Provider temporary files land on disk, under the state root, and are reclaimed

Every provider attempt gets its own directory at `<stateRoot>/scratch/<runId>-attempt-<n>`, passed
to the spawned process as `TMPDIR` (plus `TMP`/`TEMP`, which Node's own `os.tmpdir()` and much
cross-platform tooling consult first). The directory is removed when the attempt ends, and a
startup sweep clears anything a crashed or SIGKILLed daemon left behind — without that sweep, the
accumulation this change exists to prevent would simply move from `/tmp` to the state root.

Keying on attempt rather than run means a retry never inherits a previous attempt's half-written
temporary state. Removal is best effort in both the issue-Run and Routine-Firing paths: failing to
delete temporary files must never mask the attempt's own outcome, and whatever survives is
reclaimed at the next startup.

`CARGO_TARGET_DIR` is deliberately **not** redirected, though #599 suggests it. Cargo output under
a Project's own `target/` is Workspace evidence: ADR 0087's `watchdog.mtime_include` exists
specifically so a compiled Project's build progress counts as progress. Moving that tree out of
the Workspace would silence the very signal that keeps a compiling Run from being killed as idle.
`TMPDIR` is the general fix — it is what actually put multi-gigabyte trees in a RAM-backed `/tmp`
— and it costs no evidence.

### 3. I/O weight on the cgroup slices

`symphonika-daemon.slice` gets `IOWeight=500` and `symphonika-providers.slice` `IOWeight=50`, so
under disk contention the daemon's own writes (run store, evidence logs) win over an agent's
build. This is best effort by nature — the directives are inert where cgroup v2's io controller is
not enabled for the backing device — which is why it is a supporting measure and not the fix.
`doctor` now requires `IOWeight` in both slices, so an installed unit predating this change is
reported as drift.

#599 also notes that the per-provider `MemoryMax=32G` "does not compose": eight concurrent
providers would promise 256G on a 124G box. That reading is incorrect and the units now say so
explicitly. Every provider runs as a transient scope inside `symphonika-providers.slice` (ADR
0064), so the slice's own `MemoryMax` bounds their aggregate no matter how many run at once; the
per-scope cap in `process-scope.ts` bounds one provider. No code change was needed, only a comment
that stops the next reader reaching the same conclusion.

**Superseded in part by ADR 0089 (`provider-memory-is-the-kernels-problem`)**: #603 removes the
per-scope `MemoryHigh=`/`MemoryMax=` entirely — provider scopes now set no memory properties at
all, and the `src/service.ts` comment cited above is gone with them — and drops `MemoryHigh=` from
the slice as well, because a soft limit on a slice every concurrent provider shares throttled all
of them at once with `oom_kill 0`. The aggregate reading above survives: the slice's
`MemoryMax=32G` still bounds the total, and is now the only memory ceiling in the path.

## Consequences

- A host under sustained memory pressure stops claiming new work instead of adding to the stall.
  Runs already in flight are untouched — this is an admission gate, not a killer.
- Default-on memory gating changes behaviour for existing operators. The threshold is far enough
  above healthy readings that a correctly-sized host never sees it, and `enabled: false` restores
  the old behaviour exactly.
- The state root now carries transient scratch. An operator who has put their state root on a
  tmpfs gains nothing from this change; the default (`~/.local/state/symphonika`) is disk-backed.
- `RoutineSkipReason` gains `host_pressure`, which widens the skip-count record persisted per
  Routine and shown on the dashboard, the `symphonika routines` table and `/api/status`.

**Amended by ADR 0093.** `host_pressure` is a capacity refusal, not a policy skip: a stalled host
means no capacity *right now*, so the due clock event is deferred and retried rather than consumed,
and it reaches this ADR's counter only once the deferral outlives its own event and is recorded as
a missed run.
