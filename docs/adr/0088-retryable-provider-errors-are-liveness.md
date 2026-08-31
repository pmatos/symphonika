# Retryable app-server errors are liveness, not termination

The Codex provider mapped **every** `method === "error"` notification to a normalized
`turn_failed`. `isTerminalFailure` treats `turn_failed` as terminal, so the adapter called
`shutdownProviderProcess` and the attempt ended.

Codex does not use `error` only for terminal conditions. It also reports a transient stream drop
it intends to recover from itself, flagged with a `willRetry` boolean:

```json
{"method":"error","params":{"error":{"message":"Reconnecting... 2/5",
  "codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}},
  "additionalDetails":"request timed out"},
  "willRetry":true,"threadId":"...","turnId":"..."}}
```

`willRetry` was read nowhere under `src/`. Symphonika killed codex at the exact moment codex was
telling it the run was still alive, inside codex's own
`stream_idle_timeout_ms x stream_max_retries` budget. That also defeats the long
`watchdog.grace_minutes` operators configure precisely for this case — the vow project sets 180
minutes so a stalled-then-recovering stream survives, and the provider shut down long before the
Watchdog ever got a say.

Run `3d825fbb-9f34-4f70-bb9b-f5fb2dd6bc18` (vow issue #1124, `implement` stage) is the evidence.
Its entire Normalized Event Log is three events and no work at all:

```
{"type":"session_started","threadId":"01a05614-c23b-7631-b4e2-c89790da5597",...}
{"type":"turn_failed","message":"Reconnecting... 2/5","turnId":"01a05618-...",...}
{"type":"process_exit","cancelled":false,"exitCode":0,"signal":null}
```

The turn started at 04:33Z and produced zero items; the reconnect arrived at 05:32Z and the
process was shut down immediately. Every `turn_failed` in the store whose raw notification carries
`"willRetry":true` — six across vow, symphonika, jsse and s11 — ended its Run. Rare, but it lands
on long implementation stages, which is where the most work is lost.

## Decision

An `error` notification with `willRetry: true` normalizes to a **`progress` event carrying
`signal: "stream_retry"`**, not to `turn_failed`. Every other `error` notification — `willRetry`
false, or absent — stays terminal. The conservative default is deliberate: a flag Symphonika does
not understand must not silently keep a dead turn alive.

The distinction lives in the **event type**, not at a call site. `isTerminalFailure` is consulted
from two places (the streaming loop and `readUntilResponse`, which carries its own inline copy of
the terminal list), so a call-site-local exception would have to be written twice and would drift.
A non-terminal type is correct at both by construction.

`progress` is the right existing type rather than a new one. ADR 0087 defined it as a timestamped
liveness marker and the Watchdog already samples it into `last_progress_at`, where an advance
counts as progress under the ADR 0054 any-of rule. A reconnecting stream *is* a live run, so it
should read as activity rather than silence — which is what the issue reporting this asked for.

### This marker carries its message

ADR 0087's markers are deliberately payload-free: their content (a build transcript, a workspace
diff) is bulk that already sits verbatim in the raw log. A reconnect message is the opposite — one
short line, and the only human-readable explanation of a minutes-long gap in the stream. It is
carried in `message`, which both the status dashboard and the web transcript already prefer over
the generic rendering, so an operator reading either surface sees `Reconnecting... 2/5` instead of
an unexplained pause.

### The marker is not rate-limited

ADR 0087 throttles progress markers to one per five seconds because an unthrottled
`outputDelta` mapping would move an entire build transcript into `provider_events`. Reconnects are
bounded by codex's own retry budget — single digits per turn — so the throttle protects nothing
here and could suppress the one event that explains the gap. The retry marker is emitted directly
and does not touch the throttle's clock, so it cannot suppress a later command-output marker
either.

## Consequences

- Termination for a retryable stream drop is left to the controls designed for it: codex's retry
  budget, which ends in a `willRetry: false` error or a failed `turn/completed` once exhausted, and
  then the Watchdog's grace.
- A reconnect now costs a Normalized Event Log line and a `provider_events` row it previously did
  not. At single digits per turn this is negligible, and it buys an auditable record of an
  infrastructure blip that was previously indistinguishable from a model failure.
- Each reconnect advances `last_progress_at`, extending the Watchdog's idle clock. The extension is
  bounded by `stream_max_retries x stream_idle_timeout_ms`, and ADR 0086's convergence budget is
  checked before the liveness clock and independently of it, so a non-converging Run cannot be kept
  alive this way.
- Claude and Oh My Pi are unaffected; neither emits an equivalent notification.

## Interaction with existing decisions

- **ADR 0087 (progress markers):** extended. The signal vocabulary gains `stream_retry`, and this
  ADR records the two respects in which it differs from the original two signals — it carries a
  message, and it is not throttled.
- **ADR 0054 (progress liveness):** unchanged as a rule; `stream_retry` feeds the existing sixth
  signal.
- **ADR 0086 (convergence budget):** unaffected, and is what bounds the consequence above.
- **ADR 0003 (raw and normalized events):** upheld — the raw notification stays verbatim in the raw
  log and only a projection is normalized.

## Alternatives considered

**Keep `turn_failed` but skip the shutdown for retryable errors.** Rejected. `turn_failed` is read
by `classifyFailure`, the Routine dispatcher's parallel ladder, and `getLastFailureEvent` (which
renders the Run page's outcome banner). A `turn_failed` that did not fail the turn would be wrong
at all three, and the streaming loop's inline terminal list would need the same exception as
`isTerminalFailure`.

**A dedicated `provider_retry` event type.** Honest, but it would have to be added to the union,
to the Watchdog's progress bucket, and to the dashboard and transcript renderers just to reproduce
what `progress` already does. The one thing it would buy — distinguishing a retry from real work
on the run page — is already served by the `signal` field.

**Raise `watchdog.grace_minutes` further.** No effect. The provider shut the process down itself;
the Watchdog never saw the run.

## Numbering

ADR `0087` is the most recent number in tree; this ADR is `0088`.
