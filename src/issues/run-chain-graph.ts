// #860's graph drill-down evidence: derives, from #859's timeline rows and the
// chain's captured workflow graph, which states a Run Chain visited, which
// transitions it demonstrably took, and where it currently is. Pure and
// DB-free. Traversal is recovered only from consecutive timeline rows — the
// sole evidence that survives (see run-chain-timeline.ts) — so no edge is
// ever guessed across a gap.

import {
  findWorkflowStateNode,
  type ChainStateRow,
  type ChainStateRowKind
} from "./run-chain-timeline.js";
import type { ExpandedWorkflow } from "../workflow/types.js";

export type ChainGraphTraversal = {
  declared: boolean;
  from: string;
  // "handoff_pending": the Run advanced to `to` but no Run was dispatched
  // into it, so it was handed off, not executed.
  kind: "handoff_pending" | "transition";
  to: string;
};

export type ChainGraphEvidence = {
  // Row indexes that ran the same state as the row before (Continuation, PR
  // follow-up) — no transition happened between them.
  continuedInPlace: number[];
  current: {
    kind: ChainStateRowKind;
    rowIndex: number;
    stateId: string | undefined;
  };
  // Visited states the captured graph has no node for (workflow edited
  // mid-chain, or an incompatible captured graph).
  missingStateIds: string[];
  // Executed states in first-visit order; `visits` are timeline row indexes.
  states: Array<{ stateId: string; visits: number[] }>;
  traversed: ChainGraphTraversal[];
};

type ExecutedRow = { handoffTarget?: string; stateId: string | undefined };

// A `pending_handoff` row's stateId names the state it handed off *to*; the
// state it actually executed is its parent's forward-stamp, or the graph's
// `initial` for a chain root. Every other kind's stateId is what it executed.
function executedState(
  rows: readonly ChainStateRow[],
  index: number,
  graph: ExpandedWorkflow
): ExecutedRow {
  const row = rows[index];
  if (row === undefined) {
    return { stateId: undefined };
  }
  if (row.kind !== "pending_handoff") {
    return { stateId: row.stateId };
  }
  if (index === 0) {
    return row.run.currentStateId === null
      ? { stateId: row.stateId }
      : { handoffTarget: row.stateId, stateId: graph.initial };
  }
  const executed = rows[index - 1]?.run.currentStateId ?? undefined;
  return executed === undefined || executed === row.stateId
    ? { stateId: executed }
    : { handoffTarget: row.stateId, stateId: executed };
}

function declaresTransition(
  graph: ExpandedWorkflow,
  from: string,
  to: string
): boolean {
  const transitions = findWorkflowStateNode(graph, from)?.transitions;
  return (
    Array.isArray(transitions) &&
    transitions.some((transition) => transition.to === to)
  );
}

export function buildChainGraphEvidence(
  rows: readonly ChainStateRow[],
  graph: ExpandedWorkflow | undefined
): ChainGraphEvidence | undefined {
  const leafIndex = rows.length - 1;
  const leaf = rows[leafIndex];
  if (graph === undefined || leaf === undefined) {
    return undefined;
  }

  const visitsByState = new Map<string, number[]>();
  const traversed: ChainGraphTraversal[] = [];
  const continuedInPlace: number[] = [];
  const visited = new Set<string>();
  let previous: string | undefined;

  rows.forEach((_, index) => {
    const { handoffTarget, stateId } = executedState(rows, index, graph);
    if (stateId === undefined) {
      previous = undefined;
      return;
    }
    visitsByState.set(stateId, [...(visitsByState.get(stateId) ?? []), index]);
    visited.add(stateId);
    if (previous === stateId) {
      continuedInPlace.push(index);
    } else if (previous !== undefined) {
      traversed.push({
        declared: declaresTransition(graph, previous, stateId),
        from: previous,
        kind: "transition",
        to: stateId
      });
    }
    previous = stateId;
    if (handoffTarget !== undefined) {
      visited.add(handoffTarget);
      traversed.push({
        declared: declaresTransition(graph, stateId, handoffTarget),
        from: stateId,
        kind: "handoff_pending",
        to: handoffTarget
      });
      previous = undefined;
    }
  });

  return {
    continuedInPlace,
    current: { kind: leaf.kind, rowIndex: leafIndex, stateId: leaf.stateId },
    missingStateIds: [...visited].filter(
      (stateId) => findWorkflowStateNode(graph, stateId) === undefined
    ),
    states: [...visitsByState].map(([stateId, visits]) => ({
      stateId,
      visits
    })),
    traversed
  };
}
