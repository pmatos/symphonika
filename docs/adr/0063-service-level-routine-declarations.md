# Service-level Routine declarations (forward-pulled from #295)

Status: Accepted

## Context

#290's acceptance requires a Routine Host to "host Routine Firings targeted at it by a service-level
Routine." Until now Routines are declared per-Project (`project.routines: [paths]`), which assumes
the Project owns the routine. A Routine Host owns no routines — Routines point *at* it. #295 will
move Routines to a service-level block with fan-out; #290 needs the service-level placement now to
validate the Routine Host mode end-to-end, without #295's fan-out complexity.

## Decision

### Top-level `routines:` block

`symphonika.yml` gains a top-level `routines:` sequence. Each entry is an object with a required
`project: <name>` target naming a declared Project (Dispatch Project or Routine Host) and a `path:`
pointing at the same Markdown-with-front-matter routine file as before. The per-Project `routines:`
key is **removed** (breaking config change).

```yaml
routines:
  - project: refactor-audit-host-s11
    path: ./routines/refactor-audit.md
  - project: new-composer-host
    path: ./routines/new-composer.md
```

### Single target, no fan-out

Each routine declares exactly one `project:` target. Fan-out (one routine to N projects, a
`projects: all` wildcard, grouped summaries) is #295's headline and stays there. #295 will generalize
`project: <name>` to `projects: [<list>]`; the single-target form is the precursor it extends.

### Globally unique routine names

Routine names were unique per-Project; they are now globally unique across the `routines:` block. The
`routines` table primary key `(project_name, name)` is unchanged — `project_name` now comes from the
routine's `project:` target rather than an enclosing Project block. ADR 0058's skip counters keyed
`(project_name, routine_name, reason, skipped_at)` are unaffected.

### `syncRoutines` and `RoutineConfigEditor`

`RunStore.syncRoutines` moves from per-Project `(projectName, routines[])` to a single `(routines[])`
call where each routine carries its own target `project_name`. `RoutineConfigEditor.addRoutine` writes
the top-level `routines:` block instead of `project.routines:`.

### ADR 0021 disable cascade

A Routine's target Project being disabled or omitted from the current valid Service Config snapshot
continues to cascade the Routine to `state = 'inactive'` exactly as before — the Routine points at a
Project name, and that name's absence or `disabled: true` drives the cascade. The mechanism is
unchanged; only the source of the `project_name` moves from the enclosing block to the routine's
`project:` field.

### Supersedes ADR 0060's per-Project removal wording

ADR 0060 describes removal detection as "removing a Routine's path from a still-enabled Project's
`routines:` list." That wording predates this slice's removal of the per-Project `routines:` key.
ADR 0060 is preserved as historical; its removal-detection *behavior* (soft-disable with
`disabled_reason = 'removed_from_config'`, in-flight firing continues) is unchanged — only the
*source* of the declaration moved from a Project's `routines:` list to the top-level `routines:`
block. Read 0060's "Project's `routines:` list" as "top-level `routines:` block entry targeting
that Project."

## Consequences

- Routines are service-level objects pointing at declared Projects; a Routine Host can be targeted by
  name, satisfying #290's acceptance.
- The per-Project `routines:` key is gone; existing configs must move routine entries to the
  top-level block.
- #295 extends this with fan-out (`projects: [<list>]`, wildcards, grouped summaries) without
  re-introducing per-Project declarations.
