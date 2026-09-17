# Architecture deepening backlog

Persisted candidate memory for `pm-deepen` refactor-audit runs. Each firing
reconciles this file against merged/open PRs, reuses existing slugs so the dedup
filter holds, and never deletes entries. Statuses change; rows stay.

## resolve-scheduled-dispatch-context

- **Status**: landed
- **Score**: 21/25 (leverage 4, locality 4, blast radius 2, heat 5)
- **PR**: #764
- **Files**: ~3 estimated; 4 actual (new `src/lifecycle/scheduled-dispatch-context.ts`, `run-controller.ts`, new test, `CONTEXT.md` term — within tolerance)
- **Modules**: `src/lifecycle/run-controller.ts` — five scheduled-dispatch prologues sharing project-resolve+token+repository+`refreshIssue`: `executeRetry` (1358-1417), `reEvaluateWaitingRun` (2417-2444, deliberately omits the `isLabelWritingGitHubIssuesApi` guard), `executeStateAdvance` (2833-2876), `executeContinuation` (3387-3431), `dispatchReviewFollowup` (3582-3688, interleaved); existing fresh-dispatch model `resolveAndClaim` (1008-1073)
- **Summary**: A `resolveScheduledDispatchContext(ports, {project, issueNumber, requireLabelWritingApi})` returning `{kind:"resolved", repository, issue}` | `{kind:"dropped", reason}`, concentrating the token/repository/issue-refresh tail (the contiguous span in all five callers) and leaving eligibility + drop reaction at each caller (the `resolveAndClaim` discriminated-result house pattern). The project-resolve head stays a private `resolveDispatchProject`. `requireLabelWritingApi` is required; `reEvaluateWaitingRun` passes false to preserve its deliberate guard omission.
- **First seen**: 2026-09-14
- **Reason**: **Picked by the 2026-09-14 run** (top surviving candidate at 21/25; runner-up candidate `run-chain-tree-walk-cte` at 20/25, within 1 point). Classic "seam collapsing N duplicated prologues" pattern on the hottest file. Blast held at 2 despite one production file because the review surface spans five critical dispatch methods. Divergences preserved, not fixed: api-writability guard optional (reEval omits it — wait-park re-eval path, issues #731/#737/#740/#745), `providersConfig` loaded by callers that need it (2 of 5), drop logging/reaction per-caller. Implemented via design-it-twice winner Design A (ports-and-adapters exported free function — the only design whose adjudicated interface a failing test can pin without a reach-past cast); runner-up design B (single private method) lost on that plus leaving `dispatchReviewFollowup` out and needing a retry drop reorder. Empirical refinement: the prologue is not contiguous (retry/reviewFollowup interleave caller-specific checks), so the seam is the token/refresh tail, not the whole prologue. Added the `Scheduled Dispatch Context` term to CONTEXT.md. PR #764 opened 2026-09-14.

### Run 2026-09-14 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M2EG403B` (adopted; conditions 1-4 held — non-default, 0 unique commits ahead of `origin/main`, no upstream, unpublished on origin). Not renamed per the adopted-branch rule; slug recorded here and in the report instead.
- **Committed**: report + backlog (`f9b993d`), design section (`4df7d90`), implementation + CONTEXT.md term (`6d8f685`), this in-flight update.
- **Evidence**: PR #764; quality gate green (lint, typecheck, format:check, knip, build; test 2867 passed — no flakes this run). Diff 4 files (est. ~3; the 4th is the `CONTEXT.md` term add, within tolerance). No published/exported package/CLI/wire interface changed. `origin/main` unchanged at push (0 behind); no rebase needed. Reconciled `tracked-pull-request-lookup` #747 → merged (docs, superseded); no in-flight PR blocked this run.
- **Next**: human review of #764; `run-chain-tree-walk-cte` (20/25, runner-up candidate) is the natural next firing, with `handle-scheduled-dispatch-error` (20/25) as its adjacent follow-up on the same methods.
- **Reconciled 2026-09-18**: PR #764 merged 2026-09-14 (`68b0527`); status moved `in-flight` → `landed`. Both named follow-ups re-verified present at HEAD and re-scored below; neither was picked this run.

## editor-save-outcome-epilogue

- **Status**: in-flight
- **Score**: 22/25 (leverage 4, locality 4, blast radius 1, heat 5)
- **PR**: #789
- **Files**: ~5 estimated (`src/http/pages.ts`, one new module, three editor test files)
- **Modules**: `src/http/pages.ts` — three `/edit/confirm` route epilogues: workflow contract (1734-1824), service config (1977-2065), routine declaration (2360-2457); the union they dispatch is `SavePipelineResult` (`src/http/save-pipeline.ts:44-52`)
- **Summary**: One seam owning the editor save-response policy — the write-path `403` gate, the four-variant `SavePipelineResult` → `303`/`200`/`422`/`409`/`500` mapping, and the reload-gating rule — with the per-route `invalid` preview supplied by the caller rather than absorbed.
- **First seen**: 2026-09-18
- **Reason**: **Picked by the 2026-09-18 run.** Tied at 22/25 with `routine-editor-target-prologue` and the deterministic tiebreak chain (blast band → heat → recency) is exhausted, because both are seams in the same file. Broken on depth: `save-pipeline.ts` is already a deep module for the *write* half of a save; the *respond* half has no module and is written out longhand three times, with the load-bearing invariant restated verbatim as prose at `pages.ts:1762-1766`, `2003-2007` and `2386-2390`. The deepening completes a seam the codebase half-built rather than inventing one. ADR-0076 preserved exactly (two-phase POST shape; `/edit/confirm` remains the only `runSavePipeline` caller). Implemented via design-it-twice winner **Design C** (`createSaveConfirmer`, a factory bound once in `registerPages`, with the `invalid` branch crossing as a caller-supplied `renderInvalid` callback returning only the body). Runner-up **design** D (`saveEditableArtifact`, ports-and-adapters) lost on seam placement, on its own evidence: `editAction`/`savedRedirect` vary along URL topology and `renderInvalid` along no principled axis, so its port models an *editor target* while naming itself an artifact. Design A lost on requiring a behaviour change to routine-declaration 422 error text; Design B lost on its own measurement (~60% relabelling). Empirical refinement during implementation: a single `url.includes("?") ? "&" : "?"` join reproduces all three existing redirect sites byte-identically, so the module owns the `saved=1` composition rather than the caller. Added the `Save Confirmation` term to CONTEXT.md. PR #789 opened 2026-09-18.

### Run 2026-09-18 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M2RSMHBW` (**adopted**; all four conditions held — non-default, 0 unique commits ahead of `origin/main`, no upstream, unpublished on origin). Not renamed per the adopted-branch rule; the slug is recorded here and in the report instead.
- **Committed**: report + reconciled backlog (`3918928`), design section (`e2a360c`), implementation + tests (`b59a5f5`), CONTEXT.md term (`446ebca`), this in-flight update.
- **Evidence**: PR #789. Quality gate green, each step a separate command: lint, typecheck, format:check, knip, test (2938 passed / 183 files), build. Diff 5 files (estimate ~5, exact): `src/http/pages.ts`, new `src/http/save-confirm.ts`, new `tests/save-confirm.test.ts`, `CONTEXT.md`, plus `.architecture/`. **The three existing editor test files were not touched — their passing unchanged is the behaviour-preservation evidence.** Test-first: `tests/save-confirm.test.ts` was seen to fail on the absent module before it was written. No published package, wire, or CLI interface changed. `origin/main` unchanged at push (0 behind); no rebase needed. Reconciled `resolve-scheduled-dispatch-context` #764 → merged/landed; no in-flight PR blocked this run.
- **Next**: human review of #789. `routine-editor-target-prologue` (22/25, the tied runner-up **candidate**, deferred only to keep blast off the same 3,000-line function twice in one PR) is the natural next firing.

## routine-editor-target-prologue

- **Status**: proposed
- **Score**: 22/25 (leverage 4, locality 4, blast radius 1, heat 5)
- **Files**: ~3 estimated
- **Modules**: `src/http/pages.ts` — 33 lines identical modulo indentation at `POST /routines/:name/edit/preview` (2244-2276), `POST /routines/:name/edit/confirm` (2321-2353), `renderRoutineDisabledTogglePreview` (2473-2505, serving `/disable` and `/enable`)
- **Summary**: A `resolveRoutineEditTarget(...)` returning `{kind:"ok", …} | {kind:"refused", response}` — the discriminated-result house pattern PR #764 landed — owning the 404-vs-200 refusal policy and the ADR-0076 stale-declaration guard.
- **First seen**: 2026-09-18
- **Reason**: Runner-up **candidate** to `editor-save-outcome-epilogue` this run at an exact 22/25 tie. Deliberately deferred, not dropped: both live in the same 3,000-line `registerPages` function in the tree's highest-churn file, so taking both in one PR would double the blast — the same split applied to `resolve-scheduled-dispatch-context` / `handle-scheduled-dispatch-error` on 2026-09-14. **The natural next firing.** Only real divergence is a parameter: the toggle's `editAction` omits the `/edit` segment (`:2499` vs `:2270`/`:2347`).

## routine-firing-terminal-write

- **Status**: proposed
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
- **Files**: ~2 estimated
- **Modules**: `src/routines/dispatcher.ts` — the terminal `completeRoutineFiring` + `reconcileRoutineOutcome` assembly on the success path (1800-1828) and its failure/cancel twin (2001-2030), both inside `runRoutineFiring`
- **Summary**: A `settleRoutineFiringTerminal(runStore, {...})` owning the ADR-0068 12-field Routine Outcome assembly and its agreement with the persisted terminal row's `state`/`terminalReason`/`cancelReason`.
- **First seen**: 2026-09-18
- **Reason**: Has **already drifted** — the failure path passes `observedAction: githubObservation.action` where the success path passes `claimUrlVerification ?? githubObservation.action`, and a comment at `:2025-2027` admits the failure path's `pullRequestObserved` is inert by accident. Scored leverage 3 (two call sites) despite the strong drift evidence. On the hot routine outcome-claim surface (#751/#754/#760/#761/#762/#775). The *wider* settlement mirror (1606-1828 vs 1877-2030) was examined and dropped — see `routine-firing-settlement-sequence`.

## omp-frame-read-loop

- **Status**: proposed
- **Score**: 20/25 (leverage 3, locality 5, blast radius 1, heat 4)
- **Files**: ~2 estimated
- **Modules**: `src/providers/omp.ts` — `readUntilFrame` (517-556) and `readUntilResponse` (558-600); a `diff` of the two spans yields only three hunks (signature, event construction, match condition)
- **Summary**: One `readUntilMatch(queue, activeRun, {match, mapMatched})` generator owning the OMP terminal-event contract (`process_exit` → `missingTerminalAgentEndEvent`; `isTerminalAgentEnd` → `markTerminalAgentEnd` + `drainUntilExit`; `isTerminalFailure` latch); the two existing functions become thin adapters.
- **First seen**: 2026-09-18
- **Reason**: Locality 5 — the duplicated block *is* the ADR-0066 wire protocol's terminal contract, and the two functions' call sites interleave in one turn generator, so a protocol fix lands twice today. Not covered by the landed `provider-run-harness` (`runAttempt`) or the proposed `provider-validate-harness-seam` (`validate`). `drainUntilExit` (602-612) deliberately stays out: no match predicate, no terminal handling.

## routine-dispatch-refusal-ledger

- **Status**: proposed
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
- **Files**: ~2 estimated
- **Modules**: `src/routines/dispatcher.ts` — seven store-write/log/report refusal sites in `dispatchDueRoutines`: 832-852, 869-893, 902-923, 930-952, 953-975, 993-1019, 1020-1044
- **Summary**: A per-call `RoutineRefusalLedger` closing over `runStore`, `logger`, `now` and the four result arrays, exposing `.skip`/`.miss`/`.defer`/`.hold`, so the store-write / log / result-report triple is atomic by construction.
- **First seen**: 2026-09-18
- **Reason**: Leverage held at **3 despite seven call sites** — the sites are numerous but not alike (four different Run Store methods, three different log shapes), so a four-member ledger would itself be shallow, interface ≈ implementation. Real asymmetry it would name: the four `record*`-backed sites gate log+push on the store's return value, the two hold sites push unconditionally at `warn`. Drift risk: `:912-916` re-derives `scheduledAt` where `:841-845` uses the bound value. Excluded from scope: the inline catch-up skip at 742-762 and the four bare pushes at 1052/1068/1080/1114.

## init-project-prompt-session

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~2 estimated
- **Modules**: `src/doctor.ts` — `confirmOperationalLabelCreation` (2611-2638), `confirmEligibilityLabelCreation` (2640-2667), and the lifecycle wrapper only in `collectProjectSettings` (2141-2261)
- **Summary**: A `withInitProjectPrompt(prompt, yes, (ask) => …)` owning the `createInitProjectPromptController` create/close lifecycle, plus an `askYesNo(ask, {key, message, refusalNoun})` built on it.
- **First seen**: 2026-09-18
- **Reason**: Two real invariants, not shared strings — the readline interface is closed on every exit path (a leaked handle hangs `symphonika init project` after a thrown validation error), and anything other than `yes`/`y`/`no`/`n` throws rather than silently defaulting to consent for a live GitHub label write. Heat 3: `doctor.ts` is hot overall (53 touches/120 commits) but the init-prompt cluster is a cold corner of it.

## routine-firing-settlement-sequence

- **Status**: dropped
- **Score**: n/a (leverage 1 — deletion test moves)
- **Modules**: `src/routines/dispatcher.ts` 1606-1828 (success) vs 1877-2030 (failure/cancel)
- **Summary**: The *whole* firing settlement sequence — githubAfter capture, cancel re-checks, `routineGithubObservation`, `inspectRoutineCommitsAhead`, redaction, claim read — mirrored across the try and catch paths.
- **First seen**: 2026-09-18
- **Reason**: Hard filter **leverage 1**. The prose admits the mirror (`:1991-1993`, `:1944-1946`), but eight genuine divergences — claim read before vs. after classification, deadline fail-soft `.catch()` on the failure side only, `withProviderStderrTail`, PR discovery and claim-URL verification on the success side only, `state` from `outcome.kind` vs. a ternary — would land as per-path hooks. Complexity **moves**, same verdict class as `leaked-subject-sweep` and `wait-terminal-contract`. Superseded by the narrower `routine-firing-terminal-write`, which takes only the terminal write itself.

## daemon-project-snapshot-persist

- **Status**: dropped
- **Score**: n/a (leverage 1 — deletion test moves)
- **Modules**: `src/daemon.ts` `persistProjectPollState` (2579-2626) vs `persistProjectPullRequestPollState` (2700-2738)
- **Summary**: A shared per-project wholesale-replace port for the two poll-state persisters.
- **First seen**: 2026-09-18
- **Reason**: Hard filter **leverage 1**, despite an admitting comment at `:2696-2699` ("mirrors persistProjectPollState's per-project wholesale-replace rule (ADR 0073)"). The shared policy is only ~6 lines; the row mappers (`projectIssueSnapshotRows` 2628-2694 vs the inline PR mapper 2716-2736) share **no columns**, and the issue side additionally owns `recordProjectPollOutcome` and the `selectedProjectKeysByName` identity gate. A shared port pushes the difference into adapters. Distinct from `daemon-project-state-projection`, which covers 2798-2952.

## daemon-inflight-promise-registration

- **Status**: dropped
- **Score**: n/a (leverage 1 — interface ≈ implementation)
- **Modules**: `src/daemon.ts` 636-639, 1422-1430, 1447-1450, 1987-1990
- **Summary**: A helper registering an in-flight promise for the shutdown drain.
- **First seen**: 2026-09-18
- **Reason**: Hard filter **leverage 1**. A real shutdown-drain invariant, but a 3-line helper — the interface would be as complex as the implementation. Same class as the already-dropped `mutate-and-publish`.

## daemon-poll-pipeline-pair

- **Status**: dropped
- **Score**: n/a (leverage 1 — deletion test moves)
- **Modules**: `src/daemon.ts` `refreshIssuePollStatus` (798-1007) and the PR-poll pipeline
- **Summary**: A shared `partitionProjectsForPolling → poll → engageGithubBackoff → persist` pipeline.
- **First seen**: 2026-09-18
- **Reason**: Hard filter **leverage 1**. The issue-poll side additionally owns merge/carry-forward, suppression, and `projectModes`; extraction **moves** those into per-side hooks.

## doctor-winning-assignment-family

- **Status**: dropped
- **Score**: n/a (not behaviour-preserving)
- **Modules**: `src/doctor.ts` `winningServiceAssignment` (797-826), `winningSliceAssignment` (950-966), `winningByteSizeAssignment` (1017-1063), `winningAssignment` (1399-1417)
- **Summary**: Unify the four systemd last-assignment-wins readers.
- **First seen**: 2026-09-18
- **Reason**: Hard filter — **not behaviour-preserving**, so it cannot be pinned by a test before changing it. The four are *deliberately* different: `winningByteSizeAssignment` skips past assignments systemd itself rejects and is lowercase-exact; `winningAssignment` reports the literal last value case-insensitively for drift auditing. Prose at 968-981 and 1391-1398 documents why. Unifying is a behaviour change, not an extraction — same reason `probe-shutdown-drift` was dropped.

## run-chain-tree-walk-cte

- **Status**: proposed
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
- **Files**: ~1 estimated (+ test)
- **Modules**: `src/run-store.ts` — byte-identical `WITH RECURSIVE up/down` chain-tree walk in `isRunChainFullyTerminal` (5636-5655) and `retirePullRequestDiscoveryChain` (5684-5700); precedent constant `RUN_CHAIN_ROOT_CTE` (~1174)
- **Summary**: Extract the duplicated cycle-guarded chain-tree traversal (walk to chain root, then down to all descendants) into a `RUN_CHAIN_TREE_CTE` constant, like the existing root-CTE constant. Do NOT unify the deliberately-different ancestor-only walk at ~6015 (documented perf shape; see the SQLite-CTE-materialization memory).
- **First seen**: 2026-09-14
- **Reason**: Runner-up candidate to `resolve-scheduled-dispatch-context` this run (20/25, within 1 point). Sits on the #746/#753 trackPullRequest surface (landed 2026-09-13). Borderline against "shared SQL string = pure DRY", but the ~20-line shared correctness invariant (cycle guard + root-find + descend) pushes it into a genuine seam. Natural next firing.

## handle-scheduled-dispatch-error

- **Status**: proposed
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
- **Files**: ~1-2 estimated
- **Modules**: `src/lifecycle/run-controller.ts` — near-identical post-dispatch `catch` in `executeStateAdvance` (~3089-3166) and `executeContinuation` (~3511-3573), structural cousins in `executeRetry`/`dispatchReviewFollowup`
- **Summary**: One teardown owning the `RegistryShutdownError`→cancel-parent-iff-`getRun`-undefined / `CapBreachedError|IssueReservedError`→warn+reschedule+`cancelRunAfterScheduleRefused` / else-rethrow window that #663/#674 fixed.
- **First seen**: 2026-09-14
- **Reason**: **Adjacent to `resolve-scheduled-dispatch-context`, same methods, natural follow-up.** The epilogue twin of this run's pick; deferred because taking both in one PR would double the blast on the hottest file. Ties the runner-up on raw score (20/25) but coupled to the pick, so it should follow it, not precede it.

## routine-claim-window-membership-seam

- **Status**: proposed
- **Score**: 19/25 (leverage 3, locality 4, blast radius 2, heat 5)
- **Files**: ~2 estimated
- **Modules**: `src/routines/dispatcher.ts` `confirmIssueClaimAction` (2460-2491), `observedNewPullRequestForBranch` (2999-3013); `src/routines/outcome.ts` `diffRoutineGithubSnapshots` (182-230)
- **Summary**: A single `didActionHappenInWindow` snapshot-membership predicate that both the routine-outcome diff and the claim verifier call, removing the prose-compensated open/close/new-PR-within-window drift (comments at 2456-2459 and 2987-2998 admit the mirror).
- **First seen**: 2026-09-14
- **Reason**: New find; on this fortnight's hot routine outcome-claim verification surface (#751/#754/#762/#756). Distinct from the backlog `routine-github-observation` (capture, not verification). Sub-20 this run.

## provider-validate-harness-seam

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 2, heat 4)
- **Files**: ~4 estimated
- **Modules**: `src/providers/codex.ts` (104-117), `src/providers/claude.ts` (69-78), `src/providers/omp.ts` (~134-143), `src/providers/provider-session.ts` (152-156)
- **Summary**: Fold each adapter's `validate` render→parse→spread into the `createProviderSession` harness via a `validateCommand?` config callback, leaving each adapter only its probe body; stops `validate` and `runAttempt` tokenizing the command independently.
- **First seen**: 2026-09-14
- **Reason**: New find on the Agent Provider Session surface. Sub-20 this run; low-friction mid-tier future candidate.

## issue-pr-label-editing-family

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~1 estimated
- **Modules**: `src/http/pages.ts` `renderIssueLabelsSection` (4953-4977) / `renderPullRequestLabelsSection` (5498-5522); banner twins ~4846/~5408
- **Summary**: One label-editing section taking `(route, idField, note)` that owns the "`sym:*` read-only, everything else gets CSRF + snapshot-repo remove/add forms" policy once (a comment at 5404 already admits the structural identity).
- **First seen**: 2026-09-14
- **Reason**: New find; line-for-line duplicate policy that can drift. Sub-20 this run.

## probe-shutdown-drift

- **Status**: dropped
- **Score**: n/a (not behaviour-preserving)
- **Files**: ~3 estimated
- **Modules**: `src/providers/codex.ts` `shutdownProbeProcess` (357-366), `src/providers/omp.ts` (~1506-1523)
- **Summary**: The two probe-shutdown paths differ — codex stops at SIGTERM, omp escalates SIGTERM→SIGKILL and destroys pipes.
- **First seen**: 2026-09-14
- **Reason**: Unifying would give codex omp's SIGKILL escalation — a **behaviour change**, not a preserving extraction. A correctness item (a codex app-server ignoring SIGTERM leaks), not a deepening candidate. Recorded so the next firing does not re-derive it as a refactor.

## tracked-pull-request-lookup

- **Status**: superseded
- **Score**: 20/25 (leverage 3, locality 4, blast radius 1, heat 5)
- **PR**: #747
- **Files**: ~3 estimated (`src/run-store.ts`, `src/lifecycle/run-controller.ts`, one store test)
- **Modules**: `src/run-store.ts` (`findTrackedPullRequestByIssue` 5770-5790 + its twin `findTrackedPullRequestByIssueAndBranch` 5800-5821, added by #736), sole branch-scoped caller `src/lifecycle/run-controller.ts` `observeWaitPullRequestSignals` 2024-2034; unaffected unscoped callers `src/http/pages.ts:3785,6754`, `src/lifecycle/file-overlap-guard.ts:303`
- **Summary**: Merge the issue-wide and branch-scoped Tracked-PR lookups into one `findTrackedPullRequestByIssue({issueNumber, projectName, branchName?})` where the Run Store owns branch-scoping and the "absent branch" notion (undefined and "" both unscoped); the wait re-eval caller drops its ternary, the twin is removed, and the #736 branch-scoping fix gains a unit test.
- **First seen**: 2026-09-11
- **Reason**: Picked by the 2026-09-11 run (top surviving candidate at 20/25; runner-up candidate `create-waiting-run-normalization` at 18/25, 2 points back — not within 1). Only candidate with this-week-hot lines (#736, 2026-09-10). Out of scope: the 16-column `tracked_pull_requests` select list is duplicated ~6× across run-store query methods (5782/5813/5832/5859 and below) — a shared column constant is a pure DRY cleanup, deliberately left for a follow-up so blast stays at 1. Implemented via design-it-twice winner A (optional `branchName?`, store owns "absent"); runner-up design C (typed `TrackedPrScope` union) lost on depth + blast. PR #747 opened 2026-09-11.
- **Superseded by**: #742 (merged 2026-09-11, later the same day), which fixed the *same* call site (`observeWaitPullRequestSignals`) for a different bug (issue #738: branch names are deterministic from the issue title and get reused across unrelated Run Chains, so branch-scoping itself was unsound) by replacing branch-scoped lookup with `findTrackedPullRequestForRunChain`. `findTrackedPullRequestByIssueAndBranch` — this candidate's entire "twin" — has no callers left on `main`, so the merge-the-twins design is moot. Autofix (`/pm-autofix-pr`) resolved PR #747's resulting merge conflict by adopting `main`'s run-chain-scoped resolution as-is and dropping this PR's branch-scoping unification and its pinning test (`tests/run-store-tracked-pull-request.test.ts`), whose #736 scenario is already covered by `tests/wait-for-pr-open.test.ts` ("issue #736 review, round 2") via the run-chain mechanism.

### Run 2026-09-11 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M26RZFX4` (adopted; conditions 1-4 held — non-default, 0 unique commits ahead of `origin/main`, no upstream, unpublished on origin). Not renamed per the adopted-branch rule; slug recorded here and in the report instead.
- **Committed**: report + backlog reconciliation + design section (`bcd8e2d`), implementation + CONTEXT.md term (`1e024c3`), this in-flight update.
- **Evidence**: PR #747; quality gate green (lint, typecheck, format:check, knip, build; test 2806 passed — no flakes this run). Diff 4 files (est. ~3: `run-store.ts`, `run-controller.ts`, one store test; the 4th is the `CONTEXT.md` term add, within tolerance). No published/exported interface changed. Reconciled `provider-run-harness` #701 → landed; re-scored `run-slot-lease` 19→16 on heat drop.
- **Next**: human review of #747; `create-waiting-run-normalization` (18/25, runner-up candidate) is the natural next firing.

## create-waiting-run-normalization

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~2-3 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (2660-2672, 5331-5343), `src/run-store.ts` (`createWaitingRun`)
- **Summary**: Two sites hand-normalize `branchName`/`workspacePath` before `createWaitingRun` and already diverge on what "absent" means (`row.branchName.length === 0` vs `input.branchName === undefined`); let `createWaitingRun` take `branchName?`/`workspacePath?` and normalize once, making the divergence unrepresentable. Same "store owns absent" shape as `tracked-pull-request-lookup`.
- **First seen**: 2026-09-11
- **Reason**: Runner-up candidate to `tracked-pull-request-lookup` this run (18/25, 2 points back). Natural next firing.

## schedule-wait-park-epilogue

- **Status**: proposed
- **Score**: 17/25 (leverage 3, locality 4, blast radius 1, heat 2)
- **Files**: ~1-2 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (2673-2683, 4670-4684, 5840-5850; consumer `executeWaitPark` 1663-1675, refusal `logWaitReevaluationRefused` 4164)
- **Summary**: Three sites repeat the identical `this.schedule({... kind: "wait_park" ...})` + `if (!scheduled) logWaitReevaluationRefused(...)` block, re-encoding the deliberately-asymmetric "wait-park logs-but-does-not-cancel on scheduler refusal" invariant; a private `scheduleWaitPark(...)` seam owns it once while each caller keeps its own row persistence.
- **First seen**: 2026-09-11
- **Reason**: Highest raw leverage of the 2026-09-11 scan, but held back by heat — the schedule blocks are cold (2026-05-13/18); only the `if(!scheduled)` refusal lines are recent (#674). In the hot file, on cold lines. Do NOT fold all 11 `this.schedule` sites — wait_park's log-only refusal is intentionally unlike the cancel-on-refusal of state_advance/retry.

## outcome-projection

- **Status**: landed
- **Score**: 23/25 (leverage 4, locality 5, blast radius 1, heat 5)
- **Files**: ~3 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (cluster at 4259-4392), new `src/lifecycle/outcome-projection.ts`, `src/lifecycle/classify-failure.ts` (produces `ClassifiedTerminal`)
- **Summary**: Extract the pure `ClassifiedTerminal → {RunState, terminal label, WorkflowPredicateMap}` projection cluster out of run-controller into a module beside its producer, mirroring `pr-signal-projection.ts`.
- **First seen**: 2026-08-31
- **PR**: #610
- **Reason**: PR #610 merged 2026-08-31 (reconciled from `in-flight` this run); `Outcome Projection` now defined in CONTEXT.md.

## codex-event-reducer

- **Status**: landed
- **Score**: 22/25 (leverage 5, locality 4, blast radius 2, heat 4)
- **Files**: 4 (`codex.ts`, new `codex-events.ts`, new `codex-json.ts`, new `codex-events.test.ts`)
- **Modules**: `src/providers/codex.ts` (`mapCodexJsonRpcMessage` + `thinkingEvent`/`progressMarkerEvent`/`jsonRpcErrorEvent`/`codexToolCallInput`/`isInputRequiredMethod` and field accessors), new `src/providers/codex-events.ts`, new `src/providers/codex-json.ts`
- **Summary**: Extract `mapCodexJsonRpcMessage` into a `createCodexEventReducer(...).reduce(raw)` closure so mapping is testable without spawning a fake app-server subprocess.
- **First seen**: 2026-08-31
- **PR**: #617
- **Reason**: Picked by the 2026-08-31 run (top surviving candidate at 22/25; tied with `claude-event-reducer`, won the recency tie-break). Implemented via design-it-twice winner C (stateful reducer closure); leaf JSON accessors split into `codex-json.ts`. PR #617 merged 2026-08-31T20:23:58Z (reconciled from `in-flight` by the 2026-09-01 run).

### Run 2026-08-31 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M1C8YVN8` (adopted; conditions 1-4 held — non-default, 0 unique commits, no upstream, unpublished on origin)
- **Committed**: report + backlog (`ac734a4`), design section (`99215f7`), implementation (`173c54e`), this in-flight update
- **Evidence**: PR #617; quality gate green (lint, typecheck, format:check, knip, test 2345 passed, build)
- **Next**: human review of #617; `claude-event-reducer` is the natural next firing (tied runner-up)

## claude-event-reducer

- **Status**: landed
- **Score**: 22/25 (leverage 5, locality 4, blast radius 2, heat 4)
- **Files**: 3 (`claude.ts`, new `claude-events.ts`, new `claude-events.test.ts`) — design-it-twice dropped the `claude-json.ts` split (below)
- **Modules**: `src/providers/claude.ts` (`mapClaudeStreamJsonMessage` at 193-264 + `mapSystemMessage`/`mapAssistantMessage`/`mapResultMessage`/`mapStreamEvent`/`isInputRequiredType`/`isInputRequiredTool`/`isTerminalFailure` and the leaf field accessors at 690-737), new `src/providers/claude-events.ts` (accessors kept private inside it — unlike `codex-json.ts`, no second consumer justifies a split)
- **Summary**: Extract `mapClaudeStreamJsonMessage` into a `createClaudeEventReducer().reduce(raw)` closure returning `ProviderEvent[]`, owning the `session_id` carry-forward internally, so mapping is testable without spawning a fake `claude` subprocess; sibling of `codex-event-reducer`.
- **First seen**: 2026-08-31
- **PR**: #627
- **Reason**: Picked by the 2026-09-01 run (top surviving candidate at 22/25; runner-up `issue-claim-label-writer` at 21/25, within 1 point). Sibling of the landed `codex-event-reducer` (#617); the `session_id` state is entirely mapping-internal (written only in `mapSystemMessage`, read only in the map functions), so the reducer needs no injected deps — cleaner than the codex closure. Implemented via design-it-twice winner (minimal stateful closure), corrected to keep the leaf accessors private inside `claude-events.ts` (no `claude-json.ts` split — a one-consumer hypothetical seam). PR #627 merged 2026-09-01T07:03:18Z (reconciled from `in-flight` by the 2026-09-02 run).

### Run 2026-09-01 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M1D161CG` (adopted; conditions 1-4 held — non-default, 0 unique commits, no upstream, unpublished on origin). Not renamed per the adopted-branch rule; slug recorded here and in the report instead.
- **Committed**: report + backlog reconciliation (`bacc70e`), design section (`8ec8cf0`), implementation + CONTEXT.md term (`a1b9141`), this in-flight update. Rebased onto `origin/main` (picked up #626) before push.
- **Evidence**: PR #627; quality gate green (lint, typecheck, format:check, knip, build; test 2386 passed). One unrelated pre-existing flake — `routine-workspace.test.ts > cancels clone and fetch helper process trees` (2000ms process-tree cancellation race; passes on retry; imports nothing this PR touches).
- **Next**: human review of #627; `issue-claim-label-writer` (21/25) is the natural next firing.

## artifact-kind-catalog

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~3 estimated
- **Modules**: `src/run-store.ts` (5711-5771 + descriptor builders at 4144, 5508), `src/http/pages.ts` (6907), `src/http/app.ts` (`RUN_ARTIFACT_CONTENT_TYPES` :363, `RUN_ARTIFACT_KINDS` :373, `resolveRoutineEvidenceFilePath` switch :1023 — a third site of the same catalog, folded into this item's scope by the 2026-09-04 fresh scan)
- **Summary**: Replace the parallel artifact-kind constructs (identical arrays, a set, path switches, a content-type map, a label switch) across run-store, pages, and app with one `{kind, column, label, contentType}` descriptor catalog.
- **First seen**: 2026-08-31

## routine-evidence-redaction

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~3 estimated
- **Modules**: `src/routines/dispatcher.ts` (2364-2437), possibly `src/routines/evidence.ts`
- **Summary**: Lift the secret-redaction + jsonl-serialize cluster (carrying the redact-before-stringify invariant) out of the dispatcher into a tested module.
- **First seen**: 2026-08-31

## coalesce-events

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 3, blast radius 1, heat 4)
- **Files**: ~2 estimated
- **Modules**: `src/http/pages.ts` (7020-7085), new `src/http/event-coalescing.ts`
- **Summary**: Promote the private Codex message-stream reducer `coalesceEvents` to a pure exported function so it is testable without HTML-substring assertions.
- **First seen**: 2026-08-31

## status-presentation

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 2, heat 4)
- **Files**: ~2 estimated
- **Modules**: `src/http/pages.ts` (3193-3247, 4133-4157, 5027-5078)
- **Summary**: Extract the scattered pure `*Family` state classifiers into `status-presentation.ts`, leaving the `*Pill` HTML wrappers in pages as thin adapters.
- **First seen**: 2026-08-31

## issue-claim-label-writer

- **Status**: landed
- **Score**: 21/25 (leverage 4, locality 4, blast radius 2, heat 5)
- **PR**: #668
- **Files**: ~3 estimated (new `claim-label-writer.ts`, new test, `run-controller.ts`)
- **Modules**: `src/lifecycle/run-controller.ts` — the terminal-outcome cluster only:
  `markIssueNeedsHuman` (`:4434`), `markIssueFailed` (`:4458`), `markIssueBlocked` (`:4484`),
  `applyTerminalLabels` (`:4510`), `releaseIssueClaim` (`:4642`), `rollbackScheduledRunClaimLabel`
  (`:2322`), `bestEffort` (`:5050`), `ApplyLabelsInput` (`:369`); new `src/lifecycle/claim-label-writer.ts`
- **Summary**: Lift the terminal-outcome `sym:*` label decision matrix (add-then-`human-needed` fallback,
  `input_required` special-case, cancelled/closed-issue cleanup, best-effort wrappers) out of the
  ~230-line terminal region behind a `ClaimLabelWriter.markTerminal(outcome)`/`.markFailed`/`.markBlocked`/`.release(phase)` seam.
- **First seen**: 2026-08-31
- **Reason**: Picked by the 2026-09-02 run (top surviving candidate at 21/25; runner-up `watchdog-subject-port` at 20/25, within 1 point). **Scope corrected that run**: the dispatch-time `sym:claimed`/`sym:running` *add* sites (interleaved with the dispatch mutex/slot logic) and the standalone `shutdown-resume.ts`/`stale-claims.ts` modules are deliberately **out of scope** — they are a different concern (asserting a claim under a lock; resume/stale sweeps with their own availability posture) from resolving a terminal outcome, and the `~3-4 file` estimate only ever fit the terminal cluster. ADR 0002/0077-adjacent but behaviour-preserving, so no contradiction. PR #668 merged 2026-09-02T05:20:03Z (reconciled from `in-flight` by the 2026-09-03 run).

### Run 2026-09-02 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M1FK9QZN` (adopted; conditions 1-4 held — non-default, 0 unique commits, no upstream, unpublished on origin). Not renamed per the adopted-branch rule; slug recorded here and in the report instead.
- **Committed**: report + backlog reconciliation (`080c1d7`), design section (`7b0dcd9`), implementation + CONTEXT.md term (`26f358d`), this in-flight update.
- **Evidence**: PR #668; quality gate green (lint, typecheck, format:check, knip, build; test 2501 passed). One unrelated pre-existing flake — `notification-daemon.test.ts > sends one invalid Routine alert across ten ticks and one recovery` (full-suite-load timeout; passes 4/4 in isolation; imports nothing this PR touches).
- **Next**: human review of #668; `watchdog-subject-port` (20/25) is the natural next firing.

## live-run-ownership-registry

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 4, blast radius 2, heat 4)
- **Files**: ~3 estimated
- **Modules**: `src/http/pages.ts` (`collectLiveRunEntries`/`findLiveRunIdForIssue`/`livePullRequestOwner*` at 3877-4045), `src/lifecycle/stale-claims.ts` (`LiveIssueKeys`/`collectLiveKeys` at 112-183)
- **Summary**: Two files each re-derive "which `(project, repo, issue)` has a live/claim-holding run" from an overlapping-but-not-identical source union; a shared liveness module would own the union.
- **First seen**: 2026-08-31
- **Reason**: Leverage capped: the two unions differ *by design* (`stale-claims` adds `listResumableShutdownRuns` and covers scheduled work via the in-memory registry per ADR 0088; `pages` resolves scheduled callbacks but omits resumable-shutdown, per ADR 0047/0089). Unifying them is a behavioural decision, not a behaviour-preserving extraction — bail territory for an unattended run until the target semantics are settled by a human.

## routine-github-observation

- **Status**: proposed
- **Score**: 17/25 (leverage 3, locality 4, blast radius 2, heat 3)
- **Files**: ~2 estimated
- **Modules**: `src/routines/dispatcher.ts` (`captureRoutineGithubSnapshot`/`routineGithubObservation`/`routineIssueObservations`/`routinePullRequestObservations` at 1808-1986), `src/routines/outcome.ts` (`diffRoutineGithubSnapshots` at 117)
- **Summary**: The GitHub-observation capture/shaping/availability-gating half lives in the dispatcher, away from the diff it feeds in `outcome.ts`; understanding one firing's GitHub detection means bouncing between the two.
- **First seen**: 2026-08-31

## snapshot-search

- **Status**: proposed
- **Score**: 15/25 (leverage 2, locality 3, blast radius 2, heat 4)
- **Files**: ~2 estimated
- **Modules**: `src/http/pages.ts` (`searchIssueSnapshots` at 4058-4127, `searchPullRequestSnapshots` at 5078)
- **Summary**: Snapshot filter/query/sort logic sits in the HTTP layer and reaches past the store seam (iterating `listProjectIssueSnapshots`, re-fetching per row, calling `resolveClaimedRunId` inline).
- **First seen**: 2026-08-31
- **Reason**: Borderline deletion test — much is genuinely presentation-shaped, so extraction risks moving complexity to route handlers rather than concentrating it. Couples into `live-run-ownership-registry`; revisit after that lands.

## watchdog-subject-port

- **Status**: landed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 2, heat 4)
- **Files**: 4 (new `watchdog-subject.ts`, new `watchdog-subject.test.ts`, `watchdog.ts`, `watchdog.test.ts` — the 4th an observer-throw characterization test)
- **Modules**: `src/lifecycle/watchdog.ts` (run reconcile loop 179-273, firing reconcile loop 275-345, `sampleRun` 475-502, `sampleRoutineFiring` 504-529); new `src/lifecycle/watchdog-subject.ts` (port + driver)
- **Summary**: Collapse the two near-identical ~85-line watchdog reconcile loops (run vs routine-firing, the second added by #622) into one `driveWatchdogSubject` driver behind a `WatchdogSubjectPort`; run-vs-firing knowledge lands in two thin adapters.
- **First seen**: 2026-09-02
- **PR**: #695
- **Reason**: **Picked by the 2026-09-03 run** (top surviving candidate at 20/25, tied with `provider-run-harness` at 20/25; won the deterministic tie-break — blast tie, heat tie, then `watchdog.ts` most-recently-touched at #680 15:51 vs providers #672 14:21). Terminal policy differs (ADR 0091: firings get idle-grace only), so the port carries a `terminalReason` member (`watchdogTerminalReason` for runs, idle-grace-only for firings). **Scope refined**: the twinned run-store method pairs (`run-store.ts:1571-1872`) stay put — the adapters call them; unifying their table-specific SQL is `leaked-subject-sweep`'s separate concern. Implemented via design-it-twice winner C (9-member port + generic driver); runner-up design A (single `terminate` member) lost on test surface. Added the `Watchdog Subject` term to CONTEXT.md. PR #695 merged 2026-09-03T08:49:52Z (reconciled from `in-flight` by the 2026-09-04 run).

### Run 2026-09-03 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M1J5Q8C7` (adopted; conditions 1-4 held — non-default, 0 unique commits, no upstream, unpublished on origin). Not renamed per the adopted-branch rule; slug recorded here and in the report instead.
- **Committed**: report + backlog reconciliation (`8116eb4`), design section (`72bdcd7`), implementation + CONTEXT.md term (`2db6413`), this in-flight update.
- **Evidence**: PR #695; quality gate green (lint, typecheck, format:check, knip, build; test 2626 passed — no flakes this run). Diff 4 files (est. ~3; the 4th is a behaviour-pinning test edit, within tolerance). `reconcileWatchdog` public signature unchanged.
- **Next**: human review of #695; `provider-run-harness` (20/25, tied runner-up) is the natural next firing.

## run-slot-lease

- **Status**: proposed
- **Score**: 16/25 (leverage 4, locality 3, blast radius 3, heat 2) — re-scored 2026-09-11 from 19/25: heat 5→2. Every deadline site is still `42a9d8bb` (#631, 2026-09-01); this week's raw-FSM wait-state PRs touched the separate claim-guard mechanism, not the deadline plumbing, so the lines have gone cold. Friction unchanged.
- **Files**: ~5 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (`RunSlotDeadline` factory 506-590, `createRunSlotDeadline`+ownership CAS 681-750, threaded through `dispatchOneFresh` 1146-1208, `claimAndPersistRun` 3126-3313, `runAttemptLifecycle` 3352-3653, `iterateAttempt` 4203-4290)
- **Summary**: A `RunSlotLease` owning build-from-policy+origin, scoped arm→clear, and the ownership CAS, concentrating three construction sites and the arm/clear bookkeeping that keep producing sequencing bugs (#655/#631/#653/#654).
- **First seen**: 2026-09-02
- **Reason**: Strong future candidate on recurring-bug evidence, but partial deletion test — each bounded op still names its own `.race()` at the call site, so complexity partially stays. Larger blast than the reducer/label picks.

## daemon-project-state-projection

- **Status**: proposed
- **Score**: 16/25 (leverage 3, locality 4, blast radius 2, heat 2)
- **Files**: ~3 estimated
- **Modules**: `src/daemon.ts:2191-2362` (`readProjectStateInputs`/`fallbackProjectStateInputs`/`projectStateInputFromReport`/`FromPrior`/`rawProjectMode`/`Weight`/`PollIdentityKey`), called from `persistProjectPollState` 2001-2048
- **Summary**: Extract the 4-way project_states row-precedence reconciliation into `project-state-projection.ts` (`rawConfig + status + priors → inputs`) so it has a unit seam; `readFile` stays in the daemon.
- **First seen**: 2026-09-02
- **Reason**: Clean extraction but coldest of the 2026-09-02 finds — project-poll-state is absent from recent commit themes, so heat caps it.

## provider-run-harness

- **Status**: landed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 2, heat 4)
- **PR**: #701
- **Files**: ~5 estimated (three providers + new `provider-session.ts` + test)
- **Modules**: `src/providers/codex.ts` (`runAttempt` prologue 118-186, `finally` 325-339, `cancel` 83-116), `src/providers/claude.ts` (73-143, 167-180, 54-71), `src/providers/omp.ts` (135-178, 319-328, 108-133); new `src/providers/provider-session.ts`
- **Summary**: Each provider's `runAttempt` opens with a byte-identical ~55-line ADR-0052 prologue (placeholder `activeRun` before the `wrapForProviderScope` await, cancel-recheck synthetic `process_exit`, spawn+stderr+queue) and closes with an identical ADR-0064 `finally` (delete → `stopProviderScope` → `waitForFlush`); a `runProviderSession(deps, input)` harness owns those once and takes the provider-specific protocol body + cancel-interrupt as hooks.
- **First seen**: 2026-09-03
- **Reason**: **Picked by the 2026-09-04 run** (top surviving candidate at 20/25; runner-up `run-slot-lease` at 19/25, within 1 point). Was the exactly-tied runner-up to last firing's `watchdog-subject-port` (#695, merged 2026-09-03). Friction re-verified against the current tree this run: prologue/`finally`/cancel still near-identical across codex/claude/omp; stderr-attach, `confirmProviderScopeCleanup`, and `waitForFlush` still byte-identical. **Divergence surface is wide** (activeRun factory, command transform, spawn env, cancel-interrupt body, synthetic-event shape all differ), so the harness needs ~6-7 hooks — real but depth-tempering. **Benign-drift finding (do not re-derive):** omp calls `stopProviderScope` on early-cancel (omp.ts:157) and adds a second `shutdownProviderProcess` in `finally` (omp.ts:326) that codex/claude omit, but `wrapForProviderScope` (`process-scope.ts:131`) only *builds* a `systemd-run` command — no durable scope exists pre-spawn — so it is a harmless no-op, not a behaviour decision. The harness can preserve all three via a hook; **not** `live-run-ownership-registry`-style bail territory. Implemented via design-it-twice winner C (common-case-optimised: `createProviderSession` + `jsonlProviderSession`); runner-up design A (minimal interface) lost on common-case depth (forced codex+claude to name the shared JSONL queue, spent a general hook on omp's fixed shutdown). Added the `Agent Provider Session` term to CONTEXT.md. PR #701 opened 2026-09-04; **merged 2026-09-04T06:40:48Z** (reconciled from `in-flight` by the 2026-09-11 run).

### Run 2026-09-04 — complete

- **Outcome**: complete
- **Stopped at**: step 6 — PR opened
- **Branch**: `sym/symphonika/routine/refactor-audit/01M1MR2N06` (adopted; conditions 1-4 held — non-default, 0 unique commits, no upstream, unpublished on origin). Not renamed per the adopted-branch rule; slug recorded here and in the report instead.
- **Committed**: report + backlog reconciliation (`62f9899`), design section (`80b4dc3`), implementation + CONTEXT.md term (`3b7d466`), this in-flight update.
- **Evidence**: PR #701; quality gate green (lint, typecheck, format:check, knip, build; test 2695 passed — no flakes this run). Diff 6 files (est. ~5: three providers + `provider-session.ts` + test; the 6th is the `CONTEXT.md` term add, within tolerance). `create{Codex,Claude,Omp}Provider` + `AgentProvider` signatures unchanged.
- **Next**: human review of #701; `run-slot-lease` (19/25, runner-up candidate) is the natural next firing.

## provider-attempt-runner

- **Status**: proposed
- **Score**: 18/25 (leverage 3, locality 3, blast radius 2, heat 5)
- **Files**: ~3-4 estimated
- **Modules**: `src/lifecycle/run-controller.ts` `iterateAttempt` (4340-4458), `src/routines/dispatcher.ts` (1449-1550), `src/provider-probe.ts` (28-90); possible new `src/lifecycle/provider-attempt.ts`
- **Summary**: Three sites build the same 15-field `ProviderRunInput` and repeat scratch-lifecycle + ADR-0052 cancel-recheck + per-event redact-and-persist around the `for await`.
- **First seen**: 2026-09-03
- **Reason**: Borderline deletion test — the input-builder and scratch/cancel scaffolding concentrate, but the *sink* (`persistProviderEvent` sequence rows vs `appendRoutineEvent` jsonl cursors) and deadline threading differ enough that complexity stays at the call site (same caveat class as `run-slot-lease`). Extract the input-builder + scaffolding, leave the sink injected; revisit after a provider consumer stabilises.

## leaked-subject-sweep

- **Status**: proposed
- **Score**: 15/25 (leverage 2, locality 3, blast radius 2, heat 4)
- **Files**: ~2-3 estimated
- **Modules**: `src/run-store.ts` `findLeakedRuns` (5695-5741) / `findLeakedRoutineFirings` (5779-5819), `markRunsStale` / `markRoutineFiringsFailed`
- **Summary**: A second run-vs-firing twin pair on the crash-recovery startup-sweep axis, outside `watchdog-subject-port`'s range, cross-referencing each other in comments.
- **First seen**: 2026-09-03
- **Reason**: Leans toward *moves* on the deletion test — the SQL differs by table (`runs` has a `stale` state and `leaked_active_run_cleanup_pending`; `routine_firings` settle as `failed` with their own pending marker and `commits_ahead` case), so a shared port pushes differences into adapters rather than concentrating behaviour. Fold into the run-vs-firing duality story that `watchdog-subject-port` opens rather than picking standalone.

## config-project-parse-outcome

- **Status**: proposed
- **Score**: 17/25 (leverage 3, locality 4, blast radius 1, heat 3)
- **Files**: ~3 estimated
- **Modules**: `src/reload.ts` (`loadDispatchProject` 1095-1195, `loadRoutineHostProject` 1200-1263; shared idiom at 651, 696), possible new `src/reload/project-config-parse.ts`
- **Summary**: The dispatch-project and routine-host loaders are drifting twins repeating a byte-identical SPEC-5.1 watchdog-override whole-snapshot-rejection block (1121-1136 vs 1218-1233, second annotated `// Same …`) and a structurally identical reload-vs-first-load fatal-decision block; a shared `parseProjectSection` + `watchdogOverrideGate` seam would own both invariants once, leaving each loader its distinct tail.
- **First seen**: 2026-09-04
- **Reason**: New find by the 2026-09-04 fresh scan. Partial deletion test — the two invariants concentrate but the surrounding zod-error-push idiom and the loaders' tails (dispatch: polling + workflow load + `disabled`; host: `agent` + `mode`, no workflow) genuinely differ and stay separate. Sub-20, so not this firing's pick; natural mid-tier future candidate in an otherwise cold-for-the-backlog file.

## wait-terminal-contract

- **Status**: dropped
- **Score**: n/a (deletion test moves)
- **Files**: ~3 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (`reEvaluateWaitingRun` advance-to-terminal 2553-2585, direct-terminate 2740-2765; `applyWorkflowOutcome` advance-to-terminal 5303-5316)
- **Summary**: The ADR-0058 blocked/succeeded terminal contract is implemented three times — two wait paths call `terminalizeBlocked`, the provider path returns `terminalLabel` for outcome-projection + `ClaimLabelWriter.applyTerminal`.
- **First seen**: 2026-09-11
- **Reason**: Deletion test **moves** — the synchronous store+label wait mechanism and the projection-driven provider mechanism are genuinely different; unifying touches the just-landed #610 outcome-projection module. Adjacency risk, not a seam. Surfaced and dropped by the 2026-09-11 scan.

## blocked-terminalization-phase

- **Status**: dropped
- **Score**: n/a (leverage low — dedup not deepening)
- **Files**: ~1 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (`terminalizeBlocked` 1921-1938, `terminalizePullRequestDiscoveryExhausted` 1875-1897)
- **Summary**: Two near-exact terminalize twins differing only in a `release({phase})` argument.
- **First seen**: 2026-09-11
- **Reason**: `phase` is a **log tag only** — verified in `claim-label-writer.ts:300-321` that it does not drive behaviour (`deferReleaseToScheduler` keys off `outcome.kind === "success"`, not phase). Collapsing is a ~5-line dedup; complexity mostly stays. Not a deepening candidate.

## raw-fsm-park-ownership

- **Status**: dropped
- **Score**: n/a (already deep)
- **Files**: ~1 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (`isIssueOwnedByWorkflow`/`isIssueParkedAtRawFsmState`/`throwIfIssueParkedAtRawFsmState`/`loadRawFsmWorkflow` 1701-1829)
- **Summary**: The raw-FSM park-ownership predicates.
- **First seen**: 2026-09-11
- **Reason**: Already consolidated around the shared `isIssueParkedAtRawFsmState` predicate; the fail-open (ownership) vs fail-closed (guard) split is documented as intentional. No seam to add — deleting it would move real complexity back to callers, not concentrate it.

## wait-state-predicate-split

- **Status**: dropped
- **Score**: n/a (leverage low)
- **Files**: ~2 estimated
- **Modules**: `src/workflow/types.ts:12` (`isIssueContentActionKind`), `src/lifecycle/run-controller.ts` (`isParkedAction` 6266, `isArtifactOnlyWaitState` 6315)
- **Summary**: The three "what kind of wait/park state" predicates are split across two files.
- **First seen**: 2026-09-11
- **Reason**: Leverage low — concentrating them concentrates little behaviour; the two run-controller-private predicates are legitimately local to their callers. Noted for completeness so the next firing does not re-derive it.

## mutate-and-publish

- **Status**: dropped
- **Score**: n/a (leverage 1)
- **Files**: ~1 estimated
- **Modules**: `src/run-store.ts` — 17 of the 32 `this.database.transaction(...)` blocks end in `const apply = …; this.publishAll(apply())` (e.g. 5757-5776, 1272, 1343, 2047, 4487)
- **Summary**: A repeated transaction-then-publish epilogue that a `mutateAndPublish(fn)` helper could collapse.
- **First seen**: 2026-09-03
- **Reason**: Leverage 1 — the helper would be shallow (interface ≈ implementation), concentrating no behaviour. Same character as the dropped `provider-json-field-accessors`: a plain DRY cleanup, not a deepening candidate.

## issue-polling-try-api-wrappers

- **Status**: dropped
- **Score**: n/a (leverage 1)
- **Files**: ~1 estimated
- **Modules**: `src/issue-polling.ts` (the ~11 `try*` API wrappers at 880-991: `tryAddLabelsToIssue`, `tryGetIssue`, `tryListPullRequests`, …)
- **Summary**: Each wrapper is ~10 lines of `if (api.method === undefined) return sentinel; return api.method(input)`.
- **First seen**: 2026-09-04
- **Reason**: Leverage 1 — shallow-by-nature guards (interface ≈ implementation), same class as the dropped `provider-json-field-accessors`/`mutate-and-publish`. Collapsing to a generic invoker MOVES the guard, strips the `this` binding (see the explicit warning at :875-878), and the sentinel types differ (`false` vs `undefined`). Not a deepening candidate. Surfaced and rejected by the 2026-09-04 fresh scan; recorded so the next firing does not re-derive it.

## github-pr-enum-normalizers

- **Status**: dropped
- **Score**: n/a (leverage 1)
- **Files**: ~1 estimated
- **Modules**: `src/issue-polling.ts` (1573-1625)
- **Summary**: Four GraphQL enum-whitelist switches feeding `RawGitHubPullRequestFollowupState`.
- **First seen**: 2026-08-31
- **Reason**: Leverage 1 — fails the deletion test. The switches are tightly bound to the GraphQL query strings in the same file; extracting them separates the parse from the query it parses, so complexity would move, not concentrate.

## provider-json-field-accessors

- **Status**: dropped
- **Score**: n/a (leverage 1)
- **Files**: ~3 estimated
- **Modules**: `src/providers/codex.ts` (1230-1279), `src/providers/claude.ts` (690-737), `src/routines/dispatcher.ts` (2584-2600)
- **Summary**: `field`/`objectField`/`stringField`/`numberField`/`booleanField` are byte-for-byte triplicated across two providers and the routine dispatcher.
- **First seen**: 2026-08-31
- **Reason**: Leverage 1 — a DRY cleanup, not a depth win. The helpers are shallow by nature (interface ≈ implementation); sharing them concentrates no behaviour, so it fails the deletion test *as a deepening candidate*. Worth doing as a plain de-duplication, but it is not this skill's kind of work.

## concurrency-cap-admission-policy

- **Status**: landed
- **Score**: n/a (landed before `.architecture/` existed)
- **Files**: `src/lifecycle/concurrency-capacity.ts`
- **Summary**: Shared concurrency-cap admission policy (`evaluateConcurrencyCapacity` + cap predicates) removing 5 duplicated dispatch-decision sites.
- **First seen**: 2026-08-26
- **PR**: #578
- **Reason**: Landed by an earlier refactor-audit firing (pre-backlog); recorded for dedup.

## run-store-json-columns

- **Status**: landed
- **Score**: n/a (landed before `.architecture/` existed)
- **Files**: `src/run-store-json-columns.ts`
- **Summary**: Snapshot JSON-array-column codec (`encodeJsonArrayColumn`/`decodeJsonArrayColumn`) + private row mappers, removing ~9 inline empty-array⇄NULL ternaries.
- **First seen**: 2026-08-27
- **PR**: #580
- **Reason**: Landed by an earlier refactor-audit firing (pre-backlog); recorded for dedup.

## jsonl-provider-stream-queue

- **Status**: landed
- **Score**: n/a (landed before `.architecture/` existed)
- **Files**: `src/providers/jsonl-process-queue.ts`
- **Summary**: Shared jsonl provider stream queue extracted from the Codex/Claude provider loops.
- **First seen**: 2026-08-25
- **PR**: #568
- **Reason**: Landed by an earlier refactor-audit firing (pre-backlog); recorded for dedup.
