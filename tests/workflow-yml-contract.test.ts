import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { findWorkflowState } from "../src/lifecycle/state-machine-dispatch.js";
import {
  loadExpandedWorkflow,
  validateExpandedWorkflowReferences
} from "../src/workflow/fsm-expansion.js";

// This repo dogfoods its own raw-FSM shape (workflow.yml,
// symphonika_self_driving) -- the same "implement -> code_review_fix"
// shape issue #730 describes for vow/s11/modgud/health-connectors/
// pianosight/finnie. Nothing loaded this file through the production
// parser before, so a regression here (a bad edit, a broken prompt
// reference) had no regression guard.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const workflowPath = path.join(repoRoot, "workflow.yml");

describe("this repo's own workflow.yml (symphonika_self_driving)", () => {
  it("parses and expands without validation errors", async () => {
    const { errors, workflow } = await loadExpandedWorkflow(workflowPath);
    expect(errors).toEqual([]);
    expect(workflow.source.kind).toBe("raw_fsm");
  });

  it("references every agent state's prompt file on disk", async () => {
    const { workflow } = await loadExpandedWorkflow(workflowPath);
    const referenceErrors = await validateExpandedWorkflowReferences(
      workflow,
      workflowPath
    );
    expect(referenceErrors).toEqual([]);
  });

  it("routes implement's success transition through a PR-existence gate before code_review_fix (issue #730)", async () => {
    const { workflow } = await loadExpandedWorkflow(workflowPath);
    const implement = findWorkflowState(workflow, "implement");
    expect(implement).toBeDefined();

    const successTransition = implement?.transitions.find(
      (transition) =>
        transition.when.provider_success === true &&
        transition.when.branch_ahead_of_base === true
    );
    expect(successTransition).toBeDefined();
    // implement must not hand off straight to code_review_fix on local
    // git state alone -- it never checks the branch reached origin or
    // that a pull request exists (root cause #2 in issue #730).
    expect(successTransition?.to).not.toBe("code_review_fix");

    const gate = findWorkflowState(workflow, successTransition!.to);
    expect(gate).toBeDefined();
    expect(gate?.action?.kind).toBe("wait");

    const openTransition = gate?.transitions.find(
      (transition) => transition.when.pr_open === true
    );
    expect(openTransition?.to).toBe("code_review_fix");

    const mergedTransition = gate?.transitions.find(
      (transition) => transition.when.pr_merged === true
    );
    expect(mergedTransition?.to).toBe("merged");

    const closedTransition = gate?.transitions.find(
      (transition) => transition.when.pr_open === false
    );
    expect(closedTransition?.to).toBe("failed");
  });

  it.each(["code_review_fix", "simplify", "autofix", "resolve_conflicts"])(
    "gates %s's success transition on an artifact_exists: BLOCKED.md check ordered first (issue #730)",
    async (stateId) => {
      const { workflow } = await loadExpandedWorkflow(workflowPath);
      const state = findWorkflowState(workflow, stateId);
      expect(state).toBeDefined();

      const blockedIndex = state!.transitions.findIndex(
        (transition) => transition.when.artifact_exists === "BLOCKED.md"
      );
      const successIndex = state!.transitions.findIndex(
        (transition) => transition.when.provider_success === true
      );

      expect(blockedIndex).toBeGreaterThanOrEqual(0);
      expect(successIndex).toBeGreaterThanOrEqual(0);
      // First-match-wins transition dispatch (state-machine-dispatch.ts): the
      // BLOCKED.md check must be checked before provider_success, or a
      // rejected pass that still exits 0 would be read as success.
      expect(blockedIndex).toBeLessThan(successIndex);
      expect(state!.transitions[blockedIndex]?.to).toBe("failed");
    }
  );
});
