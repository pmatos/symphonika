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
A Symphonika-managed work source with its own tracker configuration, issue filters, priority mapping, workflow contract, workspace root, and agent-provider settings.
_Avoid_: GitHub Project when referring to a Symphonika Project

**Service Config**:
The reloadable orchestrator-owned configuration file that lists Projects and service-level runtime settings.
_Avoid_: workflow when referring to the multi-project registry

**Workflow Contract**:
The reloadable canonical repository-owned instructions and runtime policy used to execute one issue.
_Avoid_: service config when referring to repo-owned agent policy

**Issue**:
A normalized unit of project work read from the issue tracker.
_Avoid_: ticket, task

**Eligible Issue**:
An open issue that matches a Project's required labels, avoids excluded labels, and is not already claimed by the orchestrator; v1 treats excluded labels such as `blocked` as the only blocker signal.
_Avoid_: active issue unless referring to tracker state

**Operational Label**:
A GitHub issue label owned by the orchestrator for dispatch safety and runtime bookkeeping; v1 labels are `sym:claimed`, `sym:running`, `sym:failed`, and `sym:stale`.
_Avoid_: workflow label

**Workflow Label**:
A GitHub issue label owned by the repository workflow or coding agent to express product/work handoff state.
_Avoid_: operational label

**Stale Claim**:
A durable orchestrator claim on an issue for which no live local run exists.
_Avoid_: failed run

**Workspace**:
The operational Git worktree assigned to one issue run, used as the coding-agent cwd and prepared from the Project's repository before hooks run.
_Avoid_: checkout, repo clone

**Issue Branch**:
The deterministic Git branch created by the orchestrator for one issue workspace.
_Avoid_: agent-created branch

**PR Workflow**:
The repository-owned process for pushing branches, opening pull requests, updating comments, and reaching human review.
_Avoid_: orchestrator workflow

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

**Continuation**:
A follow-up run for the same issue after a provider completed successfully but the issue remains eligible.
_Avoid_: retry when the prior run succeeded

**Bootstrap Slice**:
The first usable implementation slice that lets Symphonika run this repository as one real Project well enough to help implement later Symphonika issues.
_Avoid_: prototype, toy

**Project Cursor**:
A Project's scheduler state for polling cadence, last poll outcome, and retry timing.
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

- A **Service Config** lists one or more **Projects**
- A **Project** owns one **Issue Tracker** configuration
- A **Project** references one **Workflow Contract**
- An **Issue Tracker** provides many **Issues**
- An **Eligible Issue** is an **Issue** that a **Project** may dispatch
- An **Orchestrator** dispatches zero or more **Issues** across one or more **Projects**
- An **Orchestrator** may write **Operational Labels**
- A **Stale Claim** blocks automatic dispatch until explicitly cleared in v1
- A **Coding Agent** may write **Workflow Labels**
- A **Coding Agent** owns the **PR Workflow**
- Each dispatched **Issue** has exactly one active **Workspace** per run
- Each **Workspace** uses one **Issue Branch**
- A **Coding Agent** executes within a **Workspace** for one **Issue**
- An **Agent Provider** launches and observes one kind of **Coding Agent**
- A **Provider Event Log** belongs to one coding-agent run
- A **Normalized Event Log** is derived from a **Provider Event Log**
- A **Run Store** records durable orchestration state across process restarts
- A **Run** can succeed even when its **Issue** remains open
- A **Continuation** is capped so an eligible issue cannot loop forever
- A **Bootstrap Slice** operates on one real **Project** before full multi-project behavior is complete
- A **Project Cursor** belongs to exactly one **Project**
- **Full-Permission Agent Execution** is the default and assumed provider posture
- An **Autonomous Run** fails if the provider requests interactive input

## Example dialogue

> **Dev:** "When the **Orchestrator** sees an eligible **Issue**, does it solve it itself?"
> **Domain expert:** "No. The **Orchestrator** prepares a **Workspace** and launches a **Coding Agent** to do the work."

## Flagged ambiguities

- "Orchestrator" is resolved as a fresh implementation following the Symphony specification, not a modification of the existing Symphony Elixir reference implementation.
- "Project" is resolved as a Symphonika-managed work source, not a GitHub Projects board.
