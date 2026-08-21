# Characterization-gated refactor swarm uses an ordinary Routine and built-in template

Status: Accepted

## Context

Large, frequently changed, undertested modules are expensive to refactor safely, but risk ranking
and behavior-preserving refactoring are separate concerns. The Orchestrator already has the two
needed boundaries: a Routine can inspect repositories and file issues, while a Workflow Template
can express a serial issue-run graph. Adding risk predicates or parallel states would duplicate
those boundaries and conflict with the workflow language's deliberately small predicate set.

The direct template precedent is `builtin:plan-tdd-pr` (ADR 0049). Agent states in one raw-FSM walk
share the issue Workspace but receive separately rendered prompts. Prompt variables contain fixed
structured fields; they do not contain an earlier provider's transcript or reasoning.

## Decision

### Risk ranking stays in a report Routine

`routines/refactor-audit.md` is a provider-neutral `kind: report` example. It ranks tracked
production targets by:

```text
size × 90-day additions-and-deletions × (1 - line coverage)
```

The prompt requires complete evidence for all three factors, searches for a stable target marker to
avoid duplicate open issues, and files at most three issues per firing. The bound prevents one audit
from flooding a Project's eligible queue; operators can copy and change the prompt when another
batching policy is appropriate. Each issue receives an existing priority label and the configured
eligibility label. The shipped example uses this repository's `priority:*` labels plus a dedicated
`refactor-ready` eligibility label and is not auto-registered.

The Routine computes and embeds the score. Dispatch sees only ordinary Eligible Issues and the
existing priority-label map. Coverage instrumentation, a risk dashboard, risk predicates, and a new
fan-out primitive are not introduced.

An operator must target audit-created issues at a Dispatch Project whose raw-FSM Workflow uses
`builtin:refactor-swarm`. The shipped prompt expects a dedicated `refactor-ready` Required
Eligibility Label. When one repository also dispatches unrelated work through a different Workflow,
use that separate label for a separate refactor Dispatch Project; workflow selection is per Project,
not per Issue.

### `builtin:refactor-swarm` is a three-state serial template

The inline template has `success` and `blocked` exits and these scalar inputs:

| Input | Type | Default |
| --- | --- | --- |
| `red_teamer` | provider | `codex` |
| `refactorer` | provider | `codex` |
| `verifier` | provider | `codex` |
| `red_team_prompt` | path | `prompts/red-team.md` |
| `refactor_prompt` | path | `prompts/refactor.md` |
| `verify_prompt` | path | `prompts/verify.md` |

Its transitions are:

| State | Success gate | Destination | Fallback |
| --- | --- | --- | --- |
| `red_team` | `provider_success: true` and `branch_ahead_of_base: true` | `refactoring` | `blocked` |
| `refactoring` | `provider_success: true` and `branch_ahead_of_base: true` | `verifying` | `blocked` |
| `verifying` | `provider_success: true` | `success` | `blocked` |

The first commit is an immutable characterization-test baseline. The second state is instructed not
to edit, delete, rename, skip, or weaken those tests and must create a separate refactor commit.

`branch_ahead_of_base` is *not* attempt-local: `inspectWorkspaceCommitsAhead` counts
`refs/remotes/origin/<base>..HEAD` in the shared Workspace, so once `red_team` commits, the
predicate stays true for every later state in the walk. Two consequences follow. The `refactoring`
gate therefore proves only "this branch has commits", not "this attempt committed" — the distinct
refactor commit is a prompt obligation that the verifier re-checks from Git history, not a
predicate the engine can enforce. And declaring `branch_ahead_of_base` on the read-only `verifying`
state would be worse than useless: it would pass unconditionally while implying a gate that does
not exist, so the state gates on `provider_success` alone and says so. A verifier rejection uses
the existing provider-failure signal and blocked exit; the template does not add a comment action
or predicate.

Closing the gap mechanically would need a new attempt-local signal (for example
`commits_ahead_of_attempt_start`). That is a workflow-language change, deliberately out of scope
here; the shipped design states the limitation instead of implying a guarantee.

### Blindness is prompt isolation, not a security boundary

The verifier receives `prompts/verify.md`, not either earlier prompt or provider transcript. It can
freely inspect the shared Workspace, identify the two commits, compare characterization-test paths,
and run tests. No new Workspace, sandbox, transcript filter, or cross-state data-passing mechanism
is added. The three provider inputs accept Codex, Claude, or OMP through the existing provider
routing contract.

Repositories override the built-in only by changing `template: builtin:refactor-swarm` to an
explicit local template path. There is no automatic name shadowing.

## Alternatives considered

- Allowing the red-team state to advance without a commit would leave no immutable baseline for the
  verifier to distinguish from refactor changes.
- Requiring a verifier commit would not block a read-only approval — `branch_ahead_of_base` is
  already true from the two earlier commits — but it would advertise a gate the predicate cannot
  express. Stating the read-only contract in the prompt is honest; a decorative predicate is not.
- Adding risk values to Workflow Predicates or the dispatch layer would couple repository analysis
  to orchestration policy even though priority labels already provide the dispatch seam.
- Filing every high-risk issue immediately would maximize throughput but could starve unrelated
  eligible work; the shipped Routine instead chooses a small, operator-editable batch.
- Automatically commenting on verifier rejection would require a system-action behavior that none
  of the existing built-ins uses. The blocked Run and provider evidence remain the audit trail.

## Consequences

- Refactors cannot reach verification until a characterization-test commit exists; the second,
  distinct refactor commit is enforced at the verifier rather than by the transition predicate.
- Read-only approval works with the existing `provider_success` predicate and state-advance rules.
- Risk-ranked targets compete through existing eligibility, priority, and concurrency behavior.
- “Swarm” means several independently filed Issues admitted by normal Project capacity, not
  parallel states inside one workflow.
- Operators remain responsible for coverage reports, batch/label customization, and selecting a
  Dispatch Project whose Workflow composes the built-in.
