# Routine manual firing design

## Goal

Add `symphonika fire-now <routine>` as a daemon-owned manual trigger for a
Routine that is not due. The firing must use the ordinary Routine Firing
lifecycle, concurrency accounting, overlap policy, provider execution, and
evidence paths without consuming or advancing a scheduled clock event.

The public seams are:

- `POST /api/routines/:id/fire`, with optional `project` and `force` query
  parameters, to claim a manual Routine Firing;
- `GET /api/routines/:id/firings`, which already exposes firing state and is
  used by `--wait`; and
- the `symphonika fire-now` CLI command.

## Approaches considered

### Dedicated manual claim sharing the existing firing runner

Resolve and validate the Routine in the daemon, create a normal
`routine_firings` row with `trigger_source = manual`, reserve the shared
in-flight slot, and invoke the existing provider lifecycle. The claim leaves
the `routines` row untouched.

This is the selected approach. It keeps the schedule clock independent while
reusing all execution and evidence behavior.

### Temporarily make the Routine due

Move `next_fire_at` to the present and invoke the scheduled dispatcher, then
restore it. This was rejected because a crash or concurrent tick could expose
the temporary schedule, advance the wrong clock event, or fire twice.

### Persist a manual request for a later daemon tick

Add a request queue and let the next dispatch tick consume it. This was
rejected for this slice because it adds a second durable lifecycle and
recovery policy before a Routine Firing exists. The daemon HTTP handler can
claim the firing immediately and run it asynchronously without bypassing
daemon ownership.

## Claim and lifecycle

The daemon first performs its normal defensive Service Config reload, then
synchronizes Routine Targets from the resulting effective snapshot through the
same path scheduled dispatch uses. It resolves a Routine name against those
current persisted rows, including inactive rows so it can return a precise
refusal. `--project` narrows resolution. Ambiguous names return every candidate
Project and do not claim a firing.

This fire-time boundary deliberately covers both drift windows: a declaration
edited on disk before the next tick has reloaded it, and a runtime snapshot
reloaded before scheduled dispatch has synchronized the Run Store. A valid
reload refreshes prompt, provider, policy, and lifecycle fields; removal or
rejection records its exact non-active state. Whole-config failures keep the
last-known-good effective snapshot, and invalid individual declarations keep
their existing per-Routine last-known-good/invalid-stub semantics. Calling only
`syncRoutines` against the prior in-memory snapshot was rejected because it
would close only the second, narrower window. Direct declaration validation
was rejected because it would duplicate the tracker-less, template-rejected,
invalid, removal, and expiry classification already centralized in Routine
Target synchronization.

After reload and synchronization, an accepted claim performs these steps
without an asynchronous gap:

1. Refuse shutdown, overlap, missing provider configuration, or a full global
   or Project concurrency cap.
2. Atomically insert a normal `routine_firings` row whose
   `trigger_source = manual`.
3. Reserve the firing in the shared active-run registry.
4. Start the existing workspace, prompt, provider, evidence, cancellation, and
   terminal-classification lifecycle in daemon-owned background work.

The scheduled claim path records `trigger_source = scheduled`. Existing
databases add the column with a `scheduled` default so historical firings keep
their prior meaning.

The manual claim does not update `next_fire_at`, `last_fired_at`,
`last_attempted_at`, or Routine state. Those fields describe schedule-clock
progress. This is necessary for a future one-shot as well as a recurring
Routine: updating `last_fired_at` would make the one-shot evaluator expire the
still-pending scheduled event.

## State, force, and policy refusals

An `active` Routine may be fired manually. Every other state is refused with
its state in the response.

`--force` overrides only `state = disabled` with
`disabled_reason = operator`, the ADR-0060 representation of an explicit
`disabled: true` declaration. It does not override:

- `inactive`, because the target Project is unavailable;
- `invalid`, because there is no valid executable declaration;
- `expired`, because the one-shot lifecycle is complete;
- `disabled (removed_from_config)`, because the current Service Config no
  longer declares the Routine; or
- `disabled (rejected_tracker_less_host)`, because the Project cannot satisfy
  the ADR-0062 host contract.

Manual overlap obeys `allow_overlap`. Manual firing also consumes the ordinary
global and per-Project `max_in_flight` slot. Unlike a scheduled clock skip, a
manual refusal does not update skip counters or advance a schedule because no
clock event was attempted.

## HTTP and CLI behavior

An accepted POST returns HTTP 202 with the firing id, Routine, Project, and
queued state. Refusals use:

- 404 for no matching Routine;
- 409 for ambiguity, disallowed Routine state, overlap, or daemon shutdown;
- 429 for a concurrency cap; and
- 503 for unavailable provider configuration.

The CLI preflights daemon identity exactly like `poll-now` and `cancel`, then
prints the accepted firing id. Without `--wait` it exits after acceptance.
With `--wait`, it polls the existing firing-history endpoint for that exact id
until `succeeded`, `failed`, or `cancelled`. It prints the terminal state and
reason, and exits non-zero for `failed` or `cancelled`.

## Test strategy

Behavior is covered at the agreed public seams:

- Run Store tests prove a manual claim records its source without changing the
  schedule and that the next scheduled clock event can still claim.
- Dispatcher tests prove manual firing reuses the provider lifecycle, reserves
  and releases shared capacity, respects overlap, and returns cap/state
  refusals.
- HTTP tests prove request parsing, status codes, and ambiguity candidates.
- CLI tests prove daemon routing, Project selection, force propagation,
  immediate output, terminal waiting, and non-zero failure exit.
- Daemon integration tests prove a target removed from Service Config before
  the next tick is refused through the live endpoint, and that a not-due
  Routine fires through the same endpoint while remaining scheduled afterward.
