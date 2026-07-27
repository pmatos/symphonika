import { describe, expect, it } from "vitest";

import {
  createDaemonHeartbeat,
  isTickRecentEnoughForWatchdog
} from "../src/lifecycle/daemon-heartbeat.js";

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

  // Regression: watchdog pings coupled to the polling tick kill a healthy
  // daemon whenever polling.interval_ms exceeds WatchdogSec, and never ping
  // at all when no config is loaded yet (no ticks scheduled). The ping must
  // run on its own timer, independent of the tick loop -- derived from
  // WATCHDOG_USEC (microseconds, set by systemd alongside NOTIFY_SOCKET
  // whenever WatchdogSec= is configured), at roughly half that window per
  // the conventional sd_watchdog_enabled(3) guidance.
  describe("watchdogPingIntervalMs", () => {
    it("is undefined when NOTIFY_SOCKET is unset", () => {
      const heartbeat = createDaemonHeartbeat({
        env: { WATCHDOG_USEC: "90000000" }
      });

      expect(heartbeat.watchdogPingIntervalMs).toBeUndefined();
    });

    it("is undefined when WATCHDOG_USEC is unset (no WatchdogSec= configured)", () => {
      const heartbeat = createDaemonHeartbeat({
        env: { NOTIFY_SOCKET: "/run/user/1000/systemd/notify" }
      });

      expect(heartbeat.watchdogPingIntervalMs).toBeUndefined();
    });

    it("is undefined when WATCHDOG_USEC is not a positive integer", () => {
      const heartbeat = createDaemonHeartbeat({
        env: {
          NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
          WATCHDOG_USEC: "not-a-number"
        }
      });

      expect(heartbeat.watchdogPingIntervalMs).toBeUndefined();
    });

    it("derives roughly half of WATCHDOG_USEC, converted to milliseconds", () => {
      const heartbeat = createDaemonHeartbeat({
        env: {
          NOTIFY_SOCKET: "/run/user/1000/systemd/notify",
          WATCHDOG_USEC: "90000000"
        }
      });

      expect(heartbeat.watchdogPingIntervalMs).toBe(45_000);
    });
  });
});

// Regression: the ping must not simply fire on a fixed schedule regardless
// of daemon health -- that would mask the exact hang this feature exists to
// catch. It pings only when the tick loop has made recent progress relative
// to its own live polling interval, or unconditionally when no config is
// loaded yet (no ticks are scheduled by design in that case, so nothing can
// hang). Deliberately decoupled from any fixed WatchdogSec constant: a
// long-configured polling interval must not be indistinguishable from a
// hang, which is the bug this whole feature fixes.
describe("isTickRecentEnoughForWatchdog", () => {
  it("is always alive when no config is loaded (no ticks are ever scheduled)", () => {
    expect(
      isTickRecentEnoughForWatchdog({
        configExists: false,
        effectiveIntervalMs: 30_000,
        lastTickAtMs: undefined,
        now: 10_000_000,
        tickLoopStartedAtMs: undefined
      })
    ).toBe(true);
  });

  it("is alive shortly after the tick loop starts, before the first tick completes", () => {
    expect(
      isTickRecentEnoughForWatchdog({
        configExists: true,
        effectiveIntervalMs: 30_000,
        lastTickAtMs: undefined,
        now: 1_000,
        tickLoopStartedAtMs: 0
      })
    ).toBe(true);
  });

  // Regression: lastTickAtMs === undefined used to be treated as "always
  // alive" unconditionally -- correct while no config is loaded (nothing is
  // scheduled), but wrong once a config exists: if the very first scheduled
  // tick hangs, lastTickAtMs never gets set and the ping would fire forever,
  // masking a startup hang exactly like the one this feature exists to
  // catch. It must fall back to tickLoopStartedAtMs and apply the same
  // staleness bound.
  it("is stale if the first tick never completes past the derived bound", () => {
    const intervalMs = 30_000;

    expect(
      isTickRecentEnoughForWatchdog({
        configExists: true,
        effectiveIntervalMs: intervalMs,
        lastTickAtMs: undefined,
        now: intervalMs * 3 + 1,
        tickLoopStartedAtMs: 0
      })
    ).toBe(false);
  });

  it("stays alive with a polling interval far larger than a typical watchdog window", () => {
    // A 5-minute polling interval would starve a tick-coupled watchdog ping
    // under WatchdogSec=90 -- the exact bug this decoupling fixes. A tick
    // completed 45s ago is trivially recent relative to a 300s interval.
    expect(
      isTickRecentEnoughForWatchdog({
        configExists: true,
        effectiveIntervalMs: 300_000,
        lastTickAtMs: 1_000_000,
        now: 1_045_000,
        tickLoopStartedAtMs: 0
      })
    ).toBe(true);
  });

  it("is stale once a tick is overdue past the derived bound", () => {
    const intervalMs = 30_000;
    const lastTickAtMs = 1_000_000;

    expect(
      isTickRecentEnoughForWatchdog({
        configExists: true,
        effectiveIntervalMs: intervalMs,
        lastTickAtMs,
        now: lastTickAtMs + intervalMs * 3 + 1,
        tickLoopStartedAtMs: 0
      })
    ).toBe(false);
  });

  it("is still alive exactly at the staleness boundary", () => {
    const intervalMs = 30_000;
    const lastTickAtMs = 1_000_000;

    expect(
      isTickRecentEnoughForWatchdog({
        configExists: true,
        effectiveIntervalMs: intervalMs,
        lastTickAtMs,
        now: lastTickAtMs + intervalMs * 3,
        tickLoopStartedAtMs: 0
      })
    ).toBe(true);
  });

  it("is alive with no reference point at all (defensive default)", () => {
    // Shouldn't happen in practice once config exists -- tickLoopStartedAtMs
    // is always set alongside pollTimer -- but must not false-positive as
    // stale in the absence of any timestamp to compare against.
    expect(
      isTickRecentEnoughForWatchdog({
        configExists: true,
        effectiveIntervalMs: 30_000,
        lastTickAtMs: undefined,
        now: 999_999_999,
        tickLoopStartedAtMs: undefined
      })
    ).toBe(true);
  });
});
