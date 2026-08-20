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

`locatedYamlErrorMessage` now wires into all three real syntax-error sites a #307 editor can
actually trigger: `parseRoutineDeclaration`'s front matter (part 1), `parseWorkflowContract`'s
front matter and `parseExplicitWorkflowDefinition`'s raw-FSM document (part 2, `src/workflow/`).
A fourth site, workflow *template* files (`.symphonika/workflow-templates/*.yml`, referenced via a
raw-FSM contract's `use:`), is deliberately left unlocated — #307's editable-artifact table doesn't
include templates, and a location reported against a different file than the one open in the editor
would misdirect rather than help.

### Workflow contract validation dispatches on format, matching `readWorkflowSnapshot`

`#306`'s save pipeline wired `workflow_contract` to bare `parseWorkflowContract`, which only
understands the Markdown-with-front-matter shape. A raw-FSM contract can legitimately open with
`---` (YAML's own document-start marker), which `parseWorkflowContract` would misread as
unterminated Markdown front matter — a real latent bug, invisible until `#307` gave it a real
caller. `validateWorkflowContractContent` (`src/workflow/fsm-expansion.ts`) fixes this by mirroring
`readWorkflowSnapshot`'s own branch (`src/reload.ts`): call `expandWorkflowDefinition`, and only
fall through to `parseWorkflowContract`-shaped errors when the resolved source kind isn't
`raw_fsm` — matching exactly what reload does, content-based instead of file-based so it can
validate a submitted edit before anything is written.

Format resolution always passes `"auto"` (extension-based inference), not the Project's actual
configured `format:` override — the generic `(contents, filePath)` shape `runSavePipeline`'s
`VALIDATORS` map calls through carries no room for a third parameter, and `getProjectWorkflowPath`
(the callback that resolves a Project name to its workflow path for the editor route) doesn't
thread `format` through either, once it became clear nothing downstream read it. This is correct
for every Project that doesn't deliberately declare a format contradicting its own file's
extension — the unusual case, per `resolveWorkflowFormat`'s own fallback design (an explicit
`format:` exists to *override* the extension guess, not to be the common path).

Deliberately not shared with `readWorkflowSnapshot`'s own near-identical branch: that function also
assembles a full `WorkflowSnapshot` (body, evidence, contentHash) for the live runtime map, not
just errors, and extracting a shared seam out of it is the same kind of speculative surgery on a
large critical-path function ADR-0075 already declined to do for `reload.ts`'s service-config
schema. The ~10-line branch shape is duplicated once, not built as an abstraction with one caller.

### Service-config validation: a throwaway file, not surgery on `loadRuntimeConfigSnapshot`

ADR-0075 deferred `service_config` validation-reuse specifically because `loadRuntimeConfigSnapshot`
(`src/reload.ts`) is a large function (schema parse → provider-command-template rendering → routine
attach → previous-snapshot merge) with no clean parse-only seam, and extracting one speculatively
against no caller would be exactly the kind of surgery this project avoids. `#307`'s service-config
editor is the real caller ADR-0075 said should drive that decision — and the actual seam turns out
not to require touching `loadRuntimeConfigSnapshot`'s internals at all: it already reads from a
caller-supplied `configPath`/`configDir` pair, entirely independent of *which* file backs
`configPath`. `validateServiceConfigContent` writes the submitted content to a throwaway file in the
**same directory** as the real config — never system tmpdir, because every relative path a
`routines:` or `projects[].workflow` entry names must resolve against the real directory tree, the
same way a genuine reload's relative-path resolution works — calls `loadRuntimeConfigSnapshot`
against that throwaway path (no `previous`, since a from-scratch evaluation is what "does this
content produce a valid snapshot" actually means), and deletes it before returning. No routine
declaration or workflow contract is ever globbed from the directory (grep-verified: no `readdir`
call anywhere in `src/`), so the throwaway file's brief existence is inert to everything else.

The one honest limitation: validating without `previous` means this can occasionally be *stricter*
than the real reload that follows a successful save — a few carry-forward fallbacks
(e.g. a disabled Project's last-loaded workflow, ADR-0054) only apply when `previous` is available.
This is a false-negative risk, never a false-positive one: nothing is written until validation
passes, and the save's own `reload` callback is the real `RuntimeConfigReloader.reload()` with real
`previous` state, so the authoritative check always still runs after write. Worse case is an
operator occasionally re-attempting a save that would have actually succeeded once merged with live
state — annoying, never unsafe.

### The provider-command confirmation gate is a second, independent check — not just a UI hint

`providers.codex`, `providers.claude`, and `providers.omp` are the only three provider names
`serviceConfigSchema` allows (`src/reload.ts`) — `providerCommandsDiffer` compares each by name
directly rather than diffing an arbitrary map. The confirmation itself is enforced twice: a
`required` HTML checkbox blocks client-side submission, and the confirm route independently
re-parses both the on-disk and submitted content and refuses the write outright
(`422`, re-rendering the same preview with the checkbox) if a provider-command change is present
without the checkbox having been submitted. The second check exists because the client is not
trusted — a hand-crafted request to `POST /config/edit/confirm` skipping the preview step entirely
must still be caught, not just steered away from by UI affordance.

### Disable/enable reuses the raw-text editor's confirm route, not a new write path

`#307`'s issue text names disable/enable as exactly the case where structured editing helps: "the
operator picks a state, not text to type." `setRoutineDisabled`
(`src/routines/declaration-editor.ts`) is the targeted edit — `parseDocument`'s CST-aware model
(the same one `RoutineConfigEditor` already uses on `symphonika.yml`, `src/routines/config-editor.ts`),
scoped to only the front-matter substring so the prompt body after the closing `---` is carried
through byte-for-byte, never re-parsed as YAML. `POST /routines/:name/disable` (and `/enable`)
compute the toggled content and hand it to the *same* `renderEditorPreview` and the *same*
`POST /routines/:name/edit/confirm` route the raw-text editor's preview step posts to — the only
difference is who produced `content`: a submitted textarea, or `setRoutineDisabled`. This is not
incidental reuse; it is the mechanism by which "every save goes through #306's pipeline" (`#307`
AC) and "a diff against on-disk content is shown before every write" (`#307` AC) hold for the
toggle too, without a second write path to keep in sync with the first.

The toggle button offered on `/routines/:name` is decided from a target still backed by the current
declaration: `operator` → "Enable routine"; anything else → "Disable routine". An `operator` target
takes precedence over other current targets because a Project-cascade `inactive` target clears its
routine-level `disabledReason`; when every current target is inactive, the page parses valid
front matter for the shared declaration's `disabled` state instead. A target removed from the
declaration can remain as a durable `removed_from_config` row beside current siblings (ADR-0069's
per-target removal semantics), so it is not eligible to represent the declaration's lifecycle
state. When every target has `disabledReason = removed_from_config`, neither button is shown because
restoring config inclusion, not this action, is what re-enables the Routine.

### Firing cancellation needed a UI control and a redirect fix, not a new cancel mechanism

Cancellation was already fully generalized server-side before `#307`: `cancelRunInStore`
(`src/http/app.ts`) already tries `runStore.getRun(id)` then falls back to
`runStore.getRoutineFiring(id)`, and `POST /api/runs/:id/cancel` already accepts a Firing id (ADR
0060 built this when Firing cancellation via `symphonika cancel <id>` shipped). The `#304`-era stub
note on `/firings/:id` ("deferred to #306's write-surface plumbing") was stale by the time `#307`
landed — the actual gap was narrower: no cancel *button* existed on the Firing page, and the
route's own form-post redirect was hardcoded to `/runs/${id}` regardless of which kind of id it
cancelled, so cancelling from `/firings/:id` would have bounced the operator to a `/runs/:id` page
for an id that was never a Run. `renderFiringCancelForm` mirrors `renderCancelForm`'s existing shape
posting to the same endpoint; the redirect now id-sniffs the same way the cancel logic itself
already does.

### Preview reads and diffs; only confirm resolves and writes

`resolveWritePath` (path confinement, `src/path-safety.ts` via ADR-0075) gates the confirm step
only. Preview reads the routine's `sourcePath` directly to build the diff — that path is never
attacker-controlled; it comes from `resolveRoutineDeclaration`, itself derived from a routine name
already looked up against the run store, so there is no arbitrary-file-read surface to confine.
Confining a read that can only ever target a legitimately-tracked declaration would add a check
with nothing to check against.

For a symlinked Workflow Contract, confirm deliberately keeps two paths: `resolveWritePath`'s real
target is used for the stale check and atomic rename so the save updates the target without
replacing the symlink, while the configured logical Workflow Contract path is passed separately as
`runSavePipeline.validationPath`. Reload calls `readWorkflowSnapshot` with that same logical path,
so relative raw-FSM prompt references must be validated from its directory. Validating from the
resolved target's directory would let preview and reload agree while confirm alone rejects (or
accepts) the same submitted contract against a different filesystem base.

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
- `renderEditorForm`/`renderEditorPreview` (renamed from routine-specific names once a second
  caller existed) are the shared form/diff shape all three editors render through; only the
  blast-radius disclosure and validator differ per artifact, passed in by the caller rather than
  hard-coded into the shared renderer.
- `save-pipeline.ts`'s `VALIDATORS` map is now `(contents, filePath) => {errors} | Promise<{errors}>`
  — widened from synchronous-only once `workflow_contract`'s real validator needed to be async
  (`expandWorkflowDefinition` and `validateExpandedWorkflowReferences` both are). `runSavePipeline`
  awaits the result unconditionally; a still-synchronous validator like `parseRoutineDeclaration`
  is unaffected.
- `SaveContentKind` now has all three real kinds from `#306`'s own issue text (`routine_declaration`,
  `workflow_contract`, `service_config`) — the pipeline built ahead of a caller in `#306` is now
  exercised end to end by all three editors `#307` asks for.
- The Config link in the shared page navigation is unconditional (every page, regardless of whether
  `getConfigPath` is wired) — matching how "Runs" is already unconditional regardless of `runStore`.
  A harness that doesn't wire `getConfigPath` gets a 404 behind that link rather than a hidden one;
  no route handler has the caller context needed to conditionally suppress a nav item shared across
  every page.
- This closes `#307`: all three editors, all nine acceptance criteria. Disable/enable and firing
  cancellation are the ADR-0060 lifecycle controls #304's stub notes deferred; both landed as thin
  wiring on top of infrastructure that already existed (the save pipeline and diff-preview shape for
  the toggle, `cancelRunInStore`'s existing Run/Firing generalization for cancellation) rather than
  new mechanisms.
