# Service-level Routine fan-out and grouped summaries

Status: Accepted

**Amendment note (issue #424):** the Project cascade applies only to current Routine Targets. A
target already disabled with `removed_from_config` is durable declaration history and retains that
state and reason across a later Project disable or removal.

Superseded in part by ADR 0084, which makes provider-blocked targets `held`, summary-terminal, and
still claimable instead of leaving them `pending` as a readiness gate.

## Context

ADR 0063 moved Routine declarations from Projects into the Service Config, but deliberately kept
the temporary single-target shape `project: <name>`. The motivating `refactor-audit` Routine has one
prompt and one schedule for seven repositories. Repeating the declaration obscures its blast radius,
allows declarations to drift, and cannot produce the single grouped result expected by ptt.

The persisted Routine key is `(project_name, name)`. Its schedule, skip counters, and lifecycle
state are naturally per Project. Replacing it with a project-plural row would require rewriting
reconciliation and would conflict with the per-Project concurrency and skip-accounting decisions in
ADRs 0053 and 0058.

Fan-out also introduces a completion problem: per-target admission can skip one Project while other
targets run, and daemon restarts can interrupt either provider execution or summary delivery.

## Decision

### Declaration shape and validation

Routines remain service-level declarations. Every entry has a path and an explicit, non-empty list
of target Project names:

```yaml
routines:
  - path: ./routines/refactor-audit.md
    projects: [s11, rightkey, petovita, jsse, vow, forseti, pewpew]
```

The declaration file remains portable: its front matter contains the name, prompt schedule, kind,
provider override, and lifecycle controls, but no Project names.

The following rules apply:

- every target resolves to a declared Dispatch Project or Routine Host;
- a target cannot appear twice in one list;
- there is no `projects: all` wildcard, so adding a Project never expands a Routine implicitly;
- Routine names are globally unique across the entire Service Config, even when paths differ;
- nested Project `routines:` remains a validation error; and
- ADR 0063's temporary singular `project:` form is removed and produces a migration error pointing
  to `projects: [<name>, ...]`.

`add-routine --project X` keeps its command-line meaning by creating a service-level declaration
whose target list is exactly `[X]`. The config editor checks names service-wide.

### One declaration materializes N Routine Targets

The `(project_name, name)` primary key is retained. A declaration targeting N Projects is loaded
once and materializes N **Routine Target** rows, each carrying that Project's next-fire state and
skip evidence. The globally unique Routine name groups those rows for operator surfaces.

Routine reconciliation consumes the complete service-level set of `(Project, Routine)` pairs:

- `disabled: true` or removing the declaration soft-disables every materialized target row;
- removing one Project from `projects:` soft-disables only that row with
  `disabled_reason = "removed_from_config"`;
- disabling or removing a targeted Project marks its current target row `inactive` under ADR 0021,
  while a row already removed from the declaration retains `removed_from_config`; and
- sibling target rows remain independently active and continue firing.

In-flight firings continue under ADR 0060. `pruneRoutinesForUnknownProjects` remains a
Project-membership cleanup operation and `markRoutinesInactiveForProject` remains a per-Project
cascade; both preserve targets already recorded as removed declaration history.

### Durable Routine Fan-out

Each matched clock event creates one durable **Routine Fan-out**, uniquely identified by
`(routine_name, scheduled_at)` and a generated correlation id. Its expected Project membership is
stored before any provider starts. Every admitted Routine Firing carries that id; a skipped target
is recorded directly on the fan-out without creating a firing row.

Expected membership is immutable after creation. A re-entrant reload can configure a new one-shot
Routine Target whose elapsed `at` value matches an existing fan-out, but that target does not join
the clock event after work has begun. Its elapsed occurrence records an ungrouped
`catch_up_window` skip and expires. A newly configured recurring target naturally begins at its
next future clock event. This preserves one summary per correlation id instead of reopening a
`sending` or `sent` fan-out and relying on a sink to interpret a duplicate as an amendment.

Admission is per target, not atomic. Each leg independently contends for the Project and global
capacity defined by ADR 0053. Admitted siblings start concurrently. A global cap can therefore
produce a normal partial group: admitted targets run, while capped or overlapping targets are
marked skipped and advance only their own schedule and ADR 0058 counters. Skipping a one-shot target
consumes that target's matched clock event and expires it.

The existing workspace and branch identities already contain the Project and firing id, so sibling
firings receive separate workspaces, branches, logs, and prompt evidence.

### Group completion and notification

A fan-out becomes summary-ready only after every expected target is either:

- skipped for overlap or a concurrency cap, or settled as `target_unavailable` when a pending leg's
  declaration or Project is disabled or removed during restart reconciliation; or
- associated with a terminal (`succeeded`, `failed`, or `cancelled`) firing.

The grouped subject is shaped as
`[ptt] <routine> — <PR count> PR, <issue count> issue, <failure count> failed`. Its payload retains
the per-Project disposition and firing result. Skips are visible per Project but do not count as
failures. Failed and cancelled firings do. Verified issue actions can increase the issue count when
the structured-outcome slice supplies them; until then it is zero.

Delivery uses a durable `pending -> sending -> sent` claim around a service-provided notification
sink. A failed send returns to `pending` with its error for retry. Startup releases an interrupted
`sending` claim. Orphan-firing reconciliation makes provider work lost in a restart terminal, while
fan-out reconciliation settles a never-claimed leg whose target is no longer schedulable, so the
group can eventually finish. A crash after an external server accepts a notification but before the
local `sent` marker may duplicate it; exactly-once external delivery requires an idempotent sink.

There is no independent partial-summary deadline. The summary waits for all admitted firings.
Firing timeouts bound live provider work, and startup reconciliation bounds work interrupted by a
daemon restart. Sending early would omit a result that is still legitimately running.

## Consequences

- One declaration can safely express `refactor-audit` across seven explicit Projects while
  preserving per-Project lifecycle and concurrency evidence.
- Partial admission is visible and expected rather than blocking an entire group.
- A restart preserves both group membership and pending delivery.
- Operator listings group Routine Targets by the globally unique Routine name; project filters
  still expose a single target.
- The fan-out tables and nullable firing correlation column are additive, so existing single-target
  history remains readable.
- This ADR supersedes ADR 0063's single-target form and its prospective wildcard wording. It
  supersedes only ADR 0060's old description of where a declaration is removed; ADR 0060's
  soft-disable and in-flight semantics remain unchanged.
