# State Machine Workflows

Status: proposed
Date: 2026-05-07

## Context

Symphonika currently treats a Project workflow as one repository-owned prompt contract. That is
enough for the bootstrap path: pick an eligible issue, prepare a workspace, run one coding agent,
expect it to test, commit, push, open a PR, and remove the readiness label. PR follow-up adds a
second poll-driven loop for review feedback and clean auto-merge, but the higher-level lifecycle is
still implicit.

The desired daily-use model is broader: an issue should move through named phases such as planning,
TDD implementation, simplification, review follow-up, and merge. These phases should be generic
enough for different repositories to define their own agentic coding workflows, while Symphonika
remains the durable runtime that runs agents, evaluates observable state, records evidence, and
advances work safely.

## Goals

- Let repositories define issue-to-merge workflows as finite state machines.
- Keep workflow behavior inspectable before dispatch.
- Support repo-local reusable templates, similar in spirit to coding skills.
- Preserve the current single-prompt workflow as a compatibility shorthand.
- Keep v1 execution poll-based, local, and aligned with the existing daemon/run-store model.
- Make the model compatible with a future visual canvas where nodes map to states and edges map to
  transitions.

## Non-Goals

- Arbitrary code execution during workflow expansion.
- A distributed workflow engine.
- A separate visual-only workflow source of truth.
- Remote template registries in the first implementation.
- Replacing repository-owned agent skills or prompt conventions.

## Design Summary

Symphonika should introduce a repository-owned workflow definition DSL that compiles into an explicit
finite state machine. Runtime execution uses only the expanded state machine.

The layers are:

1. Raw state machine: explicit states, actions, completion rules, and transitions.
2. Repo-local workflow templates: pure reusable state-machine fragments with inputs and exits.
3. Future visual builder: an editor for the same expanded graph, not a separate runtime model.

Existing Markdown `WORKFLOW.md` files remain valid. A Markdown workflow compiles to a one-state
agent workflow that preserves current behavior. A YAML workflow definition enables multi-stage
orchestration.

## Raw State Machine

A raw workflow definition names an initial state and a set of states:

```yaml
workflow:
  name: issue_to_merge
  initial: planning

  states:
    planning:
      action:
        kind: agent
        provider: codex
        prompt: prompts/plan.md
      complete_when:
        artifact_exists: PLAN.md
      transitions:
        - to: implementing

    implementing:
      action:
        kind: agent
        provider: codex
        prompt: prompts/implement-tdd.md
      complete_when:
        branch_ahead_of_base: true
        pr_open: true
      transitions:
        - to: simplifying

    simplifying:
      action:
        kind: agent
        provider: claude
        prompt: prompts/simplify.md
      complete_when:
        branch_pushed: true
      transitions:
        - to: waiting_for_review

    waiting_for_review:
      action:
        kind: wait
      transitions:
        - to: autofixing
          when:
            has_unresolved_reviews: true
        - to: merging
          when:
            checks: success
            mergeable: true
            unresolved_review_threads: 0

    autofixing:
      action:
        kind: agent
        provider: codex
        prompt: prompts/autofix-pr.md
        max_runs_per_fingerprint: 1
        max_total_runs: 3
      complete_when:
        branch_pushed: true
      transitions:
        - to: waiting_for_review

    merging:
      action:
        kind: merge_pr
        method: squash
      complete_when:
        pr_merged: true
      transitions:
        - to: done

    done:
      terminal: success

    needs_operator:
      terminal: blocked
```

### State Shape

Each state is one of:

- Agent state: dispatches a coding agent in the prepared workspace and issue branch.
- System state: evaluates or mutates external state without spending agent tokens.
- Terminal state: ends the workflow instance.

Initial action kinds:

- `agent`
- `wait`
- `merge_pr`
- `comment`
- `label_issue`
- `close_issue`
- `fail`

Initial completion predicates:

- `provider_success`
- `artifact_exists`
- `branch_ahead_of_base`
- `branch_pushed`
- `pr_open`
- `pr_merged`
- `checks`
- `mergeable`
- `review_decision`
- `has_unresolved_reviews`
- `unresolved_review_threads`
- `timeout`

Completion predicates must be observable by the daemon from the workspace, run store, or GitHub.
Agent self-reporting can be recorded as evidence, but it should not be the only success signal for a
state that mutates code or merges work.

### Transitions

Transitions are evaluated in order after a state completes or whenever a wait state is rechecked on
a daemon tick. The first matching transition wins. A transition without `when` is the default path.

If no transition matches and the state is not terminal, Symphonika records the workflow instance as
blocked with a deterministic reason. The workspace and evidence are preserved.

## Runtime Model

The run store should add a workflow instance record for each claimed issue. The instance records:

- project name
- issue number
- workflow name and content hash
- expanded workflow path or stored JSON
- current state
- terminal state, if reached
- last transition reason
- timestamps

Agent state execution creates normal Runs with extra workflow metadata:

- workflow instance id
- state id
- template instance id, when the state came from a template
- parent state run id, when applicable

Workspace-mutating states take the workspace/branch lock by default. This serializes implement,
simplify, and autofix states against the same issue branch. Wait and merge states do not run
concurrently with workspace-mutating agent states for the same workflow instance.

## Workflow Templates

Templates are repo-local reusable state-machine fragments. They are deliberately small: a template
has inputs, one entry state, named exits, and internal states.

Example:

```yaml
name: plan_tdd_pr

inputs:
  planner:
    type: provider
    default: codex
  implementer:
    type: provider
    default: codex
  plan_prompt:
    type: path
    default: prompts/plan.md
  implement_prompt:
    type: path
    default: prompts/implement-tdd.md

entry: planning

exits:
  success: pr_open
  blocked: blocked

states:
  planning:
    action:
      kind: agent
      provider: "{{ planner }}"
      prompt: "{{ plan_prompt }}"
    complete_when:
      artifact_exists: PLAN.md
    transitions:
      - to: implementing

  implementing:
    action:
      kind: agent
      provider: "{{ implementer }}"
      prompt: "{{ implement_prompt }}"
    complete_when:
      branch_ahead_of_base: true
      pr_open: true
    transitions:
      - to: pr_open

  pr_open:
    exit: success

  blocked:
    exit: blocked
```

A workflow uses templates by naming an instance and mapping exits:

```yaml
workflow:
  name: issue_to_merge
  initial: build_pr

  use:
    build_pr:
      template: .symphonika/workflow-templates/plan-tdd-pr.yml
      with:
        planner: codex
        implementer: codex
      exits:
        success: simplify
        blocked: needs_operator

    simplify:
      template: .symphonika/workflow-templates/simplify-pr.yml
      exits:
        success: review
        blocked: needs_operator

    review:
      template: .symphonika/workflow-templates/autofix-until-clean.yml
      exits:
        success: merge
        exhausted: needs_operator

    merge:
      template: builtin:merge-when-green
      exits:
        success: done
        blocked: needs_operator
```

### Expansion Contract

Expansion should stay simple:

- Template inputs are typed scalar values: string, number, boolean, provider, path, or label.
- Template interpolation is strict and side-effect free.
- Internal state names are prefixed by the template instance name, such as
  `build_pr.planning`.
- Only declared exits may leave a template instance.
- Exit mapping is required unless the exit targets a terminal state declared inside the template.
- Template expansion happens during config/workflow reload.
- The daemon stores and executes the expanded graph, not the template source.

This keeps templates close to reusable workflow fragments rather than a general programming language.

## Built-In Templates

Symphonika ships a small set of built-in templates that expand through the same template
machinery as repo-local templates (ADR 0049):

- `builtin:single-agent-pr` — a compatibility-style one-agent PR workflow.
- `builtin:plan-tdd-pr` — planning followed by TDD implementation with named exits.
- `builtin:autofix-until-clean` — a predicate-bounded wait/autofix loop that exits on
  `checks: success` + `unresolved_review_threads: 0`.
- `builtin:merge-when-green` — workflow-controlled merge through the `merge_pr` action with a
  configurable `method` input (defaults to `squash`). The template enters `merge_pr` directly so
  the global PR follow-up loop defers to it via `isIssueParkedInMergePrState`, preserving the
  method override and merge evidence path even when a PR becomes merge-ready mid-tick.

Built-ins are conveniences. Repositories can replace any built-in by changing the workflow's
`template:` reference to a local `.symphonika/workflow-templates/<name>.yml` with equivalent
content and get an identical expanded graph; resolution does not auto-shadow.

The expanded graph shows clear provenance: `workflow validate` / `workflow explain` print
`template files: builtin:<name>` so operators can audit which fragments contributed.

## Operator Surface

Add read-only commands before mutating workflow execution:

```sh
symphonika workflow validate --config symphonika.yml --project symphonika
symphonika workflow explain --config symphonika.yml --project symphonika
```

`workflow explain` should show:

- source workflow file
- template files used
- expanded states and transitions
- action kind/provider/prompt for each state
- completion predicates
- locks
- terminal states

This gives operators a way to audit what the daemon will do before labeling issues ready.

## Future Canvas

A future visual builder should edit the same canonical graph:

- canvas node = state or collapsed template instance
- canvas edge = transition
- node property panel = action and completion config
- collapsed node expansion = template internals

The visual tool should round-trip through the same YAML or through an equivalent normalized graph
format. Runtime should not gain a visual-only execution model.

## Implementation Slices

1. Add workflow validation and explanation for explicit raw FSM YAML, without dispatch changes.
2. Store expanded workflow metadata in run evidence.
3. Add workflow instance state to SQLite and execute one agent state through the existing
   RunController path.
4. Add system wait and merge states, reusing the existing PR follow-up and merge predicates.
5. Add repo-local template expansion with strict scalar inputs and named exits.
6. Migrate current Markdown workflow handling to compile into the one-state compatibility graph.

## Prior Art

- Amazon States Language: explicit start state, named states, and transitions
  (https://docs.aws.amazon.com/step-functions/latest/dg/statemachine-structure.html).
- GitHub Actions reusable workflows and composite actions: repo-versioned reusable automation with
  declared inputs (https://docs.github.com/en/actions/sharing-automations/reusing-workflows).
- Argo WorkflowTemplates: reusable workflow fragments with parameters
  (https://argo-workflows.readthedocs.io/en/latest/workflow-templates/).
- Tekton Pipelines: reusable tasks composed into pipelines with parameters and results
  (https://tekton.dev/docs/pipelines/pipelines/).

The Symphonika design borrows the inspectable graph and reusable-template ideas, but keeps execution
local, poll-driven, and centered on coding-agent workspaces.
