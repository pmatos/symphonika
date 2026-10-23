import type { AgentProviderName } from "../provider.js";
import type { ProviderPlan, ProviderSelectionSource } from "../run-store.js";
import type { ExpandedWorkflowState } from "../workflow/types.js";

type EffectiveProvider = {
  provider: AgentProviderName;
  source: ProviderSelectionSource;
};

// Only an `agent` state launches a provider of its own, so only it takes a
// per-state choice or contributes its `action.provider`.
export function isAgentState<T extends Pick<ExpandedWorkflowState, "action">>(
  state: T | undefined
): state is T {
  return state?.action?.kind === "agent";
}

// An operator's recovery of a stopped state (#863) outranks their per-state
// choice (#862), which outranks their chain-wide choice (#861), which
// outranks a state's own `action.provider`, which outranks the Project
// default. An unset level reveals the next one down. `state` is the raw-FSM
// state being launched, or undefined when none is known (a contract
// workflow, or a workflow that failed to load).
//
// `recovery` is passed only by the launch that re-enters the recovered
// position, never read from the plan: it applies to that one state, and the
// plan stays exactly as the operator saved it.
export function resolveEffectiveProvider(input: {
  plan: Pick<ProviderPlan, "provider" | "stateProviders"> | undefined;
  projectDefault: AgentProviderName;
  recovery?: { provider: AgentProviderName; stateId: string } | undefined;
  state: Pick<ExpandedWorkflowState, "action" | "id"> | undefined;
}): EffectiveProvider {
  const agentState = isAgentState(input.state) ? input.state : undefined;
  if (
    agentState !== undefined &&
    input.recovery !== undefined &&
    input.recovery.stateId === agentState.id
  ) {
    return {
      provider: input.recovery.provider,
      source: "operator_recovery"
    };
  }
  // Own keys only: a state named e.g. `constructor` must not resolve to an
  // inherited Object.prototype member.
  if (input.plan !== undefined) {
    const stateProvider =
      agentState !== undefined &&
      Object.hasOwn(input.plan.stateProviders, agentState.id)
        ? input.plan.stateProviders[agentState.id]
        : undefined;
    return stateProvider === undefined
      ? { provider: input.plan.provider, source: "operator_chain" }
      : { provider: stateProvider, source: "operator_state" };
  }
  const actionProvider = agentState?.action?.provider;
  if (actionProvider !== undefined) {
    return { provider: actionProvider, source: "workflow_action" };
  }
  return { provider: input.projectDefault, source: "project_default" };
}

// `pending` and `label_written` are what a claim may consume. `label_failed`
// and `expired` are live but blocking: a write that may have reached GitHub
// must never be claimed with the default provider.
export function isConsumableProviderPlan(
  plan: Pick<ProviderPlan, "status"> | undefined
): boolean {
  return plan?.status === "pending" || plan?.status === "label_written";
}
