# Issues Page: Bulk Label Writes, and a React Client Island

Status: Accepted

## Context

The `/issues` triage page (ADR 0077) lists every polled issue across configured Projects and lets
an operator add or remove one label at a time on a single issue's detail page
(`/issues/:project/:number`). Selecting several issues and relabeling them together required
repeating that one-at-a-time flow per issue. See the design spec at
`docs/specs/2026-08-18-issues-bulk-label-editing-design.md` for the full design discussion; this
ADR records the two decisions from that spec that other work in this codebase needs to know about.

## Decision

### The bulk write extends ADR 0077's write boundary, not a new one

`POST /api/issues/bulk-labels` reuses the exact write path the single-issue form already uses
(`options.writeIssueLabels`, the `sym:*` guard from ADR 0002/0024) and the same
`requireAuthorizedMutation` CSRF gate (ADR 0075) every mutating route already goes through. A
request naming any `sym:*` label is rejected wholesale, before any write is attempted, matching the
single-issue form's own behavior. Per-issue writes are otherwise best-effort: one issue's GitHub-side
failure (rate limit, deleted label) doesn't block the rest of the selection, and the response reports
success or failure per issue rather than an all-or-nothing outcome. Writes run through a small
worker-pool concurrency cap (four in flight) rather than fully sequential or fully parallel, so a
large selection doesn't burst the GitHub API.

### React, bundled by esbuild, is now part of this codebase's client-side stack -- scoped to one page

Every other page here is server-rendered HTML; the one prior exception (the `/runs/:id/graph`
workflow-graph view, ADR 0056) is vanilla JS with CDN-loaded, SRI-pinned libraries and no build step.
This is this codebase's first client-side framework and its first build step: `src/client/
issues-bulk.tsx` is bundled by esbuild (`scripts/build-client.mjs`) into one self-contained IIFE,
`dist/client/issues-bulk.js` -- React included in the bundle, not CDN-loaded. `GET /assets/
issues-bulk.js` (`src/http/pages.ts`) serves it, read from disk relative to the compiled module's own
location so the same relative path resolves correctly whether the server is running from `dist/`
(production) or via `tsx` from `src/` (development).

This is deliberately scoped, not a general adoption of a frontend framework across the dashboard:

- `renderIssueSearchPage` (`src/http/pages.ts`) still server-renders the table, filters, and search
  form exactly as before. React owns only the selection checkboxes' behavior, the "N selected"
  toolbar, the label-picker form, and rendering the bulk write's per-issue results -- it does not
  fetch or own the issue list itself, which the server still embeds via `window.__ISSUES__`
  (the same "serialize server data into a global, then load a script" shape ADR 0056's
  `WORKFLOW_GRAPH_CLIENT_JS` already uses).
- No other page gained a build step or a framework dependency as part of this work.
- `SPEC.md` §3's stack list is updated to name React and esbuild, scoped to this one client bundle,
  not as a general-purpose addition available to every future page without its own justification.

`SPEC.md` §2's "no separate/standalone rich frontend application (SPA)" non-goal, written during the
v1 bootstrap slice, is updated for the same reason ADR 0056 updated it once already: this doesn't
become a client-routed application fetching its own data over JSON -- the table stays server-rendered,
same as ADR 0056's own narrowing of that non-goal to mean "no separate SPA," not "no client-side
interactivity."

### `tsconfig.json` stays Node-only; the browser code gets its own project

`tsconfig.json` (the server) has no `dom` lib and no `jsx` option -- adding those globally would let
DOM globals (`window`, `document`) leak into server-side type-checking without a real boundary.
`src/client/tsconfig.json` (a real, standalone `tsconfig.json` placed inside `src/client/`, not a
differently-named sibling config) carries `jsx: "react-jsx"` and DOM libs instead. Placing it inside
the directory it covers, rather than naming it e.g. `tsconfig.client.json` at the repo root, is what
lets typescript-eslint's project service auto-discover it by directory walk -- the project service
supports exactly one process-wide `defaultProject` fallback, so two differently-named root-level
tsconfig files fighting over that single fallback silently mis-resolves whichever one didn't win (this
was tried and reverted during this work: it broke type resolution for the pre-existing `fuzz/*.mjs`
default-project files). `tests/client/tsconfig.json` mirrors the same pattern for the one `.tsx` test
file, kept in its own `tests/client/` directory so its directory-nearest config doesn't also capture
every other (plain `.ts`) file already under `tests/`.

## Numbering

ADR `0079` (GitHub Releases and self-update) is the most recent number in tree; this ADR is `0080`.
