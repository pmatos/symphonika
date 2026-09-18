# Architecture review — symphonika — 2026-09-18

**Scope**: Hot spots by churn over the last 120 commits, in descending order:
`src/lifecycle/run-controller.ts` (117 touches), `src/run-store.ts` (117),
`src/http/pages.ts` (99), `src/routines/dispatcher.ts` (55),
`src/doctor.ts` (53), `src/providers/omp.ts` (18), plus `src/daemon.ts`,
`src/routines/outcome.ts`, `src/reload.ts`, `src/issue-polling.ts`. YAGNI:
deepening pays off through *future* change, so cold code was not scanned.
**Picked**: `editor-save-outcome-epilogue` — see `.architecture/backlog.md`
**Degradations**: none. `gh` authenticated; sub-agent exploration available;
`codebase-design` vocabulary applied throughout.

**Diagram legend**: solid edges are the interface a caller must learn; dashed
edges are inside the implementation, hidden behind the seam.

## Candidates

### editor-save-outcome-epilogue — one seam owns the editor save-response policy · Strong · score 22/25

- **Files**: `src/http/pages.ts:1734-1824` (`POST /projects/:name/workflow/edit/confirm`),
  `src/http/pages.ts:1977-2065` (`POST /config/edit/confirm`),
  `src/http/pages.ts:2360-2457` (`POST /routines/:name/edit/confirm`);
  `src/http/save-pipeline.ts:44-52` (the `SavePipelineResult` union being dispatched).
  **File-count estimate: ~5** — `pages.ts`, one new module, and the three editor
  test files (`workflow-contract-editor.test.ts`, `service-config-editor.test.ts`,
  `routine-declaration-editor.test.ts`).
- **Score**: 22/25 (leverage 4, locality 4, blast radius 1, heat 5)
  - *Leverage 4*: three call sites simplify, each shedding ~60 lines of
    hand-written status-code dispatch; no caller reaches past the seam afterwards.
    Not 5 — the route tests still exercise the matrix end-to-end over HTTP, so no
    whole class of test setup disappears.
  - *Locality 4*: a change to the save-response policy becomes a one-place edit
    instead of three. Not 5 — all three sites already live in one file, and the
    rubric reserves 5 for collapsing a several-*file* edit.
  - *Blast radius 1*: contained; no published package, wire, or CLI interface
    changes. ~5 files, of which 3 are tests.
  - *Heat 5*: `pages.ts` is the third-hottest file in the tree (99 touches in 120
    commits) and was touched on 2026-09-17, in `HEAD` itself (#787) and in #782.
- **Problem**: `save-pipeline.ts` is already a **deep module** for the *write* half
  of a Service Config / Workflow Contract / Routine Declaration save: one function
  hides validation, the stale-write check, atomic-rename-preserving-mode, and
  reload-outcome capture. The *respond* half has no module at all. Each of the
  three `/edit/confirm` routes re-implements, by hand, the same policy: resolve the
  write path or refuse with `403`; then map the four-variant `SavePipelineResult`
  onto `303` / `200` / `422` / `409` / `500`, with the reload-gating rule layered
  on top of `saved`. The asymmetry is the shallowness: the interface each route
  must learn (five branches, five status codes, one gating rule) is *more* complex
  than the behaviour it is calling into. The duplication is not incidental — the
  load-bearing invariant is copied verbatim three times as prose, at
  `pages.ts:1762-1766`, `2003-2007` and `2386-2390`: *"The pipeline writes before
  reload runs, so `saved` alone doesn't mean the new … took effect — redirecting …
  here regardless would read as success even when reload rejected it."* A policy
  a codebase has to restate in three comments is a policy with no home.
- **Deletion test**: **Concentrates.** Delete the proposed module and the five-way
  status mapping plus the reload gate go back to being written out longhand in
  every editor route — and a fourth editor (ADR-0076 is explicitly "filled in part
  by part") would restate them a fourth time. Nothing moves to callers: what the
  routes keep is only what genuinely differs between them (their own URLs, their
  own preview shape, their own artifact path).
- **Solution**: One module owning the write-path gate, the status-code mapping, and
  the reload-gating rule. The one branch whose divergence is real — `invalid`,
  which re-renders each editor's own preview with a different option surface per
  route — is *not* absorbed: it is supplied by the caller. Absorbing it would
  balloon the module's option surface (`workflowFormat`, `projectParam`,
  `includeInactive`, a conditional `expectedSourcePath`, and three different ways
  of obtaining `onDisk`) and rebuild the shallowness one layer up.
- **Benefits**: **Leverage** — a caller learns one call instead of five branches,
  and a new editor route gets the reload gate and the whole status matrix by
  construction rather than by copy-paste. **Locality** — the save-response policy
  becomes a one-place edit; today a status-code change or a new `SavePipelineResult`
  variant is a three-place edit with no compiler pressure to find the third.
  **Test surface** — the matrix becomes directly exercisable through one interface
  without standing up a Hono app, a CSRF token, a session, and a temp config file
  per assertion; the route tests then only need to pin what is genuinely per-route.
- **Before**

```mermaid
graph LR
  R1[workflow confirm] --> G1[resolve write path / 403]
  R1 --> P[runSavePipeline]
  R1 --> D1[map 4 variants to 5 statuses]
  R2[config confirm] --> G2[resolve write path / 403]
  R2 --> P
  R2 --> D2[map 4 variants to 5 statuses]
  R3[routine confirm] --> G3[resolve write path / 403]
  R3 --> P
  R3 --> D3[map 4 variants to 5 statuses]
```

- **After**

```mermaid
graph LR
  R1[workflow confirm] --> S[save-outcome seam]
  R2[config confirm] --> S
  R3[routine confirm] --> S
  S -.-> G[resolve write path / 403]
  S -.-> P[runSavePipeline]
  S -.-> M[status mapping + reload gate]
  R1 -. renderInvalid .-> S
  R2 -. renderInvalid .-> S
  R3 -. renderInvalid .-> S
```

### routine-editor-target-prologue — one seam resolves a routine edit target · Strong · score 22/25

- **Files**: `src/http/pages.ts:2244-2276` (`POST /routines/:name/edit/preview`),
  `2321-2353` (`POST /routines/:name/edit/confirm`),
  `2473-2505` (`renderRoutineDisabledTogglePreview`, serving `/disable` and `/enable`).
  **File-count estimate: ~3.**
- **Score**: 22/25 (leverage 4, locality 4, blast radius 1, heat 5)
  - *Leverage 4*: three call sites shed 33 near-identical lines each.
  - *Locality 4*: the refusal policy becomes one edit; single-file today.
  - *Blast radius 1*: `pages.ts` plus two editor test files.
  - *Heat 5*: same file as the pick.
- **Problem**: 33 lines identical modulo indentation, repeated three times:
  `parseBody` → `project_param` / `expected_source_path` / `include_inactive` →
  `resolveNamedRoutineGroup` → early `renderUneditableRoutine` (200 when ambiguous,
  404 otherwise) → `resolveRoutineDeclaration` → `checkStaleRoutineDeclaration` →
  early return. The concentrated behaviour is a *refusal policy* — which resolution
  failure is 404 and which is 200, and the ADR-0076 guard that refuses a save when
  the name now resolves to a different declaration file than the form was opened
  for. Three copies means a fourth editor action can silently omit the stale guard,
  which is the precise bug the guard exists to prevent.
- **Deletion test**: **Concentrates.** The only genuine divergence is a parameter:
  the toggle's `editAction` omits the `/edit` path segment (`:2499` vs `:2270`/`:2347`).
- **Solution**: `resolveRoutineEditTarget(...)` returning
  `{ kind: "ok", … } | { kind: "refused", response }` — the discriminated-result
  house pattern `resolve-scheduled-dispatch-context` (PR #764) just landed on the
  run-controller side.
- **Benefits**: **Leverage** — a new routine-editor route inherits the stale guard.
  **Locality** — the refusal policy lands in one place. **Test surface** — the
  404-vs-200 matrix becomes assertable without three HTTP round-trips.
- **Before**

```mermaid
graph LR
  P1[edit/preview] --> A[parse body + params]
  P1 --> B[resolveNamedRoutineGroup]
  P1 --> C[stale-declaration guard]
  P2[edit/confirm] --> A
  P2 --> B
  P2 --> C
  P3[disable/enable] --> A
  P3 --> B
  P3 --> C
```

- **After**

```mermaid
graph LR
  P1[edit/preview] --> T[resolveRoutineEditTarget]
  P2[edit/confirm] --> T
  P3[disable/enable] --> T
  T -.-> A[parse body + params]
  T -.-> B[resolveNamedRoutineGroup]
  T -.-> C[stale-declaration guard]
```

### run-chain-tree-walk-cte — one constant owns the chain-tree walk · Worth exploring · score 20/25

- **Files**: `src/run-store.ts:5729-5755` (`isRunChainFullyTerminal`),
  `5777-5800` (`retirePullRequestDiscoveryChain`); precedent constant
  `RUN_CHAIN_ROOT_CTE` at `:1174`. **File-count estimate: ~2.**
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
  — leverage 3: two call sites; locality 4: the cycle-guarded walk lands once;
  blast 1: one production file; heat 5: `run-store.ts` touched 2026-09-17, 117/120.
- **Problem**: A byte-identical `with recursive up/down` walk — up to the chain root,
  then down to every descendant — is written twice. Both copies carry long prose
  explaining *why* a forward-only walk is wrong. Re-verified present at HEAD.
- **Deletion test**: **Concentrates** — a ~20-line shared correctness invariant
  (cycle guard + root-find + descend), not a shared SQL string.
- **Solution**: a `RUN_CHAIN_TREE_CTE` constant, mirroring the existing
  `RUN_CHAIN_ROOT_CTE`. Do **not** unify the deliberately-different ancestor-only
  walk further down the file — its shape is a documented performance choice.
- **Benefits**: **Locality** — a fix to the traversal lands once.
- **Before**

```mermaid
graph LR
  F1[isRunChainFullyTerminal] --> W1[up/down CTE copy 1]
  F2[retirePullRequestDiscoveryChain] --> W2[up/down CTE copy 2]
```

- **After**

```mermaid
graph LR
  F1[isRunChainFullyTerminal] --> K[RUN_CHAIN_TREE_CTE]
  F2[retirePullRequestDiscoveryChain] --> K
```

### handle-scheduled-dispatch-error — one teardown owns the post-dispatch catch · Worth exploring · score 20/25

- **Files**: `src/lifecycle/run-controller.ts:3105-3180` (`executeStateAdvance`),
  `3515-3575` (`executeContinuation`), structural cousin at `3698`
  (`dispatchReviewFollowup`). **File-count estimate: ~2.**
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
- **Problem**: The `RegistryShutdownError` → cancel-parent-iff-`getRun`-undefined /
  `CapBreachedError | IssueReservedError` → warn + reschedule +
  `cancelRunAfterScheduleRefused` / else-rethrow window that #663/#674 fixed is
  written out two-and-a-bit times. Friction re-verified present after PR #764.
- **Deletion test**: **Concentrates** — the epilogue twin of the prologue #764 landed.
- **Solution**: one teardown owning the error-classification window.
- **Benefits**: **Locality** — the error window becomes one edit.
- **Before**

```mermaid
graph LR
  A[executeStateAdvance] --> E1[catch: classify + cancel + reschedule]
  B[executeContinuation] --> E2[catch: classify + cancel + reschedule]
```

- **After**

```mermaid
graph LR
  A[executeStateAdvance] --> H[handleScheduledDispatchError]
  B[executeContinuation] --> H
  H -.-> C[classify] 
  H -.-> D[cancel / reschedule]
```

### routine-firing-terminal-write — one seam settles a terminal firing · Worth exploring · score 20/25

- **Files**: `src/routines/dispatcher.ts:1800-1828` (success path),
  `2001-2030` (failure/cancel path), both inside `runRoutineFiring`.
  **File-count estimate: ~2.**
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
- **Problem**: The rule "the reconciled Routine Outcome and the persisted terminal
  row agree" is assembled twice, and has **already drifted**: the failure path
  passes `observedAction: githubObservation.action` where the success path passes
  `claimUrlVerification ?? githubObservation.action`, and a comment at `:2025-2027`
  admits the failure path's `pullRequestObserved` is *inert* — accidentally correct
  today, wrong the moment the precondition widens.
- **Deletion test**: **Concentrates** — the divergences become named parameters
  (`firingDeadlineWon` failure-only, nullable `terminalReason`), not hooks.
- **Solution**: `settleRoutineFiringTerminal(runStore, {...})` owning the ADR-0068
  12-field `reconcileRoutineOutcome` assembly and its agreement with the row state.
- **Benefits**: **Locality** — the drift that already happened cannot recur.
- **Note**: the *wider* settlement sequence (`1606-1828` vs `1877-2030`) was examined
  and rejected — eight genuine divergences would land as per-path hooks, so that
  extraction **moves** rather than concentrates.
- **Before**

```mermaid
graph LR
  S[success path] --> R1[assemble 12-field outcome]
  S --> W1[completeRoutineFiring]
  F[failure path] --> R2[assemble 12-field outcome]
  F --> W2[completeRoutineFiring]
```

- **After**

```mermaid
graph LR
  S[success path] --> T[settleRoutineFiringTerminal]
  F[failure path] --> T
  T -.-> R[reconcileRoutineOutcome]
  T -.-> W[completeRoutineFiring]
```

### omp-frame-read-loop — one generator owns the OMP terminal contract · Worth exploring · score 20/25

- **Files**: `src/providers/omp.ts:517-556` (`readUntilFrame`),
  `558-600` (`readUntilResponse`). **File-count estimate: ~2.**
- **Score**: 20/25 (leverage 3, locality 5, blast radius 1, heat 4)
  — locality 5: a fix to the terminal-event protocol currently lands twice in two
  functions whose call sites interleave in one turn generator.
- **Problem**: `diff` of the two spans yields only three hunks — the signature, the
  event-construction line, and the match condition. Everything else — `process_exit`
  → `missingTerminalAgentEndEvent`; `isTerminalAgentEnd` → `markTerminalAgentEnd` +
  `terminalAgentEndBeforePrompt` + `drainUntilExit`; `isTerminalFailure` → latch —
  is the OMP wire protocol's terminal contract, written twice.
- **Deletion test**: **Concentrates** — it is a protocol invariant, not a shared shape.
- **Solution**: one `readUntilMatch(queue, activeRun, { match, mapMatched })`; the
  two existing functions become thin adapters. `drainUntilExit` stays out — no match
  predicate, no terminal handling; folding it in widens the interface for nothing.
- **Benefits**: **Locality** — an ADR-0066 protocol fix lands once.
- **Before**

```mermaid
graph LR
  T[turn generator] --> A[readUntilFrame]
  T --> B[readUntilResponse]
  A --> P1[terminal-event contract copy 1]
  B --> P2[terminal-event contract copy 2]
```

- **After**

```mermaid
graph LR
  T[turn generator] --> A[readUntilFrame]
  T --> B[readUntilResponse]
  A --> M[readUntilMatch]
  B --> M
  M -.-> P[terminal-event contract]
```

### routine-dispatch-refusal-ledger — atomic store-write / log / report triple · Speculative · score 20/25

- **Files**: `src/routines/dispatcher.ts` seven refusal sites in `dispatchDueRoutines`:
  `832-852`, `869-893`, `902-923`, `930-952`, `953-975`, `993-1019`, `1020-1044`.
  **File-count estimate: ~2.**
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
  — leverage held at 3 deliberately: see below.
- **Problem**: The invariant "what `dispatchDueRoutines` reports to the daemon is
  exactly what the Run Store accepted" is re-encoded seven times, with an unnamed
  asymmetry — the four `record*`-backed sites gate log+push on the store's return
  value, the two hold sites push unconditionally and log at `warn`. Corroborating
  drift risk: `:912-916` re-derives `scheduledAt` as
  `routine.nextFireAt ?? now.toISOString()` where `:841-845` uses the already-bound
  `scheduledAt` — the same expression today, one edit from not being.
- **Deletion test**: **Concentrates, weakly.** A four-member ledger wrapping four
  *different* Run Store methods with three *different* log shapes has an interface
  close to its implementation — the deepened result would itself be shallow. This is
  why leverage is 3 despite seven call sites: the sites are numerous but not alike.
- **Solution**: a per-call ledger closing over `runStore`, `logger`, `now` and the
  four result arrays, exposing `.skip` / `.miss` / `.defer` / `.hold`.
- **Benefits**: **Locality** — the gating rule becomes per-member and explicit.
- **Before**

```mermaid
graph LR
  D[dispatchDueRoutines] --> S1[skip: write+log+push]
  D --> S2[miss: write+log+push]
  D --> S3[hold: write+log+push]
  D --> S4[defer: write+log+push]
```

- **After**

```mermaid
graph LR
  D[dispatchDueRoutines] --> L[RoutineRefusalLedger]
  L -.-> W[run store write]
  L -.-> G[log]
  L -.-> R[result buckets]
```

### init-project-prompt-session — one seam owns the init prompt lifecycle · Speculative · score 18/25

- **Files**: `src/doctor.ts:2611-2638` (`confirmOperationalLabelCreation`),
  `2640-2667` (`confirmEligibilityLabelCreation`), `2141-2261`
  (`collectProjectSettings`, lifecycle only). **File-count estimate: ~2.**
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
  — heat 3: `doctor.ts` is hot overall (53/120), but the `init project` prompt
  cluster is a cold corner of it.
- **Problem**: All three repeat `createInitProjectPromptController(prompt, yes)` →
  `try` → `finally { close() }`; the two `confirm*` functions share a further ~28
  lines differing only in three strings, including the consent parse.
- **Deletion test**: **Concentrates** — two real invariants: the readline interface
  is closed on every exit path, and anything other than `yes`/`y`/`no`/`n` throws
  rather than silently defaulting to consent for a live GitHub label write.
- **Solution**: `withInitProjectPrompt(prompt, yes, (ask) => …)` plus an
  `askYesNo(ask, { key, message, refusalNoun })` built on it.
- **Benefits**: **Locality** — one consent parser instead of two.
- **Before**

```mermaid
graph LR
  A[confirmOperationalLabelCreation] --> L1[create/close + consent parse]
  B[confirmEligibilityLabelCreation] --> L2[create/close + consent parse]
  C[collectProjectSettings] --> L3[create/close]
```

- **After**

```mermaid
graph LR
  A[confirmOperationalLabelCreation] --> W[withInitProjectPrompt]
  B[confirmEligibilityLabelCreation] --> W
  C[collectProjectSettings] --> W
  W -.-> L[create/close lifecycle]
  W -.-> P[strict consent parse]
```

## Dropped

| Candidate | Dropped because |
|---|---|
| `daemon-project-snapshot-persist` | Leverage 1 — `daemon.ts:2579-2626` vs `2700-2738` share ~6 lines of policy; the row mappers share no columns, so a shared port pushes the difference into adapters. Complexity **moves**. |
| `daemon-inflight-promise-registration` | Leverage 1 — a real shutdown-drain invariant, but a 3-line helper: interface ≈ implementation. Same class as the already-dropped `mutate-and-publish`. |
| `daemon-poll-pipeline-pair` | Leverage 1 — the issue-poll side additionally owns merge/carry-forward, suppression and `projectModes`; extraction **moves**. |
| `routine-firing-settlement-sequence` | Leverage 1 — the *wide* `1606-1828` vs `1877-2030` mirror has eight genuine divergences (claim read ordering, deadline fail-soft, `withProviderStderrTail`, PR discovery, claim-URL verification) that land as per-path hooks. Superseded by the narrower `routine-firing-terminal-write` above. |
| `doctor-winning-assignment-family` | Not behaviour-preserving — `winningByteSizeAssignment` skips assignments systemd itself rejects and is case-exact; `winningAssignment` reports the last value case-insensitively for drift auditing. Prose at `doctor.ts:968-981` and `1391-1398` documents why. Unifying is a behaviour change, not an extraction. |

Previously-dropped entries re-checked this run and still excluded, filter unchanged:
`probe-shutdown-drift`, `wait-terminal-contract`, `blocked-terminalization-phase`,
`raw-fsm-park-ownership`, `wait-state-predicate-split`, `mutate-and-publish`,
`issue-polling-try-api-wrappers`, `github-pr-enum-normalizers`,
`provider-json-field-accessors`.

## Too large to automate

None. No candidate this run scored blast radius 5.

## Pick

**`editor-save-outcome-epilogue`, 22/25.**

The runner-up **candidate** is `routine-editor-target-prologue`, also **22/25** — a
genuine tie, and the rubric's deterministic tiebreak chain is **exhausted**: both
have blast radius band 1, both have heat 5, and "whose files were touched most
recently" cannot separate them because they are seams in the *same file*
(`src/http/pages.ts`), indeed in the same 3,000-line `registerPages` function.

So the pick is a documented judgement call, on **depth**:
`src/http/save-pipeline.ts` is *already* a deep module for the write half of a save
— it hides validation, the stale check, the atomic rename, and reload capture behind
one call. The respond half of that same contract has no module at all and is written
out longhand in three routes. That asymmetry is the strongest depth argument on the
board: the deepening does not invent a seam, it completes one that the codebase
half-built and then stopped. The prologue candidate is a clean extraction of a
refusal policy, but there is no existing deep counterpart it is failing to match.

Secondary reasons, recorded so a reviewer can disagree with the right thing:

- The epilogue's shared behaviour is load-bearing enough that the codebase restates
  it as prose three times, verbatim (`pages.ts:1762-1766`, `2003-2007`, `2386-2390`).
  A policy needing three identical comments is a policy with no home.
- ADR-0076 is explicitly written "part by part" and anticipates further editors.
  Each new editor pays the epilogue cost again.
- Taking both in one PR would double the blast on the highest-churn file in the
  tree. Per the `resolve-scheduled-dispatch-context` / `handle-scheduled-dispatch-error`
  precedent from the 2026-09-14 run, the coupled pair is split across firings, larger
  first. **`routine-editor-target-prologue` is the natural next firing.**

No hard filter was tripped: leverage is 4 (not 1), blast radius is 1 (not 5), it
contradicts no ADR — ADR-0076 fixes the two-phase POST *route shape* and the rule
that `/edit/confirm` is the only caller of `runSavePipeline`, both of which this
extraction preserves exactly — and current behaviour is pinnable by
`tests/workflow-contract-editor.test.ts`, `tests/service-config-editor.test.ts`,
`tests/routine-declaration-editor.test.ts` and `tests/save-pipeline.test.ts`.

### A claim deliberately *not* made

An earlier draft argued that a fifth `SavePipelineResult` variant would "silently
fall through to 500". That is **false** and is recorded here so it is not
re-derived: the three `if (result.kind === …)` blocks all return, so TypeScript
narrows `result` to `write_failed` afterwards, and a new union member makes
`result.error` a compile error in all three routes. The case for this extraction
rests on triplicated policy and the thrice-copied comment, which is sufficient
on its own.

## Design

Four interfaces were designed in parallel by sub-agents, each briefed to a
*radically different* mandate over the same friction. Every design was told the
same hard fact — the `invalid` branch's per-route divergence is real — and asked
to resolve it differently. All four are recorded, winner and losers, because the
losing reasoning is the part a reviewer most needs in order to disagree.

Shared facts verified against the tree before adjudication, because three of the
four designs turn on them:

- `escapeHtml` is defined **twice** with byte-identical bodies: `src/http/pages.ts:7738`
  (module-private) and `src/notifications/message.ts:18` (exported). `pages.ts:39`
  already imports `formatPullRequestReference` from that very file.
- `csrfTokenFor` and `ensureSession` are exported from `src/http/csrf.js` and already
  imported by `pages.ts`.
- `renderStaleSaveNotice` (`pages.ts:6182`) and `renderReloadFailedNotice` (`:6203`)
  have exactly six call sites, all inside the three spans being deepened.
- `checkStaleRoutineDeclaration(context, input): Response | undefined` (`pages.ts:5960`)
  is the existing in-file precedent for "helper takes the Hono context, returns a
  `Response` the handler returns".

### Design A — `runEditorSave`, minimal surface (`src/http/editor-save.ts`)

One export, nine input fields, `context` as a leading positional parameter.
Returns `Promise<Response | { errors: string[] }>`: a `Response` is finished, and
`{ errors }` is a **compiler-enforced obligation** handed back to the route, which
owes the 422 page. The `invalid` divergence is resolved by *returning* rather than
by a callback — the union return is what tells the caller it still owns that page.

- **Hides**: the write-path gate and its 403, the reload default, the
  write-before-reload ordering and its status code, the stale/write-failed/reload-failed
  pages, and the `?saved=1` / `&saved=1` join.
- **Dependency strategy**: `layout` and `escapeHtml` gain `export` in `pages.ts` and
  are imported back, creating a deliberate `pages.ts → editor-save.ts → pages.ts`
  **import cycle** (argued safe: both are hoisted declarations, neither runs at module
  evaluation, no `import/no-cycle` rule configured).
- **Trade-offs it accepts**: the cycle; and — decisively — **one intentional behaviour
  delta**. It always validates against the logical path, whereas the routine route
  today passes no `validationPath` and so validates against the symlink-resolved path.
  `parseRoutineDeclaration` interpolates that path into its error strings, so
  rendered 422 HTML changes for a symlinked Routine Declaration.

### Design B — `decideEditorSave`, pure decision, no rendering (`src/http/editor-save-outcome.ts`)

Zero framework coupling: the module never touches `context`, never calls `layout`,
never produces HTML. Returns a six-variant discriminated decision
(`refused_write_path` / `invalid` / `stale` / `write_failed` / `saved_inactive` /
`saved_active`), each carrying its status code; the routes `switch` and render.

- **Hides**: the reload gate (as a *fork the compiler makes every caller take*), the
  write-path gate, the reload default, and the status matrix.
- **Self-assessed verdict, which the adjudication accepts**: *"~60% relabelling."*
  Measured route shrinkage is only 15/17/21 lines, and roughly 60 lines enter the new
  module — the tree gets slightly **bigger**. Strip `refused_write_path` and the
  `saved_active`/`saved_inactive` split and what remains is `SavePipelineResult` with
  a status field stapled on.
- **Its own escape route** — returning rendered body HTML plus a title for the four
  branches whose markup is byte-identical across all three routes — is precisely what
  Design C does, and it says so.

### Design C — `createSaveConfirmer`, optimised for the common caller (`src/http/save-confirm.ts`) — **WINNER**

A factory bound **once** at the top of `registerPages`, closing over `csrfSecret`,
`layout`, `resolveWritePath` and `triggerReload`, returning
`confirmSave(context, save): Promise<Response>`. Each route passes one
`SaveConfirmation` literal: `content`, `editAction`, `expectedContentHash`,
`filePath`, `kind`, `name`, `renderInvalid`, `savedRedirect`, and the two
pass-through optionals `validationPath` / `workflowFormat`. The `invalid`
divergence is a caller-supplied `renderInvalid({ csrfToken, errors })` returning
only the **body**; the module owns the title and the 422.

- **Hides**: the write-path gate and its 403; `SavePipelineInput` assembly including
  both `exactOptionalPropertyTypes` conditional spreads; the reload default; the
  write-before-reload re-check; **both derived titles** (`Confirm changes to ${name}`
  and `Saved but not active: ${name}`, verified byte-identical across all three routes);
  `renderStaleSaveNotice` and `renderReloadFailedNotice`, which **move into** the module
  so the markup sits with the policy deciding when to show it; the `saved=1` query
  composition including the `?`/`&` choice; all six status codes; and lazy CSRF minting
  — `ensureSession` can set a session cookie, so minting it outside the `invalid`
  branch would attach `Set-Cookie` to 303s and 409s that carry none today.
- **Dependency strategy — the discriminator.** `save-confirm.ts` imports **nothing**
  from `pages.ts`. `escapeHtml` comes from `src/notifications/message.js` (verified
  byte-identical, and a file `pages.ts` already imports from); `csrfTokenFor` and
  `ensureSession` come from `./csrf.js`; `layout` is injected once at the factory
  because it closes over `STYLES`, `FONT_FACES` and `LOCAL_TIME_CLIENT_JS` and moving
  it is a ~600-line diff. The dependency is strictly one-directional,
  `pages.ts → save-confirm.ts`. `renderEditorPreview` stays in `pages.ts` — it has
  other callers and is the caller's vocabulary, not the module's.
- **Measured**: 278 lines across three handlers → ~57, of which ~40 are the three
  callbacks; new module ≈110 lines including the two moved renderers. Decisions per
  caller drop from 7 to 1.
- **Trade-offs it accepts**: a fourth editor must still write a `renderInvalid`
  closure — the seam makes the 422 uniform, not free; `layout` injection means the
  module's output is only fully determined at the call site; and `confirmSave` is a
  `const` declared ~1600 lines above its first use. Design C's own §6 additionally
  claimed it would have "no unit-test seam by construction"; that claim was wrong and
  was not followed — see the corrected criterion 4 below.
- **One assumption it asserted rather than checked**, verified during implementation:
  the factory captures `options.resolveWritePath` and `options.triggerReload` once at
  `registerPages` time, where the old code read them off `options` per request.
  Neither is ever reassigned anywhere in `src/`, and `src/http/app.ts:915-932` builds
  the options object as a single literal at construction, so factory-time binding is
  observationally identical.
- **Behaviour preservation**: `validationPath` is deliberately **not** defaulted, so
  the routine route's existing validate-against-the-resolved-path behaviour is
  preserved rather than silently unified. This is the point on which it beats Design A.

### Design D — `saveEditableArtifact`, ports and adapters (`src/http/editable-artifact-save.ts`)

A six-member `EditableArtifact` port (`displayName`, `editAction`, `renderInvalid`,
`savedRedirect`, `sourcePath`, `kind`, plus `workflowFormat` on the
`workflow_contract` variant only), a four-member `EditorSaveDeps`, and a two-member
structural `EditorSaveResponder` that a Hono `Context` satisfies without an adapter
object. Three routes construct three adapters.

- **Hides**: the same set as Design C, plus it makes a Service Config structurally
  incapable of carrying a workflow format.
- **Its own honest audit, which decided the adjudication**: of the six port members,
  `editAction` and `savedRedirect` are *not* artifact facts — they vary along URL
  topology and are 1:1 with `kind` only because each artifact type currently has
  exactly one editor. And `renderInvalid` *"does not vary along the artifact axis at
  all"*. So the port models an **editor target**, not an editable artifact: three
  adapters clear the two-adapter bar, but the modelled axis is not the one that varies.
- **Flagged typing risk**: assigning Hono's overloaded generic `html`/`redirect` to a
  monomorphic two-member responder signature may not check, with a documented fallback
  to `responder: Context`.

### Adjudication

Criteria, applied in this order: **(1) depth** — behaviour per unit of interface a
caller must learn; **(2) locality** — where change, bugs and verification concentrate
afterwards; **(3) seam placement** — is the seam where something actually varies;
**(4) test surface** — can the behaviour be exercised through the interface without
reaching past it; **(5) blast radius** — the smaller diff wins between otherwise-equal
designs. The winner was picked by consulting the advisor against the four written
designs above.

**Winner: Design C (`createSaveConfirmer`).**

1. **Depth.** C hides the most behaviour per unit of interface: nine fields (two of
   them pass-through optionals) absorb the gate, six status codes, two derived titles,
   two moved renderers, the redirect separator, lazy CSRF, and the reload re-check.
   B hides materially less and says so. D hides the same as C but charges more for it
   — a 6-member port *plus* a 4-member deps record *plus* a 2-member responder, versus
   C's one literal and one factory binding.
2. **Locality.** C and D tie; A and B are behind, B because the `switch` in each route
   costs about what the `if` chain cost.
3. **Seam placement.** The decisive axis, and it separates C from D. D's own analysis
   establishes that its port models editor-target identity while calling it an
   artifact — two of six members vary along URL topology, and `renderInvalid` varies
   along no principled axis at all. C makes no such claim: it takes a `SaveConfirmation`
   describing *this save*, which is exactly what varies.
4. **Test surface.** All four admit a unit seam, and C's survives this repo's `knip`
   scope (`src/**`) without an exception: `createSaveConfirmer` is a legitimately-used
   `src/**` export because `pages.ts` calls it, so a test importing it as well is
   free; only the `SaveConfirmation` and deps types must stay unexported.
   **Corrected after implementation**: this section originally claimed C
   "deliberately does not" admit a unit seam, following Design C's own §6. That was
   wrong, and the shipped `tests/save-confirm.test.ts` disproves it — six behaviours
   are pinned through `createSaveConfirmer` with a temp dir and a bare Hono route, no
   `createHttpApp`, no CSRF session, no Service Config. The correction strengthens the
   adjudication rather than weakening it: C is not weakest on this criterion after
   all, so criterion 4 no longer costs it anything.
5. **Blast radius.** C is smallest in `src/` net terms and, unlike D, carries no
   flagged typing risk.

**Runner-up design: Design D (`saveEditableArtifact`).** It lost on criterion 3, on
its own evidence: with three adapters it clears the "two adapters means a real seam"
bar, but the axis the port models is not the axis that varies. Its discriminated
`workflow_contract`-carries-`workflowFormat` union is genuinely better than C's two
loose optionals, and is the thing worth revisiting if a fourth editor lands.

**Design A** was eliminated on behaviour preservation rather than on the criteria: it
requires an intentional change to routine-declaration 422 error text. A behaviour-
preserving deepening is what was scored and picked; changing behaviour is a separate
decision a human should take. Its import cycle is a second, lesser mark against it,
and is avoidable — Design C's `escapeHtml`-from-`notifications/message.js` route was
verified byte-identical, so the cycle is not forced by the problem.

**Design B** was eliminated on criterion 1 by its own measurement.
