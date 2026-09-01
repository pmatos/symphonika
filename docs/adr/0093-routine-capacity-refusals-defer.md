# Routine capacity refusals defer instead of skipping

ADR 0058 made every admission refusal a policy skip: the matched clock event is consumed, the
Routine Target's schedule advances, and the fan-out leg settles as `skipped`. ADR 0088 added
`host_pressure` as a fifth reason on the same path.

That is right for `overlap` and `catch_up_window`, which express a deliberate decision not to run
this event. It is wrong for the two reasons that mean "no capacity right now". A Routine Host whose
`max_in_flight` slots are held by issue Runs at the moment a nightly clock event lands loses that
event for a whole period, reports it as a skip that `failureCount` ignores, and mails a summary
reading `0 failed`. Observed on the reference host: a nine-target fan-out against a global cap of
eight could never run in full, one of its targets had never fired at all, and three others had not
fired for five days — all reported as successful nights.

## Decision

`concurrency_cap` and `host_pressure` are capacity refusals, not skips. A due clock event that hits
one is **deferred**: no `routine_firings` row, no clock advance, no skip counter, and the fan-out
leg stays `pending` carrying `deferred_reason`, `deferred_since` and `deferred_attempts`. Every
daemon tick re-evaluates admission for that same event. Routine dispatch runs ahead of *issue*
dispatch in a tick, so a fresh issue Run never takes a slot out from under a deferral evaluated in
the same tick. **Amended by ADR 0094:** a newly due Routine still follows PR review admission, but a
persisted capacity deferral retries before it, so review work cannot repeatedly take the slot the
Routine is already waiting for.

A deferral is bounded by the Routine's own schedule. A recurring Target defers until its next clock
event is due; that successor supersedes the parked event, so carrying it further would double-fire.
A one-shot Target has no successor to bound it and no successor to release its fan-out summary, so
it takes a fixed 24-hour horizon instead — the one place this deviates from "until the next
scheduled fire", because for a one-shot there is no such fire.

Recording a miss hands the clock to the successor event that ended the wait, not to the next event
after `now`. That event has had no admission attempt of its own, and advancing past it would make
one lost run cost two — the exact failure this ADR exists to remove. A backlog older than a whole
period still collapses to the next future event, as ADR 0058's advance does. The successor is
evaluated on the following tick, so a slot that frees around the deadline still runs it.

When the bound passes with the target still unadmitted, the event settles as **missed**: the clock
advances (or a one-shot expires) exactly as a skip does, the reason increments the existing rolling
24-hour counter once, the fan-out leg becomes `disposition = 'missed'`, and `failureCount` counts
it. `overlap`, `catch_up_window` and the provider-hold path keep ADR 0058 and ADR 0084 semantics
unchanged.

Restart catch-up does not settle a parked event. `recompute_recurring` advances a recurring clock
past events the daemon slept through, but skips a Target whose current event carries a live
deferral; the dispatcher then either fires it or records it as missed on the deadline it already
had.

## Consequences

- A capacity-starved Routine now runs late instead of not at all, and a Routine that genuinely did
  not run is reported as a failure in the fan-out subject and body rather than as `0 failed`.
- A fan-out summary is withheld while any leg is deferred, because the group is not finished. A
  nightly Routine deferred for hours mails hours late; a Routine that misses mails when its next
  clock event supersedes the parked one.
- Skip counter evidence keeps ADR 0058's meaning — one count per lost clock event — because only
  the terminal miss increments it, and the miss hands the clock to the successor rather than
  skipping over it. Deferral attempts are counted per fan-out leg instead. A Missed Routine reuses
  that counter and the `last_skip_reason` / `last_skip_at` columns: the reasons are shared, only the
  path to them differs.
- A deferred leg that loses its target mid-wait — its Project disabled, its Routine removed, its
  cron edited — settles as `missed` rather than as an uncounted `target_unavailable` skip. The run
  still did not happen, so it still reaches the failure count.
- Each deferring tick refreshes the Routine's `last_attempted_at`, so an operator can see that
  admission is being retried without reading the fan-out.
- Routine dispatch outranks fresh issue dispatch within a tick. ADR 0094 also gives a parked
  deferral priority over PR review follow-up while leaving a newly due Routine behind it.
- `deferred` and `missed` join `fired` and `skipped` in the dispatch result, and operator surfaces
  (`symphonika routines`, the status dashboard, `/routines`) show a live deferral so a Routine that
  is due but unadmitted no longer looks inexplicably late.
