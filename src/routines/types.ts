import type { AgentProviderName } from "../provider.js";

export type RoutineKind = "git" | "report";

export type RoutineState = "active" | "expired" | "inactive";

export type RoutineFiringState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RoutineSchedule = { at: string } | { cron: string; tz: string };

export type RoutineDeclaration = {
  kind: RoutineKind;
  name: string;
  prompt: string;
  provider: AgentProviderName | null;
  schedule: RoutineSchedule;
  sourcePath: string;
};

export type RoutinePullRequestStatus = {
  firingId: string;
  headSha: string;
  prNumber: number;
  projectName: string;
  routineName: string;
};

export type RoutineStatus = {
  kind: RoutineKind;
  lastFiredAt: string | null;
  name: string;
  nextFireAt: string | null;
  projectName: string;
  provider: AgentProviderName | null;
  pullRequestNumbers: number[];
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
  sourcePath: string;
  state: RoutineState;
};
