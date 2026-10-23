# Recover a stopped FSM state with a different provider

Status: Accepted

Part of epic #844, slice #863 (backend stage; the preview/confirm page and the timeline entry for an
intervention are a follow-up stage). Extends ADR-2026-10-09-0743 (Run-Chain Provider Plan) and
ADR-2026-10-13-0659 (per-state choices); follows ADR-2026-09-03-1158 (adopt-pr) for the audited
operator exception to the claim mutex.

## Decision

An operator can re-enter the FSM state a Run chain stopped at on a provider of their choosing,
without restarting the Issue and without replaying earlier states. `POST
/api/issues/:project/:number/recover` (JSON, authenticated and CSRF-protected like adopt-pr, answers
`202 accepted` / `409` / `422`) takes the stopped Run id, the state id the operator saw it stopped
at, and the provider.

### Recovery is a new Continuation Run, not a new attempt

The recovery launch is a **new Run, parented to the stopped Run** through the same State Advance
route a shutdown resume uses (`executeStateAdvance` with the stopped Run as parent), so
`createContinuationRun` inherits the preserved `current_state_id`, branch and Workspace. It is not a
new Attempt on the stopped Run:

- An Attempt belongs to one Run's provider and one `runs.provider_name`; switching provider inside a
  Run would make that Run's own provider ambiguous and rewrite evidence the operator is trying to
  inspect.
- The stopped Run keeps its terminal state, reason, classification and Attempts exactly as they were.
  The Issue timeline therefore shows the original failure as its own row and the recovery as the
  next one, and the Run Chain stays a lineage rather than a history rewritten in place.
- Retries, State Advance, the watchdog and shutdown resume already operate on Runs; a recovery Run
  inherits all of them for free.

The launch is *scheduled* (a zero-delay `state_advance` in the Scheduled Work registry), not
awaited: the attempt runs the provider to completion, so awaiting it would hold the HTTP request for
the whole agent run. Scheduling also makes the Issue visibly reserved from the moment of acceptance.
The claim itself takes `dispatchMutex` later, inside `claimAndPersistRun`, exactly as for every
other advance; nothing in the recovery service holds that mutex across a claim (it is not
reentrant).

### Which Runs are recoverable

A Run is recoverable when all of these hold; any other case is refused with a reason and writes
nothing:

| Condition | Refusal reason |
| --- | --- |
| Run exists for this (Project, Issue) | `run-not-found` |
| State is `failed`, `blocked` or `input_required` | `run-not-stopped` |
| `current_state_id` is set (a workflow terminal nulls it) | `invalid-position` |
| It equals the state id the operator submitted | `position-mismatch` |
| Workflow is a raw FSM and the state is an agent state in the *current* workflow | `workflow-not-fsm`, `invalid-position` |
| Run's recorded repository is the Project's current tracker | `repository-mismatch` |
| Nothing was created after it: no Continuation child, no later Run for the Issue | `superseded` |
| Provider is configured, registered, and one of `omp`/`claude`/`codex` | `provider-unavailable` |
| Live GitHub read: Issue is open | `issue-closed` |
| Live GitHub read: no `sym:claimed`, `sym:running` or `sym:stale` | `claim-held` |
| No Issue Reservation (in-flight, scheduled retry, waiting; alias-expanded) and no pending shutdown resume | `live-run` |

The same local checks run again under `dispatchMutex` after the GitHub read, as adopt-pr does. A
scheduled retry is a reservation, so a failed Run whose retry is still pending refuses; that is the
"executing work refuses a provider switch" rule for the window between attempts.

`superseded` is what stops a stale position from replaying completed effectful states: a Run that is
not the head of its Issue's history, or that already has a recovery child, is never re-entered.

#### Stale claims and the operator's stopped verdict

Terminal failure and block release `sym:claimed` (`applyTerminal`), so a genuinely stopped Run
leaves `sym:failed`/`sym:blocked`/`sym:human-needed` and no claim. A claim label that is still on the
Issue therefore means something else owns it (a live Run the registry cannot see, or a claim that
outlived its Run and may already carry `sym:stale`). Recovery refuses rather than clearing it;
`clear-stale-claim` is the operator's explicit action for that. Once the recovery's own claim has
landed, the stopped verdict is withdrawn (`sym:failed`, `sym:blocked`, `sym:human-needed`, best
effort), so the Issue does not read "failed" while it runs again.

#### Parked `waiting` Runs are not recoverable here

The issue text lists "parked" states. A `waiting` Run is live by every liveness definition (it keeps
`sym:claimed`, owns its PR, and is reconciled on a schedule) and it sits at a `wait`/`merge_pr`
state, which has no provider. Both guards cannot hold at once, and "recover at a wait state" is
really "choose an edge out of it", a different operation. `waiting` is refused as `run-not-stopped`;
what a parked-state recovery means is left to the operator (see Consequences).

### New highest-precedence provider level

`operator_recovery` joins `ProviderSelectionSource`. Precedence for an agent state's provider
becomes:

1. operator recovery of that state,
2. the operator's per-state choice,
3. the operator's chain-wide choice,
4. the state's own `action.provider`,
5. the Project's `agent.provider`.

The recovery level is passed to `resolveEffectiveProvider` by the one launch that re-enters the
recovered position and applies to that state id only. It is **not** written onto the Run-Chain
Provider Plan, which stays exactly as saved (the plan is immutable once consumed), so a later loop
back to the same state by an ordinary State Advance resolves from the plan again. The new Run
records `provider_source = operator_recovery`, which the Issue timeline names ("operator recovery of
this state").

A **shutdown resume** of a recovered Run would otherwise resolve from the plan and silently undo the
operator's choice, so a resume whose parent is the Run a recovery launched (found through the
intervention row), re-entering the recovered state, keeps that provider. A Run that advanced past the
recovered state resumes at another state and matches nothing. A retry of an Attempt already keeps the Run's provider (ADR-2026-10-13-0659).

### Intervention record

`chain_provider_interventions` is the audit trail, separate from the plan and shared by later
intervention kinds:

| Column | Meaning |
| --- | --- |
| `id`, `kind` | Row id; `recovery` now, `override_review` reserved for #864 |
| `project_name`, `issue_number`, `repository_owner`, `repository_name` | Issue identity, keyed by repository like plans |
| `chain_root_run_id`, `from_run_id`, `to_run_id` | The chain, the stopped Run, and the Run the intervention produced (null until launched) |
| `state_id` | The recovered position |
| `from_provider`, `to_provider` | The stopped Run's provider and the operator's choice |
| `requested_via` | How the request arrived (`http`); see below |
| `outcome`, `last_error` | `scheduled` -> `launched` / `failed` / `dropped`, with the reason |

The row is written under `dispatchMutex` together with the schedule, so a refused request leaves no
row. A partial unique index allows one `scheduled` row per `(from_run_id, kind)`, so a double submit
cannot launch twice. Every exit of the scheduled launch settles the row: the claim marks it
`launched` with the new Run id; a launch that ends before a Run exists (closed Issue, dropped
Project, shutdown), or raises, marks it `dropped`/`failed`; a pre-provider failure records the failed
Run it created. A restart drops rows still `scheduled`, because the work that would settle them was
in memory.

There is no operator identity column. ADR-0075 authenticates a request (same-origin and CSRF for a
browser, none for a local CLI caller), not a person, so `requested_via` records the channel instead
of inventing a user.

## Consequences

- The stopped Run's Workspace and branch are inherited, not recreated, and recovery adds no reset of
  its own. Whether the new provider should start from a clean tree is a preview-stage question.
- A Run whose state a workflow edit renamed, removed or turned into a non-agent state cannot be
  recovered (`invalid-position`), and a recovery accepted just before such an edit is failed at the
  launch with the reason recorded.
- A chain whose Issue was closed, reopened and re-labelled has a later Run, so the older chain is
  `superseded`; the operator starts fresh instead.
- Recovering a parked `waiting` Run (choosing an edge out of a wait state with another provider) is
  deliberately not part of this stage and needs a decision.
- The preview/confirm page, the timeline entry that joins an intervention to its two Runs, and
  override review (#864) read the same table.
