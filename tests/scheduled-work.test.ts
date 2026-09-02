import { describe, expect, it, vi } from "vitest";

import { ScheduledWorkRegistry } from "../src/lifecycle/scheduled-work.js";

describe("ScheduledWorkRegistry", () => {
  it("reports delayed work refused after shutdown", () => {
    const registry = new ScheduledWorkRegistry();
    registry.cancelAll();

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

  it("rejects a second scheduled item for the same project issue", () => {
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

      registry.cancelAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
