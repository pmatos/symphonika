# Routine catch-up, overlap, and skip accounting

Recurring Routines need explicit policy for daemon outages and long-running prior firings. A clock
match that cannot launch must also remain visible to operators without being confused with a
Routine Firing.

## Decision

Routine declarations accept two optional top-level fields:

```yaml
catch_up: fire_once_if_missed
allow_overlap: true
```

Omitting `catch_up` skips clock events missed while the daemon was offline. Opting in preserves one
due event on startup and launches at most one catch-up firing, then advances `next_fire_at` strictly
beyond the current clock even when several events were missed. Omitting `allow_overlap` skips a due
event while an earlier firing of the same Routine is non-terminal. Opting in bypasses only the
same-Routine overlap gate; global and per-Project concurrency caps still apply.

The three policy skip reasons are `catch_up_window`, `overlap`, and `concurrency_cap`. A skip:

- creates no `routine_firings` row;
- atomically advances or expires the matched clock event;
- updates `last_attempted_at`, `last_skip_reason`, and `last_skip_at` on the Routine;
- increments an exact-timestamp row in `routine_skip_counts`; and
- emits `routine.skipped` with `reason`, `routine`, and `scheduled_at`.

`routine_skip_counts` is counter evidence, not a firing/event lifecycle. Status readers sum rows in
the exact trailing 24-hour interval and return zero for reasons with no samples. Keeping timestamps
allows an accurate rolling window without turning a skipped clock match into a Routine Firing.

## Consequences

- Restart catch-up cannot create a thundering herd; one Routine launches at most once per restart.
- Overlap and cap skips never replay retroactively because their matched clock event advances.
- Operators see the latest skip and per-reason pressure in the CLI, dashboards, and
  `GET /api/routines`.
- Skip counter evidence grows with skipped clock attempts and can be compacted by a later retention
  policy without changing Routine Firing semantics.
