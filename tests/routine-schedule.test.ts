import { describe, expect, it } from "vitest";

import {
  evaluateRoutineSchedule,
  normalizeRoutineCron
} from "../src/routines/schedule.js";

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

  it.each([
    ["hourly", "0 * * * *"],
    ["daily", "0 0 * * *"],
    ["weekly", "0 0 * * 0"],
    ["monthly", "0 0 1 * *"],
    ["yearly", "0 0 1 1 *"]
  ])("expands the %s alias to canonical cron", (alias, cron) => {
    expect(normalizeRoutineCron(alias)).toBe(cron);
    expect(normalizeRoutineCron(`@${alias}`)).toBe(cron);
  });

  it.each([
    ["forward", "2026-03-28T02:00:00.000Z", "2026-03-29T01:30:00.000Z"],
    ["backward", "2026-10-24T02:00:00.000Z", "2026-10-25T00:30:00.000Z"]
  ])(
    "computes the next Europe/Lisbon fire across the DST %s boundary",
    (_transition, now, expected) => {
      const result = evaluateRoutineSchedule({
        lastFiredAt: null,
        now: new Date(now),
        schedule: { cron: "30 1 * * *", tz: "Europe/Lisbon" },
        state: "active"
      });

      expect(result).toEqual({ at: expected, kind: "wait_until" });
    }
  );

  it("returns strictly-monotonic next fire times across recurring firings", () => {
    const schedule = { cron: "30 1 * * *", tz: "Europe/Lisbon" };
    const first = evaluateRoutineSchedule({
      lastFiredAt: null,
      now: new Date("2026-03-27T02:00:00.000Z"),
      schedule,
      state: "active"
    });
    expect(first).toEqual({
      at: "2026-03-28T01:30:00.000Z",
      kind: "wait_until"
    });

    const second = evaluateRoutineSchedule({
      lastFiredAt: "2026-03-28T01:30:00.000Z",
      nextFireAt: "2026-03-28T01:30:00.000Z",
      now: new Date("2026-03-28T01:30:00.000Z"),
      schedule,
      state: "active"
    });
    expect(second).toEqual({
      kind: "fire_now",
      nextAt: "2026-03-29T01:30:00.000Z"
    });

    const third = evaluateRoutineSchedule({
      lastFiredAt: "2026-03-29T01:30:00.000Z",
      nextFireAt: "2026-03-29T01:30:00.000Z",
      now: new Date("2026-03-29T01:30:00.000Z"),
      schedule,
      state: "active"
    });
    expect(third).toEqual({
      kind: "fire_now",
      nextAt: "2026-03-30T00:30:00.000Z"
    });
  });
});
