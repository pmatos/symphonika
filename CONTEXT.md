# Symphonika

Symphonika is a fresh orchestrator for turning tracked project work into isolated coding-agent runs.

## Language

**Orchestrator**:
A long-running service that claims eligible issues and dispatches them into isolated coding-agent runs.
_Avoid_: workflow engine, agent

**Issue Tracker**:
The external system that provides issues, states, and metadata used for dispatch and reconciliation.
_Avoid_: Linear when speaking tracker-generically

**Project**:
A Symphonika-managed work source with a name, workspace root, and agent-provider settings. A Project
declares a `mode` of `dispatch` or `routine_host` (ADR 0062); the mode determines which further
fields (tracker, issue filters, priority, workflow) are required.
_Avoid_: GitHub Project when referring to a Symphonika Project

**Dispatch Project**:
A Project with `mode: dispatch` (the default when omitted): polled for issues, requires tracker + issue filters + priority + workflow, and its dispatch validity gates on repo access and Operational/Eligibility Labels.
_Avoid_: Routine Host when referring to an issue-dispatching Project

**Routine Host**:
A Project with `mode: routine_host`: never polled for issues, exists only to host Routine Firings. Requires name + workspace + agent (+ tracker only when hosting `kind: git` firings). Owns no routines — Routines target it by name.
_Avoid_: Dispatch Project when referring to a firing-only Project

**Service Config**:
The reloadable orchestrator-owned configuration file that lists Projects, Routines, and service-level
runtime settings. It is the only registry that knows Project names, so it is where a Routine's target
Projects are declared.
_Avoid_: workflow when referring to the multi-project registry

**Runtime Config Snapshot**:
The atomic, fully validated effective view built from the Service Config, referenced Workflow
Contracts, and Routine declarations. A failed reload keeps the last-known-good snapshot; a
first-load failure has no effective snapshot, so snapshot-derived policy is unavailable rather than
partially salvaged or replaced with defaults (ADR 0092).
_Avoid_: parsed config when referring to rejected candidate fields

**Workflow Contract**:
The reloadable canonical repository-owned instructions and runtime policy used to execute one issue.
_Avoid_: service config when referring to repo-owned agent policy

**Expanded Workflow Graph**:
The fully resolved state machine the Orchestrator validates, stores as run evidence, and executes
after Markdown compatibility and Workflow Template expansion.
_Avoid_: workflow template when referring to the executable graph

**Workflow Template**:
A reusable, side-effect-free FSM fragment with scalar inputs, one entry state, and named exits,
resolved into an Expanded Workflow Graph during workflow expansion.
_Avoid_: prompt template when referring to reusable workflow states

**Autonomous Prompt**:
The exact provider prompt rendered for one Run, including the standard autonomy preamble, optional
run-specific instructions, and the Workflow Contract or state prompt body after strict variable
substitution.
_Avoid_: workflow contract when referring to the rendered provider input

**Issue**:
A normalized unit of project work read from the issue tracker.
_Avoid_: ticket, task

**Eligible Issue**:
An open issue that matches a Dispatch Project's required labels, avoids excluded labels, is not already claimed by the orchestrator, and has no unresolved GitHub-native issue dependency (see Dependency Gate below).
_Avoid_: active issue unless referring to tracker state

**Dispatch Eligibility**:
The question "may this Dispatch Project freshly claim this Issue?", including open state, required
labels, excluded labels, blocking operational labels, and the Dependency Gate.
_Avoid_: continuation eligibility when referring to first claim selection

**Dependency Gate**:
The check that an Issue has no open (non-`CLOSED`) GitHub-native `blockedBy` dependency before a
fresh dispatch or label-controlled Continuation; a hard block with no per-issue override in those
scopes. Dependency drift does not revoke an already-owned raw-FSM walk. Distinct from a body-text
DSL — Symphonika never parses issue body text to infer blockers, only GitHub's own
issue-dependencies GraphQL relationship. See ADR-0081 and ADR-0082.
_Avoid_: dependency graph (the `/issues/graph` display) when referring to this gating check

**Continuation Eligibility**:
The question "may this already-owned Run lifecycle keep going?", including open state for every Run,
and label and Dependency Gate (see docs/adr/0081-issue-dependency-gating-and-graph-view.md)
re-checks only for label-controlled work. State Advance, waiting rows, and PR Follow-up Runs keep
going on label drift and dependency drift alike, but still stop when the Issue closes.
_Avoid_: dispatch eligibility when referring to active-run or scheduled-work re-checks

**Required Eligibility Label**:
A repository-owned GitHub issue label configured in a Dispatch Project's `issue_filters.labels_all`.
Every configured Required Eligibility Label must exist in the Dispatch Project's repository before
the Dispatch Project can dispatch; unlike an Operational Label, Symphonika reads but does not own
its workflow meaning.
_Avoid_: operational label

**Operational Label**:
A GitHub issue label owned by the orchestrator for dispatch safety and runtime bookkeeping; v1 labels are `sym:claimed`, `sym:running`, `sym:failed`, `sym:blocked`, `sym:stale`, and `sym:human-needed`.
_Avoid_: workflow label

**Workflow Label**:
A GitHub issue label owned by the repository workflow or coding agent to express product/work handoff state.
_Avoid_: operational label

**Stale Claim**:
A durable orchestrator claim on an issue for which no live local run exists.
_Avoid_: failed run

**Blocked Run**:
A Run that reached a deterministic, non-actionable terminal outcome — the agent correctly declined
the task (`no_workspace_changes`) or a raw FSM workflow reached a `blocked` terminal state — as
opposed to a `failed` Run, which is reserved for outcomes that indicate something actually broke
(crash, malformed event, workspace-prep error, unexpected exit code). See ADR 0058.
_Avoid_: failed run, error

**Outcome Projection**:
The pure mapping from a Run's classified terminal outcome into its downstream forms — the persisted
Run state, the terminal GitHub label, and the Workflow Predicate signals that drive the next FSM
step — together with folding a raw FSM terminal label into the effective outcome. The Blocked-vs-`failed`
distinction is decided here, reason-based, without changing the outcome kind (ADR 0058); a
`no_workspace_changes` outcome still projects `provider_success` so the walk advances (ADR 0046).
_Avoid_: outcome handling, state mapping

**Issue Reservation**:
The orchestrator's exclusive claim on a Dispatch Project's Issue, whether currently in flight as an
executing Run or scheduled for imminent dispatch as a delayed retry, Continuation, State Advance,
or wait park. When Continuation Eligibility rejects label-controlled work and no active or scheduled
step remains, the reservation ends and the orchestrator releases `sym:claimed`.
_Avoid_: lock, in-flight when the claim spans both in-flight and scheduled work

**Workspace**:
The operational Git worktree assigned to one issue run, used as the coding-agent cwd and prepared from the Project's repository before hooks run.
_Avoid_: checkout, repo clone

**Issue Branch**:
The deterministic Git branch created by the orchestrator for one issue workspace.
_Avoid_: agent-created branch

**PR Workflow**:
The repository-owned process for pushing branches, opening pull requests, updating comments, and reaching human review.
_Avoid_: orchestrator workflow

**PR Follow-up**:
The orchestrator-owned polling loop for pull requests discovered from Symphonika-created Issue
Branches. It observes every tracked PR, but acts only on Issues no raw FSM workflow is parked on:
for those it re-dispatches review feedback as workflow-owned, label-immune continuation work and
merges PRs only when policy says they are clear. A workflow-owned Issue decides both from its own
parked position instead (see docs/adr/0090-fsm-position-is-the-only-start-state.md).
_Avoid_: arbitrary PR detection

**Progress Guard**:
The dual rule that a parked Run may not re-take a transition it already took under an identical
observation — the projected signals, the artefact probe, the tracked head SHA, and the review
conversation — or after that directed edge exhausts its Edge Claim Budget. It is the state
machine's only loop-breaker, and it bounds cycles that pass through a park; a guarded park raises
manual attention naming the edge and whether observation or budget caused the refusal.
_Avoid_: review dispatch cap (that is the markdown-workflow mechanism it replaces for FSM work)

**Edge Claim Budget**:
The maximum accepted advances across one `(Project, Issue, from state, to state)` park edge during
one workflow chain. It defaults to 10 and is configurable per Dispatch Project; zero disables this
absolute bound without disabling the Progress Guard's fingerprint rule. The count resets only at a
run-chain boundary.
_Avoid_: Convergence Budget, review dispatch cap

**Pull Request State**:
Symphonika's normalized interpretation of a GitHub PR's merged, mergeable, checks, unresolved-thread, and review-decision state; it is the single source of meaning consumed by both Workflow Predicate projection and PR Follow-up verdicts.
_Avoid_: raw GitHub pull request state

**Coding Agent**:
An external automation runtime that works on an issue inside a workspace.
_Avoid_: orchestrator, worker

**Provider Event Log**:
The raw protocol stream captured from an agent provider for one run.
_Avoid_: normalized event log

**Normalized Event Log**:
Provider-neutral run events used by the orchestrator, observability surfaces, and tests.
_Avoid_: raw provider log

**Provider Event Reducer**:
The per-Run mapping that turns one Coding Agent's raw protocol messages (its Provider Event
Log) into Normalized Event Log entries, owning any cross-message carry-forward state privately
so it is testable without spawning the provider. One per provider adapter (`codex-events`,
`claude-events`).
_Avoid_: parser, event mapper

**Thinking Marker**:
A timestamped normalized event recording that provider reasoning started or completed. It may carry
a provider-authored reasoning summary for observability, but never raw reasoning content, and counts
as provider progress for the Watchdog.
_Avoid_: tool call, chain of thought

**Run Store**:
The SQLite-backed durable record of projects, runs, attempts, retry state, event metadata, and workspace paths.
_Avoid_: event log when referring to scheduler state

**Run**:
One orchestrator-managed execution lifecycle for one issue in one workspace.
_Avoid_: issue when referring to execution status

**Routine**:
A service-level scheduled prompt declaration with a globally unique name that targets an explicit,
non-empty list of declared Projects and can launch Coding Agents without GitHub Issues. A Routine
Host owns no routines — Routines point *at* it. There is no target wildcard. See ADR 0069.
_Avoid_: workflow contract when referring to recurring or one-shot scheduled work

**Routine Target**:
The materialized per-Project state for one Routine, durably keyed by `(project_name, name)`. Each
target owns its schedule position, lifecycle state, and skip counters. When its Project is disabled
or omitted from the current valid Service Config snapshot, only that target becomes inactive while
sibling targets continue normally.
_Avoid_: Routine when referring to one Project-specific leg

**Routine Fan-out**:
The durable group created when one Routine clock event matches one or more Routine Targets. It has a
shared correlation id and immutable expected Project membership captured before work begins; each
target is summarized by a Routine Firing, a recorded Routine Skip, or a non-gating Routine Dispatch
Hold before one grouped notification is delivered.
_Avoid_: Routine Firing when referring to the whole clock event

**Routine Firing**:
One durable execution attempt for a Routine Target, with its own workspace, provider logs, prompt
evidence, persisted execution-time kind, lifecycle state, terminal reason, optional canonical
Routine Outcome, and an independent record of whether its prepared `kind: git` workspace held
commits ahead of base at completion. A scheduled firing is correlated to its Routine Fan-out; its
trigger source is scheduled or manual, and a manual firing targets one Routine Target directly,
using the same execution lifecycle without consuming the Routine's next clock event or creating a
Routine Fan-out.
_Avoid_: run when specifically referring to non-issue scheduled execution

**Routine Outcome Claim**:
The provider-reported `{status, action, url, title, summary}` object parsed from the final normalized
event of a Routine Firing. It is evidence to reconcile, not proof that the claimed action happened.
_Avoid_: Routine Outcome when referring to the provider's unverified input

**Routine Outcome**:
The canonical per-firing result produced by reconciling a Routine Outcome Claim with observed
GitHub and workspace state. It adds `verified` and `source` and remains separate from Routine
Firing lifecycle state and terminal reason.
_Avoid_: terminal reason, provider final message

**Routine Workspace Retention**:
The Service Config policy that reclaims terminal Routine Firing worktrees after outcome-specific
age windows while preserving their Run Store rows and state-root evidence. Firings with persisted
commits-ahead evidence are withheld until a separate durable-publication signal exists. Only a
verified zero-commits inspection permits age-based reclamation; an inspection failure is retained
conservatively.
_Avoid_: evidence retention, issue Workspace cleanup

**Routine Firing Deadline**:
An optional declared absolute wall-clock bound for one Routine Firing. It expires regardless of
continued progress, cancels active workspace preparation or provider work, and fails the firing with
terminal reason `firing_timeout` after that work settles.
_Avoid_: Watchdog timeout, no-progress grace

**Routine Skip**:
An operator-visible clock attempt that did not create a Routine Firing because of a catch-up window,
an overlapping non-terminal firing, a concurrency cap, or **Host Pressure**. It updates the Routine's latest skip
evidence and rolling counters but creates no `routine_firings` row. A refused manual firing is not a
Routine Skip because no clock event was attempted.
_Avoid_: Routine Firing when no provider execution was launched

**Routine Dispatch Hold**:
A due Routine Target that cannot be admitted because its selected Agent Provider adapter or command
is unavailable. The original clock event remains due and claimable, while its Routine Fan-out leg
is `held`, visible as a grouped-summary failure, and excluded from readiness gating. No Routine Skip
evidence is written; the Orchestrator warns and retries admission on later daemon ticks.
_Avoid_: Routine Skip, schedule advance

**Routine Pull Request**:
An informational association discovered from a succeeded `kind: git` Routine Firing's deterministic
branch. It records the PR number and head SHA but never enters PR Follow-up, review re-dispatch, or
auto-merge.
_Avoid_: PR Follow-up when referring to Routine-opened pull requests

**Notification Sink**:
A transport-neutral boundary that delivers a rendered plain-text plus HTML **Notification Message**.
SMTP is the first implementation; event-specific policy and rendering stay outside the sink.
_Avoid_: emailer when referring to the provider-neutral boundary

**Notification Message**:
A rendered delivery payload containing a subject, plain-text body, and escaped HTML alternative.
_Avoid_: provider output when referring to the operator-facing rendered payload

**Routine Notification Delivery**:
The best-effort delivery outcome for one terminal **Routine Firing**, recorded as `sent`, `skipped`,
or `failed` without changing the firing's terminal state. Delivery is tracked background work after
terminal persistence; it holds neither firing capacity nor Routine dispatch open, and graceful
daemon shutdown drains it before closing the Run Store.
_Avoid_: Routine Firing when referring only to delivery state

**Issue Run Notification Delivery**:
The durable best-effort delivery outcome for one terminal issue **Run**, claimed into a bounded
digest and recorded without changing the Run's terminal state.
_Avoid_: Run lifecycle state, one-email-per-Run

**Daemon Health Notification**:
An edge-triggered best-effort message for daemon start, configuration-health transitions,
invalid-new-Routine transitions, or grouped Watchdog terminations.
_Avoid_: daemon log line, issue Run digest

**Run Lifecycle**:
The stateful progression of one Run from dispatch selection through provider execution, scheduling,
waiting, cancellation, or terminal labels.
_Avoid_: daemon loop when referring to Run-local progression

**Run Slot Deadline**:
The Run-scoped absolute wall-clock enforcement of `watchdog.max_run_minutes` while an issue Run owns
in-flight capacity. It begins at the original Run claim, aborts pre-provider preparation or active
provider work, and persists `run_timeout` independently of the Run row's current lifecycle state.
_Avoid_: attempt timeout, Watchdog sample

**Watchdog**:
A daemon reconciliation component that samples active Runs for observable progress and marks wedged
Runs `stale` with `terminal_reason = "no_progress"` after the configured grace window, or
`terminal_reason = "no_convergence"` once a Run exceeds its Convergence Budget. Its wall-clock policy
is also enforced by a Run Slot Deadline before provider execution begins.
_Avoid_: retry, timeout when referring to no-progress termination

**Lifecycle Event**:
A value that asks the Run Lifecycle to decide what should happen next, such as a fresh dispatch
request, retry timer firing, provider attempt completion, or waiting-row recheck.
_Avoid_: entrypoint payload

**Planned Step**:
The next effect chosen by the Run Lifecycle, such as start a label-eligible run, start an FSM-owned
run, schedule retry, re-evaluate a waiting row, cancel, or mark failed.
_Avoid_: callback when referring to lifecycle policy

**Watchdog**:
The orchestrator subsystem that samples a Progress Signal for each `running` Run on the reconciliation
tick and transitions the Run to `stale` with terminal reason `no_progress` when no progress signal
advances within the configured grace window, or `no_convergence` when the Run exceeds its
Convergence Budget. Its Run-scoped `run_timeout` verdict can also be won by a Run Slot Deadline while
the Run owns capacity outside `running`.
_Avoid_: heartbeat checker, liveness probe

**Progress Signal**:
The tuple of observed Run-progress evidence the Watchdog samples — most recent tool-call timestamp,
provider progress timestamp (including Thinking Markers), Workspace Digest, distinct turn-id count,
output-token growth since the last sample, and most recent streamed assistant-message timestamp.
Advance of any one signal counts as progress.
_Avoid_: heartbeat when describing observable side-effects — rate-limit events are excluded from
the Progress Signal outright, and the bare presence of usage events is not progress, though the
Progress Signal still reads output-token growth from `usage_updated` events (signal 4)

**Workspace Digest**:
The hash over the sorted `relative-path:size` pairs of every non-excluded file in a Run's
Workspace, and the Progress Signal's workspace evidence. A change means files appeared,
disappeared, or changed size; a rebuild that restamps byte-identical output does not change it and
is not progress. The maximum workspace mtime is still sampled and shown to operators but no longer
decides the signal on its own (ADR 0086).
_Avoid_: workspace mtime when describing what counts as workspace progress

**Convergence Budget**:
The cumulative output tokens one Run attempt may spend before the Watchdog stops it as
non-converging.
Distinct from the no-progress grace window: it catches a Run doing plenty of observable work
without ever finishing, which satisfies every liveness signal on every tick. Configured at daemon
scope and per Project as `watchdog.output_token_budget`; `0` disables it (ADR 0086).
_Avoid_: token limit, context window — this is a per-Run spend ceiling, not a model constraint

**Continuation**:
A follow-up run for the same issue after a provider completed successfully but the issue remains eligible.
_Avoid_: retry when the prior run succeeded

**State Advance**:
The dispatch path that runs the next state of a raw FSM workflow after the current state advances to a non-terminal next state. State Advance bypasses the Continuation cap plus label and Dependency Gate re-checks; the state machine, not external eligibility drift, decides what runs next.
_Avoid_: continuation when describing FSM state walking

**Bootstrap Slice**:
The first usable implementation slice that lets Symphonika run this repository as one real Project well enough to help implement later Symphonika issues.
_Avoid_: prototype, toy

**Project Cursor**:
A Dispatch Project's scheduler state for polling cadence, last poll outcome, and retry timing.
Routine Hosts are never polled and have no cursor.
_Avoid_: issue cursor

**Dispatch Overlap Guard**:
An optional Dispatch-Project admission gate that delays a candidate when its known pull-request file
footprint intersects the periodically refreshed Workspace footprint of an in-flight Run in the same
Project. Unknown footprints remain dispatchable; strict serialization uses `max_in_flight: 1`.
_Avoid_: dependency scheduler, merge-conflict resolver

**Host Pressure**:
The share of a window during which every non-idle task on the machine was stalled on memory or I/O,
read from Linux's pressure-stall counters. An admission gate defers claiming new work while a gated
resource is at or above its configured ceiling. Distinct from a concurrency cap: the cap bounds how
many Runs may exist, Host Pressure asks whether the machine can still make progress.
_Avoid_: load average, CPU saturation, throttling

**Provider Scratch**:
A per-attempt, disk-backed directory under the state root handed to a spawned provider as its
temporary directory, removed when the attempt ends. Transient, never read back — unlike Run
evidence, which is also under the state root but retained.
_Avoid_: workspace, evidence, cache

**Agent Provider**:
A normalized adapter that lets the orchestrator run a specific coding-agent implementation; v1 supports Codex, Claude, and Oh My Pi.
_Avoid_: agent when referring to the adapter boundary

**Doctor Execution Environment**:
The report-only view of local capabilities `doctor` checks before any dispatch: selected Project
provider executables, the Codex headless profile contract, independent `gh` authentication, and the
provider/`gh` liveness of an installed unit's frozen PATH. It is an on-demand observation, not a
persisted capability manifest or an auto-remediation mechanism. See ADR 0085.
_Avoid_: Dispatch Eligibility, provider validation when referring only to executable/auth/PATH state

**Full-Permission Agent Execution**:
The execution posture where coding agents run without provider approval prompts or provider sandbox restrictions.
_Avoid_: safe mode, yolo mode in formal docs

**Provider PID Isolation**:
The host-level process boundary that runs each Agent Provider's process tree inside its own Linux
PID namespace, so one Run's provider cannot observe or signal PIDs belonging to a different Run's
provider tree. Decided in ADR 0067 as a boundary adjacent to, not a change of, Full-Permission Agent
Execution.
_Avoid_: sandboxing, approval policy when referring to this PID-visibility boundary

**Autonomous Run**:
A coding-agent run expected to proceed without asking the operator for interactive input.
_Avoid_: chat session

## Relationships

- A **Service Config** lists one or more **Projects** and zero or more **Routines**
- Every **Project** is either a **Dispatch Project** or a **Routine Host**
- A **Dispatch Project** owns one **Issue Tracker** configuration
- A **Dispatch Project** references one **Workflow Contract**
- Only **Dispatch Projects** are polled for **Eligible Issues**
- A **Routine Host** declares an **Issue Tracker** configuration only to enable **Routine Pull
  Request** discovery for its `kind: git` firings
- A **Workflow Contract** compiles to an **Expanded Workflow Graph**
- A **Workflow Template** contributes resolved states to an **Expanded Workflow Graph**
- An **Autonomous Prompt** is rendered from a **Workflow Contract** or workflow state prompt for one
  **Run**
- An **Issue Tracker** provides many **Issues**
- An **Eligible Issue** is an **Issue** that a **Dispatch Project** may dispatch
- **Dispatch Eligibility** and **Continuation Eligibility** are separate questions over the same
  Issue predicate family
- An **Orchestrator** dispatches zero or more **Issues** across one or more **Dispatch Projects**
- A **Dispatch Project**'s **Required Eligibility Labels** must exist in its Issue Tracker before dispatch
- An **Orchestrator** may write **Operational Labels**
- A **Stale Claim** blocks automatic dispatch until explicitly cleared in v1
- An **Issue Reservation** prevents duplicate dispatch while an Issue is either executing or scheduled
- A rejected label-controlled retry or **Continuation** releases its **Issue Reservation** so later
  restored eligibility can dispatch fresh work instead of becoming a **Stale Claim**
- A **Coding Agent** may write **Workflow Labels**
- A **Coding Agent** owns the **PR Workflow**
- A **PR Follow-up** watches only PRs associated with completed Symphonika **Runs**
- A **PR Follow-up** remains eligible while its Issue is open even when workflow labels drift
- A **PR Follow-up** defers to the **Workflow** when a raw FSM is parked on the **Issue**
- A **Progress Guard** combines observation fingerprinting with an **Edge Claim Budget** and bounds
  every **Workflow** cycle that passes through a park
- **Pull Request State** is derived from tracker observations and feeds **Workflow Predicate** projection and **PR Follow-up** verdicts
- Each dispatched **Issue** has exactly one active **Workspace** per run
- Each **Workspace** uses one **Issue Branch**
- A **Coding Agent** executes within a **Workspace** for one **Issue**
- An **Agent Provider** launches and observes one kind of **Coding Agent**
- The **Doctor Execution Environment** reports whether selected **Agent Providers** and `gh` can run
  under both the invoking process environment and an installed daemon unit's frozen PATH
- A **Provider Event Log** belongs to one coding-agent run
- A **Normalized Event Log** is derived from a **Provider Event Log**
- A **Run Store** records durable orchestration state across process restarts
- A **Run** can succeed even when its **Issue** remains open
- A **Routine** targets one or more explicitly named **Projects** and materializes one **Routine
  Target** for each
- A matched clock event creates one **Routine Fan-out** across the currently due Routine Targets
- Each **Routine Target** is summarized by one **Routine Firing**, one **Routine Skip**, or one
  non-gating **Routine Dispatch Hold**
- A **Routine Dispatch Hold** preserves a **Routine Target**'s original due clock event as claimable
  while making its held **Routine Fan-out** leg non-gating and visible as a summary failure
- A **Routine Fan-out** produces one grouped notification after all target legs are terminal or held
- A **Routine Firing** consumes the same Project/global in-flight capacity as issue **Runs**
- A **Routine Firing** may contain one canonical **Routine Outcome** reconciled from a **Routine
  Outcome Claim** and externally observed state
- A manual **Routine Firing** leaves the Routine's next scheduled clock event unchanged
- **Routine Workspace Retention** may reclaim only terminal **Routine Firing** worktrees without
  persisted commits-ahead evidence
- A **Routine Firing Deadline** terminates an over-time **Routine Firing** independently of the
  **Watchdog**'s progress-liveness decision
- A **Run Slot Deadline** bounds an issue **Run** while it owns in-flight capacity, including before
  a provider starts and during a retry reservation
- A succeeded `kind: git` **Routine Firing** may link zero or more read-only **Routine Pull Requests**
- A terminal **Routine Firing** may produce one best-effort **Routine Notification Delivery**
- A **Routine Fan-out** notification and a **Routine Notification Delivery** run outside Routine
  dispatch and are drained during graceful daemon shutdown
- A terminal issue **Run** may produce one durable **Issue Run Notification Delivery**
- A daemon start, health transition, or Watchdog pass may produce one **Daemon Health Notification**
- A **Notification Sink** delivers a rendered message without owning event-specific policy
- A **Run Lifecycle** consumes **Lifecycle Events** and chooses **Planned Steps**
- A **Watchdog** samples a **Progress Signal** for each active **Run** during daemon reconciliation
  and may mark no-progress work `stale`, stop a **Run** that exceeds its **Convergence Budget**, or
  enforce its outer wall-clock policy through a **Run Slot Deadline**, preserving **Workspace**
  contents in every case
- A **Continuation** is capped so an eligible issue cannot loop forever
- A **State Advance** is not capped by the continuation cap; the FSM bounds the walk via terminal states
- A **Bootstrap Slice** operates on one real **Project** before full multi-project behavior is complete
- A **Project Cursor** belongs to exactly one **Dispatch Project**
- A **Dispatch Overlap Guard** supplements concurrency caps and **Issue Reservation** without
  advancing a skipped **Dispatch Project**'s scheduler cursor
- **Host Pressure** gates admission ahead of concurrency caps and affects **Run** and **Routine
  Firing** alike; it never stops work already in flight
- A **Provider Scratch** directory belongs to exactly one attempt of one **Run** or **Routine
  Firing**, and outlives neither
- **Full-Permission Agent Execution** is the default and assumed provider posture
- **Provider PID Isolation** bounds what an **Agent Provider** can see and signal without changing
  **Full-Permission Agent Execution**
- An **Autonomous Run** fails if the provider requests interactive input

## Example dialogue

> **Dev:** "When the **Orchestrator** sees an eligible **Issue**, does it solve it itself?"
> **Domain expert:** "No. The **Orchestrator** prepares a **Workspace** and launches a **Coding Agent** to do the work."

## Flagged ambiguities

- "Orchestrator" is resolved as a fresh implementation following the Symphony specification, not a modification of the existing Symphony Elixir reference implementation.
- "Project" is resolved as a Symphonika-managed work source, not a GitHub Projects board.
- "Job" is deliberately not a Symphonika term. Operator surfaces name a **Run** or a **Routine
  Firing** explicitly; mixed listings are titled by what they show rather than by an umbrella noun.
