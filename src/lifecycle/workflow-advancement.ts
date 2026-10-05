import type { IssueSnapshot } from "../issue-polling.js";
import type { ProgressEdge, RunStore } from "../run-store.js";
import {
  isIssueContentActionKind,
  type ExpandedWorkflow,
  type ExpandedWorkflowState,
  type WorkflowActionKind
} from "../workflow/types.js";
import {
  buildEdgeBudgetExhaustedReason,
  buildNoProgressReason,
  describeProgressGuardPark
} from "./progress-fingerprint.js";
import {
  findWorkflowState,
  type StateMachineDecision
} from "./state-machine-dispatch.js";

type EffectfulStateMachineDecision = Extract<
  StateMachineDecision,
  { kind: "advance" | "blocked" | "terminate" }
>;

type WorkflowAdvancementDependencies = Readonly<{
  createRunId: () => string;
  runStore: RunStore;
}>;

type WorkflowAdvancementRun = Readonly<{
  branchName?: string;
  id: string;
  issue: IssueSnapshot;
  projectName: string;
  workspacePath?: string;
}>;

type WorkflowAdvancementMode =
  | Readonly<{
      deferNonTerminalAdvance: boolean;
      kind: "provider";
    }>
  | Readonly<{
      kind: "waiting";
      progressGuard:
        | Readonly<{
            fingerprint: string;
            kind: "enabled";
            maxClaims: number;
          }>
        | Readonly<{ kind: "exempt" }>;
    }>;

type WorkflowAdvancementInput = Readonly<{
  currentState: ExpandedWorkflowState;
  decision: EffectfulStateMachineDecision;
  mode: WorkflowAdvancementMode;
  reasonNote?: string;
  run: WorkflowAdvancementRun;
  workflow: ExpandedWorkflow;
}>;

type WorkflowAdvancementResult =
  | Readonly<{ kind: "advanced"; stateId: string }>
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "deferred" }>
  | Readonly<{
      attentionReason: string;
      claim: "budget_exhausted" | "unchanged";
      edge: ProgressEdge;
      kind: "progress_guarded";
      parkReason: string;
    }>
  | Readonly<{
      kind: "parked";
      stateId: string;
      waitingRunId: string;
    }>
  | Readonly<{
      kind: "terminal";
      terminal: string;
      terminalStateId: string;
    }>;

export function isWorkflowParkedAction(
  kind: WorkflowActionKind | undefined
): boolean {
  return (
    kind === "wait" || kind === "merge_pr" || isIssueContentActionKind(kind)
  );
}

export function applyWorkflowDecision(
  dependencies: WorkflowAdvancementDependencies,
  input: WorkflowAdvancementInput
): WorkflowAdvancementResult {
  const { decision } = input;
  const transitionReason = (reason: string): string =>
    input.reasonNote === undefined ? reason : `${reason} (${input.reasonNote})`;

  if (decision.kind === "blocked") {
    dependencies.runStore.recordWorkflowBlocked(input.run.id, {
      stateId: input.currentState.id,
      transitionReason: transitionReason(decision.reason)
    });
    return { kind: "blocked" };
  }

  if (decision.kind === "terminate") {
    dependencies.runStore.recordWorkflowTerminal(input.run.id, {
      terminalStateId: decision.stateId,
      transitionReason: `entered terminal state ${decision.terminal}`
    });
    return {
      kind: "terminal",
      terminal: decision.terminal,
      terminalStateId: decision.stateId
    };
  }

  const target = findWorkflowState(input.workflow, decision.to);
  if (target?.terminal !== undefined) {
    dependencies.runStore.recordWorkflowTerminal(input.run.id, {
      terminalStateId: target.id,
      transitionReason: transitionReason(decision.reason)
    });
    return {
      kind: "terminal",
      terminal: target.terminal,
      terminalStateId: target.id
    };
  }

  if (input.mode.kind === "provider" && input.mode.deferNonTerminalAdvance) {
    return { kind: "deferred" };
  }

  if (
    input.mode.kind === "waiting" &&
    input.mode.progressGuard.kind === "enabled"
  ) {
    const edge: ProgressEdge = {
      fromStateId: input.currentState.id,
      issueNumber: input.run.issue.number,
      projectName: input.run.projectName,
      toStateId: decision.to
    };
    const maxClaims = input.mode.progressGuard.maxClaims;
    const claim = dependencies.runStore.claimProgressEdge(
      edge,
      input.mode.progressGuard.fingerprint,
      maxClaims
    );
    if (claim !== "claimed") {
      const parkReason =
        claim === "unchanged"
          ? buildNoProgressReason(edge)
          : buildEdgeBudgetExhaustedReason(edge, maxClaims);
      dependencies.runStore.recordWaitingActivity(input.run.id, parkReason);
      return {
        attentionReason: describeProgressGuardPark(claim, edge, maxClaims),
        claim,
        edge,
        kind: "progress_guarded",
        parkReason
      };
    }
  }

  dependencies.runStore.recordWorkflowStateAdvance(input.run.id, {
    nextStateId: decision.to,
    transitionReason: transitionReason(decision.reason)
  });

  if (!isWorkflowParkedAction(target?.action?.kind)) {
    return { kind: "advanced", stateId: decision.to };
  }

  const waitingRunId = dependencies.createRunId();
  dependencies.runStore.createWaitingRun({
    ...(input.run.branchName === undefined
      ? {}
      : { branchName: input.run.branchName }),
    currentStateId: decision.to,
    id: waitingRunId,
    issue: input.run.issue,
    parentRunId: input.run.id,
    projectName: input.run.projectName,
    ...(input.run.workspacePath === undefined
      ? {}
      : { workspacePath: input.run.workspacePath })
  });
  return { kind: "parked", stateId: decision.to, waitingRunId };
}
