import type { AgentProviderName } from "../provider.js";
import type { RoutineOutcome } from "./outcome.js";

export type RoutineKind = "git" | "report";

export type RoutineState =
  "active" | "expired" | "inactive" | "disabled" | "invalid";

export type RoutineDisabledReason =
  "operator" | "removed_from_config" | "rejected_tracker_less_host";

export type RoutineFiringState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RoutineNotificationState = "sent" | "skipped" | "failed";

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
  notify?: boolean;
  prompt: string;
  provider: AgentProviderName | null;
  schedule: RoutineSchedule;
  sourcePath: string;
};

// A RoutineDeclaration bound to its declared target Project. The file-level
// `RoutineDeclaration` has no project target (a file cannot know it); the
// service-level `routines:` entry supplies `projectName`. Used by reload,
// the runtime map, and the run store. See ADR 0063.
export type TargetedRoutineDeclaration = RoutineDeclaration & {
  projectName: string;
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
  latestOutcome: RoutineOutcome | null;
  lastAttemptedAt: string | null;
  lastFiredAt: string | null;
  lastSkipAt: string | null;
  lastSkipReason: RoutineSkipReason | null;
  name: string;
  nextFireAt: string | null;
  notify?: boolean;
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
