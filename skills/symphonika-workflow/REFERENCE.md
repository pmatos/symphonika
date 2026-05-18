# Symphonika Workflow Reference

Authoritative source: `SPEC.md` and `docs/adr/` in the target Symphonika project. This file is a fast capability check for the workflow-design grilling loop. Re-read the canonical sources if anything below looks stale.

## Workflow contract formats

| Format | File | When to use |
|---|---|---|
| Markdown single-state | `WORKFLOW.md` | One agent run per dispatch, no branching, no waits |
| Raw FSM YAML | `workflow.yml` (or any path the Project's `workflow:` setting names) | Multi-state walks, wait-on-PR, merge gates, conditional repair branches |

Markdown workflows compile to a one-state compatibility graph. Raw FSM workflows declare states explicitly. Both go through the same expansion and evidence pipeline (see ADR 0045).

## State action kinds

Only these three are supported:

- `agent` — launches a coding agent (Codex or Claude) with a rendered prompt.
- `wait` — pauses the walk until observable PR conditions change. Re-evaluated each daemon tick.
- `merge_pr` — merges the workflow instance's tracked PR when policy is satisfied; otherwise stays parked.

Anything else (`webhook`, `timer`, `script`, `branch`, `parallel`, `fan_out`, `human_input`) is **not supported**.

## Supported predicates

Used inside `transitions[].when` and matched by strict equality (state-machine-dispatch.ts). Available signals (see ADR 0047, ADR 0048):

- `provider_success: true | false`
- `branch_ahead_of_base: true | false`
- `pr_open: true | false`
- `pr_merged: true | false`
- `mergeable: true | false` (omitted when GitHub reports `UNKNOWN`/`null` — transitions writing `mergeable: false` will not match on unknown)
- `checks: success | failure | pending`
- `review_decision: approved | changes_requested | review_required | none`
- `has_unresolved_reviews: true | false`
- `unresolved_review_threads: <integer>` (exact count match)

Reserved but unimplemented in v1: `timeout`.

Transitions without `when` are catch-alls. Top-down order matters: first match wins.

## Providers

- `codex` — JSON-RPC app-server, default command in `symphonika.yml` `providers.codex`.
- `claude` — `stream-json` CLI, default command in `providers.claude`.

Per-state `action.provider` is declared in the FSM, but **may currently be ignored at runtime** — `executeStateAdvance` uses `project.agent.provider` in some configurations (see the inline comment in this repo's `workflow.yml`). If the user depends on per-state routing working today, verify with `symphonika doctor` and the latest code; if it is still gapped, treat per-state provider routing as **partially supported** and flag this to the user.

## Templating

Strict Mustache-style. Unknown variables fail prompt rendering — there is no fallback. No arbitrary JavaScript in templates.

Top-level objects:

- `project` — `name`
- `issue` — `number`, `title`, `body`, `state`, `url`, `labels`, `created_at`, `updated_at`, `priority`
- `workspace` — `path`, `root`, `previous_attempt`
- `branch` — `name`, `ref`
- `run` — `id`, `attempt`, `continuation`
- `provider` — `name`

The autonomy preamble (SPEC §5.3) is prepended automatically; do not duplicate it in the prompt body.

## File path conventions

- `WORKFLOW.md` lives at the repository root by convention. The Project's `workflow:` setting in `symphonika.yml` may name any path.
- Multi-state FSM YAML is conventionally `workflow.yml` at the repo root.
- Per-state agent prompts (when an `agent` state declares `prompt: <path>`) live under `prompts/` by convention (see this repo: `prompts/autofix-pr.md`, `prompts/resolve-conflicts.md`).

## Supported vs unsupported

### Supported

- Single-state markdown workflow
- Multi-state FSM with `agent` / `wait` / `merge_pr` actions
- Strict-equality predicates from the list above
- Mustache substitution of the documented top-level objects
- Continuations on success when issue still eligible (default cap 3)
- Retry on transient infrastructure failures (default cap 3, delays 10s/30s/2m)
- Poll-driven re-evaluation of `wait` and `merge_pr` states
- Operational labels (`sym:claimed`, `sym:running`, `sym:failed`, `sym:stale`) — orchestrator-owned, not workflow-controlled

### Not supported (file a feature request)

- Webhook-driven dispatch (poll-only in v1; SPEC §9.4, §16)
- Workspace auto-cleanup, stale-claim TTL (SPEC §16)
- Cross-repository PRs (SPEC §2)
- Provider sandboxing / approval workflows (SPEC §2; full-permission only)
- Distributed workers / remote execution (SPEC §2)
- GitHub Projects board integration (SPEC §2)
- Issue-body dependency parsing (SPEC §2)
- Provider-neutral GitHub tools for agents (SPEC §11.5, §16)
- Predicates beyond the listed set (e.g. label-driven mid-walk, body-text, time-of-day)
- Conditional logic inside prompts (no `{{#if}}`, no helpers — strict Mustache only)
- Parallel agent runs per issue
- Action kinds other than `agent` / `wait` / `merge_pr`
- Mid-walk label re-checks (FSM owns transitions; `labels_all` / `labels_none` are dispatch-time only — ADR 0046)

### Partially supported (verify before relying on)

- Per-state `action.provider` routing — schema-validated but may not route at runtime; check current code
- `unresolved_review_threads` exact-count matching (works) vs. ranged comparisons (not supported)

## Run lifecycle reminders for prompt design

- Agent owns: PR creation, `agent-ready` removal, comments, conventional commit messages, closing the loop with the user.
- Orchestrator owns: workspace prep, branch creation, label-based dispatch safety, success/failure marking, continuations, retries, PR follow-up polling.
- A Run succeeds when the provider exits 0 AND the issue branch has commits ahead of base. No commits = `failed` with `no_workspace_changes`.
- `needs-human` (or any handoff label) as an agent exit strategy is forbidden by the autonomy preamble — the agent must comment and exit cleanly instead.
