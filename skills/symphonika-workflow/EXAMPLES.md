# Symphonika Workflow Examples

Copy one of these shapes, then specialize during the grilling loop. All examples are syntactically valid against current Symphonika.

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

## Picking between shapes

| You want | Use |
|---|---|
| One shot, no PR follow-up | Example 1 (Markdown) |
| Implement + review loop + auto-merge | Example 2 |
| Multi-state evidence, no PR loop | Example 3 |
| Per-state agent prompts | Example 4 (with Examples 2/3) |
