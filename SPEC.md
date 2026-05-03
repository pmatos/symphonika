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
- Automatic pull request detection.
- A rich frontend application.
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
- SQLite via `better-sqlite3`
- Kysely for typed SQL
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

Run success means the provider process completed successfully. It does not mean the GitHub issue is
closed, merged, or complete.

### 4.8 Continuation

A Continuation is a follow-up run for the same issue after the provider completed successfully but
the issue remains eligible.

Continuations are capped. Default: `3` per issue.

### 4.9 Agent Provider

An Agent Provider is a normalized adapter that lets Symphonika run one coding-agent implementation.

v1 supports both:

- Codex through JSON-RPC app-server mode
- Claude through `stream-json` CLI mode

### 4.10 Event Logs

Symphonika stores both:

- Provider Event Log: raw provider protocol stream for the run
- Normalized Event Log: provider-neutral events used by the orchestrator, UI, tests, and debugging

## 5. Config Files

### 5.1 Service Config

The default service config file is `symphonika.yml`.

It is reloadable and owned by the orchestrator. It lists Projects and service-level runtime
settings.

Example:

```yaml
state:
  root: ./.symphonika

polling:
  interval_ms: 30000

providers:
  codex:
    command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server"
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
```

The bootstrap slice must use this final multi-project shape even with one configured Project.

### 5.2 Workflow Contract

Each Project must reference a valid `WORKFLOW.md`.

`WORKFLOW.md` is reloadable and repository-owned. It contains the prompt body and may contain
optional YAML front matter for prompt-adjacent execution policy.

Service discovery, tracker settings, workspace roots, provider selection, and GitHub labels belong
in `symphonika.yml`, not in `WORKFLOW.md`.

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

The preamble tells the agent:

- it is running as an autonomous full-permission worker
- it should not request operator input
- it should make reasonable decisions when ambiguity is low
- it should preserve evidence when blocked
- it should use the prepared workspace and issue branch
- it should operate on the assigned issue unless the workflow says otherwise

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
<directory-containing-symphonika.yml>/.symphonika
```

The state root may be overridden in config, for example:

```yaml
state:
  root: ~/.local/state/symphonika
```

The repository should gitignore `.symphonika/`.

### 7.2 Run Store

SQLite stores durable orchestration state:

- Projects
- project validation status
- project cursors
- runs
- attempts
- retry state
- claim state snapshots
- issue snapshots
- rendered prompt metadata
- provider/session IDs
- workspace paths
- normalized event metadata
- raw log file paths

The run store is not a replacement for GitHub as the canonical tracker. It is durable runtime
evidence and restart state.

### 7.3 Log Layout

Raw logs live under the state root, outside issue workspaces.

Recommended layout:

```text
.symphonika/
  symphonika.db
  logs/
    runs/
      <run-id>/
        provider.raw.jsonl
        provider.normalized.jsonl
        stderr.log
        prompt.md
```

Agents may modify workspaces, so orchestrator evidence must stay outside the Git worktree.

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
- local UI/API

### 8.2 Startup Sequence

On daemon startup:

1. Load `symphonika.yml`.
2. Open or initialize SQLite.
3. Validate Projects.
4. Reconcile stale labels and previous run state.
5. Start local UI/API if enabled.
6. Perform an immediate poll.
7. Schedule interval polling.

Default poll interval: `30000` ms.

Manual poll-now triggers may exist in CLI or UI/API. Validation and status commands must not
dispatch work.

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

On stale startup state:

- if GitHub has `sym:claimed` or `sym:running` but there is no live local run, mark `sym:stale`
- do not auto-clear stale claims in v1

### 9.4 No PR Detection

The orchestrator does not inspect pull requests to decide eligibility. Workflow prompts and agents
are responsible for removing `agent-ready`, adding handoff labels, commenting, opening PRs, and
closing issues according to repository policy.

## 10. Workspace and Git Behavior

Symphonika has first-class Git workspace preparation for GitHub Projects.

Recommended layout:

```text
<workspace.root>/
  .cache/
    repo.git
  issues/
    <issue-number>-<slug>/
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
codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server
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
- fail the attempt
- add `sym:failed`
- preserve logs and workspace

The prompt preamble should minimize these cases by telling agents not to ask for operator input.

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
- `input_required`
- `failed`
- `succeeded`
- `cancelled`
- `stale`

Terminal run state does not necessarily match GitHub issue state.

### 12.1 Success

On provider success:

1. Mark run `succeeded`.
2. Remove `sym:running`.
3. Re-check GitHub issue.
4. If the issue remains eligible, schedule a short continuation.
5. If the continuation cap is reached, mark `sym:failed` and surface the reason.

Default continuation delay: about 1 second.

Default continuation cap: `3`.

### 12.2 Failure

Retry only transient infrastructure or provider failures.

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

## 13. CLI

Bootstrap CLI commands:

- `symphonika doctor --config <path>`
- `symphonika init-project <name> --config <path>`
- `symphonika daemon --config <path> [--port <port>]`
- `symphonika status --config <path>`
- `symphonika runs --config <path>`
- `symphonika show-run <run-id> --config <path>`
- `symphonika cancel <run-id> --config <path>`
- `symphonika clear-stale <project> <issue-number> --config <path>`

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

`init-project` creates missing operational labels only after explicit confirmation.

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

The only v1 mutating web action is explicit active-run cancellation.

Label creation, stale-claim reset, and workspace cleanup remain CLI-only.

## 15. Bootstrap Acceptance Bar

The bootstrap slice is accepted when:

- tests pass
- lint passes
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
- PR detection
- first-class provider-neutral GitHub tools for agents
- distributed scheduling
- production packaging
