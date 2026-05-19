# Tutorial: running Symphonika against your own GitHub repo

This tutorial walks you from an empty checkout to a working setup where Symphonika
claims an `agent-ready` issue from a GitHub repository you own, runs a coding agent
(Codex or Claude) against it, and records the result. By the end you will have:

- a built `symphonika` CLI on your `PATH`
- a user-level `symphonika.yml` service config pointed at one of your repositories
- a repository-owned `WORKFLOW.md` workflow contract that the agent will execute
- the four `sym:*` operational labels created on the target repository
- one completed run (via `smoke`) with logs you can inspect
- a long-running `daemon` you can stop and start at will

If you instead want to dogfood Symphonika against the `pmatos/symphonika` repository
itself, see [docs/smoke.md](./smoke.md); the underlying mechanics are the same, but
this tutorial assumes you are pointing at *your* repo, not this one.

The terminology in this tutorial follows [CONTEXT.md](../CONTEXT.md). The implementation
contract behind every behaviour described here is [SPEC.md](../SPEC.md); when something
surprises you, that is the source of truth.

---

## 1. Prerequisites

You need:

1. **Node.js 20 or newer.** Run `node --version` to check.
2. **A GitHub repository you own** (or have admin access to). The repository must
   exist on GitHub; Symphonika does not create repositories. A scratch repo with
   one or two open issues is ideal for a first run.
3. **A GitHub personal access token** with at least `repo` scope (classic) or
   the fine-grained equivalent: `Issues: read & write`, `Pull requests: read & write`,
   `Contents: read & write`, `Metadata: read`. Export it as `GITHUB_TOKEN`:
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

You do not need both; pick one and skip the other's side of the side-by-side
snippets. v1 supports either.

---

## 2. Install Symphonika

Symphonika is not currently published to npm. Install from source:

```sh
git clone https://github.com/pmatos/symphonika.git
cd symphonika
npm ci
npm run build
npm link    # makes the `symphonika` bin available on your PATH
```

Verify the install:

```sh
symphonika --help
```

You should see the top-level command list (`init`, `doctor`, `init-project`,
`daemon`, `smoke`, `status`, `poll-now`, `runs`, `show-run`, `cancel`,
`clear-stale`, `workflow validate`, `workflow explain`).

If you would rather not `npm link`, the equivalents are:

```sh
npm run dev -- <subcommand>          # runs src/cli.ts via tsx
node dist/cli.js <subcommand>        # uses the build output directly
```

The rest of this tutorial uses `symphonika <subcommand>` for brevity.

---

## 3. Initialize Symphonika from your project

Go to the repository you want Symphonika to manage and run `init` there. You do
not need a separate deployment directory.

```sh
cd ~/dev/s11
symphonika init --provider codex     # or: --provider claude
```

`init` reads the GitHub `origin` remote, creates the user service config at
`$XDG_CONFIG_HOME/symphonika/symphonika.yml` (usually
`~/.config/symphonika/symphonika.yml`), stores local runtime state under
`$XDG_STATE_HOME/symphonika` (usually `~/.local/state/symphonika`), and creates
`WORKFLOW.md` in the project only if that file is absent. It does not touch
GitHub; label creation still happens later via `init-project --yes`.

If you already have a user config, `init` refuses to overwrite it unless you pass
`--force`. For hand-authored setups, every command still accepts `--config
<path>`.

---

## 4. Review your `symphonika.yml`

Open the generated user config. The minimum viable shape for one Project against
one GitHub repo looks like this:

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
    enabled: false           # start with auto-merge off until you trust the loop
    method: squash
    require_status_success: true
    require_review_decision: false

providers:
  codex:
    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"
  claude:
    command: "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json"

projects:
  - name: my-app
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
      provider: codex          # or: claude
    workflow: /home/you/dev/my-app/WORKFLOW.md
```

A few things worth knowing as you edit this file:

- **Token is a reference, not a literal.** `"$GITHUB_TOKEN"` tells Symphonika to
  read the named environment variable at runtime. Literal tokens should never
  go in YAML and are never stored in the SQLite run store.
- **`name: my-app` is the Symphonika Project name**, not a GitHub Projects board.
  You use it as the argument to commands like `symphonika clear-stale my-app 42`.
- **`labels_all: ["agent-ready"]`** is the eligibility gate. An issue must carry
  every label in this list to be picked up. You can rename it, but keep something
  explicit — Symphonika is intentionally opt-in per issue.
- **`labels_none`** excludes issues. The `sym:stale` entry is what stops a
  previously-failed run from being re-claimed automatically.
- **`workspace.git.remote`** is what gets cloned into the workspace. HTTPS works
  on any machine; SSH works if you have keys configured. If you push, the agent
  uses whichever credential the URL implies.
- **`workflow` is an absolute path by default** when generated by `init`, because
  the service config lives outside the project. You can make it relative to the
  config directory if you hand-edit the layout.
- **`agent.provider`** picks Codex or Claude per Project. The `providers:` block
  defines the command for each.
- **`pull_requests.merge.enabled: false`** is a deliberate starting point. Leave
  auto-merge off until you have watched a few runs end-to-end; flip it on once
  you trust the workflow.

If you want to track multiple repositories from the same daemon, add more entries
to `projects:`. Dispatch is weighted round-robin across them.

---

## 5. Set up the Codex profile (Codex users only)

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

This stops headless runs from inheriting interactive Codex defaults (memory
consolidation, hooks, etc). The rationale is in
[ADR-0042](./adr/0042-codex-profile-for-headless-runs.md).

If you are running Claude, skip this section.

---

## 6. Review your `WORKFLOW.md`

`symphonika init` creates a starter `WORKFLOW.md` if your project does not
already have one. The workflow contract is the prompt the agent receives, with
placeholders that Symphonika fills in at dispatch time. Available placeholders
are listed in [SPEC.md §5.3](../SPEC.md#53-templating); the most useful are
`{{issue.number}}`, `{{issue.title}}`, `{{issue.body}}`, `{{branch.name}}`, and
`{{workspace.path}}`.

A minimal `WORKFLOW.md` for a TypeScript-ish repo looks like this:

```markdown
# Implementing issue #{{issue.number}}: {{issue.title}}

## Issue
- Number: #{{issue.number}}
- URL: {{issue.url}}
- Labels: {{issue.labels}}

### Body

{{issue.body}}

## Workspace

Your current working directory is {{workspace.path}}.
You are on branch {{branch.name}}. Stay on this branch for every commit.

## What to do

1. Read the issue carefully and locate the code paths it references.
2. Implement the change as a small, focused diff. Add or update tests under
   `tests/` so the new behaviour is covered.
3. Run the local quality gate before pushing:
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
4. Commit with a focused message and push {{branch.name}} to `origin`.
5. Open a non-draft PR against `main`:

   ```sh
   gh pr create --base main --head {{branch.name}} \
     --title "<conventional title>" \
     --body "<summary>\n\nCloses #{{issue.number}}"
   ```
6. Remove the `agent-ready` label so the orchestrator does not schedule a
   redundant continuation:
   ```sh
   gh issue edit {{issue.number}} --remove-label agent-ready
   ```
7. If you cannot proceed at all, leave a `gh issue comment` describing what
   blocked you and exit cleanly. Do **not** apply `needs-human` yourself.

## Constraints

- You are running unattended. No operator will respond to prompts mid-run.
- Use the local `gh` CLI for every GitHub mutation. Do not call GitHub MCP
  connector tools (`add_issue_labels`, `create_pull_request`, etc.) — they
  elicit operator approval, which fails the run.
- Do not create or edit labels in the `sym:*` namespace; those are owned by
  the orchestrator.
```

Symphonika prepends a standard autonomy preamble (see SPEC.md §5.3) before
your text, so you do not need to re-state that the agent is autonomous. The
preamble already covers MCP-tool avoidance and the no-self-handoff rule.

Validate that your YAML config and Markdown workflow at least parse:

```sh
symphonika workflow validate
```

This prints the expanded workflow graph and rejects unknown template variables.

---

## 7. Run `doctor`

`doctor` is the dry-run validator: config parse, GitHub auth, repository access,
operational-label presence, provider command resolution, workflow parse,
database path, workspace root. It dispatches no work.

```sh
symphonika doctor
```

The first time you run this against a fresh repository, `doctor` will exit
non-zero and report the four `sym:*` operational labels as missing — for
example:

```
doctor failed:
- projects.my-app.tracker.repository your-handle/your-repo is missing operational labels: sym:claimed, sym:running, sym:failed, sym:stale
```

That specific error is expected and is exactly what step 8 (`init-project --yes`)
resolves; re-run `doctor` after step 8 and it should print `doctor ok`. Any
*other* error — a bad token, an unreadable workflow file, a missing provider
binary — is a real problem and must be fixed before continuing, because smoke
and daemon refuse to start when `doctor` is unhappy.

Common first-run errors and what they mean:

- *"GitHub auth failed"* — `GITHUB_TOKEN` is unset, expired, or lacks scopes.
- *"workflow file not found"* — check the `workflow:` path in the user service
  config. `init` writes an absolute path; hand-authored relative paths resolve
  from the directory containing `symphonika.yml`.
- *"provider command not on PATH"* — the `codex` or `claude` binary cannot be
  resolved. Check `which codex` / `which claude`.
- *"Codex profile `symphonika` missing"* — you skipped §5. Paste the TOML snippet.

---

## 8. Create the operational labels

Symphonika owns four GitHub labels (`sym:claimed`, `sym:running`, `sym:failed`,
`sym:stale`) and refuses to create them silently. Run `init-project` once per
target repository:

```sh
symphonika init-project --yes
```

The `--yes` flag is the explicit confirmation. Without it the command runs in
preview mode and prints what *would* be created without touching GitHub. After
this completes, `doctor` should report a clean bill of health.

---

## 9. Pick a test issue

In the target repository, find or create one open issue with a clear, small,
self-contained task. Apply the `agent-ready` label to it. (Symphonika does not
own `agent-ready`; it is just an eligibility filter you chose in §4.)

If you want priority routing, also apply one of the `priority:*` labels you
configured. With multiple eligible issues, lower-numbered priorities run first;
ties break by oldest creation time, then issue number.

---

## 10. First run with `smoke`

`smoke` runs exactly one orchestration cycle and exits — no polling loop, no
retries, no continuation. It is the right shape for a first end-to-end test.

```sh
symphonika smoke
```

You should see, in order:

1. A doctor preflight (`doctor ok` or a list of errors).
2. A single GitHub poll listing the eligible issue.
3. A claim event: `sym:claimed` then `sym:running` applied to the issue.
4. A workspace being prepared under
   `~/.local/state/symphonika/workspaces/my-app/issues/<n>-<slug>/`.
5. Provider output streaming as the agent works.
6. A run summary line: run id, final state (`succeeded` / `failed` / etc.),
   branch name, workspace path, and log paths.

Exit codes: `0` for success or "no eligible issue found"; `1` for a doctor
error, a non-zero provider exit, or `input_required`.

**Do not run `smoke` while the daemon is running.** Both claim issues
independently and will race.

---

## 11. Inspect the evidence

Every run, whether from `smoke` or the daemon, writes evidence under the state
root, outside the workspace:

```text
~/.local/state/symphonika/
  daemon.json
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

Useful commands:

```sh
symphonika runs --limit 20
symphonika show-run <run-id>
```

`show-run` prints the run row, every attempt, every state transition, and the
last N normalized events. `prompt.md` is the exact rendered prompt the agent
saw — the first thing to read when something looked off.

The agent's actual code changes live in the workspace
(`~/.local/state/symphonika/workspaces/my-app/issues/<n>-<slug>/`); the run branch is named
`sym/my-app/<n>-<slug>`. Run state is whether the orchestrator finished
cleanly, not whether the PR merged.

---

## 12. Graduate to the daemon

When `smoke` succeeds end-to-end, you are ready to run the long-lived process.

```sh
symphonika daemon
```

The daemon polls GitHub every `polling.interval_ms` (default 30s), claims
eligible issues, dispatches them, reconciles state, and runs PR follow-up on
any PRs it can associate with its own Issue Branches. It also exposes a small
local HTTP API on `127.0.0.1:3000` (override with `--port`).

In a second terminal, watch the dashboard:

```sh
symphonika status --watch
```

Force an immediate reconcile-and-poll without waiting for the next interval:

```sh
symphonika poll-now
```

Raise log verbosity (useful while iterating on the workflow):

```sh
PINO_LOG_LEVEL=debug symphonika daemon
```

Cancel a stuck run by id:

```sh
symphonika cancel <run-id>
```

Clear a stale claim left behind from a previous attempt:

```sh
symphonika clear-stale my-app 42 --yes
```

`clear-stale` removes `sym:stale`, `sym:claimed`, and `sym:running` from the
named issue. It is intentionally manual: SPEC.md §9.3 says stale claims are
never cleared automatically in v1.

---

## 13. Iterating on the workflow

The user `symphonika.yml` and repository `WORKFLOW.md` are both reloadable. The
daemon re-reads them on every tick and on every `poll-now`. A valid edit applies
to future attempts; in-flight runs keep the prompt and content hash captured
when the attempt started. An invalid edit is surfaced in logs and operator
status, and the daemon keeps using the last known good snapshot.

Workflow guidelines that pay off after a few runs:

- **Be explicit about which checks must pass before pushing.** Vague
  "run the tests" instructions produce runs that push broken builds.
- **Spell out the PR shape.** The exact `gh pr create` command, the base branch,
  the title convention. Agents will follow the precise example.
- **Forbid `--draft` and `--web`** explicitly. Both interfere with the
  autonomous run model.
- **Tell the agent how to exit when blocked.** `gh issue comment` plus a clean
  exit is the only correct path; the moment an agent self-applies
  `needs-human`, automation has to chase a loop.
- **Reference your project docs.** A line like "read `ARCHITECTURE.md` before
  changing anything in `src/auth/`" beats long inline explanations.

The repository's own `WORKFLOW.md` is a worked example you can crib from.

---

## 14. Switching providers, or running both

`agent.provider` is per-Project. The simplest way to try Claude on a workload
that ran on Codex is to copy your Project entry, change `name`, `workspace.root`,
and `agent.provider`, and apply a different eligibility label
(`labels_all: ["agent-ready-claude"]`) to a subset of issues. Both Projects
will dispatch from the same daemon.

If you flip the *existing* Project from Codex to Claude, finish any in-flight
runs first — the workspace is reusable, but mid-flight provider events come
from whichever provider started the attempt.

---

## 15. Where to go next

- **Built-in workflow templates.** Symphonika ships pre-built FSM workflows
  you can drop in without writing YAML by hand:
  `builtin:single-agent-pr`, `builtin:plan-tdd-pr`,
  `builtin:autofix-until-clean`, `builtin:merge-when-green`. See the section
  in [README.md](../README.md#built-in-workflow-templates) and
  [ADR-0049](./adr/0049-builtin-workflow-templates.md) for the contract.
- **Pull-request follow-up.** Once your team is comfortable, set
  `pull_requests.merge.enabled: true` and let Symphonika merge PRs whose
  policy gates are clear. The behaviour is specified in
  [SPEC.md §12.4](../SPEC.md#124-pr-follow-up).
- **Wait and merge states.** Raw FSM workflows can declare `wait` and
  `merge_pr` states to model multi-step shipping pipelines without launching
  a provider for the wait. See [SPEC.md §12.5–§12.6](../SPEC.md#125-wait-states).
- **Multiple Projects.** Add more entries under `projects:` to track several
  repositories from one daemon. Dispatch is weighted round-robin across them.
- **ADRs.** [docs/adr/](./adr/) records the architecture decisions behind
  current behaviour. When something in SPEC.md surprises you, the ADR with
  the matching number is usually the rationale.

---

## Appendix A: Troubleshooting

**`doctor` says no initialized user service config exists.** Run
`symphonika init` from the GitHub repository you want Symphonika to manage, then
run `symphonika doctor` again.

**`doctor` complains about a `sym:stale` label on an issue.** A previous attempt
left durable claim labels but no live local run. Run
`symphonika clear-stale <project> <issue-number> --yes`.

**`smoke` exits with "no eligible issue".** Check that the issue is open, has
every label in `labels_all`, and has none of the labels in `labels_none`. Run
`symphonika status` to see the orchestrator's view of eligibility.

**The provider exits with `input_required`.** The agent invoked a tool that
elicited operator approval — usually a GitHub MCP connector tool. Re-state the
"use `gh` CLI for every GitHub mutation" constraint in `WORKFLOW.md` and rerun.

**The run succeeded but nothing changed on GitHub.** Run success means the
branch has at least one commit ahead of `base_branch` in the workspace. It does
*not* mean the agent pushed, opened a PR, or closed the issue. Check the
workspace and the workflow contract — the push/PR step is workflow-owned.

**Workspace conflicts on retry.** Retries reuse the existing worktree and
branch. Symphonika does not auto-reset dirty worktrees. If the previous attempt
left an inconsistent state, resolve it manually in the workspace directory or
delete it and let the next attempt rebuild.

**The daemon's HTTP port is busy.** Pass `--port <n>` to `symphonika daemon`
and `--daemon-url http://127.0.0.1:<n>` to `status`, `poll-now`, and `cancel`.
