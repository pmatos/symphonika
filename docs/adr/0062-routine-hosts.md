# Routine Hosts: a declared Project mode for firing-only Projects

Status: Accepted

## Context

#289 (ptt parity) needs to declare ~7 Projects (`s11`, `rightkey`, `petovita`, `jsse`,
`vow-lang/vow`, `forseti`, `pewpew`) that exist only to give Routine Firings a repository and a
workspace. They will never see an issue-driven Run. Today every Project must declare `tracker`,
`issue_filters`, `priority`, `workflow`, and have all `sym:*` Operational Labels created in-repo, or
`doctor` is permanently red and reload rejects it.

Grep-verified, the routine path reads almost none of this:

- `src/routines/*` imports `workflow/autonomous-prompt.js` (the preamble) only, never
  `workflow/contract-loading.ts`.
- `prepareRoutineWorkspace` (`src/routines/workspace.ts`) consumes `workspace.root` and
  `workspace.git.{remote,base_branch}`.
- `tracker` is read on the routine path in exactly one place: `discoverRoutinePullRequests`
  (`src/routines/dispatcher.ts`), only for `kind: git` on success, and it already degrades gracefully
  on a missing token (warn + return).
- `issue_filters` and `priority` are consumed solely by issue polling (`src/issue-polling.ts`,
  `src/dispatch.ts`).

So the heavyweight requirements are dead weight for a firing-only Project.

## Decision

### One Project concept with an explicit declared mode

A Project declares `mode: "dispatch" | "routine_host"`. Omitted defaults to `"dispatch"`, so every
existing single-Project config is backward-compatible. The schema branches on `mode` rather than
inferring from the presence or absence of other keys: forgetting to configure a `tracker` must stay a
validation error, not silently become "this Project never dispatches."

- **Dispatch Project** (`mode: "dispatch"` or omitted): today's Project. Requires `tracker`,
  `issue_filters`, `priority`, `workflow`, `workspace`, `agent`. Polled for issues. `doctor` gates
  `validForDispatch` on repo access, all `REQUIRED_OPERATIONAL_LABELS`, and Required Eligibility
  Labels.
- **Routine Host** (`mode: "routine_host"`): requires `name`, `workspace`, `agent`, and `mode`.
  `tracker` is optional — required only when the host targets `kind: git` firings that should get PR
  discovery (see below). `issue_filters`, `priority`, and `workflow` are unused and rejected. Never
  polled for issues.

### `validForDispatch` splits into two questions

`doctor`'s single `validForDispatch` boolean splits:

- `validForDispatch` (unchanged name, Dispatch Projects only): repo access + Operational Labels +
  Required Eligibility Labels + provider command + provider adapter.
- `validForHosting` (Routine Hosts only): provider command + provider adapter registered + workspace
  resolvable. No GitHub access, no label checks.

The overall `DoctorReport.ok` stays `errors.length === 0`; a Routine Host without `sym:*` labels
contributes no errors, so seven hosts plus one Dispatch Project is green.

### `kind: git` on a host without `tracker` is a declaration-time error

A Routine Host hosting a `kind: git` routine must declare `tracker`. Reload and `doctor` reject it
otherwise. This matches "forgetting a tracker must stay a validation error, not silent
non-dispatching": a `kind: git` firing with no tracker cannot get PR discovery, and silently skipping
discovery would hide a misconfiguration. `discoverRoutinePullRequests` keeps its runtime
degrade-on-missing-token guard as defense-in-depth.

### `init-project --mode routine-host`

`symphonika init-project` gains a `--mode <dispatch|routine-host>` flag (default `dispatch`). In
`routine-host` mode it prompts only for project name, provider, base branch, and workspace root; it
skips issue-filter, priority-label, and Operational/Eligibility-label creation entirely.

## Consequences

- Declaring a firing-only Project costs a name, a workspace, an agent, and the mode — nothing else.
- Seven Routine Hosts plus one Dispatch Project coexist in one `symphonika.yml` and `doctor` is green.
- A Project with no `tracker` and no `mode` is a validation error: the default is `dispatch`, which
  requires `tracker`.
- `RunControllerProjectConfig.workflow` becomes optional for Routine Hosts; the routine dispatch path
  never reads it, and issue dispatch never selects a host because hosts are absent from
  `polling.projects`.
