# Agent Instructions

This repository contains Symphonika, a fresh TypeScript/Node orchestrator inspired by the upstream
Symphony reference spec.

## Source of Truth

- Start with `SPEC.md`; it is the implementation contract for Symphonika.
- Use `CONTEXT.md` for project language and domain boundaries.
- Use `docs/adr/` for accepted architectural decisions.
- Treat `symphony/` as an upstream reference submodule, not as the Symphonika implementation.

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

### Issue tracker

Issues live in GitHub Issues at `pmatos/symphonika` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Mapped to existing repo labels (`agent-ready`, `needs-human`, `wontfix`) with new `needs-triage` / `needs-info`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
