import { describe, expect, it } from "vitest";

import {
  decideNextStep,
  findWorkflowState
} from "../src/lifecycle/state-machine-dispatch.js";
import type {
  ExpandedWorkflow,
  ExpandedWorkflowState
} from "../src/workflow/types.js";

function makeWorkflow(states: ExpandedWorkflowState[]): ExpandedWorkflow {
  return {
    contentHash: "sha256:test",
    initial: states[0]?.id ?? "",
    name: "test_workflow",
    source: { kind: "raw_fsm", path: "/tmp/test.yml" },
    states,
    templateFiles: []
  };
}

const runAgentState: ExpandedWorkflowState = {
  action: { kind: "agent", provider: "codex" },
  completeWhen: { branch_ahead_of_base: true, provider_success: true },
  id: "run_agent",
  transitions: [{ to: "done", when: {} }]
};

const doneState: ExpandedWorkflowState = {
  completeWhen: {},
  id: "done",
  terminal: "success",
  transitions: []
};

describe("state-machine-dispatch", () => {
  describe("decideNextStep", () => {
    it("returns terminate when state has a terminal label", () => {
      const decision = decideNextStep({
        actionExecuted: false,
        signals: {},
        state: doneState
      });
      expect(decision).toEqual({
        kind: "terminate",
        stateId: "done",
        terminal: "success"
      });
    });

    it("returns execute_action when the action has not yet run", () => {
      const decision = decideNextStep({
        actionExecuted: false,
        signals: {},
        state: runAgentState
      });
      expect(decision).toEqual({
        action: { kind: "agent", provider: "codex" },
        kind: "execute_action",
        stateId: "run_agent"
      });
    });

    it("advances when complete_when satisfied and a transition matches", () => {
      const decision = decideNextStep({
        actionExecuted: true,
        signals: { branch_ahead_of_base: true, provider_success: true },
        state: runAgentState
      });
      expect(decision).toEqual({
        kind: "advance",
        reason: "state run_agent advanced to done",
        to: "done"
      });
    });

    it("blocks when a complete_when predicate is unmet", () => {
      const decision = decideNextStep({
        actionExecuted: true,
        signals: { branch_ahead_of_base: false, provider_success: true },
        state: runAgentState
      });
      expect(decision.kind).toBe("blocked");
      if (decision.kind === "blocked") {
        expect(decision.reason).toContain("branch_ahead_of_base");
        expect(decision.reason).toContain("expected true");
        expect(decision.reason).toContain("got false");
      }
    });

    it("blocks when a complete_when predicate is missing from signals", () => {
      const decision = decideNextStep({
        actionExecuted: true,
        signals: { provider_success: true },
        state: runAgentState
      });
      expect(decision.kind).toBe("blocked");
      if (decision.kind === "blocked") {
        expect(decision.reason).toContain("branch_ahead_of_base");
        expect(decision.reason).toContain("got undefined");
      }
    });

    it("picks the first transition whose when predicates all match", () => {
      const state: ExpandedWorkflowState = {
        action: { kind: "agent", provider: "codex" },
        completeWhen: { provider_success: true },
        id: "branching",
        transitions: [
          { to: "no_match", when: { unresolved_review_threads: true } },
          { to: "match", when: { branch_ahead_of_base: true } },
          { to: "also_matches", when: {} }
        ]
      };

      const decision = decideNextStep({
        actionExecuted: true,
        signals: { branch_ahead_of_base: true, provider_success: true },
        state
      });
      expect(decision.kind).toBe("advance");
      if (decision.kind === "advance") {
        expect(decision.to).toBe("match");
      }
    });

    it("blocks when no transition's when predicates all match the signals", () => {
      const state: ExpandedWorkflowState = {
        action: { kind: "agent", provider: "codex" },
        completeWhen: { provider_success: true },
        id: "branching",
        transitions: [{ to: "needs_extra", when: { pr_open: true } }]
      };

      const decision = decideNextStep({
        actionExecuted: true,
        signals: { provider_success: true },
        state
      });
      expect(decision.kind).toBe("blocked");
      if (decision.kind === "blocked") {
        expect(decision.reason).toContain("no transition matching");
      }
    });

    it("skips execute_action for a wait state even on first entry", () => {
      const waitState: ExpandedWorkflowState = {
        action: { kind: "wait" },
        completeWhen: {},
        id: "holding",
        transitions: [{ to: "merge", when: { checks: "success" } }]
      };

      const decision = decideNextStep({
        actionExecuted: false,
        signals: {},
        state: waitState
      });

      expect(decision.kind).not.toBe("execute_action");
    });

    it("returns stay_waiting for a wait state with no matching transition", () => {
      const waitState: ExpandedWorkflowState = {
        action: { kind: "wait" },
        completeWhen: {},
        id: "holding",
        transitions: [{ to: "merge", when: { checks: "success" } }]
      };

      const decision = decideNextStep({
        actionExecuted: true,
        signals: { checks: "pending" },
        state: waitState
      });

      expect(decision.kind).toBe("stay_waiting");
      if (decision.kind === "stay_waiting") {
        expect(decision.reason).toContain("holding");
      }
    });

    it("advances a wait state when a transition's when predicates match", () => {
      const waitState: ExpandedWorkflowState = {
        action: { kind: "wait" },
        completeWhen: {},
        id: "holding",
        transitions: [
          { to: "autofix", when: { unresolved_review_threads: 1 } },
          { to: "merge", when: { checks: "success", mergeable: true } }
        ]
      };

      const decision = decideNextStep({
        actionExecuted: true,
        signals: {
          checks: "success",
          mergeable: true,
          unresolved_review_threads: 0
        },
        state: waitState
      });

      expect(decision.kind).toBe("advance");
      if (decision.kind === "advance") {
        expect(decision.to).toBe("merge");
      }
    });

    it("skips execute_action for a merge_pr state even on first entry", () => {
      const mergeState: ExpandedWorkflowState = {
        action: { kind: "merge_pr" },
        completeWhen: {},
        id: "merging",
        transitions: [{ to: "done", when: { pr_merged: true } }]
      };

      const decision = decideNextStep({
        actionExecuted: false,
        signals: {},
        state: mergeState
      });

      expect(decision.kind).not.toBe("execute_action");
    });

    it("returns stay_waiting for a merge_pr state with no matching transition", () => {
      const mergeState: ExpandedWorkflowState = {
        action: { kind: "merge_pr" },
        completeWhen: {},
        id: "merging",
        transitions: [{ to: "done", when: { pr_merged: true } }]
      };

      const decision = decideNextStep({
        actionExecuted: true,
        signals: { pr_open: true, mergeable: true },
        state: mergeState
      });

      expect(decision.kind).toBe("stay_waiting");
      if (decision.kind === "stay_waiting") {
        expect(decision.reason).toContain("merge_pr");
        expect(decision.reason).toContain("merging");
      }
    });

    it("advances a merge_pr state once pr_merged is signalled", () => {
      const mergeState: ExpandedWorkflowState = {
        action: { kind: "merge_pr" },
        completeWhen: {},
        id: "merging",
        transitions: [{ to: "done", when: { pr_merged: true } }]
      };

      const decision = decideNextStep({
        actionExecuted: true,
        signals: { pr_merged: true },
        state: mergeState
      });

      expect(decision.kind).toBe("advance");
      if (decision.kind === "advance") {
        expect(decision.to).toBe("done");
      }
    });

    it("still returns blocked for a non-wait state with no matching transition", () => {
      const state: ExpandedWorkflowState = {
        action: { kind: "agent", provider: "codex" },
        completeWhen: { provider_success: true },
        id: "branching",
        transitions: [{ to: "needs_extra", when: { pr_open: true } }]
      };

      const decision = decideNextStep({
        actionExecuted: true,
        signals: { provider_success: true },
        state
      });

      expect(decision.kind).toBe("blocked");
    });

    it("treats a state with no action as ready to evaluate transitions on entry", () => {
      const state: ExpandedWorkflowState = {
        completeWhen: {},
        id: "passthrough",
        transitions: [{ to: "next", when: {} }]
      };

      const decision = decideNextStep({
        actionExecuted: false,
        signals: {},
        state
      });
      expect(decision.kind).toBe("advance");
      if (decision.kind === "advance") {
        expect(decision.to).toBe("next");
      }
    });
  });

  // artifact_exists is the one predicate whose value is a query argument rather
  // than an expected observation, so it is answered by the injected resolver and
  // never by the signal map. See #583.
  describe("artifact_exists", () => {
    const gatedPlanning = (
      when: Record<string, string | string[] | boolean>
    ): ExpandedWorkflowState => ({
      action: { kind: "agent", provider: "codex" },
      completeWhen: {},
      id: "planning",
      transitions: [
        { to: "implementing", when },
        { to: "needs_plan", when: {} }
      ]
    });

    const planningWithCompleteWhen = (
      completeWhen: Record<string, string | string[] | boolean>
    ): ExpandedWorkflowState => ({
      action: { kind: "agent", provider: "codex" },
      completeWhen,
      id: "planning",
      transitions: [{ to: "implementing", when: {} }]
    });

    it("advances only when the named path exists", () => {
      const state = gatedPlanning({
        artifact_exists: "PLAN.md",
        provider_success: true
      });
      const signals = { provider_success: true };

      expect(
        decideNextStep({
          actionExecuted: true,
          artifactExists: (candidate) => candidate === "PLAN.md",
          signals,
          state
        })
      ).toMatchObject({ kind: "advance", to: "implementing" });
      expect(
        decideNextStep({
          actionExecuted: true,
          artifactExists: () => false,
          signals,
          state
        })
      ).toMatchObject({ kind: "advance", to: "needs_plan" });
    });

    it("gates a list form on every listed path existing", () => {
      const state = gatedPlanning({
        artifact_exists: ["PLAN.md", "TESTPLAN.md"]
      });
      const present = new Set(["PLAN.md", "TESTPLAN.md"]);

      expect(
        decideNextStep({
          actionExecuted: true,
          artifactExists: (candidate) => present.has(candidate),
          signals: {},
          state
        })
      ).toMatchObject({ kind: "advance", to: "implementing" });

      present.delete("TESTPLAN.md");
      expect(
        decideNextStep({
          actionExecuted: true,
          artifactExists: (candidate) => present.has(candidate),
          signals: {},
          state
        })
      ).toMatchObject({ kind: "advance", to: "needs_plan" });
    });

    it("never answers from the signal map", () => {
      const state = gatedPlanning({ artifact_exists: "PLAN.md" });

      expect(
        decideNextStep({
          actionExecuted: true,
          artifactExists: () => false,
          signals: { artifact_exists: "PLAN.md" },
          state
        })
      ).toMatchObject({ kind: "advance", to: "needs_plan" });
    });

    it("blocks with the missing paths named when complete_when is unmet", () => {
      const decision = decideNextStep({
        actionExecuted: true,
        artifactExists: (candidate) => candidate === "PLAN.md",
        signals: {},
        state: planningWithCompleteWhen({
          artifact_exists: ["PLAN.md", "TESTPLAN.md"]
        })
      });

      expect(decision).toEqual({
        kind: "blocked",
        reason:
          "state planning complete_when predicate artifact_exists not satisfied (missing from the run workspace: TESTPLAN.md)"
      });
    });

    it("blocks loudly when no workspace is available to check", () => {
      const decision = decideNextStep({
        actionExecuted: true,
        signals: {},
        state: planningWithCompleteWhen({ artifact_exists: "PLAN.md" })
      });

      expect(decision).toEqual({
        kind: "blocked",
        reason:
          "state planning complete_when predicate artifact_exists not satisfied (no run workspace available to check PLAN.md)"
      });
    });

    it("blocks on a value the parser would have rejected", () => {
      const decision = decideNextStep({
        actionExecuted: true,
        artifactExists: () => true,
        signals: {},
        state: planningWithCompleteWhen({ artifact_exists: true })
      });

      expect(decision).toEqual({
        kind: "blocked",
        reason:
          "state planning complete_when predicate artifact_exists not satisfied (true is not a workspace-relative path or list of paths)"
      });
    });

    it("names the predicate in the advance reason", () => {
      const decision = decideNextStep({
        actionExecuted: true,
        artifactExists: () => true,
        signals: { provider_success: true },
        state: gatedPlanning({
          artifact_exists: ["PLAN.md", "TESTPLAN.md"],
          provider_success: true
        })
      });

      expect(decision).toMatchObject({
        kind: "advance",
        reason:
          'state planning advanced to implementing via artifact_exists=["PLAN.md","TESTPLAN.md"], provider_success=true',
        to: "implementing"
      });
    });
  });

  describe("findWorkflowState", () => {
    it("returns the state with the given id", () => {
      const workflow = makeWorkflow([runAgentState, doneState]);
      expect(findWorkflowState(workflow, "done")).toBe(doneState);
    });

    it("returns undefined for an unknown id", () => {
      const workflow = makeWorkflow([runAgentState, doneState]);
      expect(findWorkflowState(workflow, "nope")).toBeUndefined();
    });
  });
});
