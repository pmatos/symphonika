# Symphonika Specification

Status: Draft v0, bootstrap-oriented

Symphonika is a fresh TypeScript/Node orchestrator for turning GitHub issues into autonomous,
full-permission coding-agent runs. It is inspired by the upstream Symphony specification in
`symphony/SPEC.md`, but this document is the implementation contract for Symphonika.

## 1. Purpose

Symphonika runs as a local daemon. It reads eligible GitHub issues from one or more configured
Projects, creates deterministic Git workspaces and branches, launches Codex, Claude, or Oh My Pi
agents inside those workspaces, and records enough evidence to debug and continue the work.

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

A Project is a Symphonika-managed work source. A Project declares a `mode` of `"dispatch"` (the
default when omitted) or `"routine_host"`. The schema branches on `mode`, not on the presence of
other keys, so forgetting to configure a tracker stays a validation error rather than silently
becoming a non-dispatching Project. See ADR 0062.

A **Dispatch Project** (`mode: "dispatch"` or omitted) has:

- a name
- GitHub tracker configuration
- issue eligibility filters
- priority label mapping
- workflow contract path
- workspace settings
- agent-provider settings

A **Routine Host** (`mode: "routine_host"`) is a Project that is never polled for issues and exists
only to give Routine Firings a repository and a workspace. It has:

- a name
- workspace settings
- agent-provider settings
- optional GitHub tracker configuration — **required unconditionally when any routine targeting
  this host is `kind: git`**, regardless of whether the operator wants PR discovery. A `kind: git`
  routine on a host with no `tracker` is a declaration-time validation error. See ADR 0062.

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
- it is not already running, claimed, failed, blocked, or stale according to the orchestrator

v1 uses labels only for blocking. Symphonika does not parse issue body text, task lists, GitHub
Projects fields, or linked PRs to infer blockers.

The configured `labels_all` values are Required Eligibility Labels. Every Required Eligibility
Label must exist in the Project repository before the Project can dispatch work. `doctor` reports
missing Required Eligibility Labels as validation errors, and `init-project` offers to create them
after confirmation (or creates them under `--yes`). They remain repository-owned workflow labels;
provisioning them does not make them Operational Labels or give the orchestrator authority to apply
them to issues.

### 4.4 Operational Labels

Symphonika owns this narrow GitHub label namespace:

- `sym:claimed`
- `sym:running`
- `sym:failed`
- `sym:blocked`
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
review feedback appears, and merges the PR when the configured policy says it is clear. Review
follow-up Runs are workflow-owned continuation work: they require the Issue to remain open, but
workflow-label drift does not cancel them.

### 4.10 Agent Provider

An Agent Provider is a normalized adapter that lets Symphonika run one coding-agent implementation.

v1 supports:

- Codex through JSON-RPC app-server mode
- Claude through `stream-json` CLI mode
- Oh My Pi through its native newline-delimited JSON RPC mode

### 4.11 Event Logs

Symphonika stores both:

- Provider Event Log: raw provider protocol stream for the run
- Normalized Event Log: provider-neutral events used by the orchestrator, UI, tests, and debugging

### 4.12 Routine

A Routine is a service-level scheduled prompt declaration that targets one declared Project by name
(Dispatch Project or Routine Host). Routines are declared in a top-level `routines:` block in
`symphonika.yml`, not under a Project; see §5.4. A Routine Host owns no routines — Routines point
*at* it. See ADR 0063.

Symphonika supports hand-authored Markdown routine files with YAML front matter:

- `name`
- exactly one schedule shape: `schedule.at` or `schedule.cron` with optional `schedule.tz`
- `kind: report` or `kind: git`
- optional `provider`
- optional `model` and `effort` provider settings
- optional `permission_mode: bypass`
- optional positive `timeout_minutes`
- optional `catch_up: fire_once_if_missed` (omitted means missed clock events are skipped)
- optional `allow_overlap: true` (omitted means overlapping firings are skipped)

Recurring schedules use five-field POSIX cron. They accept the `hourly`, `daily`, `weekly`,
`monthly`, and `yearly` aliases with or without an `@` prefix. `schedule.tz` defaults to `Etc/UTC`.
Aliases are expanded during validation without rewriting the declaration file.

The Markdown body is the routine prompt template. `name` must be safe as a single workspace path
segment because routine firing workspaces live under `<workspace.root>/routines/<name>/<firing-id>/`.
Routine names are globally unique across the `routines:` block. Routine states are `active`,
`expired`, and `inactive`. `inactive` means the Routine's target Project is disabled or omitted from
the current valid Service Config snapshot (ADR 0021 cascade); the row remains durable but is hidden
from default operator listings. Routine-level scheduling control also uses `disabled` and `invalid`
as defined in §8.5.

### 4.13 Routine Firing

A Routine Firing is one durable execution of a Routine. It records the Routine, its target Project,
provider, workspace path, prompt evidence, provider logs, terminal reason, lifecycle state, its
canonical Routine Outcome, and any pull requests discovered from a `kind: git` firing branch. The
Routine Outcome records `status`, `action`, `url`, `title`, `summary`, `verified`, and `source`
without replacing lifecycle state or terminal reason; see ADR 0068. Its trigger source is
`scheduled` or `manual`. A one-shot `schedule.at` Routine becomes `expired` after its scheduled
firing is claimed and must not fire again on daemon restart. A recurring Routine remains active and
advances to its next clock event after every scheduled firing. A manual firing does not consume a
scheduled clock event.

A Routine Firing with an effective `timeout_minutes` has an absolute wall-clock deadline beginning
when execution of the claimed firing starts. Exceeding it terminates the provider process tree and
records `state = failed` with `terminal_reason = "firing_timeout"`. This declared deadline is
independent of Watchdog progress-liveness: useful progress does not extend it.

A clock event skipped for catch-up policy, overlap, or a concurrency cap is not a Routine Firing:
no `routine_firings` row is created. The Routine instead records `last_attempted_at`,
`last_skip_reason`, and `last_skip_at`, together with rolling 24-hour counts for each skip reason.

### 4.14 Notification Sink

A Notification Sink is a transport-neutral delivery boundary for a rendered subject, plain-text
body, and HTML alternative. SMTP is the first sink. Routine Firing policy and rendering remain
outside the transport so later issue-Run and daemon-health notification sources can reuse it.

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

`symphonika init` initializes Symphonika's user Service Config independently of any repository. It
prompts for service-level state, polling, pull-request merge policy, and Codex/Claude/OMP commands,
writes `$XDG_CONFIG_HOME/symphonika/symphonika.yml` (or the home-directory fallback), and starts
with `projects: []`. `--yes` accepts every displayed default without prompting, and `--force` is
required to replace an existing user config.

`symphonika init-project` runs inside a Git repository with an `origin` remote and requires an
existing selected Service Config. It accepts `--mode <dispatch|routine-host>` (default `dispatch`).
In `dispatch` mode it derives repository defaults from `origin`, prompts for the Project name, Agent
Provider, base branch, issue-label filters, priority-label mapping, and Workflow Contract path, and
appends the Project without discarding unrelated Projects or hand-authored config. A duplicate
Project name is refused unless `--force`, which replaces only that sequence entry. The command
creates a starter Workflow Contract only when the selected path is absent, prints the created path
on success, and then creates missing Operational Labels and configured Required Eligibility Labels
in the newly registered repository. The starter contract is Markdown; the command refuses to
scaffold a selected path that resolves to the `raw_fsm` format (a `.yaml`, `.yml`, or `.json`
extension, or an explicit `format: raw_fsm`), since writing Markdown prose into a raw FSM file would
register a Project with a workflow contract that fails to parse. `--yes` accepts Project defaults
and performs label setup without prompting.

In `routine-host` mode `init-project` prompts only for the Project name, Agent Provider, base
branch, and workspace root; it does not prompt for issue-label filters, priority-label mapping, or a
Workflow Contract path, and it creates no Operational or Eligibility Labels. A `tracker` is added
only when the `origin` remote parses as github.com. See ADR 0062.

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

# Optional defaults inherited by Routine declarations. A front-matter value
# wins; if both are omitted, the provider command remains operator-authored.
routine_defaults:
  permission_mode: bypass
  timeout_minutes: 60

providers:
  codex:
    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"
  claude:
    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"
  omp:
    command: "omp --mode rpc --auto-approve"

projects:
  - name: symphonika
    mode: dispatch
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
  - name: new-composer-host
    mode: routine_host
    workspace:
      root: ./.symphonika/workspaces/new-composer
      git:
        remote: git@github.com:pmatos/music-timeline.git
        base_branch: main
    agent:
      provider: claude

routines:
  - project: new-composer-host
    path: ./daily-report.md
```

The bootstrap slice must use this final multi-project shape even with one configured Project. The
intermediate global config written before the first `init-project` invocation intentionally has an
empty `projects` sequence and is not daemon-ready until a Project is registered.

Each Project declares a `mode` of `"dispatch"` (the default when omitted) or `"routine_host"`. A
Dispatch Project requires `tracker`, `issue_filters`, `priority`, `workflow`, `workspace`, and
`agent`; it is polled for issues and its dispatch validity gates on repo access and Operational /
Eligibility Labels. A Routine Host requires only `name`, `workspace`, `agent`, and `mode`; it is
never polled for issues and exists only to host Routine Firings. A Routine Host must declare
`tracker` when any routine targeting it is `kind: git` — a `kind: git` routine on a tracker-less
host is a declaration-time validation error. See ADR 0062. `symphonika init-project --mode
routine-host` scaffolds a host without issue-filter, priority, or label-creation prompts.

A Project may override only `watchdog.grace_minutes` with a positive integer. It inherits
`watchdog.enabled`, `watchdog.sample_interval_seconds`, and `watchdog.mtime_ignore` from daemon
scope, so a Project can lengthen its grace window but cannot opt into a daemon-disabled Watchdog.
Project overrides are part of the defensive Service Config reload snapshot: any invalid value or
unknown key rejects the candidate snapshot for all Projects and leaves the last known-good snapshot
live.

### 5.2 Workflow Contract

Each Dispatch Project must reference a valid `WORKFLOW.md`. A Routine Host has no workflow contract.

`WORKFLOW.md` is reloadable and repository-owned. It contains the prompt body and may contain
optional YAML front matter for prompt-adjacent execution policy.

Markdown Workflow Contract front matter may declare repository-owned Watchdog evidence noise as
workspace-relative directory paths:

```yaml
---
evidence:
  ignore:
    - vendor/
    - out/
---
```

Each `evidence.ignore` entry must be a non-empty string, must not start with `/`, and must not
contain `..`. The list is additive to the Watchdog's built-in directory excludes; it cannot disable
them. Invalid entries make the Workflow Contract invalid through the normal doctor and defensive
reload surfaces. Unlike the rendered prompt captured for an attempt, the current valid
`evidence.ignore` policy is resolved for active Runs on every Watchdog reconciliation tick.

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

The daemon must not dispatch a Dispatch Project when its workflow contract is missing or invalid. A
Routine Host is never dispatched, so this gate does not apply to it.

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
preamble, plus a provider-neutral notice that each firing is one-shot, will not be re-invoked, and
must not schedule background work or depend on a later wake-up. For every Routine kind, available
top-level objects are:

- `project`
- `workspace`
- `provider`
- `routine`
- `firing`

`kind: git` additionally exposes `branch.name` and `branch.ref`. `branch` is unavailable to
`kind: report`; `issue` and `run` are unavailable to every Routine kind. Referencing an unavailable
object fails rendering with terminal reason `prompt_render_error`.

Every rendered Routine prompt also requires a final JSON Routine Outcome Claim with
`status`, `action`, `url`, `title`, and `summary`. This prompt-level contract applies to every
provider. Claude additionally receives the same JSON Schema through `--json-schema`, but the
provider-specific flag is reinforcement rather than the parsing mechanism. A missing, non-JSON, or
schema-invalid final claim does not fail the firing.

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

The service config defines a top-level `routines:` sequence. Each entry is an object with a required
`project: <name>` target naming a declared Project (Dispatch Project or Routine Host) and a `path:`
pointing at a hand-authored Markdown routine file. Paths are resolved relative to the service config
directory and are re-read on every daemon tick with the rest of the runtime snapshot. Routine names
are globally unique across the `routines:` block. The per-Project `routines:` key is not supported;
routines point at Projects by name rather than being owned by them. See ADR 0063.

Invalid routine declarations are reported through the same reload-error surface as invalid workflow
contracts. Unlike a workflow contract or Project-detail error, an invalid routine declaration does
not revert the whole daemon's config to its last known good snapshot: only that routine falls back
to its own last known good declaration (matched by file path), keeping sibling routines, sibling
Projects, and the Workflow Contract on the current reload. A routine with no prior valid declaration
to fall back to is `state = invalid` until fixed; see §8.4.

Routine schedules must define exactly one of:

- `{ at: <ISO 8601 timestamp> }`
- `{ cron: <five-field POSIX cron or supported alias>, tz?: <IANA timezone> }`

Supplying both shapes, neither shape, an invalid cron expression, or an invalid timezone is a
deterministic declaration-load error. `tz` is valid only with `cron` and defaults to `Etc/UTC`.
`catch_up`, when present, must be `fire_once_if_missed`; `allow_overlap`, when present, must be a
boolean. Their omitted defaults are missed-event skip and `false`, respectively. `disabled`, when
present, must be a boolean; omitted defaults to `false`. `disabled: true` stops future scheduling
for that routine on the next reload without affecting an in-flight firing; see §8.4.

`model` and `effort`, when present, must be non-empty strings. `permission_mode`, when present, must
be `bypass`, preserving the Full-Permission Agent Execution invariant. `timeout_minutes`, when
present, must be a finite positive number. Invalid values are deterministic declaration-load
errors and use the same per-Routine last-known-good reload path as an invalid cron expression.

The Service Config may declare the same optional fields in a top-level `routine_defaults:` mapping.
Resolution is front matter, then `routine_defaults`, then no override: when neither level supplies a
value, Symphonika leaves that aspect of the provider command as authored. Defaults are validated as
Service Config; an invalid defaults mapping rejects the candidate snapshot through the normal
Service Config last-known-good path.

### 5.5 Email Notifications

The optional service-level `email:` block configures SMTP delivery for terminal Routine Firings:

```yaml
email:
  from: "symphonika@example.com"
  to: "operator@example.com"
  on: changes
  smtp_host: "smtp.postmarkapp.com"
  smtp_security: starttls
  smtp_port: 587
  smtp_username: "<postmark-server-token>"
  smtp_password_env: "SYMPHONIKA_SMTP_PASSWORD"
```

`from`, `to`, and `smtp_host` are required when the block is present. `on` is `always`, `changes`,
or `failures` and defaults to `always`. `smtp_security` is `starttls`, `ssl`, or `none` and defaults
to `starttls`; an omitted `smtp_port` defaults respectively to 587, 465, or 25.
`smtp_password_env` names an environment variable and defaults to
`SYMPHONIKA_SMTP_PASSWORD`.

An SMTP username over `smtp_security: none` is invalid unless the host is loopback (`localhost`,
`127.0.0.1`, or `::1`). Project-level email overrides are not supported. Routine front matter may
set `notify: false` to opt out entirely; omission defaults to enabled.

For terminal Routine Firings, `always` sends every outcome, including cancellation. `changes` sends
non-empty `kind: report` provider message output and succeeded `kind: git` firings (whose success
already proves commits ahead of base). `failures` sends only `state = failed`, not cancellation.
See ADR 0067.

## 6. Credentials

GitHub credentials are environment-backed.

- Default token environment variable: `GITHUB_TOKEN`
- Service config may reference another variable with `$VAR_NAME`
- Literal tokens should not be stored in YAML
- Tokens must not be stored in SQLite
- Token-like values must be redacted from logs

SMTP passwords are also environment-backed. Service Config stores only `email.smtp_password_env`,
never a literal password. The named variable is resolved only for SMTP authentication and its value
must not be written to SQLite, logs, rendered notification content, or prompt evidence. SMTP
transport errors are redacted before logging or durable failure recording.

Codex, Claude, and OMP use their native local authentication.

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

Project repositories do not need a deploy-local state directory when using the initialized user
config; state and workspaces live under the user state root. Repositories that carry their own
project-local `symphonika.yml` should gitignore `.symphonika/`.

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
- canonical Routine Outcomes for terminal firings
- Routine Notification Delivery state and sanitized delivery error
- exact-timestamp Routine skip counters used to compute rolling 24-hour per-reason totals

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

Routine rows for Projects disabled or omitted from the current valid Service Config snapshot are
marked `inactive` and pruned from default operator listings on reload. Historical `routine_firings`
rows and `last_fired_at` remain durable Run Store evidence. Re-enabling a Project restores its
configured Routines to `active` or `expired` without re-firing an already-fired one-shot. A one-shot
Routine whose `at` elapsed while its Project was disabled and that never fired is restored to
`expired`, not `active`, on re-enable — it does not fire retroactively, mirroring the same guarantee
a routine-level `disabled` restore gives (§8.5).

`inactive` is a Project-cascade state and is distinct from a Routine's own `disabled` or `invalid`
state (§8.5): a Routine can be `disabled` while its Project stays fully enabled, and `disabled`
routines are shown in default operator listings — with their `disabled_reason` — unlike `inactive`
ones.

### 8.5 Routines

On each daemon tick, Symphonika evaluates loaded active Routines. `ScheduleEvaluator` supports:

- `wait_until` when `now < at`
- `fire_now` when `now >= at` and the Routine has not fired
- `expired` after a firing exists or the Routine state is `expired`
- recurring five-field cron evaluated in the Routine's IANA timezone, returning the next fire time
  strictly after `now`

When a Routine fires, Symphonika allocates a ULID firing id and prepares a workspace at
`<workspace.root>/routines/<routine-name>/<firing-id>/`. A `kind: report` workspace is detached at
the Project base branch. A `kind: git` workspace is checked out on
`sym/<project>/routine/<routine-name>/<first-10-firing-id-chars>`, created from the Project base.
Symphonika renders the routine prompt, runs the configured provider, and records a `routine_firings`
row. One-shot Routines become `expired`; recurring Routines remain active and atomically advance
`next_fire_at` before the provider executes, so successful and failed firings both leave the next
clock event visible. Routine Firings use states `queued`, `preparing_workspace`, `running`,
`succeeded`, `failed`, and `cancelled`.

When `timeout_minutes` is effective, one absolute deadline bounds how long the dispatcher waits
on workspace preparation, provider validation, provider streaming, and terminal outcome
classification, and completes the firing as `failed` with `terminal_reason = "firing_timeout"`
rather than classifying the cancellation-produced exit event as `process_exit_*` or `cancelled`.
Once a provider process exists, expiry invokes the provider's cancellation path, which stops the
full process group (ADR 0064 / #341) and preserves workspace and logs. Expiry during workspace
preparation does not cancel the in-flight `git` subprocesses: the dispatcher stops waiting on
`prepareRoutineWorkspace`, but the abandoned clone/fetch keeps running and can delay a later
firing that shares the same per-project repository cache (tracked in #353).

For `kind: report`, provider exit code 0 succeeds without requiring commits. For `kind: git`, exit
code 0 applies the same commits-ahead-of-base inspection as §12.1: zero commits fails with
`no_workspace_changes`, inspection failure fails with `workspace_inspection_failed`, and one or
more commits succeeds. On the succeeded transition, Symphonika lists every open pull request whose
head is the firing branch and records its PR number and head SHA. Routine PR discovery is
informational only: it never enters PR Follow-up, review re-dispatch, or auto-merge.

The dispatcher asks every provider for the same Routine Outcome Claim
`{status, action, url, title, summary}` and parses it only from the final normalized
`turn_completed` event. When tracker configuration and GitHub reads are available, it snapshots
repository issues before and after provider execution, bounded to a window sized for a single firing
rather than the repository's full history; `kind: git` firings also snapshot open pull requests on
the firing branch. It observes newly opened pull requests, newly opened issues, and issues that
change to closed, using each issue's own creation/closure timestamp — not mere absence from the
bounded before-snapshot — to tell an issue created or closed inside the window apart from a
pre-existing issue merely touched inside it. Issue and pull-request entries are distinguished before
diffing. A comparison is complete only when every channel relevant to the routine's kind succeeded
on both reads (issues alone for a report routine; issues and pull requests for a `kind: git`
routine), so a silently failed channel is never mistaken for "checked and found nothing changed". A
tracker-less Project skips GitHub observation with an informational log line; unavailable or failed
optional observation is also non-fatal.

One pure reconciliation step persists a canonical result with `verified` and `source`. An observed
GitHub action wins over an absent, error, no-action, or commit claim and is sourced to `gh`. A
claimed PR or issue action is verified only when the same action kind was observed; an unobserved
claim is retained but marked unverified. A claimed no-action (`none`) is verified only when the
before/after GitHub comparison completed and found nothing; an unavailable comparison leaves it
unverified. A successful `kind: git` firing with commits ahead of base can verify or derive a
`commit` outcome regardless of the claim's own reported status, and this git evidence overrides a
`none` claim that under-reports it so a self-reported "nothing to do" or "error" never suppresses
the retention signal below. A successful firing with neither claim nor observation records
`no_action`; it is verified and sourced to `gh` only when the before/after GitHub reads completed,
otherwise it is unverified and sourced to `symphonika`. Omission alone is not a failure. Failed and
cancelled firings retain their terminal reason independently of the reconciled outcome.

Under ADR 0025 a verified commit-only outcome remains successful because its workspace is
preserved. Such an outcome is a retention signal: future workspace garbage collection must retain
the workspace, first establish that the commit was published to durable remote state, or require an
explicit destructive operator override. It must not silently delete the only copy.

After a Routine Firing reaches a terminal state, Symphonika evaluates its Routine notification
policy. Delivery occurs after `kind: git` PR discovery, uses both plain text and an escaped HTML
alternative, and includes the canonical outcome as one ptt-style line with action, title, URL, and
an unverified marker when applicable. The final claim JSON is excluded from report-output content.
Delivery gets two total attempts within one 30-second orchestration deadline and runs after the
firing releases its concurrency slot. Delivery failure or timeout never changes the firing state:
`notification_state = failed` and the final sanitized `notification_error` remain durable. Policy
or `notify: false` suppression records `notification_state = skipped`; success records `sent`.

On daemon startup, a recurring Routine with `catch_up: fire_once_if_missed` preserves a due
`next_fire_at` and fires at most once even when the outage spans several clock events. The claim
then advances `next_fire_at` strictly beyond the current clock. Without the opt-in, startup advances
past the missed window without firing and records a `catch_up_window` skip. Timezone and DST
behavior comes from `cron-parser`; the Orchestrator does not implement separate DST rules.

Routine Firings consume the same per-Project and global `max_in_flight` slots as issue Runs. If a
cap is already full, the daemon records a `concurrency_cap` skip. If an earlier firing of the same
Routine remains non-terminal, the daemon records an `overlap` skip unless `allow_overlap: true` is
configured; overlap opt-in does not bypass concurrency caps. Every skip atomically advances the
clock event, updates the Routine's latest-attempt/skip fields and rolling counter evidence, writes no
Routine Firing row, and emits `routine.skipped` with `reason`, `routine`, and `scheduled_at` fields.

`symphonika fire-now <routine>` asks the daemon to claim a manual Routine Firing even when the
Routine is not due. The manual claim records `trigger_source = "manual"` and otherwise uses the
normal Routine Firing workspace, provider, evidence, cancellation, overlap, and concurrency paths.
It does not update the Routine's `next_fire_at`, `last_fired_at`, `last_attempted_at`, or state, so a
future one-shot or recurring clock event still fires normally. A manual overlap or cap refusal
creates neither a firing row nor Routine Skip evidence because it did not attempt a clock event.

Manual firing accepts active Routines. It refuses `inactive`, `invalid`, and `expired` Routines with
their specific state. It also refuses `disabled` by default; `--force` overrides only a
`disabled_reason = "operator"` Routine declared with `disabled: true`, not a removed declaration or
a tracker-less-host rejection. Ambiguous names return every Project/Routine candidate and require
`--project`. `--wait` blocks on the accepted firing id until terminal and exits non-zero for
`failed` or `cancelled`.

`symphonika cancel <id>` accepts a `run_id` or a Routine Firing id. A non-terminal Routine Firing
transitions to `cancelled` with `cancel_reason = "operator"`; the provider process is killed and the
workspace and logs are preserved, matching issue Run cancellation. Cancelling an unknown id or a
Routine Firing already in a terminal state (`succeeded`, `failed`, `cancelled`) returns a clear
error and makes no state change.

Graceful daemon shutdown cancels every in-flight Routine Firing through the same provider
cancellation path before waiting for dispatch work to drain, recording
`cancel_reason = "daemon_shutdown"`. This is distinct from disabling or removing a Routine while
the daemon remains active, which does not cancel its in-flight firing.

A Routine with `disabled: true` in its own front matter transitions to `state = disabled`,
`disabled_reason = "operator"` on the next reload; future scheduling stops but an in-flight firing
continues to completion under the snapshot it started with — the daemon never cancels it as a side
effect of the routine becoming disabled. Removing a Routine's entry from the top-level `routines:`
block (or its target Project) has the same in-flight-continues behavior, with `disabled_reason =
"removed_from_config"`. Restoring a Routine — removing `disabled: true` or re-adding its entry —
un-disables it on the next reload and recomputes `next_fire_at` strictly after the current clock; a
one-shot Routine whose `at` elapsed while disabled is marked `expired` instead of firing
retroactively. `catch_up: fire_once_if_missed` does not apply to a routine-level restore — that
policy is for daemon outage, not deliberate operator disable.

A previously persisted `kind: git` Routine rejected because its Routine Host has no tracker is
soft-disabled with `disabled_reason = "rejected_tracker_less_host"`. This is distinct from
`removed_from_config`: the top-level entry is still present but is incompatible with its target
host. The rejected name must not be folded into the declaration-loader's `invalidRoutineNames`
protection, because a protected, undeclared persisted row is skipped by both removal detection and
the valid-declaration upsert and could remain active. A first-appearance rejection persists the
Routine with its declared schedule and prompt: as `disabled` with the same reason while its host is
enabled, or as `inactive` when the Project-level disable cascade takes precedence. Restoring the
host's tracker therefore returns the Routine to the normal upsert path and the existing restore
rules above in every case: a recurring Routine reactivates, while an elapsed one-shot is marked
`expired` instead of firing retroactively — even when its schedule was edited while rejected or
inactive. See ADR 0066.

An invalid Routine declaration on reload does not abort reload for the rest of the fleet (§5.4): the
daemon logs the error and surfaces it in the operator status surface and `doctor`. A Routine with a
prior valid declaration keeps firing on it unchanged; its `state` does not transition away from that
last known good value. A Routine with no prior valid declaration — a newly added file, invalid from
the start — is `state = invalid` and does not fire until a valid reload succeeds. A declaration with
no parseable `name` field cannot be represented as a `routines` row at all (the table's primary key
is `(project_name, name)`) and is reported only through the reload-error and `doctor` surfaces.

## 9. GitHub Tracker Behavior

### 9.1 Required Operations

The GitHub tracker adapter supports:

- validating repository access
- validating operational labels
- validating configured Required Eligibility Labels
- creating operational labels after explicit confirmation
- creating configured Required Eligibility Labels after explicit confirmation
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

On blocked deterministic terminal state (see §12.1, ADR 0058):

- remove `sym:running`
- add `sym:blocked`
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
  name: "codex" | "claude" | "omp";
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
The final `turn_completed` event may include provider-neutral final-result text and structured
output used to parse a Routine Outcome Claim. Provider-specific event shapes do not escape the
adapter.

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

Default Oh My Pi command:

```text
omp --mode rpc --auto-approve
```

The OMP adapter requires RPC mode and full-permission operation through `--auto-approve` or
`--approval-mode yolo`. It validates the versioned ready frame with a bounded startup probe and
negotiates protocol v2 chunking when the installed OMP advertises it. See ADR-0066.

Provider commands may be overridden, but the replacement command must speak the provider adapter's
expected protocol.

Routine model and effort overrides use append-at-spawn delivery owned by each adapter; the persisted
operator command is not rewritten. Claude appends `--model` / `--effort`; Codex inserts
`-c model=...` / `-c model_reasoning_effort=...` before `app-server`; OMP appends `--model` /
`--thinking`. `permission_mode: bypass` maps to Claude's
`--dangerously-skip-permissions`; Codex and OMP retain their already-validated full-permission
startup posture. Claude Routine Firings additionally append
`--disallowedTools ScheduleWakeup Monitor CronCreate` and set
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the child environment.

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
- `blocked` (non-actionable no-op or FSM-declared block — see below; distinct from `failed`, which
  is reserved for outcomes that indicate something actually broke)
- `succeeded`
- `cancelled`
- `stale`
- `waiting`

Terminal run state does not necessarily match GitHub issue state.

### 12.1 Success

On provider exit code 0:

1. Inspect the Workspace issue branch against
   `refs/remotes/origin/<configured-base-branch>..HEAD`.
2. If the branch has zero commits ahead of base, mark the run `blocked` with deterministic terminal
   reason `no_workspace_changes` and add `sym:blocked`. This covers the agent correctly declining
   the task (e.g. the target was already superseded) — exit 0, zero commits, nothing broken.
3. If Workspace inspection fails, mark the run `failed` with deterministic terminal reason
   `workspace_inspection_failed` and add `sym:failed`. This is a real failure (the `git` inspection
   command itself errored), unlike case 2.
4. If the branch is ahead of base, mark run `succeeded`.
5. Remove `sym:running`.
6. Re-check GitHub issue.
7. If the issue remains eligible, schedule a short continuation.
8. If the continuation cap is reached, mark `sym:failed` and surface the reason.

For raw FSM workflows, a state whose `terminal` is `blocked` (§12.2) produces RunState `blocked` and
`sym:blocked`, mirroring case 2 above; a state whose `terminal` is `failure` produces RunState
`failed` and `sym:failed`, mirroring case 3. See ADR 0058.

Default continuation delay: about 1 second.

Default continuation cap: `3`.

### 12.2 Failure

Retry only transient infrastructure or provider failures.

For raw FSM workflows, retryable transient failures consume the retry budget before non-terminal
FSM transitions matching the failure signals are allowed to advance or park the workflow. The retry
re-enters the same FSM state and preserves the state-advance label-immunity bit when the failed run
was already mid-walk. Terminal `failure` / `blocked` transitions remain workflow-authored
deterministic verdicts and pre-empt retry — `failure` maps to RunState `failed` (`sym:failed`),
`blocked` maps to RunState `blocked` (`sym:blocked`). After the retry budget is exhausted, the final
attempt's signals are evaluated normally by the FSM; if no workflow transition handles them, the run
follows the exhausted-retry failure path below.

Default retry policy:

- retry cap: `3`
- delays: about `10s`, `30s`, `2m`
- maximum backoff: `5m`

Do not automatically retry these deterministic terminal outcomes:

- prompt render error (`failed`)
- invalid config (`failed`)
- missing workflow (`failed`)
- input required (`failed`)
- continuation cap reached (`failed`)
- no workspace commits ahead of base after provider exit code 0 (`blocked` — see §12.1)
- workspace success inspection failure (`failed`)
- workspace branch conflict (`failed`)
- Project validation failure (`failed`)

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
- the daemon begins graceful shutdown

Cancellation preserves workspace and logs.

On graceful shutdown, the daemon first closes the active-run registry to new claims
synchronously, before snapshotting active runs, so a dispatch still in pre-claim work can never
reserve a slot after cancellation begins; a claim that raced the gate is rolled back to
`cancel_reason = "daemon_shutdown"`, and later claims are skipped, not rescheduled. The daemon
then cancels queued or delayed work, records `cancel_reason = "daemon_shutdown"` for every
currently in-flight Run and Routine Firing, and requests cancellation through each live Agent
Provider. The shutdown reason supersedes any cancellation already in progress and is
sticky in the run store: later cancellation writes — from an in-flight reconcile or a UI
cancel landing during the drain — cannot overwrite `daemon_shutdown` with another reason.
Delayed-work registration closes with cancellation: the scheduler refuses timers armed after
that point, so nothing fires against a store that is closing. A Run that was about to park
into a wait state when cancellation latched is classified `cancelled` instead of flipping to
`waiting`, and an in-flight wait re-evaluation stops before mutating rows — durable waiting
rows are left untouched for the next daemon's reconciliation. Only after those requests have
been awaited does it wait for in-flight dispatches to unwind. This explicit
shutdown path is required because provider processes may run in a cgroup outside the daemon's
own process tree (ADR 0064).

### 12.4 Watchdog

The Watchdog detects active provider runs that have stopped doing observable work. It samples rows
in `state = "running"` only — the one active state with a live Agent Provider that can wedge. Rows
in `queued` and `preparing_workspace` have no provider executing yet, so they have no liveness
signal to advance and must not accrue idle time; rows in `state = "waiting"` are reconciled by the
wait-state path. A `running` Run that already carries `cancel_requested` is also skipped, so the
Watchdog does not overwrite a more specific in-flight cancellation with `no_progress`.

For each sampled Run, Symphonika records one durable latest `watchdog_samples` row keyed by
`run_id` and an append-only `watchdog_sample_history` row keyed by `(run_id, sampled_at)`. Both
contain `sampled_at`, `last_tool_call_at`, `last_message_at`, `workspace_mtime_max`,
`turn_id_set_size`, `output_tokens_total`, `normalized_log_offset`, `normalized_log_path`, and
`idle_since`. The latest row keeps reconciliation reads bounded; the history supports operator
rolling-window calculations. In particular, `show-run` computes output-token growth over the final
sample's five-minute window by walking persisted cumulative totals (and treating a normalized-log
path change as a counter reset), never by re-scanning the Normalized Event Log. `idle_since`
survives daemon restart, so a Run that was already observed idle resumes its grace window from the
first idle observation rather than from process boot. It is cleared on entry to `waiting` (so an
unsampled wait excursion does not accrue idle time) and reset on attempt change (so a transient
retry, which re-enters a running agent state, starts a fresh grace window).

Sampling reads the Normalized Event Log only forward of the stored byte offset and walks the
Workspace tree once. A transient retry writes a new per-attempt log path, so the byte offset and the
output-token baseline are reset whenever `normalized_log_path` changes and the new attempt's events
are read from the start. The hard-coded v1 exclude set is `.git/`, `target/`, and `node_modules/`,
skipped at the directory-entry level and not descended. The current per-Project Workflow Contract's
`evidence.ignore` list adds workspace-relative directory trees that are also skipped before descent;
the hard-coded set always remains active. Separately, `watchdog.mtime_ignore` adds workspace-relative
globs whose matching files are dropped from the mtime walk at the individual-file level, so
build-output churn (e.g. `*.log`) cannot keep a wedged Run alive.

A sampled Run is making progress when any one signal advances since the previous sample:

- `last_tool_call_at` increases
- `workspace_mtime_max` advances by at least one second
- `turn_id_set_size` increases (only the Codex provider tags events with a `turnId`; Claude and OMP
  emit session-level identity without a stable turn id, so this signal advances for Codex Runs)
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

Review follow-up Runs ignore `labels_all` and `labels_none` from the moment their in-flight slot is
reserved, including workspace preparation and provider validation. Issue closure and operator
cancellation still cancel them. Fresh dispatches and ordinary label-controlled Continuations keep
their existing label eligibility checks.

Every successful tracked-PR observation durably records whether the PR is open, still has unresolved
review feedback, and has exhausted the configured review-dispatch cap. A transient observation
failure preserves the prior value. Resolved feedback, a raised cap, PR closure, or PR merge clears
the value on the next successful observation. Cap exhaustion does not fail or cancel a parked
workflow Run: the Run stays `waiting` for human action or a later observation.

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
   parked (`stay_waiting`); reconciliation will re-evaluate it on the next tick. If unresolved
   review feedback has exhausted the PR Follow-up dispatch cap, the Run remains parked and its
   detail surfaces identify the tracked PR and require manual attention.
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

- `symphonika init [--yes] [--force]`
- `symphonika add-routine <name> --project <project> (--schedule <expr> | --at <iso8601>) --kind <git|report> [--provider <codex|claude|omp>] [--tz <iana>] [--config <path>]`
- `symphonika doctor [--config <path>]`
- `symphonika test-email [--config <path>]`
- `symphonika init-project [--config <path>] [--yes] [--force]`
- `symphonika daemon [--config <path>] [--port <port>]`
- `symphonika service install [--config <path>] [--force] [--print] [--no-reload]`
- `symphonika status [--config <path>] [--dashboard] [--watch] [--interval-ms <ms>] [--doctor-ttl-ms <ms>]`
- `symphonika poll-now [--config <path>]`
- `symphonika fire-now <routine> [--project <project>] [--force] [--wait] [--config <path>]`
- `symphonika runs [--config <path>]`
- `symphonika routines [--config <path>] [--project <project>] [--include-inactive]`
- `symphonika show-run <run-id> [--config <path>]`
- `symphonika cancel <run-id> [--config <path>]`
- `symphonika clear-stale <project> <issue-number> [--config <path>] --yes`

When neither a project-local config nor a user config exists, `doctor` reports the missing user
config path and points the operator to `symphonika init`.

`doctor` validates:

- config parse
- Project shape, including the declared `mode`
- Dispatch Projects: GitHub auth, repository access, Operational Labels, and Required Eligibility
  Labels (`issue_filters.labels_all`)
- Routine Hosts: provider command + adapter + workspace resolvable (no GitHub access, no label
  checks); `validForHosting` rather than `validForDispatch`
- provider commands for Codex, Claude, and OMP when selected by a Project or Routine
- Dispatch Projects: workflow contract path and parse
- every Routine declaration in the top-level `routines:` block, including unknown target Projects,
  a target Project name declared more than once, globally duplicate Routine names, and `kind: git`
  routines targeting a tracker-less Routine Host
- database path
- workspace root
- SMTP password environment-variable availability when authenticated email is configured

`init` writes only the user Service Config and never inspects or mutates a repository or GitHub.

`init-project` registers the current repository. In `dispatch` mode it creates a missing starter
Workflow Contract and creates missing Operational Labels and configured Required Eligibility Labels
after the interactive review or explicit `--yes` selection. In `routine-host` mode it creates no
Workflow Contract and no labels. See §5.1 and ADR 0062.

`add-routine` writes `<cwd>/routines/<name>.md` with validated YAML front matter and a placeholder
prompt, then registers the declaration as a top-level `routines:` block entry targeting the named
Project. It preserves the Service Config's YAML comments and key ordering where supported by the
YAML document parser, refuses missing Projects, unsafe names, duplicate names, invalid schedules,
and existing target files, and never contacts GitHub or triggers a daemon reload. An unrelated
existing Routine declaration that cannot be loaded does not block registration. If the loader can
recover a path-safe name from an otherwise-invalid declaration, that name still participates in the
duplicate-name check; declarations whose names cannot be recovered remain visible through `doctor`.
When the generated file is outside the Service Config directory, registration uses its absolute
path; otherwise it uses a `./`-prefixed path relative to the Service Config.

`service install --config <path>` resolves the selected Service Config to an absolute path and
bakes it into the generated unit as `daemon --config <absolute-path>`. Omitting `--config` keeps the
unit on the daemon's normal project-local/user-config discovery path.

`status --dashboard` renders a compact terminal status dashboard from the run store and daemon
`/api/status` endpoint. `status --watch` refreshes that read-only dashboard in place; it must not
dispatch work or mutate GitHub state. Watch mode refreshes daemon status and run-store data every
frame, but caches the full `doctor` validation path for 5000 ms by default so passive dashboards do
not continuously re-run provider probes or GitHub validation reads. `--doctor-ttl-ms 0` disables that
cache when an operator explicitly wants every frame to perform full validation.

`show-run` renders the latest persisted Watchdog Progress Signal, including tool-call and workspace
mtime ages, observed turn-id count, five-minute output-token growth, and `idle_since` plus effective
grace remaining when idle. `status` and its dashboard render an idle indicator only for active Runs
whose latest sample has `idle_since` set.

`routines` lists Routine status per Project with `state`, `next_fire_at`, `last_fired_at`,
`last_attempted_at`, `last_skip_reason`, `last_skip_at`, rolling 24-hour skip counts per reason, and
the latest canonical Routine Outcome plus PR numbers discovered for the latest firing. Outcome
rendering includes action, title, URL, and an `(unverified)` marker when applicable. Inactive
Routines are hidden by default; `--include-inactive` includes them.

`clear-stale` removes `sym:stale`, `sym:claimed`, and `sym:running` only after explicit confirmation.

`test-email` renders a representative fake Routine Firing and sends it through the configured
renderer, retry policy, and SMTP sink. It forces delivery regardless of `email.on`, reports the
configured recipient on success, and reports the final sanitized SMTP failure on error.

## 14. Local Web UI and API

v1 ships a local HTTP API and server-rendered operator pages.

Default bind host: `127.0.0.1`.

Richer visual design of these server-rendered pages is part of the v1 bootstrap scope. It may
include a cohesive design system, system-adaptive light and dark themes, responsive layouts,
accessibility-focused styling, and a self-hosted webfont pipeline. This presentation scope does not
create a separate frontend application or client build, and it does not broaden the web surface's
allowed mutations. `PRODUCT.md` and `DESIGN.md` record the product and design-system contract; see
ADR-0057 for the scope decision.

The UI is primarily read-only. It shows:

- Projects
- validation state
- eligible/running/failed/stale issues
- runs and attempts
- normalized events
- raw log links or content
- rendered prompt links
- retry and continuation state
- routines with firing/attempt timestamps, latest Routine Outcome, latest skip evidence, rolling
  24-hour skip counts, and discovered PR numbers
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

The v1 mutating local HTTP API actions are explicit active-run cancellation, a manual poll-now
trigger that uses the normal daemon scheduler path, and daemon-owned manual Routine firing. The
server-rendered dashboard exposes only cancellation and poll-now controls; manual Routine firing is
a CLI/API action (ADR 0067).

The HTTP API exposes `GET /api/routines` with the same Routine status shape as the CLI and
dashboard, including `latestOutcome`, latest-attempt/skip fields, and per-reason `skipCounts24h`.
Inactive Routines are hidden by default; `?include_inactive=true` includes them, and the
server-rendered dashboard accepts the same query parameter. `GET /api/routines/:id/firings` returns
firing history with each canonical `outcome`, linked PRs, and `notificationState` /
`notificationError` delivery evidence for the named Routine; callers use `?project=<name>` to
disambiguate the same Routine name across Projects and `?include_inactive=true` to resolve an
inactive Routine and reach its durable firing history.

`POST /api/routines/:id/fire` claims a manual Routine Firing. The optional `project` query
parameter disambiguates a target and `force=true` applies the narrow disabled-Routine override from
§8.5. An accepted request returns HTTP 202 with the queued firing id. State, overlap, cap,
ambiguity, and availability refusals return a specific error without advancing the Routine clock.

`GET /api/runs/:id` exposes the latest sample as a camel-cased top-level `watchdog` object, including
the effective `graceMs` and server-computed `graceRemainingMs`. `GET /api/status` adds a `watchdog`
object to each active Run with `idleSince` and `graceRemainingMs` when idle. When the effective
Watchdog policy is disabled, both endpoints return exactly `{ "enabled": false }` for that object.

The server-rendered dashboard and `/runs` list surface the same idle/grace state as a small
"watchdog idle since X (Y remaining)" badge next to the state pill, shown only for active
(non-terminal) Runs with `idleSince` set. The Run-detail page gains a Watchdog section directly under
the run-state summary, rendering `last tool_call age`, `workspace mtime age`, `turn_ids observed`,
`output tokens / 5m`, and (when set) `idle_since` and `grace remaining` — the same fields `show-run`
exposes. For any Run not in the `running` state — a terminal state (including `terminal_reason =
"no_progress"`), `queued`, `preparing_workspace`, or `waiting` — all three Progress Signal surfaces
— `show-run`, `GET /api/runs/:id`, and the Run-detail page — compute ages and grace remaining
against the Run's last persisted watchdog sample rather than the live clock. A Run's watchdog sample
only ever advances while it is `running`, so a live clock against any other state's sample is a
misleading, ever-drifting countdown for data that no longer describes what the Run is currently
doing — most visibly for a terminated Run revisited days later (a stable, final signal instead of an
ever-more-negative live countdown), but equally for a retried Run sitting in `preparing_workspace`
with the prior failed attempt's sample still on record. (`runs.updated_at` is not used for this:
it can keep advancing after termination for unrelated reasons, e.g. pull-request-discovery polling
for succeeded Runs.) Both HTTP surfaces read the same `watchdog` object and render nothing (badge
absent, section hidden) when the effective Watchdog policy is disabled.

For a waiting Run whose tracked PR has unresolved review feedback after the configured dispatch
cap, `GET /api/runs/:id` also exposes a top-level `pullRequestFollowup` object with
`attention = "cap_reached"`, `dispatchCount`, `maxDispatches`, `prNumber`, and `prUrl`; otherwise
the field is `null`. The matching server-rendered Run page shows an amber manual-attention warning
linked to the PR. Both surfaces use only persisted tracking state and the current loaded policy; they
do not call GitHub while serving a request.

Label creation, stale-claim reset, and workspace cleanup remain CLI-only.

## 15. Bootstrap Acceptance Bar

The bootstrap slice is accepted when:

- tests pass
- lint passes
- `init` can create an empty user Service Config with interactive service-level settings
- `init-project` can append a Dispatch Project without losing existing config and create its starter
  Workflow Contract
- `doctor` validates service config, GitHub auth, operational labels, selected Codex, Claude, and
  OMP provider commands, workflow file, database path, workspace root, and configured Required
  Eligibility Labels for Dispatch Projects; Routine Hosts validate provider + workspace only
- `init-project` can create missing operational and Required Eligibility Labels for a Dispatch
  Project after interactive review or `--yes`; `init-project --mode routine-host` creates none
- `daemon` can claim one `agent-ready` issue in this repository
- daemon prepares the deterministic issue worktree and branch
- daemon runs the configured provider through Codex JSON-RPC, Claude stream-json, or OMP native RPC
- daemon captures raw logs, normalized events, rendered prompt, issue snapshot, and provider metadata
- durable run state is updated in SQLite
- a configured recurring `kind: report` Routine fires on its clock tick, records a Routine Firing,
  and exposes its next clock event
- CLI and local status page show Projects, runs, failures, input-required events, stale state, and
  log links

## 16. Deferred Work

- remote workers
- external sandboxing
- workspace cleanup commands
- stale-claim TTLs
- GitHub Projects board support
- webhook-based PR subscriptions
- first-class provider-neutral GitHub tools for agents
- distributed scheduling
- production packaging
