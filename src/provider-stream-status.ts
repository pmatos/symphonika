import type {
  AttemptStatus,
  ProviderStreamEventRecord,
  ProviderStreamStallRecord,
  RunState
} from "./run-store.js";

export const PROVIDER_STREAM_STALL_THRESHOLD_MS = 5 * 60_000;

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
  latestEvent: ProviderStreamEventRecord | undefined;
  nowMs: number;
  recoveredStalls?: ProviderStreamStallRecord[];
  runState: RunState;
}): ProviderStreamStatus {
  const lastEventAt = input.latestEvent?.createdAt ?? null;
  const lastEventAtMs =
    lastEventAt === null ? Number.NaN : Date.parse(lastEventAt);
  const lastEventAgeMs = Number.isNaN(lastEventAtMs)
    ? null
    : Math.max(0, input.nowMs - lastEventAtMs);
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
    recoveredStalls: input.recoveredStalls ?? [],
    stalled,
    stalledForMs: stalled ? quietForMs : null,
    thresholdMs: PROVIDER_STREAM_STALL_THRESHOLD_MS
  };
}
