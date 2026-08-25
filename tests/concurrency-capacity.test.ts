import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECT_MAX_IN_FLIGHT,
  evaluateConcurrencyCapacity,
  isGlobalCapReached,
  isProjectCapReached,
  resolveProjectMaxInFlight
} from "../src/lifecycle/concurrency-capacity.js";

describe("resolveProjectMaxInFlight", () => {
  it("defaults an omitted per-project cap to the serial default of 1", () => {
    // ADR 0053: omitting max_in_flight preserves legacy serial behavior.
    expect(DEFAULT_PROJECT_MAX_IN_FLIGHT).toBe(1);
    expect(resolveProjectMaxInFlight(undefined)).toBe(1);
  });

  it("passes a configured per-project cap through unchanged", () => {
    expect(resolveProjectMaxInFlight(4)).toBe(4);
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
  it("uses the serial default when the cap is omitted", () => {
    expect(isProjectCapReached(undefined, 0)).toBe(false);
    expect(isProjectCapReached(undefined, 1)).toBe(true);
  });

  it("is reached at or above the configured cap", () => {
    expect(isProjectCapReached(2, 1)).toBe(false);
    expect(isProjectCapReached(2, 2)).toBe(true);
    expect(isProjectCapReached(2, 3)).toBe(true);
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

  it("reports the default project cap in the reason when omitted", () => {
    expect(
      evaluateConcurrencyCapacity({
        ...base,
        configuredProjectMax: undefined,
        projectInFlight: 1
      })
    ).toEqual({
      admitted: false,
      reason: "project alpha max_in_flight (1) reached",
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

  it("admits when the global cap is undefined and the project has headroom", () => {
    expect(
      evaluateConcurrencyCapacity({ ...base, globalMax: undefined })
    ).toEqual({ admitted: true });
  });
});
