# Systemd watchdog heartbeat and installed-unit drift detection

ADR 0064 split the daemon's own cgroup from spawned providers so a provider's build-tool memory
blowup can no longer wedge the daemon's event loop or the HTTP dashboard through shared
`memory.high` throttling. That ADR explicitly deferred a separate concern: a daemon can still hang
for reasons that have nothing to do with provider memory pressure — a genuine code deadlock, an
unbounded synchronous loop, or host-wide swap exhaustion from processes entirely outside
Symphonika's own slices. `Restart=on-failure` alone never catches this, because it only reacts to
the process actually exiting; a hung-but-alive process sits wedged indefinitely.

## Decision

Give the daemon a systemd watchdog and a human-visible staleness signal, independent of ADR 0064's
memory isolation:

- The generated `.service` unit sets `Type=notify` and `WatchdogSec=90`, with `NotifyAccess=all` and
  `TimeoutStartSec=300`. `Type=notify` holds the unit `activating` — gated on `READY=1` — until
  `TimeoutStartSec` elapses (90s by default, with no override, prior to this addition); startup
  sends `READY=1` only after an initial issue poll and reconcile pass that make real network calls,
  which can plausibly exceed 90s with several configured projects. `WatchdogSec=` only arms once
  `READY=1` has been sent, so a generous startup allowance costs nothing in the runtime hang
  detection below.
  `NotifyAccess=all` is required, not optional: the daemon's notifications are sent by spawning the
  external `systemd-notify` binary as a child process (`src/lifecycle/daemon-heartbeat.ts`), not by
  the daemon's own Node process signalling the socket directly — Node has no built-in `sd_notify`
  primitive, and adding one means a native addon. With `Type=notify`/`WatchdogSec=` alone,
  `NotifyAccess=` implicitly defaults to `main`, which only accepts notifications from the exact
  process systemd tracks as `MainPID`; a message from a child process is silently discarded, and the
  unit would never leave `activating` before restart-looping. `NotifyAccess=all` accepts
  notifications from any process in the unit's control group, which includes the `systemd-notify`
  child.
- `createDaemonHeartbeat` (`src/lifecycle/daemon-heartbeat.ts`) sends `READY=1` once startup
  completes and `WATCHDOG=1` on its own periodic timer, derived from `WATCHDOG_USEC` (the
  microsecond window systemd sets in the environment alongside `NOTIFY_SOCKET` when `WatchdogSec=`
  is configured), pinged at roughly half that window per the conventional `sd_watchdog_enabled(3)`
  guidance. Both calls are no-ops whenever `NOTIFY_SOCKET` (or `WATCHDOG_USEC`, for the watchdog
  ping specifically) isn't set — `symphonika daemon` run bare, a non-systemd host, or CI is
  unaffected, matching the graceful-degrade pattern ADR 0064 already established for
  `systemd-run --user` availability.
- The watchdog ping is intentionally **not** simply "always ping on a fixed timer" — that would
  defeat its own purpose by masking a genuinely hung event loop (the exact failure mode this ADR
  exists to catch). Instead it pings only when the daemon's own tick loop
  (`src/daemon.ts`) has made recent progress relative to its *live* configured polling interval, or
  unconditionally when no config is loaded yet (a fresh install before `symphonika init`, where no
  ticks are scheduled by design and therefore nothing can hang). This also means the watchdog ping
  is deliberately decoupled from the tick's own scheduling interval: `polling.interval_ms` has no
  enforced upper bound, and coupling `WatchdogSec` to it directly would mean either an unconfigured
  daemon is killed for having no ticks at all, or a long-configured polling interval is
  indistinguishable from a hang.
- `/api/status` gains `lastTickAt`/`tickAgeMs`, and the dashboard shows a "daemon may be
  unresponsive" banner when the last tick is older than a threshold that scales with the live
  polling interval (`max(5 minutes, 3x polling.interval_ms)`, `src/http/pages.ts`) — the same
  reasoning as the watchdog ping's own liveness gate, so a long-configured polling interval isn't
  indistinguishable from a genuine stall. The banner's own reference point falls back to when the
  tick loop started scheduling whenever no tick has completed yet — the same fallback
  `isTickRecentEnoughForSystemdWatchdog` uses — so a hung first tick is visible on the dashboard
  too, not just to the systemd watchdog; `/api/status`'s `lastTickAt`/`tickAgeMs` fields themselves
  stay truthfully null pre-first-tick, only the banner's own age computation uses the fallback. A
  human-visible warning an operator can notice on a dashboard visit, before the systemd watchdog
  would eventually restart the unit.
- `symphonika doctor` warns (does not fail) when an installed systemd unit predates this change —
  missing `Type=notify`, `NotifyAccess=all`, a `WatchdogSec=` directive, or a `TimeoutStartSec=`
  directive — pointing the operator at `symphonika service install --force`, and noting that a
  running daemon only picks up the change after an explicit `systemctl --user restart
  symphonika.service` (`--force` only rewrites unit files and reloads systemd's manager
  configuration; it does not restart the unit). It deliberately can't byte-compare the whole
  `.service` file generically (`ExecStart`/`Environment=PATH` are baked in from the operator's
  install-time environment); it checks structural markers instead — `WatchdogSec=`/
  `TimeoutStartSec=` are matched as line-anchored directives (not substring `.includes()`) so an
  operator's own hand-tuned values aren't misreported as drift. The two `.slice` files are checked
  structurally too: each must retain its `[Slice]` section and required resource-directive keys,
  while operator-tuned `MemoryHigh=`, `MemoryMax=`, and `TasksMax=` values are accepted. This keeps
  `doctor` sensitive to incomplete cgroup-split upgrades without recommending a `--force`
  remediation that would overwrite the per-host tuning documented in the README.

## Consequences

- A daemon whose event loop truly stops advancing — for any reason, not just the provider-memory
  pressure ADR 0064 addresses — is killed and restarted by systemd within the watchdog window,
  instead of sitting wedged indefinitely with `Restart=on-failure` never firing.
- Operators get an earlier, human-visible signal (the dashboard banner) before the systemd watchdog
  would eventually act.
- Operators with an already-installed unit that predates this change see no benefit until they
  re-run `symphonika service install --force`, consistent with ADR 0055's and ADR 0064's own
  "re-run install after upgrading" precedent; `doctor` surfaces this as a warning rather than
  silently leaving the operator on a stale, watchdog-less unit.
- The liveness gate on the watchdog ping (recent tick progress relative to the live polling
  interval, falling back to time-since-tick-loop-started before the first tick completes, or
  unconditional only when no config is loaded at all) is intentionally more complex than "always
  ping every `WATCHDOG_USEC` window" — the simpler approach would mask the exact hang this ADR
  exists to catch, including a hang in the very first scheduled tick. This is judged worth the
  added complexity given the failure mode is a silent, multi-hour wedge with no other detection
  today.

## Numbering

ADR `0064` is the most recent number in tree; this ADR is `0065`.
