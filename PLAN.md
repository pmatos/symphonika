# Plan: Project settings editor for Ready Label, priority labels, and epic labels (#857)

## Goal
Add a focused `GET /projects/:name/settings` page that edits one Dispatch Project's `issue_filters.ready_label`, `priority.{labels,default}`, and a new `epic_labels` list through the existing authenticated preview → confirm → reload pipeline, and show the effective (active) values on the Project page. Parent epic #844.

## Assumptions
- Blocker resolved: #855 was closed as duplicate of #845, which landed as PR #881 (`defa508`); `issue_filters.ready_label` exists on main (`src/config-schemas.ts:135`). Branch was fast-forwarded to `origin/main` (b0e4a37). The stale `EVIDENCE.md` (untracked, says "blocked") is obsolete; do not commit it.
- "Epic vocabulary" has no existing config. Chosen: new optional top-level Dispatch Project key `epic_labels: string[]` (default `[]`), NOT under `issue_filters` (it is not a filter). Display-only: never read by eligibility (`issueFilterReasons`, `src/issue-polling.ts:1636`) or `priorityForLabels`. Alternative considered: `issue_filters.epic_labels` — rejected because it implies filtering. Using epic labels to mark rows on `/issues` or the dependency graph is a follow-up.
- Structural invariant instead of a runtime promise: schema rejects an epic label that equals `ready_label` or appears in `priority.labels`, so an epic label cannot silently carry eligibility or priority meaning. New key ⇒ no existing config breaks.
- Priority edit surface: textarea, one `label=number` per line (split on the LAST `=`, labels like `priority:high` contain `:`), plus a numeric default field. Order in the saved file is lower-number-first then label name, so the file reads in dispatch order; runtime semantics unchanged (`priorityForLabels` takes the min, `default` is the explicit fallback).
- The editor never trusts submitted `content` blindly (the generic confirm form carries raw `content`, which would bypass the service-config provider-command checkbox). Confirm re-derives and refuses any save that changes anything except the three keys of the named project (see step 4).
- A project still on legacy `labels_all` is edited by writing `ready_label` and deleting `labels_all` from that project's `issue_filters`; the diff preview shows it. Best guess; no ADR conflict (ADR-2026-10-08-1426 says set `ready_label` and remove `labels_all`).

## Key Files
| File | Role | Lines of Interest |
|------|------|-------------------|
| `src/config-schemas.ts` | `issueFiltersSchema`, `DEFAULT_READY_LABEL` | 128-181 |
| `src/reload.ts` | `pollingProjectSchema` (real config load), `validateServiceConfigContent` | 322-340 |
| `src/issue-polling.ts` | duplicate `pollingProjectSchema` (parity), `normalizeIssueSnapshot`, `issueFilterReasons` | 258-290, 1604, 1636 |
| `src/issue-priority.ts` | `priorityForLabels`, `LabelPriorityConfig` | 11-66 |
| `src/http/pages.ts` | `/projects/:name` (1566), workflow editor routes (1689-1793), `/config/edit` routes (1795-1917), `renderEditorForm` (5814), `serviceConfigEditorPreviewTarget` (5903), `renderEditorPreview` (5939), `confirmSave`/`previewEditor` wiring (394-410), `renderProjectCapacityStrip` (3374) | |
| `src/http/app.ts` | `HttpAppOptions` accessors (`getConfigPath` 268, `getProjectRequiredLabels` 290) | |
| `src/daemon.ts` | wires accessors from `runtimeConfig.projectsByName()` | 1958-1972 |
| `src/http/save-confirm.ts` | `createSaveConfirmer`: 403 / 409 stale / 422 invalid / "Saved but not active" 200 / 303 | whole file |
| `src/http/save-pipeline.ts` | `runSavePipeline`: validate → hash check → atomic write → reload | 80-130 |
| `src/http/editor-preview.ts` | `createEditorPreviewer.respond` with `kind: "prepared"` command; `providerCommandsDiffer` | 55-75, 130-175 |
| `src/doctor.ts` | existing `parseDocument`/`setIn` comment-preserving config edit pattern | 2078-2180 |
| `tests/service-config-editor.test.ts` | harness to copy: CSRF/session headers, `extractHidden`, stale/reload-failure cases | 1-150, 390-460 |
| `tests/http-app-runs.test.ts` | Project page tests ("renders the capacity strip…" 3808, 404 case 3644) | |
| `symphonika.example.yml`, `SPEC.md` (§4.3 ~138, config sample ~482, editors ~3060-3100), `CONTEXT.md` (Ready Label 134) | docs to update | |

## Steps (ordered TDD slices; each = failing test → minimal production code)

### 1. Schema: optional `epic_labels`, disjoint from ready/priority labels
- **Test** (`tests/config-schemas.test.ts` + a `validateServiceConfigContent` case in `tests/reload.test.ts`): `epic_labels: [epic]` accepted and preserved on the parsed project; omitted ⇒ `[]`; empty/blank entry rejected; duplicate entries rejected; epic equal to `ready_label` rejected; epic present in `priority.labels` rejected; Routine Host with `epic_labels` rejected like other dispatch-only keys.
- **Code**: add `epic_labels: z.array(z.string().trim().min(1)).default([])` plus a `superRefine` disjointness/uniqueness check to `pollingProjectSchema` in `src/reload.ts:322` (chain beside `rejectPerProjectRoutines`) and mirror the field in the duplicate schema at `src/issue-polling.ts:258` (parity; type `PollingProjectConfig` gains `epic_labels`). Add `"epic_labels"` to `DISPATCH_ONLY_KEYS` (`src/config-schemas.ts:83-89`, consumed by `rejectDispatchOnlyKeysOnRoutineHost` at :91). Also add `epic_labels` to the hand-written `RunControllerProjectConfig` type (`src/lifecycle/run-controller.ts:208`, what `projectsByName()` returns) so daemon wiring typechecks.
- Proves AC3 (epic labels cannot overlap eligibility/priority labels).

### 2. Pure priority-policy description
- **Test** (`tests/issue-priority.test.ts`): `describePriorityPolicy({labels:{b:2,a:1,c:1}, default:99})` → entries `[a:1, c:1, b:2]` (number asc, then label) and `fallback: 99`; empty map → no entries, fallback only. Plus a regression: `priorityForLabels(["epic","priority:low"], …)` is unchanged when `epic` is not mapped, and an issue with only an epic label gets `default` (AC3 lower-number-first + explicit fallback; epic doesn't affect priority). Add an `issue-polling` test: an issue with epic label but no ready label is still ineligible (`missing required label …`).
- **Code**: `describePriorityPolicy` exported from `src/issue-priority.ts` (used by pages.ts and the settings form ⇒ not test-only, knip-safe).

### 3. Settings form parsing + comment-preserving YAML edit [new module]
- **File**: `src/http/project-settings.ts` [new]; tests `tests/project-settings.test.ts` [new].
- **Test**: (a) `parseProjectSettingsForm(body)` → `{readyLabel, priorityLabels, priorityDefault, epicLabels}`; field errors (blank ready label, line without `=`, non-integer/negative number, duplicate priority label, non-integer default); epic input is newline/comma separated, trimmed, deduped. (b) `applyProjectSettingsEdit(content, projectName, settings)`: sets only the three keys of the named project, preserves comments, other Projects, `providers`, `routines`, and unknown passthrough keys byte-for-byte outside the touched nodes; removes legacy `labels_all` when present; unknown project name / unparsable YAML / non-seq `projects` ⇒ error result; preserves unknown sibling keys inside `priority`. (c) `changesOnlyProjectSettings(onDisk, submitted, projectName)` is true for a legitimate edit and false when any other key differs — including `providers.codex.command`, another project's `ready_label`, this project's `tracker`, `issue_filters.labels_none`, `issue_filters.states`, and a passthrough sibling inside `priority`. (d) alias case: project whose `priority` is `*shared` with another project ⇒ error result, file text unchanged.
- **Code**: `parseDocument` from `yaml` (pattern `src/doctor.ts:2078`): find project by `name` in the `projects` seq, `setIn` `["issue_filters","ready_label"]`, `["priority","labels"]`, `["priority","default"]`, `["epic_labels"]` (delete when empty). For (c), compare raw `yaml.parse` output (not zod output) with EXACTLY these paths masked on the named project: `issue_filters.ready_label`, `issue_filters.labels_all`, `priority.labels`, `priority.default`, `epic_labels` — never mask all of `issue_filters` or `priority`.

### 4. Routes: GET / preview / confirm, reusing the existing pipeline
- **Preview-renderer constraint (verified)**: `renderEditorPreview` (`pages.ts:5939`) on `errors.length > 0` re-renders a raw-`content` textarea form posting to `input.previewAction`, and on success emits hidden `content` to `confirmAction`. A settings target must NOT reuse that error branch with `previewAction` = the settings preview route (raw `content` post would hit the settings form parser → missing-field 500). Plan: settings-form errors (parse errors, alias refusal, stale, schema errors from calling `validateSaveContent` directly) are rendered by a settings-specific `renderProjectSettingsForm` (422, form values preserved, nothing written) and never reach `renderEditorPreview`; only a valid candidate goes through `previewEditor.respond(…, {kind:"prepared"})`, reusing the success branch (diff + confirm button with hidden `content`) with `confirmAction` = settings confirm. Confirm's own `renderInvalid` likewise returns the settings form.
- **Alias refusal**: if the named project's `issue_filters`/`priority`/`epic_labels` node is a YAML alias/anchored node shared with another project, `applyProjectSettingsEdit` returns an error and preview shows "shared via a YAML anchor; edit the raw config" (link `/config/edit`). Test in step 3.
- **File**: `src/http/pages.ts` (new block after the workflow editor routes, ~1794; routes live in `registerPages`, not `app.ts`); tests `tests/project-settings-editor.test.ts` [new] (copy harness from `tests/service-config-editor.test.ts:1-150`, with a real temp `symphonika.yml` and `getConfigPath`).
- **Behavior / tests**:
  - `GET /projects/:name/settings` (`requireSameOriginRead`): renders form prefilled from the FILE's values for that project, hidden `expected_content_hash` of the whole Service Config, CSRF token, and an "active now" column from the runtime snapshot; 404 for unknown Project and for a Routine Host; cross-origin read refused.
  - `POST …/settings/preview` (`requireAuthorizedMutation`): requires CSRF (403 without). Reads the file; if `contentHash(file) !== expected_content_hash` ⇒ 409 stale notice (reuse `renderStaleSaveNotice` via the confirmer or an exported equivalent) — otherwise the diff would silently fold in someone else's edit. Parses form (field errors ⇒ 422 re-render with the form values, nothing written); applies edit; runs `validateSaveContent` (kind `service_config`); renders through `previewEditor.respond(…, {kind:"prepared", draft:{content, expectedContentHash}, errors, onDisk})` so the diff + "Confirm" are the existing UI.
  - `POST …/settings/confirm`: reads `content`, `expected_content_hash`; reads disk; refuses (403, file untouched) unless `changesOnlyProjectSettings(onDisk, content, name)` (closes the provider-command-checkbox bypass); then `confirmSave(context, {kind:"service_config", filePath: configPath, validationPath: configPath, expectedContentHash, editAction: /projects/:name/settings, savedRedirect: /projects/:name, name: "<project> settings", renderInvalid: …previewEditor.renderInvalid(settings target)})`.
  - Tests (each asserting file bytes): valid edit ⇒ 303 to `/projects/:name?saved=1`, ONLY that project's three keys change, other projects/comments/providers intact, reload callback invoked once (AC1). File changed externally between GET and preview ⇒ 409, and between preview and confirm ⇒ 409, file equals the external edit, reload not called (AC2). Invalid value (negative priority, blank ready label, epic==ready label) ⇒ 422, file unchanged (AC2). Reload rejects after a passing write ⇒ 200 "Saved but not active", and `/projects/:name` still shows the OLD effective values because it reads the runtime snapshot (AC2 "not presented as active"). Tampered confirm `content` changing `providers.codex.command` ⇒ 403, unchanged.
- **Code**: factor a `projectSettingsPreviewTarget(name, configPath)` next to `serviceConfigEditorPreviewTarget` (`pages.ts:5903`) and a `renderProjectSettingsForm` next to `renderEditorForm` (`pages.ts:5814`). No new write path: all writes go through `runSavePipeline` (atomic, hash-checked, real reload).

### 5. Effective queue policy on the Project page (may be done right after step 2 so AC4 lands as the first vertical slice)
- **Test** (`tests/http-app-runs.test.ts`, next to the 3808 capacity-strip test, or `tests/project-settings-page.test.ts` [new]): with a stub `getProjectQueuePolicy`, `/projects/:name` shows "Ready Label `X`", a priority table in ascending order with the explicit "other labels → default N" row, the epic label list (or "none") with the text that epic labels don't affect eligibility/priority, and an "Edit settings →" link (shown only for a Dispatch Project with the accessor present; absent for Routine Host). Escaping test: labels with `<`/`&` are escaped.
- **Code**: new `getProjectQueuePolicy?: (name) => {readyLabel, priority:{labels,default}, epicLabels} | undefined` added to BOTH `HttpAppOptions` (`src/http/app.ts`, beside `getProjectRequiredLabels` ~290) and `RegisterPagesOptions` (`src/http/pages.ts:178-197`) plus the pass-through in `createHttpApp`'s `registerPages` call; wire in `src/daemon.ts` (~1969) from `runtimeConfig.projectsByName()`; render `renderProjectQueuePolicy(policy)` in the `/projects/:name` block (`pages.ts:1678`, before the issues table) using `describePriorityPolicy`. Active values come from the runtime snapshot, never from the file.

### 6. Docs and examples
- `SPEC.md`: §4.3 note epic labels are display-only; config sample (~482) add `epic_labels`; editors section (~3069) add the `/projects/:name/settings` description (hash covers whole file, confirm restricted to the three keys, active-vs-saved display).
- `CONTEXT.md`: add **Epic Label** and **Priority Policy** (lower number first, `default` fallback) terms near **Ready Label** (line 134); add the settings editor to Relationships if appropriate.
- New ADR `docs/adr/2026-10-09-HHMM-project-settings-editor.md` (UTC time at authoring): focused editor produces a whole-file candidate through the existing service_config pipeline; `epic_labels` top-level and disjoint; confirm restricted to three keys.
- `symphonika.example.yml`: add commented/real `epic_labels` example; keep `tests/skill-examples` unaffected (only checks workflow yaml). Check `skills/symphonika/OPERATIONS.md` and `docs/tutorial.md` only if they enumerate project keys (grep found no `config/edit` mentions; update only if they list `priority`/`issue_filters`).

### 7. Quality gate (separate commands)
`npm run lint`, `npm run typecheck`, `npm run format:check` (only files in the diff), `npm run knip` (exports used only by tests ⇒ drop `export`), `npm test` (known flakes: routine-workspace, notification-daemon under load), `npm run build`. `git rm PLAN.md` before opening the PR; PR title `feat: edit project ready label, priority, and epic vocabulary` (lowercase subject).

## Testing
- Slice tests above; verify negative/vacuous assertions by temporarily disabling the guard (e.g. the stale check in preview, `changesOnlyProjectSettings`) and confirming the test fails.
- Manual check is not possible with browser MCP in issue workspaces; rely on HTTP-level tests.

## Risks
- Two near-duplicate project schemas (`src/reload.ts:322`, `src/issue-polling.ts:258`): miss one and `epic_labels` is dropped or rejected inconsistently. Mitigation: step 1 tests parse through both paths.
- Raw `content` in the generic confirm form is attacker-shaped: mitigated by `changesOnlyProjectSettings`; keep the service-config provider-command gate semantics intact.
- Preview must refuse stale files itself; otherwise the diff merges concurrent edits. Covered by test.
- Existing `runSavePipeline` hash check and write are not one atomic step (pre-existing TOCTOU); out of scope, noted only.
- Concurrent PRs touching `pages.ts` (7.5k lines, main moves fast): rebase right before push; keep new rendering in `project-settings.ts` helpers where possible.
- Codex review may surface adjacent P1s per push in config-load paths; fix the named gaps, defer unrelated ones with a PR note.

## Out of scope
- Using epic labels to group/mark rows on `/issues`, the dependency graph, or Maestro; Epic-aware dispatch of any kind.
- Editing other Project settings (tracker, weight, max_in_flight, workflow, agent) or Routine Host settings.
- Fixing the pre-existing hash-check/write TOCTOU in `runSavePipeline`.
- Creating the Ready Label / priority labels in GitHub from the settings page (`doctor`/`init-project` own that).
- Any change to `symphony/`, workflow FSM syntax, or CLI flags (so `docs/workflows.md` and OPERATIONS.md need no update).
