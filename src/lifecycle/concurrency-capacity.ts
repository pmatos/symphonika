// Concurrency-cap admission policy for dispatch. This is the single home for
// the daemon-wide and per-project max_in_flight checks that gate whether a run
// may start: the ">=" comparisons, the canonical reason strings surfaced to the
// run store / routine skip records / CapBreachedError, and the serial default
// that applies when a project omits max_in_flight (ADR 0053). Keeping the
// policy here means the dispatcher and run-controller share one source of truth
// instead of re-deriving it at each call site.

/**
 * Per-project concurrency cap applied when a project omits `max_in_flight`.
 * A cap of 1 preserves the legacy serial dispatch behavior. See ADR 0053.
 */
export const DEFAULT_PROJECT_MAX_IN_FLIGHT = 1;

/** Resolve a project's effective concurrency cap, applying the serial default. */
export function resolveProjectMaxInFlight(
  configured: number | undefined
): number {
  return configured ?? DEFAULT_PROJECT_MAX_IN_FLIGHT;
}

/**
 * Whether the daemon-wide cap is reached. An undefined global cap means the
 * daemon imposes no global limit.
 */
export function isGlobalCapReached(
  globalMax: number | undefined,
  globalInFlight: number
): boolean {
  return globalMax !== undefined && globalInFlight >= globalMax;
}

/** Whether a project's cap is reached, applying the serial default when omitted. */
export function isProjectCapReached(
  configuredProjectMax: number | undefined,
  projectInFlight: number
): boolean {
  return projectInFlight >= resolveProjectMaxInFlight(configuredProjectMax);
}

export type ConcurrencyCapacityInput = {
  /** Configured per-project cap, or undefined to apply the serial default. */
  configuredProjectMax: number | undefined;
  /** Runs currently in flight across all projects. */
  globalInFlight: number;
  /** Daemon-wide cap, or undefined for no global limit. */
  globalMax: number | undefined;
  /** Runs currently in flight for this project. */
  projectInFlight: number;
  /** Project name, used to build the project-scope reason string. */
  projectName: string;
};

export type ConcurrencyCapacityVerdict =
  | { admitted: true }
  | { admitted: false; reason: string; scope: "global" | "project" };

/**
 * Decide whether a run may be admitted under the concurrency caps. The global
 * cap is checked before the project cap, so a simultaneous breach of both
 * reports the global scope.
 */
export function evaluateConcurrencyCapacity(
  input: ConcurrencyCapacityInput
): ConcurrencyCapacityVerdict {
  if (isGlobalCapReached(input.globalMax, input.globalInFlight)) {
    return {
      admitted: false,
      reason: `global max_in_flight (${input.globalMax}) reached`,
      scope: "global"
    };
  }
  if (isProjectCapReached(input.configuredProjectMax, input.projectInFlight)) {
    return {
      admitted: false,
      reason: `project ${input.projectName} max_in_flight (${resolveProjectMaxInFlight(input.configuredProjectMax)}) reached`,
      scope: "project"
    };
  }
  return { admitted: true };
}
