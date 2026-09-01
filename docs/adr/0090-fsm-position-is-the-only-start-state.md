# The FSM position is the only thing that names a start state

Nothing outside a raw FSM chooses where its work resumes. A provider launches only at the state the
state machine advanced to. This supersedes the paragraph in ADR 0044 beginning "The follow-up run's
Continuation parent is 'record-keeping only'" through its "starts at the workflow's `initial` state"
sentence, and widens ADR 0048's merge-only deference into the general rule.

ADR 0044 gave PR review follow-up its own dispatcher, reasoning that the run associated with a
tracked pull request is by construction parked at a `wait`/`merge_pr` state, and that a parked
position is never a valid start state for a fresh dispatch. The premise is true. The conclusion —
start at `expandedWorkflow.initial` instead — does not follow from it. A parked position is not a
state you can launch a provider at, but it is very close to the right answer: it is the state whose
own transitions say what the workflow wants done about the pull request in front of it. Starting at
`initial` instead replayed the whole pipeline — plan, implement, review, simplify — against a pull
request that was already complete, and left the Issue with two live FSM positions: the untouched
parked row, and the fresh chain racing it. One occurrence cost a single five-hour run; the review
dispatch counter reached four on merged PRs across several projects.

So the parked position decides, and the deference that ADR 0048 gave to `merge_pr` states now
covers the whole follow-up loop. `isIssueOwnedByWorkflow` asks whether a raw-FSM workflow is parked
at a state of its own; when it is, `runPullRequestFollowup` observes and records but acts on
neither the merge nor the review feedback. This makes the double position unrepresentable rather
than merely guarded against — there is no second dispatcher left to race. `dispatchReviewFollowup`
refuses raw_fsm outright, including when no run is parked: a raw FSM that is not parked has
terminated or blocked, and replaying it from the top is no more correct there. It remains the
follow-up route for markdown compatibility-graph workflows, which have no state machine, no
position, and for which the single entry point is the right and only answer.

Where review feedback lands is therefore a workflow-authoring question, answered in the workflow
file. No new contract syntax was needed: `has_unresolved_reviews` has been a live `pr_signal`
predicate since ADR 0048's predicate vocabulary, projected by `projectPullRequestSignals` on every
park re-evaluation, and simply unused because ADR 0044 had assigned this case elsewhere. Issue #632
adds expanded-graph validation for that ownership rule: a PR-observing wait state that does not name
the case is rejected by `workflow validate`, `doctor`, and reload. A legacy or hand-built graph that
bypasses validation still parks and raises manual attention; it is never replayed invisibly.

Moving review rounds onto the park-to-advance path put them inside the state machine's cycles, and
the state machine had no cycle guard at all. Nothing bounded `autofix → wait_for_pr → autofix`; it
had simply been unreachable, because no workflow authored a transition that could enter it, and the
one case that could reach it went through the global loop's per-PR dispatch cap and feedback
fingerprint. Porting that cap inward would have kept "review" as a special concept inside the FSM
while leaving every other cycle an author can write unguarded.

The guard is therefore workflow-agnostic and phrased in terms of observation rather than counting.
Each park-to-advance records a fingerprint of everything the re-evaluation observed — the projected
signal map, the artefact probe results for the paths the state's own predicates name, the tracked
head SHA, and the pull request's review-feedback fingerprint — keyed by
`(project, issue, from state, to state)`. An advance that would repeat an edge under an identical
fingerprint has learned nothing since that edge last ran, so it cannot make progress; the run stays
parked and reports a `no_progress` manual-attention warning naming the edge it refused.

The last two inputs are in the fingerprint because the projected signals cannot express either on
their own, and both false-park a workflow that was in fact progressing. `unresolved_review_threads`
is a count, so a push that changed the code while leaving check status and thread count untouched
would hash identically to the tick before it; and a reviewer who resolves one thread while opening
another moves no projected signal at all, so a changed conversation at an unchanged count would read
as no change. Reusing the review-feedback fingerprint `PullRequestState` already computes — thread
ids, comment bodies, review decision — answers the second, and is the same value the global loop
uses to decide a markdown workflow's review round is new.

The original decision deliberately did not bound a cycle whose observation genuinely changed each
round. An agent that pushes something every time it runs, without ever resolving the feedback, moves
the head SHA and so never trips the fingerprint. `maxReviewDispatchesPerPr` was an absolute count
and did bound that case; after the global loop deferred to a workflow-owned Issue, only the per-Run
watchdog caps (ADR 0089) remained, and every state advance started a new Run.

**Amended by issue #619.** The Progress Guard now pairs the fingerprint with an absolute accepted
claim count on the same `(project, issue, from state, to state)` row. A changed observation advances
only while `claim_count` is below the edge budget; after that, the Run stays parked with an
`edge_budget_exhausted` manual-attention reason. The default is ten accepted advances—deliberately
above the old three-review-dispatch default so a legitimate multi-round repair has more room—and a
Dispatch Project may set `progress_guard.max_claims_per_edge`; zero disables this absolute half of
the guard without weakening the fingerprint. A pre-amendment row migrates with `claim_count = 1`
because its existence proves one accepted advance. The existing chain-boundary delete resets both
the fingerprint and the count.

This complement has the anticipated failure mode: it can park a long but genuinely converging loop.
The per-Project override and opt-out make that tradeoff explicit instead of removing the head SHA or
review-feedback fingerprint and reintroducing the false parks those inputs prevent.

Terminal targets are never guarded — they end the chain and cannot loop. Progress history is cleared
when a chain reaches a terminal and when a fresh claim opens a new one, so a re-dispatched Issue is
never parked on an edge its own chain has not taken.

The guard covers **park-mediated cycles only**, which is narrower than "every cycle a workflow can
express". Symphonika has two advance paths — `reEvaluateWaitingRun` for a park and
`applyWorkflowOutcome` for an agent result — and the guard sits on the first. A cycle among agent
states alone (`implement → review → implement`, no wait between them) is authorable today, since
nothing in `src/workflow/` validates acyclicity, and it remains unguarded. The park-mediated case is
the one this ADR's own change creates, and the one issue #616 observed. Extending the guard to
agent-outcome advances is not a free generalisation: an agent's signals are `provider_success: true`
whether or not it accomplished anything, so the same fingerprint would park a legitimate multi-pass
agent loop as readily as a stuck one. That needs its own progress signal, and its own decision.

The deeper structural point is that those two advance paths are near-duplicates — each finds the
target state, records a terminal or an advance, and parks or schedules. A single advance seam would
be worth having on its own merits, and would make where the guard applies a choice rather than an
accident of which copy was edited.

`maxReviewDispatchesPerPr` and the `cap_reached` attention it raises remain live for markdown
workflows, which still dispatch through the global loop. For a workflow-owned Issue the cap cannot
be reached on a pull request that loop never dispatches for, and the progress guard raises the
attention instead.
