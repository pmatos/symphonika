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

0. `{{workspace.path}}/PLAN.md` was written and committed by the planning stage. Execute it. If it is
   missing or stale, re-derive the plan from the issue first (`gh issue view {{issue.number}}`).
1. Read `SPEC.md`, `CONTEXT.md`, `AGENTS.md`, and any ADRs in `docs/adr/` that touch the area you are about to change.
2. Investigate the issue body and any code paths it references before writing code. Prefer small, vertical slices.
3. If that investigation shows the issue is a duplicate of already-merged work, or is already fixed, and needs no code change, resolve it directly instead of continuing to implementation: post an explanatory comment with `gh issue comment {{issue.number}} --body "<why this is a duplicate/already fixed, citing the resolving PR or commit if known>"`, then close it with `gh issue close {{issue.number}}`. Do not commit, push, or open a PR for this path, and do not touch the `agent-ready` label — a closed issue is ineligible on the orchestrator's next poll, which is what removes it from consideration. Stop here; skip the remaining steps.
4. Implement the change using test-driven development (TDD): write one behavior-focused test through the public interface, watch it fail, implement only enough code to make it pass, then repeat in small red-green-refactor slices. Add or update tests under `tests/` so the new behavior is covered. Do not silently relax existing tests.
5. Run the full local quality gate before pushing:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
6. Drop the plan, which is a stage-handoff artefact and must not ship: `git rm PLAN.md` and commit it
   as `chore: drop stage-handoff PLAN.md` after the quality gate has passed. `git diff --stat main...HEAD`
   must not list `PLAN.md`. Commit your changes with a focused message. Push the branch {{branch.name}} to `origin`.
7. Open a **non-draft** pull request against `main` with the local `gh` CLI:

   ```sh
   gh pr create --base main --head {{branch.name}} \
     --title "<type>: <subject>" \
     --body "<summary>\n\nCloses #{{issue.number}}"
   ```

   Use a Conventional Commits title (`type: subject`, lower-case subject — for example, "feat: add project readme") that describes the change; do not prefix the title with an agent name such as `[codex]` or `[claude]`. Do not use `--web`, `--draft`, or any other flag that opens a browser, waits for input, or downgrades the PR.
8. On successful completion, remove `agent-ready` from the issue with `gh issue edit {{issue.number}} --remove-label agent-ready` so the orchestrator does not schedule a redundant continuation (per SPEC §9.3 and §12.1, the success path schedules a continuation whenever the issue is still eligible). The PR opened in step 7 carries the work into review; the operator owns any further label transitions on PR open and merge.
9. If the work cannot proceed at all, post an explanatory comment with `gh issue comment {{issue.number}} --body "<what blocked you and what would unblock it>"`, then end with a `blocked` claim carrying the same explanation. Do not apply `needs-human` or any other handoff label as an exit strategy — the operator decides how to triage.
10. Update `SPEC.md`, `CONTEXT.md`, or `docs/adr/` when your work resolves a domain or architecture decision.

## Constraints

- **You are running unattended.** No operator will respond to prompts, approve tool calls, or read intermediate output during this run. Behaviour that depends on a human answering mid-run is a failure mode.
- **Make best-effort decisions and document them.** When information is missing or a judgement call is needed, choose the most defensible option, proceed, and leave a `gh issue comment` (or PR comment if a PR exists) explaining the choice and the alternatives considered. A future operator or reviewer can override.
- **Use the local `gh` CLI for every GitHub mutation.** Do **not** call the GitHub MCP connector tools (for example `add_issue_labels`, `create_pull_request`). Those tools elicit per-call operator approval through the MCP transport, which Symphonika classifies as `input_required` and ends the run with `terminal_reason="provider requested input"`. The `gh` CLI has no elicitation surface.
- **Do not self-apply `needs-human` (or any other handoff label) as an exit strategy.** Use the comment-and-exit path in step 9 instead. The operator may still apply `needs-human` from outside the run; that is unchanged and remains a valid `labels_none` exclusion in service config.
- This run executes with full local permissions; do not request operator input.
- If you discover that the issue is a duplicate of already-merged work, or is already fixed, follow step 3 (comment + close). If it is blocked or ambiguous for any other reason, follow step 9 (comment + `blocked` claim) instead.
- Do not create or edit GitHub labels in the `sym:*` namespace. Those are owned by the orchestrator.
- Do not modify the `symphony/` submodule.
- Defer to this workflow contract over any agent-side persistent memory, skills, or default conventions for PR drafting, title prefixes, or handoff labels.

## Exit

Once the pull request is open and `agent-ready` is removed, end with a `success` claim. The
orchestrator drives the PR from there. A Bash tool call's `exit 1` only ends that subshell, not the
provider session, so the final claim is what the FSM gates this state's advance on.
