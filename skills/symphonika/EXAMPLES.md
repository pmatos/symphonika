# Symphonika Workflow Examples

Copy one of these shapes, then specialize during the grilling loop. Symphonika has no workflow templates or reusable sub-graphs: every FSM is authored in full, state by state, so these examples are the starting points (Examples 5–8 are the common shapes, ready to paste). Every `yaml` workflow block here is validated by `tests/skill-examples.test.ts`.

## 1. Single-state Markdown workflow

Use when one provider run per dispatch is enough.

```markdown
# Implement issue #{{issue.number}} — {{issue.title}}

## Source of truth
- `SPEC.md` is the implementation contract.
- Domain language is in `CONTEXT.md`.
- Architecture decisions live under `docs/adr/`.

## Issue under work
- Number: #{{issue.number}}
- Title: {{issue.title}}
- URL: {{issue.url}}
- Labels: {{issue.labels}}

### Issue body
{{issue.body}}

## Run context
- Project: {{project.name}}
- Run id: {{run.id}}
- Attempt: {{run.attempt}}
- Provider: {{provider.name}}

## Workspace
Your current working directory is {{workspace.path}}.
You are on issue branch {{branch.name}} ({{branch.ref}}).

## What to do
1. Read relevant docs.
2. Implement the change using TDD, smallest viable slice.
3. Run lint, typecheck, test, build locally.
4. Commit and push branch {{branch.name}}.
5. Open a non-draft PR against `main` with `gh pr create`.
6. On success, remove `agent-ready` with `gh issue edit {{issue.number}} --remove-label agent-ready`.
7. If blocked, comment on the issue explaining why, write `EVIDENCE.md`, exit cleanly.

## Constraints
- Run unattended. No human will answer mid-run.
- Use the local `gh` CLI for every GitHub mutation. Do not use the GitHub MCP connector.
- Do not self-apply `needs-human`.
```

## 2. Multi-state FSM with autofix + merge

Use when you want the orchestrator to walk the run through review feedback, conflict resolution, and a policy-gated merge.

This shape references two per-state prompt files (`prompts/autofix-pr.md` and `prompts/resolve-conflicts.md`) via `action.prompt:`. The skill must write both alongside the workflow contract — Symphonika fails workflow validation/launch with `workflow state ... prompt not found` if any referenced prompt file is missing. Use [Example 4](#4-per-state-prompt-file) as the template body for each one, specialized for its state's responsibility.

```yaml
workflow:
  name: implement_review_merge
  initial: implement
  states:

    implement:
      action:
        kind: agent
        provider: codex
        prompt: WORKFLOW.md
      transitions:
        - to: wait_for_pr
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: failed

    wait_for_pr:
      action:
        kind: wait
      transitions:
        - to: merged
          when:
            pr_merged: true
        - to: failed
          when:
            pr_open: false
        - to: merge
          when:
            checks: success
            mergeable: true
            unresolved_review_threads: 0
        - to: resolve_conflicts
          when:
            mergeable: false
        - to: autofix
          when:
            checks: failure
        - to: autofix
          when:
            has_unresolved_reviews: true

    autofix:
      action:
        kind: agent
        provider: claude
        prompt: prompts/autofix-pr.md
      transitions:
        - to: wait_for_pr
          when:
            provider_success: true
        - to: failed

    resolve_conflicts:
      action:
        kind: agent
        provider: claude
        prompt: prompts/resolve-conflicts.md
      transitions:
        - to: wait_for_pr
          when:
            provider_success: true
        - to: failed

    merge:
      action:
        kind: merge_pr
      transitions:
        - to: merged
          when:
            pr_merged: true
        - to: failed
          when:
            pr_open: false
        - to: resolve_conflicts
          when:
            mergeable: false
        - to: autofix
          when:
            checks: failure

    merged:
      terminal: success

    failed:
      terminal: blocked
```

## 3. Implement-and-stop (FSM with no PR follow-up)

Use when the project wants FSM evidence shape and named terminals, but no wait-on-PR loop.

```yaml
workflow:
  name: implement_only
  initial: implement
  states:

    implement:
      action:
        kind: agent
        provider: codex
        prompt: WORKFLOW.md
      transitions:
        - to: done
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: failed

    done:
      terminal: success

    failed:
      terminal: blocked
```

## 4. Per-state prompt file

When using a multi-state FSM, each `agent` state can name its own prompt file. A minimal agent prompt file looks like:

```markdown
# Address review feedback on PR for issue #{{issue.number}}

You are continuing work on {{branch.name}} after review feedback landed on the open PR.

## What to do
1. Read every unresolved review thread on the PR.
2. Fix the concerns. Use TDD where behavior changes.
3. Push to {{branch.name}}; do not open a new PR.
4. Re-request review only if the original reviewer explicitly asked for it.

## Constraints
- Use the local `gh` CLI for every GitHub mutation.
- Do not self-apply `needs-human`.
- Do not modify operational labels (`sym:*` namespace).
```

## 5. Plan, then implement (two agents)

A planning agent writes `PLAN.md`; an implementation agent then builds it. Planning is gated on the plan file actually existing — `provider_success` alone would advance an empty plan to the implementer.

```yaml
workflow:
  name: plan_then_implement
  initial: planning
  states:

    planning:
      action:
        kind: agent
        provider: codex
        prompt: prompts/plan.md
      transitions:
        - to: implementing
          when:
            provider_success: true
            artifact_exists: PLAN.md
        - to: failed

    implementing:
      action:
        kind: agent
        provider: codex
        prompt: prompts/impl.md
      transitions:
        - to: done
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: failed

    done:
      terminal: success

    failed:
      terminal: blocked
```

## 6. Autofix loop until the PR is clean

Wait on the tracked PR, run an autofix agent when review threads or checks need work, then wait again. The loop is bounded by predicates only — there is no iteration counter, so a stuck loop needs a human to cancel the run.

```yaml
workflow:
  name: autofix_until_clean
  initial: waiting
  states:

    waiting:
      action:
        kind: wait
      transitions:
        - to: done
          when:
            checks: success
            unresolved_review_threads: 0
        - to: failed
          when:
            checks: failure
        - to: autofix
          when:
            has_unresolved_reviews: true

    autofix:
      action:
        kind: agent
        provider: codex
        prompt: prompts/autofix-pr.md
      transitions:
        - to: waiting
          when:
            provider_success: true
        - to: failed

    done:
      terminal: success

    failed:
      terminal: blocked
```

## 7. Merge when green

Start directly in the `merge_pr` state when the workflow should own the merge. It applies its own `method` and does its own readiness check; a `wait` state in front leaves a window where the global PR follow-up merges first with the policy-default method. There is deliberately no catch-all transition: readiness deferrals stay parked, and deterministic refusals are terminalized by reconciliation.

```yaml
workflow:
  name: merge_when_green
  initial: merging
  states:

    merging:
      action:
        kind: merge_pr
        method: squash
      transitions:
        - to: done
          when:
            pr_merged: true
        - to: failed
          when:
            pr_open: false
        - to: failed
          when:
            checks: failure
        - to: failed
          when:
            mergeable: false

    done:
      terminal: success

    failed:
      terminal: blocked
```

## 8. Characterization-gated refactor (red-team → refactor → verify)

Three serial agents: one characterizes current behavior, one refactors, one independently verifies read-only. A rejected pass writes `BLOCKED.md` instead of relying on a non-zero exit code — a failing Bash call only ends that subshell, not the provider session, so `provider_success` reads true regardless. The `BLOCKED.md` transition therefore comes first in every state. Requiring `branch_advanced_since_attempt_start` makes each pass add a new commit.

```yaml
workflow:
  name: characterization_gated_refactor
  initial: red_team
  states:

    red_team:
      action:
        kind: agent
        provider: codex
        prompt: prompts/red-team.md
      transitions:
        - to: blocked
          when:
            artifact_exists: BLOCKED.md
        - to: refactoring
          when:
            provider_success: true
            branch_advanced_since_attempt_start: true
            branch_ahead_of_base: true
        - to: blocked

    refactoring:
      action:
        kind: agent
        provider: codex
        prompt: prompts/refactor.md
      transitions:
        - to: blocked
          when:
            artifact_exists: BLOCKED.md
        - to: verifying
          when:
            provider_success: true
            branch_advanced_since_attempt_start: true
            branch_ahead_of_base: true
        - to: blocked

    verifying:
      action:
        kind: agent
        provider: codex
        prompt: prompts/verify.md
      transitions:
        - to: blocked
          when:
            artifact_exists: BLOCKED.md
        - to: done
          when:
            provider_success: true
        - to: blocked

    done:
      terminal: success

    blocked:
      terminal: blocked
```

## Combining shapes

There is nothing to import: to chain shapes, copy the states of each into one `states:` map and point one shape's terminal-success exit at the next shape's first state. For example, to run Example 5 and then Example 6, replace Example 5's `done` with a transition into `waiting` (`- to: waiting` on `implementing`) and paste Example 6's `waiting`, `autofix`, `done`, and `failed` states in. Keep state ids unique across the file.

## Picking between shapes

| You want | Use |
|---|---|
| One shot, no PR follow-up | Example 1 (Markdown) or Example 3 (FSM evidence shape) |
| Implement + review loop + auto-merge | Example 2 |
| Multi-state evidence, no PR loop | Example 3 |
| Per-state agent prompts | Example 4 (with Examples 2/3) |
| Plan first, then implement | Example 5 |
| Review-feedback loop on an existing PR | Example 6 |
| Workflow-owned merge with a fixed method | Example 7 |
| Behavior-preserving refactor with a verify gate | Example 8 |
