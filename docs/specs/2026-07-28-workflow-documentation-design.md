# Workflow Tutorial and Language Reference

Status: approved
Date: 2026-07-28

## Context

`docs/tutorial.md` currently succeeds as a first-install and first-run walkthrough, but it teaches
only the Markdown `WORKFLOW.md` compatibility path in depth. The substantially richer raw-FSM YAML
language is reduced to a short list of links near the end. An operator can finish the tutorial
without learning that Symphonika can coordinate multiple agent states, route states to different
providers, wait on pull-request observations, run repair loops, merge under policy, or compose
reusable workflow templates.

Routines were added later and are absent from the tutorial. They are related to workflows in the
broad sense of autonomous work, but they use a different execution model: a Routine is a scheduled
Markdown prompt declaration targeting a Project, while a raw-FSM Workflow is an issue-triggered
state machine. Teaching both without an explicit boundary would make the configuration model harder
to understand.

The repository also lacks one canonical, operator-facing reference for the complete shipped
workflow language. `SPEC.md`, ADRs, source, tests, the repository's own `workflow.yml`, and
`skills/symphonika-workflow/` collectively describe the surface, but they serve different audiences
and do not always distinguish proposed or parser-recognized syntax from runtime-supported behavior.

## Goals

- Preserve the existing end-to-end first-run path in `docs/tutorial.md`.
- Teach workflow capabilities progressively, from a single Markdown prompt to a composed
  issue-to-merge YAML state machine.
- Add a clearly separate routines chapter with both report and Git examples.
- Create `docs/workflows.md` as the exhaustive operator-facing reference for the shipped workflow
  language.
- Make every documented example copyable, internally complete, and accepted by the real parser.
- Distinguish runtime-supported behavior from reserved or parser-recognized syntax that operators
  must not rely on.
- Improve discoverability from the README and through cross-links between the tutorial, reference,
  specification, and relevant ADRs.

## Non-Goals

- Changing workflow, routine, provider, or lifecycle behavior.
- Promoting proposed design syntax to a supported runtime contract.
- Replacing `SPEC.md` as the implementation contract or ADRs as the source of architectural
  rationale.
- Turning the tutorial into an exhaustive schema reference.
- Documenting internal database schemas or HTTP response fields that are unrelated to authoring and
  operating workflows.
- Expanding the Routine feature or treating Routine declarations as YAML FSM states.

## Documentation Model

The documentation will have two layers.

### Tutorial: learn by progression

`docs/tutorial.md` remains the first-run journey. It will explain concepts at the moment the reader
needs them and link to `docs/workflows.md` for exhaustive syntax and edge cases.

The tutorial will retain:

- prerequisites and installation
- global initialization and Project registration
- the Service Config walkthrough
- provider setup
- `doctor`
- issue eligibility
- the first `smoke` run
- run evidence and workspace inspection
- daemon operation
- troubleshooting

The workflow material will become a progressive track:

1. Explain the two automation mechanisms:
   - Workflows react to eligible issues and walk an issue-specific execution graph.
   - Routines fire scheduled prompts independently of issue eligibility.
2. Show the Markdown `WORKFLOW.md` compatibility path as the smallest useful workflow.
3. Explain how a Project selects Markdown or raw-FSM format, including extension-based `auto`
   resolution and the explicit `{ path, format }` form.
4. Show a minimal raw-FSM workflow with one `agent` state and explicit `success` and `blocked`
   terminals.
5. Extend it to planning and implementation states, including separate prompt files and per-state
   provider selection.
6. Extend it to a pull-request shipping loop using `wait`, ordered PR predicates, repair states,
   and `merge_pr`.
7. Replace repeated fragments with built-in templates and point to local templates as the
   customization path.
8. Demonstrate the authoring loop with `workflow validate`, `workflow explain`, `poll-now`, and the
   persisted workflow graph.

Each example will be followed by a short explanation of what changed and why. The tutorial will not
repeat every schema constraint from the reference.

### Workflow reference: understand the whole language

`docs/workflows.md` will be organized for lookup rather than linear onboarding.

It will contain:

1. **Mental model and source hierarchy**
   - Markdown compatibility graph versus raw FSM
   - repository-owned source files versus the persisted expanded graph
   - `SPEC.md` as implementation contract
2. **Selecting a workflow**
   - string and mapping forms of `projects[].workflow`
   - `auto`, `markdown`, and `raw_fsm`
   - recognized extensions and relative-path resolution
3. **Markdown Workflow Contracts**
   - Markdown body
   - strict prompt interpolation
   - YAML front matter and `evidence.ignore`
   - the compatibility graph produced by Markdown
4. **Raw-FSM grammar**
   - top-level `workflow`
   - `name`, `initial`, `states`, and `use`
   - path-safe identifiers and reference validation
5. **States**
   - `action`
   - `complete_when`
   - ordered `transitions`
   - `terminal`
   - terminal-state field exclusions and no-match behavior
6. **Runtime-supported actions**
   - `agent`, including `provider` and required `prompt`
   - `wait`
   - `merge_pr`, including `merge`, `rebase`, and `squash`
7. **Predicates and signals**
   - every parser-recognized predicate
   - valid value shapes
   - which runtime path can actually produce each signal
   - strict equality, conjunction within a predicate map, transition ordering, and catch-alls
8. **Terminals and lifecycle outcomes**
   - `success`, `blocked`, and `failure`
   - how terminal choice maps onto Run state and operational labels
9. **Prompt files and variables**
   - path resolution
   - all available prompt objects and fields
   - strict interpolation and automatic autonomy preamble
10. **Template authoring**
    - `name`, `entry`, `inputs`, `exits`, and `states`
    - `boolean`, `label`, `number`, `path`, `provider`, and `string` inputs
    - defaults, exact-tag scalar preservation, embedded string interpolation
    - instance namespacing, exit mapping, terminal exits, and path containment
11. **Built-in templates**
    - `single-agent-pr`
    - `plan-tdd-pr`
    - `autofix-until-clean`
    - `merge-when-green`
    - inputs, defaults, exits, and expanded behavior for each
12. **Execution semantics**
    - state entry and advancement
    - provider routing and Project fallback
    - retries versus FSM transitions
    - wait polling and PR observation
    - merge policy interaction
    - label immunity while a raw FSM walk is in flight
    - reload and last-known-good behavior
    - evidence and graph persistence
13. **Validation and inspection**
    - `workflow validate`
    - `workflow explain`
    - dashboard graph and stored `workflow-graph.json`
14. **Supported, reserved, and unsupported**
    - runtime-supported authoring surface
    - parser-recognized action or predicate names without complete runtime semantics
    - common requested constructs that are not supported
15. **Complete examples**
    - single-agent FSM
    - plan/implement provider routing
    - wait/autofix/merge loop
    - local reusable template plus a composed workflow

Tables will be used where readers need exact mappings, especially action fields, predicate
availability, template input types, terminal outcomes, and built-in template contracts.

## Routines Chapter

Routines will be a separate major chapter in `docs/tutorial.md`, after the issue-workflow journey.
It will cover:

- why a Routine is not a Workflow state
- targeting a Dispatch Project versus a dedicated Routine Host
- `symphonika init-project --mode routine-host`
- `symphonika add-routine`
- the top-level `routines:` Service Config block
- Routine Markdown front matter
- one-shot `schedule.at` and recurring five-field cron schedules
- aliases, `schedule.tz`, `catch_up`, `allow_overlap`, and `disabled`
- `kind: report` and `kind: git`
- the tracker requirement for Git routines on Routine Hosts
- Routine-specific prompt variables
- `symphonika routines`, dashboard status, firing evidence, discovered PRs, and cancellation

The chapter will include two complete declarations:

1. A recurring `kind: report` status summary.
2. A recurring `kind: git` maintenance task hosted by a repository workspace.

It will link back to the Service Config section instead of duplicating the full Project schema.

## Discoverability and Cross-Links

- The tutorial will link to `docs/workflows.md` at its first Markdown/raw-FSM comparison and from
  each advanced workflow section.
- `docs/workflows.md` will link back to the tutorial for the operational first-run path.
- The README's workflow-template section will link to the new reference.
- Both documents will link narrowly to the relevant sections of `SPEC.md` and ADRs for rationale,
  without requiring readers to reconstruct the language from those sources.
- The tutorial's final “where to go next” section will become a compact index rather than the first
  place advanced workflow capabilities are revealed.

## Correctness Rules

The authoring reference will use the following evidence priority:

1. Current runtime behavior and focused tests.
2. Current parser and expander behavior.
3. `SPEC.md`.
4. Accepted ADRs.
5. Proposed design notes and skill-local reference files.

When these disagree, the documentation will describe confirmed current behavior and explicitly
label parser-recognized or proposed constructs that are not safe to use. Parser acceptance alone is
not sufficient to call a feature supported.

Examples must obey these rules:

- Agent states name an existing prompt file.
- Transition fallbacks appear after more specific conditions.
- Predicates use values the relevant runtime path can produce.
- Wait and merge examples include escape paths for closed or failed PRs.
- Local template paths remain inside the workflow directory.
- Template exits are declared and mapped.
- Routine examples use top-level Service Config entries and exactly one schedule shape.
- Git routines targeting Routine Hosts include tracker configuration.

## Validation

Documentation validation will include:

- Extracting every raw-FSM YAML example into an isolated fixture with any referenced prompt and
  template files.
- Loading each fixture through the production workflow parser and reference validator.
- Exercising representative composed examples through `workflow validate` or the equivalent
  production loader.
- Parsing every Routine declaration example through the production Routine declaration loader.
- Checking example Service Config fragments with the production config schema when they are
  presented as complete configs.
- Running Prettier, lint, typecheck, focused workflow/routine tests, and the repository's normal
  documentation-relevant quality gates.
- Checking Markdown links and anchors with a focused local script if the repository has no existing
  link-check command.
- Reviewing the final diff for stale command names, provider limitations, and contradictions with
  `SPEC.md`.

## Acceptance Criteria

- A new user can still follow `docs/tutorial.md` from installation to a first successful daemon run.
- The tutorial shows at least three levels of YAML workflow complexity and explains the new syntax
  introduced at each level.
- Routines have a standalone conceptual and practical chapter with both report and Git examples.
- `docs/workflows.md` documents every current workflow field, supported action, predicate, terminal,
  template feature, built-in template, prompt variable family, and relevant execution rule.
- Reserved or incomplete syntax is never presented as runtime-supported.
- Every complete YAML, template, Routine, and Service Config example is validated against production
  loaders.
- The README, tutorial, and workflow reference cross-link cleanly.
- No runtime or configuration behavior changes are included in the documentation patch.
