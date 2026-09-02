import { describe, expect, it, vi } from "vitest";

import { ScheduledWorkRegistry } from "../src/lifecycle/scheduled-work.js";

describe("ScheduledWorkRegistry", () => {
  it("reports delayed work refused after shutdown", async () => {
    const registry = new ScheduledWorkRegistry();
    await registry.cancelAll();

    const accepted = registry.scheduleDelayed({
      delayMs: 1_000,
      fire: () => Promise.resolve(),
      issueNumber: 7,
      kind: "retry",
      projectName: "symphonika",
      runId: "run-a"
    });

    expect(accepted).toBe(false);
    expect(registry.peekDelayed()).toHaveLength(0);
  });

  it("rejects a second scheduled item for the same project issue", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ScheduledWorkRegistry();
      const accepted = registry.scheduleDelayed({
        delayMs: 1_000,
        fire: () => Promise.resolve(),
        issueNumber: 7,
        kind: "retry",
        projectName: "symphonika",
        runId: "run-a"
      });

      expect(accepted).toBe(true);
      expect(() =>
        registry.scheduleDelayed({
          delayMs: 1_000,
          fire: () => Promise.resolve(),
          issueNumber: 7,
          kind: "continuation",
          projectName: "symphonika",
          runId: "run-b"
        })
      ).toThrow(/scheduled work already exists/);
      expect(registry.peekDelayed()).toHaveLength(1);

      await registry.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });

  // A timer accepted before cancelAll() latches the registry never gets to
  // fire once cancelAll() clears it — onShutdown is the caller's only
  // remaining chance to record that outcome. See issue #663 / PR #674 review.
  it("invokes onShutdown for accepted work cleared before it fired", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ScheduledWorkRegistry();
      const fire = vi.fn().mockResolvedValue(undefined);
      const onShutdown = vi.fn().mockResolvedValue(undefined);
      const accepted = registry.scheduleDelayed({
        delayMs: 1_000,
        fire,
        issueNumber: 7,
        kind: "retry",
        onShutdown,
        projectName: "symphonika",
        runId: "run-a"
      });
      expect(accepted).toBe(true);

      await registry.cancelAll();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onShutdown).toHaveBeenCalledOnce();
      expect(fire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invoke onShutdown for work whose timer already fired", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ScheduledWorkRegistry();
      const fire = vi.fn().mockResolvedValue(undefined);
      const onShutdown = vi.fn().mockResolvedValue(undefined);
      registry.scheduleDelayed({
        delayMs: 1_000,
        fire,
        issueNumber: 7,
        kind: "retry",
        onShutdown,
        projectName: "symphonika",
        runId: "run-a"
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fire).toHaveBeenCalledOnce();

      await registry.cancelAll();
      expect(onShutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows an onShutdown rejection instead of rejecting cancelAll", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ScheduledWorkRegistry();
      registry.scheduleDelayed({
        delayMs: 1_000,
        fire: () => Promise.resolve(),
        issueNumber: 7,
        kind: "retry",
        onShutdown: () => Promise.reject(new Error("boom")),
        projectName: "symphonika",
        runId: "run-a"
      });

      await expect(registry.cancelAll()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
