import { describe, expect, it } from "vitest";

import { InFlightRunRegistry } from "../src/lifecycle/in-flight-runs.js";

describe("InFlightRunRegistry", () => {
  it("rejects a second in-flight run for the same project issue", () => {
    const registry = new InFlightRunRegistry();
    registry.register({
      cancel: () => Promise.resolve(),
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });

    expect(() =>
      registry.register({
        cancel: () => Promise.resolve(),
        issueNumber: 7,
        projectName: "symphonika",
        runId: "run-b"
      })
    ).toThrow(/in-flight run already exists/);
  });

  it("reserveSlot inserts an entry that locks the project-issue without a provider", () => {
    const registry = new InFlightRunRegistry();
    registry.reserveSlot({
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });

    expect(registry.isIssueInFlight("symphonika", 7)).toBe(true);
    expect(registry.list()).toHaveLength(1);
    const entry = registry.get("run-a");
    expect(entry?.provider).toBeUndefined();
    expect(entry?.cancelRequested).toBe(false);
  });

  it("reserveSlot rejects a second reservation for the same project-issue", () => {
    const registry = new InFlightRunRegistry();
    registry.reserveSlot({
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });

    expect(() =>
      registry.reserveSlot({
        issueNumber: 7,
        projectName: "symphonika",
        runId: "run-b"
      })
    ).toThrow(/in-flight run already exists/);
  });

  it("attachProvider binds cancel and provider onto a reserved slot", async () => {
    const registry = new InFlightRunRegistry();
    registry.reserveSlot({
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });

    let cancelCalled = false;
    const cancel = (): Promise<void> => {
      cancelCalled = true;
      return Promise.resolve();
    };
    registry.attachProvider("run-a", {
      cancel,
      provider: { name: "codex" } as never
    });

    const entry = registry.get("run-a");
    expect(entry?.provider).toBeDefined();
    await registry.requestCancel("run-a", "closed_issue");
    expect(cancelCalled).toBe(true);
  });

  it("attachProvider throws if runId has not been reserved", () => {
    const registry = new InFlightRunRegistry();

    expect(() =>
      registry.attachProvider("unknown-run", {
        cancel: () => Promise.resolve(),
        provider: { name: "codex" } as never
      })
    ).toThrow(/no in-flight run for/);
  });

  it("attachProvider invokes the newly attached cancel when cancelRequested is already set", async () => {
    const registry = new InFlightRunRegistry();
    registry.reserveSlot({
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });

    // Cancel arrives BEFORE the provider is attached — the reserveSlot noop
    // is what got invoked, but the next stage of the dispatch (attachProvider)
    // must hand the cancel off to the real handler so the provider is
    // actually cancelled. See ADR 0052.
    await registry.requestCancel("run-a", "closed_issue");

    let realCancelCalled = false;
    const realCancel = (): Promise<void> => {
      realCancelCalled = true;
      return Promise.resolve();
    };
    registry.attachProvider("run-a", {
      cancel: realCancel,
      provider: { name: "codex" } as never
    });

    // Give the void-awaited cancel a microtask to run.
    await Promise.resolve();
    expect(realCancelCalled).toBe(true);
  });

  it("requestCancel on a reserved-only slot still flips cancelRequested", async () => {
    const registry = new InFlightRunRegistry();
    registry.reserveSlot({
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });

    await registry.requestCancel("run-a", "closed_issue");
    const entry = registry.get("run-a");
    expect(entry?.cancelRequested).toBe(true);
    expect(entry?.cancelReason).toBe("closed_issue");
  });

  it("count and countByProject return live in-flight totals", () => {
    const registry = new InFlightRunRegistry();
    expect(registry.count()).toBe(0);
    expect(registry.countByProject("symphonika")).toBe(0);

    registry.reserveSlot({
      issueNumber: 7,
      projectName: "symphonika",
      runId: "run-a"
    });
    registry.reserveSlot({
      issueNumber: 8,
      projectName: "symphonika",
      runId: "run-b"
    });
    registry.reserveSlot({
      issueNumber: 9,
      projectName: "other",
      runId: "run-c"
    });

    expect(registry.count()).toBe(3);
    expect(registry.countByProject("symphonika")).toBe(2);
    expect(registry.countByProject("other")).toBe(1);
    expect(registry.countByProject("nobody")).toBe(0);

    registry.unregister("run-b");
    expect(registry.count()).toBe(2);
    expect(registry.countByProject("symphonika")).toBe(1);
  });
});
