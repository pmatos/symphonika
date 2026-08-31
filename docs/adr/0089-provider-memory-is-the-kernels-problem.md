# Provider memory is the kernel's problem: no soft limit on the shared slice, none per scope

ADR 0064 gave spawned providers their own cgroup, `symphonika-providers.slice`, with
`MemoryHigh=24G` / `MemoryMax=32G`, and wrapped every provider Run in a transient
`systemd-run --user --scope` under it. Each scope was then given
`-p MemoryHigh=24G -p MemoryMax=32G` — the *same* numbers as the slice that contains all of them.
Every scope was therefore authorised to consume the entire slice budget, and the per-scope limits
restated a ceiling that already applied rather than carving it up. With `global.max_in_flight: 8`,
eight providers shared 24G with no per-provider share.

The soft limit is the part that failed, and it failed in the opposite direction from the one it
was reasoned about. `memory.high` does not stop a cgroup growing; it applies reclaim throttling and
socket-memory throttling to **every task in the subtree** once the watermark is crossed. Resident
providers crawl. A *newly spawned* provider — a ~214MB CLI bundle, a cold V8 heap, a first TLS
connection, so almost pure fresh allocation — effectively never starts, and because it is being
throttled rather than refused, it reports nothing at all.

The measured case: `refactor-audit` fan-outs on 2026-08-27 and 2026-08-30 23:00Z. All five firings
that were admitted reached `running` within 1.7s — workspace prep, `provider.validate`, and the
GitHub snapshot all succeeded — and then produced almost nothing before being SIGKILLed at the
120-minute deadline. Two of the five wrote **zero** provider output in two hours. Read from the
slice with a single run resident:

```
memory.current      21677105152   (20.2 GiB)
memory.high         25769803776   (24 GiB)
memory.events       high 209345073        <- reclaim throttle events
                    sock_throttled 663229 <- socket allocations throttled
                    oom 0  oom_kill 0     <- nothing was ever killed
memory.pressure     full total=102372735837us  (~28h of complete stall)
```

`oom_kill 0` against 28 hours of full pressure stall is the whole finding. The cap did not protect
the fan-out from a heavy run; it converted one heavy run into a silent, hours-long stall for every
other run in the slice. Had there been no `MemoryHigh`, the kernel would have reclaimed, swapped,
and then OOM-killed the largest offender in seconds, and the other four firings would have
completed.

## Decision

**Host memory pressure is the kernel's job. Symphonika keeps a hard ceiling and no soft one.**

- `symphonika-providers.slice` drops `MemoryHigh=` entirely and keeps `MemoryMax=32G` and
  `TasksMax=4096`. `MemoryMax=` kills; `MemoryHigh=` only stalls. The hard ceiling still stops a
  runaway provider tree from taking the whole machine and triggering a global OOM that tears down
  terminals or other unrelated cgroups — the original ADR 0064 goal — but it reaches that outcome
  by killing something rather than by throttling everything.
- Provider scopes set **no memory properties at all**. There is no number to divide and no ceiling
  to restate.
- Provider scopes gain `-p OOMPolicy=kill`, which sets `memory.oom.group=1` on the scope. A kernel
  OOM kill then takes the provider's entire process tree — its build tools with it — and the scope
  lands in the `oom-kill` failed state. Previously a kill could take one descendant (a `rustc`, an
  `esbmc`) and leave the provider hanging on a half-dead pipeline with nothing to report.
- `symphonika-daemon.slice` is unchanged, `MemoryHigh=4G` included. A soft limit is sound on a
  cgroup with a single occupant: there are no peers to drag down, and throttling the daemon toward
  its own budget is exactly the intent. The shared-fate problem is specific to a slice every
  concurrent provider sits in.

### Why not divide the budget per scope

The obvious repair — `sliceBudget / max_in_flight`, with a floor and an override — was considered
and rejected. It keeps the same throttle-first regime, one level down, and it requires a number
that this workload makes indefensible: a single ESBMC verification in the `vow` project has been
measured at ~21 GB resident. At `24G / 8` that run is throttled into the same stall at 3G and
OOM-killed at 4G, so the mechanism that starved its peers is replaced by one that destroys
legitimate work. Any per-scope figure large enough for the heaviest real run is too large to
isolate anything when eight of them are admitted, which is the same contradiction the hardcoded
24G expressed — a fair share cannot be both.

Admission control is the right place to resolve that contradiction, and it is not a cgroup
property. #599 (gate dispatch on host memory and IO pressure), landed as ADR 0088
(`host-pressure-dispatch-gate-and-disk-backed-scratch`), decides whether the host can afford
another provider *before* one is spawned; this decision only stops the cgroup configuration from
manufacturing stalls in the meantime.

### `OOMScoreAdjust=` is not available on a scope

Biasing the kernel's victim selection toward providers (and away from the daemon) would sharpen
this further, but `systemd-run --user --scope -p OOMScoreAdjust=500` is rejected with
`Unknown assignment: OOMScoreAdjust=500` — verified against systemd 261. Scope units carry no exec
context, because the manager does not fork the process. Raising a provider tree's
`oom_score_adj` therefore has to be done by the detached supervisor writing `/proc/self/oom_score_adj`
before exec (raising is unprivileged; lowering is not), and sparing the daemon means
`OOMScoreAdjust=` on `symphonika.service`, which is a service unit and does have an exec context.
Both are deferred: this decision removes a mechanism that actively caused stalls, and neither
addition is needed for that.

## Consequences

- **Installed hosts do not get this from an upgrade.** `service install --force` rewrites the unit
  files and runs `daemon-reload`; a running daemon keeps its old slice until
  `systemctl --user restart symphonika.service`. An operator who never re-runs install keeps a
  providers slice with `MemoryHigh=24G` and keeps reproducing the incident. `doctor` therefore
  warns when a providers slice still has a finite `MemoryHigh=` in force, alongside its existing
  drift warnings. This one check reads values, unlike every other slice-drift check: systemd applies
  drop-ins after the base unit in sorted order and the last scalar assignment wins, so the warning
  resolves the winning assignment across `symphonika-providers.slice` and
  `symphonika-providers.slice.d/*.conf`, and treats an empty assignment or `infinity` as no limit at
  all — a drop-in reading `MemoryHigh=infinity` is the idiomatic way to neutralize the base unit's
  value, and warning on the directive's mere presence would nag exactly the operator who fixed it.
  Where the winning assignment lives also decides the remediation: `install --force` rewrites only
  the base unit, so a drop-in-sourced limit is reported against that file with a
  remove-or-override-then-`daemon-reload` instruction instead. The slice-drift design's rule that
  operator-chosen *values* are never drift still governs the *required* directives, which stay a
  presence check against the base file alone.
- **The slice and scope machinery is unchanged in every other respect.** Scopes still give
  cancellation a whole-cgroup kill, still give the startup sweep leaked units to reap, and
  `TasksMax=4096` still bounds a fork bomb. Removing limits is not removing isolation.
- **The box will swap harder before the OOM killer fires.** With `memory.high` gone there is no
  early reclaim pressure on the providers slice. On the measured host that window is short (1.24G
  of swap was in use at the time of the incident), and a brief stutter that resolves in a kill is
  the outcome this decision prefers over a stall that resolves in nothing.
- **A killed provider now fails visibly**, as an `oom-kill` scope failure and a provider process
  exit, rather than hanging until the Run deadline. #269 (routine firings have no watchdog) is what
  bounds the remaining silent-hang cases; it is why this incident cost two hours per firing instead
  of minutes, and it is unaffected by this decision.
- **ADR 0064's "static constants, not per-project configuration" consequence is resolved rather
  than deferred.** There are no per-scope memory constants left to make configurable. Per-project
  memory budgets would now be a question for admission control (#599), not for `systemd-run`
  properties.

## Numbering

ADR `0088` is the most recent number in tree; this ADR is `0089`.
