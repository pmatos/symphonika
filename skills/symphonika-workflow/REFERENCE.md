# Symphonika Workflow Reference

**Canonical source: `docs/workflows.md`** in the target Symphonika checkout — "the complete authoring
reference for Symphonika issue workflows." `SPEC.md` is the implementation contract; `docs/adr/`
holds the individual decisions. This file is a *skill-specific* capability-gate summary for the
grilling loop, not a substitute for `docs/workflows.md` — when a claim here and `docs/workflows.md`
disagree, `docs/workflows.md` wins and this file is stale. Section numbers below (`§N`) refer to
`docs/workflows.md`'s own numbered sections.

Two checkouts are in play while running this skill: the **target project**, whose `WORKFLOW.md` /
`workflow.yml` you are writing, and the **Symphonika checkout** (this repo, wherever it's cloned)
that holds `docs/workflows.md`, `SPEC.md`, `docs/adr/`, and the `src/` implementation you'd read to
verify anything this file doesn't cover. They are usually different repos. Confirm you can reach both
before relying on either.

## Workflow contract formats (§1–3)

| Format | File | When to use |
|---|---|---|
| Markdown single-state | `WORKFLOW.md` | One agent run per dispatch, no branching, no waits |
| Raw FSM YAML | `workflow.yml` (or any path the Project's `workflow:` setting names) | Multi-state walks, wait-on-PR, merge gates, conditional repair branches |

`symphonika.yml`'s `projects[].workflow` accepts either a bare path (format inferred from extension)
or a mapping `{ path, format: markdown | raw_fsm | auto }` where `format` overrides extension
inference. Check which form the target project uses before assuming the shape from the filename
alone (§1).

## State action kinds (§4–5)

Six action kinds have complete runtime behavior: `agent`, `wait`, `merge_pr`, `close_issue`,
`label_issue`, `comment`. `fail` is parsed but nothing executes it (§12, "Parsed but not
operational") — don't design a workflow around it.

- `agent` — launches Codex, Claude, or OMP with a rendered prompt (`prompt` required).
- `wait` — parks the walk until PR signals change; polled every daemon tick. No `prompt`/`provider`/`method`.
- `merge_pr` — policy-gated merge of the tracked PR. Optional `method: merge | rebase | squash` (defaults to `pull_requests.merge.method`).
- `close_issue` / `label_issue` / `comment` — orchestrator writes directly to the tracked Issue, no agent involved, best-effort, fires once per state entry and always advances afterward. `label_issue` requires non-empty `labels` (+ optional `method: add | remove`); `comment` requires `body`; `close_issue` takes optional `body`/`state_reason: completed | not_planned`. See §5's `ADR-2026-09-05-0807` note on why these are best-effort with an unconditional transition, not retried.
  - Nothing stops `label_issue` from naming `agent-ready` or a `sym:*` label — don't: those are orchestrator-owned out-of-band and a workflow write races them.
  - PR creation and `agent-ready` removal still have no dedicated action kind; that stays the agent's job from inside an `agent` state's prompt.

`complete_when` is a real, optional per-state field (a predicate gate evaluated before transitions;
`{}` if omitted) — ask about it alongside transitions when a state's completion condition differs
from its advance condition (§4).

## Reusable workflow templates — `workflow.use` (§8–9)

A raw FSM can splice in a named sub-graph instead of hand-authoring every state:

```yaml
workflow:
  name: my_workflow
  initial: build          # bare instance id resolves to the template's entry state
  use:
    build:
      template: builtin:single-agent-pr
      with:
        provider: codex
        prompt: WORKFLOW.md
      exits:
        success: done
        blocked: failed
  states:
    done:
      terminal: success
    failed:
      terminal: blocked
```

- `template:` is `builtin:<name>` or a path relative to the workflow file (must stay inside its directory).
- `with:` supplies the template's declared typed inputs.
- `exits:` maps the template's named exits onto state IDs in your graph.
- `initial:`/a transition `to:` may name the bare instance id (resolves to `<instance>.<entry-state>`) or the fully-expanded `<instance>.<stateId>` directly — both work; prefer the bare form to match `docs/workflows.md`'s own examples.
- Five built-ins exist today: `builtin:single-agent-pr`, `builtin:plan-tdd-pr`, `builtin:refactor-swarm`, `builtin:autofix-until-clean`, `builtin:merge-when-green`. Read §9's table (inputs/defaults/exits and exact expanded behavior for each) before recommending one — don't guess their semantics from the name.

## Predicates (§6)

Strict equality only — no ranges, regex, `or`, or negation; multiple keys in one `when` map are
`and`. `docs/workflows.md` §6's table is authoritative for the full predicate/signal-availability
matrix, including several sharp edges worth reading before designing a `wait` state's transitions:
missing vs. `false` are different (`pr_merged`/`mergeable`/`checks` are *omitted*, not `false`, while
unsettled), `unresolved_review_threads` only matches an exact count (a positive-value gate fails
`workflow validate` per issue #632 — use `has_unresolved_reviews: true` instead), and a wait state
with only artifact predicates polls without needing a tracked PR at all.

Current predicate keys: `provider_success`, `branch_ahead_of_base`,
`branch_advanced_since_attempt_start`, `pr_open`, `pr_merged`, `mergeable`, `checks`,
`review_decision`, `has_unresolved_reviews`, `unresolved_review_threads`, `artifact_exists`.

`timeout` and `branch_pushed` are **not** reserved-but-unimplemented — they're rejected outright as
unknown predicate names (a `when` clause naming them fails validation, it doesn't silently never
match). Don't tell a user either is coming later without checking `docs/workflows.md` §6/§12 first.

Transitions without `when` are catch-alls. Top-down order matters: first match wins. §6 has a worked
example of a dead-end order bug (gating `merge` on `unresolved_review_threads: 0` while routing
`repair` only on `checks: failure` parks forever on "green checks, one open thread") — walk through
that shape explicitly when a wait state has both a merge path and a repair path.

## Providers

`codex`, `claude`, `omp` (Oh My Pi) — `action.provider` on an `agent` state, falling back to the
Project's `agent.provider` when omitted (§5). Per-state routing is fully honored; mix providers
freely across states in one FSM.

## Prompt templating (§7)

Strict `{{object.field}}` Mustache-style; unknown objects/fields/helpers fail validation, no
conditionals. Top-level objects and fields:

- `project` — `name`
- `issue` — `id`, `number`, `title`, `body`, `state`, `url`, `labels`, `created_at`, `updated_at`, `priority`
- `workspace` — `path`, `root`, `previous_attempt`
- `branch` — `name`, `ref`
- `run` — `id`, `attempt`, `continuation`
- `provider` — `name`, `command`

Arrays/objects (e.g. `issue.labels`) render as JSON. The autonomy preamble and previous-attempt
notice are added automatically — don't duplicate them in the prompt body.

This is a *separate* substitution pass from `workflow.use` template `with:` values (§8) — same
`{{ }}` syntax, different variable sets, different stage.

## Terminal states (§4)

`terminal:` accepts `success`, `blocked`, or `failure`. A terminal state must not also declare
`action`, `complete_when`, or `transitions`. Every non-terminal state needs a transition that can
fire.

- `blocked` — "the workflow deterministically cannot proceed without outside change." Produces a
  distinct blocked Run verdict and `sym:blocked` behavior on supported agent/wait paths; it's the
  give-up terminal parked-state reconciliation explicitly handles. Prefer it for non-actionable
  escape paths from PR wait loops.
- `failure` — "the workflow deterministically failed." On agent-state paths this uses the normal
  failure-label path.
- Cancellation and `input_required` always take precedence over either authored terminal.

## File path conventions

- `WORKFLOW.md` lives at the repository root by convention; the Project's `workflow:` setting may name any path.
- Multi-state FSM YAML is conventionally `workflow.yml` at the repo root.
- Per-state agent prompts (`action.prompt:`) live under `prompts/` by convention (this repo: `prompts/autofix-pr.md`, `prompts/resolve-conflicts.md`).

## Supported vs unsupported (§12)

### Safe to use

- Markdown single-agent contracts and raw FSMs with the six action kinds above
- `workflow.use` templates (local or built-in)
- Ordered strict-equality predicates from §6, including `artifact_exists`
- Per-state Codex/Claude/OMP routing
- Continuations on success (default cap 3), retry on transient infra failure (default cap 3, delays 10s/30s/2m)
- Poll-driven `wait`/`merge_pr` re-evaluation
- Operational labels (`sym:claimed`, `sym:running`, `sym:failed`, `sym:blocked`, `sym:stale`, `sym:human-needed`) — orchestrator-owned; a workflow's own `label_issue` action should avoid naming them

### Not supported (file a feature request)

- Parallel or fan-out states; nested workflows or dynamic state creation
- Scripts, webhooks, arbitrary commands, human-approval states
- Remote template registries
- Conditionals/helpers inside prompts
- Numeric comparisons or ranged predicates; mid-walk label predicates; time-based wait transitions
- Cross-repository PRs
- Provider sandboxing, workspace auto-cleanup, distributed workers, GitHub Projects integration, issue-body dependency parsing (SPEC §2, §16)

### Parsed but not operational

- `fail` action kind — accepted by the parser, never executed
- `timeout`, `branch_pushed` predicates — rejected as unknown, not reserved

## Run lifecycle reminders for prompt design

- Agent owns (from inside an `agent` state's prompt): PR creation, `agent-ready` removal, conventional commit messages, closing the loop with the user.
- Orchestrator can act directly via `comment` / `label_issue` / `close_issue` states without an agent run at all.
- Orchestrator always owns: workspace prep, branch creation, dispatch safety, success/failure marking, continuations, retries, PR follow-up polling.
- A Run succeeds when the provider exits 0 AND the issue branch has commits ahead of base. No commits = `failed` with `no_workspace_changes`.
- `needs-human` (or any handoff label) as an agent's own exit strategy is forbidden by the autonomy preamble — the agent must comment and exit cleanly instead. A workflow's own `close_issue`/`label_issue` states are an explicit authored decision, not the agent improvising an exit, and aren't restricted by the preamble.

## Validation and inspection (§11)

Before dispatching, run (against the target project):

- `symphonika workflow validate --project <name>` — validates the expanded graph for one project; prefer this over `doctor` when iterating on one workflow, since `doctor` covers the whole service.
- `symphonika workflow explain --project <name>` — prints the expanded graph, including `workflow.use` template expansion, for review.
- `symphonika doctor` — broader service-level check; still validates workflow contracts, but isn't the most targeted tool for iterating on a single workflow.
