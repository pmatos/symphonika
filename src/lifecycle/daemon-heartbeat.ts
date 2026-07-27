import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type DaemonHeartbeat = {
  notifyReady: () => Promise<void>;
  notifyWatchdog: () => Promise<void>;
  // Derived from WATCHDOG_USEC (microseconds), undefined when NOTIFY_SOCKET
  // or WATCHDOG_USEC isn't set. The ping must run on its own timer,
  // independent of the tick loop -- coupling it to the tick would either
  // kill a healthy daemon whose configured polling.interval_ms exceeds
  // WatchdogSec, or never ping at all before a config is loaded (see
  // docs/adr/0065).
  watchdogPingIntervalMs: number | undefined;
};

export type DaemonHeartbeatOptions = {
  env?: NodeJS.ProcessEnv;
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
  const enabled =
    typeof env.NOTIFY_SOCKET === "string" && env.NOTIFY_SOCKET.length > 0;

  return {
    notifyReady: async () => {
      if (!enabled) {
        return;
      }
      await runNotify(["--ready"]);
    },
    notifyWatchdog: async () => {
      if (!enabled) {
        return;
      }
      await runNotify(["WATCHDOG=1"]);
    },
    watchdogPingIntervalMs: enabled
      ? derivePingIntervalMs(env.WATCHDOG_USEC)
      : undefined
  };
}

// Whether the daemon's tick loop has made recent-enough progress to
// consider it alive, gating the independent watchdog ping. Deliberately not
// "always ping on schedule" -- that would mask the exact hang this feature
// exists to catch. No config loaded means no ticks are scheduled by design
// (nothing can hang), so that case is unconditionally alive. Otherwise a
// tick more than 3x the live polling interval old is considered stale,
// tolerating normal per-tick timing jitter and occasional slow reconcile
// passes without either masking a real hang or reintroducing the
// tick-coupling bug this decoupling fixes (the bound scales with the live
// interval, not a fixed constant).
export function isTickRecentEnoughForWatchdog(input: {
  configExists: boolean;
  effectiveIntervalMs: number;
  lastTickAtMs: number | undefined;
  now: number;
}): boolean {
  if (!input.configExists || input.lastTickAtMs === undefined) {
    return true;
  }
  return input.now - input.lastTickAtMs <= input.effectiveIntervalMs * 3;
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
