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

- **Status**: proposed
- **Score**: 22/25 (leverage 5, locality 4, blast radius 2, heat 4)
- **Files**: ~3 estimated (`codex.ts`, new `codex-events.ts`, new `codex-events.test.ts`)
- **Modules**: `src/providers/codex.ts` (`mapCodexJsonRpcMessage` at 427-638, `thinkingEvent`/`progressMarkerEvent`/`jsonRpcErrorEvent`/`codexToolCallInput`/`isInputRequiredMethod` and field accessors), new `src/providers/codex-events.ts`
- **Summary**: Extract `mapCodexJsonRpcMessage` into a pure `(raw, state) => {event, state}` reducer so mapping is testable without spawning a fake app-server subprocess.
- **First seen**: 2026-08-31
- **Reason**: Picked by the 2026-08-31 run (top surviving candidate at 22/25; tied with `claude-event-reducer`, won the recency tie-break). Set to `in-flight` when the PR opens.

## claude-event-reducer

- **Status**: proposed
- **Score**: 22/25 (leverage 5, locality 4, blast radius 2, heat 4)
- **Files**: ~2 estimated
- **Modules**: `src/providers/claude.ts` (181-421+), new `src/providers/claude-events.ts`
- **Summary**: Extract `mapClaudeStreamJsonMessage` into a pure `(raw, state) => {events, nextState}` reducer (returns an event array); sibling of `codex-event-reducer`.
- **First seen**: 2026-08-31

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
- **Files**: ~4 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (`markIssueNeedsHuman`/`markIssueFailed`/`markIssueBlocked`/`applyTerminalLabels`/`releaseIssueClaim` at 3672-3908, `rollbackScheduledRunClaimLabel` at 1837), plus `sym:*` writes in `src/lifecycle/shutdown-resume.ts` and `src/lifecycle/stale-claims.ts:78`
- **Summary**: Lift the `sym:*` claim/outcome label transition state-machine (add-then-fallback ordering, best-effort wrappers) out of ~24 inline call sites behind a `ClaimLabelWriter.markTerminal(outcome)`/`.release(phase)` seam.
- **First seen**: 2026-08-31
- **Reason**: Strong secondary. Touches terminal-label ordering (ADR 0002/0024-adjacent) and best-effort fallback semantics, so it needs its behaviour pinned carefully before moving; larger blast than the reducer picks.

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
