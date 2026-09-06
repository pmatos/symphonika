// Concurrency-cap admission policy for dispatch. This is the single home for
// the daemon-wide and per-project max_in_flight checks that gate whether a run
// may start: the ">=" comparisons, the canonical reason strings surfaced to the
// run store / routine skip records / CapBreachedError, and the default that
// applies when a project omits max_in_flight (ADR 0053, superseded by
// ADR-2026-09-06-1010). Keeping the policy here means the dispatcher and
// run-controller share one source of truth instead of re-deriving it at each
// call site.

/**
 * Resolve a project's effective concurrency cap. An explicit per-project
 * `max_in_flight` always wins; an omitted one falls back to the resolved
 * global cap; if both are omitted the project is unbounded (`undefined`).
 * See ADR-2026-09-06-1010.
 */
export function resolveProjectMaxInFlight(
  configured: number | undefined,
  globalMax: number | undefined
): number | undefined {
  return configured ?? globalMax;
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

/** Whether a project's cap is reached, applying the global-default fallback when omitted. */
export function isProjectCapReached(
  configuredProjectMax: number | undefined,
  projectInFlight: number,
  globalMax: number | undefined
): boolean {
  const resolved = resolveProjectMaxInFlight(configuredProjectMax, globalMax);
  return resolved !== undefined && projectInFlight >= resolved;
}

export type ConcurrencyCapacityInput = {
  /** Configured per-project cap, or undefined to fall back to the global cap. */
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
  const resolvedProjectMax = resolveProjectMaxInFlight(
    input.configuredProjectMax,
    input.globalMax
  );
  if (
    resolvedProjectMax !== undefined &&
    input.projectInFlight >= resolvedProjectMax
  ) {
    return {
      admitted: false,
      reason: `project ${input.projectName} max_in_flight (${resolvedProjectMax}) reached`,
      scope: "project"
    };
  }
  return { admitted: true };
}
