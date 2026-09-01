import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import {
  buildWatchdogStatus,
  resolveWatchdogNowMs
} from "../src/watchdog-status.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-watchdog-deadline-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
  }
});

const CONFIG = {
  enabled: true,
  graceMinutes: 30,
  maxRunMinutes: 360,
  outputTokenBudget: 0
};

function issue(number: number): IssueSnapshot {
  return {
    body: "",
    created_at: "2026-05-22T09:00:00.000Z",
    id: number,
    labels: ["agent-ready"],
    number,
    priority: 1,
    state: "open",
    title: "deadline",
    updated_at: "2026-05-22T09:00:00.000Z",
    url: `https://example.test/${number}`
  };
}

function seed(store: RunStore, id: string): void {
  store.createRun({
    id,
    issue: issue(700),
    projectName: "symphonika",
    providerCommand: "codex fake",
    providerName: "codex"
  });
}

describe("watchdog wall-clock deadline surfaces", () => {
  it("pins a sampleless terminal Run's clock to the moment it stopped", async () => {
    const store = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      seed(store, "run-quick");
      // Succeeded before the first Watchdog tick — the common case, since
      // entering preparing_workspace clears the latest sample. With no sample
      // there is nothing to freeze the clock against, so before ADR 0089's
      // countdown existed nothing consumed this path.
      store.updateRunState("run-quick", "succeeded");
      expect(store.getWatchdogSample("run-quick")).toBeUndefined();

      const stoppedAtMs = Date.parse(
        store.latestRunStateTransitionAt("run-quick") ?? ""
      );
      const viewedAnHourLater = stoppedAtMs + 3_600_000;
      const viewedADayLater = stoppedAtMs + 86_400_000;

      const first = resolveWatchdogNowMs({
        liveNowMs: viewedAnHourLater,
        runId: "run-quick",
        runState: "succeeded",
        runStore: store
      });
      const second = resolveWatchdogNowMs({
        liveNowMs: viewedADayLater,
        runId: "run-quick",
        runState: "succeeded",
        runStore: store
      });

      // Same clock however long after the Run stopped it is viewed, so the
      // countdown below cannot drift (ADR 0089).
      expect(first).toBe(stoppedAtMs);
      expect(second).toBe(stoppedAtMs);

      const createdAt = store.getRun("run-quick")?.createdAt ?? "";
      const statuses = [first, second].map((nowMs) =>
        buildWatchdogStatus({
          config: CONFIG,
          nowMs,
          runCreatedAt: createdAt,
          runId: "run-quick",
          runStore: store
        })
      );
      const remaining = statuses.map((status) =>
        status.enabled ? status.runRemainingMs : undefined
      );
      expect(remaining[0]).toBe(remaining[1]);
    } finally {
      store.close();
    }
  });

  it("keeps the live clock for a Run that has not stopped yet", async () => {
    const store = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      seed(store, "run-preparing");
      store.updateRunState("run-preparing", "preparing_workspace");
      const liveNowMs = Date.parse("2026-05-22T12:00:00.000Z");

      // Still moving, so the deadline must keep counting down in real time.
      expect(
        resolveWatchdogNowMs({
          liveNowMs,
          runId: "run-preparing",
          runState: "preparing_workspace",
          runStore: store
        })
      ).toBe(liveNowMs);
    } finally {
      store.close();
    }
  });

  it("renders the countdown before the first sample exists", async () => {
    const store = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      seed(store, "run-unsampled");
      store.updateRunState("run-unsampled", "running");
      const createdAtMs = Date.parse(
        store.getRun("run-unsampled")?.createdAt ?? ""
      );

      const status = buildWatchdogStatus({
        config: CONFIG,
        nowMs: createdAtMs + 60_000,
        runCreatedAt: store.getRun("run-unsampled")?.createdAt ?? "",
        runId: "run-unsampled",
        runStore: store
      });

      // A Run is sampleless through preparation and its first sampling
      // interval, which is exactly when an operator wants the deadline.
      expect(status.enabled && status.sampledAt).toBeUndefined();
      expect(status.enabled && status.runRemainingMs).toBe(
        360 * 60_000 - 60_000
      );
    } finally {
      store.close();
    }
  });

  it("reports the actual deadline when the claim is future-dated", async () => {
    const store = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      const status = buildWatchdogStatus({
        config: CONFIG,
        nowMs: Date.parse("2026-05-22T10:00:00.000Z"),
        runCreatedAt: "2026-05-22T11:00:00.000Z",
        runId: "run-clock-skew",
        runStore: store
      });

      // The cap fires six hours after the future claim, seven hours from now.
      // This is time to enforcement, not a fraction of the cap remaining.
      expect(status).toMatchObject({
        enabled: true,
        maxRunMs: 21_600_000,
        runRemainingMs: 25_200_000
      });
    } finally {
      store.close();
    }
  });

  it("omits the countdown when the cap is disabled or the claim is undatable", async () => {
    const store = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      seed(store, "run-no-cap");
      store.updateRunState("run-no-cap", "running");
      const nowMs = Date.parse("2026-05-22T12:00:00.000Z");

      const capOff = buildWatchdogStatus({
        config: { ...CONFIG, maxRunMinutes: 0 },
        nowMs,
        runCreatedAt: store.getRun("run-no-cap")?.createdAt ?? "",
        runId: "run-no-cap",
        runStore: store
      });
      expect(capOff.enabled && capOff.maxRunMs).toBe(0);
      expect(capOff.enabled && capOff.runRemainingMs).toBeUndefined();

      const undatable = buildWatchdogStatus({
        config: CONFIG,
        nowMs,
        runCreatedAt: "not-a-timestamp",
        runId: "run-no-cap",
        runStore: store
      });
      expect(undatable.enabled && undatable.runRemainingMs).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
