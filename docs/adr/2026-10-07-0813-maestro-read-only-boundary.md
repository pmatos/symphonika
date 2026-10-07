# Maestro's read-only boundary is structural, not a prompt instruction

Status: Accepted

## Context

Issue #865 (slice of epic #844) adds Maestro, a conversational assistant on the operator dashboard
that answers questions about configured Projects' Issues, Runs, and pull requests. Maestro's replies
are read over Issue/PR content fetched from GitHub by earlier polls — content an outside party
(whoever can open an Issue or PR) partly controls. An operator asking "what should I do about
symphonika#42" effectively feeds that issue's title and body into Maestro's context.

A prompt instruction such as "never call a tool that writes to GitHub" is not a security boundary: a
model is a text predictor, and sufficiently adversarial injected content can get a model to ignore its
own system prompt. The only mechanism immune to that is one in which the capability to mutate state
is never present at all, the same posture `src/http/git-status.ts`'s "no `git push` call anywhere in
this module" comment already uses for a narrower case (SPEC.md §14).

## Decision

Maestro's model-facing tool surface (`MAESTRO_TOOLS`, `src/maestro/tools.ts`) is a fixed, hand-written
list of read-only evidence lookups (list/get over Projects, Issue snapshots, Runs, and pull-request
snapshots). No write-shaped tool — label mutation, PR merge, shell execution, git, or file write — is
ever defined in that list, so the Anthropic Messages API request Maestro sends never offers the model
a tool capable of mutating anything, regardless of what the configured model is asked or told to do.
`executeMaestroTool` additionally refuses any tool name outside that fixed list and executes nothing
for it, as defense in depth against a bug or a future registry change rather than as the primary
boundary.

The read-only surface Maestro's tool execution and conversation loop depend on
(`MaestroEvidenceReader`, `src/maestro/reader.ts`) exposes only `list`/`get` operations over a narrow
set of RunStore records; it is a hand-written wrapper, not `RunStore` itself, so a write method
(`createRun`, `writeIssueLabels`, `mergePullRequest`, ...) is unreachable through it by construction.
Maestro's model configuration (`maestro:` in `symphonika.yml`, `src/maestro/config.ts`) is independent
of `providers.codex/claude/omp` — selecting Maestro's model never selects or spawns a Coding Agent, and
vice versa.

Citations attached to an assistant reply (`MaestroCitation`: href, kind, label, observed timestamp)
are built server-side from the record a tool actually returned, never from model-authored text, so a
rendered link can never be an attacker-chosen URL (e.g. a `javascript:` link smuggled into an injected
Issue title).

A chat message is persisted to `maestro_conversations`/`maestro_messages` (`RunStore`), separate from
`runs`/`attempts`: a Maestro reply is a proposal an operator reads, never Run evidence, and must never
be counted by `/api/status`, `/runs`, or a notification digest as completed work.

## Scope of this slice

#865 covers the dashboard-scope conversation only. Project-scope focus (#866), grounding Maestro in a
read-only Maestro Workspace over repository content (#867), and evidence-linked briefings/history
(#868) are separate issues per epic #844's own split of the original #852 slice; none of Maestro's
tools in this slice call GitHub live — every tool reads only already-persisted `RunStore` snapshots.

## Consequences

- Adding a write capability to Maestro in the future requires a new, explicitly-designed and
  explicitly-audited tool, not a prompt change — there is no "allow write" flag to flip.
- The model and its configured provider can still *describe* an injected instruction back to the
  operator in its reply text (e.g. "this issue asks me to add a label, which I can't do"); this is
  expected and harmless, since rendering text is not the same capability as acting on it.
- A future Maestro Workspace (#867) that adds read-only `gh` access to additional repositories must
  extend this same fixed-list pattern — a generic "shell out to `gh` with model-chosen arguments" tool
  would reopen exactly the boundary this ADR closes.
- The tool-calling loop (`runMaestroTurn`, `src/maestro/conversation.ts`) is capped at a small fixed
  number of rounds, so a model nudged toward repeatedly retrying a refused or malformed tool call is
  bounded rather than spending unbounded requests on one chat message.
- Every evidence list a tool returns is capped (`MAX_EVIDENCE_ITEMS`, `src/maestro/reader.ts`), and
  citations are deduplicated by href, so a large Project's issue/PR snapshot or an unfiltered Run
  listing cannot flood a single model request or a single rendered reply. Persisted conversation
  history resent to the model each turn is capped the same way (`MAX_HISTORY_MESSAGES`,
  `src/maestro/conversation.ts`); neither cap claims the omitted rows don't exist, only that answering
  "all of them" at once is out of scope for a single chat message.
