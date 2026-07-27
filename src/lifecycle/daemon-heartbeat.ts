import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type DaemonHeartbeat = {
  notifyReady: () => Promise<void>;
  notifyWatchdog: () => Promise<void>;
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
    }
  };
}

async function defaultRunNotify(args: string[]): Promise<void> {
  await execFile("systemd-notify", args);
}
