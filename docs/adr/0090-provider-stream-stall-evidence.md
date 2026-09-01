# Provider stream stalls are observable, recoverable Run evidence

Run `dd2ec509-0b49-407b-bad7-385ff3b7addb` produced no raw provider event for 46 minutes, then
resumed normally. Codex's built-in OpenAI stream uses a five-minute idle timeout and a bounded
reconnect budget, so that gap was compatible with a live provider recovering by itself. The
Run-detail page showed only an old transcript row, making a recovering stream indistinguishable
from a dead process and leading an operator to cancel useful work.

The Watchdog is not the right representation for this condition. Its `idle_since` is derived from
the broader Progress Signal and may legitimately use a Project-specific grace window much longer
than Codex's stream timeout. Turning a stream gap into a Watchdog verdict would also terminate the
very recovery this decision needs to make visible.

## Decision

Symphonika records provider-stream receipt activity separately from normalized provider events.
Every raw event advances one per-attempt `provider_stream_receipts` row containing the Run, Attempt,
raw sequence, and orchestrator receipt timestamp. It is a watermark, not a log: one row per Attempt,
overwritten in place, which is why it is named for the receipt rather than for the events it counts.
A normalized event advances the same row inside the transaction that writes `provider_events`; a
raw-only event advances it without fabricating a Normalized Event Log entry.

The receipt timestamp is captured where the provider's transport queue ingests the event, not where
the Run Store writes it, and — for the Codex and Claude adapters, which share
`jsonl-process-queue.ts` — not merely where the orchestrator's consumer loop happens to resume
either. Persisting an event first appends to the raw and normalized evidence logs, so deriving the
timestamp inside the store would time the state root's writes rather than the provider's transport: a
five-minute append would be persisted as a five-minute recovered stall, and slower writes would
inflate every later gap. `receivedAt` is therefore a required input to both Run Store receipt
methods; the store never invents this clock.

That alone is not sufficient: `RunController.iterateAttempt` only requests the next event from a
provider's async generator after awaiting persistence of the current one, and the shared queue's
`push()` — called synchronously from the child process's stdout/error/close handlers — can already
hold several items in its internal buffer by the time the generator is resumed to hand them off. A
timestamp taken at hand-off time would therefore still be delayed by the previous event's write
latency, one event later than the case above. `push()` is stamped at the moment it runs, which is the
one point in the pipeline genuinely decoupled from consumer speed, and that stamp — not a
consumption-time clock — is threaded through as `ProviderEvent.receivedAt`. It is optional on that
type (unlike the Run Store's own inputs) because `ProviderEvent` is the wide provider→orchestrator
contract every test double also constructs; forcing a transport-receipt timestamp onto adapters and
fakes with no real queue to timestamp would assert something false about them. `persistProviderEvent`
falls back to its own clock only when a `ProviderEvent` carries no queue-sourced stamp.

An accurate `receivedAt` value is still not enough on its own: the live status APIs
(`GET /runs/:id`, `GET /api/runs/:id`) read the receipt watermark from the Run Store, not from
`ProviderEvent`, so the watermark write itself must not lag behind ingestion either. Both Run Store
receipt methods are synchronous SQLite writes that embed the full raw/normalized payload in their own
row — they do not read back from, or otherwise depend on, the JSONL evidence files —
so `persistProviderEvent` now calls them before awaiting the JSONL appends rather than after. The
Watchdog already tails the normalized log independently by its own byte offset (not by watermark
existence), so nothing depends on the JSONL line preceding the Run Store row. One consequence: a
failed append can now leave a Run Store row with no corresponding JSONL line, where the previous
ordering could not. The append is still awaited and its rejection still propagates out of
`iterateAttempt` exactly as before; only the row is no longer implicitly rolled back with it.
Consumption ordering itself — the `for await` still awaits the whole of `persistProviderEvent`,
including the JSONL appends, before requesting the next event — is unchanged by this: pipelining
iterator consumption ahead of persistence was considered and rejected as its own, separate change
(see Alternatives below).

On upgrade, the newest
existing normalized event per Attempt seeds the receipt row, once, on the first open that finds the
table empty. Raw-only activity from before this evidence existed cannot be reconstructed.

A running Attempt whose latest raw receipt is at least five minutes old is surfaced as **stream
stalled, provider retrying**. When no event has arrived yet, the Attempt creation time is the gap
origin while the last-event value remains explicitly `none`. This state is observational only: it
does not mutate the Run, reset or replace the Watchdog, cancel the provider, or affect retry and
terminal classification. The fixed five-minute threshold matches Codex's built-in stream idle
timeout. It is intentionally not configuration yet because it has no control effect; recovered-gap
evidence will provide the distribution needed to justify later tuning.

The next raw event clears the current state. When the gap met the threshold, that same receipt
transaction appends one `provider_stream_stalls` evidence row with the gap start, the prior and
resuming raw sequences, the receipt time, and the measured duration.

Only a gap between two receipts becomes evidence. The wait before an Attempt's first receipt is
workspace preparation, prompt assembly, and provider startup — not transport silence — so recording
it would corrupt the duration distribution this evidence exists to produce. That window is still
surfaced as stalled, measured from the Attempt's creation time, because an operator cannot tell a
slow start from a dead process either; it simply is not durable stall evidence. Gaps never span
Attempts, so retry preparation or backoff is not misclassified as a provider-stream stall.

`GET /runs/:id` always renders a Provider stream section with time since the current Attempt's last
raw event (or `none`), the threshold, the active retrying banner when applicable, and recovered
stall count. `GET /api/runs/:id` exposes the same current status and the recovered stall records so
operators can measure duration distributions without parsing logs.

## Consequences

- A page read stays read-only. Current stalls are derived from durable receipt evidence; recovered
  stalls are written only when provider activity actually resumes.
- Unknown provider messages remain in the Provider Event Log without polluting the Normalized Event
  Log, while still proving that the transport delivered something.
- The label is provider-neutral and may conservatively describe a legitimately quiet provider as
  retrying. Because it is non-terminal and paired with the exact last-event age, this false-positive
  cost is limited to presentation rather than lost work.
- Existing Normalized Event Log evidence seeds last-receipt state after upgrade, but historical
  recovered durations are not synthesized from normalized rows because raw-only receipts were not
  previously durable.
- The original queue-ingestion `receivedAt` fix covered the Codex and Claude adapters through their
  shared `jsonl-process-queue.ts`. Follow-up #638 closes the deferred OMP gap: its structurally
  similar but more complex `createProcessQueue` now stamps items in `push()` and threads that stamp
  through OMP frame mapping while preserving its independent backpressure and frame-reassembly
  behavior. When OMP's backpressure gate is holding buffered bytes back, those bytes are only parsed
  and pushed once the queue drains below the low-water mark, so the stamp for that data reflects
  drain time rather than transport-arrival time; this is bounded by the same backpressure thresholds
  and does not reintroduce the unbounded consumption-time gap this ADR describes.

## Interaction with existing decisions

ADR `0088` (retryable provider errors are liveness) established that a provider recovering from its
own transport failure is evidence the Run is alive rather than evidence it is broken. A stream stall
is the silent form of the same condition: the provider is retrying but says nothing while it does.
This decision extends that reading to the case where there is no error to observe at all.

ADRs `0086` (output-token convergence budget) and `0089` (Run wall-clock cap) own the verdicts that
can end a Run. This decision deliberately adds none. Provider stream state is rendered beside those
verdicts and never feeds them, which is why the threshold here can be much shorter than any Watchdog
grace window without shortening a Run's life.

ADR `0087` (Watchdog provider progress markers) decides what counts as a Progress Signal. Raw
receipt activity is not added to that set: a keep-alive frame proves the transport is up, not that
the Coding Agent is making progress.

Both surfaces freeze their ages on a terminal Run rather than drifting against a Run that stopped
moving, but they freeze on different clocks because they rest on different evidence. The Watchdog
freezes on its own latest sample (`resolveWatchdogNowMs`). Provider stream cannot: sampling stops
the moment a Run leaves `running`, so the Attempt's final `process_exit` normally arrives after the
last sample, and that sample would describe the Run's own last event as arriving "in 5m". The
provider-stream clock (`resolveProviderStreamNowMs`) freezes on the terminal transition instead,
floored at the latest receipt.

## Alternatives considered

**Use the latest `provider_events.created_at`.** Rejected because `provider_events` contains only
normalized events. A raw notification the normalizer deliberately ignores would leave the page
claiming the stream was silent.

**Write a synthetic normalized `stream_stall` event.** Rejected because silence emits no event and
a read path must not manufacture evidence. It would also conflate an observation derived by the
orchestrator with provider output.

**Terminate after the five-minute gap.** Rejected. The motivating Run recovered after 46 minutes;
termination would turn normal provider retry behavior into data loss.

**Pipeline `iterateAttempt` so the next iterator item is requested before `persistProviderEvent`
resolves.** Rejected as the fix for late `receivedAt` values: capturing the clock only where the
`for await` loop resumes is still gated on the previous event's persistence finishing, so a naive
one-item lookahead does not actually move the timestamp earlier — it changes when the *next* item is
fetched, not when the *current* one is stamped. It would also change `iterateAttempt`'s fast-fail
behavior on a persistence error (today, a thrown write error stops iteration and the generator's
`finally` tears down the provider process promptly; decoupled consumption would keep pulling and
discarding further events until the stream itself ends) for a benefit the queue-ingestion timestamp
already provides. `push()`-time stamping (see Decision) gets the same accuracy without touching
consumption ordering or fast-fail semantics.

## Numbering

ADR `0089` was the most recent number in tree when this ADR was written. `0090`-`0092` have since
landed on `main`; duplicate numbers are already the tree's convention (`0087`-`0089` each name more
than one decision), so this ADR keeps `0090`.
