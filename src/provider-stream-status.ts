import {
  PROVIDER_STREAM_STALL_THRESHOLD_MS,
  type AttemptStatus,
  type ProviderStreamReceipt,
  type ProviderStreamStallRecord,
  type RunState
} from "./run-store.js";

export type ProviderStreamStatus = {
  lastEventAgeMs: number | null;
  lastEventAt: string | null;
  recoveredStalls: ProviderStreamStallRecord[];
  stalled: boolean;
  stalledForMs: number | null;
  thresholdMs: number;
};

export function buildProviderStreamStatus(input: {
  attempt: AttemptStatus | undefined;
  nowMs: number;
  receipt: ProviderStreamReceipt | undefined;
  recoveredStalls: ProviderStreamStallRecord[];
  runState: RunState;
}): ProviderStreamStatus {
  const lastEventAt = input.receipt?.lastEventAt ?? null;
  const lastEventAtMs =
    lastEventAt === null ? Number.NaN : Date.parse(lastEventAt);
  const lastEventAgeMs = Number.isNaN(lastEventAtMs)
    ? null
    : Math.max(0, input.nowMs - lastEventAtMs);
  // Before the first receipt the Attempt's own start is the gap origin, so a
  // Run that has produced nothing at all still reads as stalled rather than
  // merely blank. It is deliberately not durable stall evidence — see ADR 0090.
  const quietSince = lastEventAt ?? input.attempt?.createdAt;
  const quietSinceMs =
    quietSince === undefined ? Number.NaN : Date.parse(quietSince);
  const quietForMs = Number.isNaN(quietSinceMs)
    ? null
    : Math.max(0, input.nowMs - quietSinceMs);
  const stalled =
    input.runState === "running" &&
    quietForMs !== null &&
    quietForMs >= PROVIDER_STREAM_STALL_THRESHOLD_MS;

  return {
    lastEventAgeMs,
    lastEventAt,
    recoveredStalls: input.recoveredStalls,
    stalled,
    stalledForMs: stalled ? quietForMs : null,
    thresholdMs: PROVIDER_STREAM_STALL_THRESHOLD_MS
  };
}
