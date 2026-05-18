---
name: symphonika-workflow
description: Design and write a Symphonika Workflow Contract (WORKFLOW.md or workflow.yml) by grilling the user one question at a time. Use when the user wants to create, edit, or design a Symphonika workflow, mentions "symphonika workflow", asks how to wire up agent states, wait states, merge_pr states, predicates, or transitions, or describes an orchestration pipeline they want to run under Symphonika. Detects unsupported requirements and offers to file a feature request at pmatos/symphonika.
---

# Symphonika Workflow Designer

Interview the user one question at a time until you can confidently write a valid `WORKFLOW.md` or `workflow.yml` for their Symphonika Project, OR confirm the design needs a Symphonika feature that does not exist yet.

## Quick start

1. Confirm the **target project** — ask the user for the absolute path to the repo whose Workflow Contract you will write. Verify a `symphonika.yml` exists there (or a parent) before continuing.
2. Read [REFERENCE.md](REFERENCE.md) so you can answer capability questions accurately.
3. Run the grilling loop below until every branch is resolved.
4. Choose the artifact (`WORKFLOW.md` or `workflow.yml`), render it from one of the [EXAMPLES.md](EXAMPLES.md) shapes, and write it after the user approves the final draft.

## Grilling loop

Ask **one question at a time**. For each, propose your recommended answer and the reasoning. Walk down each branch of the decision tree, resolving dependencies before moving to the next branch.

Cover at minimum:

1. **Goal** — what should one Run of this workflow accomplish?
2. **Shape** — single-state (Markdown `WORKFLOW.md`) or multi-state (raw FSM `workflow.yml`)? Default to single-state unless the user names at least one of: review-feedback loop, conflict resolution, wait-then-merge, conditional branches.
3. **Providers** — Codex or Claude per agent state? Note ADR-0049 / per-state `action.provider` gap if relevant.
4. **States** — for each FSM node: kind (`agent` | `wait` | `merge_pr`), prompt path (for `agent`), transitions, terminal flag.
5. **Predicates** — which of the supported predicates (see REFERENCE) gate each transition? Reject predicates that do not exist.
6. **Prompt body** — what does the agent need to be told? What templating variables (`issue`, `project`, `workspace`, `branch`, `run`, `provider`) does it use? Confirm every `{{var}}` resolves; strict Mustache fails on unknown vars.
7. **Terminal states** — at least one `terminal: success` and (usually) one `terminal: blocked`. Verify every non-terminal state has a transition that can fire.
8. **Side effects outside the workflow** — `agent-ready` removal, PR opening, comments. Confirm these are agent responsibilities (the orchestrator does not do them).

If a question can be answered by reading `SPEC.md`, `CONTEXT.md`, `docs/adr/`, or the project's existing `symphonika.yml` / current `WORKFLOW.md`, read instead of asking.

## Capability check (gate before writing)

Before drafting the artifact, run through [REFERENCE.md](REFERENCE.md#supported-vs-unsupported) and flag anything the user asked for that is **not** supported in current Symphonika. Common asks that are out of scope today:

- Action kinds other than `agent`, `wait`, `merge_pr`
- Predicates beyond the documented set (e.g. timer-based, body-text-based, label-based mid-walk)
- Webhook triggers instead of poll-based ticks
- Workspace auto-cleanup, cross-repo PRs, provider sandboxing
- Conditional logic inside prompts beyond strict Mustache variable substitution
- Multiple parallel agent runs per issue

If anything is unsupported, **stop drafting** and run the feature-request flow below.

## Feature request flow

1. Summarize the missing capability in one sentence and confirm the user agrees with the framing.
2. Build a minimal example workflow (paste-ready YAML or Markdown) that illustrates how the user would write it if the feature existed.
3. Ask the user explicitly: "Should I file this as a feature request at `pmatos/symphonika`?" — do not file without that confirmation.
4. On yes, run:
   ```sh
   gh issue create -R pmatos/symphonika \
     --title "<imperative title naming the missing capability>" \
     --label "needs-triage" \
     --body "$(cat <<'EOF'
   ## Use case
   <one paragraph>

   ## Example workflow that would work if this existed
   ```yaml
   <example>
   ```

   ## What current Symphonika supports
   <one paragraph naming the closest existing primitives>

   ## What is missing
   <bullet list of concrete additions>
   EOF
   )"
   ```
5. Print the issue URL `gh` returns. Do **not** stage, commit, or push anything else in response.

## Writing the artifact

After the design is fully resolved and supported:

1. **Reconcile the artifact path with `symphonika.yml`.** Read the target project's `symphonika.yml` and find the `projects[].workflow:` entry for the Project under work. Compare it against the artifact filename you chose (`WORKFLOW.md` vs. `workflow.yml`):
   - If the configured path already matches, keep it.
   - If it diverges, present both options to the user and proceed only after explicit approval: (a) write to the existing configured path (rename the rendered artifact to match), or (b) update `projects[].workflow:` in `symphonika.yml` to point at the new artifact. Symphonika loads exactly the configured path, so writing the new artifact under a different name without (a) or (b) produces a valid but inert workflow file that `symphonika doctor` will not even validate.
2. Show the user the final rendered `WORKFLOW.md` or `workflow.yml` (full content, in chat) and ask for explicit approval to write.
3. On approval, write to the path resolved in step 1. Use `Write` (overwrite) only if the user has confirmed they want to replace any existing file there. If step 1 chose option (b), also `Edit` `symphonika.yml` to update `projects[].workflow:` — a narrow `Edit` only, never a full rewrite.
4. Remind the user to run `symphonika doctor` to validate the workflow before dispatching.

`symphonika.yml` edits from this skill are limited to the `projects[].workflow:` reconciliation in step 1 (option b). Do not touch any other field — service-level runtime settings, providers, tracker config, and workspace roots are out of scope for a workflow-design skill.

## See also

- [REFERENCE.md](REFERENCE.md) — supported action kinds, predicates, templating, deferred features
- [EXAMPLES.md](EXAMPLES.md) — canned workflow shapes for common goals
