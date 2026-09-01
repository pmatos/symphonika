# Parked Routine deferrals outrank PR review follow-up admission

ADR 0093 changed a Routine capacity refusal from a consumed skip into a parked deferral. It gave
Routine dispatch priority over fresh Issue dispatch, but deliberately left PR review follow-up
ahead of both pending a separate scheduling decision. Because review follow-up and Routine Firings
reserve the same global and per-Project in-flight slots, a steady review backlog could still claim
each newly freed slot before the parked Routine retried and eventually turn the deferral into a
Missed Routine.

PR review follow-up has a real latency purpose: it unblocks pull requests and merges. Moving every
newly due Routine ahead of it would reverse the priority globally even when no Routine had yet been
denied capacity. The stronger claim is needed only after the Orchestrator has already promised to
retry a particular clock event.

## Decision

Daemon admission is conditionally ordered:

1. When the Run Store contains a live Routine Deferral, run Routine dispatch before PR follow-up.
   This pre-pass evaluates all due Routine Targets, so sibling and unrelated due work retain the
   dispatcher's existing per-target behavior without a second Routine pass in the same tick.
2. If that pass admits a Routine Firing, end the tick. The firing has reserved its shared slot.
   If it records a miss, also end the tick so the successor clock event handed forward by ADR 0093
   gets first refusal on the next tick.
3. Otherwise run PR follow-up. A `review_dispatch` action ends the tick because it reserved the
   shared capacity. A `merged` action does not end the tick: merging launches no provider and owns
   no in-flight slot.
4. When no Routine pre-pass was needed, run ordinary Routine dispatch after PR follow-up. Fresh
   Issue dispatch remains last.

This priority applies only while persisted deferral evidence is live. A Routine becoming due for
the first time remains behind PR follow-up, preserving the established bias toward unblocking pull
requests until capacity has actually refused the Routine.

## Consequences

- A review backlog cannot repeatedly take the slot promised to a parked Routine, so ADR 0093's
  retry window is meaningful rather than best effort behind an unbounded earlier queue.
- Review work keeps its prior priority over newly due Routine events; this ADR does not make all
  scheduled work globally higher priority than pull-request progress.
- A clean automatic merge no longer suppresses Routine and fresh-Issue admission for the rest of a
  daemon tick. It remains logged as a PR follow-up action and can be followed by work that actually
  reserves capacity.
- The daemon performs one inexpensive persisted-deferral existence query before PR follow-up
  admission. It does not add a new queue, reservation kind, or concurrency rule; the existing
  dispatcher and shared gates remain authoritative.

The alternatives rejected are keeping PR follow-up unconditionally first, which preserves the
starvation bug, and moving every Routine dispatch first, which delays review progress without any
prior capacity denial to justify that reversal.
