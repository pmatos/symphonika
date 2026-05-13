# Poll-driven wait states are reconciled, not dispatched

Symphonika's raw FSM workflow contract allows `action.kind: "wait"` states whose purpose is to pause
a workflow walk until observable pull-request conditions change (status-check rollup, mergeability,
unresolved review threads). Unlike `action.kind: "agent"` states, a wait state must not launch a
provider — it only re-evaluates predicates against externally-observed GitHub state and either
advances to the next workflow state or stays parked.

Two design choices follow from that contract.

First, a parked wait state needs its own lifecycle status. Reusing `blocked` (which is reserved for
the workflow-instance property recorded when an agent state finishes with no matching transition,
per ADR 0046) would conflate "operator should look at this" with "the daemon is correctly waiting
for external GitHub state to change". Symphonika introduces a new `RunState` value `"waiting"`,
distinct from `succeeded`, `cancelled`, and the failure states. Waiting rows show up in
`ACTIVE_STATES` (so status surfaces still list them) and in `KNOWN_RUN_STATES` (so the HTTP filter
admits them) but stay out of `TERMINAL_RUN_STATES` — operators can still cancel a waiting run, and
the daemon will keep re-evaluating it on every tick until it advances or is cancelled.

Second, wait re-evaluation does not go through the dispatch path. `executeStateAdvance` always
prepares a workspace and launches a provider via `runFreshLifecycle`; that contract is correct for
agent states but wrong for wait states, which by definition must not start a provider. Symphonika
adds a no-provider tick handler `reconcileWaitingRuns` that lives alongside `reconcileActiveRuns`
in the reconciliation phase of each daemon tick. For each row in `state = "waiting"` the handler
refreshes the issue, looks up the tracked pull request, projects the raw GitHub follow-up state
into the same `WorkflowPredicateMap` shape that agent states produce, and calls `decideNextStep`
to either advance, stay parked, or terminate. `decideNextStep` is taught a new
`stay_waiting` decision so a wait state with no matching transition is distinguishable from a
non-wait state in the same condition.

Wait re-evaluation runs outside `dispatchMutex`. The mutex protects fresh-run dispatch and PR
follow-up dispatch — both of which create new rows or mutate `tracked_pull_requests` — not
reconciliation of existing run rows. Tick serialization is provided by `enqueueScheduledWork`,
which already chains daemon ticks through a single promise queue, so two reconciliation passes
cannot overlap. Manual `/poll-now` calls `tick()` like the periodic timer, so the handler runs
the same way under operator-triggered polls.

The waiting row is persisted synchronously the moment the parent agent run terminates and the FSM
decides to advance into a wait state. `applyWorkflowOutcome` calls `createWaitingRun` inside the
same code path that records the parent's `state_transition_reason`. This places the wait state on
disk before any scheduler callback fires, so a daemon restart between the agent finishing and the
first re-evaluation firing only costs one tick of latency rather than losing the wait entirely —
single-daemon v1 (ADR 0012) keeps scheduler callbacks in memory, so durability has to live in the
run-store row itself.

Label immunity carries over from ADR 0046. A waiting run skips the `labels_all` / `labels_none`
re-check because the FSM, not the issue label set, decides when the wait advances; the
`sym:claimed` label remains set across the wait, which keeps the existing fresh-dispatch guard
against starting a second parallel agent on the same issue. Issue close is still honored — a
waiting row whose issue transitions to `closed` is cancelled with `cancel_reason="closed_issue"`,
matching the cancellation semantics of in-flight agent runs.

Two predicates are intentionally out of scope for this slice. `timeout` stays defined in the
predicate set but unimplemented; adding it requires tracking a wait-entered-at timestamp and a
clock signal, which belongs in a follow-up issue. Webhook-driven wake-ups are also out of scope —
the wait predicate set is intentionally observation-based, so the same daemon tick cadence that
already drives PR follow-up drives wait re-evaluation, with no second event path to maintain.

Projection of `mergeable` deliberately omits the predicate key when GitHub reports
`UNKNOWN` or `null`. A workflow author writing `when: { mergeable: false }` will not match on
UNKNOWN — the wait state stays parked until GitHub resolves the value. This is the correct
behavior: matching unknown against either branch would race the GitHub mergeability computation
that runs right after a push.

The PR follow-up logic in `src/pull-request-followup.ts` shares `projectPullRequestSignals` with
the wait handler so the two paths cannot drift in how they interpret a given GitHub state.
