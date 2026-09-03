# Architecture deepening backlog

Persisted candidate memory for `pm-deepen` refactor-audit runs. Each firing
reconciles this file against merged/open PRs, reuses existing slugs so the dedup
filter holds, and never deletes entries. Statuses change; rows stay.

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
- **Modules**: `src/run-store.ts` (5711-5771 + descriptor builders at 4144, 5508), `src/http/pages.ts` (6907)
- **Summary**: Replace the six parallel artifact-kind constructs (two identical arrays, a set, two identical path switches, a label switch) with one `{kind, column, label}` descriptor catalog.
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
- **Score**: 19/25 (leverage 4, locality 3, blast radius 3, heat 5)
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

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 2, heat 4)
- **Files**: ~5 estimated (three providers + new `provider-session.ts` + test)
- **Modules**: `src/providers/codex.ts` (`runAttempt` prologue 118-186, `finally` 325-339, `cancel` 83-116), `src/providers/claude.ts` (73-143, 167-180, 54-71), `src/providers/omp.ts` (135-178, 319-328, 108-133); new `src/providers/provider-session.ts`
- **Summary**: Each provider's `runAttempt` opens with a byte-identical ~55-line ADR-0052 prologue (placeholder `activeRun` before the `wrapForProviderScope` await, cancel-recheck synthetic `process_exit`, spawn+stderr+queue) and closes with an identical ADR-0064 `finally` (delete → `stopProviderScope` → `waitForFlush`); a `runProviderSession(deps, input)` harness owns those once and takes the provider-specific protocol body + cancel-interrupt as hooks.
- **First seen**: 2026-09-03
- **Reason**: **Picked by the 2026-09-04 run** (top surviving candidate at 20/25; runner-up `run-slot-lease` at 19/25, within 1 point). Was the exactly-tied runner-up to last firing's `watchdog-subject-port` (#695, merged 2026-09-03). Friction re-verified against the current tree this run: prologue/`finally`/cancel still near-identical across codex/claude/omp; stderr-attach, `confirmProviderScopeCleanup`, and `waitForFlush` still byte-identical. **Divergence surface is wide** (activeRun factory, command transform, spawn env, cancel-interrupt body, synthetic-event shape all differ), so the harness needs ~6-7 hooks — real but depth-tempering. **Benign-drift finding (do not re-derive):** omp calls `stopProviderScope` on early-cancel (omp.ts:157) and adds a second `shutdownProviderProcess` in `finally` (omp.ts:326) that codex/claude omit, but `wrapForProviderScope` (`process-scope.ts:131`) only *builds* a `systemd-run` command — no durable scope exists pre-spawn — so it is a harmless no-op, not a behaviour decision. The harness can preserve all three via a hook; **not** `live-run-ownership-registry`-style bail territory.

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

## mutate-and-publish

- **Status**: dropped
- **Score**: n/a (leverage 1)
- **Files**: ~1 estimated
- **Modules**: `src/run-store.ts` — 17 of the 32 `this.database.transaction(...)` blocks end in `const apply = …; this.publishAll(apply())` (e.g. 5757-5776, 1272, 1343, 2047, 4487)
- **Summary**: A repeated transaction-then-publish epilogue that a `mutateAndPublish(fn)` helper could collapse.
- **First seen**: 2026-09-03
- **Reason**: Leverage 1 — the helper would be shallow (interface ≈ implementation), concentrating no behaviour. Same character as the dropped `provider-json-field-accessors`: a plain DRY cleanup, not a deepening candidate.

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
