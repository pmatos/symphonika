# `adopt-pr` as an audited exception to ADR 0090

Status: Accepted

## Context

Several `jsse` pull requests were opened by Symphonika agents whose owning Run was subsequently
lost. Re-labeling the *pull request* `agent-ready` does nothing — the dispatch loop's eligibility
scan (`issue-polling.ts`, `dispatch.ts`) only ever looks at issues, never at PRs, and `Run` rows are
keyed by `(project, issue_number)` throughout `run-store.ts`. There is no existing path that attaches
an already-open PR to a fresh Run.

ADR 0090 ("the FSM position is the only thing that names a start state") establishes that nothing
outside a raw FSM should choose where its work resumes, after a real incident where inferring a
resume point from PR/CI/review shape — rather than deferring to the workflow's own authored
transitions — cost a five-hour wasted run and four duplicate review dispatches on merged PRs. An
orphaned PR is exactly the case that invariant leaves unaddressed: it has no parked FSM position at
all, because its Run no longer exists. Something has to originate one, and inferring it
automatically from the PR's diff/CI/review shape is precisely the class of heuristic ADR 0090 was
written to rule out.

## Decision

`adopt-pr` is a human-triggered, one-shot, audited exception to ADR 0090's invariant — not a second
inference mechanism sitting beside it. `symphonika adopt-pr <project> <pr-number> --issue
<issue-number> --entry-state <state>` requires an operator to have looked at the PR and to name the
FSM position explicitly, the same way a workflow author names a transition's target state. The
operator's choice is the authored decision ADR 0090 requires; `adopt-pr` supplies the mechanism for
recording it, not a substitute for having one.

Two constraints keep this exception narrow rather than opening a second, competing start-state
mechanism:

- **`--entry-state` must be a `wait` or `merge_pr` state in the project's real expanded workflow
  graph.** `WorkflowActionKind` is `agent | close_issue | comment | fail | label_issue | merge_pr |
  wait` (`src/workflow/types.ts`) — only a `wait`/`merge_pr` state is a position the workflow's own
  author already gave meaning to as something to observe and react to; an `agent` state re-runs a
  provider from scratch against a branch that may already hold complete, reviewed work, which is
  the same class of mistake ADR 0090 documents, and a terminal state is a no-op. A project workflow
  built from `builtin_single_agent_pr`/`builtin_plan_tdd_pr` (`agent → done`, no `wait`/`merge_pr`
  state anywhere) has no valid entry state at all, and `adopt-pr` refuses outright rather than
  accepting a state that happens to validate against the graph but means nothing for adoption.
- **Adoption is restricted to PRs whose head branch is this project's own deterministic Issue Branch**
  (`sym/<project>/<issue>-<slug>`, `planWorkspacePaths`) for the given `--issue`, cross-checked
  structurally rather than trusted as bare operator input. A continuation Run's agent always pushes
  to that deterministic branch; a PR whose head is anything else — a fork, a hand-created branch —
  would leave the adopted Run's own workspace pushing to a branch the PR never updates from. Fork and
  foreign-branch adoption is an explicit non-goal here, not an oversight; it needs new remote-handling
  machinery `workspace.ts` does not have today (`ensureRepositoryCacheRemote` errors if `origin`
  doesn't match the configured remote).

Once parked, an adopted Run is ordinary raw-FSM state from the FSM's own point of view: nothing
downstream (`decideNextStep`, PR Follow-up's `reEvaluateWaitingRun`) knows or needs to know the Run
was adopted rather than dispatched. `decideNextStep` has no dwell time — if the operator parks at a
state whose transition predicates are already satisfied by the PR's current state, the very next
daemon tick advances, including a `merge_pr` state auto-merging on that first tick if merge policy is
already satisfied. This is accepted as correct, not gated: the parked position's own transitions
decide, per ADR 0090, and the CLI's success output says so explicitly so the operator isn't
surprised by it.

## Consequences

- `adopt-pr`'s entry-state validation and issue-branch restriction are the two places this exception
  is bounded; widening either (accepting `agent` states, accepting arbitrary/fork branches) would
  turn a narrow, audited exception back into exactly the kind of external inference ADR 0090 forbids.
- Entry-state validation stops garbage input (a typo'd or nonexistent state, or a state of the wrong
  kind), not *wrong-but-valid* input — an operator can still park a Run at a real `wait`/`merge_pr`
  state that doesn't match the PR's true progress. Accepted as a bounded, one-shot, human-auditable
  risk, smaller than an unattended heuristic making the same mistake repeatedly.
- Automatic adoption (inferring the issue number from a PR's "Closes #N" body, or inferring the entry
  state from PR/CI/review shape) remains out of scope. `adopt-pr`'s guard and validation logic is
  reusable infrastructure for that direction if it's ever built, but building it now would reopen the
  exact question this ADR answers by requiring a human in the loop.
- **Known limitation, not fixed here:** `adopt-pr` derives the adopted Run's workspace path from the
  PR's own existing branch, not a freshly recomputed one, so an issue title edited before adoption
  cannot cause adoption itself to land on the wrong path. But a *later* continuation/state-advance
  that re-enters an `agent` state still recomputes the workspace/branch path from whatever the issue's
  title is at that moment (`prepareIssueWorkspace`, `run-controller.ts`) — the same pre-existing gap
  every normally-dispatched Run has. See #699.
