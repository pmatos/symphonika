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

### Fragments: two named regions, not per-row patches

The dashboard (`/`) is the only page this slice wires up live — the issue's own acceptance criteria
name "the active band and the affected Project row," both dashboard elements. `GET
/fragments/active-band` and `GET /fragments/projects-section` call `renderActiveNowBand` /
`renderProjectsSection` directly (no `layout()` wrapper), fed by one `assembleDashboardData()`
helper `GET /` and both fragment routes share — so a live-update fetch renders from the exact same
inputs a full page load would, not a second hand-maintained assembly.

Fragments are whole named regions, not individual project rows. A `ChangeEvent` deliberately carries
no `projectName` (see above), and refetching a whole section costs one request either way, so
resolving "which row" client-side would only add complexity for no savings. On any of
`run-transition`, `firing-transition`, or `project-poll`, the client refetches and patches both
fragments — simpler than deciding per event-kind which one region actually changed, and cheap enough
that the extra request is not worth optimizing away.

### The patch primitive is `replaceChildren`, not a morph

`patchFragment(id, html)` parses the fetched HTML into a detached container and calls
`element.replaceChildren(...)` with its children — a full swap of the named container's content, no
diffing, no key-matched node reuse. This is deliberately the simplest thing that satisfies the "only
the affected fragment is replaced" acceptance criterion: **today**, neither `active-now-band` nor
`projects-section` contains an editor, a form, or a scrollable subregion — nothing inside either
fragment has state worth preserving across a swap. Building a general focus/selection/scroll-
preserving morph now, with no real element to preserve, would be exactly the kind of Speculative
Generality the Standards review this repo's process runs would flag: machinery for a requirement
with no instance in the codebase yet.

`#307` introduces editors (routine declarations, workflow contracts, service config). If one ever
lands inside a live-patched region, that is where a preservation mechanism belongs — built against a
real element, not a hypothetical one. Until then, "the affected fragment is replaced" is tested as
region-scoped replacement: patching `active-now-band` leaves `projects-section` and everything
outside both containers — including an unrelated `<textarea>` — byte-for-byte untouched. That is
what the test in `tests/dashboard-live-client.test.ts` checks; it does not (and today cannot) check
in-region preservation, because no in-region state exists to preserve.

### Reconnect and the stream-down banner

`EventSource` already reconnects on its own at a fixed retry interval; this slice does not
hand-roll a custom backoff on top of it; there is no evidence yet that the browser's default retry
cadence is a problem for a same-machine, same-process daemon. The client's `error` listener shows a
`#live-stream-banner` ("Live updates disconnected... Refresh"); the `open` listener (fired on first
connect and every successful reconnect) hides it and triggers one reconciling fetch of both
fragments — the client-side counterpart to "no replay on reconnect" above.

### Testability without a build step

The embedded client script (`DASHBOARD_LIVE_CLIENT_JS` / `DASHBOARD_PATCH_FRAGMENT_JS` in
`src/http/pages.ts`) is a plain string constant, matching the existing `WORKFLOW_GRAPH_CLIENT_JS`
precedent (ADR-0056: no build step, no bundled client module) rather than a compiled TypeScript
file — `tsconfig.json` has no `"DOM"` lib entry project-wide, and adding one just for this file
would be a second compilation concern this repo doesn't otherwise have. Both constants are exported
so `tests/dashboard-live-client.test.ts` can evaluate the literal source that ships to the browser
(via `happy-dom`, added as a per-file `// @vitest-environment` pragma — not the global test
environment, so every other test keeps running under plain Node) instead of testing a
reimplementation of it.

## Consequences

- `RunStore` gains a fourth responsibility (change notification) alongside persistence, but it adds
  four call sites total to already-existing chokepoints, not one per mutation — the risk the
  version-counter alternative was chosen to avoid didn't materialize once the chokepoints were
  checked.
- No delivery guarantee across a disconnect. This is a deliberate trade for a much simpler server
  (no sequence log, no per-client cursor persistence) and is only safe because every event is
  paired with a page that can be re-fetched in full to reconcile — there is no case in this app
  where an event is the only record of something that happened.
- `#305` shipped as two stacked PRs: the first (the notification path, the SSE endpoint,
  degradation and leak-safety at the transport level, all independently testable without a
  browser) and this second one (the dashboard's fragment endpoints, the embedded client script,
  reconnect-visible banner, and region-scoped-replacement test, using `happy-dom` added as a
  per-file pragma). Together they satisfy every `#305` acceptance criterion except in-region state
  preservation during a live patch, which has no real instance in the app until `#307` ships an
  editor — see "The patch primitive is `replaceChildren`, not a morph" above.
- Only the dashboard (`/`) got live updates in this slice, matching the acceptance criteria's own
  wording ("the active band and the affected Project row"). `/runs/:id`, `/firings/:id`,
  `/routines/:name`, and `/projects/:name` still require a manual reload to see a transition; wiring
  those up is follow-on work, not part of `#305`'s stated scope.
- A future mutation site that changes user-visible state but isn't one of the four instrumented
  methods will not notify anyone — same class of risk the "store emits events" option always
  carried, just narrowed to four places rather than every `RunStore` method. If a fifth chokepoint
  is needed later (e.g. an editor save in `#307`), add it the same way: a `publishChange` call at
  the one place that state actually changes.
