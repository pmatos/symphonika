import { describe, expect, it, vi } from "vitest";

import {
  ActiveRunRegistry,
  CANCEL_REASONS,
  computeRetryDelayMs,
  LIFECYCLE_POLICY
} from "../src/lifecycle/active-runs.js";

function entry(overrides: Partial<{ runId: string; cancel: () => Promise<void> }> = {}) {
  return {
    cancel: overrides.cancel ?? (() => Promise.resolve()),
    issueNumber: 7,
    projectName: "symphonika",
    runId: overrides.runId ?? "run-a"
  };
}

describe("ActiveRunRegistry", () => {
  it("registers and looks up by runId", () => {
    const registry = new ActiveRunRegistry();
    registry.register(entry());

    expect(registry.get("run-a")?.issueNumber).toBe(7);
    expect(registry.list()).toHaveLength(1);
  });

  it("isIssueInFlight reports per-(project,issue) lock", () => {
    const registry = new ActiveRunRegistry();
    registry.register(entry({ runId: "run-a" }));

    expect(registry.isIssueInFlight("symphonika", 7)).toBe(true);
    expect(registry.isIssueInFlight("symphonika", 8)).toBe(false);

    registry.unregister("run-a");
    expect(registry.isIssueInFlight("symphonika", 7)).toBe(false);
  });

  it("requestCancel calls the entry cancel exactly once", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const registry = new ActiveRunRegistry();
    registry.register(entry({ cancel, runId: "run-a" }));

    await registry.requestCancel("run-a", CANCEL_REASONS.CLOSED_ISSUE);
    await registry.requestCancel("run-a", CANCEL_REASONS.CLOSED_ISSUE);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(registry.get("run-a")?.cancelRequested).toBe(true);
    expect(registry.get("run-a")?.cancelReason).toBe("closed_issue");
  });

  it("scheduleDelayed fires after the requested delay and is reported by peekDelayed", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ActiveRunRegistry();
      const fire = vi.fn().mockResolvedValue(undefined);
      registry.scheduleDelayed({
        delayMs: 50,
        fire,
        kind: "retry",
        runId: "run-a"
      });

      const peeked = registry.peekDelayed();
      expect(peeked).toHaveLength(1);
      expect(peeked[0]?.kind).toBe("retry");

      await vi.advanceTimersByTimeAsync(50);
      expect(fire).toHaveBeenCalledTimes(1);
      expect(registry.peekDelayed()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelAll clears pending scheduled work", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ActiveRunRegistry();
      const fire = vi.fn().mockResolvedValue(undefined);
      registry.scheduleDelayed({
        delayMs: 50,
        fire,
        kind: "continuation",
        runId: "run-a"
      });
      registry.cancelAll();
      await vi.advanceTimersByTimeAsync(100);

      expect(fire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("computeRetryDelayMs", () => {
  it("returns the configured delay for each retry slot, then cap", () => {
    expect(computeRetryDelayMs(1)).toBe(LIFECYCLE_POLICY.retry.delaysMs[0]);
    expect(computeRetryDelayMs(2)).toBe(LIFECYCLE_POLICY.retry.delaysMs[1]);
    expect(computeRetryDelayMs(3)).toBe(LIFECYCLE_POLICY.retry.delaysMs[2]);
    expect(computeRetryDelayMs(99)).toBe(LIFECYCLE_POLICY.retry.maxBackoffMs);
  });
});
