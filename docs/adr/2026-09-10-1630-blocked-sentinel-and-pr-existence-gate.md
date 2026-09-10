# A working blocked-signal sentinel, and gating post-implement states on an actual pull request

Status: Accepted

## Context

The `vow_plan_tdd_pr` raw-FSM shape (`implement -> code_review_fix -> simplify -> wait_for_pr ->
...`), used by vow-lang/vow, s11, symphonika itself (`workflow.yml`), modgud, health-connectors,
pianosight, and finnie, had two compounding gaps (issue #730), reconstructed from vow-lang/vow#1255
(2026-09-06):

1. **The "exit non-zero to signal blocked" instruction in `prompts/code-review-fix.md`,
   `prompts/autofix-pr.md`, `prompts/resolve-conflicts.md`, `prompts/simplify.md`,
   `prompts/red-team.md`, `prompts/refactor.md`, and `prompts/verify.md` cannot work as written.**
   Each told the agent to
   post a comment and "exit non-zero (e.g. `exit 1`)", claiming this routes the FSM through
   `provider_success: false`. But the agent can only run `exit 1` as a Bash **tool call**, which
   exits that subshell, not the wrapping provider session — the session's real `process_exit` event
   is controlled by the harness, which exits 0 when the turn completes normally regardless of what a
   tool call inside it returned. In vow#1255, `code_review_fix` correctly diagnosed "no PR exists",
   posted a comment, ran `exit 1` believing it would fail the run, and the run advanced to `simplify`
   anyway with `provider_success: true`.
2. **`implement`'s completion gate (`provider_success` + `branch_ahead_of_base`, ADR-2026-09-05-1205
   already flagged this) never checks that the branch reached origin or that a pull request
   exists**, even though pushing and `gh pr create` are `impl.md`'s (`WORKFLOW.md`'s, for this
   repo's own instance) own job. In vow#1255, `implement` ended its turn after a long background
   test run without ever pushing or opening a PR; the FSM still advanced into `code_review_fix`,
   whose prompt assumes "a pull request was just opened".

ADR-2026-09-05-1205 already bounded the symptom this produced — a `wait`/`merge_pr` state parked
forever with no tracked PR now terminalizes `blocked` after ~120 ticks (~1 hour) instead of parking
for days — but explicitly left both of these root causes unfixed as filed-separately follow-up work.
This ADR is that follow-up.

## Decision

### A working blocked signal: the `BLOCKED.md` sentinel

Symphonika already has a working, generic mechanism for gating a raw-FSM transition on Workspace
state: `artifact_exists`, the same predicate `plan-tdd-pr`'s `planning -> implementing` transition
uses to require a written `PLAN.md` (issue #583) rather than trusting `provider_success` alone. The
seven affected prompts now tell the agent to write `BLOCKED.md` (uncommitted) with its explanation and
exit 0, instead of exiting non-zero. `workflow.yml`'s `code_review_fix`, `simplify`, `autofix`, and
`resolve_conflicts` states, and the `refactor-swarm` built-in template's `red_team`, `refactoring`,
and `verifying` states (`src/builtin-templates.ts`), each gained a
`- to: failed / when: artifact_exists: BLOCKED.md` transition ordered before their existing success
transition (transitions are evaluated top-down, first match wins), so a blocked pass now correctly
routes to the workflow's `blocked` exit regardless of the process exit code.

`red_team` and `refactoring` already had an incidental, coincidental second layer of protection —
their success transitions also require `branch_advanced_since_attempt_start`, and their prompts
instruct making no commit when blocked — so the exit-code bug never produced a false positive there.
`verifying` had no such protection: it is a read-only verifier by design (never commits), and its
only transition was `provider_success: true -> done`, so a rejected verification with the broken
`exit 1` instruction would have silently advanced `refactor-swarm` to `done`. The `BLOCKED.md` gate
closes that gap directly rather than relying on the coincidence.

`BLOCKED.md` is a reserved name, not a per-template input like `plan_artifact`: making it
configurable would have required the attempt-start cleanup below (see "Stale sentinels") to know a
state-specific filename, for no real benefit — nothing needs more than one blocked-sentinel
convention across every project this shape runs against.

**Stale sentinels across a reused Workspace.** SPEC.md documents that Workspaces are reused across
attempts (ADR 0040) and that an ordinary artefact like `PLAN.md` deliberately persists across
attempts as a result. `BLOCKED.md` must not: a workspace reused after an earlier attempt left
`BLOCKED.md` behind (that attempt's run terminalized, but a later continuation or operator-triggered
re-run reuses the same Workspace) must not have a stale sentinel block a later, genuinely successful
attempt that never touches the file. `clearBlockedSentinel` (`src/lifecycle/blocked-sentinel.ts`)
removes `BLOCKED.md` from the Workspace immediately before each attempt's provider execution, next
to the existing `headShaAtAttemptStart` snapshot in `run-controller.ts` — best-effort, logged and
swallowed on failure, the same as other pre-attempt Workspace inspection steps at that call site.
`run-controller.ts` only runs this clear when the attempt's current state actually declares a
`BLOCKED.md` artifact-exists transition (`collectArtifactPaths(currentState).has("BLOCKED.md")`):
most workflow states never reference the sentinel at all, and an unconditional clear would delete a
managed repository's own unrelated root `BLOCKED.md` (issue #736 review). That state-gate condition
still deletes an in-scope `BLOCKED.md` unconditionally, with no check on whether the file is this
attempt's own sentinel or a repository's tracked file of the same name; ADR-2026-09-10-2018 adds a
git-tracked-file provenance check to close that gap.

### Gating a post-implement state on an actual pull request

`implement`'s transition only proves local git state (a commit ahead of base); it cannot prove the
branch reached origin or that a pull request exists. Two options were weighed for closing that gap:

1. A new predicate (e.g. `pull_request_exists`) evaluated synchronously inside
   `applyWorkflowOutcome`, calling GitHub directly (`listPullRequestsForBranch`) the moment the
   agent's turn ends. This would detect the gap immediately, but puts a live network call with no
   good failure mode (a transient API error would have to either false-negative to `blocked` or
   silently fall back to the old unsafe behavior) directly in the FSM decision path — a new failure
   mode in an unattended run with no operator to notice a wrongly `blocked` outcome.
2. A `wait` state inserted between `implement` and `code_review_fix`, gated on the existing
   `pr_open`/`pr_merged` PR-signal predicates.

This ADR takes option 2: `workflow.yml`'s `implement` now hands off to a new `wait_for_pr_open`
state instead of `code_review_fix` directly:

```yaml
implement:
  transitions:
    - to: wait_for_pr_open
      when:
        provider_success: true
        branch_ahead_of_base: true
    - to: failed

wait_for_pr_open:
  action:
    kind: wait
  transitions:
    - to: merged
      when:
        pr_merged: true
    - to: failed
      when:
        pr_open: false
    - to: code_review_fix
      when:
        pr_open: true
```

This reuses two mechanisms that already exist and are already exercised by `wait_for_pr` later in
the same chain: the tracked-PR-by-issue discovery loop (`pull-request-followup.ts`'s
`discoverPullRequests`, which polls any `state = 'succeeded'` run's branch for an open PR
independently of which FSM state is currently parked) and ADR-2026-09-05-1205's bounded
untracked-wait escalation. `code_review_fix` — and everything after it — can no longer run before a
tracked, open pull request exists. No new orchestrator code was needed for the gate itself, only the
new state in the graph.

**Tradeoff.** Under this shape, vow#1255 would terminalize `blocked` after ADR-2026-09-05-1205's
bound (~1 hour), not immediately the moment `implement`'s turn ends, the way a synchronous live
check would. Immediate detection was judged not worth a live GitHub call inside the FSM decision
path for an unattended run; a bounded wait with an established, already-notifying escalation path is
the more defensible choice here. The `implement` attempt's own run row also becomes `state =
'succeeded'` with no tracked PR, so it is independently subject to `discoverPullRequests`'s own
`MAX_PULL_REQUEST_DISCOVERY_ATTEMPTS` bound (`pull-request-followup.ts`,
`terminalizePullRequestDiscoveryExhausted`) — a pre-existing bound on that row set, unchanged by this
ADR, that may terminalize before `wait_for_pr_open`'s own ~1-hour bound does. `builtin:plan-tdd-pr`
(`src/builtin-templates.ts`) is unaffected:
its `implementing` state has no `code_review_fix`-equivalent downstream state that assumes an open
PR, so the gap this ADR closes does not apply to it.

## Consequences

- `prompts/code-review-fix.md`, `prompts/autofix-pr.md`, `prompts/resolve-conflicts.md`,
  `prompts/simplify.md`, `prompts/red-team.md`, `prompts/refactor.md`, and `prompts/verify.md`, this
  repo's own `workflow.yml`, and `refactor-swarm`'s built-in template now have a working blocked
  signal. A blocked pass can no longer silently cascade through the rest of the pipeline as a
  false-positive success.
- `code_review_fix` (and everything after it) cannot run before a tracked, open pull request exists
  for the issue branch.
- **Not fixed here**: this lands in symphonika's own `prompts/` and `workflow.yml`. The downstream
  projects that copied this shape (vow-lang/vow, s11, modgud, health-connectors, pianosight, finnie)
  each carry their own copies and need the same prompt and workflow edits applied separately in
  their own repositories; that rollout is tracked outside this repository.
- **Not fixed here**: a live-GitHub-call predicate (option 1 above) would close the ~1-hour detection
  gap the chosen `wait` state leaves; revisit only if that gap is shown to matter in practice, since
  it trades a new unattended-run failure mode for faster detection of one that ADR-2026-09-05-1205
  already bounds.
