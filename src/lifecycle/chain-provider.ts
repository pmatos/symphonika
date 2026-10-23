import type { AgentProviderName } from "../provider.js";
import type { ProviderPlan, ProviderSelectionSource } from "../run-store.js";
import {
  isCurrentStateDefinitionDigest,
  stateDefinitionEvidence,
  type StateDefinitionEvidence
} from "../workflow/state-definition-digest.js";
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

export type ProviderOverrideReviewFinding = {
  kind: "definition_changed" | "state_removed";
  newDigest: string | null;
  oldDigest: string;
  provider: AgentProviderName;
  stateId: string;
};

// Whether an operator's per-state choice (#862) still describes the state it
// was made for (#864). Returns a finding only for a choice that recorded the
// state's definition at Start and whose state is now gone or is still an
// agent state with a different definition. Not a finding: a chain-wide
// choice (it names no state), a choice for another state, a legacy choice
// with no recorded digest, a digest from another scope version, and a state
// that is no longer an agent state (its per-state choice is already inert).
export function findStaleStateOverride(input: {
  plan: Pick<ProviderPlan, "stateDefinitions" | "stateProviders"> | undefined;
  state: ExpandedWorkflowState | undefined;
  stateId: string;
}): ProviderOverrideReviewFinding | undefined {
  const { plan, state, stateId } = input;
  if (
    plan === undefined ||
    !Object.hasOwn(plan.stateProviders, stateId) ||
    !Object.hasOwn(plan.stateDefinitions, stateId)
  ) {
    return undefined;
  }
  const provider = plan.stateProviders[stateId];
  const recorded = plan.stateDefinitions[stateId];
  if (
    provider === undefined ||
    recorded === undefined ||
    !isCurrentStateDefinitionDigest(recorded.digest)
  ) {
    return undefined;
  }
  if (state === undefined) {
    return {
      kind: "state_removed",
      newDigest: null,
      oldDigest: recorded.digest,
      provider,
      stateId
    };
  }
  if (!isAgentState(state)) {
    return undefined;
  }
  const current = stateDefinitionEvidence(state);
  return current.digest === recorded.digest
    ? undefined
    : {
        kind: "definition_changed",
        newDigest: current.digest,
        oldDigest: recorded.digest,
        provider,
        stateId
      };
}

// What an operator's review of a stale per-state choice leaves in the plan
// for that state: the provider and the definition it now describes, or null
// to drop the choice so the state falls back to the chain-wide one.
export type ReviewedOverride = {
  evidence: StateDefinitionEvidence;
  provider: AgentProviderName;
} | null;

// The plan as it will read once the review is persisted. The launch that
// resumes the chain evaluates the detector and the precedence against this,
// so a workflow edit that lands between the operator's confirm and the launch
// parks the chain again instead of binding the choice to an unseen definition.
export function withReviewedOverride<
  T extends Pick<ProviderPlan, "stateDefinitions" | "stateProviders">
>(plan: T, stateId: string, override: ReviewedOverride): T {
  const without = <V>(record: Readonly<Record<string, V>>): Record<string, V> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => id !== stateId));
  return {
    ...plan,
    stateDefinitions:
      override === null
        ? without(plan.stateDefinitions)
        : { ...without(plan.stateDefinitions), [stateId]: override.evidence },
    stateProviders:
      override === null
        ? without(plan.stateProviders)
        : { ...without(plan.stateProviders), [stateId]: override.provider }
  };
}

// `pending` and `label_written` are what a claim may consume. `label_failed`
// and `expired` are live but blocking: a write that may have reached GitHub
// must never be claimed with the default provider.
export function isConsumableProviderPlan(
  plan: Pick<ProviderPlan, "status"> | undefined
): boolean {
  return plan?.status === "pending" || plan?.status === "label_written";
}
