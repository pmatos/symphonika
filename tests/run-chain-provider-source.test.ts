import { describe, expect, it } from "vitest";

import { resolveProviderSource } from "../src/issues/run-chain-timeline.js";
import type { ExpandedWorkflow } from "../src/workflow/types.js";

const graph: ExpandedWorkflow = {
  contentHash: "sha256:graph",
  initial: "implement",
  name: "default",
  source: { kind: "raw_fsm", path: "workflow.yml" },
  states: [
    {
      action: { kind: "agent", prompt: "p", provider: "claude" },
      completeWhen: {},
      id: "implement",
      transitions: []
    },
    {
      action: { kind: "wait" },
      completeWhen: {},
      id: "await_checks",
      transitions: []
    }
  ]
};

describe("resolveProviderSource (#862)", () => {
  it.each([
    ["operator_state", { kind: "operator_state" }],
    ["operator_chain", { kind: "operator_chain" }],
    ["project_default", { kind: "project_default" }],
    ["workflow_action", { declaredProvider: "codex", kind: "workflow_state" }]
  ] as const)("prefers a recorded %s source", (source, expected) => {
    expect(
      resolveProviderSource(graph, "implement", { provider: "codex", source })
    ).toEqual(expected);
  });

  it("falls back to the captured graph when nothing was recorded", () => {
    expect(
      resolveProviderSource(graph, "implement", {
        provider: "claude",
        source: null
      })
    ).toEqual({ declaredProvider: "claude", kind: "workflow_state" });
    expect(resolveProviderSource(graph, "implement")).toEqual({
      declaredProvider: "claude",
      kind: "workflow_state"
    });
  });

  it("keeps a non-agent state at no provider even with a recorded source", () => {
    expect(
      resolveProviderSource(graph, "await_checks", {
        provider: "codex",
        source: "project_default"
      })
    ).toEqual({ kind: "no_provider" });
  });
});
