# Remove workflow templates; every FSM is authored in full

Status: Accepted — supersedes ADR 0049 and the template parts of ADR 0045 and
`docs/specs/2026-05-07-state-machine-workflows-design.md`

## Context

The state-machine workflow design (`docs/specs/2026-05-07-state-machine-workflows-design.md`, with
ADR 0045's persisted graph recording their provenance) introduced repo-local workflow templates
(`workflow.use`): YAML fragments with typed scalar inputs, one entry state, and named exits, spliced
into a raw-FSM graph under an instance prefix. ADR 0049 added five inline built-ins (`builtin:single-agent-pr`, `plan-tdd-pr`, `refactor-swarm`,
`autofix-until-clean`, `merge-when-green`) resolved through the same loader, and ADR 0085 added the
refactor swarm on top of them.

The mechanism cost more than it saved:

- It was roughly 1,000 lines of source (input typing, interpolation, exit mapping, prefixed state
  ids, terminal-exit special cases, the inline built-in registry) plus about 2,000 lines of tests,
  in the module that every workflow load goes through.
- Authors had to hold two graphs in their head: the one they wrote and the prefixed one that ran.
  State ids in run evidence (`build.planning`) did not appear anywhere in the authored file, and a
  second `template files:` provenance channel existed only to explain that gap.
- Only one of the ten live raw-FSM workflow files used a template at all; the rest are authored in
  full.
- Several built-in behaviors were subtle enough (the `BLOCKED.md` sentinel ordering, the
  plan-artifact gate, `merge_pr` as the entry state) that hiding them behind a name made them harder
  to review, not easier.

The Symphonika skill (`skills/symphonika/`) already interviews the user and writes the workflow
file, so the convenience the templates offered is better delivered as worked examples the skill can
copy and specialize.

## Decision

Raw-FSM workflows declare every state under `workflow.states`. There is no `workflow.use`, no
`builtin:` namespace, no template inputs or exits, and no instance-prefixed state ids.

- `workflow.use` is rejected with `workflow.use is not supported; declare every state directly under
  workflow.states`. It is a hard error, not silently ignored, and it is the only error reported:
  the rest of the graph checks are skipped, because a workflow that still carries a `use` block
  would otherwise also fail with a misleading "initial state is not declared" cascade (its
  `initial:` names a template instance).
- `ExpandedWorkflow` no longer has a `templateFiles` field and `workflow explain`/`validate` no
  longer print `template files:`. Persisted `workflow-graph.json` files written by earlier versions
  still carry the field; readers ignore it.
- The workflow content hash is the hash of the workflow file alone. For a workflow that never used
  templates this is byte-identical to the previous value (the hash was the file's contents joined
  with zero template sources), so redeploying does not change any template-free project's hash.
- The five built-in shapes become worked examples in `skills/symphonika/EXAMPLES.md` (Examples 3 and
  5–8), and the repository's `refactor-workflow.yml` carries the refactor swarm's three states in
  full. `tests/skill-examples.test.ts` validates every `yaml` workflow block in EXAMPLES.md and
  replays the refactor workflow's routing decisions, so the copies cannot drift into invalidity
  silently.
- Chaining shapes means merging their `states:` maps and keeping ids unique. State ids may contain
  dots, so a migrated workflow can keep the `<instance>.<state>` names that templates produced and
  preserve the state ids of runs already parked mid-workflow.

The behavior notes ADR 0049 recorded still hold as authoring guidance and are carried into the
examples: an autofix loop is bounded by predicates only (there is no iteration counter, ADRs 0047
and 0048), and a workflow that wants to own the merge starts directly in a `merge_pr` state so the
global PR follow-up defers to it from the first parked row.

## Consequences

- **Breaking change.** Any project whose workflow declares `workflow.use` fails to load until its
  states are inlined. A running daemon's reload keeps the last known good snapshot and reports the
  error; a fresh start (including a self-update cutover restart) has no snapshot to fall back on,
  so such a project is unavailable until its workflow is migrated. Migrate before the release
  carrying this change is deployed. The expansion each template
  produced is in the git history of `src/builtin-templates.ts` and is what EXAMPLES.md now shows.
  Runs already parked in a prefixed state can be preserved by keeping the prefixed ids; renaming
  them orphans those runs.
- ADR 0049 is superseded. ADR 0085's `builtin:refactor-swarm` becomes `refactor-workflow.yml`; its
  state graph, predicates, and prompts are unchanged.
- `expandWorkflowDefinition` no longer touches the filesystem, so it is synchronous.
- Reintroducing reuse later would need a new ADR; the likeliest shape is skill-side generation,
  not a runtime expansion pass.
