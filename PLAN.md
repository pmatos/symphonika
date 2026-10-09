# Plan: Issue Run Chain graph as a secondary evidence drill-down (#860)

## Goal
Add an optional, collapsed visual FSM graph to each Run Chain on `GET /issues/:project/:number` that highlights the current state and traversed transitions and links nodes to the same server-rendered timeline evidence (#859). The timeline stays the primary, complete explanation; the graph is progressive enhancement with no graph-only status or control.

## Assumptions
- Graph lives on the **Issue page, per Run Chain** (not the existing standalone `/runs/:id/graph`, which stays untouched): best-effort decision — AC says "an Issue's state" and "timeline evidence", both Issue-page concepts (best guess).
- Client code is an **inline plain-string script + CDN cytoscape/dagre with SRI**, reusing the `/runs/:id/graph` precedent (`WORKFLOW_GRAPH_SCRIPTS`), not a new React/esbuild entry: SPEC §13 / ADR-0056 require embedded visualizations to be self-contained with graceful degradation, and the precedent already carries SRI hashes (best guess). No new ADR; ADR-0056 already governs.
- **Keyboard access is provided by a server-rendered state outline** (`<details>` per state), not by making the canvas keyboard-navigable. The canvas gets `aria-hidden`-style treatment plus a pointer to the outline. Best guess: native `<details>/<summary>/<a>` are keyboard- and no-JS-accessible for free; canvas a11y in cytoscape is poor.
- Graph per chain = the **leaf's nearest captured graph** (same `nearestGraphs[leafIndex]` already computed in `loadIssueRunChainViews`). States the chain visited that are absent from that graph (mid-chain workflow edit) are listed in the outline as "not in the captured graph" and rendered as `missing` nodes; the existing `workflowChangedMidChain` note already explains why.
- Traversed transitions are derived from **consecutive timeline rows** (row[i].stateId → row[i+1].stateId), the only recoverable evidence (see header comment of `src/issues/run-chain-timeline.ts`). Rows with `stateId === undefined` (`not_recorded`) break the walk; no edge is guessed across the gap. A pair maps to every declared transition between those two states.
- Real-browser verification is not possible here (Playwright/chrome-devtools MCP fail in issue workspaces); coverage is happy-dom client tests + HTTP-seam tests. Stated in PR body.

## Key Files
| File | Role | Lines of Interest |
|------|------|-------------------|
| `src/issues/run-chain-timeline.ts` | Pure timeline derivation; gets the new pure graph-evidence builder (or sibling `run-chain-graph.ts`) | `deriveChainStateRows` (~L106), `findWorkflowStateNode` (~L290), `resolveProviderSource` (~L310) |
| `src/issues/run-chain-graph.ts` [new] | Pure `buildChainGraphEvidence(rows, graph)` → visits per state, traversed pairs, current state, missing states | consumes `ChainStateRow`, `ExpandedWorkflow` |
| `src/http/pages.ts` | `loadIssueRunChainViews` (L4739), `renderChainRow` (L4868), `renderIssueRunChainView` (L4916), `renderIssueRunChainSection` (L4939), `WORKFLOW_GRAPH_SCRIPTS` (L7293, stays module-private), `escapeJsonForInlineScript` (L7540), `STYLES` (L2930 `@media (max-width: 640px)`) | add row ids, outline, mount, styles |
| `src/http/chain-graph-client.ts` [new] | Exports `CHAIN_GRAPH_CLIENT_JS` string (cytoscape wiring); keeps `pages.ts` (7.5k lines) from growing further | pattern: `WORKFLOW_GRAPH_CLIENT_JS` (pages.ts L7297) |
| `tests/issue-run-chain-timeline.test.ts` | HTTP-seam tests; helpers `setup`, `writeGraph`, `IMPLEMENT_THEN_WAIT_GRAPH`; L1014 test asserts `not.toContain("<script")` over `Run Chain</h2>…</main>` | must be narrowed (see Step 6) |
| `tests/issue-run-chain-graph.test.ts` [new] | Unit tests for the builder | |
| `tests/chain-graph-client.test.ts` [new] | happy-dom client tests, modeled on `tests/workflow-graph-client.test.ts` | |
| `SPEC.md` | §13 paragraph at ~L3269 (`GET /issues/:project/:number` timeline) and ~L2979 (embedded visualization rule) | |
| `docs/adr/0056-embedded-interactive-operator-visualizations.md` | Governing guardrails (read-only, server-rendered, self-contained, degrades gracefully) | no edit expected |

## Steps (ordered TDD slices; run each slice red → green before the next)

### 1. Pure graph-evidence builder
- **Test first**: `tests/issue-run-chain-graph.test.ts` [new]. Behaviors: (a) rows implement→review_wait→done yield visited = those 3 states, traversed pairs `implement→review_wait`, `review_wait→done`, current = leaf state with its **row kind**; (b) a loop (implement→review→implement) records two visits for `implement` and one pair per hop; (c) a `not_recorded` row yields no pair across the gap; (d) a visited state absent from the graph is reported in `missingStateIds`; (e) undefined graph → `undefined` (no drill-down); (f) non-array `states` handled safely (mirror the `findWorkflowStateNode` guard); (g) **`pending_handoff` leaf**: its `row.stateId` is the handoff *target*, not what it ran — the executed state is the parent's stamp (or root `graph.initial`), and the target is reported as a separate "handed off, not dispatched" edge, never as an executed visit; (h) **consecutive rows in the same state** (Continuation / PR follow-up) produce no edge and are flagged "continued in place"; (i) a consecutive pair with **no declared transition** in the captured graph (escalation, mid-chain edit) is flagged `undeclared`, not dropped and not mapped onto unrelated edges; (j) an escalated-to-blocked chain (fixtures at `issue-run-chain-timeline.test.ts` L389/L455) reports current kind `blocked` even though the borrowed graph node is a green `terminal: success`.
- **Code**: `src/issues/run-chain-graph.ts` [new] `buildChainGraphEvidence({rows, graph})` returning `{ current: {stateId, kind}, states: [{id, visits: rowIndex[]}], traversed: [{from, to, declared, kind: "transition" | "handoff_pending"}], missingStateIds }`. Executed state is derived **per row kind** (see `deriveChainStateRows` comments), never uniformly from `row.stateId`. **Reuses** `findWorkflowStateNode` (`run-chain-timeline.ts:290`), `ChainStateRow`.

### 2. Stable timeline anchors
- **Test first**: extend `tests/issue-run-chain-timeline.test.ts` (new `describe` for #860): each state `<tr>` has a unique `id` namespaced by chain root run id (two chains on one Issue → no duplicate ids; ids pass through `escapeHtml`).
- **Code**: `renderChainRow` (`pages.ts:4868`) gets `id="chain-<rootRunId>-state-<index>"`; pass `rootRunId`/index through `IssueRunChainRowView`. No separate "Transitions taken" list: the existing row order plus Evidence column already carry it, and the outline (Step 3) lists traversed transitions per state.

### 3. Server-rendered state outline (keyboard + no-JS drill-down)
- **Test first** (same file): for a chain with a captured graph, response contains a collapsed `<details>` "Graph drill-down (optional)" per chain with one `<details>` per graph state showing: the graph's **declared** action kind/provider/prompt only, complete-when, declared transitions (traversed ones marked; `undeclared` and "continued in place" noted), and a **per-visit list** `href="#chain-…-state-N"` where each visit shows that row's own effective provider and source (`row.attempts.at(-1)?.providerName` + `describeProviderSource`, already in `IssueRunChainRowView`) — never the leaf graph's provider (would reintroduce mid-chain misattribution #859 avoided). Current state is marked in text with the **row kind** pill (`renderChainRowStatusPill`), not color alone; visited-but-missing states listed as "not in captured graph"; chain with no graph → no drill-down section; loop state links to every visit.
- **Code**: `renderChainGraphDrilldown(view, evidence)` in `pages.ts`; reuses `describeProviderSource` (`pages.ts:4850`), `renderChainRowStatusPill`, and the predicate formatter from `renderUpcomingSection` (extract to a shared helper, not duplicated). Add `evidence` to `IssueRunChainView` in `loadIssueRunChainViews`.

### 4. Graph mount + embedded data + styles (still inert without script)
- **Test first**: response includes a `<div class="chain-graph" data-…>` canvas container per chain and a `<script type="application/json">` blob (escaped via `escapeJsonForInlineScript`; assert a state id containing `</script>` cannot break out) carrying graph, current `{stateId, kind}`, traversed pairs (with `declared`), visit→anchor map; the escalated-to-blocked fixtures (L389/L455) show current kind `blocked`; CDN tags (`WORKFLOW_GRAPH_SCRIPTS`) emitted once per page and only when ≥1 chain has a graph; layout CSS has a `max-width` rule stacking canvas over outline.
- **Code**: mount inside the drill-down `<details>`; import the CDN script tags (`WORKFLOW_GRAPH_SCRIPTS`) into the page output from `pages.ts` itself (no new `export`, knip); add `CHAIN_GRAPH_STYLES` (canvas `height: 60vh; min-height: 320px`, full-width, `@media (max-width: 720px)` single column, visible `:focus-visible` outline on summaries) and append alongside existing page styles.

### 5. Client script: highlight, link, degrade
- **Test first**: `tests/chain-graph-client.test.ts` [new] (happy-dom, stub `cytoscape`/`dagre`/`cytoscapeDagre` like `tests/workflow-graph-client.test.ts`): (a) elements carry `current`, `visited`, and `traversed` classes (nodes and edges) per the embedded data, and the current node's styling class comes from the embedded **row kind** (blocked/terminal/waiting/running/input_required/pending_handoff), not the graph node's `terminal` flavor (escalated-to-blocked fixture shows blocked, not green); `undeclared` pairs get no edge highlight; (b) lazy init: cytoscape not constructed until the test **manually dispatches** `toggle` on the opened drill-down `<details>` (don't rely on happy-dom firing it); (c) `tap` on a node opens the matching outline `<details>` and moves focus to its summary (and exposes a "View in timeline" link whose href is the row anchor); (d) *optional, drop if tight*: selecting an outline summary highlights the node (node→timeline linking is what the AC requires); (e) `cytoscape` undefined → outline remains, an "Interactive graph unavailable; use the state list" note is shown, no throw; (f) cytoscape constructor throws → same fallback. **Negative checks**: before relying on (e)/(f), temporarily break the guard and confirm the test fails (avoid vacuous passes).
- **Code**: `src/http/chain-graph-client.ts` [new] `CHAIN_GRAPH_CLIENT_JS`; handles multiple chains per page (one cy per mount); element-building mirrors `WORKFLOW_GRAPH_CLIENT_JS` (pages.ts:7297) but takes data from the JSON blob; no state-changing requests, no form/controls beyond fit/re-layout (convenience only). Inline it in `layout`-adjacent output via the same pattern as `renderWorkflowGraphPage`.

### 6. Reconcile the #859 no-script assertion
- `tests/issue-run-chain-timeline.test.ts:1014-1090` slices `Run Chain</h2>`→`</main>` and asserts no `<script`; the new mount/scripts live in that range. Narrow the slice to end at the drill-down section start (the assertion's intent: the timeline itself needs no JS) and add a positive assertion that the timeline still renders "Waiting"/"Finished: success" with the drill-down JSON removed from the string. Do this in the same commit as Step 4.

### 7. Docs
- `SPEC.md` ~L3269: add paragraph for the drill-down (secondary, collapsed, per chain; anchors; outline; traversed edges derived from consecutive rows; degrades to timeline + outline; no graph-only control). Note at ~L2979 that the Issue page also embeds such a visualization.
- `CONTEXT.md`: only if a term is needed; default is no change. `docs/workflows.md`/`skills/symphonika/*`: no FSM syntax change → untouched.

## Testing
- New: `tests/issue-run-chain-graph.test.ts`, `tests/chain-graph-client.test.ts`; extended `tests/issue-run-chain-timeline.test.ts`.
- Gate (each separately): `npm run lint`, `npm run typecheck`, `npm run format:check` (only files the diff touches), `npm run knip` (new exports must be used by `src/**`, not only tests — drop `export` otherwise), `npm test` (known flakes: routine-workspace / notification-daemon under full-suite load — verify in isolation), `npm run build`.

## Risks
- **Loop states / repeated visits**: one node, many timeline rows → node links go to the latest visit with all visits listed in the outline; covered by Step 1(b)/3.
- **Workflow edited mid-chain**: graph is the leaf's; earlier visited states may be absent → shown as missing/"not in captured graph", never silently dropped.
- **Graph status contradicting the timeline (AC4)**: current-node styling is driven by timeline row kind; escalated-blocked fixtures cover it.
- **`pending_handoff` / same-state continuation / undeclared pairs**: handled explicitly in Step 1 rather than as a false or dropped edge.
- **`not_recorded`/legacy rows**: no traversed edge across gaps; honest labeling preserved (#859 AC3).
- **`<script>` injection**: graph content (state ids, prompts) is operator-authored but rendered through `escapeJsonForInlineScript`/`escapeHtml`; tested in Step 4.
- **Multiple chains / duplicate DOM ids**: namespaced by chain root run id; tested in Step 2.
- **Hidden-container sizing**: cytoscape initialised lazily on `<details>` open to avoid a zero-size canvas.
- **Existing test coupling** (Step 6) and `pages.ts` size; the `knip` rule about test-only exports applies to new types: new client/builder code lives in separate modules.
- Cannot verify in a real browser here; documented in PR.

## Out of scope
- Changing or merging the standalone `GET /runs/:id/graph` page (stays as is); no refactor of `WORKFLOW_GRAPH_CLIENT_JS`.
- Provider-plan selection, Start/recovery controls, or any mutating action (other #844 slices).
- Canvas-native keyboard navigation (outline is the keyboard path), SSE live updates of the graph, multi-hop "predicted path" overlays, bundling cytoscape locally.
- New ADR (ADR-0056 covers it), skill/workflow-doc edits, Maestro work.
