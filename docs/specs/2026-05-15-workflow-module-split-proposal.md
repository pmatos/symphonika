# Workflow Module Split Proposal

Status: proposed
Date: 2026-05-15
Issue: #144

## Goal

Split `src/workflow.ts` along the ADR boundaries that already exist in the product model, without
moving implementation code in this proposal PR. The implementation PRs should move one sub-domain at
a time while preserving every current public export name and shape through the existing
`src/workflow.ts` compatibility facade.

The current file mixes three responsibilities:

- Workflow Contract loading: repository-owned `WORKFLOW.md` or `workflow.yml` discovery,
  front-matter validation, format selection, and Project workflow binding.
- FSM expansion: raw state parsing, `uses:` template expansion, predicate/action validation,
  builtin-template resolution, and expanded-graph explanation.
- Autonomous Prompt rendering: strict prompt variable substitution, autonomy preamble rendering, and
  rendered prompt evidence.

## Target Layout

The target split uses four new domain files. `src/workflow.ts` remains as a compatibility facade
that re-exports the public Interface and contains no domain logic after migration.

| Path | Responsibility | Public exports |
| --- | --- | --- |
| `src/workflow/types.ts` | Shared workflow graph and predicate/action types consumed by runtime, CLI, tests, and the other workflow modules. | `WorkflowSourceKind`, `WorkflowActionKind`, `WorkflowPredicateValue`, `WorkflowPredicateMap`, `WorkflowAction`, `WorkflowTransition`, `ExpandedWorkflowState`, `ExpandedWorkflow` |
| `src/workflow/contract-loading.ts` | Load and validate repository-owned Workflow Contracts and prompt-adjacent front matter. It may expose project workflow reference helpers to the FSM loader, but it should not expand raw FSM graphs itself. | `WorkflowContract`, `loadWorkflowContract`, `parseWorkflowContract`, `validateWorkflowContract`, `validateWorkflowTemplate` |
| `src/workflow/fsm-expansion.ts` | Convert Markdown compatibility workflows and raw FSM YAML/JSON into an Expanded Workflow Graph, including template loading, builtin-template resolution, reference checks, and explain output. | `ExpandedWorkflowLoadResult`, `ProjectWorkflowLoadResult`, `loadExpandedWorkflow`, `loadProjectWorkflow`, `validateExpandedWorkflowReferences`, `explainWorkflow`, `expandWorkflowDefinition` |
| `src/workflow/autonomous-prompt.ts` | Render and persist the Autonomous Prompt sent to Codex or Claude for a provider attempt. | `AUTONOMY_PREAMBLE_VERSION`, `PromptProject`, `PromptWorkspace`, `PromptBranch`, `PromptRun`, `PromptProvider`, `RenderAutonomousPromptInput`, `RenderedAutonomousPrompt`, `PersistRunEvidenceInput`, `RunEvidencePaths`, `renderAutonomousPrompt`, `persistRunEvidence` |

`loadProjectWorkflow` belongs with `fsm-expansion.ts` because its public contract is "return the
project-selected Expanded Workflow Graph." The service-config reference parsing it needs should be
kept as narrow helpers from `contract-loading.ts`, so CLI callers do not learn about loader internals.

## Export Mapping

| Current export in `src/workflow.ts` | New home |
| --- | --- |
| `AUTONOMY_PREAMBLE_VERSION` | `src/workflow/autonomous-prompt.ts` |
| `PromptProject` | `src/workflow/autonomous-prompt.ts` |
| `PromptWorkspace` | `src/workflow/autonomous-prompt.ts` |
| `PromptBranch` | `src/workflow/autonomous-prompt.ts` |
| `PromptRun` | `src/workflow/autonomous-prompt.ts` |
| `PromptProvider` | `src/workflow/autonomous-prompt.ts` |
| `RenderAutonomousPromptInput` | `src/workflow/autonomous-prompt.ts` |
| `RenderedAutonomousPrompt` | `src/workflow/autonomous-prompt.ts` |
| `PersistRunEvidenceInput` | `src/workflow/autonomous-prompt.ts` |
| `RunEvidencePaths` | `src/workflow/autonomous-prompt.ts` |
| `WorkflowContract` | `src/workflow/contract-loading.ts` |
| `WorkflowSourceKind` | `src/workflow/types.ts` |
| `WorkflowActionKind` | `src/workflow/types.ts` |
| `WorkflowPredicateValue` | `src/workflow/types.ts` |
| `WorkflowPredicateMap` | `src/workflow/types.ts` |
| `WorkflowAction` | `src/workflow/types.ts` |
| `WorkflowTransition` | `src/workflow/types.ts` |
| `ExpandedWorkflowState` | `src/workflow/types.ts` |
| `ExpandedWorkflow` | `src/workflow/types.ts` |
| `ExpandedWorkflowLoadResult` | `src/workflow/fsm-expansion.ts` |
| `ProjectWorkflowLoadResult` | `src/workflow/fsm-expansion.ts` |
| `renderAutonomousPrompt` | `src/workflow/autonomous-prompt.ts` |
| `loadWorkflowContract` | `src/workflow/contract-loading.ts` |
| `loadExpandedWorkflow` | `src/workflow/fsm-expansion.ts` |
| `validateExpandedWorkflowReferences` | `src/workflow/fsm-expansion.ts` |
| `loadProjectWorkflow` | `src/workflow/fsm-expansion.ts` |
| `explainWorkflow` | `src/workflow/fsm-expansion.ts` |
| `validateWorkflowContract` | `src/workflow/contract-loading.ts` |
| `parseWorkflowContract` | `src/workflow/contract-loading.ts` |
| `validateWorkflowTemplate` | `src/workflow/contract-loading.ts` |
| `expandWorkflowDefinition` | `src/workflow/fsm-expansion.ts` |
| `persistRunEvidence` | `src/workflow/autonomous-prompt.ts` |

Private helpers should move with the public function that uses them most directly:

- `resolveWorkflowFormat`, `projectWorkflowReferences`, `parseWorkflowReference`, and
  `selectProjectWorkflow` are loader/reference helpers.
- `parseExplicitWorkflowDefinition`, `expandRawStateMachineWorkflow`, `parseWorkflowTemplateUses`,
  `loadWorkflowTemplateUses`, `loadWorkflowTemplate`, `loadBuiltinWorkflowTemplate`,
  `parseWorkflowTemplate`, `parseWorkflowTemplateInputs`, `expandWorkflowTemplateUse`, and
  `templateExitStateMap` are FSM expansion helpers. `parseExplicitWorkflowDefinition` parses the raw
  FSM top-level `workflow` mapping, so it owns raw FSM structural knowledge and must live with
  `fsm-expansion.ts`; otherwise `contract-loading.ts` would have to understand raw FSM structure,
  which contradicts the boundary set above.
- `resolveTemplateValue`, prompt allow-lists, previous-attempt notice rendering, and evidence file
  naming are Autonomous Prompt helpers.

## ADR Ownership

| ADR | Governing module after split |
| --- | --- |
| ADR 0017, standard autonomy prompt preamble | `src/workflow/autonomous-prompt.ts` owns the preamble text and version export. ADR 0043's v2 extension follows the same module. |
| ADR 0029, store rendered provider prompts | `src/workflow/autonomous-prompt.ts` owns prompt/evidence persistence. It imports `ExpandedWorkflow` only as evidence data, not as an expansion dependency. |
| ADR 0033, workflow contract required for dispatch | `src/workflow/contract-loading.ts` owns missing/invalid contract behavior and the "no generic fallback" rule. |
| ADR 0034, strict simple workflow templating | Split by use site: `autonomous-prompt.ts` owns provider prompt variables, while `fsm-expansion.ts` owns Workflow Template input interpolation. `contract-loading.ts` keeps the public `validateWorkflowTemplate` entry point for Markdown contract validation. |
| ADR 0035, workflow front-matter scope | `src/workflow/contract-loading.ts` owns the forbidden service-config key checks. |
| ADR 0045, persist expanded workflow graph | `src/workflow/fsm-expansion.ts` owns graph construction and explanation; `src/workflow/types.ts` owns graph shape; `autonomous-prompt.ts` persists the graph as run evidence. |
| ADR 0049, built-in workflow templates | `src/workflow/fsm-expansion.ts` owns builtin template resolution and expansion. `src/builtin-templates.ts` remains the builtin YAML registry. |

## Shared Types Decision

`ExpandedWorkflow`, `WorkflowAction`, and `WorkflowPredicateMap` should live in
`src/workflow/types.ts`, not in `fsm-expansion.ts`.

These types are runtime contracts consumed by `state-machine-dispatch`, `run-controller`,
`pr-signal-projection`, CLI/operator surfaces, and tests. Placing them in the FSM expansion module
would make runtime code depend on parser/loader internals. The expansion module should own how graph
objects are built and validated; the shared types module should own the stable shape that downstream
runtime code executes.

## Template Inputs Decision

Template inputs, including `parseWorkflowTemplateInputs`, are part of FSM expansion, not Autonomous
Prompt rendering.

The decisive boundary is when and what they render:

- Workflow Template inputs are typed scalar DSL values resolved during workflow reload/expansion,
  before a Run is launched.
- They can fill non-prompt fields such as `action.provider`, `action.method`, predicates, and paths,
  so treating them as provider-prompt rendering would blur the workflow graph contract.
- Autonomous Prompt rendering happens later, for one provider attempt, against normalized
  `project`, `issue`, `workspace`, `branch`, `run`, and `provider` context.

Both features use strict `{{ }}` syntax under ADR 0034, but they have different variable scopes and
failure modes. The implementation should keep them separate even if a tiny scanner helper is shared
internally.

## Test Migration Map

| Current block in `tests/workflow.test.ts` | Target test file |
| --- | --- |
| `describe("workflow prompt rendering")` | `tests/autonomous-prompt.test.ts`. The front-matter-only loading assertion inside this block can move to `tests/workflow-contract-loading.test.ts`; prompt rendering and evidence assertions stay here. |
| `describe("state machine workflow definitions")` | `tests/workflow-fsm-expansion.test.ts`. |
| `describe("built-in workflow templates")` | `tests/workflow-fsm-expansion.test.ts`, kept as a separate describe block because builtins are one expansion source, not a separate runtime path. |
| `describe("workflow format routing")` | `tests/workflow-contract-loading.test.ts`, because format selection is a loader concern even though the public helper returns an expanded graph. |
| `describe("validateExpandedWorkflowReferences")` | `tests/workflow-fsm-expansion.test.ts`. |

The first implementation PR should add a representative `renderAutonomousPrompt` snapshot through
the public `src/workflow.ts` facade before moving prompt code. After the move, the same snapshot
must pass byte-for-byte to prove the Autonomous Prompt output did not change.

## Implementation Sequencing

1. Move shared type aliases and interfaces to `src/workflow/types.ts`; leave `src/workflow.ts` as a
   re-exporting facade and update type-only imports where it reduces cycles.
2. Move Autonomous Prompt rendering and evidence persistence to
   `src/workflow/autonomous-prompt.ts`; add the prompt snapshot before moving code.
3. Move Workflow Contract parsing and validation to `src/workflow/contract-loading.ts`; migrate the
   front-matter and Markdown validation tests.
4. Move FSM expansion and explain/reference validation to `src/workflow/fsm-expansion.ts`; migrate
   raw FSM, Workflow Template, builtin-template, and reference-validation tests.
5. Only after callers are stable, decide whether internal imports should use the new submodules
   directly or keep importing from the `src/workflow.ts` facade. Public names should remain
   available from the facade throughout the refactor.

Each implementation PR should run `npm run lint`, `npm run typecheck`, `npm test`, and
`npm run build`.
