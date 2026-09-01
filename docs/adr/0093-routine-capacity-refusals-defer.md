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
daemon tick re-evaluates admission for that same event. Routine dispatch runs ahead of issue
dispatch in a tick, so a deferred target gets first refusal on the next freed slot.

A deferral is bounded by the Routine's own schedule. A recurring Target defers until its next clock
event is due; that successor supersedes the parked event, so carrying it further would double-fire.
A one-shot Target has no successor and defers for 24 hours instead.

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
  the terminal miss increments it. Deferral attempts are counted per fan-out leg instead.
- `deferred` and `missed` join `fired` and `skipped` in the dispatch result, and operator surfaces
  (`symphonika routines`, the status dashboard, `/routines`) show a live deferral so a Routine that
  is due but unadmitted no longer looks inexplicably late.
