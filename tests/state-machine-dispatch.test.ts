import { describe, expect, it } from "vitest";

import {
  decideNextStep,
  findWorkflowState
} from "../src/lifecycle/state-machine-dispatch.js";
import type {
  ExpandedWorkflow,
  ExpandedWorkflowState
} from "../src/workflow.js";

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
