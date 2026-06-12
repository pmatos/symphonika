import { describe, expect, it } from "vitest";

import { evaluateRoutineSchedule } from "../src/routines/schedule.js";

describe("ScheduleEvaluator", () => {
  it("waits until a future one-shot at schedule", () => {
    const result = evaluateRoutineSchedule({
      lastFiredAt: null,
      now: new Date("2026-05-22T10:00:00.000Z"),
      schedule: { at: "2026-05-22T10:01:00.000Z" },
      state: "active"
    });

    expect(result).toEqual({
      at: "2026-05-22T10:01:00.000Z",
      kind: "wait_until"
    });
  });

  it("fires once when now reaches the one-shot at time", () => {
    const result = evaluateRoutineSchedule({
      lastFiredAt: null,
      now: new Date("2026-05-22T10:01:00.000Z"),
      schedule: { at: "2026-05-22T10:01:00.000Z" },
      state: "active"
    });

    expect(result).toEqual({ kind: "fire_now" });
  });

  it("expires after a one-shot routine has fired", () => {
    const result = evaluateRoutineSchedule({
      lastFiredAt: "2026-05-22T10:01:02.000Z",
      now: new Date("2026-05-22T10:02:00.000Z"),
      schedule: { at: "2026-05-22T10:01:00.000Z" },
      state: "expired"
    });

    expect(result).toEqual({ kind: "expired" });
  });
});
