// Shared label-to-priority domain logic for the issue-dispatch pipeline.
//
// Raw GitHub labels become a normalized string list, that list resolves to a
// numeric priority via the project's priority config, and candidate issues sort
// by that priority (then age, then number). Both the polling path
// (issue-polling.ts) and the dispatch path (lifecycle/run-controller.ts) need
// this identical ordering; keeping one implementation prevents the two paths
// from silently disagreeing about which issue is "next".

// The subset of a project's priority config these helpers read: a per-label
// priority map plus a fallback for labels the map does not mention. Lower is
// more urgent.
export type LabelPriorityConfig = {
  labels: Record<string, number>;
  default: number;
};

// Normalize a raw GitHub label array (strings or `{ name }` objects) into a
// plain string list. Entries that are neither a string nor a plain object with
// a string `name` are dropped. Arrays are never treated as label objects.
export function normalizeLabels(labels: unknown[]): string[] {
  const normalized: string[] = [];

  for (const label of labels) {
    if (typeof label === "string") {
      normalized.push(label);
      continue;
    }

    if (
      typeof label === "object" &&
      label !== null &&
      !Array.isArray(label) &&
      "name" in label &&
      typeof (label as { name?: unknown }).name === "string"
    ) {
      normalized.push((label as { name: string }).name);
    }
  }

  return normalized;
}

// Resolve the priority of an issue from its labels: the minimum (most urgent)
// mapped priority, or the config default when no label is mapped.
export function priorityForLabels(
  labels: string[],
  config: LabelPriorityConfig
): number {
  const priorities = labels.flatMap((label) => {
    const priority = config.labels[label];
    return priority === undefined ? [] : [priority];
  });

  return priorities.length === 0 ? config.default : Math.min(...priorities);
}

// Deterministic dispatch order for candidate issues: ascending priority, then
// earliest created_at, then lowest issue number as a final tie-break. Typed
// structurally so callers can pass their own richer candidate records.
export function compareCandidateIssues(
  left: { issue: { priority: number; created_at: string; number: number } },
  right: { issue: { priority: number; created_at: string; number: number } }
): number {
  return (
    left.issue.priority - right.issue.priority ||
    left.issue.created_at.localeCompare(right.issue.created_at) ||
    left.issue.number - right.issue.number
  );
}

// Coerce a configured project weight to a positive integer, defaulting to 1 for
// missing, non-integer, or non-positive values.
export function normalizeProjectWeight(weight: number | undefined): number {
  if (weight === undefined || !Number.isInteger(weight) || weight <= 0) {
    return 1;
  }
  return weight;
}
