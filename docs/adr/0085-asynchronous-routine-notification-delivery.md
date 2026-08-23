# Asynchronous Routine Notification Delivery and Shutdown Drain

Status: Accepted

## Context

ADR 0067 moved terminal Routine Firing notification delivery below the active-run unregister step,
so SMTP no longer consumed Project or global concurrency. The delivery promise still remained in
`dispatchDueRoutines`'s awaited firing task, however, and ADR 0072's ready Routine Fan-out loop also
awaited SMTP before dispatch returned. A relay consuming the 30-second delivery deadline could
therefore delay subsequent orchestration even though provider work was terminal and its slot was
free.

Detaching those promises without lifecycle ownership would create the opposite failure: graceful
daemon shutdown could close SQLite while an SMTP attempt or its delivery-evidence write was still in
flight.

## Decision

The daemon owns one `NotificationDeliveryTracker` for routine notification work. Its small interface
enqueues a best-effort asynchronous task and settles all tracked tasks. It contains unexpected task
rejections so background delivery never becomes an unhandled rejection; source-specific delivery
code continues to persist and log expected SMTP failures.

After a Routine Firing is terminal and its active-run slot is unregistered, scheduled and manual
firing paths enqueue per-firing delivery in the tracker. `dispatchDueRoutines` enqueues the ready
Routine Fan-out delivery pass after all admitted provider work is terminal. Neither SMTP path is part
of the promise routine dispatch awaits. The fan-out pass retains ADR 0072's durable claim and
per-pass config-resolution behavior inside its background task.

Graceful shutdown preserves producer-before-consumer ordering:

1. close new active-run admission and cancel live provider work;
2. await scheduled work and in-flight dispatches, after which no firing can enqueue another routine
   notification;
3. settle the routine notification tracker; and
4. settle daemon-health notifications before closing the HTTP server and Run Store.

The existing 30-second delivery deadline still bounds the tracked orchestration task. A Notification
Sink has no cancellation interface, so an underlying transport operation may continue after that
deadline exactly as ADR 0067 already documents; its durable outcome is the deadline failure.

Issue Run digests remain outside this tracker. Their pending rows are deliberately restart-delivered
under ADR 0071, while this decision addresses SMTP work already started by routine dispatch. Daemon
health retains its existing in-flight set and `settled()` drain.

## Consequences

- A slow or failing SMTP relay no longer holds routine dispatch or later issue orchestration open.
- Per-firing and fan-out outcomes are persisted after dispatch returns without changing Routine
  Firing lifecycle state.
- Graceful shutdown waits for started routine notification work, up to the existing delivery
  deadline, before SQLite closes.
- Direct dispatcher embedders that configure notifications must provide a tracker and own its drain;
  the production daemon provides the canonical lifecycle.
- Crash recovery is unchanged: this decision drains graceful shutdown but does not add a durable
  worker or persist the report-output payload needed to replay an interrupted per-firing message.
