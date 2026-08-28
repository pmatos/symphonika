# Workflow predicates are parameterized queries, and no predicate name is accepted without an evaluator

`artifact_exists` was listed in the Workflow Contract parser's predicate allowlist from the
state-machine Workflow slice onwards, and never evaluated. `signalsFromTerminal` emitted three
keys — `provider_success`, `branch_ahead_of_base`, `branch_advanced_since_attempt_start` — and
transition matching was strict equality against that map, so `when: { artifact_exists: PLAN.md }`
validated cleanly, was rendered by `workflow validate`, and then never matched anything. The author
got no feedback at all, which is a worse failure than a validation error.

The damage was measured on `vow`. Issues #1108–#1115 each ran `builtin:plan-tdd-pr`, whose planning
state gated `planning -> implementing` on `provider_success: true` alone. Across all eight planning
Runs, **zero** files were written into the Workspace:

| issue | fileChange items | commands | sub-agents | total tokens |
| --- | --- | --- | --- | --- |
| 1108 | 0 | 182 | 4 | 7.8M |
| 1109 | 0 | 91 | 2 | 2.8M |
| 1110 | 0 | 149 | 3 | 3.5M |
| 1111 | 0 | 130 | 3 | 4.9M |
| 1112 | 0 | 293 | 5 | 7.0M |
| 1113 | 0 | 138 | 3 | 7.2M |
| 1114 | 0 | 41 | 6 | 2.0M |
| 1115 | 1 | 79 | 6 | 6.8M |

The single `fileChange` in #1115 was `/tmp/codex_tool_probe` containing `probe\n` — the agent
testing whether it could write at all. Roughly 42M output tokens produced no plan, and every Run
still advanced to `implementing`, which then worked unplanned.

Each planner had delegated to sub-agents (2–6 of them) and returned the sub-agent's report as the
turn's final answer; #1108's final message begins literally `"Read-only architecture report for the
planning agent:"`. Delegation is desirable. Ending the turn on a sub-agent's report instead of
writing the artefact is the failure, and no prompt wording can guarantee against it — which is
exactly why the gate belongs in the Workflow, where it is checked rather than requested.

## Decision

### `artifact_exists` is a parameterized predicate, not a signal comparison

Every other predicate is an *observation*: Symphonika samples the world, produces a value, and the
Workflow's expected value is compared to it by strict equality. `artifact_exists` is a *query*: its
value is the query's argument, not an expected observation. Forcing it into the signal map cannot
work — a state with two transitions naming two different paths would need the single-valued map to
hold both answers at once.

So predicate evaluation becomes kind-aware. `src/workflow/predicates.ts` maps every accepted key to
how it is answered (`agent_signal`, `pr_signal`, `artifact`); `decideNextStep` compares signal
predicates by equality as before, and asks an injected resolver for artifact predicates.

`decideNextStep` stays synchronous and pure. The caller probes the Workspace **once** for every path
the current state's `complete_when` and transitions name, then passes a resolver over that snapshot
(`src/lifecycle/artifact-probe.ts`). One probe per decision means `complete_when` and every
transition see a consistent view of the Workspace, and the decision function keeps having no I/O of
its own.

Shape and semantics:

- `artifact_exists: PLAN.md`, or `artifact_exists: [PLAN.md, docs/notes.md]` for "all of these
  exist". Paths resolve against the Run's Workspace.
- Absolute paths and paths escaping the Workspace are **validation errors**, through the same
  `isPathInside` guard `fsm-expansion` already applies to Template paths. Validation runs before a
  Workspace exists, so containment is checked against a synthetic root — containment of a relative
  path is lexical, so the answer does not depend on which root it is checked against. The probe
  re-checks at the real Workspace anyway, as defence in depth at the join for a graph assembled in
  code rather than parsed from a Contract.
- **Existence only.** No content inspection, no non-empty check, no `does not exist` form. A
  directory counts; a dangling symlink does not.
- The artefact need not be committed. That is the whole point: reading uncommitted Workspace state
  lets a planning stage hand a plan to the next stage without pushing a handoff file into the branch
  history.

The alternative considered was gating on `branch_advanced_since_attempt_start: true` and requiring
the planner to *commit* the plan. It works with today's signals and is what `vow` adopted as a
stopgap, but it forces a handoff artefact into the branch history and then requires the
implementation stage to `git rm` it before opening the PR. `artifact_exists` removes the commit
entirely.

### Staleness is deliberately out of scope

Workspaces are reused across attempts (ADR 0040), so a `PLAN.md` written by a *previous* attempt
satisfies the predicate on the next one. `artifact_exists` answers "is the artefact there", not "did
this attempt produce it". Freshness is already `branch_advanced_since_attempt_start`'s job, and the
two compose in one `when` map for a state that must both produce an artefact and move the branch.
Building a second, weaker freshness notion into the artefact check would duplicate that signal with
different semantics for no gain.

A state that names an artefact but whose Run never had a Workspace prepared **blocks**, and the
blocked reason names the paths it could not check. Absent evidence is not evidence of presence.

### Wait and merge states get the predicate too, under one guard

An artefact gate is only worth having where a stage can produce the artefact, which includes the
poll-driven side of the walk. Two things had to change for that to be true rather than merely
documented.

First, `createWaitingRun` never wrote `workspace_path`, so a waiting row's Workspace was NULL and
every artefact predicate in a `wait`/`merge_pr` state was unevaluable — the same silent-never-match
this ADR exists to abolish, one level in. The Workspace is now carried onto the waiting row at write
time, from the parent agent Run when the walk parks and from the current waiting row on a
wait-to-wait advance. Carrying it forward is what makes wait-to-wait chains work: that advance sets
`continuation_parent_run_id` to the *waiting* Run, so resolving the Workspace by walking parents at
read time would just find another NULL.

Second, `reEvaluateWaitingRun` returned early when no pull request was tracked, well before the
predicate was evaluated, so a wait state that needs no pull request could never advance. PR
observation now lives in its own method and the decision that follows it is reachable without a
tracked PR — but only for a state whose predicates are *artefact predicates plus at most
`provider_success`*, the signals this path actually projects. A state naming PR predicates, and every
`merge_pr` state, still waits for its pull request.

That guard is the load-bearing part. Predicate matching is strict equality over a signal map, and a
missing key is unmet, not unknown — so evaluating a mixed artefact-plus-PR state with no PR signals
projected would fail its real transition and fall through to any catch-all, advancing the walk on the
first poll for the wrong reason. Requiring at least one artefact predicate also means no Workflow
that exists today changes behaviour: an artefact predicate in a wait state has never once matched, so
there is nothing in the field to regress.

This supersedes two narrower claims in ADR 0047: that wait re-evaluation "looks up the tracked pull
request" as an unconditional step, and that `timeout` "stays defined in the predicate set but
unimplemented" — `timeout` is now rejected outright, per the no-dead-predicate policy below.

### No predicate name is accepted without an evaluator

The registry is a total map from accepted key to evaluation kind, so a key cannot be allowlisted
with nothing behind it: adding one without a kind is a type error, and there is no
"reserved"/"unimplemented" kind to hide in.

`branch_pushed` and `timeout`, the two remaining allowlisted-but-dead names, are therefore
**removed** and now fail validation as unknown predicates. Neither had any evaluator, any emitter,
or any consumer in tree; a Workflow using either was already broken, silently. Failing at
`symphonika workflow validate` is the strictly better version of that state. This is the "cannot
exist" branch of the choice the issue posed rather than the "fails validation loudly" branch: a
name that reaches validation at all is one somebody could still reasonably expect to work.

A test cross-checks each `agent_signal` and `pr_signal` key against the projection that actually
emits it, so a future key added to the registry with a kind but no emitter fails in CI rather than
in a Workflow.

### `builtin:plan-tdd-pr` gates on the plan

The built-in's `planning -> implementing` transition now requires `artifact_exists` on a new
`plan_artifact` input (default `PLAN.md`) alongside `provider_success: true`. A planner that returns
success having written nothing takes the template's `blocked` exit instead of handing an empty plan
to the implementer.

This is a behaviour change for existing users of the template, recorded in the CHANGELOG. It is the
whole point of the decision: the built-in was the vehicle for the eight wasted `vow` Runs. The path
is an input rather than a hardcoded `PLAN.md` because the plan prompt is already an input — a
repository that tells its planner to write `docs/plan.md` would otherwise be unable to use the
built-in at all after this change.

## Interaction with existing decisions

- **ADR 0034 (strict simple Templating):** unchanged. `plan_artifact` is an ordinary `path` input and
  substitutes into the predicate value like any other tag.
- **ADR 0040 (reuse Issue Workspaces across attempts):** the reason staleness is out of scope above.
- **ADR 0047 (poll-driven wait states):** amended as described above — the tracked-PR lookup is no
  longer unconditional, and the `timeout` reservation it recorded is withdrawn.
- **ADR 0045 (persisted expanded Workflow graph):** the graph gains list-valued predicates; the
  operator graph view renders them bracketed.
- **ADR 0046 (state advance vs. continuation):** unchanged. A blocked artefact gate is an ordinary
  non-advance, and a Workflow-authored terminal still fuses the same way.
- **ADR 0051 (Workflow module boundaries):** the registry and the path-validation helpers are a new
  `workflow/` submodule imported directly by FSM expansion, dispatch, and the probe.

## Numbering

ADR `0086` is the most recent number in tree; this ADR is `0087`.
