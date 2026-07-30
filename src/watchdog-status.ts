import type { WatchdogConfig } from "./reload.js";
import type { RunState, RunStore } from "./run-store.js";

export type WatchdogStatus =
  | { enabled: false }
  | {
      enabled: true;
      graceMs: number;
      graceRemainingMs?: number;
      idleSince?: string;
      lastToolCallAt?: string | null;
      outputTokensTotal?: number;
      sampledAt?: string;
      turnIdSetSize?: number;
      workspaceMtimeMax?: string | null;
    };

export type WatchdogIdleStatus =
  | { enabled: false }
  | {
      enabled: true;
      graceRemainingMs?: number;
      idleSince?: string;
    };

export function buildWatchdogStatus(input: {
  config: Pick<WatchdogConfig, "enabled" | "graceMinutes">;
  nowMs: number;
  runId: string;
  runStore: RunStore;
}): WatchdogStatus {
  if (!input.config.enabled) {
    return { enabled: false };
  }

  const graceMs = input.config.graceMinutes * 60_000;
  const sample = input.runStore.getWatchdogSample(input.runId);
  if (sample === undefined) {
    return { enabled: true, graceMs };
  }

  return {
    enabled: true,
    graceMs,
    ...(sample.idleSince === null
      ? {}
      : {
          graceRemainingMs:
            Date.parse(sample.idleSince) + graceMs - input.nowMs,
          idleSince: sample.idleSince
        }),
    lastToolCallAt: sample.lastToolCallAt,
    outputTokensTotal: sample.outputTokensTotal,
    sampledAt: sample.sampledAt,
    turnIdSetSize: sample.turnIdSetSize,
    workspaceMtimeMax: timestampFromEpochMs(sample.workspaceMtimeMax)
  };
}

export function buildWatchdogIdleStatus(input: {
  config: Pick<WatchdogConfig, "enabled" | "graceMinutes">;
  nowMs: number;
  runId: string;
  runStore: RunStore;
}): WatchdogIdleStatus {
  const status = buildWatchdogStatus(input);
  if (!status.enabled) {
    return status;
  }
  if (status.idleSince === undefined || status.graceRemainingMs === undefined) {
    return { enabled: true };
  }
  return {
    enabled: true,
    graceRemainingMs: status.graceRemainingMs,
    idleSince: status.idleSince
  };
}

// Sampling only ever runs against `state = 'running'` Runs (see
// listWatchdogCandidateRuns), so a terminal Run's last persisted sample is
// permanently frozen the moment it stops being sampled. `runs.updated_at` is
// not: it can keep advancing after termination for unrelated reasons (e.g.
// PR-discovery polling bumps it for succeeded Runs), so it is not a safe
// "as of termination" reference clock. All Progress Signal consumers (CLI
// show-run, the HTTP API, and the web UI) must derive the same effective
// clock from the same source so they render the same values for the same
// Run — see the discussion on PR #344.
const WATCHDOG_TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "cancelled",
  "failed",
  "blocked",
  "input_required",
  "stale",
  "succeeded"
]);

export function resolveWatchdogNowMs(input: {
  liveNowMs: number;
  runId: string;
  runState: RunState;
  runStore: RunStore;
}): number {
  if (!WATCHDOG_TERMINAL_RUN_STATES.has(input.runState)) {
    return input.liveNowMs;
  }
  const sample = input.runStore.getWatchdogSample(input.runId);
  return sample === undefined ? input.liveNowMs : Date.parse(sample.sampledAt);
}

export function formatWatchdogDuration(durationMs: number): string {
  const sign = durationMs < 0 ? "-" : "";
  const totalSeconds = Math.floor(Math.abs(durationMs) / 1_000);
  const units: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1]
  ];
  let remaining = totalSeconds;
  const parts: string[] = [];
  for (const [label, seconds] of units) {
    const value = Math.floor(remaining / seconds);
    if (value > 0) {
      parts.push(`${value}${label}`);
      remaining %= seconds;
    }
    if (parts.length === 2) {
      break;
    }
  }
  return `${sign}${parts.length === 0 ? "0s" : parts.join(" ")}`;
}

export function formatAge(
  timestamp: string | null | undefined,
  nowMs: number
): string {
  if (timestamp === null || timestamp === undefined) {
    return "never";
  }
  const ageMs = nowMs - Date.parse(timestamp);
  return ageMs < 0
    ? `in ${formatWatchdogDuration(-ageMs)}`
    : `${formatWatchdogDuration(ageMs)} ago`;
}

function timestampFromEpochMs(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value).toISOString();
}
