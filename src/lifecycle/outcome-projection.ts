import type { ClassifiedTerminal } from "./classify-failure.js";
import type { RunState } from "../run-store.js";
import type { WorkflowPredicateMap } from "../workflow/types.js";

// Projects a ClassifiedTerminal (produced by classify-failure.ts) into the two
// downstream vocabularies the run controller drives from a terminal outcome:
//   (a) FSM terminal-label fusion — narrowTerminalLabel + fuseWorkflowTerminal,
//       turning a raw workflow terminal label into an effective outcome;
//   (b) outcome projection — isBlockedOutcome, mapOutcomeToRunState (both on the
//       *effective* outcome) and signalsFromTerminal (on the *raw* outcome,
//       upstream of the FSM decision that yields the label).
// The two phases share the private BLOCKED_TERMINAL_REASONS alphabet:
// fuseWorkflowTerminal writes `workflow_terminal_blocked`, isBlockedOutcome
// reads it. Keep them co-located so that coupling stays private.

// The three FSM terminal-node labels that carry outcome semantics. Any other
// raw `state.terminal` string (or undefined) narrows to `undefined`.
export type TerminalLabel = "success" | "failure" | "blocked";

// Reason-based, not a new ClassifiedTerminal.kind: `kind` stays "failed" for
// these outcomes so retry/classification/scheduling logic
// (deferRetryableTransientAdvance, willRetry, signalsFromTerminal, fsmContinuing)
// is untouched by this distinction — only RunState and the GitHub label branch
// downstream care. See ADR 0058 / issue #271.
const BLOCKED_TERMINAL_REASONS = new Set([
  "no_workspace_changes",
  "workflow_terminal_blocked"
]);

export function isBlockedOutcome(outcome: ClassifiedTerminal): boolean {
  return (
    outcome.kind === "failed" && BLOCKED_TERMINAL_REASONS.has(outcome.reason)
  );
}

export function mapOutcomeToRunState(outcome: ClassifiedTerminal): RunState {
  if (isBlockedOutcome(outcome)) {
    return "blocked";
  }
  switch (outcome.kind) {
    case "success":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "input_required":
      return "failed";
    case "failed":
    default:
      return "failed";
  }
}

export function narrowTerminalLabel(
  value: string | undefined
): TerminalLabel | undefined {
  if (value === "success" || value === "failure" || value === "blocked") {
    return value;
  }
  return undefined;
}

// When a raw FSM walks to a `failure` or `blocked` terminal node, the workflow
// author has declared the run is a deterministic failure regardless of the
// provider's exit code. Synthesize that classification so downstream code
// (state write, terminal_reason, sym:failed label, scheduleNext) all observe
// the workflow's verdict. Cancellation and input_required always win — they
// reflect operator/system intent that an FSM terminal label cannot override.
// This intentionally pre-empts the transient-retry policy for workflow-driven
// failures.
export function fuseWorkflowTerminal(
  terminal: ClassifiedTerminal,
  terminalLabel: TerminalLabel | undefined
): ClassifiedTerminal {
  if (terminal.kind === "cancelled" || terminal.kind === "input_required") {
    return terminal;
  }
  if (terminalLabel !== "failure" && terminalLabel !== "blocked") {
    return terminal;
  }
  return {
    classification: "deterministic",
    kind: "failed",
    reason: `workflow_terminal_${terminalLabel}`
  };
}

// Narrow-then-fuse for the single caller that holds both the base terminal and
// the raw FSM terminal string at one site.
// Invariant: fuseTerminalLabel(t, raw) === fuseWorkflowTerminal(t, narrowTerminalLabel(raw)).
export function fuseTerminalLabel(
  terminal: ClassifiedTerminal,
  rawLabel: string | undefined
): ClassifiedTerminal {
  return fuseWorkflowTerminal(terminal, narrowTerminalLabel(rawLabel));
}

// Projects the *raw* (pre-fusion) terminal to the workflow predicate signals
// that drive the FSM next-step decision. `no_workspace_changes` keeps
// provider_success true so a deterministic no-commits step still advances the
// walk (ADR 0046).
export function signalsFromTerminal(
  terminal: ClassifiedTerminal
): WorkflowPredicateMap {
  if (terminal.kind === "success") {
    return {
      branch_advanced_since_attempt_start:
        terminal.branchAdvancedSinceAttemptStart ?? false,
      branch_ahead_of_base: true,
      provider_success: true
    };
  }
  if (
    terminal.kind === "failed" &&
    terminal.reason === "no_workspace_changes"
  ) {
    return {
      branch_advanced_since_attempt_start: false,
      branch_ahead_of_base: false,
      provider_success: true
    };
  }
  return {
    branch_advanced_since_attempt_start: false,
    branch_ahead_of_base: false,
    provider_success: false
  };
}
