import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { UpdateCoordinator } from "../../src/update/coordinator.js";
import type {
  UpdateCoordinatorInput,
  UpdateOps
} from "../../src/update/coordinator.js";
import type { LatestRelease } from "../../src/update/release-client.js";

const RELEASE: LatestRelease = {
  tagName: "v1.2.3",
  version: "1.2.3",
  tarballAsset: { name: "symphonika-1.2.3.tar.gz", url: "https://x/tarball" },
  checksumsAsset: { name: "SHA256SUMS.txt", url: "https://x/checksums" }
};

function flushMicrotasks(times = 20): Promise<void> {
  return new Promise((resolve) => {
    let remaining = times;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      setImmediate(step);
    };
    step();
  });
}

function fakeOps(overrides: Partial<UpdateOps> = {}): UpdateOps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    getLatestRelease: () => {
      calls.push("getLatestRelease");
      return Promise.resolve({ kind: "release", release: RELEASE });
    },
    downloadAndVerify: () => {
      calls.push("downloadAndVerify");
      return Promise.resolve({
        kind: "verified",
        archivePath: "/tmp/archive.tar.gz"
      });
    },
    stageExtractedRelease: () => {
      calls.push("stageExtractedRelease");
      return Promise.resolve({ kind: "staged", stagingPath: "/tmp/staging" });
    },
    runStagedSelfCheck: () => {
      calls.push("runStagedSelfCheck");
      return Promise.resolve({ ok: true, errors: [] });
    },
    cutOver: () => {
      calls.push("cutOver");
      return Promise.resolve({
        kind: "cut-over",
        installPath: "/opt/symphonika"
      });
    },
    checkUnitRegenerationNeeded: () => {
      calls.push("checkUnitRegenerationNeeded");
      return Promise.resolve({ needed: false });
    },
    pruneStale: () => {
      calls.push("pruneStale");
      return Promise.resolve();
    },
    isSystemdAvailable: () => {
      calls.push("isSystemdAvailable");
      return Promise.resolve(true);
    },
    restartService: () => {
      calls.push("restartService");
      return Promise.resolve();
    },
    ...overrides
  };
}

function fakeNotifier() {
  const calls: { broken: boolean; detail?: string }[] = [];
  return {
    calls,
    observeUpdateFailure: (input: { broken: boolean; detail?: string }) => {
      calls.push(input);
    }
  };
}

function fakeLogger(): Logger {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Logger;
}

describe("UpdateCoordinator", () => {
  it("is a no-op when self_update is disabled", async () => {
    const ops = fakeOps();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => false,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(ops.calls).toEqual([]);
    expect(coordinator.isDrainRequested()).toBe(false);
  });

  it("prunes stale artifacts and does nothing else when already up to date", async () => {
    const ops = fakeOps();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.2.3",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => true,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(ops.calls).toEqual(["getLatestRelease", "pruneStale"]);
  });

  it("warns without notifying when the release check is skipped or errors", async () => {
    for (const result of [
      { kind: "skipped" as const, reason: "no token" },
      { kind: "error" as const, error: "network down" }
    ]) {
      const ops = fakeOps({
        getLatestRelease: () => {
          ops.calls.push("getLatestRelease");
          return Promise.resolve(result);
        }
      });
      const notifier = fakeNotifier();
      const logger = fakeLogger();
      const coordinator = new UpdateCoordinator({
        activeRuns: { countInFlight: () => 0 },
        currentVersion: "1.0.0",
        daemonHealthNotifier: notifier,
        isSelfUpdateEnabled: () => true,
        logger,
        ops
      });

      coordinator.tick();
      await flushMicrotasks();

      expect(ops.calls).toEqual(["getLatestRelease"]);
      expect(notifier.calls).toEqual([]);
      // #582: silence here made "no token configured" and "nothing to do"
      // indistinguishable in the journal.
      expect(logger.warn).toHaveBeenCalledWith(
        result.kind === "skipped"
          ? { reason: "no token" }
          : { error: "network down" },
        expect.stringContaining("release check")
      );
    }
  });

  it("runs the full cycle: check -> stage -> smoke-check -> drain -> cutover -> restart", async () => {
    const ops = fakeOps();
    const notifier = fakeNotifier();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: notifier,
      isSelfUpdateEnabled: () => true,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(ops.calls).toEqual([
      "getLatestRelease",
      "downloadAndVerify",
      "stageExtractedRelease",
      "runStagedSelfCheck",
      "checkUnitRegenerationNeeded",
      "cutOver",
      "pruneStale",
      "isSystemdAvailable",
      "restartService"
    ]);
    expect(coordinator.isDrainRequested()).toBe(false);
  });

  it("keeps a completed cutover healthy when unit shutdown interrupts the restart request", async () => {
    const restartError = Object.assign(
      new Error(
        "Command failed: systemctl --user restart --no-block symphonika.service"
      ),
      { killed: false, signal: "SIGTERM" }
    );
    const ops = fakeOps({
      restartService: () => Promise.reject(restartError)
    });
    const notifier = fakeNotifier();
    const logger = fakeLogger();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: notifier,
      isSelfUpdateEnabled: () => true,
      logger,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(ops.calls).toContain("cutOver");
    expect(notifier.calls).toEqual([{ broken: false }]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("requests a manual restart when the restart request times out", async () => {
    const restartError = Object.assign(
      new Error(
        "Command failed: systemctl --user restart --no-block symphonika.service"
      ),
      { killed: true, signal: "SIGTERM" }
    );
    const ops = fakeOps({
      restartService: () => Promise.reject(restartError)
    });
    const notifier = fakeNotifier();
    const logger = fakeLogger();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: notifier,
      isSelfUpdateEnabled: () => true,
      logger,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(notifier.calls).toEqual([{ broken: false }]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { err: restartError },
      expect.stringContaining("restart the daemon manually")
    );
  });

  it("requests a manual restart without marking a completed cutover broken when restart fails", async () => {
    const restartError = new Error("systemctl user session disappeared");
    const ops = fakeOps({
      restartService: () => Promise.reject(restartError)
    });
    const notifier = fakeNotifier();
    const logger = fakeLogger();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: notifier,
      isSelfUpdateEnabled: () => true,
      logger,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(notifier.calls).toEqual([{ broken: false }]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { err: restartError },
      expect.stringContaining("restart the daemon manually")
    );
  });

  it("logs and skips restartService when no systemd session is available", async () => {
    const ops = fakeOps({ isSystemdAvailable: () => Promise.resolve(false) });
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => true,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(ops.calls).not.toContain("restartService");
    expect(ops.calls).toContain("cutOver");
  });

  it("waits for in-flight work to drain before cutting over", async () => {
    let inFlight = 2;
    const sleeps: number[] = [];
    const ops = fakeOps();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => inFlight },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      drainPollIntervalMs: 5,
      isSelfUpdateEnabled: () => true,
      ops,
      sleepImpl: (ms) => {
        sleeps.push(ms);
        inFlight -= 1;
        return Promise.resolve();
      }
    });

    coordinator.tick();
    await flushMicrotasks(50);

    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(ops.calls).toContain("cutOver");
  });

  it("reports failure via the daemon-health notifier and clears the drain flag on error", async () => {
    const ops = fakeOps({
      stageExtractedRelease: () =>
        Promise.resolve({ kind: "error", error: "extraction blew up" })
    });
    const notifier = fakeNotifier();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: notifier,
      isSelfUpdateEnabled: () => true,
      ops
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(ops.calls).not.toContain("cutOver");
    expect(coordinator.isDrainRequested()).toBe(false);
    expect(notifier.calls).toEqual([
      { broken: true, detail: "extraction blew up" }
    ]);
  });

  it("aborts before draining when self_update is toggled off mid-flight", async () => {
    let enabled = true;
    const ops = fakeOps();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => enabled,
      ops: {
        ...ops,
        runStagedSelfCheck: () => {
          ops.calls.push("runStagedSelfCheck");
          enabled = false;
          return Promise.resolve({ ok: true, errors: [] });
        }
      }
    });

    coordinator.tick();
    await flushMicrotasks();

    expect(ops.calls).not.toContain("cutOver");
    expect(ops.calls).not.toContain("restartService");
    expect(coordinator.isDrainRequested()).toBe(false);
  });

  it("does not start a second cycle while one is already in progress", async () => {
    let resolveDownload: (() => void) | undefined;
    const ops = fakeOps({
      downloadAndVerify: () =>
        new Promise((resolve) => {
          resolveDownload = () =>
            resolve({ kind: "verified", archivePath: "/tmp/a.tar.gz" });
        })
    });
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => true,
      ops
    });

    coordinator.tick();
    await flushMicrotasks(5);
    coordinator.tick();
    await flushMicrotasks(5);

    expect(
      ops.calls.filter((call) => call === "getLatestRelease")
    ).toHaveLength(1);

    resolveDownload?.();
    await flushMicrotasks();
  });
});

describe("UpdateCoordinator.runNow", () => {
  function build(
    overrides: Partial<UpdateCoordinatorInput> & { ops?: UpdateOps } = {}
  ): { coordinator: UpdateCoordinator; ops: UpdateOps & { calls: string[] } } {
    const ops = (overrides.ops ?? fakeOps()) as UpdateOps & {
      calls: string[];
    };
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      forcedRestartGraceMs: 0,
      isSelfUpdateEnabled: () => true,
      sleepImpl: () => Promise.resolve(),
      ...overrides,
      ops
    });
    return { coordinator, ops };
  }

  it("reports disabled without touching the release API", async () => {
    const { coordinator, ops } = build({ isSelfUpdateEnabled: () => false });

    await expect(coordinator.runNow()).resolves.toEqual({ kind: "disabled" });
    expect(ops.calls).toEqual([]);
  });

  it("reports up-to-date with the running version", async () => {
    const { coordinator } = build({ currentVersion: "1.2.3" });

    await expect(coordinator.runNow()).resolves.toEqual({
      kind: "up-to-date",
      version: "1.2.3"
    });
  });

  it("reports a skipped release check with its reason", async () => {
    const ops = fakeOps({
      getLatestRelease: () =>
        Promise.resolve({ kind: "skipped", reason: "GITHUB_TOKEN is not set" })
    });
    const { coordinator } = build({ ops });

    await expect(coordinator.runNow()).resolves.toEqual({
      kind: "skipped",
      reason: "GITHUB_TOKEN is not set"
    });
  });

  it("reports a failed release check as an error", async () => {
    const ops = fakeOps({
      getLatestRelease: () =>
        Promise.resolve({ kind: "error", error: "GitHub API 502" })
    });
    const { coordinator } = build({ ops });

    await expect(coordinator.runNow()).resolves.toEqual({
      error: "GitHub API 502",
      kind: "error"
    });
  });

  it("reports a completed cutover and the restart it requested", async () => {
    const { coordinator, ops } = build();

    await expect(coordinator.runNow()).resolves.toEqual({
      fromVersion: "1.0.0",
      kind: "updated",
      restart: "requested",
      toVersion: "1.2.3"
    });
    await flushMicrotasks();
    expect(ops.calls).toContain("restartService");
  });

  it("reports a cutover with no systemd session as needing a manual restart", async () => {
    const ops = fakeOps({ isSystemdAvailable: () => Promise.resolve(false) });
    const { coordinator } = build({ ops });

    await expect(coordinator.runNow()).resolves.toEqual({
      fromVersion: "1.0.0",
      kind: "updated",
      restart: "unavailable",
      toVersion: "1.2.3"
    });
    await flushMicrotasks();
    expect(ops.calls).not.toContain("restartService");
  });

  it("waits for the response to flush before requesting the restart", async () => {
    const graceSleeps: number[] = [];
    const { coordinator, ops } = build({
      forcedRestartGraceMs: 250,
      sleepImpl: (ms) => {
        graceSleeps.push(ms);
        return Promise.resolve();
      }
    });

    const result = await coordinator.runNow();

    expect(result.kind).toBe("updated");
    // The grace runs after the outcome is reported, so the CLI sees
    // "updated" instead of a connection dropped by the restart's SIGTERM.
    expect(ops.calls).not.toContain("restartService");
    await flushMicrotasks();
    expect(graceSleeps).toEqual([250]);
    expect(ops.calls).toContain("restartService");
  });

  it("reports a distinct refusal rather than a generic error", async () => {
    const ops = fakeOps({
      cutOver: () =>
        Promise.resolve({
          kind: "refused",
          reason: "install path is a git checkout"
        })
    });
    const notifier = fakeNotifier();
    const { coordinator } = build({ daemonHealthNotifier: notifier, ops });

    await expect(coordinator.runNow()).resolves.toEqual({
      kind: "refused",
      reason: "install path is a git checkout"
    });
    await flushMicrotasks();
    // A refusal still travels the existing failure path.
    expect(notifier.calls).toEqual([
      { broken: true, detail: "install path is a git checkout" }
    ]);
  });

  it("reports a staging failure as an error", async () => {
    const ops = fakeOps({
      stageExtractedRelease: () =>
        Promise.resolve({ error: "npm ci failed", kind: "error" })
    });
    const { coordinator } = build({ ops });

    await expect(coordinator.runNow()).resolves.toEqual({
      error: "npm ci failed",
      kind: "error"
    });
  });

  it("reports where a cycle halted when self_update is toggled off mid-flight", async () => {
    let enabled = true;
    const ops = fakeOps();
    const { coordinator } = build({
      isSelfUpdateEnabled: () => enabled,
      ops: {
        ...ops,
        stageExtractedRelease: () => {
          ops.calls.push("stageExtractedRelease");
          enabled = false;
          return Promise.resolve({ kind: "staged", stagingPath: "/tmp/s" });
        }
      }
    });

    await expect(coordinator.runNow()).resolves.toEqual({
      kind: "halted",
      phase: "smoke-checking"
    });
    expect(ops.calls).not.toContain("cutOver");
  });

  it("answers at the drain gate instead of blocking on in-flight runs", async () => {
    let inFlight = 2;
    let releaseDrain: (() => void) | undefined;
    const ops = fakeOps();
    const { coordinator } = build({
      activeRuns: { countInFlight: () => inFlight },
      drainPollIntervalMs: 5,
      ops,
      // Parks the drain poll until the test releases it, so "answered while
      // still draining" is asserted rather than raced. Every later sleep
      // (the pre-restart grace) resolves at once.
      sleepImpl: () =>
        inFlight === 0
          ? Promise.resolve()
          : new Promise((resolve) => {
              releaseDrain = () => {
                inFlight = 0;
                resolve();
              };
            })
    });

    await expect(coordinator.runNow()).resolves.toEqual({
      fromVersion: "1.0.0",
      inFlight: 2,
      kind: "draining",
      toVersion: "1.2.3"
    });
    // The caller is answered while live work is still running, and nothing
    // has cut over underneath it.
    expect(ops.calls).not.toContain("cutOver");
    expect(coordinator.isDrainRequested()).toBe(true);

    releaseDrain?.();
    await flushMicrotasks(50);
    expect(ops.calls).toContain("cutOver");
    expect(coordinator.isDrainRequested()).toBe(false);
  });

  it("reports in-progress rather than starting a second cycle", async () => {
    let resolveDownload: (() => void) | undefined;
    const ops = fakeOps({
      downloadAndVerify: () =>
        new Promise((resolve) => {
          resolveDownload = () =>
            resolve({ archivePath: "/tmp/a.tar.gz", kind: "verified" });
        })
    });
    const { coordinator } = build({ ops });

    const first = coordinator.runNow();
    await flushMicrotasks(5);

    await expect(coordinator.runNow()).resolves.toEqual({
      kind: "in-progress"
    });
    expect(
      ops.calls.filter((call) => call === "getLatestRelease")
    ).toHaveLength(1);

    resolveDownload?.();
    await expect(first).resolves.toMatchObject({ kind: "updated" });
    await flushMicrotasks();
  });

  it("resets the tick interval so a forced run is not immediately repeated", async () => {
    const ops = fakeOps({
      getLatestRelease: () => {
        ops.calls.push("getLatestRelease");
        return Promise.resolve({ kind: "error", error: "offline" });
      }
    });
    const { coordinator } = build({ checkIntervalMs: 60_000, ops });

    await coordinator.runNow();
    coordinator.tick();
    await flushMicrotasks();

    expect(
      ops.calls.filter((call) => call === "getLatestRelease")
    ).toHaveLength(1);
  });
});

describe("UpdateCoordinator.checkNow", () => {
  it("reports an available release without staging or cutting over", async () => {
    const ops = fakeOps();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => true,
      ops
    });

    await expect(coordinator.checkNow()).resolves.toEqual({
      currentVersion: "1.0.0",
      kind: "available",
      latestVersion: "1.2.3",
      selfUpdateEnabled: true
    });
    expect(ops.calls).toEqual(["getLatestRelease"]);
  });

  it("still reports availability when self_update is disabled", async () => {
    const ops = fakeOps();
    const coordinator = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => false,
      ops
    });

    await expect(coordinator.checkNow()).resolves.toEqual({
      currentVersion: "1.0.0",
      kind: "available",
      latestVersion: "1.2.3",
      selfUpdateEnabled: false
    });
  });

  it("reports up-to-date and skipped checks", async () => {
    const upToDate = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.2.3",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => true,
      ops: fakeOps()
    });
    await expect(upToDate.checkNow()).resolves.toEqual({
      kind: "up-to-date",
      version: "1.2.3"
    });

    const skipped = new UpdateCoordinator({
      activeRuns: { countInFlight: () => 0 },
      currentVersion: "1.0.0",
      daemonHealthNotifier: fakeNotifier(),
      isSelfUpdateEnabled: () => true,
      ops: fakeOps({
        getLatestRelease: () =>
          Promise.resolve({
            kind: "skipped",
            reason: "GITHUB_TOKEN is not set"
          })
      })
    });
    await expect(skipped.checkNow()).resolves.toEqual({
      kind: "skipped",
      reason: "GITHUB_TOKEN is not set"
    });
  });
});
