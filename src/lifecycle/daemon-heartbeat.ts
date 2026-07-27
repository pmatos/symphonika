import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "pino";

const execFile = promisify(execFileCallback);

export type DaemonHeartbeat = {
  notifyReady: () => Promise<void>;
  notifySystemdWatchdog: () => Promise<void>;
  // Derived from WATCHDOG_USEC (microseconds), undefined when NOTIFY_SOCKET
  // or WATCHDOG_USEC isn't set. The ping must run on its own timer,
  // independent of the tick loop -- coupling it to the tick would either
  // kill a healthy daemon whose configured polling.interval_ms exceeds
  // WatchdogSec, or never ping at all before a config is loaded (see
  // docs/adr/0065).
  systemdWatchdogPingIntervalMs: number | undefined;
};

export type DaemonHeartbeatOptions = {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  runNotify?: (args: string[]) => Promise<void>;
};

// NOTIFY_SOCKET is only set by systemd when the unit is Type=notify (see
// docs/adr/0065 and renderServiceUnit in service.ts). Under any other
// invocation — symphonika daemon run bare, a non-systemd host, or an
// installed unit that predates this change — this is a no-op, matching the
// pattern already established for process-scope.ts's graceful degrade.
export function createDaemonHeartbeat(
  options: DaemonHeartbeatOptions = {}
): DaemonHeartbeat {
  const env = options.env ?? process.env;
  const runNotify = options.runNotify ?? defaultRunNotify;
  const logger = options.logger;
  const enabled =
    typeof env.NOTIFY_SOCKET === "string" && env.NOTIFY_SOCKET.length > 0;

  // A failed systemd-notify call (missing binary, transient socket error)
  // must never crash the daemon this heartbeat exists to keep alive:
  // notifyReady is awaited directly by startDaemon(), and
  // notifySystemdWatchdog is fired from a bare `void` at its call site with
  // no .catch() -- either a rejection here would abort startup or become an
  // unhandled promise rejection that kills the process by default (Node's
  // --unhandled-rejections=throw). Swallow and log instead, matching the
  // pattern process-scope.ts's own systemd calls already use.
  const notify = async (args: string[]): Promise<void> => {
    if (!enabled) {
      return;
    }
    try {
      await runNotify(args);
    } catch (error) {
      logger?.warn({ args, err: error }, "symphonika systemd-notify failed");
    }
  };

  return {
    notifyReady: () => notify(["--ready"]),
    notifySystemdWatchdog: () => notify(["WATCHDOG=1"]),
    systemdWatchdogPingIntervalMs: enabled
      ? derivePingIntervalMs(env.WATCHDOG_USEC)
      : undefined
  };
}

// Whether the daemon's tick loop has made recent-enough progress to
// consider it alive, gating the independent watchdog ping. Deliberately not
// "always ping on schedule" -- that would mask the exact hang this feature
// exists to catch. No config loaded means no ticks are scheduled by design
// (nothing can hang), so that case is unconditionally alive. Once a config
// is loaded, lastTickAtMs === undefined no longer means "nothing can hang"
// -- it means the first scheduled tick hasn't completed yet, and that tick
// can hang just like any later one. tickLoopStartedAtMs is the fallback
// reference for that pre-first-tick window, subject to the same staleness
// bound, so a hung first tick doesn't ping forever. Otherwise a tick (or the
// tick loop's start) more than 3x the live polling interval old is
// considered stale, tolerating normal per-tick timing jitter and occasional
// slow reconcile passes without either masking a real hang or reintroducing
// the tick-coupling bug this decoupling fixes (the bound scales with the
// live interval, not a fixed constant).
export function isTickRecentEnoughForSystemdWatchdog(input: {
  configExists: boolean;
  effectiveIntervalMs: number;
  lastTickAtMs: number | undefined;
  now: number;
  tickLoopStartedAtMs: number | undefined;
}): boolean {
  if (!input.configExists) {
    return true;
  }
  const referenceAtMs = input.lastTickAtMs ?? input.tickLoopStartedAtMs;
  if (referenceAtMs === undefined) {
    return true;
  }
  return input.now - referenceAtMs <= input.effectiveIntervalMs * 3;
}

// Half the watchdog window, per the conventional sd_watchdog_enabled(3)
// guidance, so at least one ping lands within systemd's own deadline even
// if a single ping is delayed or dropped.
function derivePingIntervalMs(
  watchdogUsec: string | undefined
): number | undefined {
  if (watchdogUsec === undefined) {
    return undefined;
  }
  const usec = Number.parseInt(watchdogUsec, 10);
  if (!Number.isFinite(usec) || usec <= 0) {
    return undefined;
  }
  return Math.floor(usec / 2 / 1000);
}

async function defaultRunNotify(args: string[]): Promise<void> {
  await execFile("systemd-notify", args);
}
