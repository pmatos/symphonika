// Host-pressure admission policy for dispatch. Concurrency caps (ADR 0053)
// count runs; they say nothing about whether the machine those runs land on
// can still make progress. A host whose memory is exhausted stalls every task
// in uninterruptible sleep, so an agent keeps emitting tokens — and the
// Watchdog keeps seeing progress — while taking hours to do seconds of work.
//
// Linux's pressure-stall information (PSI) measures exactly that: the `full`
// line of /proc/pressure/<resource> is the share of a window during which
// EVERY non-idle task was stalled on that resource. Unlike load average it
// does not conflate "busy" with "stuck", and unlike core count it reflects
// the host as it actually is right now. This module reads it, caches a
// sample, and turns it into an admission verdict. See ADR 0088.

import { readFile } from "node:fs/promises";

/** Directory holding the kernel's pressure-stall counters. */
const DEFAULT_PRESSURE_DIRECTORY = "/proc/pressure";

/** Resources this gate can defer on. CPU is deliberately absent: a saturated
 * CPU still makes progress, which is what `max_in_flight` already bounds. */
export type HostPressureResource = "memory" | "io";

const HOST_PRESSURE_RESOURCES: readonly HostPressureResource[] = [
  "memory",
  "io"
];

/**
 * Per-resource ceilings on the PSI `full avg60` percentage. `undefined` leaves
 * that resource ungated.
 */
export type HostPressureThresholds = {
  io: number | undefined;
  memory: number | undefined;
};

export type HostPressurePolicy = {
  enabled: boolean;
  /** How long a sample stays fresh before `refresh()` re-reads /proc. */
  sampleIntervalMs: number;
  thresholds: HostPressureThresholds;
};

/**
 * Memory ceiling applied when `global.pressure` is omitted entirely. A healthy
 * host reads ~0; the incident in #599 measured 23.53. 10 sits far above the
 * former and well below the latter.
 */
export const DEFAULT_MEMORY_FULL_AVG60_MAX = 10;

/**
 * Default sampling interval. One /proc read per interval is cheap enough to
 * run on every daemon tick without being so stale that a spike is missed.
 */
const DEFAULT_PRESSURE_SAMPLE_INTERVAL_MS = 10_000;

// I/O is deliberately ungated by default. A workstation doing ordinary
// compilation sustains an io `full avg60` in the 50s with no thrashing at
// all, so any default low enough to catch a genuine stall would refuse
// dispatch on a perfectly healthy build host. Operators who want it opt in
// with `io_full_avg60_max`.
export const DEFAULT_HOST_PRESSURE_POLICY: HostPressurePolicy = {
  enabled: true,
  sampleIntervalMs: DEFAULT_PRESSURE_SAMPLE_INTERVAL_MS,
  thresholds: {
    io: undefined,
    memory: DEFAULT_MEMORY_FULL_AVG60_MAX
  }
};

/** One reading of the host's pressure counters. */
export type HostPressureSample = {
  /** `full avg60` per resource; absent when the counter could not be read. */
  fullAvg60: Partial<Record<HostPressureResource, number>>;
  /** Resources whose counter could not be read, with the reason. */
  unavailable: Partial<Record<HostPressureResource, string>>;
};

export type HostPressureVerdict =
  | { admitted: true }
  | {
      admitted: false;
      observed: number;
      reason: string;
      resource: HostPressureResource;
      threshold: number;
    };

/**
 * Parse one /proc/pressure/<resource> file and return the `full` window's
 * avg60 percentage. Returns undefined when the file has no `full` line —
 * kernels before 5.13 omit it for cpu, and a malformed file must never be
 * read as "no pressure" by accident.
 */
export function parseFullAvg60(contents: string): number | undefined {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("full ")) {
      continue;
    }
    for (const field of trimmed.slice("full ".length).split(/\s+/)) {
      const [key, rawValue] = field.split("=");
      if (key !== "avg60" || rawValue === undefined) {
        continue;
      }
      const value = Number(rawValue);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    }
  }
  return undefined;
}

export type ReadHostPressureOptions = {
  pressureDirectory?: string;
  readPressureFile?: (resource: HostPressureResource) => Promise<string>;
};

/** Read every gated resource's counter. Never throws. */
export async function readHostPressure(
  options: ReadHostPressureOptions = {}
): Promise<HostPressureSample> {
  const directory = options.pressureDirectory ?? DEFAULT_PRESSURE_DIRECTORY;
  const readPressureFile =
    options.readPressureFile ??
    ((resource: HostPressureResource) =>
      readFile(`${directory}/${resource}`, "utf8"));

  const sample: HostPressureSample = { fullAvg60: {}, unavailable: {} };
  await Promise.all(
    HOST_PRESSURE_RESOURCES.map(async (resource) => {
      let contents: string;
      try {
        contents = await readPressureFile(resource);
      } catch (error) {
        sample.unavailable[resource] = errorMessage(error);
        return;
      }
      const value = parseFullAvg60(contents);
      if (value === undefined) {
        sample.unavailable[resource] = "no parsable `full avg60` line";
        return;
      }
      sample.fullAvg60[resource] = value;
    })
  );
  return sample;
}

/**
 * Turn a sample into an admission verdict. Memory is checked before I/O, so a
 * host breaching both reports the memory scope — the one that actually
 * explains a stall. A resource whose counter is unavailable is treated as
 * admitting: PSI is absent on non-Linux hosts and on kernels built without
 * CONFIG_PSI, where this gate must be inert rather than deadlocking dispatch.
 */
export function evaluateHostPressure(
  sample: HostPressureSample,
  thresholds: HostPressureThresholds
): HostPressureVerdict {
  for (const resource of HOST_PRESSURE_RESOURCES) {
    const threshold = thresholds[resource];
    const observed = sample.fullAvg60[resource];
    if (threshold === undefined || observed === undefined) {
      continue;
    }
    if (observed >= threshold) {
      return {
        admitted: false,
        observed,
        reason: `host ${resource} pressure (full avg60 ${observed.toFixed(2)}% >= ${threshold}%) — deferring dispatch`,
        resource,
        threshold
      };
    }
  }
  return { admitted: true };
}

export type HostPressureGate = {
  /**
   * The verdict from the last completed refresh. Synchronous on purpose: the
   * manual Routine-fire path (`fireRoutineNow`) makes its admission decision
   * without an await, and every caller benefits from one /proc read per
   * sampling interval rather than one per candidate.
   */
  current: () => HostPressureVerdict;
  /** The last completed sample, or undefined before the first refresh. */
  lastSample: () => HostPressureSample | undefined;
  /** Re-read the counters if the cached sample has aged past the interval. */
  refresh: () => Promise<HostPressureVerdict>;
};

export type CreateHostPressureGateOptions = {
  now?: () => number;
  policy?: () => HostPressurePolicy;
  readPressure?: () => Promise<HostPressureSample>;
};

/**
 * A TTL-cached gate over the host's pressure counters. The policy is read
 * through a callback rather than captured, so a config reload takes effect on
 * the next evaluation without the daemon rebuilding the gate.
 */
export function createHostPressureGate(
  options: CreateHostPressureGateOptions = {}
): HostPressureGate {
  const now = options.now ?? (() => Date.now());
  const readPolicy = options.policy ?? (() => DEFAULT_HOST_PRESSURE_POLICY);
  const readPressure = options.readPressure ?? (() => readHostPressure());

  let sample: HostPressureSample | undefined;
  let sampledAtMs: number | undefined;
  // Collapses concurrent refreshes — the daemon tick, a fresh dispatch and a
  // retry re-admission can all land inside one interval — onto a single read.
  let inFlight: Promise<HostPressureSample> | undefined;

  const verdict = (): HostPressureVerdict => {
    const policy = readPolicy();
    if (!policy.enabled || sample === undefined) {
      return { admitted: true };
    }
    return evaluateHostPressure(sample, policy.thresholds);
  };

  return {
    current: verdict,
    lastSample: () => sample,
    refresh: async () => {
      const policy = readPolicy();
      if (!policy.enabled) {
        return { admitted: true };
      }
      const isFresh =
        sampledAtMs !== undefined &&
        now() - sampledAtMs < policy.sampleIntervalMs;
      if (!isFresh) {
        inFlight ??= readPressure();
        const pending = inFlight;
        try {
          const read = await pending;
          // Only the read that owns the in-flight promise publishes it, so a
          // slower caller cannot overwrite a newer sample with a stale one.
          if (inFlight === pending) {
            sample = read;
            sampledAtMs = now();
          }
        } finally {
          if (inFlight === pending) {
            inFlight = undefined;
          }
        }
      }
      return verdict();
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
