import { describe, expect, it } from "vitest";

import { UpdateCoordinator } from "../../src/update/coordinator.js";
import type { UpdateOps } from "../../src/update/coordinator.js";
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

  it("does nothing when the release check is skipped or errors", async () => {
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
      const coordinator = new UpdateCoordinator({
        activeRuns: { countInFlight: () => 0 },
        currentVersion: "1.0.0",
        daemonHealthNotifier: notifier,
        isSelfUpdateEnabled: () => true,
        ops
      });

      coordinator.tick();
      await flushMicrotasks();

      expect(ops.calls).toEqual(["getLatestRelease"]);
      expect(notifier.calls).toEqual([]);
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
