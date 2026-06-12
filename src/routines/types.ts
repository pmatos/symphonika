import type { AgentProviderName } from "../provider.js";

export type RoutineKind = "report";

export type RoutineState = "active" | "expired" | "inactive";

export type RoutineFiringState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RoutineSchedule = {
  at: string;
};

export type RoutineDeclaration = {
  kind: RoutineKind;
  name: string;
  prompt: string;
  provider: AgentProviderName | null;
  schedule: RoutineSchedule;
  sourcePath: string;
};

export type RoutineStatus = {
  kind: RoutineKind;
  lastFiredAt: string | null;
  name: string;
  nextFireAt: string | null;
  projectName: string;
  provider: AgentProviderName | null;
  scheduleAt: string;
  sourcePath: string;
  state: RoutineState;
};
