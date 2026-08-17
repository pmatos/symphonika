# Live Notification Path

Status: Accepted

## Context

`#305` asks for live dashboard updates: a Run state transition or Routine Firing transition should
update the page without a reload. Grep-verified: there is no `EventEmitter`, observer, or version
counter anywhere on `RunStore` or the daemon lifecycle today — this slice builds the notification
path from nothing, not wires up an existing one.

Two shapes were on the table:

- **Store emits typed events** at the point of mutation. Precise payloads, no polling; the risk the
  issue names is "touching every mutation site and keeping emission honest as new ones are added."
- **Version counter + diff at the HTTP layer.** Mutations bump a monotonic counter; the SSE loop
  wakes on change and diffs rendered fragments. Fewer call sites, coarser granularity, and a
  built-in fallback if a mutation forgets to bump.

The "touching every mutation site" cost turned out not to apply here. `RunStore` already funnels
essentially every Run/Firing state change through two private methods:

- `recordRunTransition` — called from `insertRunRow` (a new Run's initial state, i.e. the dispatch
  decision), `updateRunState`, and the two stale/failed sweep paths. 5 call sites total.
- `recordRoutineFiringTransition` — called from the Firing insert (`queued`, i.e. its own dispatch
  decision), `updateRoutineFiringState`, `completeRoutineFiring`, and the sweep path. 5 call sites
  total.

Both are already the single place every state write passes through, so instrumenting them gives
precise per-mutation events at close to version-counter cost, without a parallel "did every writer
remember to bump the counter" discipline to maintain. `recordProjectPollOutcome` is the same shape
for poll completion: one method, called once per project per tick from `persistProjectPollState`.

Reload outcome is the one signal that does not live on `RunStore` — it is decided in `daemon.ts`'s
`refreshIssuePollStatus`, the single per-tick call site that already has both the fresh
`RuntimeConfigReloader` snapshot and the `runStore` handle in scope (see the existing comment at
that call site). Rather than give `daemon.ts` its own emitter to construct and thread through
`createHttpApp` — the kind of extra wiring pass `#303`/`#304` paid for `projectModes`/
`getConcurrency`/`startedAtMs` — `RunStore` grows one public forwarding method,
`publishReloadOutcome`, so it stays the single object every subscriber needs a reference to.

The daemon and HTTP server already run in one Node process sharing one `RunStore` instance
(`daemon.ts` constructs `RunStore` and passes it into `createHttpApp`) — so an in-process emitter
needs no cross-process transport, no queue, no polling of the database for changes.

## Decision

### `RunStore` owns a change bus; three existing methods publish to it

`RunStore` gets a `Set<(event: ChangeEvent) => void>` of listeners, a private `publishChange`, and
a public `subscribeToChanges(listener): () => void` (the returned function unsubscribes).
`recordRunTransition`, `recordRoutineFiringTransition`, and `recordProjectPollOutcome` each call
`publishChange` as their last line. `publishReloadOutcome` is a fourth, public entry point called
once per tick from `daemon.ts`.

```ts
export type ChangeEvent =
  | { kind: "run-transition"; runId: string; sequence: number; state: RunState }
  | { kind: "firing-transition"; firingId: string; sequence: number; state: RoutineFiringState }
  | { kind: "project-poll"; projectName: string; ok: boolean; finishedAt: string }
  | { kind: "reload-outcome"; ok: boolean; errors: string[] };
```

A listener that throws (a broken SSE write, most likely) is isolated with a per-listener
`try`/`catch` inside `publishChange` — a state-transition write must never fail because one
subscriber's connection is in a bad state.

### Events are invalidation signals, not a replay log

Payloads carry identity and new state, not a rendered fragment or a full row. No sequence buffer is
kept for replay: a client that misses events while disconnected is not caught up on reconnect. The
client interaction model this commits `#305`'s second half to is: reconnect, then do one reconciling
fragment fetch for what's currently on screen, then trust live events again. This is simpler than
either a full replay buffer or a version-counter diff, and it's honest — an SSE gap is exactly the
kind of staleness `PRODUCT.md` principle 4 says must be visible, not silently patched over by
inferring what was missed.

### Transport: one `GET /events` SSE connection per client

`GET /events` uses Hono's `streamSSE` (`hono/streaming`, already a transitive dependency of the
installed `hono@^4.13.0` — no new package). Each connection calls `runStore.subscribeToChanges`
independently, so concurrent browser tabs are fully independent: no shared cursor, no fan-out
registry to manage. Unsubscribe runs in a `finally` block around the connection's read loop, and
`stream.onAbort` also flips a `done` flag — between the two, a client disconnecting (tab close,
navigation, network drop) always releases its listener; the daemon cannot accumulate dead
subscriptions across a long uptime.

The read loop is an event queue with a wake-up race, not a poll:

```
while connected:
  if queue empty: await race(wake-on-publish, sleep(HEARTBEAT_MS))
  if queue still empty: send a heartbeat comment, continue
  send the next queued event as an SSE message
```

An idle daemon (no Run/Firing/poll/reload activity) sends nothing but a heartbeat every
`SSE_HEARTBEAT_MS` (20s) — fixed, low-frequency keepalive traffic to hold the connection open
through intermediary proxies, not a busy loop. This is unrelated to, and does not add to, the
daemon's existing 30-second poll cadence (ADR 0036).

### What's pushed vs. polled

- Run transitions, Firing transitions, and reload outcomes push the moment they happen — no
  cadence, no delay.
- Project-poll completion also pushes, but only to invalidate the poll-age display the capacity
  strip already renders (`last_poll_finished_at`, `last_poll_ok` — see ADR 0073). It fires at
  whatever cadence `refreshIssuePollStatus` actually runs at (ADR 0036's ~30s tick), which this
  slice does not change. Receiving this event must never be read by the client as "issue eligibility
  changed live" — only the poll-age label is honest to refresh from it.
- `#308`'s GitHub search results are snapshot-backed at that same poll cadence and will reuse this
  same event, not a new one.

### Reconnect and the stream-down banner are client concerns

Backoff-on-reconnect, the "stream is down, here's a manual refresh control" banner, and the
per-fragment DOM patch that must leave an open editor's text and scroll position untouched are
`#305`'s second half (a separate, stacked PR — see Consequences). The server contract they build on
is fixed by this ADR: `GET /events`, the four `ChangeEvent` kinds above, no replay on reconnect, and
independent per-tab subscriptions.

## Consequences

- `RunStore` gains a fourth responsibility (change notification) alongside persistence, but it adds
  four call sites total to already-existing chokepoints, not one per mutation — the risk the
  version-counter alternative was chosen to avoid didn't materialize once the chokepoints were
  checked.
- No delivery guarantee across a disconnect. This is a deliberate trade for a much simpler server
  (no sequence log, no per-client cursor persistence) and is only safe because every event is
  paired with a page that can be re-fetched in full to reconcile — there is no case in this app
  where an event is the only record of something that happened.
- `#305` ships as two stacked PRs: this one (the notification path, the SSE endpoint, degradation
  and leak-safety at the transport level, all independently testable without a browser) and a
  second one (client-side fragment patching, reconnect backoff, the stream-down banner, and the
  editor/scroll-preservation test, which needs a DOM test environment this repo does not carry
  yet). Both are required for `#305`'s acceptance criteria in full; this PR covers the "Run/Firing
  transition pushes", "stream doesn't leak on disconnect", "idle produces no busy-loop traffic",
  and "multiple tabs supported" criteria on the server side.
- A future mutation site that changes user-visible state but isn't one of the four instrumented
  methods will not notify anyone — same class of risk the "store emits events" option always
  carried, just narrowed to four places rather than every `RunStore` method. If a fifth chokepoint
  is needed later (e.g. an editor save in `#307`), add it the same way: a `publishChange` call at
  the one place that state actually changes.
