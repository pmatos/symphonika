import { describe, expect, it } from "vitest";

import { probeStateClaim } from "../src/lifecycle/claim-probe.js";
import type { NormalizedProviderEvent } from "../src/provider.js";
import type { ExpandedWorkflowState } from "../src/workflow/types.js";

function agentState(
  completeWhen: ExpandedWorkflowState["completeWhen"] = {},
  transitions: ExpandedWorkflowState["transitions"] = []
): ExpandedWorkflowState {
  return {
    action: { kind: "agent", provider: "codex" },
    completeWhen,
    id: "working",
    transitions
  };
}

function claimEvents(
  claim: { status: string; summary: string } | undefined
): NormalizedProviderEvent[] {
  return [
    {
      ...(claim === undefined ? {} : { structuredOutput: claim }),
      type: "turn_completed"
    }
  ];
}

describe("probeStateClaim", () => {
  it("returns undefined when the state names no claim_status predicate, even if a valid claim was emitted", () => {
    const status = probeStateClaim({
      events: claimEvents({ status: "blocked", summary: "Should be ignored." }),
      state: agentState({}, [{ to: "done", when: { provider_success: true } }])
    });

    expect(status).toBeUndefined();
  });

  it("returns undefined when the declaring state's run emitted no claim", () => {
    const status = probeStateClaim({
      events: claimEvents(undefined),
      state: agentState({}, [
        { to: "blocked_terminal", when: { claim_status: "blocked" } }
      ])
    });

    expect(status).toBeUndefined();
  });

  it("returns the claim's status when the final turn carries a valid claim", () => {
    const status = probeStateClaim({
      events: claimEvents({ status: "blocked", summary: "No open PR found." }),
      state: agentState({}, [
        { to: "blocked_terminal", when: { claim_status: "blocked" } }
      ])
    });

    expect(status).toBe("blocked");
  });

  it("reads from complete_when as well as transitions", () => {
    const status = probeStateClaim({
      events: claimEvents({ status: "success", summary: "Done." }),
      state: agentState({ claim_status: "success" })
    });

    expect(status).toBe("success");
  });
});
