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
