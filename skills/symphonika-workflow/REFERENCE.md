# Symphonika Workflow Reference

**Canonical source: `docs/workflows.md`** in the Symphonika checkout — "the complete authoring
reference for Symphonika issue workflows." `SPEC.md` is the implementation contract; `docs/adr/`
holds the individual decisions. This file is a *skill-specific* capability-gate summary for the
grilling loop, not a substitute for `docs/workflows.md` — when a claim here and `docs/workflows.md`
disagree, `docs/workflows.md` wins and this file is stale. (See SKILL.md's Quick start for the
target-project-vs-Symphonika-checkout setup this skill assumes.)

## Workflow contract formats

| Format | File | When to use |
|---|---|---|
| Markdown single-state | `WORKFLOW.md` | One agent run per dispatch, no branching, no waits |
| Raw FSM YAML | `workflow.yml` (or any path the Project's `workflow:` setting names) | Multi-state walks, wait-on-PR, merge gates, conditional repair branches |

`symphonika.yml`'s `projects[].workflow` accepts either a bare path (format inferred from extension)
or a mapping `{ path, format: markdown | raw_fsm | auto }` where `format` overrides extension
inference. Check which form the target project uses before assuming the shape from the filename
alone (`docs/workflows.md`'s Workflow formats section).

## State action kinds

Six action kinds have complete runtime behavior: `agent`, `wait`, `merge_pr`, `close_issue`,
`label_issue`, `comment`. `fail` is parsed but nothing executes it (see "Parsed but not
operational" below) — don't design a workflow around it.

- `agent` — launches Codex, Claude, or OMP with a rendered prompt (`prompt` required).
- `wait` — parks the walk until PR signals change; polled every daemon tick. No `prompt`/`provider`/`method`.
- `merge_pr` — policy-gated merge of the tracked PR. Optional `method: merge | rebase | squash` (defaults to `pull_requests.merge.method`).
- `close_issue` / `label_issue` / `comment` — orchestrator writes directly to the tracked Issue, no agent involved, best-effort, fires once per state entry and always advances afterward. `label_issue` requires non-empty `labels` (+ optional `method: add | remove`); `comment` requires `body`; `close_issue` takes optional `body`/`state_reason: completed | not_planned`. See the Actions section's `ADR-2026-09-05-0807` note on why these are best-effort with an unconditional transition, not retried.
  - Nothing stops `label_issue` from naming `agent-ready` or a `sym:*` label — don't: those are orchestrator-owned out-of-band and a workflow write races them.
  - PR creation and `agent-ready` removal have no dedicated action kind — see "Run lifecycle reminders" below.

`complete_when` is a real, optional per-state field — ask about it alongside transitions whenever a
state's completion condition differs from its advance condition (see the States section for the
field table).

## Reusable workflow templates (`workflow.use`)

A raw FSM can splice in a named sub-graph instead of hand-authoring every state — see
[EXAMPLES.md](EXAMPLES.md#5-using-a-built-in-workflow-template) for a worked sample. Mechanics:

- `template:` is `builtin:<name>` or a path relative to the workflow file (must stay inside its directory).
- `with:` supplies the template's declared typed inputs.
- `exits:` maps the template's named exits onto state IDs in your graph.
- `initial:`/a transition `to:` may name the bare instance id (resolves to `<instance>.<entry-state>`) or the fully-expanded `<instance>.<stateId>` directly — both work; prefer the bare form to match `docs/workflows.md`'s own examples.
- Built-ins exist today (five, as of this writing) — read `docs/workflows.md`'s built-in-templates table for the current list, each one's inputs/defaults/exits, and exact expanded behavior. Don't guess their semantics from the name, and don't trust a specific count or name list here without checking that table — it's exactly the kind of detail that drifts.

## Predicates

Strict equality only — no ranges, regex, `or`, or negation; multiple keys in one `when` map are
`and`. `docs/workflows.md`'s predicates section has the full, current predicate/signal-availability
table (don't rely on a name list copied here — it drifts) plus several sharp edges worth reading
before designing a `wait` state's transitions: missing vs. `false` are different
(`pr_merged`/`mergeable`/`checks` are *omitted*, not `false`, while unsettled),
`unresolved_review_threads` only matches an exact count (a positive-value gate fails
`workflow validate` per issue #632 — use `has_unresolved_reviews: true` instead), and a wait state
with only artifact predicates polls without needing a tracked PR at all.

`timeout` and `branch_pushed` are **not** reserved-but-unimplemented — they're rejected outright as
unknown predicate names (a `when` clause naming them fails validation, it doesn't silently never
match). Don't tell a user either is coming later without checking `docs/workflows.md` first.

Transitions without `when` are catch-alls. Top-down order matters: first match wins.
`docs/workflows.md` has a worked example of a dead-end order bug (gating `merge` on
`unresolved_review_threads: 0` while routing `repair` only on `checks: failure` parks forever on
"green checks, one open thread") — walk through that shape explicitly when a wait state has both a
merge path and a repair path.

## Providers

`codex`, `claude`, `omp` (Oh My Pi) — `action.provider` on an `agent` state, falling back to the
Project's `agent.provider` when omitted. Per-state routing is fully honored; mix providers freely
across states in one FSM.

## Prompt templating

Strict `{{object.field}}` Mustache-style; unknown objects/fields/helpers fail validation, no
conditionals. `docs/workflows.md`'s prompt-variables table has the current top-level objects and
fields — don't rely on a field list copied here without checking it (past drift: this file was
missing `issue.id` and `provider.command` for a while). Arrays/objects (e.g. `issue.labels`) render
as JSON. The autonomy preamble and previous-attempt notice are added automatically — don't duplicate
them in the prompt body.

This is a *separate* substitution pass from `workflow.use` template `with:` values — same `{{ }}`
syntax, different variable sets, different stage.

## Terminal states

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

## Supported vs unsupported

`docs/workflows.md`'s "Supported, reserved, and unsupported" section is the definitive, current list
— don't rely on a copy here going stale. Common asks worth naming explicitly because they come up in
the grilling loop:

- Not supported: parallel/fan-out states, webhooks/scripts/human-approval states, remote template
  registries, conditionals inside prompts, ranged/numeric predicates, mid-walk label predicates,
  time-based wait transitions, cross-repository PRs, provider sandboxing.
- Parsed but not operational: the `fail` action kind, and the `timeout`/`branch_pushed` predicate names.
- Operational labels (`sym:*` namespace, plus `agent-ready`) are orchestrator-owned — a workflow's
  own `label_issue` action should avoid naming them (see State action kinds above).

## Run lifecycle reminders for prompt design

These specifics aren't in `docs/workflows.md` — they're sourced from `src/lifecycle/` — so verify
against source (`run-controller.ts`, `claim-label-writer.ts`) rather than trusting them blind if the
design leans on the exact details:

- Agent owns (from inside an `agent` state's prompt): PR creation, `agent-ready` removal, conventional commit messages, closing the loop with the user.
- Orchestrator can act directly via `comment` / `label_issue` / `close_issue` states without an agent run at all.
- Orchestrator always owns: workspace prep, branch creation, dispatch safety, success/failure marking, continuations, retries, PR follow-up polling.
- A Run succeeds when the provider exits 0 AND the issue branch has commits ahead of base. No commits = `failed` with `no_workspace_changes`.
- `needs-human` (or any handoff label) as an agent's own exit strategy is forbidden by the autonomy preamble — the agent must comment and exit cleanly instead. A workflow's own `close_issue`/`label_issue` states are an explicit authored decision, not the agent improvising an exit, and aren't restricted by the preamble.

## Validation and inspection

Before dispatching, run (against the target project):

- `symphonika workflow validate --project <name>` — validates the expanded graph for one project; prefer this when iterating on one workflow.
- `symphonika workflow explain --project <name>` — prints the expanded graph, including `workflow.use` template expansion, for review.
- `symphonika doctor` — broader service-level check that also validates workflow contracts, but isn't the targeted tool for one workflow.
