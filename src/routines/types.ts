import type { AgentProviderName } from "../provider.js";

export type RoutineKind = "git" | "report";

export type RoutineState =
  | "active"
  | "expired"
  | "inactive"
  | "disabled"
  | "invalid";

export type RoutineDisabledReason = "operator" | "removed_from_config";

export type RoutineFiringState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RoutineCatchUpPolicy = "skip" | "fire_once_if_missed";

export type RoutineSkipReason =
  "overlap" | "concurrency_cap" | "catch_up_window";

export type RoutineSchedule = { at: string } | { cron: string; tz: string };

export type RoutineDeclaration = {
  allowOverlap?: boolean;
  catchUp?: RoutineCatchUpPolicy;
  disabled?: boolean;
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
  allowOverlap: boolean;
  catchUp: RoutineCatchUpPolicy;
  disabledReason: RoutineDisabledReason | null;
  kind: RoutineKind;
  lastAttemptedAt: string | null;
  lastFiredAt: string | null;
  lastSkipAt: string | null;
  lastSkipReason: RoutineSkipReason | null;
  name: string;
  nextFireAt: string | null;
  projectName: string;
  provider: AgentProviderName | null;
  pullRequestNumbers: number[];
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
  skipCounts24h: Record<RoutineSkipReason, number>;
  sourcePath: string;
  state: RoutineState;
};
