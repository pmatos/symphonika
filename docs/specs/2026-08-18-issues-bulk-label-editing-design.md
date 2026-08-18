# Issues Page: Bulk Multi-Select Label Editing

Status: proposed
Date: 2026-08-18

## Context

The `/issues` triage page (`src/http/pages.ts`, `renderIssueSearchPage`) lists every polled issue
across configured Projects — currently unpaginated, all matching rows render in one table (73 rows
in the default filter as of this writing). Per-issue label add/remove already exists, but only on
the single-issue detail page (`/issues/:project/:number`), one label at a time, via a plain HTML
`<form method="post">` (`renderIssueLabelsSection`, `POST /issues/:project/:number/labels/add|remove`).
That write path already:

- Rejects `sym:*` labels server-side (`isOrchestratorLabel` — those are orchestrator-owned per
  ADR 0002/0024 and edited only by Symphonika itself).
- Goes through `options.writeIssueLabels` (`WriteIssueLabelsFn`), which wraps `octokit.rest.issues
  .addLabels` / `.removeLabel` (`src/issue-polling.ts`).
- Is protected by `requireAuthorizedMutation` / CSRF (ADR 0075), and is documented by ADR 0077
  ("Issue Triage: Snapshot-Backed Search, Verdicts, and Label Writes").
- Reflects labels from the persisted poll snapshot (`project_issue_snapshots`, ADR 0073), not a
  live GitHub read — so the table's Labels column is normally accurate within one poll interval,
  not necessarily the instant after a write.

This work adds the ability to select multiple issues on the `/issues` list page and add/remove one
or more labels across all of them in one action.

This also introduces the project's first client-side framework and build step: React, bundled with
esbuild. Every other page on this dashboard is either plain server-rendered HTML or, for the one
existing interactive view (`/runs/:id/graph`, ADR 0056), vanilla JS with CDN-loaded, SRI-pinned
libraries and no build step. `SPEC.md` §3's stack list has no bundler or frontend framework, and
§2's non-goals list still says "a separate/standalone rich frontend application (SPA)" — written
during the v1 bootstrap slice and stale relative to where the project is now. This spec treats that
non-goal as needing an update, not as a blocker: the scope here stays a small, server-rendered-page-
embedded island (not a client-routed app fetching JSON, and not a rewrite of the existing filter/
search rendering), so it doesn't reintroduce what that non-goal was actually protecting against.
`SPEC.md` §3 and §2 both get updated as part of this work, alongside a new ADR.

## Goals

- Select any subset of the issues currently rendered on `/issues` (checkboxes + "select all on this
  page").
- Add and/or remove one or more labels across every selected issue in a single action.
- `sym:*` labels remain blocked from this UI, exactly as they are today for single-issue edits.
- Partial failure is visible per-issue (e.g. "11 succeeded, 1 failed: sym:blocked is
  orchestrator-owned") rather than silently dropped or an all-or-nothing abort.
- No change to how `/issues` filters, searches, or paginates — this is additive to the existing
  table.

## Non-Goals

- Making the Labels column reflect a bulk write instantly (it still reflects the poll snapshot, per
  ADR 0073/0077 — same behavior as the existing single-issue edit today).
- Any change to which labels are orchestrator-owned or to the dispatch eligibility predicate
  (`evaluateProjectEligibility`, `src/issue-polling.ts`).
- Issue dependency visualization / agent-ready gating — a related but materially different design
  (structured dependency data doesn't exist anywhere yet) being brainstormed separately.
- Migrating the rest of `/issues` (search, filters, table rendering) to React. The table stays
  server-rendered HTML; React owns only the selection/toolbar/bulk-form layer.

## Architecture

**New dependencies:** `react`, `react-dom`, `@types/react`, `@types/react-dom` (runtime deps);
`esbuild` (dev dep). esbuild is chosen over Vite/webpack because it needs no dev server (pages are
already server-rendered by Hono) and matches this project's existing preference for small, fast,
low-config tooling (`tsx` for dev, `tsc` for the server build).

**Build:** a new entry point `src/client/issues-bulk.tsx` is bundled by esbuild into one
self-contained IIFE, `dist/client/issues-bulk.js` — React itself is bundled in, not CDN-loaded, so
the page has no external runtime dependency (unlike the CDN+SRI pattern `/runs/:id/graph` uses for
cytoscape, which is a reasonable choice for a big graph-rendering library but unnecessary here for
a small, fully-owned component). `package.json` gets a `build:client` script (esbuild invocation)
and `build:server` (today's `tsc -p tsconfig.build.json && chmod +x dist/cli.js`); `build` runs
both, `dev` runs `build:client` once before `tsx src/cli.ts` so `npm run dev` keeps working
standalone. Each quality-gate step stays a separate command per this repo's convention — the
existing `lint`/`typecheck`/`format:check`/`test`/`build` sequence is unchanged, `build` just does
more work internally.

**Serving:** `src/http/app.ts` adds one narrow route, `GET /assets/issues-bulk.js`, that streams
`dist/client/issues-bulk.js` with `content-type: application/javascript`. This is not a general
static-file server — just this one generated asset.

**Page wiring:** mirrors the existing `/runs/:id/graph` pattern (`renderWorkflowGraphPage`,
`WORKFLOW_GRAPH_CLIENT_JS`, `serializeGraphForScript`). `renderIssueSearchPage` adds:
- A checkbox cell in each row (`<input type="checkbox" data-project="..." data-issue="...">`),
  present in the server-rendered HTML so the page has a sane no-JS fallback shape (checkboxes just
  don't do anything without the script — no bulk form is rendered server-side, since the whole
  bulk-write flow is React-owned per your direction to take on the build step rather than keep a
  parallel plain-form implementation).
- A mount point, `<div id="issues-bulk-root"></div>`, placed above or below the table.
- `<script>window.__ISSUES__ = ${json}; window.__CSRF_TOKEN__ = "${csrfToken}";</script>` — the
  same "serialize server data into a global, then load the client script" shape
  `serializeGraphForScript` already uses. `__ISSUES__` is the array of currently-rendered rows
  (`projectName`, `issueNumber`, `title`, `labels`) — enough for the React island to build its
  selection state and the label-autocomplete source without a second network request.
- `<script src="/assets/issues-bulk.js"></script>`.

**React island (`src/client/issues-bulk.tsx`):** owns:
- Selection state (a `Set` of `"${projectName}:${issueNumber}"` keys), driven by the checkboxes it
  attaches listeners to (it does not re-render the table rows themselves — it reads/writes the
  `checked` state of the server-rendered checkboxes directly, keeping the table's HTML as the
  source of truth for row content).
- A toolbar showing "`N` selected" once `N > 0`.
- A multi-label picker for labels to add and labels to remove, with autocomplete suggestions drawn
  from the distinct labels present in `window.__ISSUES__` (no new label-listing API — the existing
  "no GitHub Search API calls" note on this page stays true; this reads already-fetched snapshot
  data, not a fresh call).
- An "Apply" action that `POST`s to `/api/issues/bulk-labels` as JSON, with the CSRF token as an
  `X-CSRF-Token` header (the fetch-driven-caller convention ADR 0075 already defines, distinct from
  the hidden-form-field convention the plain single-issue form uses).
- Rendering the per-issue result summary once the response comes back (which issues succeeded,
  which failed and why), without attempting to rewrite the table's Labels column (see Non-Goals).

## API

`POST /api/issues/bulk-labels`, behind `requireAuthorizedMutation` (same middleware every other
mutating route uses).

Request:

```json
{
  "operations": [
    { "projectName": "symphonika", "issueNumber": 469 },
    { "projectName": "symphonika", "issueNumber": 468 }
  ],
  "addLabels": ["agent-ready"],
  "removeLabels": ["needs-triage"]
}
```

Validation and execution order:

1. If `addLabels` or `removeLabels` contains any `sym:*` label, the whole request is rejected with
   `400` before any writes happen — this is a request-shape error (the client should never have
   offered it), not a per-issue outcome, so it's checked once, matching how the existing single-issue
   form already refuses before writing.
2. If `operations` is empty, or both `addLabels` and `removeLabels` are empty, `400`.
3. Otherwise, each operation calls the existing `writeIssueLabels` independently, with a
   concurrency cap (~4 in flight at a time) rather than fully sequential or fully parallel — fast
   without bursting the GitHub API.
4. Every operation runs regardless of whether earlier ones failed (best-effort, per the product
   decision above) — one issue hitting a GitHub-side error doesn't block the rest of the batch.

Response — always `200` if the request itself was well-formed; failures are per-issue, not
transport-level:

```json
{
  "results": [
    { "projectName": "symphonika", "issueNumber": 469, "ok": true },
    { "projectName": "symphonika", "issueNumber": 468, "ok": false, "error": "..." }
  ]
}
```

The core logic (validate → partition → concurrency-limited writes → collect results) lives in a
small, pure-ish function (e.g. `applyBulkIssueLabels` in `src/http/pages.ts` or a new
`src/issues/bulk-labels.ts`, decided at implementation time based on which keeps `pages.ts`'s
route handler thin) that takes `writeIssueLabels` as a parameter — directly unit-testable without
spinning up Hono, mirroring how `writeIssueLabels`/`describeIssueVerdict` are tested today.

## Error Handling

- Malformed request body (missing `operations`, wrong types) → `400` with a message, no writes
  attempted.
- `sym:*` label requested → `400`, no writes attempted (see Validation step 1 above).
- Per-issue GitHub API failure (rate limit, issue not found, label doesn't exist, network error)
  → that operation's result has `ok: false` and an `error` string; every other operation still
  runs.
- `options.writeIssueLabels` unavailable (mirrors the existing single-issue "label writes are
  unavailable" case, e.g. no GitHub token configured) → `503`, no per-issue attempt.

## Testing

- Unit tests for the bulk-write core function: empty selection, empty labels, `sym:*` rejection,
  mixed success/failure across operations, concurrency cap respected (no more than N in-flight
  writes at once against a fake `writeIssueLabels` that tracks concurrent calls).
- Route-level test hitting `POST /api/issues/bulk-labels` directly (request validation, CSRF
  enforcement via `requireAuthorizedMutation`, response shape).
- React island test using `happy-dom` (already a dev dependency, already used this way for
  `tests/dashboard-live-client.test.ts`'s hand-written client script): render the component,
  simulate checkbox selection and label entry, assert the `fetch` call's body and
  `X-CSRF-Token` header, assert the result summary renders from a mocked response.

## Docs Follow-Up

- New ADR: bulk label writes (extends ADR 0077's write-boundary decisions to a multi-issue form)
  and the React/esbuild addition to the client-side stack (extends ADR 0056's embedded-visualization
  guardrails — this is a second case of client-side interactivity on a server-rendered page, this
  time via a bundled framework rather than vendored/CDN vanilla JS, which ADR 0056 didn't
  anticipate).
- `SPEC.md` §3 (Implementation Stack): add React + esbuild.
- `SPEC.md` §2 (Non-Goals): the "separate/standalone rich frontend application (SPA)" line should
  be clarified the same way ADR 0056 already clarified "loads client-side JavaScript" — this
  doesn't become a client-routed app or fetch its data as JSON; the table stays server-rendered.
