# Project next-poll ETA design

## Problem

The Dispatch Project detail page currently derives its `next poll` ETA from the latest completed
poll plus `polling.interval_ms`. A manual poll-now updates the latest poll timestamp but does not
reset the daemon's periodic `setInterval`, so the page can report a deadline later than the timer
that will actually fire.

## Decision

The live daemon will own a monotonic timestamp for the next periodic poll trigger. It will set the
deadline whenever it creates or resets the interval timer and advance it whenever that timer fires.
A manual poll-now will run the normal tick without changing this deadline.

The HTTP app will expose the deadline to the server-rendered pages through a read-only callback.
The Project detail page will combine its remaining monotonic duration with the request's wall clock
only for human-readable rendering. If no live deadline is available, the page will omit `next poll`
instead of reconstructing timer state from persisted poll history.

## Alternatives considered

1. Persist whether each poll was manual or periodic and extrapolate only from periodic history.
   This expands durable state while still failing to represent timer resets and event-loop delay.
2. Reconstruct the interval phase from process start and the current interval. This becomes wrong
   after hot reload resets the timer and can drift from when interval callbacks actually execute.
3. Track the live timer deadline directly. This is the smallest source-of-truth change and is the
   selected approach.

## Data flow

1. Daemon interval creation records `performance.now() + interval_ms`.
2. An interval callback advances that deadline and queues the normal tick.
3. Poll-now queues the normal tick without advancing the periodic deadline.
4. `GET /projects/:name` reads the deadline and renders its actual remaining duration.

## Testing

A route-level regression test will simulate a just-completed manual poll while the periodic timer
has one minute remaining in a ten-minute interval. The returned Project detail HTML must show
`next poll` in one minute, proving the ETA comes from the timer rather than the last poll timestamp.

