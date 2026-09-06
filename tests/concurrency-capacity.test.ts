import { describe, expect, it } from "vitest";

import {
  evaluateConcurrencyCapacity,
  isGlobalCapReached,
  isProjectCapReached,
  resolveProjectMaxInFlight
} from "../src/lifecycle/concurrency-capacity.js";

describe("resolveProjectMaxInFlight", () => {
  it("passes a configured per-project cap through unchanged, even with a global cap set", () => {
    expect(resolveProjectMaxInFlight(4, 16)).toBe(4);
  });

  it("falls back to the resolved global cap when the project cap is omitted", () => {
    // ADR-2026-09-06-1010: an omitted per-project cap now inherits the
    // fleet-wide cap instead of hardcoding a serial default of 1.
    expect(resolveProjectMaxInFlight(undefined, 16)).toBe(16);
  });

  it("is unbounded when both the project and global caps are omitted", () => {
    expect(resolveProjectMaxInFlight(undefined, undefined)).toBeUndefined();
  });
});

describe("isGlobalCapReached", () => {
  it("treats an undefined global cap as unlimited", () => {
    expect(isGlobalCapReached(undefined, 1_000)).toBe(false);
  });

  it("is reached when in-flight equals the cap", () => {
    expect(isGlobalCapReached(3, 3)).toBe(true);
  });

  it("is reached when in-flight exceeds the cap", () => {
    expect(isGlobalCapReached(3, 4)).toBe(true);
  });

  it("is not reached below the cap", () => {
    expect(isGlobalCapReached(3, 2)).toBe(false);
  });
});

describe("isProjectCapReached", () => {
  it("falls back to the global cap when the project cap is omitted", () => {
    expect(isProjectCapReached(undefined, 15, 16)).toBe(false);
    expect(isProjectCapReached(undefined, 16, 16)).toBe(true);
  });

  it("is never reached when both project and global caps are omitted", () => {
    expect(isProjectCapReached(undefined, 0, undefined)).toBe(false);
    expect(isProjectCapReached(undefined, 1_000_000, undefined)).toBe(false);
  });

  it("is reached at or above the configured cap regardless of the global cap", () => {
    expect(isProjectCapReached(2, 1, undefined)).toBe(false);
    expect(isProjectCapReached(2, 2, undefined)).toBe(true);
    expect(isProjectCapReached(2, 3, 16)).toBe(true);
  });
});

describe("evaluateConcurrencyCapacity", () => {
  const base = {
    configuredProjectMax: 2,
    globalInFlight: 0,
    globalMax: 5,
    projectInFlight: 0,
    projectName: "alpha"
  };

  it("admits when both global and project have headroom", () => {
    expect(evaluateConcurrencyCapacity(base)).toEqual({ admitted: true });
  });

  it("refuses on the global cap with the canonical reason string", () => {
    expect(evaluateConcurrencyCapacity({ ...base, globalInFlight: 5 })).toEqual(
      {
        admitted: false,
        reason: "global max_in_flight (5) reached",
        scope: "global"
      }
    );
  });

  it("refuses on the project cap with the canonical reason string", () => {
    expect(
      evaluateConcurrencyCapacity({ ...base, projectInFlight: 2 })
    ).toEqual({
      admitted: false,
      reason: "project alpha max_in_flight (2) reached",
      scope: "project"
    });
  });

  it("reports the resolved global cap in the reason when the project cap is omitted", () => {
    expect(
      evaluateConcurrencyCapacity({
        ...base,
        configuredProjectMax: undefined,
        projectInFlight: 5
      })
    ).toEqual({
      admitted: false,
      reason: "project alpha max_in_flight (5) reached",
      scope: "project"
    });
  });

  it("checks the global cap before the project cap", () => {
    // When both caps are breached, the global scope wins, matching the
    // original inline ordering that guards the daemon-wide limit first.
    expect(
      evaluateConcurrencyCapacity({
        ...base,
        globalInFlight: 5,
        projectInFlight: 2
      })
    ).toEqual({
      admitted: false,
      reason: "global max_in_flight (5) reached",
      scope: "global"
    });
  });

  it("admits when the global cap is undefined and the project has an explicit cap with headroom", () => {
    expect(
      evaluateConcurrencyCapacity({ ...base, globalMax: undefined })
    ).toEqual({ admitted: true });
  });

  it("admits an unbounded project regardless of in-flight count when both caps are omitted", () => {
    expect(
      evaluateConcurrencyCapacity({
        ...base,
        configuredProjectMax: undefined,
        globalMax: undefined,
        projectInFlight: 1_000_000
      })
    ).toEqual({ admitted: true });
  });
});
