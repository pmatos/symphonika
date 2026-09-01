import type { AgentProviderName } from "../provider.js";
import type { RoutineOutcome } from "./outcome.js";

export type RoutineKind = "git" | "report";

export type RoutineState =
  "active" | "expired" | "inactive" | "disabled" | "invalid";

export type RoutineDisabledReason =
  | "operator"
  | "removed_from_config"
  | "rejected_tracker_less_host"
  | "rejected_provider_template_mismatch";

export type RoutineFiringState =
  | "queued"
  | "preparing_workspace"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RoutineNotificationState = "sent" | "skipped" | "failed";

export type RoutineFiringTriggerSource = "manual" | "scheduled";

export type RoutineCatchUpPolicy = "skip" | "fire_once_if_missed";

export type RoutineSkipReason =
  | "overlap"
  | "concurrency_cap"
  | "catch_up_window"
  // The host itself is stalled on memory or I/O, so the firing was held
  // back regardless of how much count-headroom the caps left (ADR 0088).
  | "host_pressure";

// The subset of skip reasons that mean "the host has no capacity right now"
// rather than "this clock event is deliberately dropped". Capacity refusals
// defer and retry instead of skipping, and count as a failed run once the
// deferral outlives its clock event (ADR 0093).
export type RoutineDeferralReason = Extract<
  RoutineSkipReason,
  "concurrency_cap" | "host_pressure"
>;

export type RoutineSchedule = { at: string } | { cron: string; tz: string };

export type RoutineExecutionOverrides = {
  effort?: string;
  model?: string;
  permissionMode?: string;
  timeoutMinutes?: number;
};

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
} & RoutineExecutionOverrides;

// A RoutineDeclaration bound to its declared target Project. The file-level
// `RoutineDeclaration` has no project target (a file cannot know it); the
// service-level `routines:` entry supplies `projectName`. Used by reload,
// the runtime map, and the run store. See ADR 0069.
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

export type RoutineDeferralStatus = {
  attempts: number;
  reason: RoutineDeferralReason;
  since: string;
};

export type RoutineStatus = {
  allowOverlap: boolean;
  catchUp: RoutineCatchUpPolicy;
  // Set while this Target's due clock event is parked waiting for capacity
  // (ADR 0093); null whenever nothing is waiting to be admitted.
  deferral: RoutineDeferralStatus | null;
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
} & RoutineExecutionOverrides;
