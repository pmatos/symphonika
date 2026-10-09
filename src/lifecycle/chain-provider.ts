import type { AgentProviderName } from "../provider.js";
import type { ProviderPlan } from "../run-store.js";

// A Run-Chain Provider Plan (the operator's chain-wide choice) outranks a
// state's own `action.provider`, which outranks the Project default.
export function resolveEffectiveProvider(input: {
  actionProvider: AgentProviderName | undefined;
  planProvider: AgentProviderName | undefined;
  projectDefault: AgentProviderName;
}): AgentProviderName {
  return input.planProvider ?? input.actionProvider ?? input.projectDefault;
}

// `pending` and `label_written` are what a claim may consume. `label_failed`
// and `expired` are live but blocking: a write that may have reached GitHub
// must never be claimed with the default provider.
export function isConsumableProviderPlan(
  plan: Pick<ProviderPlan, "status"> | undefined
): boolean {
  return plan?.status === "pending" || plan?.status === "label_written";
}
