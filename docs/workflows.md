# Symphonika workflow language

This is the complete authoring reference for Symphonika issue workflows. For a guided installation
and a progression of examples, start with the [tutorial](./tutorial.md). `SPEC.md` remains the
implementation contract; this document turns the shipped parser and runtime behavior into an
operator-facing reference.

Symphonika has two automation mechanisms:

- A **Workflow** starts from an eligible GitHub issue and moves that issue through an execution
  graph.
- A **Routine** runs a scheduled prompt. Routines are not states in the workflow language; see the
  [routines chapter](./tutorial.md#part-iii-scheduled-work-with-routines).

## 1. Workflow formats

A Dispatch Project selects its workflow in `symphonika.yml`. The compact form lets the file
extension select the format:

```yaml
projects:
  - name: my-app
    # ...
    workflow: ./WORKFLOW.md
```

The mapping form makes the choice explicit:

```yaml
projects:
  - name: my-app
    # ...
    workflow:
      path: ./workflow.yml
      format: raw_fsm
```

`format` accepts:

| Value | Behavior |
| --- | --- |
| `auto` | `.md` is Markdown; `.yaml`, `.yml`, and `.json` are raw FSMs |
| `markdown` | Treat the file as a Markdown Workflow Contract regardless of extension |
| `raw_fsm` | Treat the file as an explicit state machine regardless of extension |

The default is `auto`. An unrecognized extension is an error under `auto`. Relative workflow paths
are resolved from the directory containing `symphonika.yml`.

Both formats compile to the same expanded graph. Symphonika validates that graph, stores it as
run evidence, and executes it. The difference is how much of the graph you author.

## 2. Markdown Workflow Contracts

A Markdown Workflow Contract is the smallest workflow:

```markdown
# Implement issue #{{issue.number}}: {{issue.title}}

Work in {{workspace.path}} on branch {{branch.name}}.

1. Implement the issue.
2. Run the repository's checks.
3. Commit and push the change.
4. Open a non-draft pull request with `gh pr create`.
```

Symphonika compiles it to this compatibility graph:

```text
run_agent (agent)
  complete when provider_success=true and branch_ahead_of_base=true
  -> done
done (terminal: success)
```

The Markdown body is the prompt sent to the Project's configured provider. Symphonika prepends its
standard autonomy preamble automatically.

### Markdown front matter

Markdown may start with YAML front matter. The currently documented setting adds repository-owned
directories to the Watchdog's workspace-mtime exclusions:

```markdown
---
evidence:
  ignore:
    - vendor/
    - out/
---

# Implement {{issue.title}}

...
```

Each `evidence.ignore` entry must be a non-empty, workspace-relative path without `..`. This list is
additive: it cannot remove the built-in `.git/`, `target/`, and `node_modules/` exclusions.

Service-discovery keys such as `provider`, `tracker`, `workspace`, and `workflow` do not belong in
Markdown front matter. Put them in `symphonika.yml`.

## 3. Raw-FSM structure

A raw FSM is YAML or JSON with one top-level `workflow` mapping:

```yaml
workflow:
  name: implement_only
  initial: implement
  states:
    implement:
      action:
        kind: agent
        prompt: prompts/implement.md
      transitions:
        - to: done
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: blocked
    done:
      terminal: success
    blocked:
      terminal: blocked
```

The top-level fields are:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Workflow name stored in graph evidence |
| `initial` | yes | State id or template-instance id entered first |
| `states` | when `use` is empty | Locally declared states |
| `use` | no | Instances of built-in or repository-local templates |

At least one of `states` or `use` must contribute a state. State and template-instance ids must
start with a letter or underscore and may then contain letters, digits, `_`, `.`, or `-`.

The `initial` target and every transition target must resolve to a declared state. When a target
names a template instance, expansion rewrites it to that template's entry state.

## 4. States

A state is either an action state or a terminal state.

```yaml
states:
  implementing:
    action:
      kind: agent
      provider: codex
      prompt: prompts/implement.md
    complete_when:
      provider_success: true
      branch_ahead_of_base: true
    transitions:
      - to: done
        when:
          provider_success: true
      - to: blocked

  done:
    terminal: success

  blocked:
    terminal: blocked
```

### Action state fields

| Field | Required | Meaning |
| --- | --- | --- |
| `action` | yes | Work performed on entry |
| `complete_when` | no | Predicates that must all match after the action |
| `transitions` | no | Ordered candidate destinations |

`complete_when` is a gate. If any predicate is missing or unequal, Symphonika records why the state
could not complete and does not evaluate transitions.

After the completion gate, transitions are evaluated from top to bottom. Every predicate inside one
`when` mapping must match. The first matching transition wins. A transition without `when` is an
unconditional catch-all, so put it last.

An ordinary action state with no matching transition stops graph advancement and records a
workflow-blocked reason. A `wait` or `merge_pr` state with no matching transition remains parked
for the next daemon tick, provided its `complete_when` gate is not violated.

### Terminal state fields

A terminal state contains only:

```yaml
terminal: success
```

It must not also define `action`, `complete_when`, or `transitions`.

| Terminal | Intended use |
| --- | --- |
| `success` | The workflow reached its completed path |
| `blocked` | The workflow deterministically cannot proceed without outside change |
| `failure` | The workflow deterministically failed |

`blocked` produces a distinct blocked Run verdict and `sym:blocked` behavior on supported
agent/wait paths. On agent-state paths, `failure` is a deterministic failure and uses the normal
failure-label path. Cancellation and `input_required` still take precedence over an authored
terminal. Prefer `terminal: blocked` for non-actionable escape paths from PR wait loops; it is the
give-up terminal explicitly handled by parked-state reconciliation.

## 5. Actions

Three action kinds have complete runtime behavior.

### `agent`

An agent state launches Codex, Claude, or Oh My Pi (OMP) in the prepared issue workspace:

```yaml
action:
  kind: agent
  provider: claude
  prompt: prompts/review.md
```

| Field | Required | Meaning |
| --- | --- | --- |
| `kind: agent` | yes | Launch an Agent Provider |
| `prompt` | yes | Markdown prompt path relative to the raw-FSM file |
| `provider` | no | `codex`, `claude`, or `omp`; defaults to the Project's `agent.provider` |

The prompt file must exist when `doctor` or daemon reload validates Project readiness. It uses the
same strict variables and autonomy preamble as a Markdown Workflow Contract.

An agent result currently projects only:

- `provider_success`
- `branch_ahead_of_base`

Do not put PR predicates such as `checks` in an agent state's `complete_when`; those signals are
produced when a `wait` or `merge_pr` state polls GitHub.

### `wait`

A wait state launches no provider:

```yaml
action:
  kind: wait
```

It parks the workflow in a durable `waiting` Run. Every daemon tick and `poll-now` refreshes the
Symphonika-tracked PR and re-evaluates the state's transitions.

A wait action accepts no `prompt`, `provider`, or `method`.

### `merge_pr`

A merge state is a policy-aware parked state:

```yaml
action:
  kind: merge_pr
  method: squash
```

`method` is optional and accepts `merge`, `rebase`, or `squash`. When omitted, the state inherits
`pull_requests.merge.method`.

The state only acts on a PR associated with the Symphonika issue branch. On each re-evaluation,
Symphonika refreshes the PR signals. If merge policy is enabled and the PR satisfies its checks,
review, and mergeability gates, Symphonika pins the merge to the observed head SHA and attempts the
merge.

A deferred merge does not skip transition evaluation. When merging is disabled or the PR is not
ready under policy, the state still evaluates transitions against the refreshed signals. A matching
transition such as `checks: failure` can therefore advance to a repair or blocked state without a
merge attempt.

The state remains parked when:

- no tracked PR exists;
- PR state cannot be fetched;
- the tracker does not expose the merge API or a merge attempt fails; or
- no transition matches the refreshed signals.

After a successful merge, Symphonika projects the post-merge PR signals before evaluating
transitions.

## 6. Predicates and signal availability

Predicate values are scalars and comparisons use strict equality. Symphonika has no inequality,
range, regular-expression, `or`, or negation syntax. Multiple fields in one map mean logical
`and`.

The parser recognizes the following keys:

| Predicate | Useful values | Agent result | Wait/merge poll | Current status |
| --- | --- | --- | --- | --- |
| `provider_success` | `true`, `false` | yes | always `true` | supported |
| `branch_ahead_of_base` | `true`, `false` | yes | no | supported |
| `pr_open` | `true`, `false` | no | always | supported |
| `pr_merged` | `true` | no | only when merged | supported |
| `mergeable` | `true`, `false` | no | omitted while unknown | supported |
| `checks` | `success`, `failure`, `pending` | no | omitted while unknown | supported |
| `review_decision` | `approved`, `changes_requested`, `review_required`, `none` | no | always | supported |
| `has_unresolved_reviews` | `true`, `false` | no | always | supported |
| `unresolved_review_threads` | non-negative integer | no | always | supported, exact count only |
| `artifact_exists` | string path | no | no | reserved; not emitted |
| `branch_pushed` | `true`, `false` | no | no | reserved; not emitted |
| `timeout` | scalar | no | no | reserved; not implemented |

Because missing and `false` are different, `pr_merged: false` does not match an ordinary open PR:
the signal is omitted until the PR is merged. Likewise, `mergeable: false` means GitHub explicitly
reported a conflict; it does not match `UNKNOWN`.

Example transition order:

```yaml
transitions:
  - to: merged
    when:
      pr_merged: true
  - to: blocked
    when:
      pr_open: false
  - to: merge
    when:
      checks: success
      mergeable: true
      unresolved_review_threads: 0
  - to: repair
    when:
      checks: failure
```

With no final catch-all, a wait state stays parked when checks are pending, review threads remain,
or mergeability is unknown.

## 7. Prompt variables

Prompt interpolation is deliberately small and strict. Tags have the form `{{object.field}}`;
unknown objects, fields, helpers, and nested expressions fail validation. There are no conditionals
or executable expressions.

| Object | Fields |
| --- | --- |
| `project` | `name` |
| `issue` | `id`, `number`, `title`, `body`, `state`, `url`, `labels`, `created_at`, `updated_at`, `priority` |
| `workspace` | `path`, `root`, `previous_attempt` |
| `branch` | `name`, `ref` |
| `run` | `id`, `attempt`, `continuation` |
| `provider` | `name`, `command` |

Arrays and objects, such as `issue.labels`, render as JSON. A previous-attempt notice and the
standard autonomy preamble are added outside your prompt file.

## 8. Reusable templates

A template is a YAML state-machine fragment with typed scalar inputs, one entry, and named exits.
Repository-local templates are resolved relative to the main workflow and must remain inside its
directory.

`entry` and `states` are required. `inputs` and `exits` are optional mappings. `name` is
conventional descriptive metadata; the caller-visible instance name comes from the key under
`workflow.use`.

### Template file

`.symphonika/workflow-templates/plan-implement.yml`:

```yaml
name: plan_implement
entry: planning

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
    default: prompts/implement.md

exits:
  success: done
  blocked: blocked

states:
  planning:
    action:
      kind: agent
      provider: "{{ planner }}"
      prompt: "{{ plan_prompt }}"
    transitions:
      - to: implementing
        when:
          provider_success: true
      - to: blocked

  implementing:
    action:
      kind: agent
      provider: "{{ implementer }}"
      prompt: "{{ implement_prompt }}"
    transitions:
      - to: done
        when:
          provider_success: true
          branch_ahead_of_base: true
      - to: blocked

  done:
    exit: success

  blocked:
    exit: blocked
```

An exit state may be a non-terminal state with `exit: <name>`, in which case the caller must map
that exit. A terminal state may also be a declared exit; if the caller leaves it unmapped, it
remains a terminal inside the expanded template.

### Template inputs

Input names must be identifiers: a letter or underscore followed by letters, digits, or
underscores.

| Type | Accepted value |
| --- | --- |
| `boolean` | YAML boolean |
| `number` | finite YAML number |
| `provider` | `codex`, `claude`, or `omp` |
| `label` | non-empty string |
| `path` | non-empty string without a NUL character |
| `string` | non-empty string |

Inputs without defaults are required. Supplying an undeclared input is an error.

Use `{{ input_name }}` in any string value inside a template. If the whole YAML scalar is one tag,
boolean and number types remain booleans and numbers. A tag embedded inside a larger string is
converted to text. Template interpolation is distinct from prompt interpolation: it expands the
graph at load time and can reference only declared template inputs.

### Using a local template

```yaml
workflow:
  name: plan_then_ship
  initial: build

  use:
    build:
      template: .symphonika/workflow-templates/plan-implement.yml
      with:
        planner: claude
        implementer: codex
      exits:
        success: done
        blocked: blocked

  states:
    done:
      terminal: success
    blocked:
      terminal: blocked
```

Expansion prefixes internal ids with the instance id, such as `build.planning`. Template instances
and local states cannot share an id. A transition or `initial` value that targets `build` is
rewritten to `build`'s entry state.

Only declared exits can leave the template. Every non-terminal exit must be mapped. An exit mapping
may target a local state or another template instance.

Local template paths must be relative, cannot escape the directory containing the main workflow,
and contribute to the workflow content hash and evidence.

## 9. Built-in templates

Built-ins use the same expansion machinery and are referenced with `builtin:<name>`.

| Template | Entry behavior | Inputs and defaults | Exits |
| --- | --- | --- | --- |
| `builtin:single-agent-pr` | One agent must succeed with commits ahead of base | `provider: codex`, `prompt: WORKFLOW.md` | `success`, `blocked` |
| `builtin:plan-tdd-pr` | Planning agent, then implementation agent | `planner: codex`, `implementer: codex`, `plan_prompt: prompts/plan.md`, `impl_prompt: prompts/impl.md` | `success`, `blocked` |
| `builtin:autofix-until-clean` | Wait for checks/reviews, then run an autofix agent and loop | `provider: codex`, `fix_prompt: prompts/autofix.md` | `success`, `blocked` |
| `builtin:merge-when-green` | Enter a policy-controlled merge state | `method: squash` | `success`, `blocked` |

Their exact expanded behavior is:

- **`single-agent-pr`:** run the configured agent and take `success` only when
  `provider_success: true` and `branch_ahead_of_base: true`; every other completed outcome takes
  `blocked`.
- **`plan-tdd-pr`:** a successful planner advances to the implementer without requiring a commit.
  The implementer takes `success` only with provider success and commits ahead of base. Either
  state's fallback takes `blocked`.
- **`autofix-until-clean`:** its wait state takes `success` when checks succeed and unresolved
  threads equal zero, takes `blocked` when checks fail, and launches the autofix agent when checks
  succeed but the zero-thread transition did not match. Other PR states stay parked. A successful
  autofix returns to the wait; its fallback takes `blocked`.
- **`merge-when-green`:** enter `merge_pr` directly. A successful merge takes `success`; a closed
  PR, failed checks, or explicit merge conflict takes `blocked`; all other observations stay
  parked. Service-level merge policy still controls whether a merge is attempted.

Example composition:

```yaml
workflow:
  name: plan_fix_merge
  initial: build

  use:
    build:
      template: builtin:plan-tdd-pr
      with:
        planner: claude
        implementer: codex
      exits:
        success: fix
        blocked: blocked

    fix:
      template: builtin:autofix-until-clean
      exits:
        success: merge
        blocked: blocked

    merge:
      template: builtin:merge-when-green
      with:
        method: squash
      exits:
        success: done
        blocked: blocked

  states:
    done:
      terminal: success
    blocked:
      terminal: blocked
```

This example requires the built-ins' default prompt files to exist. You can override their paths
through `with`.

`workflow validate` and `workflow explain` list `builtin:<name>` under `template files`, so the
expanded graph remains auditable. A local template does not automatically shadow a built-in; change
the `template` value explicitly.

## 10. Execution semantics

### State entry and advancement

Agent states run serially in the issue workspace. A transition to another agent state schedules a
state-advance Run in the same workflow walk. A transition to `wait` or `merge_pr` creates a durable
waiting Run. Transitions into terminals end the walk.

Raw-FSM state advances are not ordinary issue continuations. While the graph is in flight,
`labels_all` and `labels_none` drift does not cancel it; the FSM owns advancement. Issue closure and
operator cancellation still apply.

### Provider routing

`action.provider` is honored on the initial state and on later agent states. If it is omitted,
Symphonika uses `projects[].agent.provider`. Both providers still need valid commands in the
Service Config when referenced.

### Retries and failure transitions

Transient provider or infrastructure failures consume the normal retry budget before a transition
to another non-terminal state is allowed. The retry re-enters the same FSM state. After retry
exhaustion, the state's failure predicates and fallbacks determine whether the workflow advances or
ends.

Terminal `failure` or `blocked` paths are deterministic workflow verdicts and can pre-empt retry.
Cancellation and `input_required` are never converted into workflow success.

### Wait and PR tracking

Wait and merge states observe only a PR that Symphonika associated with its issue branch. If no
tracked PR exists, they remain parked. The ordinary PR follow-up loop can still dispatch agents for
review feedback; a workflow parked in `merge_pr` owns the merge attempt so the global loop does not
race it.

### Merge policy

`merge_pr` always respects the service-level gates under `pull_requests.merge`, including
`enabled`, required status success, and required review decision. A state's `method` overrides only
the merge method.

### Reload behavior

The daemon re-reads Service Config, Workflow Contracts, raw FSMs, prompts, and templates on reload
ticks. A valid edit applies to future attempts. In-flight attempts retain their captured prompt and
workflow hash. An invalid candidate workflow is surfaced while the daemon keeps the last known-good
Project snapshot.

### Evidence

Every attempt stores:

- the rendered `prompt.md`;
- prompt metadata;
- issue snapshot;
- provider logs; and
- `workflow-graph.json`.

Template sources contribute to the graph content hash. The run-detail page can render the expanded
graph, and `show-run` reports state transitions alongside attempts.

## 11. Validation and inspection

Validate the selected Project without dispatching:

```sh
symphonika workflow validate --config symphonika.yml --project my-app
```

Print the expanded graph:

```sh
symphonika workflow explain --config symphonika.yml --project my-app
```

Both commands select the Project from the Service Config, load the workflow, expand templates, and
report graph and parse errors. `validate` also prints a summary of the expanded graph.

`doctor` adds the full Project preflight, including checking that every raw-FSM agent prompt path
exists. Daemon reload performs the same reference check. Raw prompt contents are rendered strictly
when their state starts, so an unknown prompt tag becomes a prompt-rendering failure at dispatch.
After a valid edit, `poll-now` makes the daemon reload and reconcile immediately. Use
`show-run <id>` or the local dashboard to inspect the graph captured for an actual attempt.

Common validation failures:

- a missing top-level `workflow` mapping;
- an unknown initial or transition target;
- a terminal state that also declares action fields;
- an agent state with no prompt;
- a prompt file that does not exist (`doctor` or daemon reload);
- an unknown Markdown-contract variable, or a raw prompt variable that fails when its state starts;
- an unsupported predicate;
- a template path outside the workflow directory;
- a missing required template input; or
- an unmapped non-terminal template exit.

## 12. Supported, reserved, and unsupported

### Safe to use

- Markdown single-agent contracts
- Raw FSMs with `agent`, `wait`, and `merge_pr`
- Ordered strict-equality transitions
- Supported agent-result and PR predicates from the table above
- Per-state Codex/Claude/OMP routing
- Local templates and all six scalar input types
- The four built-in templates
- Poll-driven wait and policy-controlled merge loops

### Parsed but not operational

The current parser recognizes these action kinds from the broader workflow design:

- `comment`
- `label_issue`
- `close_issue`
- `fail`

It also recognizes the reserved predicates `artifact_exists`, `branch_pushed`, and `timeout`.
Current runtime paths do not implement those system actions or produce those signals. Do not use
them in an operational workflow merely because `workflow validate` accepts their names.

### Not supported

- parallel or fan-out states
- nested workflows or dynamic state creation
- scripts, webhooks, arbitrary commands, or human-approval states
- remote template registries
- conditionals or helpers inside prompts
- numeric comparisons or ranged predicates
- mid-walk label predicates
- time-based wait-state transitions
- cross-repository pull requests

## 13. Complete issue-to-merge example

The repository's own [`workflow.yml`](../workflow.yml) is the most detailed shipped example. This
smaller version shows the complete runtime-supported shape:

```yaml
workflow:
  name: implement_review_merge
  initial: implement

  states:
    implement:
      action:
        kind: agent
        provider: codex
        prompt: prompts/implement.md
      transitions:
        - to: wait_for_pr
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: blocked

    wait_for_pr:
      action:
        kind: wait
      transitions:
        - to: merged
          when:
            pr_merged: true
        - to: blocked
          when:
            pr_open: false
        - to: merge
          when:
            checks: success
            mergeable: true
            unresolved_review_threads: 0
        - to: repair
          when:
            checks: failure
        - to: repair
          when:
            has_unresolved_reviews: true

    repair:
      action:
        kind: agent
        provider: claude
        prompt: prompts/repair.md
      transitions:
        - to: wait_for_pr
          when:
            provider_success: true
        - to: blocked

    merge:
      action:
        kind: merge_pr
        method: squash
      transitions:
        - to: merged
          when:
            pr_merged: true
        - to: blocked
          when:
            pr_open: false
        - to: repair
          when:
            checks: failure
        - to: repair
          when:
            mergeable: false

    merged:
      terminal: success

    blocked:
      terminal: blocked
```

`prompts/implement.md` must tell the agent to commit, push, and open the PR. `prompts/repair.md`
must tell it to update the existing branch and PR rather than create a second one.

Before making an issue eligible, run:

```sh
symphonika workflow validate --project my-app
symphonika workflow explain --project my-app
```

For the architectural rationale, see [ADR-0045](./adr/0045-persist-expanded-workflow-graph.md),
[ADR-0046](./adr/0046-state-advance-vs-continuation.md),
[ADR-0047](./adr/0047-poll-driven-wait-states.md),
[ADR-0048](./adr/0048-fsm-controlled-merge-states.md), and
[ADR-0049](./adr/0049-builtin-workflow-templates.md).
