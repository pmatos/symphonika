# Issue reconciliation after a tracked PR merges

Status: Accepted

## Context

pmatos/forseti#213 got stuck at `sym:claimed, sym:stale` with no `agent-ready` twice in one day,
after PRs #252 and #255 each merged real, partial-slice work against it (tracked as
pmatos/symphonika#709). Investigating turned up two distinct problems the original report
conflated:

1. **A bug.** `ClaimLabelWriter.applyTerminal` (`src/lifecycle/claim-label-writer.ts:155-197`)
   only removes `sym:running` on a non-cancelled terminal outcome; `sym:claimed` is released only
   on the closed-issue and eligibility-loss cancellation paths. `sym:stale`, once
   `detectStaleClaims` (`src/lifecycle/stale-claims.ts`) adds it, is never removed by any terminal
   path either — `STALE_CLEAR_LABELS` (`src/doctor.ts:2677`) exists only as a manual `symphonika
   doctor` remediation, which is the "manual audit" the forseti report describes. Both labels are
   in `REQUIRED_OPERATIONAL_LABELS` (`src/operational-labels.ts`), so an issue carrying either is
   permanently ineligible for re-dispatch once a run finishes successfully. This reproduces the
   report on its own, with no PR-merge awareness required: symphonika already tracks and
   auto-merges PRs (`src/pull-request-followup.ts`), but the claim it took to do the work is never
   given back. (Fixed separately, in parallel with this ADR's own changes.)

2. **A missing feature.** Symphonika's GitHub surface (`GitHubIssuesApi`,
   `src/issue-polling.ts:122-150`) can only read issues and add/remove labels — it cannot close an
   issue or post a comment. `WorkflowActionKind` already declares `close_issue`, `label_issue`, and
   `comment` (`src/workflow/types.ts:3-10`) and `fsm-expansion.ts` validates them as legal DSL
   syntax, but nothing executes them: `run-controller.ts` only branches on `"agent"` and
   `"merge_pr"`. There is no way, today, for a workflow to leave a pointer to what a merged PR
   delivered, or to close an issue itself instead of relying on GitHub's own `Closes #N` parsing.
   Checking the two actual PRs that triggered the report (#252, #255) confirms agents don't use
   that keyword reliably for partial work — both say "Part of #213" / "first implementation slice"
   in prose, never `Closes #213` — so there's no existing signal symphonika could parse even if it
   wanted to.

ADR-0090 established that nothing outside a raw FSM's own authored transitions should infer where
work resumes or what a PR's state implies, after inferring a resume point from PR/CI/review shape
cost a five-hour wasted run and four duplicate dispatches. That constrains problem 2: symphonika
gaining the *ability* to close an issue or post a comment is not itself inference, but *deciding
when* to use it must stay an authored FSM transition, not a heuristic read of PR/checklist content.

## Decision

- **Fix the bug directly.** `ClaimLabelWriter.applyTerminal` releases `sym:claimed` and `sym:stale`
  (alongside the existing `sym:running` removal) on every non-cancelled terminal outcome, the same
  way the closed-issue/eligibility-loss cancellation paths already do. This alone makes a
  successfully-completed run's issue re-dispatchable again without any PR-merge awareness — it is
  the load-bearing fix for the reported symptom and lands regardless of the rest of this decision.
- **Give symphonika the ability to close issues and post comments.** `GitHubIssuesApi` gains
  `closeIssue` and `addIssueComment` methods (implemented on `OctokitGitHubIssuesApi`), mirroring
  how `addLabelsToIssue`/`removeLabelsFromIssue` are already exposed. Symphonika is already
  structurally tied to GitHub's issue/label/PR model throughout; withholding issue-content writes
  while performing label writes and PR merges on its own authority was an inconsistent line, not a
  deliberate boundary anything in `docs/adr/` established.
- **Finish the three dead action kinds.** `close_issue`, `label_issue`, and `comment` get real
  executors in the run controller's action-dispatch path, using the new `GitHubIssuesApi` methods.
  A workflow author can now put a transition after `merge_pr` that closes the issue, or that labels
  it `agent-ready` and leaves a comment describing remaining scope with a pointer to the PR number —
  exactly the two outcomes forseti#213 needed, decided by whoever authors the FSM, not inferred by
  symphonika from PR or checklist content.
- **The claim-release fix applies uniformly; issue-content writes do not.** Both the FSM `merge_pr`
  path and the plain auto-merge loop in `pull-request-followup.ts` get the same claim/stale release
  the moment they observe or perform a merge — releasing a claim symphonika itself holds is not a
  resume-state inference. Whether and how the non-FSM auto-merge path (workflows with no
  `wait`/`merge_pr` state, e.g. `builtin_single_agent_pr`) also posts a comment or closes the issue
  is left open: doing so requires deciding *what* to say, which is exactly the class of authored
  content this ADR keeps FSM-side. Extending a builtin template to add that step, if wanted, is a
  separate follow-up, not a change forced by this ADR.

Deciding *which* box on a tracked issue's checklist a given PR closed off remains out of scope
entirely — that requires interpreting body text, the inference class ADR-0090 (and the Dependency
Gate's own body-text policy in `CONTEXT.md`) rules out. A `comment` action that links the PR and
states remaining scope, authored by the workflow, satisfies the traceability need without symphonika
ever parsing or diffing checklist content itself.

## Consequences

- `SPEC.md` needs the three action kinds documented; they exist in code today but nowhere in the
  spec.
- Builtin workflow templates (`builtin_single_agent_pr`, `builtin_plan_tdd_pr`) are unchanged by
  this ADR — adding a `close_issue`/`comment` step to them, or to any project's own workflow, is an
  opt-in authoring choice, not a consequence of implementing the executors.
- Issues currently stranded at `sym:claimed`/`sym:stale` from before this fix need the existing
  `symphonika doctor --all` remediation run once; the fix only stops new occurrences.
- `WorkflowAction`'s shape (`src/workflow/types.ts`) needs fields to carry a label set, a comment
  body, and a close reason — an implementation detail of finishing the three action kinds, not a
  further architectural decision.
