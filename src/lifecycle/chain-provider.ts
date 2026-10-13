import type { AgentProviderName } from "../provider.js";
import type { ProviderPlan, ProviderSelectionSource } from "../run-store.js";

export type EffectiveProvider = {
  provider: AgentProviderName;
  source: ProviderSelectionSource;
};

// An operator's per-state choice (#862) outranks their chain-wide choice
// (#861), which outranks a state's own `action.provider`, which outranks the
// Project default. An unset level reveals the next one down.
export function resolveEffectiveProvider(input: {
  actionProvider: AgentProviderName | undefined;
  plan: Pick<ProviderPlan, "provider" | "stateProviders"> | undefined;
  projectDefault: AgentProviderName;
  stateId: string | undefined;
}): EffectiveProvider {
  // Own keys only: a state named e.g. `constructor` must not resolve to an
  // inherited Object.prototype member.
  const stateProvider =
    input.stateId === undefined ||
    input.plan === undefined ||
    !Object.hasOwn(input.plan.stateProviders, input.stateId)
      ? undefined
      : input.plan.stateProviders[input.stateId];
  if (stateProvider !== undefined) {
    return { provider: stateProvider, source: "operator_state" };
  }
  if (input.plan !== undefined) {
    return { provider: input.plan.provider, source: "operator_chain" };
  }
  if (input.actionProvider !== undefined) {
    return { provider: input.actionProvider, source: "workflow_action" };
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
