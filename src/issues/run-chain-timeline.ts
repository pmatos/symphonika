// #859's Issue Run Chain timeline: joins a Run Chain's rows into an ordered
// FSM state walk without recomputing anything the controller already
// decided. Pure and DB-free — callers (src/http/pages.ts) fetch Runs and
// their captured workflow graphs and pass the plain data in.
//
// The tricky part: `runs.current_state_id` is a forward-stamp, not a
// history. When a Run advances from state S to state S', the controller
// (src/lifecycle/workflow-advancement.ts) overwrites *that Run's own* row
// with S' before creating the continuation/waiting Run that actually
// executes S' (run-store.ts's createContinuationRun/createWaitingRun copy
// the parent's — by then already-overwritten — current_state_id into the
// child). So a Run's own `current_state_id`, once it has a continuation,
// names the *next* Run's state, never its own. The state a non-leaf Run
// executed is only recoverable from its *parent's* row (or, for a chain's
// root, from that root's own captured graph's `initial`).

import type { AgentProviderName } from "../provider.js";
import type { RunStatus } from "../run-store.js";
import type {
  ExpandedWorkflow,
  ExpandedWorkflowState,
  WorkflowTransition
} from "../workflow/types.js";

export type RunChainGroup = {
  // Runs sharing this chain's root that fell off the primary path (e.g. a
  // second continuation created off a Run that already had one) — flagged
  // rather than silently dropped or merged into the primary walk.
  otherRunIds: string[];
  rootRunId: string;
  // Root-to-leaf, the walk this chain's timeline renders.
  runs: RunStatus[];
};

// Groups a flat Run list (e.g. `runStore.listRuns({project, issueNumber})`)
// into Run Chains by walking `continuationParentRunId`. A Run whose parent
// id is absent from `runs` (closed over a different query window, or
// genuinely root) starts its own chain — never merged into another chain on
// the strength of sharing an issue number (AC1).
export function groupRunsIntoChains(
  runs: readonly RunStatus[]
): RunChainGroup[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const childrenByParent = new Map<string, RunStatus[]>();
  const roots: RunStatus[] = [];
  for (const run of runs) {
    const parentId = run.continuationParentRunId;
    if (parentId === null || !byId.has(parentId)) {
      roots.push(run);
      continue;
    }
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(run);
    childrenByParent.set(parentId, siblings);
  }

  const byCreatedAtDesc = (a: RunStatus, b: RunStatus): number =>
    a.createdAt === b.createdAt
      ? b.id.localeCompare(a.id)
      : b.createdAt.localeCompare(a.createdAt);

  const collectDescendants = (runId: string, out: string[]): void => {
    for (const child of childrenByParent.get(runId) ?? []) {
      out.push(child.id);
      collectDescendants(child.id, out);
    }
  };

  return roots
    .slice()
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    )
    .map((root) => {
      const path: RunStatus[] = [root];
      const otherRunIds: string[] = [];
      let current = root;
      for (;;) {
        const children = (childrenByParent.get(current.id) ?? [])
          .slice()
          .sort(byCreatedAtDesc);
        const [primaryChild, ...branches] = children;
        if (primaryChild === undefined) {
          break;
        }
        for (const branch of branches) {
          otherRunIds.push(branch.id);
          collectDescendants(branch.id, otherRunIds);
        }
        path.push(primaryChild);
        current = primaryChild;
      }
      return { otherRunIds, rootRunId: root.id, runs: path };
    });
}

export type ChainStateRowKind =
  | "blocked"
  | "completed"
  | "current_running"
  | "current_waiting"
  | "input_required"
  | "not_recorded"
  | "pending_handoff"
  | "terminal";

export type ChainStateRow = {
  kind: ChainStateRowKind;
  run: RunStatus;
  // The FSM terminal flavor ("success" | "blocked" | "failure") when `kind`
  // is "terminal" and the graph confirms it; undefined otherwise, including
  // when the graph is missing (AC3: described honestly, never guessed).
  terminalKind: string | undefined;
  transitionReason: string | null;
  // undefined only for "not_recorded": the evidence needed to say which FSM
  // state this Run executed is gone (e.g. an adopted root with no captured
  // graph that has since advanced further).
  stateId: string | undefined;
};

// `graphForRun(runId)` returns the ExpandedWorkflow captured by that Run's
// own latest attempt, or undefined if it has none (waiting/system-action
// Runs dispatch no provider and so capture no graph of their own).
export function deriveChainStateRows(
  chainRuns: readonly RunStatus[],
  graphForRun: (runId: string) => ExpandedWorkflow | undefined
): ChainStateRow[] {
  return chainRuns.map((run, index) => {
    const isLeaf = index === chainRuns.length - 1;
    if (!isLeaf) {
      const stateId =
        index === 0
          ? graphForRun(run.id)?.initial
          : (chainRuns[index - 1]?.currentStateId ?? undefined);
      return {
        kind: stateId === undefined ? "not_recorded" : "completed",
        run,
        stateId,
        terminalKind: undefined,
        transitionReason: run.stateTransitionReason
      };
    }

    if (run.currentStateId !== null && run.terminalStateId !== null) {
      return {
        kind: "blocked",
        run,
        stateId: run.terminalStateId,
        terminalKind: undefined,
        transitionReason: run.stateTransitionReason
      };
    }
    if (run.currentStateId === null && run.terminalStateId !== null) {
      const node = graphForRun(run.id)?.states.find(
        (state) => state.id === run.terminalStateId
      );
      return {
        kind: "terminal",
        run,
        stateId: run.terminalStateId,
        terminalKind: node?.terminal,
        transitionReason: run.stateTransitionReason
      };
    }
    if (run.currentStateId !== null) {
      return {
        kind: leafActiveKind(run.state),
        run,
        stateId: run.currentStateId,
        terminalKind: undefined,
        transitionReason: run.stateTransitionReason
      };
    }
    // Neither field is set: this Run has never recorded reaching any FSM
    // state. For the chain's root that's still its very first attempt,
    // dispatched but not yet advanced out of — `graph.initial` is ground
    // truth for what it's working on, independent of the current_state_id
    // forward-stamp quirk, so prefer it over an honest-but-unhelpful
    // "not recorded" when the graph is available.
    const rootInitial = index === 0 ? graphForRun(run.id)?.initial : undefined;
    if (rootInitial !== undefined) {
      return {
        kind: leafActiveKind(run.state),
        run,
        stateId: rootInitial,
        terminalKind: undefined,
        transitionReason: run.stateTransitionReason
      };
    }
    return {
      kind: "not_recorded",
      run,
      stateId: undefined,
      terminalKind: undefined,
      transitionReason: run.stateTransitionReason
    };
  });
}

// A leaf with no FSM terminal and `current_state_id` set is "current" only
// while its own execution is still moving (queued/preparing/running) or
// durably parked (waiting). A lifecycle-terminal RunState (succeeded,
// failed, cancelled, stale, blocked with no terminal_state_id) that still
// holds a forward-stamped current_state_id handed off to a continuation
// that was never created (crash between the two writes, or a daemon that
// never got to it) — shown as "pending_handoff" rather than claimed as
// still executing. `input_required` gets its own label: an operator
// decision is pending, not a stranded handoff.
function leafActiveKind(state: RunStatus["state"]): ChainStateRowKind {
  if (state === "waiting") {
    return "current_waiting";
  }
  if (state === "input_required") {
    return "input_required";
  }
  if (
    state === "queued" ||
    state === "preparing_workspace" ||
    state === "running"
  ) {
    return "current_running";
  }
  return "pending_handoff";
}

// Nearest-ancestor graph lookup: a waiting/system-action Run dispatches no
// provider and captures no graph of its own, so its evidence is whatever
// the closest earlier Run in the same chain captured.
export function resolveNearestGraph(
  chainRuns: readonly RunStatus[],
  rowIndex: number,
  graphForRun: (runId: string) => ExpandedWorkflow | undefined
): ExpandedWorkflow | undefined {
  for (let index = rowIndex; index >= 0; index -= 1) {
    const run = chainRuns[index];
    if (run === undefined) {
      continue;
    }
    const graph = graphForRun(run.id);
    if (graph !== undefined) {
      return graph;
    }
  }
  return undefined;
}

export function findWorkflowStateNode(
  graph: ExpandedWorkflow | undefined,
  stateId: string | undefined
): ExpandedWorkflowState | undefined {
  if (graph === undefined || stateId === undefined) {
    return undefined;
  }
  return graph.states.find((state) => state.id === stateId);
}

export type ProviderSource =
  | { kind: "no_provider" }
  | { kind: "not_recorded" }
  | { kind: "project_default" }
  | { declaredProvider: AgentProviderName; kind: "workflow_state" };

// Where the action's provider came from, per that state's *own* captured
// graph node — never the chain's newest graph, which may postdate this Run
// if the workflow changed mid-chain (ADR-2026-09-10-2031-adjacent concern).
export function resolveProviderSource(
  graph: ExpandedWorkflow | undefined,
  stateId: string | undefined
): ProviderSource {
  const node = findWorkflowStateNode(graph, stateId);
  if (node === undefined) {
    return { kind: "not_recorded" };
  }
  if (node.action?.kind !== "agent") {
    return { kind: "no_provider" };
  }
  return node.action.provider === undefined
    ? { kind: "project_default" }
    : { declaredProvider: node.action.provider, kind: "workflow_state" };
}

// One-hop lookahead only: predicates decide branching at run time, so
// anything past the current state's own declared transitions would be a
// guess, not evidence (AC2/AC3).
export function resolveUpcomingTransitions(
  graph: ExpandedWorkflow | undefined,
  stateId: string | undefined
): WorkflowTransition[] | undefined {
  return findWorkflowStateNode(graph, stateId)?.transitions;
}
