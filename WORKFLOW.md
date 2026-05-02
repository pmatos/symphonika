# Symphonika implementation issue: #{{issue.number}} {{issue.title}}

## Source of truth

- Implementation contract: `SPEC.md`
- Domain language: `CONTEXT.md`
- Architecture decisions: `docs/adr/`
- Repository conventions: `AGENTS.md`

The upstream `symphony/` directory is a reference submodule and must not be modified.

## Issue under work

- Number: #{{issue.number}}
- Title: {{issue.title}}
- URL: {{issue.url}}
- Labels: {{issue.labels}}
- Created: {{issue.created_at}}
- Updated: {{issue.updated_at}}

### Issue body

{{issue.body}}

## Run context

- Project: {{project.name}}
- Run id: {{run.id}}
- Attempt: {{run.attempt}}
- Continuation: {{run.continuation}}
- Provider: {{provider.name}}

## Workspace

Your current working directory is {{workspace.path}}.
Workspace root: {{workspace.root}}.
Previous attempt detected: {{workspace.previous_attempt}}.

You are on the issue branch {{branch.name}} ({{branch.ref}}).
Stay on this branch for all commits. Do not switch branches or open new ones.

## What to do

1. Read `SPEC.md`, `CONTEXT.md`, `AGENTS.md`, and any ADRs in `docs/adr/` that touch the area you are about to change.
2. Investigate the issue body and any code paths it references before writing code. Prefer small, vertical slices.
3. Implement the change. Add or update tests under `tests/` so the new behavior is covered. Do not silently relax existing tests.
4. Run the full local quality gate before pushing:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
5. Commit your changes with a focused message. Push the branch {{branch.name}} to `origin`.
6. Open a pull request against `main` that links to {{issue.url}}.
7. If a workflow handoff label such as `needs-review` or `needs-human` is appropriate, apply it before exiting.
8. Update `SPEC.md`, `CONTEXT.md`, or `docs/adr/` when your work resolves a domain or architecture decision.

## Constraints

- This run executes with full local permissions; do not request operator input.
- If you discover that the issue is blocked, ambiguous, or already resolved, leave a clear note in the workspace (for example, an `EVIDENCE.md` at `{{workspace.path}}/EVIDENCE.md`) and exit cleanly rather than guessing.
- Do not create or edit GitHub labels in the `sym:*` namespace. Those are owned by the orchestrator.
- Do not modify the `symphony/` submodule.
