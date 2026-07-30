# Tutorial: from first run to custom workflows and routines

This tutorial starts with an empty checkout and ends with two kinds of automation:

- **Issue Workflows** claim eligible GitHub issues and move them through an agent-authored or
  YAML-defined execution graph using Codex, Claude, or Oh My Pi.
- **Routines** run scheduled prompts for recurring reports or repository maintenance, without
  needing an eligible issue.

You will first run one issue through a simple Markdown Workflow Contract. Then you will graduate
through three levels of YAML workflow complexity and finally configure report and Git routines.

By the end you will have:

- a built `symphonika` CLI on your `PATH`;
- a user-level `symphonika.yml` Service Config;
- one registered Dispatch Project;
- a validated Workflow Contract;
- one completed issue Run with evidence you can inspect;
- a long-running daemon;
- enough YAML to design a multi-stage issue-to-merge workflow; and
- a clear path to scheduled Routines.

If you want to dogfood Symphonika against `pmatos/symphonika` itself, see
[docs/smoke.md](./smoke.md). For exhaustive workflow syntax, keep the
[workflow-language reference](./workflows.md) nearby. `SPEC.md` remains the implementation contract
for every behavior described here.

## Before you start: Workflows versus Routines

Both mechanisms launch autonomous agents, but their triggers and lifecycles differ:

| You want to… | Use |
| --- | --- |
| Implement an eligible GitHub issue | Markdown or YAML Workflow |
| Plan, implement, wait for checks, repair, and merge | YAML Workflow |
| Run a daily status report | Routine with `kind: report` |
| Run weekly repository maintenance and open a PR | Routine with `kind: git` |

A Workflow belongs to a Dispatch Project and starts from an issue selected by label filters. A
Routine is declared at service level, points at either a Dispatch Project or Routine Host, and
starts from a clock event. Routines are not YAML Workflow states.

# Part I: your first issue Run

## 1. Prerequisites

You need:

1. **Node.js 20 or newer.** Run `node --version`.
2. **A GitHub repository you own or administer.** A scratch repository with one or two issues is
   ideal.
3. **A GitHub token.** A classic token needs `repo`; a fine-grained token needs equivalent
   repository metadata, contents, issues, and pull-request access. Export it:

   ```sh
   export GITHUB_TOKEN=ghp_xxx...
   ```

4. **Local `git` and `gh`.** The agent uses `gh` for every GitHub mutation; if it
   is missing or unauthenticated, the workflow contract cannot post comments or
   open PRs. Run `gh auth status` and authenticate with `gh auth login` if needed.
5. **One agent provider installed and on `PATH`:**
   - **Codex** — install the `codex` CLI per its upstream instructions, then add
     a `symphonika` profile to `~/.codex/config.toml` (see §5 below). `which codex`
     should resolve.
   - **Claude** — install the `claude` CLI per its upstream instructions. `which claude`
     should resolve.
   - **Oh My Pi** — install OMP, commonly through Bun, and confirm `command -v omp`
     resolves. Bun installations commonly place it in `~/.bun/bin`.

You do not need all three; pick one and skip the other provider-specific setup.

## 2. Install Symphonika

Symphonika is not currently published to npm. Install it from source:

```sh
git clone https://github.com/pmatos/symphonika.git
cd symphonika
npm ci
npm run build
npm link
```

Verify the CLI:

```sh
symphonika --help
```

If you do not want to use `npm link`, run commands from the Symphonika checkout with either:

```sh
npm run dev -- <subcommand>
node dist/cli.js <subcommand>
```

The rest of this tutorial uses `symphonika`.

## 3. Initialize the service and register a Project

Create the user Service Config once:

```sh
symphonika init
```

Then enter the repository you want Symphonika to manage and register it:

```sh
cd ~/dev/my-app
symphonika init-project
```

`init` writes `$XDG_CONFIG_HOME/symphonika/symphonika.yml`, normally
`~/.config/symphonika/symphonika.yml`, with `projects: []`. It also chooses the state root, normally
`~/.local/state/symphonika`.

`init-project` reads the current repository's `origin`, prompts for Project settings, appends a
Dispatch Project, creates a starter Markdown `WORKFLOW.md` when the selected path is absent, and
creates missing `sym:*` Operational Labels plus required eligibility labels.

Pass `--yes` to accept displayed defaults. `init --force` replaces the global config;
`init-project --force` replaces only a Project with the same name.

## 4. Understand the generated Service Config

A single Dispatch Project has this shape:

```yaml
state:
  root: ~/.local/state/symphonika

polling:
  interval_ms: 30000

pull_requests:
  enabled: true
  review_followup:
    max_dispatches_per_pr: 3
  merge:
    enabled: false
    method: squash
    require_status_success: true
    require_review_decision: false

providers:
  codex:
    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"
  claude:
    command: "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json"
  omp:
    command: "omp --mode rpc --auto-approve"

projects:
  - name: my-app
    mode: dispatch
    disabled: false
    weight: 1
    tracker:
      kind: github
      owner: your-github-handle
      repo: your-repo-name
      token: "$GITHUB_TOKEN"
    issue_filters:
      states: ["open"]
      labels_all: ["agent-ready"]
      labels_none: ["blocked", "needs-human", "sym:stale"]
    priority:
      labels:
        "priority:critical": 0
        "priority:high": 1
        "priority:medium": 2
        "priority:low": 3
      default: 99
    workspace:
      root: ~/.local/state/symphonika/workspaces/my-app
      git:
        remote: https://github.com/your-github-handle/your-repo-name.git
        base_branch: main
    agent:
      provider: codex          # or: claude / omp
    workflow: /home/you/dev/my-app/WORKFLOW.md
```

The important boundaries are:

- `"$GITHUB_TOKEN"` is an environment reference, not a literal token. Tokens are not stored in the
  SQLite run store.
- `name: my-app` is the Symphonika Project name, not a GitHub Projects board. Commands such as
  `symphonika clear-stale my-app 42` use it.
- `labels_all` controls eligibility. An issue must have every listed label before dispatch.
- `labels_none` excludes issues. `sym:stale` prevents automatic re-claim after a stale Run.
- `sym:*` labels belong to the orchestrator. Workflow labels such as `agent-ready` belong to the
  repository.
- `workspace.git.remote` is cloned into the Project workspace root. HTTPS and SSH are both
  supported; pushes use the credentials implied by the URL.
- `agent.provider` selects Codex, Claude, or OMP as the Project default. YAML agent states can
  override it, and the `providers:` block defines each command.
- `workflow` points to Markdown or raw-FSM YAML. Generated paths are absolute; hand-authored
  relative paths resolve from the Service Config.
- `pull_requests.merge.enabled: false` is a safe starting point. Leave automatic merging off until
  you trust the Workflow; a `merge_pr` state also respects this gate.

Add other repositories by running `symphonika init-project` from each checkout. Dispatch uses
weighted round-robin across Projects.

## 5. Complete provider-specific setup

### Codex profile

The default Codex provider command passes `-p symphonika`, which selects a named
profile. Add this block to `~/.codex/config.toml`:

```toml
[profiles.symphonika]
analytics = { enabled = false }
sandbox_mode = "danger-full-access"
approval_policy = "never"

[profiles.symphonika.features]
memories         = false
multi_agent      = true
codex_hooks      = false
image_generation = false
```

This keeps headless runs from inheriting interactive-only behavior. See
[ADR-0042](./adr/0042-codex-profile-for-headless-runs.md).

Claude and OMP users do not need this Codex profile.

### Oh My Pi RPC and service `PATH`

The generated OMP command is:

```text
omp --mode rpc --auto-approve
```

`--mode rpc` selects the newline-delimited JSON host protocol. `--auto-approve` is required for an
unattended full-permission run; without it, an approval request would become `input_required` and
fail the attempt.

Verify OMP in the same login environment you will use to launch Symphonika:

```sh
command -v omp
omp --version
symphonika doctor
```

If Bun installed OMP under `~/.bun/bin`, ensure that directory is on `PATH`. This matters especially
for `systemd --user`, which does not inherit additions made only inside an interactive terminal.
Install or refresh the service from a login shell where `command -v omp` succeeds:

```sh
exec zsh -l
command -v omp
symphonika service install --force
```

The generated service captures that shell's `PATH`. Keep the portable `omp` command in
`symphonika.yml`; do not replace it with a user-specific absolute path.

## 6. Start with a Markdown Workflow Contract

The generated `WORKFLOW.md` is the prompt sent to the agent. Symphonika fills strict
Mustache-style variables such as `{{issue.number}}`, `{{issue.title}}`, `{{branch.name}}`, and
`{{workspace.path}}`.

A useful first contract is:

````markdown
# Implement issue #{{issue.number}}: {{issue.title}}

## Issue

- URL: {{issue.url}}
- Labels: {{issue.labels}}

{{issue.body}}

## Workspace

Work in {{workspace.path}} on branch {{branch.name}}.

## What to do

1. Read the issue and repository instructions.
2. Implement a focused change with tests.
3. Run the repository's lint, typecheck, test, and build commands.
4. Commit and push {{branch.name}}.
5. Open a non-draft PR with `gh pr create`.
6. Remove `agent-ready` with:

   ```sh
   gh issue edit {{issue.number}} --remove-label agent-ready
   ```

7. If blocked, leave an explanatory `gh issue comment` and exit cleanly.
````

Symphonika prepends the autonomy contract automatically. Your prompt should still describe
repository-specific commands, expected outputs, and the desired PR shape.

Validate the selected Project:

```sh
symphonika workflow validate
```

For Markdown, the command shows the two-state compatibility graph: one agent state followed by a
success terminal. See [Markdown Workflow Contracts](./workflows.md#2-markdown-workflow-contracts)
for front matter and every prompt variable.

## 7. Run the full preflight

`doctor` validates configuration, GitHub access, labels, provider commands, Workflow Contracts,
state storage, workspaces, and Routine declarations:

```sh
symphonika doctor
```

It dispatches nothing. Fix every error before continuing.

Common first-run errors:

- **GitHub auth failed:** `GITHUB_TOKEN` is unset, expired, or lacks scopes.
- **Workflow file not found:** check the Project's `workflow` path. Generated paths are absolute;
  hand-authored relative paths resolve from the directory containing `symphonika.yml`.
- **Provider command not on PATH:** check the selected `codex`, `claude`, or `omp` command with
  `command -v <name>`. For a Bun-installed OMP, confirm `~/.bun/bin` is on the launching shell's
  `PATH`.
- **Codex profile missing:** add the profile from the previous section.
- **Required label missing:** rerun `init-project` or create the configured eligibility label.

## 8. Make one issue eligible

Choose a small, self-contained open issue and apply `agent-ready`. Symphonika does not own that
label; it is simply the eligibility gate configured above.

With multiple eligible issues, lower `priority` numbers run first. Ties break by creation time and
then issue number.

## 9. Run one cycle with `smoke`

`smoke` performs one orchestration cycle and exits:

```sh
symphonika smoke
```

You should see:

1. the doctor preflight;
2. a GitHub poll;
3. `sym:claimed` and then `sym:running`;
4. a workspace under
   `~/.local/state/symphonika/workspaces/my-app/issues/<number>-<slug>/`;
5. provider output; and
6. a Run summary with its id, state, branch, workspace, and log paths.

Exit code `0` means success or no eligible issue. Exit code `1` means doctor failure, provider
failure, or `input_required`.

Do not run `smoke` while the daemon is running. They claim work independently.

## 10. Inspect the evidence

Run evidence lives outside agent workspaces:

```text
~/.local/state/symphonika/
  symphonika.db
  logs/
    runs/
      <run-id>/
        provider.raw.jsonl
        provider.normalized.jsonl
        stderr.log
        prompt.md
        prompt-metadata.json
        issue-snapshot.json
        workflow-graph.json
```

Inspect recent Runs:

```sh
symphonika runs --limit 20
symphonika show-run <run-id>
```

`prompt.md` is the exact prompt seen by the provider. `workflow-graph.json` is the expanded graph
captured for the attempt. The code changes remain in the Project workspace on a branch such as
`sym/my-app/42-fix-widget`.

A succeeded Run means the provider exited successfully and the branch has commits ahead of the
configured base. It does not by itself mean the agent pushed or opened a PR; those actions belong
in the prompt.

## 11. Start the daemon

After the first `smoke` Run:

```sh
symphonika daemon
```

The daemon polls, claims eligible issues, dispatches providers, reconciles state, fires Routines,
and follows PRs associated with issue branches. It also serves a local dashboard on
`127.0.0.1:3000`.

In another terminal:

```sh
symphonika status --watch
```

Force an immediate reload, reconcile, and poll:

```sh
symphonika poll-now
```

Useful operational commands:

```sh
PINO_LOG_LEVEL=debug symphonika daemon
symphonika cancel <run-id>
symphonika clear-stale my-app 42 --yes
```

# Part II: graduate to YAML Workflows

Markdown is ideal when one autonomous agent can own the entire issue. Raw-FSM YAML is useful when
the orchestrator—not one prompt—should own phases, provider routing, waits, repair loops, or merge
policy.

The examples below introduce one capability at a time. The
[workflow-language reference](./workflows.md) documents every field and constraint.

## 12. Select raw-FSM YAML

Create `workflow.yml` beside the existing `WORKFLOW.md`, then point the Project at it:

```yaml
projects:
  - name: my-app
    # ...the rest of the Project...
    workflow:
      path: /home/you/dev/my-app/workflow.yml
      format: raw_fsm
```

With `format: auto`, the `.yml` extension also selects raw FSM. The explicit mapping makes the
choice obvious to readers.

`init-project` scaffolds Markdown only. Create the YAML file yourself, keep prompt files beside it,
and validate before making another issue eligible.

## 13. Level 1: one explicit agent state

This is the YAML equivalent of the Markdown compatibility graph:

```yaml
workflow:
  name: implement_only
  initial: implement

  states:
    implement:
      action:
        kind: agent
        prompt: WORKFLOW.md
      transitions:
        - to: done
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: blocked

    done:
      terminal: success

    blocked:
      terminal: blocked
```

What this adds:

- `initial` names the entry state.
- `action.kind: agent` launches a provider.
- Omitting `provider` uses the Project default.
- `prompt` is relative to `workflow.yml`.
- Fields inside `when` are combined with logical `and`.
- Transitions are checked in order, so the unconditional blocked fallback comes last.
- Terminals make the outcome paths visible in graph evidence.

Validate and inspect it:

```sh
symphonika workflow validate --project my-app
symphonika workflow explain --project my-app
```

## 14. Level 2: plan with Claude, implement with Codex

Create two focused prompt files:

```text
prompts/
  plan.md
  implement.md
```

`prompts/plan.md` should tell the planner to inspect the issue and repository, then write a plan into
the workspace. `prompts/implement.md` should tell the implementer to follow that plan, test,
commit, push, and open the PR.

Then use separate agent states:

```yaml
workflow:
  name: plan_then_implement
  initial: planning

  states:
    planning:
      action:
        kind: agent
        provider: claude
        prompt: prompts/plan.md
      transitions:
        - to: implementing
          when:
            provider_success: true
        - to: blocked

    implementing:
      action:
        kind: agent
        provider: codex
        prompt: prompts/implement.md
      transitions:
        - to: done
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: blocked

    done:
      terminal: success

    blocked:
      terminal: blocked
```

The planning state does not require a commit: `provider_success: true` is enough to advance. The
implementation state requires commits ahead of base. `action.provider` overrides the Project
default for that state and is honored on both initial and later states.

Raw-FSM state advances remain part of one in-flight graph even if the agent removes
`agent-ready`. Mid-walk label drift does not cancel them; issue closure and operator cancellation
still do.

## 15. Level 3: wait, repair, and merge

Before copying this workflow, add the repair prompt used by its `repair` state:

```text
prompts/
  repair.md
```

Tell the repair agent to inspect failing checks and review feedback, update the existing branch and
PR, run the Project's checks, commit, and push the fixes. After the implementation agent opens a PR,
the Workflow can park until GitHub state changes:

```yaml
workflow:
  name: implement_review_merge
  initial: implement

  states:
    implement:
      action:
        kind: agent
        provider: codex
        prompt: prompts/implement.md
      transitions:
        - to: wait_for_pr
          when:
            provider_success: true
            branch_ahead_of_base: true
        - to: blocked

    wait_for_pr:
      action:
        kind: wait
      transitions:
        - to: merged
          when:
            pr_merged: true
        - to: blocked
          when:
            pr_open: false
        - to: merge
          when:
            checks: success
            mergeable: true
            unresolved_review_threads: 0
        - to: repair
          when:
            checks: failure
        - to: repair
          when:
            has_unresolved_reviews: true

    repair:
      action:
        kind: agent
        provider: claude
        prompt: prompts/repair.md
      transitions:
        - to: wait_for_pr
          when:
            provider_success: true
        - to: blocked

    merge:
      action:
        kind: merge_pr
        method: squash
      transitions:
        - to: merged
          when:
            pr_merged: true
        - to: blocked
          when:
            pr_open: false
        - to: repair
          when:
            checks: failure
        - to: repair
          when:
            mergeable: false

    merged:
      terminal: success

    blocked:
      terminal: blocked
```

The `wait` state launches no provider. Every daemon tick refreshes the tracked PR and projects
signals for checks, mergeability, review decision, unresolved threads, open state, and merged
state. If no transition matches—for example, checks are pending—the Run stays parked.

After the repair prompt exits, the graph returns to the wait state.

`merge_pr` also parks. It merges only a PR associated with the Symphonika issue branch and only
when the service-level merge policy allows it. For this example, change:

```yaml
pull_requests:
  merge:
    enabled: true
```

The state-level `method` overrides only the method; status and review gates still come from the
Service Config.

The exact PR signal values and missing-signal behavior are documented under
[Predicates and signal availability](./workflows.md#6-predicates-and-signal-availability).

## 16. Compose built-in templates

When the graph shape is familiar, built-ins remove repeated state declarations:

```yaml
workflow:
  name: plan_fix_merge
  initial: build

  use:
    build:
      template: builtin:plan-tdd-pr
      with:
        planner: claude
        implementer: codex
      exits:
        success: fix
        blocked: blocked

    fix:
      template: builtin:autofix-until-clean
      exits:
        success: merge
        blocked: blocked

    merge:
      template: builtin:merge-when-green
      with:
        method: squash
      exits:
        success: done
        blocked: blocked

  states:
    done:
      terminal: success
    blocked:
      terminal: blocked
```

The four built-ins are:

- `builtin:single-agent-pr`
- `builtin:plan-tdd-pr`
- `builtin:autofix-until-clean`
- `builtin:merge-when-green`

The example uses the built-ins' default prompt paths:

```text
WORKFLOW.md
prompts/plan.md
prompts/impl.md
prompts/autofix.md
```

Override those paths under `with` or create the files before validation.

For repository-specific reusable fragments, create a YAML template under
`.symphonika/workflow-templates/` and reference it by relative path. Templates support typed scalar
inputs, one entry, internal states, and named exits. The full template language and every built-in
contract are in [Reusable templates](./workflows.md#8-reusable-templates).

## 17. Iterate safely

Use this loop before making an issue eligible:

```sh
symphonika workflow validate --project my-app
symphonika workflow explain --project my-app
symphonika doctor
symphonika poll-now
```

`validate` and `explain` expand templates without dispatching. The daemon reloads valid edits on its
next tick; `poll-now` requests that tick immediately. In-flight attempts retain the prompt and graph
hash captured when they began.

For an actual Run:

```sh
symphonika show-run <run-id>
```

Inspect its transition history, rendered prompt, and `workflow-graph.json`.

Useful authoring rules:

- Put specific transitions before catch-alls.
- Use only signals produced by that action type.
- Give wait loops closed-PR and failure escape paths.
- Keep each agent prompt focused on one state's responsibility.
- Tell repair agents to update the existing PR.
- Validate every referenced prompt and template before dispatch.
- Treat parser-recognized but runtime-incomplete actions as reserved; see
  [Supported, reserved, and unsupported](./workflows.md#12-supported-reserved-and-unsupported).

# Part III: scheduled work with Routines

## 18. What a Routine does

A Routine is a service-level scheduled prompt declaration. It points at a Project for:

- a Git repository and base branch;
- a workspace root; and
- a default provider.

Routine kinds differ:

| Kind | Workspace | Success rule | Typical use |
| --- | --- | --- | --- |
| `report` | Detached at the base branch | Provider exits successfully; no commit required | Status summaries, audits, analysis |
| `git` | Dedicated deterministic branch | Provider exits successfully and commits are ahead of base | Dependency updates, cleanup, generated files |

A Routine may target an existing Dispatch Project. Use a **Routine Host** when a repository should
run scheduled work but never poll issues.

## 19. Add a recurring report Routine

From a repository already registered as a Project:

```sh
cd ~/dev/my-app
symphonika add-routine daily-status \
  --project my-app \
  --schedule daily \
  --tz Europe/Berlin \
  --kind report \
  --provider claude
```

The command:

- creates `routines/daily-status.md`;
- validates its front matter;
- registers it in the top-level `routines:` block of `symphonika.yml`; and
- does not contact GitHub or reload the daemon itself.

The Service Config entry is:

```yaml
routines:
  - project: my-app
    path: /home/you/dev/my-app/routines/daily-status.md
```

With the default user config, the Routine file is outside the config directory, so `add-routine`
registers an absolute path. It uses a `./`-prefixed relative path when the file is inside the
Service Config directory.

Edit the generated Routine file:

```markdown
---
name: daily-status
schedule:
  cron: daily
  tz: Europe/Berlin
kind: report
provider: claude
catch_up: fire_once_if_missed
---

# Daily repository status for {{project.name}}

Inspect the repository in {{workspace.path}} and produce a concise status report.

Include:

1. recent commits and open work visible locally;
2. failing or suspicious repository checks you can run safely;
3. maintenance risks worth addressing; and
4. concrete next actions.

Write the report to `DAILY_STATUS.md`.
This is firing {{firing.id}} for Routine {{routine.name}}.
```

`daily` is a supported cron alias. `catch_up: fire_once_if_missed` fires at most once after a daemon
outage, even if several daily clock events were missed. Without it, missed clock events are skipped.

Run the full validation and trigger a reload:

```sh
symphonika doctor
symphonika poll-now
```

The daemon—not `add-routine`—evaluates the schedule.

## 20. Use a dedicated Routine Host

Suppose a repository should receive scheduled maintenance but should not expose issues to
Symphonika. Register it from its checkout:

```sh
cd ~/dev/maintenance-target
symphonika init-project --mode routine-host
```

A Routine Host has no issue filters, priority map, or Workflow Contract:

```yaml
projects:
  - name: maintenance-target
    mode: routine_host
    tracker:
      kind: github
      owner: your-github-handle
      repo: maintenance-target
      token: "$GITHUB_TOKEN"
    workspace:
      root: ~/.local/state/symphonika/workspaces/maintenance-target
      git:
        remote: https://github.com/your-github-handle/maintenance-target.git
        base_branch: main
    agent:
      provider: codex
```

The `tracker` is optional for report-only hosting. It is required when any `kind: git` Routine
targets the host, because Symphonika performs post-run PR discovery.

## 21. Add a Git maintenance Routine

From the target checkout:

```sh
symphonika add-routine weekly-maintenance \
  --project maintenance-target \
  --schedule "0 7 * * 1" \
  --tz Europe/Berlin \
  --kind git \
  --provider codex
```

Edit `routines/weekly-maintenance.md`:

```markdown
---
name: weekly-maintenance
schedule:
  cron: "0 7 * * 1"
  tz: Europe/Berlin
kind: git
provider: codex
allow_overlap: false
---

# Weekly maintenance for {{project.name}}

Work in {{workspace.path}} on {{branch.name}}.

1. Inspect dependency and toolchain health.
2. Apply only low-risk maintenance updates.
3. Run the repository's complete quality gate.
4. Commit and push {{branch.name}}.
5. If changes were made, open a non-draft PR with `gh pr create`.
6. If no safe change is needed, document the evidence in the workspace and exit cleanly. The
   firing may be recorded as `no_workspace_changes`; do not create a meaningless commit merely to
   satisfy the Git success rule.

This is Routine {{routine.name}}, firing {{firing.id}}.
```

Each Git firing gets its own workspace:

```text
<workspace.root>/routines/weekly-maintenance/<firing-id>/
```

and a branch shaped like:

```text
sym/maintenance-target/routine/weekly-maintenance/<firing-prefix>
```

Git Routine success requires at least one commit ahead of the base branch. Symphonika discovers
open PRs from the firing branch and records them for status, but Routine PRs do not enter issue PR
follow-up or auto-merge.

## 22. Scheduling and overlap controls

A Routine declaration must have exactly one schedule:

```yaml
schedule:
  at: 2026-08-01T09:00:00+02:00
```

or:

```yaml
schedule:
  cron: "15 9 * * 1-5"
  tz: Europe/Berlin
```

Recurring schedules use five-field POSIX cron. Supported aliases are `hourly`, `daily`, `weekly`,
`monthly`, and `yearly`, with or without `@`. The default timezone is `Etc/UTC`.

Optional controls:

```yaml
catch_up: fire_once_if_missed
allow_overlap: true
disabled: true
```

- Omitted `catch_up` means missed events during daemon outage are skipped.
- Omitted `allow_overlap` is `false`; a clock event is skipped if the previous firing is still
  active.
- Overlap opt-in does not bypass global or per-Project concurrency caps.
- `disabled: true` stops future scheduling after reload without cancelling an active firing.

Skipped clock events create no firing row, but Routine status records the attempt, reason, time, and
rolling 24-hour counts.

## 23. Routine prompt variables

All Routine prompts can use:

| Object | Fields |
| --- | --- |
| `project` | `name` |
| `workspace` | `path`, `root` |
| `provider` | `name`, `command` |
| `routine` | `name`, `kind`, `schedule_at`, `schedule_cron`, `schedule_tz`, `source_path` |
| `firing` | `id` |

Git Routines additionally expose `branch.name` and `branch.ref`. Report Routines do not. Issue and
Run variables are unavailable to both kinds because no issue triggered the firing.

Routine interpolation is strict: an unavailable or empty value fails the firing with
`prompt_render_error`.

## 24. Inspect and control Routines

After the daemon has loaded the declarations:

```sh
symphonika routines
symphonika routines --project maintenance-target
symphonika routines --include-inactive
```

The listing includes state, next fire time, last firing and attempt, skip evidence, and discovered
PR numbers. Routine states include `active`, `expired`, `disabled`, `inactive`, and `invalid`. The
dashboard and `GET /api/routines/:id/firings?project=<name>` expose firing history. Firing evidence
is stored under `<state.root>/logs/routines/<firing-id>/`.

Cancel an active Routine Firing with the same command used for issue Runs:

```sh
symphonika cancel <firing-id>
```

Cancellation kills an active provider but preserves its workspace and logs.

# Part IV: operating and extending the setup

## 25. Switch providers or run several

`agent.provider` is per Project. A raw-FSM `action.provider` and Routine `provider` can override it
for one state or declaration.

To compare OMP, Claude, and Codex on issue work, create separate Projects with distinct names,
workspace roots, and eligibility labels such as `agent-ready-omp`. All Projects dispatch from the
same daemon. Do not point two Projects with the same eligibility rule at the same issue set unless
you intend them to race.

If you switch an existing Project to another provider, finish its in-flight Runs first. The
workspace is reusable, but mid-flight provider events come from whichever provider started the
attempt.

Routines use the Project provider by default and may override it in front matter:

```yaml
---
name: dependency-audit
kind: report
provider: omp
schedule:
  cron: "@weekly"
---
```

OMP support and its native RPC lifecycle are recorded in
[ADR-0066](./adr/0066-oh-my-pi-provider.md).

## 26. Troubleshooting

### `doctor` cannot find an initialized config

Run `symphonika init`, then register at least one Project with `init-project`.

### No eligible issue

Confirm the issue is open, has every `labels_all` label, and has no `labels_none` label. Check
`symphonika status`.

### `input_required`

The provider attempted an approval-dependent action. Tell it to use local `gh` commands and avoid
GitHub connector tools. The autonomy preamble already establishes this rule; repository-specific
prompts should not contradict it.

### Run succeeded but no PR appeared

Provider success plus commits ahead of base satisfies the orchestrator. Push and PR creation remain
prompt-owned. Inspect `prompt.md`, the workspace, and provider logs.

### YAML Workflow validates but cannot advance

Run `workflow explain` and check:

- predicates are available for that action type;
- strict values match the reference;
- specific transitions come before catch-alls;
- wait states have a Symphonika-tracked PR; and
- `merge_pr` is enabled by service policy.

Parser acceptance alone does not make reserved actions or predicates operational.

### Missing prompt file

Every raw-FSM `agent` state needs an existing prompt path relative to the main YAML file. Built-in
defaults also need their corresponding files.

### Routine never fires

Run `doctor`, `poll-now`, and `routines`. Check the Routine state, next fire time, timezone,
`disabled`, target Project state, catch-up policy, overlap skips, and concurrency-cap skips.

### Git Routine fails with `no_workspace_changes`

`kind: git` requires commits ahead of the base branch. Use `kind: report` for read-only analysis, or
change the prompt so a successful Git firing commits its intended output.

### Workspace conflicts on retry

Retries reuse issue workspaces. Symphonika does not reset dirty worktrees automatically. Resolve the
workspace manually or remove the specific issue workspace and let the next attempt rebuild it.

### Daemon HTTP port is busy

Start it with `--port <n>` and pass
`--daemon-url http://127.0.0.1:<n>` to `status`, `poll-now`, and `cancel`.

## 27. Where to go next

- Read the [complete Workflow language](./workflows.md).
- Study the repository's production [`workflow.yml`](../workflow.yml) and prompts.
- Inspect [SPEC.md §5](../SPEC.md#5-config-files) for configuration contracts.
- Review [ADR-0049](./adr/0049-builtin-workflow-templates.md) for built-in template decisions.
- Review [ADR-0058](./adr/0058-routine-catch-up-overlap-and-skip-accounting.md),
  [ADR-0060](./adr/0060-routine-lifecycle-control.md),
  [ADR-0062](./adr/0062-routine-hosts.md), and
  [ADR-0063](./adr/0063-service-level-routine-declarations.md) for Routine behavior.
