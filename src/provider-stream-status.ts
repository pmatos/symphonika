import {
  PROVIDER_STREAM_STALL_THRESHOLD_MS,
  TERMINAL_RUN_STATES,
  type AttemptStatus,
  type ProviderStreamStallRecord,
  type RunState,
  type RunStore
} from "./run-store.js";

export type ProviderStreamStatus = {
  lastEventAgeMs: number | null;
  lastEventAt: string | null;
  recoveredStalls: ProviderStreamStallRecord[];
  stalled: boolean;
  stalledForMs: number | null;
  thresholdMs: number;
};

// A terminal Run's provider ages must stop drifting, but freezing them on the
// Watchdog's clock reads the stream backwards: the final process_exit normally
// arrives after the last Watchdog sample, so that sample would describe the
// Run's own last event as arriving "in 5m". The terminal transition is the
// latest instant the stream could still have produced anything, and the last
// receipt is a hard floor under any freeze point. See ADR 0090.
function resolveProviderStreamNowMs(input: {
  lastEventAt: string | null;
  liveNowMs: number;
  runId: string;
  runState: RunState;
  runStore: RunStore;
}): number {
  if (!TERMINAL_RUN_STATES.has(input.runState)) {
    return input.liveNowMs;
  }
  const stoppedAt = input.runStore.latestRunStateTransitionAt(input.runId);
  const stoppedAtMs = stoppedAt === undefined ? NaN : Date.parse(stoppedAt);
  const frozenMs = Number.isNaN(stoppedAtMs) ? input.liveNowMs : stoppedAtMs;
  const lastEventAtMs =
    input.lastEventAt === null ? NaN : Date.parse(input.lastEventAt);
  return Number.isNaN(lastEventAtMs)
    ? frozenMs
    : Math.max(frozenMs, lastEventAtMs);
}

// Reads its own evidence rows the way buildWatchdogStatus does, so every
// surface that renders the section passes a live clock and an Attempt rather
// than re-deriving which store tables back it.
export function buildProviderStreamStatus(input: {
  attempt: AttemptStatus | undefined;
  liveNowMs: number;
  runId: string;
  runState: RunState;
  runStore: RunStore;
}): ProviderStreamStatus {
  const receipt =
    input.attempt === undefined
      ? undefined
      : input.runStore.getProviderStreamReceipt(input.attempt.id);
  const lastEventAt = receipt?.lastEventAt ?? null;
  const nowMs = resolveProviderStreamNowMs({
    lastEventAt,
    liveNowMs: input.liveNowMs,
    runId: input.runId,
    runState: input.runState,
    runStore: input.runStore
  });
  const ageMs = (at: string | null | undefined): number | null => {
    if (at === null || at === undefined) {
      return null;
    }
    const atMs = Date.parse(at);
    return Number.isNaN(atMs) ? null : Math.max(0, nowMs - atMs);
  };

  const lastEventAgeMs = ageMs(lastEventAt);
  // Before the first receipt the Attempt's own start is the gap origin, so a
  // Run that has produced nothing at all still reads as stalled rather than
  // merely blank. It is deliberately not durable stall evidence — see ADR 0090.
  const quietForMs =
    lastEventAt === null ? ageMs(input.attempt?.createdAt) : lastEventAgeMs;
  const stalled =
    input.runState === "running" &&
    quietForMs !== null &&
    quietForMs >= PROVIDER_STREAM_STALL_THRESHOLD_MS;

  return {
    lastEventAgeMs,
    lastEventAt,
    recoveredStalls: input.runStore.listProviderStreamStalls(input.runId),
    stalled,
    stalledForMs: stalled ? quietForMs : null,
    thresholdMs: PROVIDER_STREAM_STALL_THRESHOLD_MS
  };
}
