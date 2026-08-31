# Architecture deepening backlog

Persisted candidate memory for `pm-deepen` refactor-audit runs. Each firing
reconciles this file against merged/open PRs, reuses existing slugs so the dedup
filter holds, and never deletes entries. Statuses change; rows stay.

## outcome-projection

- **Status**: proposed
- **Score**: 23/25 (leverage 4, locality 5, blast radius 1, heat 5)
- **Files**: ~3 estimated
- **Modules**: `src/lifecycle/run-controller.ts` (cluster at 4259-4392), new `src/lifecycle/outcome-projection.ts`, `src/lifecycle/classify-failure.ts` (produces `ClassifiedTerminal`)
- **Summary**: Extract the pure `ClassifiedTerminal → {RunState, terminal label, WorkflowPredicateMap}` projection cluster out of run-controller into a module beside its producer, mirroring `pr-signal-projection.ts`.
- **First seen**: 2026-08-31

## codex-event-reducer

- **Status**: proposed
- **Score**: 22/25 (leverage 5, locality 4, blast radius 2, heat 4)
- **Files**: ~2 estimated
- **Modules**: `src/providers/codex.ts` (410-651), new `src/providers/codex-events.ts`
- **Summary**: Extract `mapCodexJsonRpcMessage` into a pure `(raw, state) => {events, nextState}` reducer so mapping is testable without spawning a fake app-server subprocess.
- **First seen**: 2026-08-31

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

## github-pr-enum-normalizers

- **Status**: dropped
- **Score**: n/a (leverage 1)
- **Files**: ~1 estimated
- **Modules**: `src/issue-polling.ts` (1573-1625)
- **Summary**: Four GraphQL enum-whitelist switches feeding `RawGitHubPullRequestFollowupState`.
- **First seen**: 2026-08-31
- **Reason**: Leverage 1 — fails the deletion test. The switches are tightly bound to the GraphQL query strings in the same file; extracting them separates the parse from the query it parses, so complexity would move, not concentrate.

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
