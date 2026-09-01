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

- **Status**: proposed
- **Score**: 21/25 (leverage 4, locality 4, blast radius 2, heat 5)
- **Files**: ~3 estimated (new `claim-label-writer.ts`, new test, `run-controller.ts`)
- **Modules**: `src/lifecycle/run-controller.ts` — the terminal-outcome cluster only:
  `markIssueNeedsHuman` (`:4434`), `markIssueFailed` (`:4458`), `markIssueBlocked` (`:4484`),
  `applyTerminalLabels` (`:4510`), `releaseIssueClaim` (`:4642`), `rollbackScheduledRunClaimLabel`
  (`:2322`), `bestEffort` (`:5050`), `ApplyLabelsInput` (`:369`); new `src/lifecycle/claim-label-writer.ts`
- **Summary**: Lift the terminal-outcome `sym:*` label decision matrix (add-then-`human-needed` fallback,
  `input_required` special-case, cancelled/closed-issue cleanup, best-effort wrappers) out of the
  ~230-line terminal region behind a `ClaimLabelWriter.markTerminal(outcome)`/`.markFailed`/`.markBlocked`/`.release(phase)` seam.
- **First seen**: 2026-08-31
- **Reason**: Picked by the 2026-09-02 run (top surviving candidate at 21/25; runner-up `watchdog-subject-port` at 20/25, within 1 point). **Scope corrected this run**: the dispatch-time `sym:claimed`/`sym:running` *add* sites (interleaved with the dispatch mutex/slot logic) and the standalone `shutdown-resume.ts`/`stale-claims.ts` modules are deliberately **out of scope** — they are a different concern (asserting a claim under a lock; resume/stale sweeps with their own availability posture) from resolving a terminal outcome, and the `~3-4 file` estimate only ever fit the terminal cluster. ADR 0002/0077-adjacent but behaviour-preserving, so no contradiction.

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

- **Status**: proposed
- **Score**: 20/25 (leverage 4, locality 4, blast radius 2, heat 4)
- **Files**: ~4 estimated
- **Modules**: `src/lifecycle/watchdog.ts` (run reconcile loop 179-273, firing reconcile loop 275-345, `sampleRun` 475-502, `sampleRoutineFiring` 504-529), twinned run-store method pairs `src/run-store.ts:1558-1688`
- **Summary**: Collapse the two near-identical ~85-line watchdog reconcile loops (run vs routine-firing, the second added by #622) into one `reconcileSubject` driver behind a `WatchdogSubject` port; run-vs-firing knowledge lands in two thin adapters.
- **First seen**: 2026-09-02
- **Reason**: Runner-up candidate to `issue-claim-label-writer` this run (within 1 point). Natural next firing. Terminal policy differs (ADR 0091: firings get idle-grace only), so the port must carry a `terminalPolicy` member.

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
