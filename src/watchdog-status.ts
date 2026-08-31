import type { WatchdogConfig } from "./reload.js";
import type { RunState, RunStore } from "./run-store.js";

export type WatchdogStatus =
  | { enabled: false }
  | {
      enabled: true;
      graceMs: number;
      graceRemainingMs?: number;
      idleSince?: string;
      lastProgressAt?: string | null;
      lastToolCallAt?: string | null;
      // Zero when no wall-clock cap is configured (ADR 0089). `runRemainingMs`
      // accompanies a configured cap whenever the caller supplied the Run's
      // claim timestamp, and goes negative once the cap is overrun but the
      // next Watchdog tick has not landed yet.
      maxRunMs: number;
      // Zero when no convergence budget is configured (ADR 0086).
      outputTokenBudget: number;
      outputTokensTotal?: number;
      runRemainingMs?: number;
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
  config: Pick<
    WatchdogConfig,
    "enabled" | "graceMinutes" | "maxRunMinutes" | "outputTokenBudget"
  >;
  nowMs: number;
  runId: string;
  // The Run's claim timestamp, which the wall-clock countdown is measured
  // from. Optional because buildWatchdogIdleStatus projects only the idle
  // fields and has no run row to read it from; every caller that renders the
  // full status has the Run detail in hand and should pass it.
  runCreatedAt?: string;
  runStore: RunStore;
}): WatchdogStatus {
  if (!input.config.enabled) {
    return { enabled: false };
  }

  const graceMs = input.config.graceMinutes * 60_000;
  const maxRunMs = input.config.maxRunMinutes * 60_000;
  const outputTokenBudget = input.config.outputTokenBudget;
  const runRemaining =
    maxRunMs > 0 && input.runCreatedAt !== undefined
      ? runRemainingMs(input.runCreatedAt, maxRunMs, input.nowMs)
      : undefined;
  const deadline =
    runRemaining === undefined ? {} : { runRemainingMs: runRemaining };
  const sample = input.runStore.getWatchdogSample(input.runId);
  if (sample === undefined) {
    return { enabled: true, graceMs, maxRunMs, outputTokenBudget, ...deadline };
  }

  return {
    enabled: true,
    graceMs,
    maxRunMs,
    outputTokenBudget,
    ...deadline,
    ...(sample.idleSince === null
      ? {}
      : {
          graceRemainingMs:
            Date.parse(sample.idleSince) + graceMs - input.nowMs,
          idleSince: sample.idleSince
        }),
    lastProgressAt: sample.lastProgressAt,
    lastToolCallAt: sample.lastToolCallAt,
    outputTokensTotal: sample.outputTokensTotal,
    sampledAt: sample.sampledAt,
    turnIdSetSize: sample.turnIdSetSize,
    workspaceMtimeMax: timestampFromEpochMs(sample.workspaceMtimeMax)
  };
}

// Milliseconds left before the wall-clock cap terminates the Run, against the
// same effective clock the rest of the Progress Signal uses. An unparseable
// claim timestamp yields no countdown rather than a nonsensical one, matching
// the Watchdog's own refusal to age a Run it cannot date.
function runRemainingMs(
  runCreatedAt: string,
  maxRunMs: number,
  nowMs: number
): number | undefined {
  const claimedAtMs = Date.parse(runCreatedAt);
  return Number.isNaN(claimedAtMs) ? undefined : claimedAtMs + maxRunMs - nowMs;
}

export function buildWatchdogIdleStatus(input: {
  config: Pick<
    WatchdogConfig,
    "enabled" | "graceMinutes" | "maxRunMinutes" | "outputTokenBudget"
  >;
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
// listWatchdogCandidateRuns). Terminal and waiting Runs can carry their last
// running sample; attempt start clears it before entering preparing_workspace,
// while a queued first attempt has none. A live clock against a preserved
// non-running sample would render a misleading, ever-drifting countdown for
// data that no longer describes what the Run is currently doing.
// `runs.updated_at` is not a safe stand-in
// for "stopped being sampled" either: it can keep advancing for unrelated
// reasons (e.g. PR-discovery polling bumps it for succeeded Runs). All
// Progress Signal consumers (CLI show-run, the HTTP API, and the web UI)
// must derive the same effective clock from the same source so they render
// the same values for the same Run — see the discussion on PR #344.
export function resolveWatchdogNowMs(input: {
  liveNowMs: number;
  runId: string;
  runState: RunState;
  runStore: RunStore;
}): number {
  if (input.runState === "running") {
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
