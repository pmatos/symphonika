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

The receipt timestamp is captured where the provider yields the event, not where the Run Store
writes it. Persisting an event first appends to the raw and normalized evidence logs, so deriving
the timestamp inside the store would time the state root's writes rather than the provider's
transport: a five-minute append would be persisted as a five-minute recovered stall, and slower
writes would inflate every later gap. `receivedAt` is therefore a required input to both Run Store
receipt methods; the store never invents this clock.

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

## Numbering

ADR `0089` was the most recent number in tree when this ADR was written. `0090`-`0092` have since
landed on `main`; duplicate numbers are already the tree's convention (`0087`-`0089` each name more
than one decision), so this ADR keeps `0090`.
