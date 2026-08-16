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
- `npm test`
- `npm run build`

`format:check` (prettier) is easy to miss since it's not part of `lint` here — a diff can pass lint
and typecheck while still failing it. If it flags a file the current change didn't touch, leave that
file alone; only fix formatting in files the diff already modifies.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `pmatos/symphonika` (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Mapped to existing repo labels (`agent-ready`, `needs-human`, `wontfix`) with new `needs-triage` / `needs-info`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
