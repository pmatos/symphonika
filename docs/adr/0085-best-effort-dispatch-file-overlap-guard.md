# Best-effort dispatch file-overlap guard

ADR 0053 permits more than one in-flight Run per Project, but admission considers only capacity and
Issue Reservation. Two concurrent Runs can therefore modify the same files and create predictable
merge-conflict churn.

## Decision

Add an optional Dispatch-Project configuration:

```yaml
dispatch:
  overlap_guard: true
```

The option defaults to false and is invalid on a Routine Host.

When enabled, `RunController.pickTargetFromCandidates` applies a fourth gate after the global cap,
per-Project cap, and Issue Reservation. The candidate footprint is the changed-file list of an
existing open pull request linked through a Symphonika tracked association or the candidate's
deterministic Issue Branch. The in-flight footprint is the union of committed and live Workspace
changes for issue Runs in the same Project. Exact repository-relative path intersection is a known
collision and skips that candidate for the current tick.

In-flight footprints live on `InFlightRunRegistry` entries and are refreshed at most every 30
seconds during normal dispatch ticks. The guard creates no timer or polling loop. Unregistering a
terminal Run removes its footprint, making a skipped candidate eligible for reconsideration on the
next tick.

The guard fails open when either footprint is unavailable or a Git/GitHub read fails. Fresh Issues
usually have no pull-request footprint and therefore remain dispatchable. Strict Project-wide
serialization remains available through `max_in_flight: 1`.

A skipped Project does not participate in weighted round-robin for that tick, so its scheduler
cursor does not advance. Other Projects and later non-colliding candidates in the same Project
remain eligible.

## Consequences

- The feature reduces known collisions without introducing an Issue-body file convention.
- The feature is best-effort, not a guarantee against collisions between genuinely fresh Issues or
  changes made during the refresh interval.
- GitHub file discovery and local Git inspection remain provider-neutral.
- Candidate and in-flight evidence stay ephemeral; no Run Store migration is required.
- Detecting or cancelling superseded in-flight work remains a separate architecture decision.

