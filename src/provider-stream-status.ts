import {
  PROVIDER_STREAM_STALL_THRESHOLD_MS,
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

// Reads its own evidence rows the way buildWatchdogStatus does, so every
// surface that renders the section passes a clock and an Attempt rather than
// re-deriving which store tables back it.
export function buildProviderStreamStatus(input: {
  attempt: AttemptStatus | undefined;
  nowMs: number;
  runId: string;
  runState: RunState;
  runStore: RunStore;
}): ProviderStreamStatus {
  const ageMs = (at: string | null | undefined): number | null => {
    if (at === null || at === undefined) {
      return null;
    }
    const atMs = Date.parse(at);
    return Number.isNaN(atMs) ? null : Math.max(0, input.nowMs - atMs);
  };

  const receipt =
    input.attempt === undefined
      ? undefined
      : input.runStore.getProviderStreamReceipt(input.attempt.id);
  const lastEventAt = receipt?.lastEventAt ?? null;
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
