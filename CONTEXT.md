# Symphonika

Symphonika is a fresh orchestrator for turning tracked project work into isolated coding-agent runs.

> **Prospective model:** The **Dispatch Project** / **Routine Host** split and service-level
> **Routine** / **Routine Target** / **Routine Fan-out** definitions are target-state vocabulary
> for [#290](https://github.com/pmatos/symphonika/issues/290) and
> [#295](https://github.com/pmatos/symphonika/issues/295), not the current implementation
> contract. Until those issues land, `SPEC.md`, ADR-0060, and the Service Config loader remain
> authoritative for the implemented flat **Project**, project-owned **Routine** model.

## Language

**Orchestrator**:
A long-running service that claims eligible issues and dispatches them into isolated coding-agent runs.
_Avoid_: workflow engine, agent

**Issue Tracker**:
The external system that provides issues, states, and metadata used for dispatch and reconciliation.
_Avoid_: Linear when speaking tracker-generically

**Project**:
A Symphonika-managed work source with its own workspace root and agent-provider settings, declared in
the Service Config. Every Project declares whether it is a Dispatch Project or a Routine Host.
_Avoid_: GitHub Project when referring to a Symphonika Project

**Dispatch Project**:
A Project that Symphonika polls for Eligible Issues and dispatches Runs against. It additionally
requires tracker configuration, issue filters, priority mapping, and a Workflow Contract.
_Avoid_: Project when the distinction from a Routine Host matters

**Routine Host**:
A Project that is never polled for issues and exists only to give Routine Firings a repository and a
workspace — including Routines with no natural repo tie (a nightly weather digest, say), since every
Routine must target at least one Project. It declares a name, workspace root, and agent settings —
plus tracker configuration only when its `kind: git` firings should get Routine Pull Request
discovery. It has no issue filters, no priority mapping, no Workflow Contract, and no `sym:*`
operational labels.
_Avoid_: routine-only Project — a Routine Host owns no Routines; Routines target it

**Service Config**:
The reloadable orchestrator-owned configuration file that lists Projects, Routines, and service-level
runtime settings. It is the only registry that knows Project names, so it is where a Routine's target
Projects are declared.
_Avoid_: workflow when referring to the multi-project registry

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
An open issue that matches a Dispatch Project's required labels, avoids excluded labels, and is not already claimed by the orchestrator; v1 treats excluded labels such as `blocked` as the only blocker signal.
_Avoid_: active issue unless referring to tracker state

**Dispatch Eligibility**:
The question "may this Dispatch Project freshly claim this Issue?", including open state, required
labels, excluded labels, and blocking operational labels.
_Avoid_: continuation eligibility when referring to first claim selection

**Continuation Eligibility**:
The question "may this already-owned Run lifecycle keep going?", including open state for every Run,
and label re-checks only for label-controlled work. State Advance, waiting rows, and PR Follow-up
Runs keep going on label drift but still stop when the Issue closes.
_Avoid_: dispatch eligibility when referring to active-run or scheduled-work re-checks

**Required Eligibility Label**:
A repository-owned GitHub issue label configured in a Dispatch Project's `issue_filters.labels_all`.
Every configured Required Eligibility Label must exist in the Dispatch Project's repository before
the Dispatch Project can dispatch; unlike an Operational Label, Symphonika reads but does not own
its workflow meaning.
_Avoid_: operational label

**Operational Label**:
A GitHub issue label owned by the orchestrator for dispatch safety and runtime bookkeeping; v1 labels are `sym:claimed`, `sym:running`, `sym:failed`, `sym:blocked`, and `sym:stale`.
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

**Issue Reservation**:
The orchestrator's exclusive claim on a Dispatch Project's Issue, whether currently in flight as an
executing Run or scheduled for imminent dispatch as a delayed retry, Continuation, State Advance,
or wait park.
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
Branches; it re-dispatches review feedback as workflow-owned, label-immune continuation work and
merges PRs only when policy says they are clear.
_Avoid_: arbitrary PR detection

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

**Run Store**:
The SQLite-backed durable record of projects, runs, attempts, retry state, event metadata, and workspace paths.
_Avoid_: event log when referring to scheduler state

**Run**:
One orchestrator-managed execution lifecycle for one issue in one workspace.
_Avoid_: issue when referring to execution status

**Routine**:
A service-level scheduled prompt declaration that can launch a Coding Agent without a GitHub Issue,
targeting one or more Projects — never zero. Symphonika has no project-less Routine: Routine Firing
capacity caps and skip accounting are tracked per Project, so a Routine with no natural repo tie
still declares against a minimal Routine Host rather than standing free of any Project. Its name is
unique across the Service Config. When a targeted Project is disabled or omitted from the current
valid Service Config snapshot, that Routine Target is inactive: it is hidden from default operator
listings while its firing state remains durable for later re-enable.
_Avoid_: workflow contract when referring to recurring or one-shot scheduled work; project-owned
routine — a Routine names its Projects, not the other way round

**Routine Target**:
One Project named in a Routine's project list. Each Target carries its own schedule state, skip
counters, and Firing history, so a single Routine can be firing against one Project while skipped
against another.
_Avoid_: routine instance

**Routine Fan-out**:
The expansion of one Routine clock event into one clock attempt per active Routine Target. Each
attempt independently yields either a Routine Firing or a Routine Skip, so one clock event can fire
against some Targets while skipping against others. Inactive Targets are excluded from the fan-out
entirely: they are neither attempted nor recorded as a Skip. Siblings from a single clock event
share a correlation identity so operator surfaces can present them as one event.
_Avoid_: continuation, retry

**Routine Firing**:
One durable execution attempt of a Routine against one Routine Target, with its own workspace,
provider logs, prompt evidence, and lifecycle state.
_Avoid_: run when specifically referring to non-issue scheduled execution

**Routine Skip**:
An operator-visible clock attempt that did not create a Routine Firing because of a catch-up window,
an overlapping non-terminal firing, or a concurrency cap. It updates that Routine Target's latest
skip evidence and rolling counters but creates no `routine_firings` row; a Routine can be skipped
against one Target while firing normally against its others.
_Avoid_: Routine Firing when no provider execution was launched

**Routine Pull Request**:
An informational association discovered from a succeeded `kind: git` Routine Firing's deterministic
branch. It records the PR number and head SHA but never enters PR Follow-up, review re-dispatch, or
auto-merge.
_Avoid_: PR Follow-up when referring to Routine-opened pull requests

**Run Lifecycle**:
The stateful progression of one Run from dispatch selection through provider execution, scheduling,
waiting, cancellation, or terminal labels.
_Avoid_: daemon loop when referring to Run-local progression

**Watchdog**:
A daemon reconciliation component that samples active Runs for observable progress and marks wedged
Runs `stale` with `terminal_reason = "no_progress"` after the configured grace window.
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
advances within the configured grace window.
_Avoid_: heartbeat checker, liveness probe

**Progress Signal**:
The tuple of observed Run-progress evidence the Watchdog samples — most recent tool-call timestamp,
workspace mtime maximum, distinct turn-id count, output-token growth since the last sample, and
most recent streamed assistant-message timestamp. Advance of any one signal counts as progress.
_Avoid_: heartbeat when describing observable side-effects — rate-limit events are excluded from
the Progress Signal outright, and the bare presence of usage events is not progress, though the
Progress Signal still reads output-token growth from `usage_updated` events (signal 4)

**Continuation**:
A follow-up run for the same issue after a provider completed successfully but the issue remains eligible.
_Avoid_: retry when the prior run succeeded

**State Advance**:
The dispatch path that runs the next state of a raw FSM workflow after the current state advances to a non-terminal next state. State Advance bypasses the Continuation cap and label eligibility re-check; the state machine, not the issue label set, decides what runs next.
_Avoid_: continuation when describing FSM state walking

**Bootstrap Slice**:
The first usable implementation slice that lets Symphonika run this repository as one real Project well enough to help implement later Symphonika issues.
_Avoid_: prototype, toy

**Project Cursor**:
A Dispatch Project's scheduler state for polling cadence, last poll outcome, and retry timing.
Routine Hosts are never polled and have no cursor.
_Avoid_: issue cursor

**Agent Provider**:
A normalized adapter that lets the orchestrator run a specific coding-agent implementation; v1 supports Codex and Claude.
_Avoid_: agent when referring to the adapter boundary

**Full-Permission Agent Execution**:
The execution posture where coding agents run without provider approval prompts or provider sandbox restrictions.
_Avoid_: safe mode, yolo mode in formal docs

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
- A **Coding Agent** may write **Workflow Labels**
- A **Coding Agent** owns the **PR Workflow**
- A **PR Follow-up** watches only PRs associated with completed Symphonika **Runs**
- A **PR Follow-up** remains eligible while its Issue is open even when workflow labels drift
- **Pull Request State** is derived from tracker observations and feeds **Workflow Predicate** projection and **PR Follow-up** verdicts
- Each dispatched **Issue** has exactly one active **Workspace** per run
- Each **Workspace** uses one **Issue Branch**
- A **Coding Agent** executes within a **Workspace** for one **Issue**
- An **Agent Provider** launches and observes one kind of **Coding Agent**
- A **Provider Event Log** belongs to one coding-agent run
- A **Normalized Event Log** is derived from a **Provider Event Log**
- A **Run Store** records durable orchestration state across process restarts
- A **Run** can succeed even when its **Issue** remains open
- A **Routine** targets one or more **Projects** of either kind, and its name is unique across the
  **Service Config**
- One **Routine** clock event is evaluated once per active **Routine Target**, yielding either a
  **Routine Firing** or a **Routine Skip**; inactive Targets are not evaluated
- A **Routine Target** may record **Routine Skips** without creating Routine Firings
- A **Routine Firing** consumes the same Project/global in-flight capacity as issue **Runs**
- A succeeded `kind: git` **Routine Firing** may link zero or more read-only **Routine Pull Requests**
- A **Run Lifecycle** consumes **Lifecycle Events** and chooses **Planned Steps**
- A **Watchdog** samples a **Progress Signal** for each active **Run** during daemon reconciliation and may mark no-progress work `stale`, preserving **Workspace** contents
- A **Continuation** is capped so an eligible issue cannot loop forever
- A **State Advance** is not capped by the continuation cap; the FSM bounds the walk via terminal states
- A **Bootstrap Slice** operates on one real **Project** before full multi-project behavior is complete
- A **Project Cursor** belongs to exactly one **Dispatch Project**
- **Full-Permission Agent Execution** is the default and assumed provider posture
- An **Autonomous Run** fails if the provider requests interactive input

## Example dialogue

> **Dev:** "When the **Orchestrator** sees an eligible **Issue**, does it solve it itself?"
> **Domain expert:** "No. The **Orchestrator** prepares a **Workspace** and launches a **Coding Agent** to do the work."

## Flagged ambiguities

- "Orchestrator" is resolved as a fresh implementation following the Symphony specification, not a modification of the existing Symphony Elixir reference implementation.
- "Project" is resolved as a Symphonika-managed work source, not a GitHub Projects board.
- "Job" is deliberately not a Symphonika term. Operator surfaces name a **Run** or a **Routine
  Firing** explicitly; mixed listings are titled by what they show rather than by an umbrella noun.
