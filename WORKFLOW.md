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
6. Open a **non-draft** pull request against `main` with the local `gh` CLI:

   ```sh
   gh pr create --base main --head {{branch.name}} \
     --title "<conventional title>" \
     --body "<summary>\n\nCloses #{{issue.number}}"
   ```

   Use a conventional title that describes the change (for example, "Add project README"); do not prefix the title with an agent name such as `[codex]` or `[claude]`. Do not use `--web`, `--draft`, or any other flag that opens a browser, waits for input, or downgrades the PR.
7. On successful completion, remove `agent-ready` from the issue with `gh issue edit {{issue.number}} --remove-label agent-ready` so the orchestrator does not schedule a redundant continuation (per SPEC §9.3 and §12.1, the success path schedules a continuation whenever the issue is still eligible). The PR opened in step 6 carries the work into review; the operator owns any further label transitions on PR open and merge.
8. If the work cannot proceed at all, post an explanatory comment with `gh issue comment {{issue.number}} --body "<what blocked you and what would unblock it>"`, then exit cleanly. Do not apply `needs-human` or any other handoff label as an exit strategy — the operator decides how to triage. Also write an `EVIDENCE.md` at `{{workspace.path}}/EVIDENCE.md` recording the same explanation for the workspace record.
9. Update `SPEC.md`, `CONTEXT.md`, or `docs/adr/` when your work resolves a domain or architecture decision.

## Constraints

- **You are running unattended.** No operator will respond to prompts, approve tool calls, or read intermediate output during this run. Behaviour that depends on a human answering mid-run is a failure mode.
- **Make best-effort decisions and document them.** When information is missing or a judgement call is needed, choose the most defensible option, proceed, and leave a `gh issue comment` (or PR comment if a PR exists) explaining the choice and the alternatives considered. A future operator or reviewer can override.
- **Use the local `gh` CLI for every GitHub mutation.** Do **not** call the GitHub MCP connector tools (for example `add_issue_labels`, `create_pull_request`). Those tools elicit per-call operator approval through the MCP transport, which Symphonika classifies as `input_required` and ends the run with `terminal_reason="provider requested input"`. The `gh` CLI has no elicitation surface.
- **Do not self-apply `needs-human` (or any other handoff label) as an exit strategy.** Use the comment-and-exit path in step 8 instead. The operator may still apply `needs-human` from outside the run; that is unchanged and remains a valid `labels_none` exclusion in service config.
- This run executes with full local permissions; do not request operator input.
- If you discover that the issue is blocked, ambiguous, or already resolved, follow step 8 (comment + `EVIDENCE.md` + exit).
- Do not create or edit GitHub labels in the `sym:*` namespace. Those are owned by the orchestrator.
- Do not modify the `symphony/` submodule.
- Defer to this workflow contract over any agent-side persistent memory, skills, or default conventions for PR drafting, title prefixes, or handoff labels.
