---
name: symphonika
description: Help with Symphonika, either by designing and writing a Workflow Contract (WORKFLOW.md or workflow.yml) by grilling the user one question at a time, or by explaining/editing a local Symphonika install — the `symphonika` CLI, its systemd --user service, and where `symphonika.yml`/state-root config live and how to change them safely. Use when the user mentions "symphonika", wants to wire up agent states, wait states, merge_pr states, predicates, or transitions; wants to run `symphonika init`/`doctor`/`daemon`/`service install`/`poll-now`; asks where Symphonika's config or state lives, how to change service or provider settings, or how to inspect/restart the `symphonika.service` unit. Detects unsupported workflow requirements and offers to file a feature request at pmatos/symphonika.
---

# Symphonika

This skill covers two different jobs — work out which one applies before doing anything else:

- **Design or edit a Workflow Contract** (`WORKFLOW.md` / `workflow.yml`) — the user wants to change how issues get implemented: states, providers, predicates, merge policy. Go to [Designing a Workflow Contract](#designing-a-workflow-contract).
- **Operate a local Symphonika install** — the user wants to know or change how their `symphonika` CLI and service are configured: where `symphonika.yml` lives, how to edit it safely, how the service picks up changes, troubleshooting. Go to [Operating a local install](#operating-a-local-install).

If the request could be either (e.g. "my workflow isn't dispatching"), start with
[Operating a local install](#operating-a-local-install) — most "it's not working" reports are
configuration or service problems, not workflow design problems.

## Designing a Workflow Contract

Interview the user one question at a time until you can confidently write a valid `WORKFLOW.md` or `workflow.yml` for their Symphonika Project, OR confirm the design needs a Symphonika feature that does not exist yet.

### Quick start

Two checkouts are in play: the **target project** (whose Workflow Contract you're writing) and the
**Symphonika checkout** (wherever `docs/workflows.md`, `SPEC.md`, `docs/adr/`, and `src/` live — the
thing that defines what's possible). They're usually different repos; confirm you can reach both.

1. Confirm the **target project** — ask the user for the absolute path to the repo whose Workflow Contract you will write. Verify a `symphonika.yml` exists there (or a parent) before continuing.
2. Confirm you have a **Symphonika checkout** to consult. Read [REFERENCE.md](REFERENCE.md) first; it's a thin pointer into that checkout's `docs/workflows.md`, which is the authoritative capability reference — read the relevant `docs/workflows.md` section directly whenever REFERENCE.md's summary isn't enough to answer a question confidently.
3. Run the grilling loop below until every branch is resolved.
4. Choose the artifact (`WORKFLOW.md` or `workflow.yml`), render it from one of the [EXAMPLES.md](EXAMPLES.md) shapes, and write it after the user approves the final draft.

### Grilling loop

Ask **one question at a time**. For each, propose your recommended answer and the reasoning. Walk down each branch of the decision tree, resolving dependencies before moving to the next branch.

Cover at minimum:

1. **Goal** — what should one Run of this workflow accomplish?
2. **Shape** — single-state (Markdown `WORKFLOW.md`) or multi-state (raw FSM `workflow.yml`)? Default to single-state unless the user names at least one of: review-feedback loop, conflict resolution, wait-then-merge, conditional branches.
3. **Providers** — Codex, Claude, or OMP per agent state? Per-state `action.provider` routing is fully supported at runtime; mix providers across states freely (see [REFERENCE.md](REFERENCE.md#providers)).
4. **States** — for each FSM node: kind (`agent` | `wait` | `merge_pr` | `comment` | `label_issue` | `close_issue`), prompt path (for `agent`), `complete_when` (see REFERENCE.md's State action kinds section — only needed when completion differs from the advance condition), transitions, terminal flag. Consider whether a `workflow.use` template (builtin or custom) already covers part of the shape instead of hand-authoring every state.
5. **Predicates** — which of the supported predicates (see REFERENCE, including `artifact_exists`) gate each transition? Reject predicates that do not exist. Walk through wait-state transition order explicitly — a plausible-looking order can leave a state parked forever (REFERENCE.md's Predicates section has the worked example).
6. **Prompt body** — what does the agent need to be told? What templating variables (`issue`, `project`, `workspace`, `branch`, `run`, `provider`) does it use? Confirm every `{{var}}` resolves; strict Mustache fails on unknown vars.
7. **Terminal states** — at least one `terminal: success` and (usually) one `terminal: blocked` or `terminal: failure`. Verify every non-terminal state has a transition that can fire.
8. **Side effects outside the workflow** — PR opening and `agent-ready` removal are still agent-only; comments/labels/issue-closing *can* be done by the orchestrator directly via `comment` / `label_issue` / `close_issue` states instead — ask whether the user wants that. See REFERENCE.md's State action kinds section for the boundary between them, including why a workflow's own `label_issue` shouldn't touch `agent-ready`/`sym:*`.

If a question can be answered by reading `SPEC.md`, `CONTEXT.md`, `docs/adr/`, or the project's existing `symphonika.yml` / current `WORKFLOW.md`, read instead of asking.

### Capability check (gate before writing)

Before drafting the artifact, run through [REFERENCE.md](REFERENCE.md#supported-vs-unsupported) and flag anything the user asked for that is **not** supported in current Symphonika. Common asks that are out of scope today:

- Action kinds beyond `agent`, `wait`, `merge_pr`, `comment`, `label_issue`, `close_issue`
- Predicates beyond the documented set (e.g. timer-based, body-text-based, label-based mid-walk)
- Webhook triggers instead of poll-based ticks
- Workspace auto-cleanup, cross-repo PRs, provider sandboxing
- Conditional logic inside prompts beyond strict Mustache variable substitution
- Multiple parallel agent runs per issue

If anything is unsupported, **stop drafting** and run the feature-request flow below.

### Feature request flow

1. Summarize the missing capability in one sentence and confirm the user agrees with the framing.
2. Build a minimal example workflow (paste-ready YAML or Markdown) that illustrates how the user would write it if the feature existed.
3. Check for an existing report before proposing to file a new one: `gh issue list -R pmatos/symphonika --search "<capability keywords>"`. If a matching open (or recently closed) issue exists, point the user at it instead of filing a duplicate. Before concluding nothing exists, double-check the gap is real against current `docs/workflows.md`/`src/` — the doc has drifted stale before.
4. Ask the user explicitly: "Should I file this as a feature request at `pmatos/symphonika`?" — do not file without that confirmation.
5. On yes, write the issue body to a scratch file first (avoids nested-fence escaping problems in a `gh issue create --body "$(cat <<'EOF' ... EOF)"` heredoc) and run:
   ```sh
   cat > /tmp/symphonika-feature-request.md <<'EOF'
   ## Use case
   <one paragraph>

   ## Example workflow that would work if this existed
   <fenced yaml example>

   ## What current Symphonika supports
   <one paragraph naming the closest existing primitives>

   ## What is missing
   <bullet list of concrete additions>
   EOF
   gh issue create -R pmatos/symphonika \
     --title "<imperative title naming the missing capability>" \
     --label "needs-triage" \
     --body-file /tmp/symphonika-feature-request.md
   ```
6. Print the issue URL `gh` returns. Do **not** stage, commit, or push anything else in response.

### Writing the artifact

After the design is fully resolved and supported:

1. **Reconcile the artifact path AND format with `symphonika.yml`.** Read the target project's `symphonika.yml` and find the `projects[].workflow:` entry for the Project under work. It's either a bare path (format inferred from extension) or a mapping `{ path, format: markdown | raw_fsm | auto }` where `format` overrides the extension. Compare both the path and (if present) the explicit `format:` against the artifact you chose (`WORKFLOW.md`/markdown vs. `workflow.yml`/raw FSM):
   - If the configured path matches AND any explicit `format:` agrees with the shape you're writing, keep it.
   - If either diverges — including an explicit `format:` that disagrees with the shape you chose, even when the path matches — present the options to the user and proceed only after explicit approval: (a) write to the existing configured path/format (rename or reshape the artifact to match), or (b) update `projects[].workflow:` in `symphonika.yml` to match the new artifact (path and/or `format:`). Getting only the path right while `format:` still names the other shape produces a file that parses under the wrong grammar — it won't be caught by a filename match, only by validation (step 5).
2. **Enumerate every file the workflow will need.** Start with the contract file itself. For an FSM workflow, also walk every `agent` state's `action.prompt:` and treat each distinct path as a file to write. For each referenced prompt path: check whether it already exists in the target project; if it does not, draft prompt content using [EXAMPLES.md](EXAMPLES.md) Example 4 as the template (specialized for that state's responsibility) and add it to the write list. Symphonika's raw-FSM validation fails with `workflow state ... prompt not found` when any referenced prompt file is missing, so the workflow file alone is not a usable artifact.
3. Show the user the **full write list**. Tag each path `NEW` or `REPLACES (existing N lines)`; for a `NEW` path show the rendered content, for a `REPLACES` path show a diff against the existing file, not just the new content — the user can't judge an overwrite from the new content alone. Ask for explicit approval to write the whole set. Approval must cover every file — partial approval is not permitted.
4. On approval, write every file in the list to its named path. Use `Write` (overwrite) only if the user has confirmed they want to replace any existing file there. If step 1 chose option (b), also `Edit` `symphonika.yml` to update `projects[].workflow:` — a narrow `Edit` only, never a full rewrite.
5. Have the user (or run yourself, if you have a shell in the target project) validate the result using the commands in REFERENCE.md's Validation and inspection section (`workflow validate`, `workflow explain` — including for reviewing a `workflow.use` expansion — and `doctor` as the broader check).

`symphonika.yml` edits from this skill are limited to the `projects[].workflow:` reconciliation in step 1 (option b). Do not touch any other field — service-level runtime settings, providers, tracker config, and workspace roots are out of scope for a workflow-design skill.

## Operating a local install

The user's `symphonika` CLI drives a local, long-running Symphonika service — a systemd `--user`
unit by default (`symphonika.service`), running `symphonika daemon` continuously. Read
[OPERATIONS.md](OPERATIONS.md) before making config edits or troubleshooting claims; do not guess a
flag, a path, or a systemd command from memory — this is the same "don't guess" posture the
[Feature request flow](#feature-request-flow) already takes toward workflow capabilities.

Quick orientation:

- `symphonika` is the CLI binary; `symphonika.service` is the systemd `--user` unit installed by
  `symphonika service install`.
- Service Config: `symphonika.yml`, normally `$XDG_CONFIG_HOME/symphonika/symphonika.yml`
  (`~/.config/symphonika/symphonika.yml`). A sibling `env` file holds secrets such as
  `SYMPHONIKA_SMTP_PASSWORD`; it is never baked into the unit.
- Runtime evidence (the SQLite run store, Run/Firing logs, workspaces) lives under the **state
  root**, normally `~/.local/state/symphonika` — a different directory from the config file.
- Most `symphonika.yml` and Workflow Contract edits hot-reload on the next daemon tick or
  `symphonika poll-now`; no restart needed. Unit-level changes (PATH capture, `EnvironmentFile=`,
  `OOMScoreAdjust=`) need `symphonika service install --force` followed by
  `systemctl --user restart symphonika.service`.
- Diagnose before editing: `symphonika doctor`, `symphonika status --watch`,
  `journalctl --user -u symphonika.service`.

See [OPERATIONS.md](OPERATIONS.md) for the full command/file reference and troubleshooting flow.

## See also

- `docs/workflows.md` in the Symphonika checkout — the canonical, complete authoring reference for Workflow Contracts (see Quick start).
- `docs/tutorial.md` and `SPEC.md` §13 ("CLI") in the Symphonika checkout — the canonical CLI and service-operation reference.
- [REFERENCE.md](REFERENCE.md) — skill-specific capability-gate summary for workflow design, sourced from `docs/workflows.md`.
- [EXAMPLES.md](EXAMPLES.md) — canned workflow shapes for common goals.
- [OPERATIONS.md](OPERATIONS.md) — skill-specific CLI/service/config summary, sourced from `docs/tutorial.md`, `SPEC.md`, and the ADRs it cites.
