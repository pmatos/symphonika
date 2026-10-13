import type { AgentProviderName } from "../provider.js";
import type { ProviderPlan, ProviderSelectionSource } from "../run-store.js";
import type { ExpandedWorkflowState } from "../workflow/types.js";

export type EffectiveProvider = {
  provider: AgentProviderName;
  source: ProviderSelectionSource;
};

// Only an `agent` state launches a provider of its own, so only it takes a
// per-state choice or contributes its `action.provider`.
export function isAgentState(
  state: Pick<ExpandedWorkflowState, "action"> | undefined
): boolean {
  return state?.action?.kind === "agent";
}

// An operator's per-state choice (#862) outranks their chain-wide choice
// (#861), which outranks a state's own `action.provider`, which outranks the
// Project default. An unset level reveals the next one down. `state` is the
// raw-FSM state being launched, or undefined when none is known (a contract
// workflow, or a workflow that failed to load).
export function resolveEffectiveProvider(input: {
  plan: Pick<ProviderPlan, "provider" | "stateProviders"> | undefined;
  projectDefault: AgentProviderName;
  state: Pick<ExpandedWorkflowState, "action" | "id"> | undefined;
}): EffectiveProvider {
  const agentState = isAgentState(input.state) ? input.state : undefined;
  // Own keys only: a state named e.g. `constructor` must not resolve to an
  // inherited Object.prototype member.
  const stateProvider =
    agentState === undefined ||
    input.plan === undefined ||
    !Object.hasOwn(input.plan.stateProviders, agentState.id)
      ? undefined
      : input.plan.stateProviders[agentState.id];
  if (stateProvider !== undefined) {
    return { provider: stateProvider, source: "operator_state" };
  }
  if (input.plan !== undefined) {
    return { provider: input.plan.provider, source: "operator_chain" };
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
