# Run-Chain Provider Plan: a chain-wide provider choice persisted before the Ready Label

Status: Accepted

Part of epic #844, slice #861. Builds on ADR 0052/0053/0093 (claim mutex and bounded claim write),
ADR 0075 (mutation authentication), ADR 0077 (issue label writes), ADR 0073 (snapshot) and
ADR-2026-10-08-1426 (single Ready Label).

## Decision

An operator can start an Issue with one provider (`omp`, `claude` or `codex`) for the **whole Run
Chain**. The choice is a durable **Run-Chain Provider Plan** row, written *before* the Project's
Ready Label is added, so the claim that the Ready Label triggers reads the plan instead of racing a
separate provider edit.

Precedence for the provider of an agent state: **chain plan > `action.provider` > Project
`agent.provider`**, applied at fresh claim and at State Advance. Non-FSM Continuations and PR
review follow-ups keep Project routing (per-state exceptions and their provenance are #862).

### Storage

`run_chain_provider_plans(id, project_name, issue_number, repository_owner, repository_name,
provider, graph_fingerprint, snapshot_polled_at, ready_label, status, last_error, attempt_count,
consumed_run_id, ...)`. Plans are keyed by `(repository owner/name, issue number)`, not Project
name, because two Projects can alias one repository. A partial unique index allows at most one live
plan per repository Issue. The chain link is `runs.provider_plan_id` on the **root** Run, set when a
claim consumes the plan; a chain's plan is found by walking `continuation_parent_run_id` to the
root, whatever the plan's status by then.

### Statuses

| Status | Meaning | Claim may consume | Blocks dispatch |
| --- | --- | --- | --- |
| `pending` | persisted, label write not confirmed | yes | no |
| `label_written` | Ready Label write confirmed | yes | no |
| `label_failed` | label write failed or was indeterminate | no | **yes** |
| `expired` | `pending` older than one hour | no | **yes** |
| `consumed` / `cancelled` / `superseded` | terminal | no | no |

`label_failed` and `expired` block because a timed-out write may have reached GitHub; letting the
poll claim the Issue with the Project default would be exactly the unintended provider the plan
exists to prevent. A plan never silently lapses into default routing: the blocked Issue is shown on
the Issue page with Retry and Cancel. `pending` is consumable so a crash between the plan write and
the status update does not strand an Issue whose label did land.

### Start protocol

1. Cheap local checks without the mutex: provider is configured and registered; the rendered
   snapshot repository binds through the persisted snapshot to the current tracker; the form's
   snapshot `polled_at` equals the stored one; the form's graph fingerprint equals the live
   workflow's `contentHash`.
2. A live GitHub read of the Issue and its dependencies (bounded, outside `dispatchMutex`; failure
   refuses). Ready Label already present, any `sym:*` label, excluded label, closed state, open or
   truncated blocker all refuse.
3. Under `dispatchMutex`, local checks only: no live Issue Reservation (in-flight, scheduled,
   waiting; alias-expanded), no suppressing latest Run, no other pending plan. One transaction
   supersedes older unconsumed plans and inserts the `pending` plan.
4. Outside the mutex, add the Ready Label (bounded), then a **conditional** status write
   (`pending` -> `label_written` or `label_failed`). A claim that already consumed the plan, or a
   Cancel that won, is reported as it is and never overwritten.
5. Retry reopens `label_failed`/`expired` after the same repository, fingerprint (the plan's stored
   one) and live-state checks; if the live Issue already carries the Ready Label it records
   `label_written` without a second write. Cancel is refused once consumed; a `label_written` plan
   is cancelled only while the Issue no longer carries the Ready Label.

### Claim boundary

`resolveAndClaim` reads the active plan to choose the provider; `claimAndPersistRun` re-reads it
inside `dispatchMutex` before the `sym:claimed` write and defers (`FreshClaimDeferredError`) on any
mismatch. Start/Retry/Cancel flip status under the same mutex, so the check stays valid through
`createRun`, which is followed synchronously by `consumeProviderPlan`. A plan whose provider has no
command or adapter skips that one candidate: no failed Run is created and the plan stays visible.
Candidates with a blocking plan are skipped like suppressed ones.

## Consequences

- The graph fingerprint (the workflow `contentHash`, a whole-file hash) is verified at Start and
  stored for audit; it is **not** re-checked at claim, so a chain-wide choice survives later graph
  edits. A comment-only edit therefore invalidates an open preview (accepted false positive).
- The snapshot identity is the Issue snapshot row's `polledAt`; a preview older than one poll is
  refused with "reload". Retry does not compare `polledAt`.
- The generic and bulk label routes can still add the Ready Label without a plan; that path keeps
  default routing and ignores plans.
- A `label_written` plan whose label is later removed by hand stays until cancelled or superseded
  and could attach to a much later manual Ready Label add; it is visible on the Issue page.
- Per-state operator exceptions, provenance on the timeline, recovery with another provider and
  override review after workflow edits are #862-#864.
