# Workflow module boundaries follow contract loading, FSM expansion, and Autonomous Prompt rendering

Status: Proposed

Symphonika will split the current `src/workflow.ts` implementation into three domain modules plus a
shared types module: Workflow Contract loading, FSM expansion, Autonomous Prompt rendering, and
workflow graph types. The existing `src/workflow.ts` file remains as a compatibility facade during
the migration so existing callers keep the same public Interface names and shapes.

`ExpandedWorkflow`, `WorkflowAction`, `WorkflowPredicateMap`, and related graph types belong in the
shared types module because they are runtime contracts consumed by dispatch, reconciliation,
operator surfaces, and tests. The FSM expansion module owns construction and validation of those
objects, but runtime consumers should not need to depend on parser or template-loader internals.

Workflow Template inputs belong to FSM expansion rather than Autonomous Prompt rendering. Template
inputs are typed scalar DSL values resolved while expanding a repository workflow into an executable
graph, and they can fill fields such as `action.provider`, `action.method`, predicates, and prompt
paths. Autonomous Prompt rendering happens later for one provider attempt against normalized
project, issue, workspace, branch, run, and provider context. Both paths remain governed by ADR 0034
strict templating, but their variable scopes and failure modes are intentionally separate.

The detailed proposal and test migration map live in
`docs/specs/2026-05-15-workflow-module-split-proposal.md`. Implementation PRs should wait for human
review of that proposal and then migrate one sub-domain at a time.

## Internal Import Policy Addendum (2026-07-30)

With #156–#159 landed, `src/workflow.ts` is a pure re-export facade, and the proposal's
Implementation Sequencing step 5 deferred one question until callers stabilized: should internal
callers keep importing from the facade, or import directly from the submodule that owns the export
they need? Issue #160 tracks this decision.

**Decision: internal callers import directly from the owning submodule** (`workflow/types.ts`,
`workflow/contract-loading.ts`, `workflow/fsm-expansion.ts`, `workflow/autonomous-prompt.ts`).
`src/workflow.ts` remains in place and keeps re-exporting every public name unchanged. `symphonika`
is `"private": true` and not currently published, so the facade is not insulating an existing
external consumer today; it is retained as the designated surface for if/when the package is
published, and as the anchor for the facade-integrity tests described below. Internal code no
longer has a reason to route through it.

Two alternatives were weighed:

- **Keep the facade for internal use too.** Minimizes import churn and hides submodule layout from
  internal callers. Rejected because the insulation a facade buys is strongest for consumers who
  cannot fix their own imports when internals move — external package consumers, which symphonika
  does not yet have. Internal callers live in the same repository, so when a boundary changes the
  same PR that moves the code can update the callers; there is little churn actually being saved.
  Routing everything through one file also hides which submodule a given import actually depends
  on, which works against the point of having ADR-0051 module boundaries in the first place: it
  makes cross-module coupling invisible in normal code review instead of visible in the `import`
  line. `src/routines/prompt-renderer.ts` (added 2026-05-22, after the split landed) already imports
  `renderAutonomousPrompt` and friends directly from `workflow/autonomous-prompt.js` rather than
  through the facade — evidence that direct import is the path of least resistance once the
  submodules exist, not an inconsistency introduced against a working convention.
- **Direct submodule imports (chosen).** Makes each internal file's real dependency on Workflow
  Contract loading, FSM expansion, Autonomous Prompt rendering, or shared types explicit at the
  import site, matching the boundaries this ADR defines. Codifies the pattern
  `prompt-renderer.ts` already uses instead of leaving it as an outlier. Symphonika has no bundler —
  `npm run build` is a plain `tsc -p tsconfig.build.json` emit to `dist/` — so this is not a
  tree-shaking argument. A named re-export is a pointer, not `#include`-style text substitution, so
  the facade was never paying a transitive-recompilation or binary-bloat cost the way a C umbrella
  header would; the only cost being traded away is import-site traceability, and directness wins
  that trade for internal code.

**Tests keep a deliberate exception.** `tests/workflow-contract-loading.test.ts`,
`tests/workflow-fsm-expansion.test.ts`, and `tests/workflow-types.test.ts` each import the same
values or types from both `src/workflow.js` and the owning submodule (aliased, e.g.
`loadWorkflowContract` vs. `loadWorkflowContractFromFacade`) and assert the two are equal — a direct
automated guard for this ADR's requirement that no export disappears from `src/workflow.ts`.
`tests/autonomous-prompt.test.ts` is weaker: it imports `loadExpandedWorkflow`, `persistRunEvidence`,
and `renderAutonomousPrompt` only from `src/workflow.js` and asserts rendered prompt output is
"stable through the workflow facade," which exercises the facade path but does not assert
facade/submodule equality the way the other three do — the Autonomous Prompt module has no parity
check today. All four files keep their existing facade import and are not part of the migration
below; every other internal test file migrates to importing only from the submodule it exercises,
same as `src/`.

Follow-up, landed in the same change as this addendum: the internal `src/` and `tests/` callers
previously importing via `./workflow.js` now import from their owning submodule, and `npm run
quality` was run. `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run build`, and
`npm test` (minus one pre-existing, environment-specific `npm link` test failure unrelated to this
change — reproduces identically against this same commit before the rewrite) all pass:

- `src/`: `cli.ts`, `doctor.ts`, `http/pages.ts`, `lifecycle/pr-signal-projection.ts`,
  `lifecycle/run-controller.ts`, `lifecycle/state-machine-dispatch.ts`, `reload.ts`, `run-store.ts`
- `tests/`: `daemon-dispatch.test.ts`, `property-invariants.test.ts`,
  `routine-prompt-renderer.test.ts`, `state-machine-dispatch.test.ts`

No export disappears from `src/workflow.ts` (the file has no diff hunk in this change).

This ADR's `Status` above is still `Proposed`; whether landing this addendum also promotes it to
`Accepted` is a separate call left to the maintainer.
