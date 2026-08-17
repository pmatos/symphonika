# Config Editors: Routine Declarations, Workflow Contracts, Service Config

Status: Accepted

## Context

`#307` asks for three editors on top of `#306`'s save pipeline: routine declarations, workflow
contracts, and the service config itself. All three are hand-authored YAML/Markdown files with
comments and ordering an operator cares about — a generated-form round-trip would reformat them,
so the issue's own posture is raw text editing with server-side validation, not a form. Where
structured editing genuinely helps (toggling `disabled`, changing a schedule), it is a targeted
surgical edit in the manner `RoutineConfigEditor` (`src/routines/config-editor.ts`) already uses
the `yaml` document API — never the whole-file textarea path.

This ADR is filled in part by part, the same way `#305`/`#306` extended ADR-0074/ADR-0075 across
their PRs, rather than written once ahead of the work.

## Decision

### Diff before write: a two-phase POST, not a client-side preview

Every save shows a diff against on-disk content before anything is written (`#307` AC). The three
editors share one shape: `GET .../edit` renders the raw content plus a hash captured at open time;
`POST .../edit/preview` re-validates the submitted content and, if valid, renders a diff against
the *current* on-disk content (not the content captured at open — a concurrent change since then
is exactly what the stale-write check exists to catch, and the diff should show what the operator
is actually about to overwrite); `POST .../edit/confirm` is the only route that calls
`runSavePipeline`. The original open-time hash travels through both POSTs as a hidden field,
unchanged — recomputing it at the confirm step would silently defeat the stale-write check, since a
concurrent write landing between preview and confirm would then compare as fresh.

Preview is a POST, not GET-with-query-string, because the content can be arbitrarily large and
`GET` request URLs are the wrong place for it. It still passes through the same
`requireAuthorizedMutation` (CSRF/origin) gate the confirm step uses, even though it writes
nothing: it does meaningful server-side work (parse + validate) against caller-supplied content,
and there's no reason a foreign origin should reach that either.

### The diff renderer is a hand-rolled LCS, not a dependency

`renderLineDiff` (`src/http/pages.ts`) is a straightforward O(n·m) longest-common-subsequence line
diff, not a library. The two inputs are always already-in-memory strings — a routine declaration,
workflow contract, or service config, never a multi-megabyte file — so the quadratic table is
never a real cost, and pulling in a diff dependency for three call sites would be the wrong trade.

### Located errors: line/column only where the parser actually gives it

The issue text asks for errors that "locate themselves (line/column where the parser gives it)
rather than dumping a stringified error" — a conditional requirement, not a blanket one. Two
distinct error sources exist per editor, and only one carries a position:

- A YAML **syntax** error (`parse()` throwing) carries `linePos` in the `yaml` package (`^2.9.0`).
  `locatedYamlErrorMessage` (`src/yaml-errors.ts`) appends `(line N, column N)` when present,
  parameterized by a caller-supplied line offset — `parseRoutineDeclaration`'s front matter is
  parsed from a substring starting at the file's own line 2 (line 1 is the opening `---`), so a
  position reported against that substring needs +1 added back to point at the real file line.
  Shared rather than duplicated per editor: `contract-loading.ts` and `reload.ts` both parse YAML
  through the same `parse()` and will reuse this module as their own editors land.
- A **semantic** validation error (a required field missing, a value of the wrong type) has no
  parser position — `parseRoutineDeclaration`'s hand-written checks operate on the already-parsed
  JS object, not source text. These stay plain strings, exactly the issue text's own carve-out.

### Preview reads and diffs; only confirm resolves and writes

`resolveWritePath` (path confinement, `src/path-safety.ts` via ADR-0075) gates the confirm step
only. Preview reads the routine's `sourcePath` directly to build the diff — that path is never
attacker-controlled; it comes from `resolveRoutineDeclaration`, itself derived from a routine name
already looked up against the run store, so there is no arbitrary-file-read surface to confine.
Confining a read that can only ever target a legitimately-tracked declaration would add a check
with nothing to check against.

### Ambiguous name resolution reuses the existing disambiguation page

A routine name can resolve to more than one declaration (`groupRoutinesByName`'s documented "stale
name reuse" case: an earlier declaration removed from config, a later one reusing the name for a
different target). `/routines/:name` already has a disambiguation page for this. The three new
routes (`resolveNamedRoutineGroup`, extracted from what was previously duplicated inline in
`/routines/:name` alone) render the same page rather than a bare 404 — a 404 would tell the
operator the routine doesn't exist, when it does, just not uniquely by name.

## Consequences

- `runSavePipeline` (ADR-0075) now has its first real caller; the reload callback wired in is the
  daemon's own `reloadConfigAndRecordOutcome` (`src/daemon.ts`), extracted from
  `refreshIssuePollStatus` so an editor save and the poll tick publish the identical outcome
  (health notifier observation, `#305`'s change-event, invalid-routine stub upserts) rather than a
  parallel hand-rolled copy. It deliberately does not participate in `refreshIssuePollStatus`'s
  `polling` reentrancy guard — an editor save's reload is a cheap, file-scoped read with no shared
  mutable state to race, so it runs even while a poll tick is in flight instead of silently
  no-oping.
- A saved routine declaration's schedule/next-fire-time effect lands on the next dispatch tick, not
  synchronously in the save response — `runSavePipeline`'s `reload` re-resolves the full runtime
  snapshot (surfacing a cross-file failure like an ADR-0062/0067 rejection immediately), but the
  schedule recompute itself is `dispatchDueRoutines`' `syncRoutines` call on its own next tick. The
  AC's own wording ("takes effect on the next tick") is honored as written, not synchronously
  short-circuited.
- Editor CSS (`.editor`, `.diff`, `.diff-line`, `.diff-add`, `.diff-del`) reuses the existing
  `--ok-ink`/`--ok-bg`/`--fail-ink`/`--fail-bg` tokens for add/remove coloring rather than
  introducing new ones — an addition reads as the same "ok" green a succeeded Run pill already
  uses, a removal the same "fail" red, in both the light and dark palettes.
