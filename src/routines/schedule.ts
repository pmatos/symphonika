import type { RoutineState } from "./types.js";

type RoutineOneShotSchedule = {
  at: string;
};

export type RoutineScheduleEvaluation =
  | { kind: "expired" }
  | { kind: "fire_now" }
  | { at: string; kind: "wait_until" };

export type EvaluateRoutineScheduleInput = {
  lastFiredAt: string | null;
  now: Date;
  schedule: RoutineOneShotSchedule;
  state: RoutineState;
};

export function evaluateRoutineSchedule(
  input: EvaluateRoutineScheduleInput
): RoutineScheduleEvaluation {
  if (input.state !== "active" || input.lastFiredAt !== null) {
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
