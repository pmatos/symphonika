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
| `initial` | yes | State id entered first |
| `states` | yes | Every state in the graph, declared in full |

State ids must start with a letter or underscore and may then contain letters, digits, `_`, `.`, or
`-`.

The `initial` target and every transition target must resolve to a declared state. `workflow.use`, the
removed template mechanism, is rejected with a validation error rather than silently dropped (see
[section 8](#8-common-shapes)).

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

Six action kinds have complete runtime behavior.

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

An agent result currently projects:

- `provider_success`
- `branch_ahead_of_base`
- `branch_advanced_since_attempt_start`
- `claim_status`, when the agent's final message was a valid Workflow Claim (below)

Do not put PR predicates such as `checks` in an agent state's `complete_when`; those signals are
produced when a `wait` or `merge_pr` state polls GitHub.

### Workflow Claim

An agent state whose predicates name `claim_status` gates on the agent's own terminal verdict,
carried by its final message rather than a sentinel file. For such a state Symphonika appends a
standard "Final claim" section to the rendered prompt (ahead of the workflow prompt body), instructing the agent to end with a single
bare JSON object:

```json
{ "status": "blocked", "summary": "No open PR found for this branch." }
```

`status` uses the same three-value vocabulary as `terminal`: `success`, `blocked`, `failure`. The
same states also pass the claim's JSON Schema to the provider, so Claude (`--json-schema`) and
Codex (`turn/start.outputSchema`) enforce the shape and cannot finish the turn without a valid
claim. Oh My Pi's RPC mode has no schema lever yet, so an Oh My Pi state relies on the prompt
instruction alone and reads the claim from the final message text.

Symphonika reads the last `turn_completed` event — its schema-enforced structured output when the
provider produced one, otherwise the final message text — and offers the parsed `status` as the
`claim_status` predicate, compared by strict equality like every other non-artifact predicate.
Because a missing or malformed claim leaves `claim_status` absent, a transition naming it simply
does not match. Gate advancing on a positive `claim_status: success` (together with
`provider_success: true`) and end with a fallback transition, so an agent that never emits a valid
claim falls through to failure rather than advancing:

```yaml
transitions:
  - to: failed
    when:
      claim_status: blocked
  - to: next_state
    when:
      claim_status: success
      provider_success: true
  - to: failed
```

A state that does not name `claim_status` is unaffected: its prompt gets no claim section and its
provider receives no schema. `BLOCKED.md` with `artifact_exists` remains a supported artefact
sentinel for workflows that prefer it, but Symphonika's own `workflow.yml` and
`refactor-workflow.yml` use `claim_status` — see ADR-2026-10-02-1909.

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

### `close_issue`, `label_issue`, `comment`

These three action kinds write directly to the tracked Issue instead of the tracked pull request.
None of them launches a provider or observes anything external; each performs its GitHub call(s)
once, on the state's first re-evaluation tick, and the walk always advances (or blocks)
immediately afterward:

```yaml
action:
  kind: label_issue
  labels: [agent-complete]
  method: add # or remove; defaults to add
```

```yaml
action:
  kind: comment
  body: "Part of this issue landed in #252; remaining scope tracked here."
```

```yaml
action:
  kind: close_issue
  state_reason: completed # or not_planned; defaults to completed
  body: "Closing as complete." # optional, posted before the issue is closed
```

A `label_issue` state is a System state, not a terminal state — it cannot declare `terminal`
alongside its `action`. Reaching `agent-complete` on success typically looks like a non-terminal
labeling state that transitions unconditionally into the terminal state:

```yaml
states:
  labeling_complete:
    action:
      kind: label_issue
      labels: [agent-complete]
    transitions:
      - to: done
  done:
    terminal: success
```

| Field | Required | Meaning |
| --- | --- | --- |
| `labels` (`label_issue`) | yes | Non-empty list of labels to add or remove |
| `method` (`label_issue`) | no | `add` or `remove`; defaults to `add` |
| `body` (`comment`) | yes | Comment text to post |
| `body` (`close_issue`) | no | Comment posted before the issue is closed |
| `state_reason` (`close_issue`) | no | `completed` or `not_planned`; defaults to `completed` |

Each GitHub call is best-effort: a tracker without the method, or a call that throws, is logged and
the walk still advances, the same way `ClaimLabelWriter`'s own label writes are best-effort. There
is nothing to retry an issue-content mutation against on a later tick, so failing the walk here
would only strand it — an author normally writes `complete_when: {}` and an unconditional
transition so the state always advances on this first tick. See ADR-2026-09-05-0807.

## 6. Predicates and signal availability

Predicate values are scalars and comparisons use strict equality. Symphonika has no inequality,
range, regular-expression, `or`, or negation syntax. Multiple fields in one map mean logical
`and`.

The parser recognizes the following keys:

| Predicate | Useful values | Agent result | Wait/merge poll | Current status |
| --- | --- | --- | --- | --- |
| `provider_success` | `true`, `false` | yes | always `true` | supported |
| `branch_ahead_of_base` | `true`, `false` | yes | no | supported |
| `branch_advanced_since_attempt_start` | `true`, `false` | yes | no | supported |
| `pr_open` | `true`, `false` | no | always | supported |
| `pr_merged` | `true` | no | only when merged | supported |
| `mergeable` | `true`, `false` | no | omitted while unknown | supported |
| `checks` | `success`, `failure`, `pending` | no | omitted while unknown | supported |
| `review_decision` | `approved`, `changes_requested`, `review_required`, `none` | no | always | supported |
| `has_unresolved_reviews` | `true`, `false` | no | always | supported |
| `unresolved_review_threads` | non-negative integer | no | always | supported, exact count only; a wait transition may only gate on `0` — a positive value fails `workflow validate` (issue #632), use `has_unresolved_reviews: true` |
| `artifact_exists` | path, or a sequence of paths | yes | yes | supported, existence only |
| `claim_status` | `success`, `blocked`, `failure` | yes, when the final message was a valid Workflow Claim | no | supported, opt-in — see Workflow Claim above; naming it on a `wait`/`merge_pr` state fails `workflow validate`, the same way it does on `close_issue`/`label_issue`/`comment` |

`branch_ahead_of_base` counts commits ahead of `origin/<base_branch>`, not ahead of the commit the
attempt started from. It is a property of the branch, not of the attempt: in a multi-state walk it
stays `true` for every later state once any earlier state has committed.

`branch_advanced_since_attempt_start` is attempt-local. Symphonika snapshots a digest of
`git diff origin/<base_branch>...HEAD` after Workspace preparation and before the provider runs. The
signal is true whenever the completion digest differs from that snapshot. Diff content, not `HEAD`'s
SHA, is what's compared: a mid-attempt `git rebase`/`reset --hard` onto an advanced base rewrites the
attempt's own earlier commits to new SHAs even though real work was strictly added, and blob hashes
are content-addressed, so a clean rebase reproduces the same diff text and the same digest
(symphonika#806). A same-content rewrite with no real new work — a bare `git commit --amend`, a
no-diff reword/squash, or a rebase that adds no new commit — also reproduces the same digest, so it
correctly reads as `false`. Combine it with `branch_ahead_of_base` when a state must create and
retain its own commit. See ADR-2026-09-22-1417.

`artifact_exists` is the one predicate whose value is a query argument rather than an expected
observation, so it is not compared against a signal at all — Symphonika resolves each path against
the Run Workspace and checks whether it is there:

```yaml
transitions:
  - to: implementing
    when:
      provider_success: true
      artifact_exists: PLAN.md
  - to: needs_plan
```

Rules:

- Paths are Workspace-relative. Absolute paths and paths escaping the Workspace are rejected by
  `workflow validate` rather than silently never matching.
- A sequence gates on **all** listed paths existing: `artifact_exists: [PLAN.md, docs/notes.md]`.
- Existence only. There is no content inspection, no non-empty check, and no "does not exist" form.
  A directory counts as existing; a dangling symlink does not.
- The file does not have to be committed. Reading uncommitted Workspace state is the point: a
  planning stage can hand a plan to the next stage without pushing it into the branch history.
- Because Workspaces are reused across attempts (ADR 0040), an artefact a *previous* attempt wrote
  still satisfies the predicate. `artifact_exists` answers "is the artefact there", not "did this
  attempt just produce it" — pair it with `branch_advanced_since_attempt_start` when a state must
  also have moved the branch.
- A state whose predicate names an artefact but which never had a Workspace prepared blocks, with
  the reason naming the paths it could not check.
- In a `wait` or `merge_pr` state the predicate is checked against the Workspace carried onto the
  waiting row when the walk parked, so it sees the same files the agent stage left behind. A wait
  state whose predicates are *only* artefact predicates is polled without a tracked pull request —
  the poll has everything it needs on disk. A wait state that also names PR predicates, and every
  `merge_pr` state, still waits for Symphonika to track a pull request first, because an unprojected
  PR signal reads as unmet and would otherwise drop the state onto a catch-all transition on its
  first poll.

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
  - to: repair
    when:
      has_unresolved_reviews: true
```

With no final catch-all, a wait state stays parked when checks are pending or mergeability is
unknown.

Name the unresolved-review case explicitly, as above. Nothing outside the state machine will pick it
up: the orchestrator-wide PR follow-up loop defers entirely to a raw FSM parked at a state of its
own, or still actively running an earlier state's turn (ADR 0090, corrected by ADR-2026-09-18-0849),
so a wait state that gates `merge` on `unresolved_review_threads: 0` and routes
`repair` only on `checks: failure` parks forever on the commonest shape there is — green checks with
one open thread. Order it after `merge`, so a clean and fully resolved PR still merges.

`workflow validate`, `doctor`, and daemon reload reject this dead end before a Run can park on it.
For every wait state with PR-signal transitions, validation checks the cross-product of settled
checks (`success` or `failure`), concrete mergeability, resolved/unresolved feedback, open/closed PR
state, merged state, and review decisions. A transition must match each observation. Pending checks
are excluded because waiting for them to settle is the wait action's purpose; unknown mergeability
is excluded the same way, but only while the PR is open -- a wait re-evaluates against whatever the
tracked PR's current state is regardless of which state the run parked in, so a merge or an unmerged
close landing while parked is itself a settled observation, and GitHub does not keep recomputing
mergeability once a PR closes, merged or not, so unknown mergeability stops being transient and
needs a covering transition (the shipped `wait_for_pr`'s `pr_merged: true -> merged` catch-all
covers the merged half of that; its unconditional `pr_open: false -> failed` escape covers the
closed-unmerged half, mergeable resolved or not). Pure artefact waits are not PR-signal waits, and
mixed artefact gates are excluded because a missing file is itself an intentional reason to stay
parked.

A transition from a repair state back to the wait it came from makes a cycle. That is expected and
supported: the progress guard stops it from spinning by refusing to re-take an edge on an
observation identical to the one it was last taken on, parking the run and raising manual attention
instead. The guard compares what it can see — the projected signals, the artefact probes for paths
this state's predicates name, the head SHA, and the review conversation — so a repair that changes
nothing observable is caught, while one that pushes a fix is not.

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

## 8. Common shapes

Symphonika has no template, import, or sub-graph mechanism: every state of a workflow is declared
under `workflow.states` in one file. The recurring shapes are worked out in full in the Symphonika
skill's [EXAMPLES.md](../skills/symphonika/EXAMPLES.md), which is validated by the test suite:

| Shape | Example |
| --- | --- |
| One agent, then stop | Example 3, implement-and-stop |
| Implement, review-feedback loop, conflict resolution, merge | Example 2 |
| Planning agent, then implementation agent | Example 5 |
| Wait and autofix until the PR is clean | Example 6 |
| Workflow-owned `merge_pr` with a fixed method | Example 7 |
| Characterization-gated refactor (`red_team`, `refactoring`, `verifying`) | Example 8, and the repository's [`refactor-workflow.yml`](../refactor-workflow.yml) |

To combine shapes, copy the states of each into one `states` map, keep state ids unique, and point
one shape's success transition at the next shape's first state.

`workflow.use` and the `builtin:<name>` templates (`single-agent-pr`, `plan-tdd-pr`,
`refactor-swarm`, `autofix-until-clean`, `merge-when-green`) were removed by
[ADR-2026-09-30-0848](./adr/2026-09-30-0848-remove-workflow-templates.md). A workflow that still
declares `workflow.use` fails validation with `workflow.use is not supported`. To migrate, replace
each instance with the states its template used to expand to. Expansion named each state
`<instance>.<state>`; dots are legal in state ids, so keeping those names preserves the state ids
of runs that are already parked mid-workflow. Also update `initial:` and every `to:` that named an
instance: they must now name the state explicitly (`shipit` becomes `shipit.agent`, the entry
state the template expanded to). Exits the instance mapped (`exits: { success: done }`) never
produced a state of their own: transitions that led to them pointed at the mapped target, so
retarget those transitions at that state (`done`) instead of at `<instance>.<exit state>`.

## 9. Execution semantics

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

The graph content hash covers the workflow file. The run-detail page can render the captured graph,
and `show-run` reports state transitions alongside attempts.

## 10. Validation and inspection

Validate the selected Project without dispatching:

```sh
symphonika workflow validate --config symphonika.yml --project my-app
```

Print the graph:

```sh
symphonika workflow explain --config symphonika.yml --project my-app
```

Both commands select the Project from the Service Config, load the workflow, and report graph and
parse errors. `validate` also prints a summary of the graph.

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
- a PR-observing wait state with no transition for a settled actionable signal combination; or
- a `workflow.use` block, which is no longer supported.

## 11. Supported, reserved, and unsupported

### Safe to use

- Markdown single-agent contracts
- Raw FSMs with `agent`, `wait`, `merge_pr`, `close_issue`, `label_issue`, and `comment`
- Ordered strict-equality transitions
- Supported agent-result and PR predicates from the table above
- Per-state Codex/Claude/OMP routing
- Poll-driven wait and policy-controlled merge loops
- Issue content actions (`close_issue`, `label_issue`, `comment`) chained after a `merge_pr` or
  `wait` state

### Parsed but not operational

The current parser recognizes this action kind from the broader workflow design, but nothing
executes it:

- `fail`

Every predicate the parser accepts now has an evaluator behind it, so there are no reserved
predicate names. `branch_pushed` and `timeout` were previously accepted and never evaluated; they
are now rejected as unknown predicates. A `when` clause that validates is a `when` clause that can
match.

### Not supported

- parallel or fan-out states
- nested workflows or dynamic state creation
- scripts, webhooks, arbitrary commands, or human-approval states
- reusable workflow templates or sub-graph composition (`workflow.use` was removed)
- conditionals or helpers inside prompts
- numeric comparisons or ranged predicates
- mid-walk label predicates
- time-based wait-state transitions
- cross-repository pull requests

## 12. Complete issue-to-merge example

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
            mergeable: false
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
[ADR-2026-09-30-0848](./adr/2026-09-30-0848-remove-workflow-templates.md).
