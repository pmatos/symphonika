import { describe, expect, it } from "vitest";

import {
  compareCandidateIssues,
  normalizeLabels,
  normalizeProjectWeight,
  priorityForLabels,
  type LabelPriorityConfig
} from "../src/issue-priority.js";

describe("normalizeLabels", () => {
  it("keeps string labels verbatim", () => {
    expect(normalizeLabels(["agent-ready", "bug"])).toEqual([
      "agent-ready",
      "bug"
    ]);
  });

  it("extracts the name from GitHub label objects", () => {
    expect(
      normalizeLabels([{ name: "agent-ready" }, { name: "needs-triage" }])
    ).toEqual(["agent-ready", "needs-triage"]);
  });

  it("mixes string and object labels in order", () => {
    expect(normalizeLabels(["a", { name: "b" }, "c"])).toEqual(["a", "b", "c"]);
  });

  it("drops objects without a string name", () => {
    expect(
      normalizeLabels([{ name: 123 }, { color: "red" }, { name: null }])
    ).toEqual([]);
  });

  it("drops non-string, non-object entries", () => {
    expect(normalizeLabels([null, undefined, 42, true])).toEqual([]);
  });

  it("ignores arrays even when they carry a name property", () => {
    const arrayWithName = Object.assign(["x"], { name: "sneaky" });
    expect(normalizeLabels([arrayWithName])).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(normalizeLabels([])).toEqual([]);
  });
});

describe("priorityForLabels", () => {
  const config: LabelPriorityConfig = {
    labels: { urgent: 0, high: 1, low: 5 },
    default: 3
  };

  it("returns the default when no label maps to a priority", () => {
    expect(priorityForLabels(["misc"], config)).toBe(3);
    expect(priorityForLabels([], config)).toBe(3);
  });

  it("returns the mapped priority for a single matching label", () => {
    expect(priorityForLabels(["low"], config)).toBe(5);
  });

  it("returns the minimum (most urgent) priority across matches", () => {
    expect(priorityForLabels(["low", "urgent", "high"], config)).toBe(0);
  });

  it("ignores unmapped labels when at least one maps", () => {
    expect(priorityForLabels(["misc", "high", "other"], config)).toBe(1);
  });
});

describe("compareCandidateIssues", () => {
  const candidate = (priority: number, created_at: string, number: number) => ({
    issue: { priority, created_at, number }
  });

  it("orders by ascending priority first", () => {
    expect(
      compareCandidateIssues(
        candidate(1, "2026-01-02", 10),
        candidate(0, "2026-01-01", 20)
      )
    ).toBeGreaterThan(0);
  });

  it("breaks priority ties by earlier created_at", () => {
    expect(
      compareCandidateIssues(
        candidate(1, "2026-01-01", 30),
        candidate(1, "2026-01-02", 5)
      )
    ).toBeLessThan(0);
  });

  it("breaks created_at ties by ascending issue number", () => {
    expect(
      compareCandidateIssues(
        candidate(1, "2026-01-01", 30),
        candidate(1, "2026-01-01", 5)
      )
    ).toBeGreaterThan(0);
  });

  it("returns 0 for fully equal candidates", () => {
    expect(
      compareCandidateIssues(
        candidate(2, "2026-01-01", 7),
        candidate(2, "2026-01-01", 7)
      )
    ).toBe(0);
  });

  it("sorts a bucket into priority/created_at/number order", () => {
    const bucket = [
      candidate(2, "2026-01-05", 3),
      candidate(1, "2026-01-02", 9),
      candidate(1, "2026-01-02", 4),
      candidate(0, "2026-01-09", 1)
    ];
    const ordered = bucket
      .slice()
      .sort(compareCandidateIssues)
      .map((entry) => entry.issue.number);
    expect(ordered).toEqual([1, 4, 9, 3]);
  });
});

describe("normalizeProjectWeight", () => {
  it("defaults undefined to 1", () => {
    expect(normalizeProjectWeight(undefined)).toBe(1);
  });

  it("defaults non-positive weights to 1", () => {
    expect(normalizeProjectWeight(0)).toBe(1);
    expect(normalizeProjectWeight(-4)).toBe(1);
  });

  it("defaults non-integer weights to 1", () => {
    expect(normalizeProjectWeight(2.5)).toBe(1);
    expect(normalizeProjectWeight(Number.NaN)).toBe(1);
  });

  it("passes through valid positive integers", () => {
    expect(normalizeProjectWeight(1)).toBe(1);
    expect(normalizeProjectWeight(7)).toBe(7);
  });
});
