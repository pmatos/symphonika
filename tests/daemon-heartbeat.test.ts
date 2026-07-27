import { describe, expect, it } from "vitest";

import { createDaemonHeartbeat } from "../src/lifecycle/daemon-heartbeat.js";

describe("createDaemonHeartbeat", () => {
  it("does nothing when NOTIFY_SOCKET is unset (no systemd notify contract)", async () => {
    let calls = 0;
    const heartbeat = createDaemonHeartbeat({
      env: {},
      runNotify: () => {
        calls += 1;
        return Promise.resolve();
      }
    });

    await heartbeat.notifyReady();
    await heartbeat.notifyWatchdog();

    expect(calls).toBe(0);
  });

  it("sends --ready when NOTIFY_SOCKET is set", async () => {
    const calls: string[][] = [];
    const heartbeat = createDaemonHeartbeat({
      env: { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" },
      runNotify: (args) => {
        calls.push(args);
        return Promise.resolve();
      }
    });

    await heartbeat.notifyReady();

    expect(calls).toEqual([["--ready"]]);
  });

  it("sends WATCHDOG=1 when NOTIFY_SOCKET is set", async () => {
    const calls: string[][] = [];
    const heartbeat = createDaemonHeartbeat({
      env: { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" },
      runNotify: (args) => {
        calls.push(args);
        return Promise.resolve();
      }
    });

    await heartbeat.notifyWatchdog();

    expect(calls).toEqual([["WATCHDOG=1"]]);
  });
});
