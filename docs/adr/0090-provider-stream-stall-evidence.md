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
Every raw event advances one per-attempt `provider_stream_events` row containing the Run, Attempt,
raw sequence, and orchestrator receipt timestamp. A normalized event advances the same row inside
the transaction that writes `provider_events`; a raw-only event advances it without fabricating a
Normalized Event Log entry. On upgrade, the newest existing normalized event per Attempt seeds the
receipt row. Raw-only activity from before this evidence existed cannot be reconstructed.

A running Attempt whose latest raw receipt is at least five minutes old is surfaced as **stream
stalled, provider retrying**. When no event has arrived yet, the Attempt creation time is the gap
origin while the last-event value remains explicitly `none`. This state is observational only: it
does not mutate the Run, reset or replace the Watchdog, cancel the provider, or affect retry and
terminal classification. The fixed five-minute threshold matches Codex's built-in stream idle
timeout. It is intentionally not configuration yet because it has no control effect; recovered-gap
evidence will provide the distribution needed to justify later tuning.

The next raw event clears the current state. When the gap met the threshold, that same receipt
transaction appends one `provider_stream_stalls` evidence row with the gap start, nullable prior raw
sequence, the resuming sequence and receipt time, and the measured duration. A null prior sequence
means the Attempt was already quiet from creation until its first event. Gaps never span Attempts,
so retry preparation or backoff is not misclassified as a provider-stream stall.

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

ADR `0089` is the most recent number in tree; this ADR is `0090`.
