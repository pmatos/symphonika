# Codex plans are first-class normalized state

Codex app-server emits two kinds of activity that the Symphonika adapter previously discarded:
`turn/plan/updated`, which carries the Coding Agent's current ordered checklist, and
`item/commandExecution/terminalInteraction`, which proves that a running command is still being
interacted with. Long healthy Runs can otherwise look indistinguishable from wedged Runs between
tool calls.

Symphonika normalizes `turn/plan/updated` as a first-class `plan_updated` event. Its compact payload
contains the optional explanation plus ordered `{ step, status }` entries. Codex's `inProgress`
wire value becomes provider-neutral `in_progress`; `pending` and `completed` retain their spelling,
and an unrecognized future value becomes `unknown`. The Run-detail page reads the latest plan from
the newest attempt independently of its bounded transcript tail and renders it as a checklist.

`item/commandExecution/terminalInteraction` instead becomes the payload-free `progress` marker
`signal: "terminal_interaction"`. Process ids and terminal input remain only in the Provider Event
Log. This follows ADR 0087's projection and shares its per-attempt five-second rate limit across all
Codex progress-marker sources, avoiding duplicate raw payloads in the Normalized Event Log and Run
Store.

The Watchdog's existing `last_progress_at` aggregate advances for either a payload-free `progress`
marker or `plan_updated`. A plan is deliberately not reduced to a payload-free marker: its content
is the operator-facing progress summary this change exists to expose. Both new Codex signals now
reset the no-progress clock.

Claude's stream-json adapter has no equivalent provider-native plan notification being dropped in
this slice. Claude plan/todo tool activity arrives as ordinary `tool_use` content and already
normalizes to `tool_call`; inferring a structured Run Plan from a provider-specific tool name would
be a separate semantic decision.

This extends ADR 0003's normalized-event boundary and ADR 0087's progress-marker sources without
changing their raw-evidence or rate-limiting rules.

## Numbering

ADR `0095` is the most recent number on the rebased base; this ADR is `0096`.
