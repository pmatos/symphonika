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

type ChainGraphTraversal = {
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

type ExecutedRow = {
  next?: { kind: ChainGraphTraversal["kind"]; stateId: string } | undefined;
  stateId: string | undefined;
};

// State a Run at `index` executed, recovered from the chain's forward-stamps:
// its parent's `currentStateId`, or the graph's `initial` for the root. A
// still-live parent never forward-stamped, so its value says nothing.
function stateExecutedAt(
  rows: readonly ChainStateRow[],
  index: number,
  graph: ExpandedWorkflow
): string | undefined {
  if (index === 0) {
    return graph.initial;
  }
  const parent = rows[index - 1];
  return parent?.kind === "completed"
    ? (parent.run.currentStateId ?? undefined)
    : undefined;
}

// A `pending_handoff` row's stateId names the state it handed off *to*, and a
// `terminal` row's names the terminal it reached — in both cases the state the
// Run actually executed is what stateExecutedAt recovers. Every other kind's
// stateId is what it executed.
function executedState(
  rows: readonly ChainStateRow[],
  index: number,
  graph: ExpandedWorkflow
): ExecutedRow {
  const row = rows[index];
  if (row === undefined) {
    return { stateId: undefined };
  }
  const reached = row.stateId;
  if (
    reached === undefined ||
    (row.kind !== "pending_handoff" && row.kind !== "terminal")
  ) {
    return { stateId: reached };
  }
  const executed = stateExecutedAt(rows, index, graph);
  if (executed === reached) {
    return { stateId: reached };
  }
  if (executed === undefined) {
    return { stateId: row.kind === "terminal" ? reached : undefined };
  }
  return {
    next: {
      kind: row.kind === "terminal" ? "transition" : "handoff_pending",
      stateId: reached
    },
    stateId: executed
  };
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

  const visit = (stateId: string, index: number): void => {
    const visits = visitsByState.get(stateId);
    if (visits === undefined) {
      visitsByState.set(stateId, [index]);
    } else {
      visits.push(index);
    }
    visited.add(stateId);
  };

  rows.forEach((_, index) => {
    const { next, stateId } = executedState(rows, index, graph);
    if (stateId === undefined) {
      previous = undefined;
      return;
    }
    visit(stateId, index);
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
    if (next !== undefined) {
      if (next.kind === "transition") {
        visit(next.stateId, index);
      } else {
        visited.add(next.stateId);
      }
      traversed.push({
        declared: declaresTransition(graph, stateId, next.stateId),
        from: stateId,
        kind: next.kind,
        to: next.stateId
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
