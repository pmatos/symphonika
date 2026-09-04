# Architecture review — symphonika — 2026-09-04

**Scope**: Hot-spot scan weighted by recent `git log` — the Agent Provider adapters
(`src/providers/{codex,claude,omp}.ts`, most-changed after run-store/run-controller) plus a fresh
sub-agent sweep of `run-store.ts`, `run-controller.ts`, `daemon.ts`, `http/pages.ts`,
`routines/dispatcher.ts`, `reload.ts`, `issue-polling.ts`, `http/app.ts`, and
`pull-request-followup.ts`. Reconciled against `.architecture/backlog.md` and open/merged PRs.
**Picked**: `provider-run-harness` — see [PR #701](https://github.com/pmatos/symphonika/pull/701) and `.architecture/backlog.md`
**Degradations**: none — `gh` authenticated, sub-agent explore available, full quality gate discoverable.

In the Mermaid diagrams, **solid edges are the interface** a caller wires by hand; **dashed edges are
inside the implementation** the seam hides.

## Candidates

### `provider-run-harness` — one Agent Provider session harness behind the three runAttempts  ·  Strong  ·  score 20/25

- **Files**: `src/providers/codex.ts:120-192` (prologue), `:331-349` (`finally`), `:85-118` (cancel);
  `src/providers/claude.ts:75-127` (prologue), `:173-191` (`finally`), `:56-73` (cancel);
  `src/providers/omp.ts:137-183` (prologue), `:324-338` (`finally`), `:110-135` (cancel); new
  `src/providers/provider-session.ts` + `tests/provider-session.test.ts`. **File-count estimate: ~5.**
- **Score 20/25** — leverage 4, locality 4, blast radius 2, heat 4:
  - *Leverage 4*: three call sites each shed a byte-identical ~55-line ADR-0052 prologue and an
    identical ADR-0064 `finally`; the placeholder-`activeRun` cancel race is defined once instead of
    three times, so a future provider stops re-deriving it. Not 5 — the protocol bodies stay
    provider-specific, so no whole class of test setup disappears.
  - *Locality 4*: the pre-spawn cancel race (ADR 0052), the scratch/scope/stderr wiring, and the
    scope-cleanup `finally` (ADR 0064) become a one-file edit; today a fix to any of them is a
    three-file edit that must stay in sync (the omp copy already carries a `// Same …` annotation
    admitting the drift risk).
  - *Blast radius 2*: a module and its three direct callers; no published interface changes — the
    exported `create{Codex,Claude,Omp}Provider` signatures and the `AgentProvider` shape are unchanged.
  - *Heat 4*: `codex.ts` (11), `claude.ts` (7), `omp.ts` (6) are all in the top of the 60-commit
    change-frequency list; recent provider churn (#672 omp exit close time, #684 scope-cleanup
    persistence, #680 codex plans) keeps touching exactly this prologue/finally region.
- **Problem**: The three `runAttempt` generators are **shallow at their shared edges**. Each opens
  with the same sequence — register a placeholder `activeRun` *before* the `wrapForProviderScope`
  await (so a cancel landing during the probe has somewhere to go, ADR 0052), render the command
  template, wrap for the provider scope, re-check `cancelled` and emit a synthetic `process_exit`,
  `markProviderScopeCleanupPending`, spawn, attach the stderr tee, build the queue — and each closes
  with the same `finally`: `activeRuns.delete`, `confirmProviderScopeCleanup`, `stderrCapture.waitForFlush`.
  The `attachProviderStderrLog` call, the `confirmProviderScopeCleanup` call, and the `waitForFlush`
  call (with its comment) are **byte-identical** across all three files. The interface a reader must
  learn to understand one provider is nearly the whole prologue; the genuinely provider-specific
  part is only the protocol body between them.
- **Deletion test**: **Concentrates.** Delete the harness and the ADR-0052 pre-spawn cancel race and
  the ADR-0064 scope-cleanup ordering must be re-stated at every provider that spawns a process —
  which is exactly today's state and exactly what keeps producing paired edits (#672/#684 touched two
  of the three copies). A single `runProviderSession` owning the race and the teardown concentrates
  that invariant in one tested place; the protocol bodies, which really do differ, stay at the edges.
- **Solution**: Introduce `runProviderSession(deps, input)` in `src/providers/provider-session.ts`.
  It owns the prologue and the `finally`, and yields to the provider through a small set of hooks:
  an `activeRun` factory, a command transform applied before `wrapForProviderScope`, spawn-env
  extras, a synthetic cancel-exit event factory, a queue factory, and the protocol body itself
  (an async generator taking the spawned child + queue + activeRun). A companion `cancelProviderRun`
  helper owns the shared cancel shape (look up, set `cancelled`, `shutdownProviderProcess` with a
  provider-specific interrupt body). The three adapters keep their exported factories and shrink to
  their protocol bodies + hook wiring.
- **Benefits**: **Leverage** — a fourth provider adapter, or a change to the cancel race, is written
  once. **Locality** — the ADR-0052/0064 invariants live in one module with one test file, instead
  of being characterization-tested three times through three fake subprocesses. **Test surface** —
  the harness's prologue/finally can be exercised through a trivial fake protocol-body hook and a
  recording `processScope`, without a per-provider fake-subprocess transcript, so the race and the
  teardown ordering get direct unit coverage they lack today.

**Before** — each provider wires the shared prologue/finally itself:

```mermaid
graph LR
  CX[codex.runAttempt] --> P1[register placeholder activeRun]
  CX --> P2[wrapForProviderScope + cancel recheck]
  CX --> P3[spawn + stderr + queue]
  CX --> P4[finally: delete + confirmCleanup + waitForFlush]
  CL[claude.runAttempt] --> P1
  CL --> P2
  CL --> P3
  CL --> P4
  OM[omp.runAttempt] --> P1
  OM --> P2
  OM --> P3
  OM --> P4
```

**After** — one harness owns them; providers pass their protocol body as a hook:

```mermaid
graph LR
  CX[codex.runAttempt] --> H[runProviderSession]
  CL[claude.runAttempt] --> H
  OM[omp.runAttempt] --> H
  H -.-> P1[register placeholder activeRun]
  H -.-> P2[wrapForProviderScope + cancel recheck]
  H -.-> P3[spawn + stderr + queue]
  H -.-> P4[finally: delete + confirmCleanup + waitForFlush]
  H -.-> B[provider protocol body hook]
```

### `config-project-parse-outcome` — shared project-section parse gate in reload  ·  Worth exploring  ·  score 17/25

- **Files**: `src/reload.ts:1095-1195` (`loadDispatchProject`), `:1200-1263` (`loadRoutineHostProject`);
  shared idiom also at `:651`, `:696`. **File-count estimate: ~3** (`reload.ts` + a small
  `project-config-parse.ts` + test).
- **Score 17/25** — leverage 3, locality 4, blast radius 1, heat 3:
  - *Leverage 3*: two sibling loaders repeat a **byte-identical** 15-line watchdog-override
    whole-snapshot-rejection block (`:1121-1136` vs `:1218-1233`, the second annotated `// Same …`)
    and a structurally identical reload-vs-first-load fatal-decision block (`:1138-1148` vs
    `:1235-1245`); collapsing them concentrates two real policy invariants, but the surrounding
    zod-error-push idiom is pure DRY that would move, not concentrate — so 3, not 4.
  - *Locality 4*: single file today, single seam afterwards.
  - *Blast radius 1*: contained to `reload.ts` + a helper + test; no published interface.
  - *Heat 3*: `reload.ts` is on the hot list (#685 config-validation churn) but the project-loader
    region specifically is quieter than the provider prologue.
- **Problem**: The dispatch-project and routine-host loaders are drifting twins. The SPEC-5.1
  watchdog-override rejection and the reload/first-load "revert whole snapshot vs drop one project"
  fatal-decision policy are each duplicated verbatim, each with its own explanatory comment — a reader
  must read both copies to trust either.
- **Deletion test**: **Partially concentrates.** A `parseProjectSection(schema, raw, prefix, errors)`
  plus a `watchdogOverrideGate(rawProject, index, errors)` would own the two invariants once; the
  loaders' tails (dispatch: polling + workflow load + `disabled` carry-forward; host: `agent` + `mode`,
  no workflow) genuinely differ and stay separate. Real but sub-20 — recorded for a future firing.
- **Solution**: Lift the watchdog-override gate and the project-section parse-and-fatal-decide into a
  shared `project-config-parse.ts`, leaving each loader its distinct tail.
- **Benefits**: **Locality** — the whole-snapshot-rejection invariant lives in one place. **Test
  surface** — the fatal-decision policy becomes unit-testable without constructing two full config
  loads.

**Before**:

```mermaid
graph LR
  D[loadDispatchProject] --> W1[watchdog-override reject]
  D --> F1[parse + fatal decide]
  H[loadRoutineHostProject] --> W2[watchdog-override reject dup]
  H --> F2[parse + fatal decide dup]
```

**After**:

```mermaid
graph LR
  D[loadDispatchProject] --> G[parseProjectSection + watchdogOverrideGate]
  H[loadRoutineHostProject] --> G
  G -.-> W[watchdog-override reject]
  G -.-> F[parse + fatal decide]
```

## Dropped

No new hard-filter drops this run. The standing `dropped` entries — `mutate-and-publish`,
`github-pr-enum-normalizers`, `provider-json-field-accessors` (all leverage 1, fail the deletion
test) — were re-checked against their filters and still apply; they remain `dropped` in the backlog.
The fresh scan's near-misses (`issue-polling.ts` `try*` API wrappers, `http/app.ts` artifact-stream
trio, `daemon.ts` poll-state twins, `pull-request-followup.ts` loop prologue,
`fsm-expansion.ts` codec pairs) were rejected before scoring: each either fails the deletion test
(complexity moves to callers) or is already territory of an existing backlog item
(`artifact-kind-catalog`, `daemon-project-state-projection`).

| Candidate | Dropped because |
|---|---|
| `issue-polling-try-api-wrappers` | Leverage 1 — shallow-by-nature guards; collapsing strips the `this` binding and moves the guard to callers |
| `app-artifact-stream-trio` | Not new — the artifact-kind catalog it shares is already owned by `artifact-kind-catalog` (add `http/app.ts` to that item's scope, don't split) |

## Too large to automate

None surfaced this run (no blast-radius-5 candidate). The largest eligible candidate,
`run-slot-lease` (19/25, blast radius 3, ~5 files), is one-PR-sized and stays `proposed`.

## Pick

**`provider-run-harness` (20/25).** It is the top surviving candidate after the hard filters, and it
was the exactly-tied runner-up to last firing's `watchdog-subject-port` (#695, now merged) — the
natural next firing. The runner-up **candidate** this run is `run-slot-lease` (19/25), **within 1
point**, so the pick was close: `run-slot-lease` is the natural next firing after this one. It lost
on two axes — a **partial** deletion test (each bounded op still names its own `.race()` at the call
site, so complexity only partly concentrates) and a larger blast radius (3 vs 2, ~5 files crossing
more of `run-controller.ts`). `provider-run-harness`'s deletion test is cleaner: the ADR-0052 cancel
race and ADR-0064 teardown fully concentrate into one module.

The friction was re-verified against the current tree this run: the prologue, `finally`, and cancel
shapes are still near-identical across the three providers, and the stderr-attach /
`confirmProviderScopeCleanup` / `waitForFlush` calls are still byte-identical.

## Design

Produced by three parallel design sub-agents (one interface each: minimal, maximally flexible,
common-case-optimised), then chosen by a fourth **non-author adjudicator** against the fixed criteria
(depth → locality → seam placement → test surface → blast radius). Dependency category: **in-process
orchestration + local-substitutable** — `processScope` is already an injected seam with a
`noopProcessScope`/recording test stand-in, and the spawn/stderr/queue helpers are already exercised
through env-driven fake-subprocess transcripts. **No new external port is introduced** (one adapter =
a hypothetical seam).

### Winner — Design C, "common-case optimised"

A new deep module `src/providers/provider-session.ts` exporting:

- `createProviderSession<RunState extends ProviderRunState, Queue>(config): Pick<AgentProvider, "name" | "cancel" | "runAttempt">`
  — owns the `activeRuns` Map, the ADR-0052 register-before-await cancel race, the prologue, the
  `finally` (delete → optional benign shutdown → `confirmProviderScopeCleanup` → `waitForFlush`), and
  `cancel()`.
- `jsonlProviderSession<RunState>(configWithoutCreateQueue)` — a convenience that fixes the queue to
  `createJsonlProcessQueue`, so the two alike providers (codex, claude) **never name a queue**.

`ProviderRunState = { cancelled: boolean; child?: ChildProcessWithoutNullStreams }`; each provider's
activeRun extends it, so `cancelled`/`child` stay where the existing per-provider helpers already read
them. `config`: `name`, `label`, `processScope`, `createRunState()`, `createQueue(child, input, run)`,
`runTurn(turn)` (an async generator; `turn.run` is narrowed to `RunState & { child }`, which deletes
codex's `SpawnedCodexRun` alias and its `as` cast), plus optionals `refineCommand?`, `extraEnv?`,
`cancelInterrupt?(run, child) → (() => void) | undefined` (two-phase: a synchronous side effect now,
a returned `beforeClose` courtesy later), and `shutdownChildOnFinish?: boolean` (a **boolean, not a
hook**, for omp's single fixed benign finally shutdown). The synthetic cancelled-before-spawn
`process_exit` is proven byte-identical across all three providers (the branch only runs when
`cancelled === true`) and folds to one `cancelledBeforeSpawnExit()` factory; omp's now-unused
`processExitEvent` is deleted.

Common case (codex/claude): 5 required fields + 0–2 optionals. Outlier (omp): `createProviderSession`
directly with its own `createQueue` (stashing the queue on its own run for cancel), `cancelInterrupt`,
and `shutdownChildOnFinish: true`.

**Why it won**, walking the criteria: *Depth* — `jsonlProviderSession` gives the two-of-three common
case the smallest interface (the shared JSONL queue is hidden, not re-named per provider). *Locality*
— it disturbs existing provider internals least; `cancelled`/`child`/`queue` stay on the run object
the current helpers read, so post-refactor bugs concentrate in the harness rather than across
rethreaded call sites. *Seam placement* — the only design that reduces omp's single fixed shutdown to
a boolean instead of spending a general hook, and hard-codes the one-spawn/one-queue shape because it
genuinely never varies. *Blast radius* — smallest (deletes a cast and a dead helper rather than
relocating state). *Test surface* — an effective tie; a slight edge from a required `processScope` and
the smallest trivial `runTurn`.

### Runner-up design — Design A, "minimal interface"

`createProviderSession<R, Q>(config) → { runAttempt, cancel }`, harness owning the Map (and stashing
the queue on a harness-side `SessionEntry`). It lost on **depth at the common case**: it forces codex
*and* claude to supply a `createQueue` factory for the JSONL queue they **share**, and spends a
general `beforeCleanup` hook on omp's **single** fixed shutdown — where the winner hides the shared
queue behind `jsonlProviderSession` and reduces the one-off to a boolean (a deeper common case with an
honest seam instead of a hypothetical one). A's shared *frozen* synthetic-exit constant is
behaviour-safe but converts any missed mutation into a `TypeError`; the winner's fresh-object factory
sidesteps the question. Otherwise strong and close.

### Losing design — Design B, "maximally flexible"

`createProviderSessionRunner<S, T>(deps, definition)` with a 9-field definition, a generic transport
`T` the harness stores but never inspects, and a capability object handed to a free-form `drive`. It
placed last: surface bloat and depth dilution (`drive` is a near-total escape hatch — deep at the rim,
hollow in the centre), a zero-implementation `cancelledBeforeSpawnEvent` port and duplicated `input`
params (speculative surface no current provider uses), and the **highest churn** — relocating
`cancelled`/`child` off every provider's run object forces rethreading all three adapters' reads, not
just omp's.

### Adjudicator's verified implementation constraints (carried into step 5)

- Synthetic cancelled-exit is byte-identical (incl. key order) across `codex.ts`, `claude.ts`, and
  omp's `processExitEvent` on the `cancelled === true` branch — the fold is behaviour-preserving.
- Deleting omp's `processExitEvent` is required once folded (its only caller is the cancel-race yield),
  or `noUnusedLocals`/knip fails.
- `runTurn`'s `run: RunState & { child }` narrowing removes codex's `SpawnedCodexRun` cast at the
  spawn site; `readUntilResponse`'s param must be retyped to the narrowed type.
- `knip` (`src/**` scope): export only the types a provider actually *annotates*; a config/context type
  reachable purely by contextual inference will fail as an unused export — drop its `export`.
- `shutdownChildOnFinish` must fire strictly between `activeRuns.delete` and
  `confirmProviderScopeCleanup`, mirroring omp's current `finally` order.

_Designs were produced by parallel sub-agents; the adjudicator authored none of them._
