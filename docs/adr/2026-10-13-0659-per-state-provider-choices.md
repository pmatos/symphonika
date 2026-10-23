# Per-state provider choices on the Run-Chain Provider Plan, and recorded provider provenance

Status: Accepted

Part of epic #844, slice #862. Extends ADR-2026-10-09-0743 (Run-Chain Provider Plan).

## Decision

The Start preview (`GET /issues/:project/:number/start`) lists every state of the loaded workflow.
Each `agent` state of a raw FSM gets a provider selector whose default is "Chain-wide choice";
non-agent states and the synthesized states of a contract workflow get none. A selected value is an
**operator per-state choice**, stored on the same Run-Chain Provider Plan as the chain-wide choice.

Precedence for an agent state's provider becomes:

1. the operator's per-state choice for that state id,
2. the operator's chain-wide choice,
3. the state's own `action.provider`,
4. the Project's `agent.provider`.

An unset level reveals the next one. With no plan, levels 3 and 4 apply exactly as before. The
chain-wide choice stays required on a plan (Start is still "Start with a provider"), so while a
plan exists, level 3 is reached only by Runs the plan does not cover.

### Storage

`run_chain_provider_plans.state_providers_json` holds a `{stateId: provider}` object (since
ADR-2026-10-23-1738 a value may instead be `{provider, definitionDigest, definition}`) (`{}` for
none; `NULL` only on plans written before this change). Start validates it against the previewed
graph: the state must exist and be selectable, and the provider must be configured and registered;
blank entries mean chain-wide and are dropped. Retry re-runs the same validation.

`runs.provider_source` records which level chose the Run's provider at launch:
`operator_state`, `operator_chain`, `workflow_action` or `project_default`. Every path that launches
a provider through the fresh lifecycle must supply it: the fresh claim and State Advance resolve it
through `resolveEffectiveProvider`, and non-FSM Continuations and PR review follow-ups, which keep
Project routing, record `project_default`. Runs from before this change, and Runs that never
launched a provider, leave it `NULL`.

### Launch boundaries

- **Fresh claim** resolves the initial state's per-state choice. The plan id check under
  `dispatchMutex` is unchanged, and the per-state map is part of the same row, so the provider that
  was resolved is the one that gets consumed.
- **State Advance** reads the chain's plan (from the root Run, whatever the plan's status by then)
  and resolves the target state's per-state choice.
- **Retry** of an Attempt reuses the Run's own provider. An executing or retried Attempt therefore
  keeps the provider it started with, and the plan is immutable once consumed, so nothing can move
  it mid-state.

### Timeline

The Issue Run Chain timeline prefers `runs.provider_source` over re-deriving the source from the
captured workflow graph. An operator's choice never appears in any graph, so without the record the
timeline would mislabel an operator-routed Run as "workflow state" or "project default". Runs
without a record keep the graph-derived description.

## Consequences

- Per-state choices are keyed by state id and, as first built, were not re-validated at claim or
  advance: if a later workflow edit renames or removes a state, its choice silently stops
  matching and the state falls back to the chain-wide choice, and an edit that keeps the id but
  changes what the state does silently rebinds the choice. *Superseded for choices made since
  ADR-2026-10-23-1738*: they record the state's definition at Start, and a changed or removed
  state parks the chain before any provider starts. Choices without a recorded definition keep the
  behaviour described here.
- A per-state provider that becomes unconfigured or unregistered mid-chain fails that State
  Advance before the provider starts (`provider_command_missing` / `provider_not_registered`), as a
  chain-wide choice would.
- Recovering a stopped state with a different provider is #863, decided in
  ADR-2026-10-23-0903: a Continuation Run re-enters the stopped state under a new highest-precedence
  `operator_recovery` level that outranks the per-state choice above for that state only, and the
  plan is not rewritten.
- "Immutable once consumed" has one audited exception: the operator's resolution of an override
  review (ADR-2026-10-23-1820) rewrites the per-state entry it resolved, at the resumed Run's claim.
