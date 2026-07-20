# Symphonika Specification

Status: Draft v0, bootstrap-oriented

Symphonika is a fresh TypeScript/Node orchestrator for turning GitHub issues into autonomous,
full-permission coding-agent runs. It is inspired by the upstream Symphony specification in
`symphony/SPEC.md`, but this document is the implementation contract for Symphonika.

## 1. Purpose

Symphonika runs as a local daemon. It reads eligible GitHub issues from one or more configured
Projects, creates deterministic Git workspaces and branches, launches Codex or Claude agents inside
those workspaces, and records enough evidence to debug and continue the work.

The first milestone is a self-hosting bootstrap slice: Symphonika should be able to run this
repository as one real Project well enough to help implement later Symphonika issues.

## 2. Non-Goals for v1

- Distributed workers or remote execution.
- A multi-tenant control plane.
- Provider-level sandboxing or approval workflows.
- Cross-repository pull request handling.
- A separate/standalone rich frontend application (SPA). Self-contained, read-only
  interactive visualizations embedded in a server-rendered operator page (e.g. the
  workflow-graph view) are permitted — see §14 and ADR-0056.
- Automatic workspace deletion.
- GitHub Projects board integration.
- Parsing issue-body dependency syntax.

## 3. Implementation Stack

Symphonika uses a small TypeScript stack optimized for agentic coding and debugging:

- Node.js LTS
- strict TypeScript
- `tsx` for development
- `tsc` for production builds
- `commander` for CLI commands
- Hono for the local HTTP API and server-rendered pages
- Zod for runtime validation
- SQLite via direct `better-sqlite3` prepared statements
- Octokit for GitHub API access
- Vitest for tests
- Pino for structured logging

## 4. Domain Model

### 4.1 Project

A Project is a Symphonika-managed work source. It has:

- a name
- GitHub tracker configuration
- issue eligibility filters
- priority label mapping
- workflow contract path
- workspace settings
- agent-provider settings

Project means a Symphonika configuration unit, not a GitHub Projects board.

### 4.2 Issue

An Issue is a normalized GitHub issue record used for dispatch, prompt rendering, and debugging.

Required normalized fields:

- `id`
- `number`
- `title`
- `body`
- `state`
- `url`
- `labels`
- `created_at`
- `updated_at`
- `priority`

GitHub remains canonical for current issue state and eligibility. The run store records issue
snapshots for evidence and reproduction.

### 4.3 Eligible Issue

An issue is eligible when all are true:

- it is open
- it has every configured `labels_all` label
- it has none of the configured `labels_none` labels
- it does not have blocking operational labels
- it is not already running, claimed, failed, or stale according to the orchestrator

v1 uses labels only for blocking. Symphonika does not parse issue body text, task lists, GitHub
Projects fields, or linked PRs to infer blockers.

### 4.4 Operational Labels

Symphonika owns this narrow GitHub label namespace:

- `sym:claimed`
- `sym:running`
- `sym:failed`
- `sym:stale`

The orchestrator may write these labels for dispatch safety and runtime bookkeeping. Workflow
labels, comments, PR links, handoff labels, and issue closure are owned by the coding agent and the
repository workflow.

Operational labels must exist before a Project can dispatch work. Creating missing labels requires
explicit operator confirmation through `init-project` or a deliberate startup flag. The daemon must
not silently create labels.

### 4.5 Workspace

A Workspace is the operational Git worktree assigned to one issue run. Symphonika always starts the
agent with the workspace as the current working directory.

This cwd rule is an operational invariant, not a security boundary. Agents run with full local
permissions.

### 4.6 Issue Branch

An Issue Branch is the deterministic Git branch created by the orchestrator for one issue workspace.

Recommended branch shape:

```text
sym/<project-name>/<issue-number>-<slug>
```

The exact slugging algorithm must be deterministic and path-safe.

### 4.7 Run

A Run is one orchestrator-managed execution lifecycle for one issue in one workspace.

Run success means the provider process completed successfully and the issue branch has at least one
commit ahead of the configured base branch in the Workspace. It does not mean the GitHub issue is
closed, merged, pushed, or represented by a pull request.

### 4.8 Continuation

A Continuation is a follow-up run for the same issue after the provider completed successfully but
the issue remains eligible.

Continuations are capped. Default: `3` per issue.

### 4.9 PR Follow-up

A PR Follow-up is a poll-driven orchestration loop for a pull request discovered from a
Symphonika-created Issue Branch. It records the PR number and head SHA, watches review feedback,
checks, and mergeability, re-dispatches the Coding Agent into the same Workspace when unresolved
review feedback appears, and merges the PR when the configured policy says it is clear.

### 4.10 Agent Provider

An Agent Provider is a normalized adapter that lets Symphonika run one coding-agent implementation.

v1 supports both:

- Codex through JSON-RPC app-server mode
- Claude through `stream-json` CLI mode

### 4.11 Event Logs

Symphonika stores both:

- Provider Event Log: raw provider protocol stream for the run
- Normalized Event Log: provider-neutral events used by the orchestrator, UI, tests, and debugging

### 4.12 Routine

A Routine is a Project-owned scheduled prompt declaration. Symphonika supports hand-authored Markdown
routine files with YAML front matter:

- `name`
- `schedule.at`
- `kind: report` or `kind: git`
- optional `provider`

The Markdown body is the routine prompt template. `name` must be safe as a single workspace path
segment because routine firing workspaces live under `<workspace.root>/routines/<name>/<firing-id>/`.

### 4.13 Routine Firing

A Routine Firing is one durable execution of a Routine. It records the Routine, Project, provider,
workspace path, prompt evidence, provider logs, terminal reason, lifecycle state, and any pull
requests discovered from a `kind: git` firing branch. One-shot `schedule.at` routines become
`expired` after the first firing is created and must not fire again on daemon restart.

## 5. Config Files

### 5.1 Service Config

The service config file is named `symphonika.yml`. By default the CLI uses
`./symphonika.yml` when the current directory provides one; otherwise it uses the initialized
user config at `$XDG_CONFIG_HOME/symphonika/symphonika.yml`, falling back to
`~/.config/symphonika/symphonika.yml` when `XDG_CONFIG_HOME` is unset. Operators can always select
another file with `--config`.

It is reloadable and owned by the orchestrator. It lists Projects and service-level runtime
settings.

v1 implements reload by defensively re-reading the selected `symphonika.yml` on each daemon tick
and manual poll-now trigger. A valid reload replaces the effective snapshot used for future polling,
dispatch, retry, continuation, provider-command selection, and PR follow-up policy. An invalid
reload is surfaced in structured logs and operator status while the daemon keeps using the last
known good effective snapshot.

`symphonika init` is the default first-run path for a project checkout. It runs from inside a
GitHub-backed repository, derives the Project from `origin`, writes the user service config, chooses
`$XDG_STATE_HOME/symphonika` (or `~/.local/state/symphonika`) as the state root, and creates a
starter repository-owned `WORKFLOW.md` only when one does not already exist. It does not create
GitHub operational labels; `init-project --yes` remains the explicit label-creation step.

Example:

```yaml
state:
  root: ./.symphonika

polling:
  interval_ms: 30000

watchdog:
  enabled: true
  grace_minutes: 30
  sample_interval_seconds: 60
  mtime_ignore: []

pull_requests:
  enabled: true
  review_followup:
    max_dispatches_per_pr: 3
  merge:
    enabled: true
    method: squash
    require_status_success: true
    require_review_decision: false

providers:
  codex:
    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"
  claude:
    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"

projects:
  - name: symphonika
    disabled: false
    weight: 1
    tracker:
      kind: github
      owner: pmatos
      repo: symphonika
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
      root: ./.symphonika/workspaces/symphonika
      git:
        remote: git@github.com:pmatos/symphonika.git
        base_branch: main
    agent:
      provider: codex
    workflow: ./WORKFLOW.md
    routines:
      - ./daily-report.md
```

The bootstrap slice must use this final multi-project shape even with one configured Project.

A Project may override only `watchdog.grace_minutes` with a positive integer. It inherits
`watchdog.enabled`, `watchdog.sample_interval_seconds`, and `watchdog.mtime_ignore` from daemon
scope, so a Project can lengthen its grace window but cannot opt into a daemon-disabled Watchdog.
Project overrides are part of the defensive Service Config reload snapshot: any invalid value or
unknown key rejects the candidate snapshot for all Projects and leaves the last known-good snapshot
live.

### 5.2 Workflow Contract

Each Project must reference a valid `WORKFLOW.md`.

`WORKFLOW.md` is reloadable and repository-owned. It contains the prompt body and may contain
optional YAML front matter for prompt-adjacent execution policy.

Workflow contracts are re-read as part of the daemon's defensive service-config reload. A valid
workflow edit applies to future attempts. In-flight attempts keep the rendered prompt and workflow
content hash captured when the attempt was created. If a reload sees an invalid workflow for an
existing Project, the daemon reports the reload error and keeps the last known good effective
workflow snapshot for future work until a valid reload is available.

Service discovery, tracker settings, workspace roots, provider selection, and GitHub labels belong
in `symphonika.yml`, not in `WORKFLOW.md`.

Raw FSM agent states may declare `action.provider` to route that state to a specific configured
Agent Provider. If an agent state omits `action.provider`, Symphonika uses the Project's
`agent.provider` from `symphonika.yml`.

The daemon must not dispatch a Project when its workflow contract is missing or invalid.

### 5.3 Templating

Workflow prompt rendering uses simple strict Mustache-style variables. Unknown variables fail prompt
rendering. Templates must not execute arbitrary JavaScript.

Available top-level objects:

- `project`
- `issue`
- `workspace`
- `branch`
- `run`
- `provider`

Symphonika prepends a standard autonomy preamble to every rendered workflow prompt.

Routine prompt rendering uses the same strict templating rules and the same standard autonomy
preamble. For every Routine kind, available top-level objects are:

- `project`
- `workspace`
- `provider`
- `routine`
- `firing`

`kind: git` additionally exposes `branch.name` and `branch.ref`. `branch` is unavailable to
`kind: report`; `issue` and `run` are unavailable to every Routine kind. Referencing an unavailable
object fails rendering with terminal reason `prompt_render_error`.

The preamble tells the agent:

- it is running as an autonomous full-permission worker
- no operator will respond to prompts, approve tool calls, or read intermediate output during the run; behaviour that depends on a human answering mid-run is a failure mode
- it should make reasonable decisions when ambiguity is low and document them via `gh issue comment`
- it should use the local `gh` CLI for every GitHub mutation and avoid the GitHub MCP connector tools (for example `add_issue_labels`, `create_pull_request`), which elicit per-call operator approval through the provider transport
- it should not self-apply `needs-human` (or any other handoff label) as an exit strategy — leave a `gh issue comment` describing the blocker and exit cleanly instead
- it should preserve evidence when blocked
- it should use the prepared workspace and issue branch
- it should operate on the assigned issue unless the workflow says otherwise

### 5.4 Routine Declarations

Projects may define `routines: string[]` in `symphonika.yml`. Paths are resolved relative to the
service config directory and are re-read on every daemon tick with the rest of the runtime snapshot.
Invalid routine declarations are reported through the same reload-error surface as invalid workflow
contracts, and the daemon keeps using the last known good snapshot.

Slice 1 supports only one-shot `schedule.at` routines. Cron and any second schedule field are
invalid in this slice.

## 6. Credentials

GitHub credentials are environment-backed.

- Default token environment variable: `GITHUB_TOKEN`
- Service config may reference another variable with `$VAR_NAME`
- Literal tokens should not be stored in YAML
- Tokens must not be stored in SQLite
- Token-like values must be redacted from logs

Codex and Claude use their native local authentication.

## 7. State and Logs

### 7.1 State Root

Default state root:

```text
$XDG_STATE_HOME/symphonika when using the initialized user config
<directory-containing-symphonika.yml>/.symphonika for explicit or project-local configs
```

The state root may be overridden in config, for example:

```yaml
state:
  root: ~/.local/state/symphonika
```

Project repositories do not need a deploy-local state directory when using `symphonika init`; state
and workspaces live under the user state root. Repositories that carry their own project-local
`symphonika.yml` should gitignore `.symphonika/`.

### 7.2 Run Store

SQLite stores durable orchestration state:

- Projects
- project validation status
- project cursors
- runs
- attempts
- retry state
- tracked PR associations
- claim state snapshots
- issue snapshots
- rendered prompt metadata
- provider/session IDs
- workspace paths
- normalized event metadata
- Watchdog samples for no-progress detection
- raw log file paths
- routines
- routine firings

The run store is not a replacement for GitHub as the canonical tracker. It is durable runtime
evidence and restart state.

Run-store readers expose evidence as typed values, readable streams, and artifact descriptors.
Absolute evidence file paths remain an internal persistence detail used by writers and migrations;
operator surfaces link artifacts by stable artifact kind rather than by on-disk filename.

### 7.3 Log Layout

Raw logs live under the state root, outside issue workspaces.

Recommended layout:

```text
<state.root>/
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

Agents may modify workspaces, so orchestrator evidence must stay outside the Git worktree.
When the daemon is running, `daemon.json` records the local API endpoint for that state root.
Operator CLI commands that use the descriptor must preflight the daemon status and reject endpoints
whose reported state root differs from the configured state root.

### 7.4 Prompt Evidence

Each provider attempt stores:

- autonomy preamble version
- workflow contract path
- workflow content hash
- rendered prompt text
- provider name
- provider command
- workspace path
- issue branch
- issue snapshot
- expanded workflow graph (workflow name, source kind, source path, content hash, initial
  state, states, transitions, terminal markers, template files)

First attempts write `prompt.md`, `prompt-metadata.json`, `issue-snapshot.json`, and
`workflow-graph.json`. Retries write `prompt.attempt-<N>.md`,
`prompt-metadata.attempt-<N>.json`, `issue-snapshot.attempt-<N>.json`, and
`workflow-graph.attempt-<N>.json` so prior attempts' rendered prompts, issue snapshots, metadata,
and workflow graphs remain inspectable through attempt-scoped artifact descriptors. Markdown
`WORKFLOW.md` workflows record their one-state compatibility graph; explicit raw FSM YAML workflows
record their parsed expanded graph. Multi-state raw FSM walks advance through the state machine via
a `state_advance` dispatch path that is distinct from label-driven continuations; see ADR 0046.

## 8. Scheduling

### 8.1 Daemon Shape

v1 is one local daemon process.

The daemon owns:

- config loading and hot reload
- Project validation
- polling
- claim decisions
- workspace preparation
- provider launches
- reconciliation
- retries and continuations
- PR follow-up polling for Symphonika-owned PRs
- local UI/API
- routine schedule evaluation and firing dispatch

### 8.2 Startup Sequence

On daemon startup:

1. Load the selected `symphonika.yml`.
2. Open or initialize SQLite.
3. Backfill legacy `input_required` Run rows older than 60 seconds to `failed` with
   `terminal_reason = "provider requested input (legacy)"`.
4. Validate Projects.
5. Reconcile stale labels and previous run state.
6. Start local UI/API if enabled.
7. Perform an immediate poll.
8. Schedule interval polling.

Default poll interval: `30000` ms.

Manual poll-now triggers may exist in CLI or UI/API. They run the same daemon reconcile, polling,
and dispatch gates as interval ticks, and may queue or coalesce when another manual poll is already
pending. Validation and status commands must not dispatch work.

The daemon also runs the Watchdog during reconciliation according to
`watchdog.sample_interval_seconds`. The default Watchdog policy is enabled with a 30 minute
no-progress grace window and 60 second sampling interval.

### 8.3 Multi-Project Dispatch

The orchestrator is the single authority for dispatch.

Projects have Project Cursors for poll cadence, last poll outcome, and retry timing.

Dispatch uses weighted round-robin across Projects. Within each Project, issues are sorted by:

1. configured priority label mapping
2. oldest creation time
3. issue number

Invalid Projects are disabled. Valid Projects may continue running.

### 8.4 Project Disable and Removal

`disabled: true` stops new dispatch immediately.

Existing runs continue by default. Removing a Project from service config marks it inactive rather
than killing active full-permission agents. Operators can explicitly cancel runs.

Routine rows for Projects omitted from the current valid service-config snapshot are marked
inactive and pruned from operator routine listings on reload. Historical `routine_firings` rows
remain durable run-store evidence.

### 8.5 Routines

On each daemon tick, Symphonika evaluates loaded active Routines. Slice 1's `ScheduleEvaluator`
supports one-shot `schedule.at` only:

- `wait_until` when `now < at`
- `fire_now` when `now >= at` and the Routine has not fired
- `expired` after a firing exists or the Routine state is `expired`

When a Routine fires, Symphonika allocates a ULID firing id and prepares a workspace at
`<workspace.root>/routines/<routine-name>/<firing-id>/`. A `kind: report` workspace is detached at
the Project base branch. A `kind: git` workspace is checked out on
`sym/<project>/routine/<routine-name>/<first-10-firing-id-chars>`, created from the Project base.
Symphonika renders the routine prompt, runs the configured provider, records a `routine_firings`
row, and marks a one-shot Routine `expired`. Routine Firings use states `queued`,
`preparing_workspace`, `running`, `succeeded`, `failed`, and `cancelled`.

For `kind: report`, provider exit code 0 succeeds without requiring commits. For `kind: git`, exit
code 0 applies the same commits-ahead-of-base inspection as §12.1: zero commits fails with
`no_workspace_changes`, inspection failure fails with `workspace_inspection_failed`, and one or
more commits succeeds. On the succeeded transition, Symphonika lists every open pull request whose
head is the firing branch and records its PR number and head SHA. Routine PR discovery is
informational only: it never enters PR Follow-up, review re-dispatch, or auto-merge.

Routine Firings consume the same per-Project and global `max_in_flight` slots as issue Runs. If a
cap is already full when a Routine is due, the daemon skips that fire for this slice and logs the
skip; no firing row is written.

## 9. GitHub Tracker Behavior

### 9.1 Required Operations

The GitHub tracker adapter supports:

- validating repository access
- validating operational labels
- creating operational labels after explicit confirmation
- fetching candidate issues
- fetching current issue state for reconciliation
- applying and removing operational labels

### 9.2 Eligibility

v1 dispatches from GitHub issues only.

Default labels:

- required: `agent-ready`
- excluded: `blocked`, `needs-human`, `sym:stale`

Each Project may configure these.

### 9.3 Operational Label Writes

On claim:

- add `sym:claimed`
- add `sym:running` when the run starts

On success:

- remove `sym:running`
- re-check issue eligibility
- schedule a continuation if still eligible and under continuation cap

On failed deterministic terminal state:

- remove `sym:running`
- add `sym:failed`
- preserve `sym:claimed` until operator action

On closed issue:

- cancel active run
- remove operational labels best-effort
- preserve workspace and logs

On eligibility loss while running:

- cancel active run
- remove `sym:running`
- preserve workspace and logs

On Watchdog no-progress termination:

- transition the Run to `state = "stale"`
- record `terminal_reason = "no_progress"` with deterministic classification
- request provider cancellation
- remove `sym:running` best-effort when the provider stream unwinds
- preserve workspace and logs

On stale startup state:

- if GitHub has `sym:claimed` or `sym:running` but there is no live local run, mark `sym:stale`
- do not auto-clear stale claims in v1
- sweep run rows in `queued`, `preparing_workspace`, or `running` to terminal `stale` —
  their scheduler callback and provider stream were lost with the previous daemon
- sweep run rows in `state = "waiting"` only when `current_state_id IS NULL` (a pre-atomicity
  crash artifact, see ADR 0047); preserve valid waits so `reconcileWaitingRuns` can pick them
  up on the next tick

### 9.4 PR Follow-up Scope

The orchestrator does not inspect arbitrary pull requests to decide issue eligibility. It only
tracks PRs that can be associated with a completed Symphonika Run by the deterministic Issue Branch.
Repository workflows and coding agents remain responsible for opening PRs, writing comments, and
removing `agent-ready`; Symphonika records the discovered PR number and head SHA so the daemon can
continue the same branch after review feedback.

Routine PR discovery is a separate, read-only association. A succeeded `kind: git` Routine Firing
records every open PR found on its deterministic firing branch, but those PRs are never candidates
for review re-dispatch or auto-merge.

The v1 trigger model is poll-based and runs on the daemon tick. Webhooks are deferred.

## 10. Workspace and Git Behavior

Symphonika has first-class Git workspace preparation for GitHub Projects.

Recommended layout:

```text
<workspace.root>/
  .cache/
    repo.git
  issues/
    <issue-number>-<slug>/
  routines/
    <routine-name>/
      <firing-id>/
```

First attempt:

- ensure repository cache exists
- fetch base branch
- create deterministic issue branch
- create deterministic issue worktree
- run configured hooks
- launch provider from workspace cwd

Retry or continuation:

- reuse the same worktree and issue branch
- dirty worktrees are expected
- do not auto-reset
- do not auto-delete
- notify the agent in the rendered prompt that it is entering a previous-attempt workspace

Workspace conflicts are deterministic failures unless explicitly resolved by an operator.

## 11. Agent Providers

### 11.1 Common Provider Interface

Provider adapters expose a normalized interface conceptually equivalent to:

```ts
type AgentProvider = {
  name: "codex" | "claude";
  validate(command: string): Promise<void>;
  runAttempt(input: ProviderRunInput): AsyncIterable<ProviderEvent>;
  cancel(runId: string): Promise<void>;
};
```

The exact TypeScript shape may vary, but orchestration code must depend on normalized provider
events rather than provider-specific protocol details.

### 11.2 Normalized Events

Required normalized events:

- `session_started`
- `message`
- `tool_call`
- `usage_updated`
- `rate_limit_updated`
- `turn_completed`
- `turn_failed`
- `input_required`
- `process_exit`
- `malformed_event`

Provider adapters must persist raw stream entries and derive normalized events.

### 11.3 Full-Permission Execution

Symphonika assumes providers run with full local permissions.

Default Codex command:

```text
codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server
```

The `-p symphonika` flag selects a named profile that operators define in `~/.codex/config.toml` so
headless runs do not pick up interactive Codex defaults (memory consolidation, hooks, etc.). See
ADR-0042 for the contract and the snippet operators paste; `doctor` surfaces the snippet when the
profile is missing.

Default Claude command:

```text
claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json
```

Provider commands may be overridden, but the replacement command must speak the provider adapter's
expected protocol.

Future sandboxing, if added, should be outside the provider through host, container, VM, network, or
credential isolation.

### 11.4 Input Required

Runs are autonomous. If a provider requests interactive input:

- record normalized `input_required`
- fail the attempt and persist the Run as `failed` with terminal reason `provider requested input`
- add `sym:failed`
- preserve logs and workspace

The prompt preamble minimizes these cases by telling agents not to ask for operator input and to avoid tools (such as the GitHub MCP connector) that elicit operator approval through provider transports.

### 11.5 GitHub Tools

v1 does not expose provider-specific GitHub tools.

The orchestrator uses GitHub API for polling, reconciliation, and operational labels. Agents use
normal local tools and credentials, such as `git` and `gh`, for comments, pushes, pull requests,
handoff labels, and closure.

## 12. Run Lifecycle

Normalized lifecycle states:

- `queued`
- `preparing_workspace`
- `running`
- `input_required` (transient or legacy only; durable provider-input failures are `failed`)
- `failed`
- `succeeded`
- `cancelled`
- `stale`
- `waiting`

Terminal run state does not necessarily match GitHub issue state.

### 12.1 Success

On provider exit code 0:

1. Inspect the Workspace issue branch against
   `refs/remotes/origin/<configured-base-branch>..HEAD`.
2. If the branch has zero commits ahead of base, mark the run `failed` with deterministic terminal
   reason `no_workspace_changes`.
3. If Workspace inspection fails, mark the run `failed` with deterministic terminal reason
   `workspace_inspection_failed`.
4. If the branch is ahead of base, mark run `succeeded`.
5. Remove `sym:running`.
6. Re-check GitHub issue.
7. If the issue remains eligible, schedule a short continuation.
8. If the continuation cap is reached, mark `sym:failed` and surface the reason.

Default continuation delay: about 1 second.

Default continuation cap: `3`.

### 12.2 Failure

Retry only transient infrastructure or provider failures.

For raw FSM workflows, retryable transient failures consume the retry budget before non-terminal
FSM transitions matching the failure signals are allowed to advance or park the workflow. The retry
re-enters the same FSM state and preserves the state-advance label-immunity bit when the failed run
was already mid-walk. Terminal `failure` / `blocked` transitions remain workflow-authored
deterministic verdicts and pre-empt retry. After the retry budget is exhausted, the final attempt's
signals are evaluated normally by the FSM; if no workflow transition handles them, the run follows
the exhausted-retry failure path below.

Default retry policy:

- retry cap: `3`
- delays: about `10s`, `30s`, `2m`
- maximum backoff: `5m`

Do not automatically retry deterministic failures:

- prompt render error
- invalid config
- missing workflow
- input required
- continuation cap reached
- no workspace commits ahead of base after provider exit code 0
- workspace success inspection failure
- workspace branch conflict
- Project validation failure

After retry exhaustion:

- mark run failed
- add `sym:failed`
- preserve logs
- preserve workspace

### 12.3 Cancellation

Cancel active provider process when:

- issue is closed
- issue loses eligibility
- operator cancels through CLI or UI

Cancellation preserves workspace and logs.

### 12.4 Watchdog

The Watchdog detects active provider runs that have stopped doing observable work. It samples rows
in `state = "running"` only — the one active state with a live Agent Provider that can wedge. Rows
in `queued` and `preparing_workspace` have no provider executing yet, so they have no liveness
signal to advance and must not accrue idle time; rows in `state = "waiting"` are reconciled by the
wait-state path. A `running` Run that already carries `cancel_requested` is also skipped, so the
Watchdog does not overwrite a more specific in-flight cancellation with `no_progress`.

For each sampled Run, Symphonika records one durable `watchdog_samples` row keyed by `run_id`:
`sampled_at`, `last_tool_call_at`, `last_message_at`, `workspace_mtime_max`, `turn_id_set_size`,
`output_tokens_total`, `normalized_log_offset`, `normalized_log_path`, and `idle_since`. `idle_since`
survives daemon restart, so a Run that was already observed idle resumes its grace window from the
first idle observation rather than from process boot. It is cleared on entry to `waiting` (so an
unsampled wait excursion does not accrue idle time) and reset on attempt change (so a transient
retry, which re-enters a running agent state, starts a fresh grace window).

Sampling reads the Normalized Event Log only forward of the stored byte offset and walks the
Workspace tree once. A transient retry writes a new per-attempt log path, so the byte offset and the
output-token baseline are reset whenever `normalized_log_path` changes and the new attempt's events
are read from the start. The hard-coded v1 exclude set is `.git/`, `target/`, and `node_modules/`,
skipped at the directory-entry level and not descended; `watchdog.mtime_ignore` adds
workspace-relative globs whose matching files are dropped from the mtime walk at the individual-file
level, so build-output churn (e.g. `*.log`) cannot keep a wedged Run alive.

A sampled Run is making progress when any one signal advances since the previous sample:

- `last_tool_call_at` increases
- `workspace_mtime_max` advances by at least one second
- `turn_id_set_size` increases (only the Codex provider tags events with a `turnId`; Claude emits
  `sessionId`, so this signal advances for Codex Runs)
- `output_tokens_total` increases
- `last_message_at` increases (a new streamed assistant `message` event arrived — both providers
  normalize their streamed deltas to a `message` event)

`usage_updated` and `rate_limit_updated` events alone do not count unless output tokens grow or
another signal advances. When no progress is observed, the Watchdog persists `idle_since` on first
observation. Once `now - idle_since >= watchdog.grace_minutes`, it transitions the Run to
`stale` with `terminal_reason = "no_progress"` and requests provider cancellation. `no_progress`
is a deterministic terminal verdict for that attempt, not a transient retry reason.

### 12.5 PR Follow-up

On each daemon tick, Symphonika discovers open PRs for succeeded runs whose Issue Branch is not yet
tracked. For each tracked open PR:

1. Fetch PR review state, unresolved review threads, status-check rollup, head SHA, and mergeability.
2. If unresolved review threads or requested changes exist, start a follow-up Run in the same
   Workspace and Issue Branch. The prompt includes the review thread context and tells the agent not
   to open a second PR.
3. Do not repeat the same review follow-up for the same head SHA and review-feedback fingerprint.
4. Stop automatic review follow-up after `pull_requests.review_followup.max_dispatches_per_pr`.
5. If the PR is open, non-draft, mergeable, has no unresolved review feedback, satisfies the review
   policy, and has passing status checks when required, merge it using the configured merge method.

Default PR follow-up policy: poll enabled, at most `3` review dispatches per PR, squash merge,
require successful status checks, and do not require an explicit approval unless repository rules
surface `REVIEW_REQUIRED`.

### 12.6 Wait States

Raw FSM workflows may declare `action.kind: "wait"` states that pause the workflow walk until
observable pull-request conditions change. A wait state does not launch a provider; instead the
daemon re-evaluates it on every tick and on `/poll-now`.

Lifecycle:

1. When an agent state succeeds and the FSM advances into a wait state, Symphonika persists a new
   Run row with `state = "waiting"`, `current_state_id` set to the wait state id, and
   `continuation_parent_run_id` set to the parent agent run. Both `state` and `current_state_id`
   are written inside a single SQLite transaction so the row is durable as a complete wait
   (a crash cannot leave a `state = "waiting"` row with `current_state_id IS NULL`). The parent
   run records the advance via `state_transition_reason` exactly like any other state advance
   (per ADR 0046).
2. On each daemon tick (and on `/poll-now`), the reconciliation phase calls
   `reconcileWaitingRuns`, which iterates the rows in `state = "waiting"`, refreshes the issue,
   looks up the tracked pull request, fetches its follow-up state, projects predicates
   (`pr_open`, `pr_merged`, `mergeable`, `checks`, `review_decision`,
   `has_unresolved_reviews`, `unresolved_review_threads`) and emits a static
   `provider_success: true`, then evaluates the wait state's transitions in file order.
3. The first matching transition wins. If the destination is an agent state, Symphonika schedules
   a `state_advance` that runs the agent through `runFreshLifecycle`. If the destination is another
   wait state, Symphonika creates a new waiting Run row and schedules a `wait_park` re-evaluation.
   If the destination is terminal, the waiting Run records `terminal_state_id` and transitions to
   `succeeded`.
4. If no transition matches and the wait state's `complete_when` is not violated, the wait stays
   parked (`stay_waiting`); reconciliation will re-evaluate it on the next tick.
5. Issue close cancels a waiting Run with `cancel_reason = "closed_issue"`. Operator cancel marks
   the cancel reason; the next re-evaluation tick observes the cancel-requested flag and
   transitions the Run to `cancelled`.
6. Label drift does not cancel a waiting Run. Mid-walk runs are immune to `labels_all` and
   `labels_none` re-checks; the FSM owns transitions while the walk is in flight (ADR 0046,
   carried over to wait states by ADR 0047).

Mergeability `UNKNOWN`/`null` is intentionally projected as the predicate key omitted — workflow
transitions writing `mergeable: false` will not match on unknown values, so the wait stays parked
until GitHub resolves the mergeability. The `timeout` predicate is reserved in the schema but
unimplemented in v1.

Review decisions are projected as `review_decision: approved|changes_requested|review_required|none`.
The `none` value covers GitHub `null`. Unresolved review feedback is projected both as
`unresolved_review_threads: <number>` for exact-count workflows and
`has_unresolved_reviews: <boolean>` for strict-equality workflows that only need to detect whether
any unresolved threads exist.

### 12.7 Merge States

Raw FSM workflows may declare `action.kind: "merge_pr"` states that merge the workflow instance's
Symphonika-owned pull request when the configured policy is satisfied. A merge state does not
launch a provider; it is poll-driven and reconciled on every daemon tick, exactly like a wait
state. The optional `method` field overrides the merge method from `pull_requests.merge.method`
for that single state.

Lifecycle:

1. When the FSM advances into a `merge_pr` state, Symphonika persists a new Run row with
   `state = "waiting"` and `current_state_id` set to the merge state id, identical to a wait
   parking. The parent Run records `state_transition_reason` for the advance.
2. On each daemon tick (and on `/poll-now`), `reconcileWaitingRuns` calls
   `reEvaluateWaitingRun`. For a merge state the handler looks up the tracked pull request
   associated with the workflow instance's issue and project — Symphonika never merges a PR
   that is not tied to its own issue branch. If no tracked PR exists yet, the run stays parked
   and records `state_transition_reason = "merge_pr awaiting Symphonika-tracked pull request"`.
3. If a tracked PR exists, the handler refreshes its follow-up state from GitHub, projects the
   same predicate set used by wait states, and checks `pullRequestReadyToMerge` against the
   configured `pull_requests.merge` policy (mergeable, required status success, required
   review decision). If the policy is not satisfied, the run stays parked with a deferred
   reason recorded. If `pull_requests.merge.enabled` is `false`, the merge is also deferred and
   the policy gate is recorded.
4. When the policy is satisfied, Symphonika calls `mergePullRequest` with the workflow's
   `method` override (if any) or the policy default, pinning the merge to the observed head
   SHA. On success the tracked-PR row is moved to `merged`, the signals projected for
   `decideNextStep` include `pr_merged: true`, and the workflow advances via its transitions.
   On a merge API failure the run records the error in `state_transition_reason` and stays
   parked; the next tick retries from the same row.
5. Successful merge transitions advancing into a terminal state record the terminal as
   `succeeded`, exactly like wait-state terminals. Failed, deferred, blocked, or missing-PR
   outcomes record deterministic `state_transition_reason` text on the merge state's Run row
   and never delete the workspace, matching §10 (workspaces are never auto-deleted).

The merge state is intentionally scoped to Symphonika-tracked PRs — arbitrary cross-issue or
external PRs are out of scope. PR follow-up policy (`§12.5`) and merge-state evaluation share
the same `pullRequestReadyToMerge` helper so the two paths cannot drift on what counts as
mergeable. Cancellation, issue-close, and label-immunity semantics are inherited from wait
states (§12.6).

## 13. CLI

Bootstrap CLI commands:

- `symphonika init [--provider codex|claude] [--force]`
- `symphonika doctor [--config <path>]`
- `symphonika init-project [--config <path>] --yes`
- `symphonika daemon [--config <path>] [--port <port>]`
- `symphonika service install [--config <path>] [--force] [--print] [--no-reload]`
- `symphonika status [--config <path>] [--dashboard] [--watch] [--interval-ms <ms>] [--doctor-ttl-ms <ms>]`
- `symphonika poll-now [--config <path>]`
- `symphonika runs [--config <path>]`
- `symphonika routines [--config <path>]`
- `symphonika show-run <run-id> [--config <path>]`
- `symphonika cancel <run-id> [--config <path>]`
- `symphonika clear-stale <project> <issue-number> [--config <path>] --yes`

When neither a project-local config nor a user config exists, `doctor` reports the missing user
config path and points the operator to `symphonika init`.

`doctor` validates:

- config parse
- Project shape
- GitHub auth
- repository access
- operational labels
- provider commands for Codex and Claude
- workflow contract path and parse
- database path
- workspace root

`init` writes local files only and never mutates GitHub. `init-project` creates missing operational
labels only after explicit confirmation.

`service install --config <path>` resolves the selected Service Config to an absolute path and
bakes it into the generated unit as `daemon --config <absolute-path>`. Omitting `--config` keeps the
unit on the daemon's normal project-local/user-config discovery path.

`status --dashboard` renders a compact terminal status dashboard from the run store and daemon
`/api/status` endpoint. `status --watch` refreshes that read-only dashboard in place; it must not
dispatch work or mutate GitHub state. Watch mode refreshes daemon status and run-store data every
frame, but caches the full `doctor` validation path for 5000 ms by default so passive dashboards do
not continuously re-run provider probes or GitHub validation reads. `--doctor-ttl-ms 0` disables that
cache when an operator explicitly wants every frame to perform full validation.

`routines` lists routine status per Project with `state`, `next_fire_at`, `last_fired_at`, and PR
numbers discovered for the latest firing.

`clear-stale` removes `sym:stale`, `sym:claimed`, and `sym:running` only after explicit confirmation.

## 14. Local Web UI and API

v1 ships a local HTTP API and lightweight server-rendered operator pages.

Default bind host: `127.0.0.1`.

The UI is primarily read-only. It shows:

- Projects
- validation state
- eligible/running/failed/stale issues
- runs and attempts
- normalized events
- raw log links or content
- rendered prompt links
- retry and continuation state
- routines with `state`, `next_fire_at`, `last_fired_at`, and discovered PR numbers
- a per-run interactive workflow graph

Operator pages stay server-rendered and primarily read-only, but a page may embed a
self-contained, client-side interactive visualization to make evidence explorable — for
example the workflow-graph view at `GET /runs/:id/graph`, which renders a run's expanded FSM
(ADR-0045) with pan/zoom and click-to-inspect. Such a visualization must be self-contained
(no build step, no bundled single-page application), must degrade gracefully when its external
visualization dependencies are unavailable — if the CDN/vendored viz libraries are blocked or
fail Subresource Integrity, the page's own inline script renders a text listing of the evidence
instead of a blank canvas — and must not introduce mutating actions beyond the ones listed
below. This narrows — it does not remove — the §2 non-goal: Symphonika still does not ship a
separate frontend application. See ADR-0056.

The v1 mutating web actions are explicit active-run cancellation and a manual poll-now trigger that
uses the normal daemon scheduler path.

The HTTP API exposes `GET /api/routines` with the same routine status shape as the CLI and
dashboard. `GET /api/routines/:id/firings` returns firing history and linked PRs for the named
Routine; callers use `?project=<name>` to disambiguate the same Routine name across Projects.

Label creation, stale-claim reset, and workspace cleanup remain CLI-only.

## 15. Bootstrap Acceptance Bar

The bootstrap slice is accepted when:

- tests pass
- lint passes
- `init` can create a user service config and starter workflow from a GitHub-backed project checkout
- `doctor` validates service config, GitHub auth, operational labels, Codex and Claude provider
  commands, workflow file, database path, and workspace root
- `init-project` can create missing operational labels after confirmation
- `daemon` can claim one `agent-ready` issue in this repository
- daemon prepares the deterministic issue worktree and branch
- daemon runs the configured provider through either Codex JSON-RPC or Claude stream-json
- daemon captures raw logs, normalized events, rendered prompt, issue snapshot, and provider metadata
- durable run state is updated in SQLite
- CLI and local status page show Projects, runs, failures, input-required events, stale state, and
  log links

## 16. Deferred Work

- remote workers
- external sandboxing
- richer UI
- workspace cleanup commands
- stale-claim TTLs
- GitHub Projects board support
- webhook-based PR subscriptions
- first-class provider-neutral GitHub tools for agents
- distributed scheduling
- production packaging
