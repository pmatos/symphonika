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
- A separate/standalone rich frontend application (SPA): a client-routed app that fetches its own
  data over JSON instead of the server rendering it. Self-contained, read-only interactive
  visualizations embedded in a server-rendered operator page (e.g. the workflow-graph view) are
  permitted — see §14 and ADR-0056 — as is a scoped client-side island, bundled with a build step,
  that owns interactive behavior on top of server-rendered data for one page (e.g. the `/issues`
  page's bulk label-select toolbar, or the `/issues/graph` dependency graph view) — see ADR-0080 and
  ADR-0081.
- Automatic issue Workspace deletion.
- GitHub Projects board integration.
- Parsing issue-body dependency syntax as a *gating* mechanism: dispatch eligibility depends on
  GitHub's native `blockedBy` issue-dependency links, not on any body-text DSL. A stacked follow-up PR
  adds a best-effort `## Parent` heading parse for the `/issues/graph` view's display-only clustering
  — see ADR-0081 — but that parse never influences eligibility.

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
- React, bundled by esbuild, for scoped client-side islands (the `/issues` page's bulk label-select
  toolbar; the `/issues/graph` dependency graph view, landing in a stacked follow-up PR) — not a
  general frontend framework adopted across the dashboard; see ADR-0080 and ADR-0081

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
- it has no unresolved GitHub-native issue dependency (`blockedBy`): every blocker is `CLOSED`, and
  the dependency fetch was not truncated — see ADR-0081

Symphonika does not parse issue body text, task lists, GitHub Projects fields, or linked PRs to infer
blockers. The one exception is GitHub's own native issue-dependencies feature (`blockedBy`), which is
a GraphQL-queried relationship, not free text — see ADR-0081.

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
- `sym:human-needed`

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

A Routine is a service-level scheduled prompt declaration with a globally unique name that targets
an explicit, non-empty list of declared Projects (Dispatch Projects or Routine Hosts). Routines are
declared in a top-level `routines:` block in `symphonika.yml`, not under a Project; see §5.4. A
Routine Host owns no routines — Routines point *at* it. See ADR 0069.

Symphonika supports hand-authored Markdown routine files with YAML front matter:

- `name`
- exactly one schedule shape: `schedule.at` or `schedule.cron` with optional `schedule.tz`
- `kind: report` or `kind: git`
- optional `provider`
- optional `model`, `effort`, and `permission_mode` provider settings
- optional positive `timeout_minutes`
- optional `catch_up: fire_once_if_missed` (omitted means missed clock events are skipped)
- optional `allow_overlap: true` (omitted means overlapping firings are skipped)

Recurring schedules use five-field POSIX cron. They accept the `hourly`, `daily`, `weekly`,
`monthly`, and `yearly` aliases with or without an `@` prefix. `schedule.tz` defaults to `Etc/UTC`.
Aliases are expanded during validation without rewriting the declaration file.

The Markdown body is the routine prompt template. `name` must be safe as a single workspace path
segment because routine firing workspaces live under `<workspace.root>/routines/<name>/<firing-id>/`.
Routine names are globally unique across the `routines:` block. One declaration materializes a
**Routine Target** row for each named Project, keyed `(project_name, name)`. Target states are
`active`, `expired`, and `inactive`. `inactive` means that target's Project is disabled or omitted
from the current valid Service Config snapshot (ADR 0021 cascade); the row remains durable but is
hidden from default operator listings while sibling targets keep running. Routine-level scheduling
control also uses `disabled` and `invalid` as defined in §8.5.

### 4.13 Routine Firing

A **Routine Fan-out** is the durable group for one Routine clock event. It stores a shared
correlation id and the expected Project targets before work begins. Each target is completed by a
Routine Firing or a Routine Skip, and the group produces one summary only after every target
completes. Expected membership is immutable after the fan-out is created. A Routine Target
configured only after that clock event began does not join the existing group; an already-due
one-shot is consumed as an ungrouped `catch_up_window` skip instead of reopening a delivered
summary, while a recurring target begins with its next future clock event.

A Routine Firing is one durable execution of a Routine Target. It records the Routine, its target
Project, fan-out id, provider, nominal scheduled clock time, workspace path, branch name and ref,
prompt evidence, provider logs, terminal reason, lifecycle state, its canonical Routine Outcome,
whether its prepared `kind: git` workspace held commits ahead of the configured base branch at
completion, and any pull requests discovered from a `kind: git` firing branch. The commits-ahead
signal is independent of the canonical action: a verified GitHub issue or pull-request action may
legitimately be the Routine Outcome while the workspace still has local commits to protect. The
Routine Outcome records `status`, `action`, `url`, `title`, `summary`, `verified`, and `source`
without replacing lifecycle state or terminal reason; see ADR 0068. Its trigger source is
`scheduled` or `manual`; a scheduled firing carries the fan-out id of the Routine Fan-out it belongs
to, while a manual firing targets one Routine Target directly and has no fan-out id. A one-shot
`schedule.at` target becomes `expired` after its firing is claimed and must not fire again on daemon
restart. A recurring target remains active and advances to its next clock event after every
scheduled firing. A manual firing does not consume or correspond to a scheduled clock event, so its
nominal scheduled-time evidence is unknown. New firings persist their deterministic workspace and
branch plan when claimed, before workspace preparation. Legacy firings that predate scheduled-time
or branch-identity evidence leave those fields unknown; operator surfaces must not reconstruct
historical evidence from the claim time or mutable live configuration.

When Routine Workspace Retention reclaims a terminal firing's worktree, the firing keeps its
historical workspace path and records `workspace_pruned_at`. State-root logs and prompt evidence are
not part of workspace retention. A firing with persisted commits-ahead evidence is never an
age-based prune candidate until Symphonika can separately verify durable publication. A planned
workspace that was never created because preparation failed is treated as already reclaimed when its
repository cache is also absent or unusable.

A Routine Firing with an effective `timeout_minutes` has an absolute wall-clock deadline beginning
when execution of the claimed firing starts. Exceeding it terminates the provider process tree and
records `state = failed` with `terminal_reason = "firing_timeout"`. This declared deadline is
independent of Watchdog progress-liveness: useful progress does not extend it.

A clock event skipped for catch-up policy, overlap, or a concurrency cap is not a Routine Firing:
no `routine_firings` row is created. The Routine instead records `last_attempted_at`,
`last_skip_reason`, and `last_skip_at`, together with rolling 24-hour counts for each skip reason.

### 4.14 Notification Sink

A Notification Sink is a transport-neutral delivery boundary for a rendered subject, plain-text
body, and HTML alternative. SMTP is the first sink. Routine Firing, terminal issue-Run, and
daemon-health policy and rendering remain outside the transport.

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

retention:
  routine_workspaces:
    enabled: true
    succeeded_days: 1
    failed_days: 14
    cancelled_days: 14

pull_requests:
  enabled: true
  review_followup:
    max_dispatches_per_pr: 3
  merge:
    enabled: true
    method: squash
    require_status_success: true
    require_review_decision: false

self_update: false

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
  - path: ./daily-report.md
    projects: [symphonika, new-composer-host]
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

Routine Workspace Retention is a service-level policy under `retention.routine_workspaces`.
Automatic reclamation defaults to enabled. Successful firing workspaces are retained for `1` day;
failed and cancelled firing workspaces are retained for `14` days. Each day value is a non-negative
integer. Operators may tune the windows or set `enabled: false`; the manual cleanup command still
uses the configured windows when automatic reclamation is disabled. See ADR 0067.

`self_update` is a service-level boolean, defaulting to `false`. When `true`, the daemon
periodically checks GitHub Releases for a newer Symphonika version, stages and smoke-checks it in
an isolated location, drains in-flight work without cancelling it, and cuts over with a
`systemctl --user restart`-driven restart once the drain completes. This slice exposes no check-interval
or channel configuration beyond the boolean; toggling it to `false` mid-flight halts any in-progress
update before its next phase, per the defensive reload model in §5.1. See ADR 0079 for the full
design, including the deferred edges (no prebuilt native-module binaries, no automatic rollback
after a post-cutover crash-loop) and `symphonika service rollback` for manual recovery.
Once cutover and artifact pruning complete, the update is healthy: the old unit's restart client
being terminated by the same cgroup-wide `SIGTERM` it requested is expected and must not reverse
that result. Any other automatic restart-request error is logged as a manual-restart warning rather
than reported as a failed cutover, because the old process cannot observe post-restart liveness.

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
`evidence.ignore` policy is resolved for active Runs on every Watchdog reconciliation tick while
their Project remains in the Service Config. Each new Run also persists the effective list at
creation time. If the Project is later removed while the Run remains active under §8.4, the
Watchdog falls back to that per-Run snapshot, including after an Orchestrator restart. Pre-existing
rows without captured policy use an empty list.

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

The service config defines a top-level `routines:` sequence. Each entry is an object with a `path:`
pointing at a hand-authored Markdown routine file and a required, non-empty
`projects: [<name>, ...]` list. Every target names a declared Dispatch Project or Routine Host.
Targets are explicit: duplicates and wildcard values such as `all` are invalid, so adding a Project
never expands a Routine's blast radius implicitly. Paths are resolved relative to the service
config directory and are re-read on every daemon tick with the rest of the runtime snapshot.

Routine names are globally unique across the complete `routines:` block, including declarations
with different target lists. The per-Project `routines:` key is not supported; routines point at
Projects by name rather than being owned by them. ADR 0063's transitional singular `project:` form
is also rejected with a validation error pointing to `projects: [<name>, ...]`. See ADR 0069.

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

`model`, `effort`, and `permission_mode`, when present, must be non-empty strings — Symphonika does
not constrain `permission_mode` to a specific value; it is operator-authored, exactly like `model`
and `effort` (see §11.3). `timeout_minutes`, when present, must be a finite positive number. Invalid
values are deterministic declaration-load errors and use the same per-Routine last-known-good reload
path as an invalid cron expression.

The Service Config may declare the same optional fields in a top-level `routine_defaults:` mapping.
Resolution is front matter, then `routine_defaults`, then no override: when neither level supplies a
value, Symphonika leaves that aspect of the provider command as authored. Defaults are validated as
Service Config; an invalid defaults mapping rejects the candidate snapshot through the normal
Service Config last-known-good path.

Independently of these per-field checks, reload renders the routine's resolved provider command
template (§11.3) against its resolved `model`/`effort`: a routine declaring `model` or `effort` its
resolved provider's command template never references is also a declaration-load error (the field
would otherwise be silently inert) — checked before the routine attaches, so a template-invalid
routine is never attached with its tuning silently ignored. Unlike a per-field validation error, a
template-cross-check failure does not retain the routine's last known good declaration: the
rejection instead mirrors the kind:git-on-a-tracker-less-host rejection above it exactly — a
previously persisted Routine rejected by this check is soft-disabled with `disabled_reason =
"rejected_provider_template_mismatch"`, distinct from `removed_from_config`, so a still-configured
routine is never mistaken for one removed from `routines:`. `permission_mode` is exempt from this
check; see §11.3.

Independently of both the per-routine checks above, reload also renders every configured
`providers.<name>.command` unconditionally against empty values, whether or not any routine
currently resolves to that provider — a provider used only by issue-driven Projects would otherwise
never have its template rendered at reload time. This check sits at the same tier as a malformed
`watchdog:` or `routine_defaults:` mapping: a malformed provider command rejects the whole candidate
snapshot through the normal Service Config last-known-good path, before per-routine attach ever
runs.

### 5.5 Email Notifications

The optional service-level `email:` block configures SMTP delivery for terminal Routine Firings,
grouped Routine Fan-out summaries, terminal issue Runs, and daemon health events:

```yaml
email:
  from: "symphonika@example.com"
  to: "operator@example.com"
  on: changes
  digest_window_seconds: 60
  sources:
    routine_firings: true
    routine_fanouts: true
    issue_runs: true
    daemon_health: true
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

The four `sources` switches are independent and default to `true`. This lets an operator keep
Routine Firing delivery while muting the Routine Fan-out summary, issue-Run, or daemon-health mail
(or any other combination). `digest_window_seconds` is a positive integer from 1 through 3600 and
defaults to 60.

For terminal Routine Firings, `always` sends every outcome, including cancellation. `changes` sends
non-empty `kind: report` provider message output and succeeded `kind: git` firings (whose success
already proves commits ahead of base). `failures` sends only `state = failed`, not cancellation.
See ADR 0067.

For a grouped Routine Fan-out summary, no per-target report output is reachable at the group level,
so policy is defined in terms of the group's failure and pull-request counts plus each target's own
structured outcome action: `always` sends regardless; `failures` sends only when the group's failure
count is nonzero (a target skipped for overlap or a concurrency cap is not a failure, matching ADR
0069); `changes` sends when the failure or pull-request count is nonzero, or when any target's
outcome action is `issue_opened` or `issue_closed`. The group's issue count itself is not read for
this check — it stays ADR 0069's permanently-zero placeholder pending the structured-outcome slice.
A Routine's `notify: false` mutes the group summary the same way it mutes each target's own
per-firing notification, since the field is uniform across every target of one fan-out. A
policy-suppressed or source-muted group is recorded with its own `notification_state = skipped` —
distinct from `sent` and from the `pending` state an unconfigured `email:` block leaves it in for a
later reload or restart to pick up. Every clock-matched Routine creates a fan-out even when it
targets a single Project, so under `on: always` a single-target Routine sends both its own
per-firing notification and a one-target summary; set `sources.routine_fanouts: false` to keep only
one message per firing. See ADR 0072.

For terminal issue Runs, `always` includes every terminal outcome, including blocked outcomes and
cancellation. `changes` includes succeeded Runs, whose success proves commits ahead of base.
`failures` is keyed by `terminal_reason`, not `RunState`: `no_workspace_changes` and
`workflow_terminal_blocked` are not failures, while `no_progress`, `cap_reached:*`, orphan
recovery, provider failures, and infrastructure failures are. Cancellation is not a failure.
Terminal issue Runs are durably claimed into at most one digest per window. A digest renders at
most 50 Run details and reports the omitted count, bounding both mail frequency and message size.
Interrupted digest claims return to pending on daemon restart; delivery success, policy/source
suppression, and final delivery failure are stored separately from Run state.

Daemon-health delivery is not filtered by `on`. It reports daemon start (including orphaned Run and
Routine Firing reconciliation counts), Watchdog terminations, transition into and out of
last-known-good Service Config fallback, and transition into and out of one-or-more invalid-new
Routine declarations. Reload and invalid-Routine health are separate edge-triggered components, so
a persistently broken configuration sends once rather than once per tick, followed by one recovery
message. Watchdog terminations from one reconciliation pass are grouped.

All notification delivery gets two total attempts within one 30-second orchestration deadline.
Sink construction, rendering, delivery, and delivery-evidence failures are best-effort and cannot
change a Run or Routine Firing state or fail a daemon tick. See ADR 0071.

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
- per-Run Workflow Contract `evidence.ignore` snapshots
- normalized event metadata
- Watchdog samples for no-progress detection
- raw log file paths
- routines
- routine firings
- canonical Routine Outcomes for terminal firings
- Routine Firing commits-ahead evidence, independent of canonical Routine Outcome
- Routine Notification Delivery state and sanitized delivery error
- Issue Run Notification Delivery state and sanitized delivery error
- Routine Firing workspace-reclamation timestamps
- Routine Fan-outs, their expected Project targets, and grouped-notification delivery state
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
- self-update checks and staged cutover, when `self_update: true` (§5.1, ADR 0079)

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

After the initial reload and endpoint startup, configured daemon-health delivery emits one daemon
start event with the orphaned issue-Run and Routine Firing reconciliation counts from steps 3-5.

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

Routine Target rows for Projects disabled or omitted from the current valid Service Config snapshot
are marked `inactive` and pruned from default operator listings on reload. Other targets of the same
Routine remain active. Historical `routine_firings` rows and `last_fired_at` remain durable Run
Store evidence. Re-enabling a Project restores its configured Routine Targets to `active` or
`expired` without re-firing an already-fired one-shot. A one-shot target whose `at` elapsed while
its Project was disabled and that never fired is restored to `expired`, not `active`, on re-enable
— it does not fire retroactively, mirroring the same guarantee a routine-level `disabled` restore
gives (§8.5).

`inactive` is a Project-cascade state and is distinct from a Routine's own `disabled` or `invalid`
state (§8.5): a Routine can be `disabled` while its Project stays fully enabled, and `disabled`
routines are shown in default operator listings — with their `disabled_reason` — unlike `inactive`
ones.

### 8.5 Routines

On each daemon tick, Symphonika evaluates loaded active Routine Targets. `ScheduleEvaluator`
supports:

- `wait_until` when `now < at`
- `fire_now` when `now >= at` and the Routine has not fired
- `expired` after a firing exists or the Routine state is `expired`
- recurring five-field cron evaluated in the Routine's IANA timezone, returning the next fire time
  strictly after `now`

When one or more targets for a globally named Routine match the same scheduled clock event,
Symphonika first creates a durable Routine Fan-out with a shared ULID correlation id and expected
Project membership. It then admits each target independently against overlap and concurrency gates.
That membership snapshot remains immutable across re-entrant reloads and notification delivery. A
later target with the same already-due one-shot timestamp is catch-up-skipped without joining the
existing fan-out, so one clock event still produces at most one grouped summary.
For every admitted target, Symphonika allocates a ULID firing id and prepares a workspace at
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
`none` claim or an unconfirmed pull-request/issue claim that under-reports it so a self-reported
"nothing to do", an external action no GitHub observation corroborates, or an "error" never
suppresses the retention signal below. A successful firing with neither claim nor observation records
`no_action`; it is verified and sourced to `gh` only when the before/after GitHub reads completed,
otherwise it is unverified and sourced to `symphonika`. Omission alone is not a failure. Failed and
cancelled firings retain their terminal reason independently of the reconciled outcome.

Every prepared `kind: git` workspace is inspected for commits ahead independently of terminal
lifecycle classification and the canonical Routine Outcome. Routine Workspace Retention withholds
every positive inspection from age-based collection, including failed and cancelled firings and
succeeded firings whose reconciliation correctly selects a verified `pr`, `issue_opened`, or
`issue_closed` action. Only a verified zero-commits inspection permits age-based collection; an
inspection failure is unknown and conservatively persists the protection signal. Symphonika does
not yet persist a separate durable-publication transition, so the conservative v1 behavior retains
every commits-ahead workspace indefinitely rather than infer publication from an unrelated
canonical action. A future publication signal or explicit destructive operator override may
release that protection; age alone must never delete the only copy.

When a pre-signal database first gains commits-ahead evidence, the column addition and backfill are
atomic. Every historical firing not known to be a `kind: report` firing is conservatively protected;
subsequent startups do not repeat the backfill and therefore cannot overwrite a newly inspected
zero. Startup reconciliation similarly protects a prepared `kind: git` workspace when a daemon
crash prevents the ordinary terminal inspection from running. Because a Routine declaration can
change kind while its firing is active and the firing row does not retain execution-time kind,
reconciliation treats every leaked firing with a recorded workspace path as unknown and protected.

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

Routine Firings consume the same per-Project and global `max_in_flight` slots as issue Runs.
Fan-out admission is per target rather than atomic: admitted siblings start concurrently, while a
target whose cap is full records a `concurrency_cap` skip. If an earlier firing of the same Routine
Target remains non-terminal, that target records an `overlap` skip unless `allow_overlap: true` is
configured; overlap opt-in does not bypass concurrency caps. A partial group is therefore normal.
Every skip atomically advances only that target's clock event, updates its latest-attempt/skip
fields and per-Project rolling counter evidence, completes its fan-out leg, writes no Routine
Firing row, and emits `routine.skipped` with `reason`, `routine`, and `scheduled_at` fields. A
skipped one-shot expires rather than remaining due.

A selected Agent Provider adapter that is not registered is a Routine Dispatch Hold, not a Routine
Skip. The target remains active with its original `next_fire_at`, its fan-out leg remains pending,
and Symphonika writes neither Routine Firing nor latest-attempt/skip/counter evidence. Each daemon
tick returns `provider_not_registered: <provider>` for that target and emits a structured warning
with the Project, Routine, provider, and scheduled clock time. Once the adapter is registered, a
later tick claims the original clock event and only then advances or expires the target normally.
This deliberately preserves a persistent configuration failure instead of silently progressing a
schedule whose work never ran; see ADR 0070.

A Routine Fan-out is summary-ready only after every expected target is skipped or has a terminal
firing. Symphonika then claims one durable grouped-notification delivery with a per-Project result
and subject
`[ptt] <routine> — <PR count> PR, <issue count> issue, <failure count> failed`. Skips remain visible
but do not count as failures; failed and cancelled firings do. Delivery failures return to pending
for retry. Startup releases interrupted delivery claims and existing orphan-firing reconciliation
makes claimed legs lost across a daemon restart terminal. A pending leg whose Routine Target becomes
disabled or inactive before it can be claimed is settled as `target_unavailable` without adding a
skip counter, so configuration changes cannot strand the group. There is no separate
partial-summary deadline: the firing timeout bounds live provider work, and the summary waits for
every admitted firing.

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
workspace and logs are not deleted as part of cancellation, matching issue Run cancellation.
Routine Workspace Retention may later reclaim the terminal workspace after the cancelled window;
state-root logs remain. Cancelling an unknown id or a Routine Firing already in a terminal state
(`succeeded`, `failed`, `cancelled`) returns a clear error and makes no state change.

Graceful daemon shutdown cancels every in-flight Routine Firing through the same provider
cancellation path before waiting for dispatch work to drain, recording
`cancel_reason = "daemon_shutdown"`. This is distinct from disabling or removing a Routine while
the daemon remains active, which does not cancel its in-flight firing.

A Routine with `disabled: true` in its own front matter transitions every Routine Target to
`state = disabled`, `disabled_reason = "operator"` on the next reload; future scheduling stops but
in-flight firings continue under the snapshot they started with — the daemon never cancels them as
a side effect of the Routine becoming disabled. Removing the declaration from the top-level
`routines:` block likewise soft-disables every target with `disabled_reason =
"removed_from_config"`. Removing one Project from its `projects:` list soft-disables only that
target with the same reason, leaving siblings active. Restoring a Routine or target — removing
`disabled: true`, re-adding the entry, or restoring the target name — un-disables it on the next
reload and recomputes `next_fire_at` strictly after the current clock; a one-shot target whose `at`
elapsed while disabled is marked `expired` instead of firing retroactively.
`catch_up: fire_once_if_missed` does not apply to a routine-level restore — that policy is for
daemon outage, not deliberate operator disable.

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

A previously persisted Routine rejected by the model/effort-vs-provider-command-template
cross-check (§5.4/§11.3) is soft-disabled with `disabled_reason =
"rejected_provider_template_mismatch"`, following exactly the same distinctness-from-
`removed_from_config`, `invalidRoutineNames`-exclusion, first-appearance-persistence, and
restore-on-fix rules as the tracker-less-host rejection immediately above — the two categories share
the same underlying mechanism, keyed on a different rejection cause. See ADR 0067 amendment.

An invalid Routine declaration on reload does not abort reload for the rest of the fleet (§5.4): the
daemon logs the error and surfaces it in the operator status surface and `doctor`. A Routine with a
prior valid declaration keeps firing on it unchanged; its `state` does not transition away from that
last known good value. A Routine with no prior valid declaration — a newly added file, invalid from
the start — is `state = invalid` and does not fire until a valid reload succeeds. A declaration with
no parseable `name` field cannot be represented as a `routines` row at all (the table's primary key
is `(project_name, name)`) and is reported only through the reload-error and `doctor` surfaces.

On every daemon tick, enabled Routine Workspace Retention selects only terminal firings whose
terminal update time has crossed the configured outcome window and whose persisted commits-ahead
signal is false. Canonical Routine Outcome does not substitute for this predicate. Reclamation runs
`git worktree remove --force` followed by `git worktree prune` against the Project cache, so both
the checkout and its registration are removed; for a `kind: git` firing, reclamation also deletes
its deterministic local branch (`git branch -D`) from the Project cache, since that branch has no
other purpose once the worktree is gone. A failed removal remains unmarked and is retried on
a later tick. The Run Store preserves `workspace_path` and writes `workspace_pruned_at`; no
state-root provider log, normalized event, or prompt artifact is removed. The manual
`symphonika prune-workspaces [--dry-run]` command evaluates the same policy even when automatic
retention is disabled. See ADR 0067.

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

Issue Workspaces are not deleted automatically. Terminal Routine Firing workspaces are the narrow
exception governed by Routine Workspace Retention in §8.5 and ADR 0067.

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

The OMP adapter requires RPC mode (`--mode rpc`, selected exactly once) and rejects print mode
(`-p`/`--print`). It validates the versioned ready frame with a bounded startup probe and negotiates
protocol v2 chunking when the installed OMP advertises it. See ADR-0066.

Provider commands may be overridden, but the replacement command must speak the provider adapter's
expected protocol.

Provider adapters validate wire protocol conformance only — the flags each adapter's own
stream-json/RPC parser requires to function (Claude: `-p`, `--input-format stream-json`,
`--output-format stream-json`, `--verbose`; OMP: `--mode rpc`, no print mode; Codex: the `app-server`
subcommand) — never which permission or approval *policy* the operator chose. Which permission mode
a command runs under (`--dangerously-skip-permissions`, `--permission-mode bypassPermissions`,
`--permission-mode auto`, or any later mode a provider CLI adds) is the operator's own authored
choice, exactly like `-c sandbox_mode=...` for Codex; Symphonika's TypeScript never hardcodes or
allowlists a specific policy value. An operator who wants to verify a chosen command and permission
mode actually completes a real turn, rather than only passing this static shape check, can request
`doctor --live-check <provider>`: an opt-in functional probe (not part of the default `doctor` run,
since it is a real billed call that can take tens of seconds) that spawns the configured command with
a trivial prompt and waits for a reply.

Routine `model`, `effort`, and `permission_mode` overrides are delivered by command templating, not
append-at-spawn: `providers.<name>.command` may reference plain tags `{{model}}` / `{{effort}}` /
`{{permission_mode}}`, substituted with the resolved value, and `{{#tag}}...{{/tag}}` conditional
sections, whose enclosed text (delimiters included) is kept only when the field resolves to a value —
the section form is what lets an operator omit a whole `--model X` segment when `X` is absent without
leaving a dangling incomplete flag, and likewise lets an operator template
`{{#permission_mode}}--permission-mode {{permission_mode}}{{/permission_mode}}` so a routine that
doesn't declare `permission_mode` doesn't emit a dangling flag either. Each provider adapter renders
`input.provider.command` through this template — using the firing's resolved values for
`runAttempt`, and empty values (so every section collapses) for `validate()` and for issue-driven
Runs — before parsing the rendered string into argv. Symphonika's TypeScript never hardcodes a
provider's flag vocabulary; the operator's own authored command carries that knowledge, exactly as it
already does today for Codex's `-c sandbox_mode=...`. An unrecognized or malformed template tag
throws rather than being passed through as literal text. `permission_mode` is exempt from the
unreferenced-field declaration-load check (§5.4): unlike `model`/`effort`, a routine may declare
`permission_mode` purely as documentation of intent without its resolved provider command
referencing the tag, since no provider currently requires it to appear in the command for full
permission to take effect (the default commands above already carry a fixed policy flag literally).
Claude Routine Firings additionally append `--disallowedTools ScheduleWakeup Monitor CronCreate`
(outside the template, appended by the adapter directly) and set
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

Every genuinely terminal issue Run is made pending for the durable notification digest. A
transient failed attempt remains deferred while a retry is scheduled against the same Run row and
becomes pending only when the retry budget is exhausted. Notification state is delivery evidence,
not Run lifecycle state; see §5.5 and ADR 0071.

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
when an active Run's Project has been removed from the Service Config, the Watchdog uses the list
captured on that Run instead. The hard-coded set always remains active. Separately,
`watchdog.mtime_ignore` adds workspace-relative globs whose matching files are dropped from the
mtime walk at the individual-file level, so build-output churn (e.g. `*.log`) cannot keep a wedged
Run alive.

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
- `symphonika prune-workspaces [--config <path>] [--dry-run]`
- `symphonika firings <routine> [--config <path>] [--project <project>] [--limit <n>]`
- `symphonika show-run <run-id> [--config <path>]`
- `symphonika show-firing <firing-id> [--config <path>] [--events <n>]`
- `symphonika cancel <run-id> [--config <path>]`
- `symphonika clear-stale <project> (<issue-number> | --all) [--config <path>] --yes`

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
prompt, then registers the declaration as a top-level `routines:` block entry with
`projects: [<named Project>]`. It preserves the Service Config's YAML comments and key ordering
where supported by the YAML document parser, refuses missing Projects, unsafe names, service-wide
duplicate names, invalid schedules, and existing target files, and never contacts GitHub or
triggers a daemon reload. An unrelated
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

`routines` groups Routine Targets under their globally unique Routine name and target list, then
shows each Project's `state`, `next_fire_at`, `last_fired_at`, `last_attempted_at`,
`last_skip_reason`, `last_skip_at`, rolling 24-hour skip counts per reason, and the latest canonical
Routine Outcome plus PR numbers discovered for the latest firing. Outcome rendering includes action,
title, URL, and an `(unverified)` marker when applicable. Inactive targets are hidden by default;
`--include-inactive` includes them. `--project` narrows the grouped view to one target.

`prune-workspaces` reclaims terminal Routine Firing worktrees eligible under the effective
service-level retention policy. `--dry-run` lists candidates without changing Git registrations,
directories, or Run Store rows. The command remains available when automatic retention is disabled.

`firings <routine>` lists the Routine's firing history newest first, bounded to 25 rows by default.
When the name matches current or historical targets in multiple Projects, the command lists every
candidate and requires `--project`; `--limit` selects another positive bound.

`show-firing <firing-id>` renders the Routine Firing's identity, lifecycle timing, workspace and
branch identity, deterministic prompt and provider-log paths, terminal/cancellation evidence,
discovered pull requests, and recent Normalized Event Log entries. `--events` defaults to 25.
Deterministic artifact paths are rendered even when retention has removed the files.

`clear-stale` requires exactly one of an Issue number or `--all` and removes `sym:stale`,
`sym:claimed`, and `sym:running` only after explicit confirmation. `--all` selects every Issue in
the Project's tracker repository that GitHub currently reports with `sym:stale`, lists the selected
Issue numbers before requiring `--yes`, and processes them best-effort. The command reports each
Issue as cleared, already removed, or errored and continues after an individual Issue failure.

`test-email` renders a representative fake Routine Firing and sends it through the configured
renderer, retry policy, and SMTP sink. It forces delivery regardless of `email.on` and
`email.sources.routine_firings`, reports the configured recipient on success, and reports the final
sanitized SMTP failure on error.

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

The dashboard (`/`) leads with an **active-now band**: every in-flight Run and Routine Firing,
labelled by kind. Active means `queued`, `preparing_workspace`, or `running` — a `waiting` Run
(parked for external state, such as PR review) or one in `input_required` has no provider process
running and is not active right now, though both still appear on `/runs`. Below the band, Routines
are grouped by their globally unique name into one row per Routine with a target-Project count
linking to its own page (`/routines/:name`, detailed below); Projects split into Dispatch
Projects (eligible/in-flight counts, last terminal-run outcome) and a visually subordinate Routine
Hosts group, since a Routine Host is never polled and never dispatches (ADR-0062). The flat
"recent runs" list this superseded now lives only at `/runs`. See #302.

Each Project name links to its own drill-in page, `GET /projects/:name`. For a Dispatch Project
this is a capacity strip — validity, in-flight vs. per-Project cap, global cap, poll age (marked
`(pre-restart)` when the last successful poll predates the current process), and next poll — over
one issue-keyed table: a union of the persisted issue poll snapshot (candidate and filtered issues,
ADR-0073) and this Project's Runs, keyed by issue number. Every row's state pill collapses to
`eligible`, the Run's own state (`queued`/`preparing_workspace` render as a claimed-but-not-yet-
running Run, `waiting`/`input_required` as parked, `blocked`, or a terminal RunState), or
`filtered`; the detail column carries the specific reason — cap pressure for a capped eligible
issue, the retry/recheck ETA for a waiting Run, the excluded label for a filtered issue, or the
terminal reason (plus a tracked PR, when one exists) for a terminal Run. An issue closed since the
last poll — a Run exists but no snapshot row does — still renders, driven entirely by its Run; an
issue with neither a Run nor a snapshot row does not appear. Below the table, a Routine Firings
block lists every Firing that has targeted this Project. A Routine Host's page skips the capacity
strip's poll/cap fields (a Host is never polled) and the issue table entirely, showing only the
Routine Firings block and an explanation. See #303, ADR-0073.

Each Routine's target-count link resolves to `GET /routines/:name`: its declaration (kind,
provider, schedule, `allowOverlap`, `catchUp`, source path, prompt body), one row per target
Project with that target's own state, `next_fire_at`, `disabled_reason`, last-fired/last-skip
evidence, and rolling 24-hour skip counts per ADR-0058, and the firing history across every current
target, newest first. Sibling firings admitted by one clock event share a `fanoutId` (ADR-0069) and
render grouped as one event rather than N unrelated rows; a firing with no `fanoutId` (manual or
pre-fan-out) stands alone. Because a Routine name is unique only among currently-declared
targets — a removed declaration's row is soft-disabled, never deleted, and a later, unrelated
declaration may reuse its name for a different target — a bare `/routines/:name` that matches more
than one distinct declaration renders a disambiguation list instead of guessing; `?project=<name>`
resolves it, mirroring the same query parameter `GET /api/routines/:id/firings` already exposes for
this purpose. An `invalid` target's declaration never displaces a valid sibling's real prompt or
schedule — `resolveRoutineDeclaration` tries every non-invalid target first — and any reload error
mentioning the Routine's name is shown alongside it. Enable/disable (#411, ADR-0076) and manual-fire
(#469) both render as plain HTML forms, no client-side JS. Enable/disable funnels through the same
validate/diff-confirm/write pipeline the raw-text editor uses, since toggling `disabled` is a
declaration edit. Fire-now instead posts directly to
`POST /api/routines/:id/fire` (ADR-0075), which content-type-sniffs a form submission and redirects
back to `/routines/:name` with the outcome flattened into query parameters — mirroring
`/api/runs/:id/cancel`'s existing form/JSON duality — rather than returning raw JSON, so `refused`
(with reason), `ambiguous`, and `not_found`/`unavailable` render as a legible notice instead of a
blank failure. A Routine that fans out to more than one Project (ADR-0069) gets one Fire-now button
per target, since `fireRoutineNow` requires an unambiguous `(routineName, projectName)` pair. See
#304.

Each firing row on `/routines/:name` links to `GET /firings/:id`, `/runs/:id`'s counterpart for a
Routine Firing: state, terminal reason, timings (started/ended derived from its own state
transitions), workspace path, branch, state transitions, and a provider event tail — sharing
`renderTransitionsTable`/`coalesceEvents`/`renderEventsTable`/`renderRunFileLinks` with the Run
pages rather than forking them. A Firing's evidence is a normalized-log file on disk at a path
`routineEvidencePaths` derives from the state root and firing id (`src/routines/evidence.ts`), not
the DB-backed `provider_events` table a Run's attempts use, and carries no per-event timestamp of
its own — the shared event renderers were widened to a smaller structural type
(`{normalized, sequence, type, createdAt?}`) that both satisfy, rather than fabricating one.
`GET /logs/firings/:id/:kind` streams the four evidence files that apply to a Firing (prompt,
prompt metadata, raw and normalized provider logs — a Firing has no issue snapshot and no workflow
graph), 404ing for a kind that doesn't apply or a file that was never written. A discovered Routine
Pull Request renders as plain informational text (`RoutinePullRequestStatus` carries no URL to link
to, matching the `show-firing` CLI command's own precedent) explicitly labelled as not a PR
Follow-up, per `CONTEXT.md`'s read-only-association rule. Cancelling a live firing is deferred to
#306 alongside `/routines/:name`'s write actions; the page states this and stays read-only. See
#304.

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

`GET /events` is a long-lived server-sent-events stream, one connection per browser tab, carrying
`RunStore`'s change-notification path (ADR-0074): `run-transition`, `firing-transition`,
`project-poll`, and `reload-outcome` events, plus a periodic `heartbeat` when idle. Events are
invalidation signals — an id and a new state, not a rendered fragment — so a client that misses
events during a disconnect reconciles once on reconnect rather than replaying what it missed. A Run
or Firing transition, and a reload outcome, push the instant they happen; a `project-poll` event
fires at the daemon's existing ~30-second poll cadence (ADR-0036) and only invalidates the poll-age
display already on the page — receiving one never means issue eligibility itself just became live.
Each connection subscribes and unsubscribes independently, so concurrent tabs do not share a cursor
and a disconnect (tab close, navigation, network drop) cannot leak a listener.

The dashboard (`/`) is the one page wired to this stream. `renderActiveNowBand` and
`renderProjectsSection` render inside stable `#active-now-band` / `#projects-section` containers,
each also served standalone (no `layout()`) at `GET /fragments/active-band` and `GET
/fragments/projects-section` from the same `assembleDashboardData()` inputs the full page uses. An
embedded script (`DASHBOARD_LIVE_CLIENT_JS`, a plain string constant matching the existing
`renderWorkflowGraphPage` client-JS precedent — no build step, ADR-0056) opens `GET /events`; on a
`run-transition`, `firing-transition`, or `project-poll` event it refetches and swaps both
fragments via `element.replaceChildren(...)` — a full-region replace, not a diffing morph, since
today neither fragment contains an editor or other state worth preserving across a swap (`#307`
introduces editors; a preservation mechanism belongs there, against a real element, not built ahead
of one). `EventSource`'s own reconnect handles drops; `error` shows a `#live-stream-banner` with a
manual refresh link, `open` hides it and reconciles both fragments once, matching "no replay on
reconnect." Every other page (`/runs/:id`, `/firings/:id`, `/routines/:name`, `/projects/:name`)
still requires a manual reload to see a transition — wiring those up is follow-on work. See #305,
ADR-0074.

The v1 mutating local HTTP API actions are explicit active-run cancellation, a manual poll-now
trigger that uses the normal daemon scheduler path, and daemon-owned manual Routine firing. The
server-rendered dashboard exposes only cancellation and poll-now controls; manual Routine firing is
a CLI/API action (ADR 0067).

Every mutating route — the three above and every one a later slice adds — requires the request to
either carry no browser fetch-metadata (`Origin`/`Sec-Fetch-Site` both absent, the CLI's own bare
`fetch()` calls) or be same-origin and carry a valid CSRF token (ADR-0075). A page GET that renders
a mutating form (today, only the Run-detail page's cancel form) mints a session cookie on first
visit and embeds a token derived from it; the token travels as a hidden form field for a
form-encoded submission, or an `X-CSRF-Token` header otherwise. A cross-origin request, or a
same-origin one with a missing or stale token, gets `403`. The token's lifetime is the daemon
process's — a restart invalidates every open tab's token until it reloads.

`runSavePipeline` (`src/http/save-pipeline.ts`, ADR-0075) is the save path every editor route calls
through: validate with the same parser the reload path uses, refuse a write that would clobber a
change made since the editor opened (a content-hash comparison, `src/content-hash.ts`), write
atomically preserving the file's mode, then trigger the real reload path and report its actual
outcome. It validates routine declarations and workflow contracts today; service-config
validation-reuse is deferred to whichever editor route first needs it (ADR-0075 records why). A
save target must resolve — through symlinks — to one of the specific paths the current valid
config actually references (`resolveConfinedWritePath`/`computeReferencedRealPaths`,
`src/path-safety.ts`), not merely a path inside the config directory.

`GET /routines/:name/edit` is the first caller (`#307`, ADR-0076): raw text editing of the
Routine's declaration file, no generated form — the file is Markdown-with-YAML-front-matter, and a
form round-trip would reformat it. Saving is two steps, never one: `POST .../edit/preview`
re-validates the submitted content with `parseRoutineDeclaration` and, when valid, renders a diff
against the current on-disk content (a small in-process LCS line diff — the two texts are always
in memory already, never large enough to warrant a dependency); nothing is written until the
operator submits the resulting confirm form to `POST .../edit/confirm`, which resolves the write
target through `resolveWritePath` and calls `runSavePipeline` with the daemon's real reload as the
`reload` callback. A stale write (content changed on disk since the editor opened) is refused with
the current content shown, never silently overwritten. A YAML syntax error surfaces the parser's
own line/column (`locatedYamlErrorMessage`, `src/yaml-errors.ts`); a semantic validation error (a
missing or malformed field) has no parser position to report and is shown as plain text. The
schedule and next-fire-time effect of a saved edit lands on the next dispatch tick, same as any
other config reload — the page shows whatever the store's current row holds on next visit, not a
synthetic post-save preview. The editor states which Routine Targets a save affects and their
current next-fire time before the operator commits.

`GET /projects/:name/workflow/edit` follows the identical two-step shape for a Dispatch Project's
workflow contract (a Routine Host has no workflow and gets no edit link). Validation
(`validateWorkflowContractContent`, `src/workflow/fsm-expansion.ts`) dispatches on the file's own
format the same way reload's `readWorkflowSnapshot` does — a raw-FSM YAML contract (which can
legitimately open with `---`, a bare YAML document marker) is validated as raw FSM, not
misinterpreted as unterminated Markdown front matter, closing a gap in `#306`'s save-pipeline
wiring that had no real caller to exercise it until now. The editor states explicitly that a save
affects the Project's *next* dispatch only — an in-flight Run keeps the workflow graph it started
with (ADR-0045's per-Run persisted expanded graph), which the issue text calls out as the direction
an operator would otherwise reasonably assume wrong.

`GET /config/edit` closes the same shape over `symphonika.yml` itself, linked from every page's
primary navigation rather than a Project- or Routine-scoped page. Validation
(`validateServiceConfigContent`, `src/reload.ts`) runs the submitted content through the exact same
schema-parse-and-cross-reference path a real reload does — the previously-deferred extraction from
`#306` (ADR-0075), driven now that `#307` gives it a real caller: the submitted content is written
to a throwaway file in the same directory as the real config (so relative `routines:`/`workflow:`
paths resolve correctly) and validated there, never touching the live file. An invalid edit is
refused with each error located to its offending field path; the daemon's own last-good snapshot is
untouched either way, since nothing is written until validation passes. Editing any of
`providers.codex.command`, `providers.claude.command`, or `providers.omp.command` — the three
provider names the schema allows — requires an explicit checkbox distinct from the ordinary
"Confirm save" button, checked both client-side (a required HTML checkbox) and server-side (the
confirm route independently re-derives the same before/after comparison and refuses the write
outright if the box wasn't submitted).

`detectGitFileState` (`src/http/git-status.ts`, ADR-0075) gives a future editor the git context the
issue requires before a save: whether the target path sits inside a git repo, its repo root and
branch (or, if detached, the current SHA), the whole working tree's dirty state and — separately —
the target file's own staged/unstaged status, whether it's mid-rebase, and whether it's gitignored.
`commitFile` optionally stages and commits exactly that one file (`git ... -- <path>`, never
sweeping in an unrelated already-staged file), refusing outright while mid-rebase and reporting
`nothing_to_commit` for a no-op save rather than surfacing a raw git error. There is no `git push`
call anywhere in this module — "never push" is structural, not a convention a caller has to
remember.

The HTTP API exposes `GET /api/routines` with the same Routine status shape as the CLI and
dashboard, including `latestOutcome`, latest-attempt/skip fields, and per-reason `skipCounts24h`.
Inactive Routines are hidden by default; `?include_inactive=true` includes them, and the
server-rendered dashboard accepts the same query parameter. Because Routine names are globally
unique, `GET /api/routines/:id/firings` returns firing history with each canonical `outcome`,
linked PRs, and `notificationState` / `notificationError` delivery evidence across every target,
along with the target list. Callers may use `?project=<name>` to narrow the result and
`?include_inactive=true` to include an inactive target and reach its durable firing history.

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

The Routine-detail page (`/routines/:name`) surfaces ADR-0060's disable/enable as a first-class
action (`#307`): a "Disable routine" / "Enable routine" button (whichever the routine's current
`disabledReason` calls for; neither renders for a `removed_from_config` routine, since that state
is controlled by config file inclusion, not this action) posts to `/routines/:name/disable` or
`/enable`, which computes the toggled `disabled:` value via a targeted structured edit
(`setRoutineDisabled`, `src/routines/declaration-editor.ts` — the `yaml` document API, preserving
every other comment and key in the front matter) and renders the same diff-before-write
confirmation the raw-text editor uses; the confirm button posts to the same
`/routines/:name/edit/confirm` route, so the write itself goes through the identical save pipeline
regardless of which editor produced the content. Disabling affects every target sharing that
declaration (ADR-0069's fan-out); a live firing already in progress is unaffected until it
terminates, and the schedule/state change itself lands on the next dispatch tick, same as any other
routine-declaration edit.

The Firing-detail page (`/firings/:id`) surfaces a "Cancel firing" button for a non-terminal firing,
posting to the same `/api/runs/:id/cancel` route the Run-detail page's cancel form already uses —
that route already id-sniffs a Run vs. a Routine Firing server-side (ADR-0060), so no new cancel
mechanism was needed, only the missing UI control. The route's own form-post redirect now sniffs
the same way (`#307`): cancelling from `/firings/:id` returns to `/firings/:id`, not `/runs/:id`.

`GET /issues` (`#308`, ADR 0077) is a cross-Project issue triage search, linked from every page's
primary navigation. It reads only `#303`'s persisted per-Project issue poll snapshot
(`listProjectIssueSnapshots`) — never a live GitHub Search API call, and never `#302`'s in-process
`issuePollStatus` either, so the page's own snapshot-age display means the same thing for every
result regardless of how recently the daemon polled. Honest, stated limits: open issues only, at
most ~30s stale in steady state, scoped to configured Projects' repos, and search is over issue
titles only (not body — no acceptance criterion needs it, and persisting every open issue's full
body on every 30s poll is real write amplification the page doesn't require). Each row shows
Symphonika's own eligibility verdict and reason — `eligible`, `filtered: <label>`, `filtered:
missing <label>`, `blocked: sym:<label>`, or `claimed by run <id>` — derived purely from the
snapshot's own `kind`/`reasons` (`describeIssueVerdict`, `src/issues/verdict.ts`), the same verdict
`evaluateProjectEligibility` computed at poll time, never recomputed against live config. A
snapshot row polled before the current process started renders `(pre-restart)` next to its age,
the same rule `/projects/:name`'s capacity strip already uses. Filters — Project, verdict
(eligible/filtered), exact label, and free-text title search — combine with AND and are all
optional query parameters; an unrecognized `?verdict=` value is treated as no filter, matching how
`/runs`'s `?state=` handles an unrecognized value.

Each search result links to `GET /issues/:project/:number` (`#308` part 2), showing the issue's full
label set — orchestrator-owned `sym:*` labels render as read-only pills with an explanation (ADR
0002/0024), never a Remove control — plus an "Add a label" form and a per-label Remove form for
every other label. Both write through `writeIssueLabels` (`src/daemon.ts`), which resolves the
Project's tracker token, calls `GitHubIssuesApi.addLabelsToIssue` / `removeLabelsFromIssue`, and
surfaces a thrown error as a plain-text failure banner — the page's label list is always read from
the persisted snapshot, never mutated in memory on either a success or a failure, so "the issue's
displayed labels unchanged" holds for both. A successful write's banner offers `POST
/issues/poll-now`, a page-facing wrapper around the same `pollNow` trigger `/api/poll-now` already
exposes to the CLI — submitted separately by the operator, never auto-fired by the write itself, so
labelling an issue never bypasses the dispatch gates (ADR 0036) by triggering a poll as a side effect.

`POST /issues/:project/:number/clear-stale-claim` (`#308` part 3) is the one `sym:*` mutation the UI
offers, named rather than raw label surgery: it removes `sym:stale`, `sym:claimed`, and `sym:running`
together, the same set `clear-stale` (`doctor`, ADR 0038) removes, and only appears on the page when
at least one is present in the persisted poll snapshot. Once invoked, it attempts all three against
live GitHub state rather than narrowing the write to that deliberately stale snapshot; an
already-absent label is an idempotent per-label success. It is refused — no GitHub write attempted —
when a live Run exists for the issue, checked against the same three sources `detectStaleClaims`'s own liveness check unions
(the in-process active-run registry, `queued`/`preparing_workspace`/`running` Run rows, and parked
`waiting` rows, which keep `sym:claimed` across the wait per ADR 0047): hand-clearing a claim on a Run
that is still live is exactly the double-dispatch ADR 0038 exists to prevent. This closes the one gap
`clear-stale`'s CLI form never had a liveness check for; the CLI command itself is intentionally left
as-is (a narrow, deliberately un-generalized addition — see ADR 0077).

Label creation and workspace cleanup remain CLI-only; stale-claim reset no longer is.

`GET /issues` also lets an operator select several rows and add or remove labels across all of them
in one action (ADR 0080) — a checkbox per row plus a header "select all," a label-picker toolbar with
autocomplete drawn from the labels already present in the currently-rendered rows (no new
label-listing call), and a React island (`src/client/issues-bulk-select.tsx`, bundled by esbuild into
`dist/client/issues-bulk.js`, served at `GET /assets/issues-bulk.js`) that owns that selection/toolbar
behavior on top of the still-server-rendered table. `POST /api/issues/bulk-labels` is the write path:
it rejects the whole request before any write if any requested label is `sym:*` (the same guard the
single-issue form uses), then writes best-effort per selected issue — one issue's GitHub-side failure
doesn't block the rest — through a small concurrency cap, and reports success or failure per issue in
the response.

`GET /prs` (`#309`, ADR 0078) is the PR counterpart to `/issues`: a cross-Project pull request
search, linked from every page's primary navigation. Unlike issues, there is no pre-existing
repo-wide PR poll — this slice adds one, a cheap paginated REST list (`GitHubIssuesApi.
listPullRequests`) per configured Project's repo, run on the same tick as the issue poll and
persisted to a new `project_pull_request_snapshots` table (mirroring `#303`'s
`project_issue_snapshots` replace-wholesale rule: a PR that stops being returned ages out on the
next successful poll, a failed poll leaves the prior snapshot in place). Each listed PR's
Symphonika Pull Request State (`src/pull-request-state.ts` — merged, mergeable, checks,
unresolved-thread count, and review decision) is also fetched at poll time, one GraphQL follow-up
call per PR, and persisted alongside the cheap fields; a PR whose state fetch fails or whose
`GitHubIssuesApi` doesn't support it still gets a row, with `stateAvailable: false` rather than
being dropped — the un-enrichable PRs are exactly the ones this feature exists to make visible.
Search combines Project, branch origin (`issue_branch` / `routine_firing_branch` / `neither`, from
the PR's head ref shape — see ADR 0078), tracking status (`tracked` / `untracked`), and free-text
title, all optional and AND-combined; an unrecognized filter value is treated as no filter, the
same rule `/issues` and `/runs` use.

Each result links to `GET /prs/:project/:number`, showing the PR's full normalized Pull Request
State (mergeable, checks, review decision, unresolved-thread count) when available, or an explicit
note that the state couldn't be fetched at the last poll — never a silent "unknown" that looks the
same as GitHub genuinely reporting nothing outstanding. Follow-up tracking status and the owning
Run id are joined at read time against `tracked_pull_requests`, not persisted on the snapshot row —
tracking status can change independently of the next poll tick. An untracked PR from a Symphonika
branch (an Issue Branch or Routine Firing branch with no matching `tracked_pull_requests` row —
`#259`'s twelve orphaned PRs are exactly this case) renders with an explicit "untracked" pill rather
than silently looking the same as a PR from an unrelated repo branch.

The PR detail page's Labels section (`#309` part 2) reuses `#308`'s exact policy: orchestrator-owned
`sym:*` labels render as read-only pills, and every other label gets a Remove control plus an "Add a
label" form. Both write through `writeIssueLabels` (`src/daemon.ts`) — the same callback `#308`'s
issue labelling uses, since GitHub's labels endpoint treats an issue number and a PR number
identically — passing `kind: "pull_request"` and the PR number as `subjectNumber`. A successful
write's banner offers `POST /issues/poll-now` exactly as the issue page does; that route now
accepts an optional `return_to` field (validated against a fixed `/issues`/`/prs` allowlist) so
triggering it from either search page's detail view returns to the page it came from, rather than
always landing back on `/issues`.

The PR detail page's Merge section (`#309` part 3, closing epic `#301`) offers a "Merge" button only
when no live Run owns the PR — a PR whose tracked row points at a terminated Run is treated as
mergeable, same as an untracked one, since the rule is "no *live* Run," not "never tracked." When a
live Run does own it (checked against the same three-source liveness union `#308`'s clear-stale-
claim uses — the in-process registry, active `runs` rows, and parked `waiting` rows, which still own
a PR under a `merge_pr` FSM state), the section instead shows "owned by run `<id>`, cannot be merged
until that Run is cancelled" and renders no button at all — refused both in the UI and, independently,
server-side on the `POST` route, so a replayed or hand-crafted request gets the identical refusal a
test covers directly. Merging goes through `mergePullRequest` (`src/daemon.ts`), which resolves the
Project's tracker token, calls `GitHubIssuesApi.mergePullRequest` with the persisted snapshot's
`headSha` as `expectedHeadSha` (so GitHub refuses a merge of commits the operator never saw), and —
regardless of whether that call succeeds or GitHub refuses it — immediately re-fetches the PR's Pull
Request State and renders that fresh result in the outcome banner, never assuming success or failure
implies a particular state. Every attempt that reaches GitHub (successful or refused) is recorded as
a durable evidence row, independent of any Run — the `#259` orphan case that motivates this feature
has no Run to key evidence off of.

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
- automatic and manual Routine Workspace Retention reclaim registered terminal worktrees without
  deleting state-root evidence
- CLI and local status page show Projects, runs, failures, input-required events, stale state, and
  log links

## 16. Deferred Work

- remote workers
- external sandboxing
- stale-claim TTLs
- GitHub Projects board support
- webhook-based PR subscriptions
- first-class provider-neutral GitHub tools for agents
- distributed scheduling
- production packaging
