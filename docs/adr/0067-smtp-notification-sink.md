# SMTP Notification Sink for Routine Firings

Status: Accepted

## Context

Routine Firings already persist provider evidence and terminal state, but a `kind: report` firing has
no delivery path. The first required transport is SMTP (including Postmark over STARTTLS), while
later work will notify on terminal issue Runs and daemon-health events. SMTP credentials must follow
ADR 0014: durable configuration names an environment variable and never stores its value.

## Decision

### A provider-neutral sink with an SMTP adapter

`NotificationSink` accepts a rendered `NotificationMessage` containing a subject, plain-text body,
and HTML alternative. Event-specific code owns policy and rendering; the SMTP adapter owns transport
and credential resolution. This keeps SMTP details out of Routine dispatch and lets later issue-Run
or daemon-health renderers use the same sink without introducing an event bus or multi-sink registry
in this slice.

The HTML renderer supports only headings, bold, italic, unordered lists, and paragraphs. It escapes
every interpolated value before applying that subset. Titles, report output, terminal reasons,
branches, and other agent- or tracker-adjacent strings therefore cannot inject live markup.

### Service-level configuration and a Routine opt-out

The optional top-level `email:` Service Config block owns one delivery policy and SMTP endpoint for
the daemon. Projects cannot override it. Routine front matter may set `notify: false`; omission
defaults to enabled. This matches the operational model of one daemon-owned mailbox while preserving
the ptt master switch for Routines that deliver their own output.

`on` has these Routine Firing meanings:

- `always`: deliver every terminal Routine Firing, including cancellation.
- `changes`: deliver a `kind: report` firing when its non-thinking provider message output is
  non-empty; deliver a `kind: git` firing when it succeeds, because git success already requires at
  least one commit ahead of base.
- `failures`: deliver only `state = failed`. Operator and daemon cancellation are not failures.

Policy is evaluated after terminal classification and after `kind: git` pull-request discovery, so
the message can include final state, terminal reason, duration, branch, and discovered PR numbers.
This slice does not notify on issue Runs, Routine Skips, or daemon health.

### Secret boundary

`smtp_password_env` stores only an environment-variable name (default
`SYMPHONIKA_SMTP_PASSWORD`). The SMTP adapter resolves that variable immediately before delivery.
The password is passed only as SMTP authentication input. It is excluded from rendered messages,
SQLite, and logs; transport errors are redacted before they reach durable evidence or logging.

`smtp_security: none` with `smtp_username` is rejected unless `smtp_host` is `localhost`,
`127.0.0.1`, or `::1`. Default ports are 587 for `starttls`, 465 for `ssl`, and 25 for `none`.

### Failure policy and visibility

Delivery gets up to two attempts (one retry) bounded by a per-attempt timeout (`deliverWithTimeout`,
default 15s). A definite (already-settled) failure is retried once; a timeout is not retried, because
the underlying send is not cancelled and may still complete after the timeout fires — retrying it
would race a second delivery against a still-live first attempt and risk sending a duplicate
notification. Exhaustion never changes the Routine Firing's terminal state. Instead,
`routine_firings.notification_state` records `sent`, `skipped`, or `failed`, and `notification_error`
stores the final sanitized error for a failure. These fields are returned by the Routine Firing API
and are durable across restart.

`doctor` validates configuration and reports a missing configured password variable with a manual
env-file loading hint. It does not inspect historical delivery outcomes. The dashboard does not yet
list individual Routine Firings, so delivery history remains on
`GET /api/routines/:id/firings` in this slice; adding a dashboard firing-detail view can consume the
same fields without a schema change.

`symphonika test-email` renders a representative fake Routine Firing and uses the same policy,
renderer, retry, and SMTP sink path, forcing `always` only for the test so restrictive production
policy does not suppress verification. It reports the configured recipient on success or the final
sanitized transport error on failure.

## Consequences

- Routine email is best-effort and cannot turn successful provider work into a failed firing.
- Operators can distinguish policy/opt-out skips from delivered and failed email through durable
  firing evidence.
- Service Config reload applies SMTP changes to future deliveries while in-flight provider work
  continues.
- Supporting another event source requires a renderer and policy decision, not a second SMTP
  implementation.
- Supporting another transport or multiple simultaneous sinks remains future work.
