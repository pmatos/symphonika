import { CronExpressionParser } from "cron-parser";

import type { RoutineSchedule, RoutineState } from "./types.js";

const cronAliases = new Map([
  ["hourly", "0 * * * *"],
  ["daily", "0 0 * * *"],
  ["weekly", "0 0 * * 0"],
  ["monthly", "0 0 1 * *"],
  ["yearly", "0 0 1 1 *"]
]);

export function normalizeRoutineCron(cron: string): string {
  const normalized = cron.trim();
  const expanded =
    cronAliases.get(normalized) ??
    cronAliases.get(normalized.replace(/^@/, "")) ??
    normalized.replace(/\s+/g, " ");
  if (expanded.split(" ").length !== 5) {
    throw new Error("expected exactly five fields or a supported alias");
  }
  try {
    CronExpressionParser.parse(expanded);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
  return expanded;
}

export function isIanaTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export type RoutineScheduleEvaluation =
  | { kind: "expired" }
  | { kind: "fire_now"; nextAt?: string }
  | { at: string; kind: "wait_until" };

export type EvaluateRoutineScheduleInput = {
  lastFiredAt: string | null;
  nextFireAt?: string | null;
  now: Date;
  schedule: RoutineSchedule;
  state: RoutineState;
};

export function evaluateRoutineSchedule(
  input: EvaluateRoutineScheduleInput
): RoutineScheduleEvaluation {
  if (input.state !== "active") {
    return { kind: "expired" };
  }

  if ("cron" in input.schedule) {
    const nextFireAt =
      input.nextFireAt ?? nextRecurringFireAt(input.schedule, input.now);
    if (new Date(nextFireAt).getTime() <= input.now.getTime()) {
      return {
        kind: "fire_now",
        nextAt: nextRecurringFireAt(input.schedule, input.now)
      };
    }
    return { at: nextFireAt, kind: "wait_until" };
  }

  if (input.lastFiredAt !== null) {
    return { kind: "expired" };
  }

  const at = new Date(input.schedule.at);
  if (input.now.getTime() >= at.getTime()) {
    return { kind: "fire_now" };
  }

  return {
    at: input.schedule.at,
    kind: "wait_until"
  };
}

export function nextRecurringFireAt(
  schedule: Extract<RoutineSchedule, { cron: string }>,
  after: Date
): string {
  const next = CronExpressionParser.parse(schedule.cron, {
    currentDate: after,
    tz: schedule.tz
  })
    .next()
    .toISOString();
  if (next === null) {
    throw new Error("cron expression did not produce a next firing time");
  }
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
