# Agent Instructions

This repository contains Symphonika, a fresh TypeScript/Node orchestrator inspired by the upstream
Symphony reference spec.

## Source of Truth

- Start with `SPEC.md`; it is the implementation contract for Symphonika.
- Use `CONTEXT.md` for project language and domain boundaries.
- Use `docs/adr/` for accepted architectural decisions.
- Treat `symphony/` as an upstream reference submodule, not as the Symphonika implementation.

### ADR numbering

`docs/adr/0001-*.md` through the existing sequential range are frozen legacy
numbers — don't renumber or reuse a number from that range, and don't try to
resolve the duplicate numbers already in there (several numbers have more
than one file; that's pre-existing history, not something to fix here). Name
new ADRs `docs/adr/YYYY-MM-DD-HHMM-slug.md` instead (UTC, 24h clock),
timestamped when the ADR is authored, and reference one in prose or comments
as `ADR-YYYY-MM-DD-HHMM`. A bare date isn't enough here — several ADRs can
land in one day — but two authors can't independently pick the same
real-world minute the way they could pick the same next integer, so there's
no more numbering-collision class to guard against in CI —
`scripts/check-adr-numbers.mjs` and the branch ruleset's "ADR numbers"
required check existed only for that and have been removed.

## Implementation Posture

- Keep changes aligned with the bootstrap slice in `SPEC.md`.
- Preserve the v1 requirement to support both Codex and Claude providers.
- Keep GitHub issue eligibility label-based unless a later ADR changes it.
- Keep provider execution full-permission by default; future sandboxing belongs outside providers.
- Store orchestration evidence outside agent workspaces.

## Workflow

- Prefer small vertical slices with tests.
- Update `SPEC.md`, `CONTEXT.md`, or `docs/adr/` when implementation work resolves a domain or
  architecture decision.
- Do not silently change the upstream `symphony/` submodule unless the task explicitly asks for it.

## Quality Gate

Before opening a PR, run each of these as a separate command (never `&&`-chained):

- `npm run lint`
- `npm run typecheck`
- `npm run format:check`
- `npm run knip`
- `npm test`
- `npm run build`

`format:check` (prettier) is easy to miss since it's not part of `lint` here — a diff can pass lint
and typecheck while still failing it. If it flags a file the current change didn't touch, leave that
file alone; only fix formatting in files the diff already modifies.

`knip` is the other easy one to miss, and it fails in a way nothing else catches: its project scope
is `src/**` only, so a symbol exported and used *only* by a test — or only by its own module — is
reported as an unused export and fails CI. The usual fix is to drop the `export` keyword rather than
to add a knip exception.

PR titles must follow Conventional Commits (`type: subject`, e.g. `feat: ...`, `fix: ...`) with a
lowercase subject — the "Lint PR title" workflow enforces this on open/edit/reopen/synchronize
(mirrors `commitlint.config.cjs`'s subject-case rule), so a plain-English or capitalized title fails
CI immediately. Set it correctly in `gh pr create --title "..."` up front rather than fixing it after
the check fails.

## Agent skills

### Workflow-design skill

`skills/symphonika-workflow/` (SKILL.md, REFERENCE.md, EXAMPLES.md) helps design and write a
Workflow Contract. `docs/workflows.md` is the canonical authoring reference for the FSM's syntax and
semantics — action kinds, predicates, `workflow.use` templates, templating variables, providers,
terminal states; REFERENCE.md is a thin, deliberately non-duplicative pointer into it, not an
independent source of facts. Both go stale silently: nothing fails CI when either drifts from
`src/workflow/`, `src/lifecycle/run-controller.ts`, or `src/builtin-templates.ts`. Whenever a change
in this PR alters FSM syntax or semantics — a new/removed action kind, predicate, provider, template,
templating variable, or terminal-state behavior — update `docs/workflows.md` in the same PR, and
update `skills/symphonika-workflow/` if the change affects something REFERENCE.md/EXAMPLES.md
summarizes independently (action-kind list, predicate list, provider list, built-in template names).
When unsure whether a change qualifies, diff both docs' claims against the touched source rather than
guessing.

### Issue tracker

Issues live in GitHub Issues at `pmatos/symphonika` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Mapped to existing repo labels (`agent-ready`, `needs-human`, `wontfix`) with new `needs-triage` / `needs-info`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
