import path from "node:path";
import { describe, expect, it } from "vitest";

import { projectPullRequestSignals } from "../src/workflow/pr-signal-projection.js";
import {
  artifactPredicatePaths,
  parseArtifactExistsPaths,
  resolveArtifactPath,
  workflowPredicateEvaluation,
  workflowPredicateEvaluations
} from "../src/workflow/predicates.js";

// The agent-result signal keys signalsFromTerminal emits. That function is
// private to run-controller, so this list is the contract the registry is
// checked against; changing one without the other is the exact drift that left
// artifact_exists allowlisted with nothing evaluating it (#583).
const agentResultSignalKeys = [
  "branch_advanced_since_attempt_start",
  "branch_ahead_of_base",
  "provider_success"
];

function everyPullRequestSignalKey(): Set<string> {
  const keys = new Set<string>();
  for (const checks of ["failure", "pending", "success", "unknown"] as const) {
    for (const mergeable of ["conflicting", "mergeable", "unknown"] as const) {
      for (const merged of [false, true]) {
        const signals = projectPullRequestSignals({
          checks,
          merged,
          mergeable,
          open: !merged,
          reviewDecision: "approved",
          unresolvedReviewThreads: 0
        });
        for (const key of Object.keys(signals)) {
          keys.add(key);
        }
      }
    }
  }
  return keys;
}

describe("workflow predicate registry", () => {
  it("gives every accepted predicate key a live evaluator", () => {
    const pullRequestKeys = everyPullRequestSignalKey();
    for (const [key, evaluation] of Object.entries(
      workflowPredicateEvaluations
    )) {
      if (evaluation === "agent_signal") {
        expect(agentResultSignalKeys, key).toContain(key);
        continue;
      }
      if (evaluation === "pr_signal") {
        expect([...pullRequestKeys], key).toContain(key);
        continue;
      }
      expect(evaluation, key).toBe("artifact");
    }
  });

  it("accepts no key beyond the ones the two signal projections emit plus artifact_exists", () => {
    const accounted = new Set([
      ...agentResultSignalKeys,
      ...everyPullRequestSignalKey(),
      "artifact_exists"
    ]);
    expect(
      Object.keys(workflowPredicateEvaluations).filter(
        (key) => !accounted.has(key)
      )
    ).toEqual([]);
  });

  it("no longer accepts the dead branch_pushed and timeout keys", () => {
    expect(workflowPredicateEvaluation("branch_pushed")).toBeUndefined();
    expect(workflowPredicateEvaluation("timeout")).toBeUndefined();
  });

  it("resolves known keys and rejects unknown and inherited ones", () => {
    expect(workflowPredicateEvaluation("artifact_exists")).toBe("artifact");
    expect(workflowPredicateEvaluation("provider_success")).toBe(
      "agent_signal"
    );
    expect(workflowPredicateEvaluation("checks")).toBe("pr_signal");
    expect(workflowPredicateEvaluation("nonsense")).toBeUndefined();
    expect(workflowPredicateEvaluation("toString")).toBeUndefined();
    expect(workflowPredicateEvaluation("constructor")).toBeUndefined();
  });
});

describe("parseArtifactExistsPaths", () => {
  it("accepts a single path and trims it", () => {
    expect(parseArtifactExistsPaths("  PLAN.md  ")).toEqual({
      paths: ["PLAN.md"]
    });
  });

  it("accepts a sequence of paths", () => {
    expect(parseArtifactExistsPaths(["PLAN.md", "docs/notes.md"])).toEqual({
      paths: ["PLAN.md", "docs/notes.md"]
    });
  });

  it("accepts nested and dot-prefixed relative paths", () => {
    expect(parseArtifactExistsPaths("./docs/plan/PLAN.md")).toEqual({
      paths: ["./docs/plan/PLAN.md"]
    });
    expect(parseArtifactExistsPaths("a/b/../c.md")).toEqual({
      paths: ["a/b/../c.md"]
    });
  });

  it("rejects an empty sequence", () => {
    expect(parseArtifactExistsPaths([])).toEqual({
      error: "must list at least one path"
    });
  });

  it("rejects non-string values", () => {
    expect(parseArtifactExistsPaths(true)).toEqual({
      error: "must be a path string or a sequence of path strings"
    });
    expect(parseArtifactExistsPaths(3)).toEqual({
      error: "must be a path string or a sequence of path strings"
    });
    expect(parseArtifactExistsPaths(["PLAN.md", 7])).toEqual({
      error: "must be a path string or a sequence of path strings"
    });
  });

  it("rejects an empty or whitespace-only path", () => {
    expect(parseArtifactExistsPaths("   ")).toEqual({
      error: "must not contain an empty path"
    });
    expect(parseArtifactExistsPaths(["PLAN.md", ""])).toEqual({
      error: "must not contain an empty path"
    });
  });

  it("rejects a null byte", () => {
    expect(parseArtifactExistsPaths("PLAN\0.md")).toEqual({
      error: "must not contain a null byte"
    });
  });

  it("rejects absolute paths", () => {
    expect(parseArtifactExistsPaths("/etc/passwd")).toEqual({
      error: "path /etc/passwd must be workspace-relative, not absolute"
    });
  });

  it("rejects paths escaping the workspace", () => {
    expect(parseArtifactExistsPaths("../PLAN.md")).toEqual({
      error: "path ../PLAN.md must stay inside the run workspace"
    });
    expect(parseArtifactExistsPaths("docs/../../PLAN.md")).toEqual({
      error: "path docs/../../PLAN.md must stay inside the run workspace"
    });
    expect(parseArtifactExistsPaths("..")).toEqual({
      error: "path .. must stay inside the run workspace"
    });
  });
});

describe("artifactPredicatePaths", () => {
  it("returns the paths a valid value names", () => {
    expect(artifactPredicatePaths("PLAN.md")).toEqual(["PLAN.md"]);
    expect(artifactPredicatePaths(["PLAN.md", "TODO.md"])).toEqual([
      "PLAN.md",
      "TODO.md"
    ]);
  });

  it("returns undefined for a value validation would have rejected", () => {
    expect(artifactPredicatePaths(true)).toBeUndefined();
    expect(artifactPredicatePaths("/etc/passwd")).toBeUndefined();
    expect(artifactPredicatePaths("../escape")).toBeUndefined();
  });
});

describe("resolveArtifactPath", () => {
  it("resolves a relative path against the workspace", () => {
    expect(resolveArtifactPath("/tmp/ws", "docs/PLAN.md")).toBe(
      path.join("/tmp/ws", "docs", "PLAN.md")
    );
  });

  it("refuses a path that escapes the workspace at evaluation time", () => {
    expect(resolveArtifactPath("/tmp/ws", "../PLAN.md")).toBeUndefined();
    expect(resolveArtifactPath("/tmp/ws", "/etc/passwd")).toBeUndefined();
  });
});
