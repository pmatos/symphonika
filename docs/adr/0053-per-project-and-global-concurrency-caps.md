# Per-Project and global concurrency caps

Slice 1 (ADR 0052) narrowed `dispatchMutex` so multiple provider runs can execute concurrently in
the daemon. With no further controls in place, the only limit on concurrent runs would be the
number of eligible Project Issues — which is rarely what an operator wants. Bounded concurrency is
needed so a busy multi-project deployment doesn't saturate CPU, network, or downstream APIs.

ADR 0005 already establishes weighted round-robin fairness across Projects. ADR 0008 establishes
hot-reload for service config. ADR 0051 establishes Issue Reservation as the per-Project-Issue
exclusion mechanism. This ADR layers a per-Project and a global concurrency cap on top of those.

## Decision

Add two new optional config keys:

```yaml
global:
  max_in_flight: 8       # default: unbounded (omit to disable)

projects:
  - name: symphonika
    max_in_flight: 2     # default: 1 (legacy serial-per-project behavior)
```

Both fields are `positive integer optional` — Zod rejects `0`, negative numbers, and non-integers.
Omitting the field is the documented disabled / default state.

### Enforcement

`RunController.pickTargetFromCandidates` is the single enforcement point:

1. **Global cap** — checked first. If `globalConcurrency.maxInFlight` is set and
   `activeRuns.countInFlight() >= maxInFlight`, the picker returns `undefined` and no dispatch
   happens this tick.
2. **Per-Project cap** — checked inside the per-project loop, before candidate selection. If
   `activeRuns.countInFlightByProject(projectName) >= project.max_in_flight ?? 1`, the project is
   skipped (its cursor does not advance, so weighted-round-robin fairness is preserved).
3. **Per-Issue reservation** — unchanged from ADR 0051. The picker still skips Issues already in
   `IssueReservationRegistry`.

Both counts read `InFlightRunRegistry` directly, NOT the `IssueReservationRegistry` union
(scheduled retries/continuations/state-advances do not consume a fresh cap slot).

### Counts come from InFlightRunRegistry only

A run consumes a cap slot from the moment `reserveSlot` runs (inside the narrowed claim section,
ADR 0052) until `unregister` runs (in `runAttemptLifecycle`'s `finally`). Scheduled retries,
continuations, and state-advances do not occupy a cap slot during the delay window — the parent
run's `finally` already released the slot, and the scheduled callback's `reserveSlot` re-acquires
the slot synchronously on fire. The cap throttles **new dispatches**, not workflow walks on an
already-in-progress Issue.

### Interaction with weighted round-robin (ADR 0005)

When a Project is at its per-Project cap, it is excluded from `dispatchable` in
`pickTargetFromCandidates`. Its `scheduler_current_weight` cursor does not advance because the
project never enters the round-robin computation for that tick. Once the cap clears, the project
re-enters with its existing cursor unchanged. Fairness is preserved across cap windows.

### Hot-reload semantics (ADR 0008)

Hot-reloading a config that lowers a cap below the current in-flight count does **not** cancel
running runs. Running runs continue to completion under the snapshot they started with; the new
cap gates only future dispatches. Once the in-flight count drops below the new cap, fresh
dispatches resume.

### Operator visibility

`/api/status` exposes `globalConcurrency: { maxInFlight, inFlight }` plus per-Project
`maxInFlight` and `inFlight` counts. The HTML dashboard, terminal dashboard, and `symphonika
status` CLI render them so operators can see the current state vs. configured caps at a glance.

### Workspace fetch concurrency (out of band but in-scope)

A per-Project `max_in_flight > 1` puts two concurrent `prepareIssueWorkspace` calls against the
same bare-repo cache path. Git's `git fetch` is not safe under concurrent invocations on the same
`.git` directory — it fails with `Unable to create '.../packed-refs.lock': File exists.`. To make
`max_in_flight > 1` per Project safe, this slice also adds a module-level fetch lock in
`src/workspace.ts` keyed by cache path, serializing `git fetch` against the same bare repo while
allowing the rest of `prepareIssueWorkspace` (per-issue worktree creation) to run concurrently.

## Consequences

- Operators can bound concurrency at two levels (per-Project and globally) without code changes.
- Default behavior is unchanged: omitted caps preserve legacy serial-per-project behavior
  (because per-Project default is 1 and global default is unbounded — a single ready project with
  one in-flight run does not exceed cap 1).
- Multiple projects each at cap 1 still run concurrently, which is the intended Slice-1 gain.
- A project capped above 1 requires git fetch lock support, which lands in the same slice.
- `dispatchOneEligibleIssue` (one-shot CLI, ADR 0026) parses `max_in_flight` from the schema for
  parity but does not enforce it: the one-shot CLI runs at most one Issue per invocation, so
  per-Project and global counts are 0 at start and trivially below any cap.
- Future per-provider caps (e.g., `providers.codex.max_in_flight`) are a possible follow-up
  but out of scope here.

## Numbering

ADR 0052 (`narrow-dispatch-mutex-scope`) precedes this ADR. The next free number is 0053. ADR
0051 has three pre-existing variants in the tree; the gap was an artifact of concurrent slices,
not numbering error here.
