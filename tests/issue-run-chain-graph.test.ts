import { describe, expect, it } from "vitest";

import { buildChainGraphEvidence } from "../src/issues/run-chain-graph.js";
import type {
  ChainStateRow,
  ChainStateRowKind
} from "../src/issues/run-chain-timeline.js";
import type { RunStatus } from "../src/run-store.js";
import type { ExpandedWorkflow } from "../src/workflow/types.js";

const GRAPH: ExpandedWorkflow = {
  contentHash: `sha256:${"a".repeat(64)}`,
  initial: "implement",
  name: "loopy",
  source: { kind: "raw_fsm", path: "/repo/workflow.yml" },
  states: [
    {
      action: { kind: "agent", provider: "claude", prompt: "implement.md" },
      completeWhen: {},
      id: "implement",
      transitions: [{ to: "review_wait", when: { provider_success: true } }]
    },
    {
      action: { kind: "wait" },
      completeWhen: {},
      id: "review_wait",
      transitions: [
        { to: "implement", when: { checks: "failure" } },
        { to: "done", when: { checks: "success" } }
      ]
    },
    { completeWhen: {}, id: "done", terminal: "success", transitions: [] }
  ]
};

function row(
  kind: ChainStateRowKind,
  stateId: string | undefined,
  currentStateId: string | null = null
): ChainStateRow {
  return {
    kind,
    run: { currentStateId } as unknown as RunStatus,
    stateId,
    terminalKind: undefined,
    transitionReason: null
  };
}

describe("buildChainGraphEvidence (#860)", () => {
  it("records visits and one traversed pair per hop, with the leaf row kind as current", () => {
    const evidence = buildChainGraphEvidence(
      [
        row("completed", "implement"),
        row("completed", "review_wait"),
        row("terminal", "done")
      ],
      GRAPH
    );

    expect(evidence?.states).toEqual([
      { stateId: "implement", visits: [0] },
      { stateId: "review_wait", visits: [1] },
      { stateId: "done", visits: [2] }
    ]);
    expect(evidence?.traversed).toEqual([
      {
        declared: true,
        from: "implement",
        kind: "transition",
        to: "review_wait"
      },
      { declared: true, from: "review_wait", kind: "transition", to: "done" }
    ]);
    expect(evidence?.current).toEqual({
      kind: "terminal",
      rowIndex: 2,
      stateId: "done"
    });
    expect(evidence?.missingStateIds).toEqual([]);
  });

  it("records every visit of a looped state", () => {
    const evidence = buildChainGraphEvidence(
      [
        row("completed", "implement"),
        row("completed", "review_wait"),
        row("completed", "implement"),
        row("current_waiting", "review_wait")
      ],
      GRAPH
    );

    expect(
      evidence?.states.find((s) => s.stateId === "implement")?.visits
    ).toEqual([0, 2]);
    expect(evidence?.traversed.map((t) => `${t.from}->${t.to}`)).toEqual([
      "implement->review_wait",
      "review_wait->implement",
      "implement->review_wait"
    ]);
    expect(evidence?.current.kind).toBe("current_waiting");
  });

  it("draws no pair across a not_recorded row", () => {
    const evidence = buildChainGraphEvidence(
      [
        row("completed", "implement"),
        row("not_recorded", undefined),
        row("current_waiting", "review_wait")
      ],
      GRAPH
    );

    expect(evidence?.traversed).toEqual([]);
    expect(evidence?.states.map((s) => s.stateId)).toEqual([
      "implement",
      "review_wait"
    ]);
  });

  it("reports visited states absent from the captured graph", () => {
    const evidence = buildChainGraphEvidence(
      [row("completed", "legacy_step"), row("current_waiting", "review_wait")],
      GRAPH
    );

    expect(evidence?.missingStateIds).toEqual(["legacy_step"]);
    expect(evidence?.traversed).toEqual([
      {
        declared: false,
        from: "legacy_step",
        kind: "transition",
        to: "review_wait"
      }
    ]);
  });

  it("returns undefined without a captured graph", () => {
    expect(
      buildChainGraphEvidence([row("current_waiting", "implement")], undefined)
    ).toBeUndefined();
  });

  it("does not throw when the captured graph has non-array states", () => {
    const broken = {
      ...GRAPH,
      states: undefined
    } as unknown as ExpandedWorkflow;
    const evidence = buildChainGraphEvidence(
      [row("completed", "implement"), row("current_waiting", "review_wait")],
      broken
    );

    expect(evidence?.missingStateIds).toEqual(["implement", "review_wait"]);
    expect(evidence?.traversed).toEqual([
      {
        declared: false,
        from: "implement",
        kind: "transition",
        to: "review_wait"
      }
    ]);
  });

  it("treats a pending_handoff leaf's state as the handoff target, not as an executed visit", () => {
    const evidence = buildChainGraphEvidence(
      [
        row("completed", "implement", "review_wait"),
        row("pending_handoff", "done", "done")
      ],
      GRAPH
    );

    expect(evidence?.states).toEqual([
      { stateId: "implement", visits: [0] },
      { stateId: "review_wait", visits: [1] }
    ]);
    expect(evidence?.traversed).toEqual([
      {
        declared: true,
        from: "implement",
        kind: "transition",
        to: "review_wait"
      },
      {
        declared: true,
        from: "review_wait",
        kind: "handoff_pending",
        to: "done"
      }
    ]);
    expect(evidence?.current).toEqual({
      kind: "pending_handoff",
      rowIndex: 1,
      stateId: "done"
    });
  });

  it("uses graph.initial as the executed state of a handed-off root", () => {
    const evidence = buildChainGraphEvidence(
      [row("pending_handoff", "review_wait", "review_wait")],
      GRAPH
    );

    expect(evidence?.states).toEqual([{ stateId: "implement", visits: [0] }]);
    expect(evidence?.traversed).toEqual([
      {
        declared: true,
        from: "implement",
        kind: "handoff_pending",
        to: "review_wait"
      }
    ]);
  });

  it("flags consecutive rows in the same state as continued in place, with no edge", () => {
    const evidence = buildChainGraphEvidence(
      [row("completed", "implement"), row("current_running", "implement")],
      GRAPH
    );

    expect(evidence?.traversed).toEqual([]);
    expect(evidence?.continuedInPlace).toEqual([1]);
    expect(evidence?.states).toEqual([
      { stateId: "implement", visits: [0, 1] }
    ]);
  });

  it("flags a consecutive pair with no declared transition as undeclared", () => {
    const evidence = buildChainGraphEvidence(
      [row("completed", "implement"), row("terminal", "done")],
      GRAPH
    );

    expect(evidence?.traversed).toEqual([
      { declared: false, from: "implement", kind: "transition", to: "done" }
    ]);
  });

  it("reports an escalated-to-blocked leaf as blocked regardless of the graph node's terminal flavor", () => {
    const evidence = buildChainGraphEvidence(
      [row("completed", "implement"), row("blocked", "done")],
      GRAPH
    );

    expect(evidence?.current).toEqual({
      kind: "blocked",
      rowIndex: 1,
      stateId: "done"
    });
  });
});
