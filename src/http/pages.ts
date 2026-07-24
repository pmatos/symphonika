import { Hono } from "hono";

import type {
  FilteredProjectIssueSnapshot,
  IssuePollStatus
} from "../issue-polling.js";
import {
  formatCapReachedReason,
  parseCapReachedReason
} from "../lifecycle/terminal-reason.js";
import type {
  ListRunsFilter,
  ProjectState,
  ProviderEventRecord,
  RunArtifactDescriptor,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";
import type { RoutineStatus } from "../routines/types.js";
import type { StatusSnapshot } from "../status.js";
import type { ExpandedWorkflow } from "../workflow.js";
import { BUNDLED_FONTS, getBundledFont, getFontHash } from "./fonts.js";

export type RegisterPagesOptions = {
  app: Hono;
  getPullRequestFollowupPolicy?: () => {
    maxReviewDispatchesPerPr: number;
  };
  getStatusSnapshot?: () => StatusSnapshot;
  issuePollStatus?: IssuePollStatus;
  runStore: RunStore;
  version: string;
};

export type PullRequestFollowupAttention = {
  attention: "cap_reached";
  dispatchCount: number;
  maxDispatches: number;
  prNumber: number;
  prUrl: string;
};

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "cancelled",
  "failed",
  "blocked",
  "input_required",
  "stale",
  "succeeded"
]);

const KNOWN_RUN_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "preparing_workspace",
  "running",
  "input_required",
  "failed",
  "blocked",
  "succeeded",
  "cancelled",
  "stale"
]);

const FAILURE_STATES: ReadonlySet<RunState> = new Set(["failed", "stale"]);

// Runs whose outcome banner should render, but with the calmer "blocked"
// family/copy rather than the alarming "failed" one — see issue #271.
const BLOCKED_STATES: ReadonlySet<RunState> = new Set(["blocked"]);

// A single run's detail view is cheap to render; coalescing streamed message
// tokens collapses hundreds of rows into a handful, so fetch a generous tail.
const EVENT_TAIL_LIMIT = 500;

export function registerPages(options: RegisterPagesOptions): void {
  options.app.get("/assets/fonts/:file", (context) => {
    // The URL carries a per-weight content hash so the immutable one-year cache
    // is safe: regenerating the font changes the hash, which changes the URL.
    const match = /^ibm-plex-mono-(\d+)\.([0-9a-f]+)\.woff2$/.exec(
      context.req.param("file")
    );
    const weight = match?.[1];
    const hash = match?.[2];
    if (
      weight === undefined ||
      hash === undefined ||
      getFontHash(weight) !== hash
    ) {
      return context.notFound();
    }
    const bytes = getBundledFont(weight);
    if (bytes === undefined) {
      return context.notFound();
    }
    return new Response(bytes, {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": "font/woff2"
      },
      status: 200
    });
  });

  options.app.get("/", (context) => {
    const snapshot = options.getStatusSnapshot?.();
    const recentRuns = options.runStore.listRuns({ limit: 25 });
    const html = layout(
      "Symphonika",
      [
        `<h1 class="page-title">Dashboard</h1>`,
        renderHeader(options.version, snapshot),
        renderProjectsCard(snapshot, options.issuePollStatus),
        renderRoutinesTable(
          options.runStore.listRoutines({
            includeInactive: context.req.query("include_inactive") === "true"
          })
        ),
        renderStaleIssuesCard(options.issuePollStatus?.filteredIssues ?? []),
        renderRunsTable("Recent runs", recentRuns)
      ].join("")
    );
    return context.html(html);
  });

  options.app.get("/runs", (context) => {
    const filter: ListRunsFilter = {};
    const stateParam = context.req.query("state");
    if (
      stateParam !== undefined &&
      KNOWN_RUN_STATES.has(stateParam as RunState)
    ) {
      filter.state = stateParam as RunState;
    }
    const project = context.req.query("project");
    if (project !== undefined) {
      filter.project = project;
    }
    const runs = options.runStore.listRuns(filter);
    const title =
      filter.state === undefined ? "All runs" : `Runs (${filter.state})`;
    const html = layout(
      title,
      `<h1 class="page-title">Runs</h1>${renderRunsTable(title, runs)}`
    );
    return context.html(html);
  });

  options.app.get("/runs/:id", async (context) => {
    const id = context.req.param("id");
    const detail = options.runStore.getRun(id);
    if (detail === undefined) {
      return context.html(
        layout(
          "Run not found",
          `<h1 class="page-title">Run not found</h1><p class="lede">Run <code>${escapeHtml(id)}</code> was not found in the run store.</p>`
        ),
        404
      );
    }

    // Fetch one extra row so we can distinguish "exactly EVENT_TAIL_LIMIT
    // events, nothing cut" from "more than EVENT_TAIL_LIMIT, truncated" — the
    // count label must not claim truncation when none happened.
    const tailDesc = options.runStore.listProviderEvents(id, {
      limit: EVENT_TAIL_LIMIT + 1,
      order: "desc"
    });
    const eventsTruncated = tailDesc.length > EVENT_TAIL_LIMIT;
    const events = tailDesc.slice(0, EVENT_TAIL_LIMIT).reverse();
    const isFailure =
      FAILURE_STATES.has(detail.state) || BLOCKED_STATES.has(detail.state);
    const terminalAttempt = detail.attempts[detail.attempts.length - 1];
    const failureEvent = isFailure
      ? options.runStore.getLastFailureEvent(id, terminalAttempt?.id)
      : undefined;
    // Scope to the terminal attempt for the same reason failureEvent is: an
    // earlier attempt's abnormal process_exit must not be attributed to the
    // terminal failure (e.g. a stale run whose terminal attempt was killed via
    // the watchdog DB update and never emitted its own process_exit).
    const exitEvent = isFailure
      ? findLast(
          events,
          (event) =>
            event.normalized.type === "process_exit" &&
            event.attemptId === terminalAttempt?.id
        )
      : undefined;
    const artifacts = options.runStore.listRunArtifacts(id);
    const workflowGraph = await options.runStore.getWorkflowGraph(id);
    const capKind = parseCapReachedReason(detail.terminalReason);
    const capContext =
      capKind === null
        ? null
        : {
            count: options.runStore.countSucceededContinuations(
              detail.project,
              detail.issueNumber
            ),
            kind: capKind
          };
    const pullRequestFollowup = buildPullRequestFollowupAttention({
      detail,
      maxDispatches:
        options.getPullRequestFollowupPolicy?.().maxReviewDispatchesPerPr ??
        null,
      runStore: options.runStore
    });
    const sections = [
      `<h1 class="page-title">Run <code>${escapeHtml(detail.id)}</code></h1>`,
      renderOutcomeBanner(detail, failureEvent, exitEvent),
      renderPullRequestFollowupAttention(pullRequestFollowup),
      renderRunSummary(detail, capContext),
      renderWorkflowGraphSummary(detail.id, workflowGraph),
      renderCancelForm(detail),
      renderAttemptsTable(detail.attempts),
      renderTransitionsTable(detail.transitions),
      renderEventsTable(events, eventsTruncated),
      renderRunFileLinks(detail.id, artifacts)
    ].join("");
    return context.html(layout(`Run ${detail.id}`, sections));
  });

  options.app.get("/runs/:id/graph", async (context) => {
    const id = context.req.param("id");
    const detail = options.runStore.getRun(id);
    if (detail === undefined) {
      return context.html(
        layout("Run not found", `<p>Run ${escapeHtml(id)} not found.</p>`),
        404
      );
    }
    const graph = await options.runStore.getWorkflowGraph(id);
    if (graph === undefined) {
      return context.html(
        layout(
          "No workflow graph",
          `<h1>Workflow graph</h1><p>No workflow graph was recorded for run <a href="/runs/${encodeURIComponent(id)}"><code>${escapeHtml(id)}</code></a>.</p>`
        ),
        404
      );
    }
    return context.html(
      layout(
        `Workflow graph ${detail.id}`,
        renderWorkflowGraphPage(detail.id, graph)
      )
    );
  });
}

const FONT_FACES = BUNDLED_FONTS.map(
  ({ weight, hash }) =>
    `@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:${weight};font-display:swap;src:url("/assets/fonts/ibm-plex-mono-${weight}.${hash}.woff2") format("woff2");}`
).join("");

const DARK_TOKENS = `
  --bg: oklch(0.205 0.012 255);
  --surface: oklch(0.232 0.014 255);
  --surface-2: oklch(0.27 0.015 255);
  --raised: oklch(0.246 0.015 255);
  --border: oklch(0.33 0.015 255);
  --border-strong: oklch(0.44 0.017 255);
  --ink: oklch(0.93 0.008 250);
  --ink-2: oklch(0.8 0.011 250);
  --ink-muted: oklch(0.68 0.012 250);
  --accent: oklch(0.72 0.13 255);
  --accent-ink: oklch(0.8 0.12 255);
  --accent-quiet: oklch(0.32 0.06 255);
  --focus: oklch(0.78 0.14 255);
  --progress-ink: oklch(0.84 0.11 82);
  --progress-bg: oklch(0.32 0.055 78);
  --fail-ink: oklch(0.77 0.15 28);
  --fail-bg: oklch(0.31 0.075 28);
  --ok-ink: oklch(0.8 0.13 152);
  --ok-bg: oklch(0.3 0.06 152);
  --blocked-ink: oklch(0.8 0.13 300);
  --blocked-bg: oklch(0.32 0.06 300);`;

const STYLES = `${FONT_FACES}
:root {
  color-scheme: light dark;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --fs-display: 1.3125rem;
  --fs-h2: 0.9375rem;
  --fs-body: 0.8125rem;
  --fs-meta: 0.75rem;
  --fs-label: 0.6875rem;
  --lh-body: 1.55;
  --sp-1: 0.25rem; --sp-2: 0.5rem; --sp-3: 0.75rem; --sp-4: 1rem;
  --sp-5: 1.5rem; --sp-6: 2rem; --sp-7: 3rem;
  --radius: 6px; --radius-sm: 4px;
  --maxw: 1200px;
  --z-sticky: 100;

  --bg: oklch(0.985 0.004 255);
  --surface: oklch(0.977 0.005 255);
  --surface-2: oklch(0.954 0.007 255);
  --raised: oklch(0.968 0.006 255);
  --border: oklch(0.9 0.007 255);
  --border-strong: oklch(0.82 0.009 255);
  --ink: oklch(0.29 0.013 255);
  --ink-2: oklch(0.42 0.013 255);
  --ink-muted: oklch(0.51 0.012 255);
  --accent: oklch(0.58 0.16 255);
  --accent-ink: oklch(0.51 0.17 258);
  --accent-quiet: oklch(0.94 0.03 255);
  --focus: oklch(0.6 0.18 258);
  --progress-ink: oklch(0.47 0.1 72);
  --progress-bg: oklch(0.94 0.045 82);
  --fail-ink: oklch(0.5 0.19 28);
  --fail-bg: oklch(0.945 0.04 28);
  --ok-ink: oklch(0.45 0.12 152);
  --ok-bg: oklch(0.94 0.05 152);
  --blocked-ink: oklch(0.5 0.15 300);
  --blocked-bg: oklch(0.945 0.035 300);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}
  }
}
:root[data-theme="dark"] {${DARK_TOKENS}
}

*, *::before, *::after { box-sizing: border-box; }
html { font-size: 100%; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  font-variant-ligatures: none;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent-ink); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 0.2em; }
code { font-family: var(--font-mono); }
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: 3px;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-5);
  background: var(--raised);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ink);
}
.brand a { color: inherit; }
.brand a:hover { text-decoration: none; }
.nav { display: flex; gap: var(--sp-1); }
.nav a {
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  font-size: var(--fs-meta);
  transition: background-color 120ms ease, color 120ms ease;
}
.nav a:hover { background: var(--surface-2); color: var(--ink); text-decoration: none; }

main { max-width: var(--maxw); margin: 0 auto; padding: var(--sp-6) var(--sp-5) var(--sp-7); }

.page-title {
  font-size: var(--fs-display);
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0 0 var(--sp-5);
}
.page-title code { font-size: 0.85em; color: var(--ink-2); }
.lede { color: var(--ink-muted); }

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3) var(--sp-6);
  align-items: baseline;
  padding: 0 0 var(--sp-5);
  margin: 0 0 var(--sp-6);
  border-bottom: 1px solid var(--border);
}
.kv { display: flex; flex-direction: column; gap: 0.15rem; }
.kv .k {
  color: var(--ink-muted);
  font-size: var(--fs-label);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.kv .v { color: var(--ink); font-size: var(--fs-meta); }
.kv .v code { color: var(--ink-2); }
.kv .v.num { font-size: var(--fs-h2); font-weight: 600; letter-spacing: -0.01em; }

section { margin: 0 0 var(--sp-6); }
.section-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
}
.section-head h2 {
  font-size: var(--fs-h2);
  font-weight: 600;
  letter-spacing: -0.005em;
  margin: 0;
}
.count {
  font-size: var(--fs-label);
  color: var(--ink-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.05rem 0.45rem;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
table { border-collapse: collapse; width: 100%; font-size: var(--fs-body); }
th, td {
  text-align: left;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  white-space: nowrap;
}
thead th {
  background: var(--surface-2);
  color: var(--ink-muted);
  font-size: var(--fs-label);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
tbody tr { transition: background-color 110ms ease; }
tbody tr:hover { background: var(--surface-2); }
tbody tr:last-child td { border-bottom: 0; }
td code { color: var(--ink-2); }
.c-title { white-space: normal; min-width: 22ch; }
.c-detail { white-space: normal; min-width: 26ch; color: var(--ink-2); }
.muted { color: var(--ink-muted); }

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.42em;
  padding: 0.14rem 0.5rem;
  border-radius: 999px;
  font-size: var(--fs-label);
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  border: 1px solid transparent;
}
.pill-dot { width: 0.5em; height: 0.5em; border-radius: 50%; background: currentColor; flex: none; }
.pill--progress { color: var(--progress-ink); background: var(--progress-bg); border-color: color-mix(in oklch, var(--progress-ink) 22%, transparent); }
.pill--fail { color: var(--fail-ink); background: var(--fail-bg); border-color: color-mix(in oklch, var(--fail-ink) 22%, transparent); }
.pill--ok { color: var(--ok-ink); background: var(--ok-bg); border-color: color-mix(in oklch, var(--ok-ink) 22%, transparent); }
.pill--blocked { color: var(--blocked-ink); background: var(--blocked-bg); border-color: color-mix(in oklch, var(--blocked-ink) 22%, transparent); }
.pill--neutral { color: var(--ink-muted); background: var(--surface-2); border-color: var(--border); }

.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--sp-2) var(--sp-4);
  align-items: baseline;
  margin: 0;
  padding: var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.fields dt {
  color: var(--ink-muted);
  font-size: var(--fs-label);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.fields dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
.fields dd code { color: var(--ink-2); }
.field-note { grid-column: 1 / -1; color: var(--ink-2); font-size: var(--fs-meta); }

.files { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.files a {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4em;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--accent-ink);
  font-size: var(--fs-meta);
  transition: border-color 120ms ease, background-color 120ms ease;
}
.files a:hover { border-color: var(--border-strong); background: var(--surface-2); text-decoration: none; }
.files small { color: var(--ink-muted); }

.btn {
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: var(--sp-2) var(--sp-4);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.btn:hover { background: var(--accent-quiet); border-color: var(--accent-ink); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.alert {
  border: 1px solid var(--fail-ink);
  background: var(--fail-bg);
  color: var(--fail-ink);
  border-radius: var(--radius);
  padding: var(--sp-3) var(--sp-4);
  margin: 0 0 var(--sp-5);
  font-size: var(--fs-meta);
}
.alert strong { display: block; margin-bottom: var(--sp-1); }
.alert ul { margin: 0; padding-left: 1.2em; }

.empty {
  padding: var(--sp-5);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink-muted);
}
.empty strong { display: block; margin-bottom: var(--sp-1); color: var(--ink-2); }

.note { color: var(--ink-2); font-size: var(--fs-meta); margin: var(--sp-2) 0 0; }

.banner {
  border: 1px solid var(--fail-ink);
  background: var(--fail-bg);
  border-radius: var(--radius);
  padding: var(--sp-3) var(--sp-4);
  margin: 0 0 var(--sp-5);
}
.banner--blocked {
  border-color: var(--blocked-ink);
  background: var(--blocked-bg);
}
.banner--attention {
  border-color: var(--progress-ink);
  background: var(--progress-bg);
}
.banner-title {
  margin: 0 0 var(--sp-1);
  font-weight: 600;
  text-transform: capitalize;
  color: var(--fail-ink);
}
.banner--blocked .banner-title { color: var(--blocked-ink); }
.banner--attention .banner-title { color: var(--progress-ink); }
.banner-reason { margin: 0 0 var(--sp-2); white-space: pre-wrap; color: var(--ink); }
.banner-context { margin: 0; font-size: var(--fs-meta); color: var(--ink-muted); }
.banner-context code { color: var(--ink-2); }
.msg {
  margin: 0;
  max-height: 22rem;
  overflow: auto;
  white-space: pre-wrap;
  font-family: var(--font-mono);
  color: var(--ink);
}
.hint { color: var(--ink-muted); font-size: var(--fs-meta); margin: 0 0 var(--sp-3); }

@media (prefers-reduced-motion: no-preference) {
  .pill--progress.is-running .pill-dot { animation: pulse 1.8s ease-in-out infinite; }
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

@media (max-width: 640px) {
  .topbar { padding: var(--sp-3) var(--sp-4); }
  main { padding: var(--sp-5) var(--sp-4) var(--sp-6); }
  .meta { gap: var(--sp-3) var(--sp-4); }
  .fields { grid-template-columns: 1fr; gap: var(--sp-1) 0; }
  .fields dt { margin-top: var(--sp-2); }
}`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234a6ff0' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 6l5 6-5 6'/%3E%3Cpath d='M13 18h7'/%3E%3C/svg%3E">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <div class="brand"><a href="/">Symphonika</a></div>
  <nav class="nav" aria-label="Primary"><a href="/">Dashboard</a><a href="/runs">Runs</a></nav>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

function stateFamily(
  state: RunState
): "ok" | "fail" | "blocked" | "progress" | "neutral" {
  switch (state) {
    case "succeeded":
      return "ok";
    case "failed":
    case "cancelled":
    case "stale":
      return "fail";
    case "blocked":
      return "blocked";
    case "queued":
    case "preparing_workspace":
    case "running":
    case "waiting":
    case "input_required":
      return "progress";
    default:
      return "neutral";
  }
}

function statePill(state: RunState): string {
  const family = stateFamily(state);
  const running = state === "running" ? " is-running" : "";
  return `<span class="pill pill--${family}${running}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(state)}</span>`;
}

function renderHeader(
  version: string,
  snapshot: StatusSnapshot | undefined
): string {
  const stateRoot = snapshot?.stateRoot ?? "";
  const issuePolling = snapshot?.issuePolling;
  const candidateCount = issuePolling?.candidateIssues.length ?? 0;
  const filteredCount = issuePolling?.filteredIssues.length ?? 0;
  const errors = issuePolling?.errors ?? [];
  const errorList =
    errors.length === 0
      ? ""
      : `<div class="alert" role="alert"><strong>Issue polling errors</strong><ul>${errors
          .map((error) => `<li>${escapeHtml(error)}</li>`)
          .join("")}</ul></div>`;
  return `<section class="meta">
  <div class="kv"><span class="k">Version</span><span class="v"><code>${escapeHtml(version)}</code></span></div>
  <div class="kv"><span class="k">State root</span><span class="v"><code>${escapeHtml(stateRoot)}</code></span></div>
  <div class="kv"><span class="k">Eligible issues</span><span class="v num">${candidateCount}</span></div>
  <div class="kv"><span class="k">Filtered</span><span class="v num">${filteredCount}</span></div>
</section>
${errorList}`;
}

function sectionHead(title: string, count?: number): string {
  const badge =
    count === undefined ? "" : `<span class="count">${count}</span>`;
  return `<div class="section-head"><h2>${escapeHtml(title)}</h2>${badge}</div>`;
}

function tableSection(
  title: string,
  count: number,
  head: string,
  rows: string
): string {
  return `<section>${sectionHead(title, count)}<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderProjectsCard(
  snapshot: StatusSnapshot | undefined,
  issuePollStatus: IssuePollStatus | undefined
): string {
  const projectStates = snapshot?.projectStates ?? [];
  if (projectStates.length > 0) {
    const rows = projectStates
      .map(
        (project) =>
          `<tr><td>${escapeHtml(project.projectName)}</td><td>${project.weight}</td><td class="c-detail">${escapeHtml(formatProjectValidation(project))}</td><td class="c-detail">${escapeHtml(formatProjectPoll(project))}</td><td class="c-detail">${escapeHtml(formatProjectDispatch(project))}</td></tr>`
      )
      .join("");
    return tableSection(
      "Projects",
      projectStates.length,
      "<tr><th>Name</th><th>Weight</th><th>Validation</th><th>Last poll</th><th>Last dispatch</th></tr>",
      rows
    );
  }

  if (snapshot !== undefined && snapshot.projects.length > 0) {
    const rows = snapshot.projects
      .map((project) => {
        const missingEligibility =
          project.missingEligibilityLabels.length === 0
            ? "&mdash;"
            : escapeHtml(project.missingEligibilityLabels.join(", "));
        const missingOperational =
          project.missingOperationalLabels.length === 0
            ? "&mdash;"
            : escapeHtml(project.missingOperationalLabels.join(", "));
        const valid = project.validForDispatch ? "valid" : "invalid";
        return `<tr><td>${escapeHtml(project.name)}</td><td>${escapeHtml(valid)}</td><td><code>${escapeHtml(project.workflowPath)}</code></td><td class="c-detail">${missingEligibility}</td><td class="c-detail">${missingOperational}</td></tr>`;
      })
      .join("");
    return tableSection(
      "Projects",
      snapshot.projects.length,
      "<tr><th>Name</th><th>Validation</th><th>Workflow</th><th>Missing required eligibility labels</th><th>Missing operational labels</th></tr>",
      rows
    );
  }

  const pollProjects = issuePollStatus?.projects ?? [];
  if (pollProjects.length === 0) {
    return "";
  }

  const rows = pollProjects
    .map((project) => {
      const status = project.ok ? "poll ok" : "poll failed";
      const detail = project.ok
        ? `${project.fetchedIssues} fetched`
        : (project.error ?? "unknown error");
      return `<tr><td>${escapeHtml(project.name)}</td><td>${escapeHtml(status)}</td><td class="c-detail">${escapeHtml(detail)}</td></tr>`;
    })
    .join("");
  return tableSection(
    "Projects",
    pollProjects.length,
    "<tr><th>Name</th><th>Issue polling</th><th>Last poll</th></tr>",
    rows
  );
}

function formatProjectValidation(project: ProjectState): string {
  return project.validationMessage === null
    ? project.validationState
    : `${project.validationState}: ${project.validationMessage}`;
}

function formatProjectPoll(project: ProjectState): string {
  if (project.lastPollFinishedAt === null || project.lastPollOk === null) {
    return "never";
  }
  const outcome = project.lastPollOk ? "ok" : "failed";
  return [
    `${outcome} at ${project.lastPollFinishedAt}`,
    `(${project.lastFetchedIssues} fetched, ${project.lastCandidateIssues} candidate, ${project.lastFilteredIssues} filtered)`
  ].join(" ");
}

function formatProjectDispatch(project: ProjectState): string {
  if (
    project.lastDispatchedAt === null ||
    project.lastDispatchedIssueNumber === null
  ) {
    return "never";
  }
  return `#${project.lastDispatchedIssueNumber} at ${project.lastDispatchedAt}`;
}

function renderStaleIssuesCard(
  filteredIssues: FilteredProjectIssueSnapshot[]
): string {
  const staleIssues = filteredIssues.filter((entry) =>
    entry.issue.labels.includes("sym:stale")
  );
  if (staleIssues.length === 0) {
    return "";
  }

  const rows = staleIssues
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.project)}</td><td class="c-title"><a href="${escapeHtml(entry.issue.url)}">#${entry.issue.number}</a> ${escapeHtml(entry.issue.title)}</td><td class="c-detail">${escapeHtml(entry.reasons.join(", "))}</td></tr>`
    )
    .join("");
  return tableSection(
    "Stale issues",
    staleIssues.length,
    "<tr><th>Project</th><th>Issue</th><th>Reason</th></tr>",
    rows
  );
}

function renderRoutinesTable(routines: RoutineStatus[]): string {
  if (routines.length === 0) {
    return "";
  }
  const rows = routines
    .map(
      (routine) =>
        `<tr><td>${escapeHtml(routine.projectName)}</td><td>${escapeHtml(routine.name)}</td><td>${escapeHtml(routine.state)}</td><td>${escapeHtml(routine.disabledReason ?? "-")}</td><td><code>${escapeHtml(routine.nextFireAt ?? "-")}</code></td><td><code>${escapeHtml(routine.lastFiredAt ?? "-")}</code></td><td><code>${escapeHtml(routine.lastAttemptedAt ?? "-")}</code></td><td>${escapeHtml(routine.lastSkipReason ?? "-")}</td><td><code>${escapeHtml(routine.lastSkipAt ?? "-")}</code></td><td>${escapeHtml(formatRoutineSkipCounts(routine.skipCounts24h))}</td><td>${escapeHtml(formatRoutinePullRequestNumbers(routine.pullRequestNumbers))}</td></tr>`
    )
    .join("");
  return tableSection(
    "Routines",
    routines.length,
    "<tr><th>Project</th><th>Routine</th><th>State</th><th>Disabled reason</th><th>next_fire_at</th><th>last_fired_at</th><th>last_attempted_at</th><th>last_skip_reason</th><th>last_skip_at</th><th>skips_24h</th><th>Pull requests</th></tr>",
    rows
  );
}

function formatRoutinePullRequestNumbers(numbers: number[]): string {
  return numbers.length === 0
    ? "-"
    : numbers.map((number) => `#${number}`).join(", ");
}

function formatRoutineSkipCounts(
  counts: RoutineStatus["skipCounts24h"]
): string {
  return `overlap=${counts.overlap},concurrency_cap=${counts.concurrency_cap},catch_up_window=${counts.catch_up_window}`;
}

function renderRunsTable(title: string, runs: RunStatus[]): string {
  if (runs.length === 0) {
    const message = title.startsWith("Runs (")
      ? "No runs in this state yet."
      : "No runs yet. A Run appears here once the daemon claims an eligible issue and dispatches a coding agent; its state and evidence stay recorded for review.";
    return `<section>${sectionHead(title, 0)}<div class="empty"><strong>Nothing to show</strong>${escapeHtml(message)}</div></section>`;
  }

  const rows = runs
    .map(
      (run) =>
        `<tr><td><a href="/runs/${encodeURIComponent(run.id)}"><code>${escapeHtml(run.id)}</code></a></td><td>${escapeHtml(run.project)}</td><td class="c-title">#${run.issueNumber} ${escapeHtml(run.issueTitle)}</td><td>${statePill(run.state)}</td><td>${escapeHtml(run.provider)}</td><td><code>${escapeHtml(run.createdAt)}</code></td><td><code>${escapeHtml(run.updatedAt)}</code></td><td><code>${escapeHtml(run.branchName)}</code></td></tr>`
    )
    .join("");
  return tableSection(
    title,
    runs.length,
    "<tr><th>Run id</th><th>Project</th><th>Issue</th><th>State</th><th>Provider</th><th>Started</th><th>Updated</th><th>Branch</th></tr>",
    rows
  );
}

type CapContext = {
  count: number;
  kind: ReturnType<typeof parseCapReachedReason>;
};

export function buildPullRequestFollowupAttention(input: {
  detail: Pick<RunStatus, "issueNumber" | "project" | "state">;
  maxDispatches: number | null;
  runStore: RunStore;
}): PullRequestFollowupAttention | null {
  if (input.detail.state !== "waiting" || input.maxDispatches === null) {
    return null;
  }
  const tracked = input.runStore.findTrackedPullRequestByIssue({
    issueNumber: input.detail.issueNumber,
    projectName: input.detail.project
  });
  if (
    tracked === undefined ||
    tracked.state !== "open" ||
    !tracked.reviewFollowupCapReached ||
    tracked.reviewDispatchCount < input.maxDispatches
  ) {
    return null;
  }
  return {
    attention: "cap_reached",
    dispatchCount: tracked.reviewDispatchCount,
    maxDispatches: input.maxDispatches,
    prNumber: tracked.prNumber,
    prUrl: tracked.prUrl
  };
}

function renderPullRequestFollowupAttention(
  attention: PullRequestFollowupAttention | null
): string {
  if (attention === null) {
    return "";
  }
  return `<section class="banner banner--attention"><p class="banner-title">Manual attention required</p><p class="banner-reason">PR review follow-up reached its dispatch cap (${attention.dispatchCount} of ${attention.maxDispatches}) while unresolved feedback remains.</p><p class="banner-context"><a href="${escapeHtml(attention.prUrl)}">Open pull request #${attention.prNumber}</a></p></section>`;
}

function renderRunSummary(
  detail: RunStatus,
  capContext: CapContext | null
): string {
  const capContextLine =
    capContext !== null && capContext.kind !== null
      ? `<div class="field-note"><strong>Cap context:</strong> ${escapeHtml(formatCapReachedReason(capContext.kind, capContext.count))}</div>`
      : "";
  const cancelLine = detail.cancelRequested
    ? `<div class="field-note"><strong>Cancel requested</strong> (reason: ${escapeHtml(detail.cancelReason ?? "unknown")})</div>`
    : "";
  const terminalRow =
    detail.terminalReason !== null
      ? `<dt>Terminal reason</dt><dd><code>${escapeHtml(detail.terminalReason)}</code></dd>`
      : "";
  return `<section><dl class="fields">
  <dt>Project</dt><dd>${escapeHtml(detail.project)}</dd>
  <dt>Issue</dt><dd>#${detail.issueNumber} ${escapeHtml(detail.issueTitle)}</dd>
  <dt>State</dt><dd>${statePill(detail.state)}</dd>
  <dt>Provider</dt><dd>${escapeHtml(detail.provider)}</dd>
  <dt>Started</dt><dd><code>${escapeHtml(detail.createdAt)}</code></dd>
  <dt>Updated</dt><dd><code>${escapeHtml(detail.updatedAt)}</code></dd>
  <dt>Branch</dt><dd><code>${escapeHtml(detail.branchName)}</code></dd>
  <dt>Workspace</dt><dd><code>${escapeHtml(detail.workspacePath)}</code></dd>
  <dt>Retries</dt><dd>${detail.retryCount}${detail.isContinuation ? " (continuation)" : ""}</dd>
  ${terminalRow}
  ${capContextLine}
  ${cancelLine}
</dl></section>`;
}

function renderCancelForm(detail: { id: string; state: RunState }): string {
  if (TERMINAL_STATES.has(detail.state)) {
    return "";
  }
  return `<section><form method="post" action="/api/runs/${encodeURIComponent(detail.id)}/cancel"><button class="btn" type="submit">Cancel run</button></form></section>`;
}

function renderAttemptsTable(
  attempts: {
    id: string;
    attemptNumber: number;
    state: RunState;
    providerName: string;
    createdAt: string;
    updatedAt: string;
    branchName: string;
  }[]
): string {
  if (attempts.length === 0) {
    return `<section>${sectionHead("Attempts", 0)}<div class="empty"><strong>No attempts recorded</strong>This run has not produced a provider attempt yet.</div></section>`;
  }
  const rows = attempts
    .map(
      (attempt) =>
        `<tr><td>${attempt.attemptNumber}</td><td><code>${escapeHtml(attempt.id)}</code></td><td>${statePill(attempt.state)}</td><td>${escapeHtml(attempt.providerName)}</td><td><code>${escapeHtml(attempt.createdAt)}</code></td><td><code>${escapeHtml(attempt.updatedAt)}</code></td><td><code>${escapeHtml(attempt.branchName)}</code></td></tr>`
    )
    .join("");
  return tableSection(
    "Attempts",
    attempts.length,
    "<tr><th>#</th><th>Attempt id</th><th>State</th><th>Provider</th><th>Attempt started</th><th>Attempt updated</th><th>Branch</th></tr>",
    rows
  );
}

function renderTransitionsTable(
  transitions: { sequence: number; state: RunState; createdAt: string }[]
): string {
  if (transitions.length === 0) {
    return "";
  }
  const rows = transitions
    .map(
      (transition) =>
        `<tr><td>${transition.sequence}</td><td>${statePill(transition.state)}</td><td><code>${escapeHtml(transition.createdAt)}</code></td></tr>`
    )
    .join("");
  return tableSection(
    "State transitions",
    transitions.length,
    "<tr><th>Seq</th><th>State</th><th>At</th></tr>",
    rows
  );
}

function renderEventsTable(
  events: ProviderEventRecord[],
  truncated: boolean
): string {
  if (events.length === 0) {
    return `<section>${sectionHead("Transcript & events", 0)}<div class="empty"><strong>No events recorded yet</strong>Provider events stream in here once the run starts producing output.</div></section>`;
  }
  const rows = coalesceEvents(events)
    .map((row) => {
      if (row.kind === "message") {
        const seq =
          row.firstSequence === row.lastSequence
            ? `${row.firstSequence}`
            : `${row.firstSequence}–${row.lastSequence}`;
        return `<tr><td>${seq}</td><td>message</td><td class="c-detail"><div class="msg">${escapeHtml(row.text)}</div></td><td><code>${escapeHtml(row.createdAt)}</code></td></tr>`;
      }
      return `<tr><td>${row.sequence}</td><td>${escapeHtml(row.type)}</td><td class="c-detail"><code>${escapeHtml(row.detail)}</code></td><td><code>${escapeHtml(row.createdAt)}</code></td></tr>`;
    })
    .join("");
  const scope = truncated
    ? `most recent ${events.length}`
    : `all ${events.length}`;
  return `<section>${sectionHead("Transcript & events", events.length)}<p class="hint">Showing ${scope} events, oldest first. Streamed message tokens are merged into blocks; full logs are under Files below.</p><div class="table-wrap"><table><thead><tr><th>Seq</th><th>Type</th><th>Detail</th><th>At</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderRunFileLinks(
  runId: string,
  artifacts: RunArtifactDescriptor[]
): string {
  const items = artifacts
    .filter((artifact) => artifact.present)
    .map((artifact) => {
      const size =
        artifact.sizeBytes === undefined
          ? ""
          : ` <small>(${artifact.sizeBytes} bytes)</small>`;
      return `<li><a href="/logs/runs/${encodeURIComponent(runId)}/${encodeURIComponent(artifact.kind)}">${escapeHtml(formatArtifactKind(artifact.kind))}</a>${size}</li>`;
    });
  if (items.length === 0) {
    return "";
  }
  return `<section>${sectionHead("Files", items.length)}<ul class="files">${items.join("")}</ul></section>`;
}

function renderWorkflowGraphSummary(
  runId: string,
  graph: ExpandedWorkflow | undefined
): string {
  if (graph === undefined) {
    return "";
  }
  const name = typeof graph.name === "string" ? graph.name : "(unknown)";
  const sourceKind =
    typeof graph.source?.kind === "string" ? graph.source.kind : "(unknown)";
  const sourcePath =
    typeof graph.source?.path === "string" ? graph.source.path : "(unknown)";
  const initial =
    typeof graph.initial === "string" ? graph.initial : "(unknown)";
  const stateCount = Array.isArray(graph.states) ? graph.states.length : 0;
  const contentHash =
    typeof graph.contentHash === "string" ? graph.contentHash : "(unknown)";
  return `<section>${sectionHead("Workflow graph")}<dl class="fields">
  <dt>Name</dt><dd><code>${escapeHtml(name)}</code></dd>
  <dt>Source kind</dt><dd>${escapeHtml(sourceKind)}</dd>
  <dt>Source path</dt><dd><code>${escapeHtml(sourcePath)}</code></dd>
  <dt>Initial state</dt><dd><code>${escapeHtml(initial)}</code></dd>
  <dt>States</dt><dd>${stateCount}</dd>
  <dt>Content hash</dt><dd><code>${escapeHtml(contentHash)}</code></dd>
</dl><p class="note"><a href="/runs/${encodeURIComponent(runId)}/graph">View interactive graph &rarr;</a></p></section>`;
}

function formatArtifactKind(kind: RunArtifactDescriptor["kind"]): string {
  switch (kind) {
    case "issue_snapshot":
      return "Issue snapshot";
    case "prompt":
      return "Rendered prompt";
    case "prompt_metadata":
      return "Prompt metadata";
    case "workflow_graph":
      return "Workflow graph";
    case "provider_raw":
      return "Provider event log";
    case "provider_normalized":
      return "Normalized event log";
  }
}

function renderOutcomeBanner(
  detail: RunStatus,
  failureEvent: ProviderEventRecord | undefined,
  exitEvent: ProviderEventRecord | undefined
): string {
  // Only failure- and blocked-state runs get a banner. A prior attempt's
  // failure event must never surface on a run that ultimately succeeded or is
  // still running.
  const isBlocked = BLOCKED_STATES.has(detail.state);
  if (!FAILURE_STATES.has(detail.state) && !isBlocked) {
    return "";
  }
  const providerMessage =
    failureEvent !== undefined &&
    typeof failureEvent.normalized.message === "string"
      ? failureEvent.normalized.message
      : undefined;

  const reason =
    providerMessage !== undefined
      ? `<p class="banner-reason">${escapeHtml(providerMessage)}</p>`
      : isBlocked
        ? `<p class="banner-reason">The agent finished without making workspace changes, or a workflow needs a human decision. See the terminal reason and transcript below.</p>`
        : `<p class="banner-reason">No provider failure message was recorded. See the transcript and logs below.</p>`;

  const context: string[] = [];
  if (detail.terminalReason !== null) {
    context.push(
      `terminal reason <code>${escapeHtml(detail.terminalReason)}</code>`
    );
  }
  const abnormalExit = formatAbnormalExit(exitEvent);
  if (abnormalExit !== undefined) {
    context.push(abnormalExit);
  }
  context.push(`provider <code>${escapeHtml(detail.provider)}</code>`);
  if (failureEvent !== undefined) {
    context.push(`event #${failureEvent.sequence}`);
  }

  const bannerClass = isBlocked ? "banner banner--blocked" : "banner";
  return `<section class="${bannerClass}"><p class="banner-title">Run ${escapeHtml(detail.state)}</p>${reason}<p class="banner-context">${context.join(" &middot; ")}</p></section>`;
}

// Exit code is reported only when abnormal: codex exits 0 even after refusing a
// task, so a "process exited 0" line next to a failure would mislead.
function formatAbnormalExit(
  exitEvent: ProviderEventRecord | undefined
): string | undefined {
  if (exitEvent === undefined) {
    return undefined;
  }
  const normalized = exitEvent.normalized;
  const exitCode =
    typeof normalized.exitCode === "number" ? normalized.exitCode : undefined;
  const signal =
    typeof normalized.signal === "string" ? normalized.signal : undefined;
  const bits: string[] = [];
  if (exitCode !== undefined && exitCode !== 0) {
    bits.push(`exit code ${exitCode}`);
  }
  if (signal !== undefined) {
    bits.push(`signal ${signal}`);
  }
  return bits.length === 0 ? undefined : `process ${bits.join(", ")}`;
}

type EventDisplayRow =
  | {
      kind: "message";
      firstSequence: number;
      lastSequence: number;
      text: string;
      createdAt: string;
    }
  | {
      kind: "event";
      sequence: number;
      type: string;
      detail: string;
      createdAt: string;
    };

// Codex streams assistant text one token per event; merge runs of adjacent
// message events into a single readable block, breaking on any other event.
function coalesceEvents(events: ProviderEventRecord[]): EventDisplayRow[] {
  const rows: EventDisplayRow[] = [];
  let buffer: Extract<EventDisplayRow, { kind: "message" }> | undefined;
  const flush = (): void => {
    if (buffer !== undefined) {
      rows.push(buffer);
      buffer = undefined;
    }
  };

  for (const event of events) {
    const message = event.normalized.message;
    if (event.type === "message" && typeof message === "string") {
      if (buffer === undefined) {
        buffer = {
          createdAt: event.createdAt,
          firstSequence: event.sequence,
          kind: "message",
          lastSequence: event.sequence,
          text: message
        };
      } else {
        buffer.text += message;
        buffer.lastSequence = event.sequence;
        buffer.createdAt = event.createdAt;
      }
      continue;
    }

    flush();
    rows.push({
      createdAt: event.createdAt,
      detail:
        typeof message === "string"
          ? message
          : JSON.stringify(event.normalized),
      kind: "event",
      sequence: event.sequence,
      type: event.type
    });
  }

  flush();
  return rows;
}

function findLast<T>(
  items: readonly T[],
  predicate: (item: T) => boolean
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) {
      return item;
    }
  }
  return undefined;
}

function serializeGraphForScript(graph: ExpandedWorkflow): string {
  return JSON.stringify(graph).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

function renderWorkflowGraphPage(
  runId: string,
  graph: ExpandedWorkflow
): string {
  const encodedId = encodeURIComponent(runId);
  const name = typeof graph.name === "string" ? graph.name : "(unknown)";
  return `<style>${WORKFLOW_GRAPH_STYLES}</style>
<h1>Workflow graph</h1>
<p class="wf-sub">Run <a href="/runs/${encodedId}"><code>${escapeHtml(runId)}</code></a> &middot; <code>${escapeHtml(name)}</code> &middot; <a href="/logs/runs/${encodedId}/workflow_graph">raw JSON</a></p>
<div class="wf-toolbar">
  <button id="wf-fit" type="button">Fit</button>
  <button id="wf-relayout" type="button">Re-layout</button>
  <span class="wf-hint">Scroll to zoom &middot; drag background to pan &middot; drag a node to move it &middot; click a node for details</span>
</div>
<div class="wf-wrap">
  <div id="wf-cy"></div>
  <aside class="wf-side">
    <div class="wf-card">
      <h2>Legend</h2>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#dbeafe;border-color:#3b82f6;border-width:2px"></span> initial state</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#eff6ff;border-color:#60a5fa"></span> agent action</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#f1f5f9;border-style:dashed"></span> wait</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#f5f3ff;border-color:#8b5cf6"></span> merge PR</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#dcfce7;border-color:#22c55e"></span> terminal &middot; success</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#fee2e2;border-color:#ef4444"></span> terminal &middot; blocked</div>
      <div class="wf-legend-row"><span class="wf-swatch wf-swatch-line" style="border-top-color:#f59e0b"></span> retry / loop edge</div>
      <div class="wf-legend-row"><span class="wf-swatch wf-swatch-line" style="border-top-color:#cbd5e1"></span> default (&ldquo;otherwise&rdquo;)</div>
    </div>
    <div class="wf-card wf-detail" id="wf-detail">
      <h2>Details</h2>
      <p class="wf-muted">Click a state node to inspect its action and transitions.</p>
    </div>
  </aside>
</div>
<script>window.__WORKFLOW_GRAPH__ = ${serializeGraphForScript(graph)};</script>
${WORKFLOW_GRAPH_SCRIPTS}
<script>${WORKFLOW_GRAPH_CLIENT_JS}</script>`;
}

const WORKFLOW_GRAPH_STYLES = `
.wf-sub { color:#555; font-size:0.9rem; margin:0 0 0.8rem; }
.wf-toolbar { display:flex; gap:.5rem; align-items:center; margin-bottom:.6rem; flex-wrap:wrap; }
.wf-toolbar button { font:inherit; font-size:.85rem; padding:.3rem .7rem; border:1px solid #cbd5e1; background:#fff; color:#0f172a; border-radius:6px; cursor:pointer; }
.wf-toolbar button:hover { background:#f1f5f9; }
.wf-hint { color:#64748b; font-size:.8rem; }
.wf-wrap { display:flex; gap:1rem; align-items:stretch; }
#wf-cy { flex:1 1 auto; height:80vh; min-height:520px; border:1px solid #e2e8f0; border-radius:10px;
  background:#fbfcfe radial-gradient(circle at 1px 1px, #e6eaf1 1px, transparent 0) 0 0 / 22px 22px; }
.wf-side { flex:0 0 320px; display:flex; flex-direction:column; gap:1rem; }
.wf-card { border:1px solid #e2e8f0; border-radius:10px; padding:.8rem .9rem; background:#fff; color:#0f172a; }
.wf-card h2 { margin:0 0 .5rem; font-size:.95rem; }
.wf-legend-row { display:flex; align-items:center; gap:.5rem; font-size:.82rem; margin:.28rem 0; }
.wf-swatch { width:16px; height:16px; border-radius:4px; border:1px solid #94a3b8; flex:0 0 auto; }
.wf-swatch-line { height:0; border:none; border-top:2px dashed #cbd5e1; border-radius:0; }
.wf-badges { display:flex; flex-wrap:wrap; gap:.3rem; margin:.2rem 0 .6rem; }
.wf-badge { font-size:.72rem; padding:.12rem .5rem; border-radius:999px; background:#eef2ff; color:#3730a3; border:1px solid #c7d2fe; }
.wf-badge.init { background:#dbeafe; color:#1e40af; border-color:#93c5fd; }
.wf-badge.term-ok { background:#dcfce7; color:#166534; border-color:#86efac; }
.wf-badge.term-block { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }
.wf-dl dt { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:#64748b; margin-top:.5rem; }
.wf-dl dd { margin:.15rem 0 0; font-size:.86rem; }
.wf-dl pre { background:#f8fafc; border:1px solid #eef2f7; border-radius:6px; padding:.4rem .5rem; overflow:auto; margin:.2rem 0 0; font-size:.8rem; }
.wf-trans { list-style:none; margin:.2rem 0 0; padding:0; }
.wf-trans li { font-size:.82rem; margin:.3rem 0; padding-left:.9rem; border-left:2px solid #cbd5e1; }
.wf-cond { color:#475569; }
.wf-muted { color:#94a3b8; font-style:italic; }
.wf-fallback { padding:1rem; }
.wf-fallback pre { background:#f8fafc; color:#0f172a; border:1px solid #e2e8f0; border-radius:8px; padding:.8rem; overflow:auto; }
`;

const WORKFLOW_GRAPH_SCRIPTS = `<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.4/dist/cytoscape.min.js" integrity="sha384-H3uzGzTfGHUAumB8+s4GEdfFwzAceN9wCCndN8AXubWKFIPuBSWKKtWDx7RhSf/z" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js" integrity="sha384-2IH3T69EIKYC4c+RXZifZRvaH5SRUdacJW7j6HtE5rQbvLhKKdawxq6vpIzJ7j9M" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js" integrity="sha384-EHCdyFVbhtbpgI+4x7ETlZUvJwOkxJublmhTpH114NSk3fqfiUgcLl6pQm8JQwg9" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`;

const WORKFLOW_GRAPH_CLIENT_JS = `(function () {
  var graph = window.__WORKFLOW_GRAPH__;
  var cyEl = document.getElementById("wf-cy");
  var detailEl = document.getElementById("wf-detail");
  if (!graph || !cyEl) return;
  var states = Array.isArray(graph.states) ? graph.states : [];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtVal(v) { return typeof v === "string" ? '"' + v + '"' : String(v); }
  function condLines(when) {
    var keys = when ? Object.keys(when) : [];
    return keys.map(function (k) { return k + " = " + fmtVal(when[k]); });
  }
  function edgeLabel(when) {
    var lines = condLines(when);
    return lines.length === 0 ? "otherwise" : lines.join("\\n");
  }
  function nodeClasses(st) {
    var cls = [];
    if (st.id === graph.initial) cls.push("initial");
    if (st.terminal === "success") cls.push("term-ok");
    else if (st.terminal) cls.push("term-block");
    else if (st.action && st.action.kind) cls.push("act-" + st.action.kind);
    else cls.push("act-default");
    return cls.join(" ");
  }
  function stateById(id) {
    for (var i = 0; i < states.length; i++) { if (states[i].id === id) return states[i]; }
    return undefined;
  }

  var realIds = {};
  states.forEach(function (s) { realIds[s.id] = true; });

  var rank = {};
  if (realIds[graph.initial]) {
    var queue = [graph.initial];
    rank[graph.initial] = 0;
    while (queue.length) {
      var cur = queue.shift();
      var cst = stateById(cur);
      if (!cst) continue;
      (cst.transitions || []).forEach(function (tr) {
        if (realIds[tr.to] && rank[tr.to] === undefined) {
          rank[tr.to] = rank[cur] + 1;
          queue.push(tr.to);
        }
      });
    }
  }

  var elements = [];
  var missing = {};
  states.forEach(function (st) {
    elements.push({ data: { id: st.id, label: st.id, state: st }, classes: nodeClasses(st) });
  });
  states.forEach(function (st) {
    (st.transitions || []).forEach(function (tr, i) {
      var target = tr.to;
      var targetId;
      if (realIds[target]) {
        targetId = target;
      } else {
        targetId = "__missing__" + target;
        if (!missing[target]) {
          missing[target] = true;
          elements.push({ data: { id: targetId, label: target }, classes: "missing" });
        }
      }
      // A retry/loop edge returns to an earlier, non-terminal state. Edges
      // into a terminal state are exits, never loops, even when the terminal
      // sits at a shallow BFS rank (e.g. reached by an early "otherwise").
      var targetState = stateById(target);
      var targetTerminal = !!(targetState && targetState.terminal);
      var isLoop = !targetTerminal && rank[target] !== undefined && rank[st.id] !== undefined && rank[target] < rank[st.id];
      elements.push({ data: {
        id: st.id + "->" + target + "#" + i,
        source: st.id,
        target: targetId,
        label: edgeLabel(tr.when),
        isDefault: condLines(tr.when).length === 0
      }, classes: isLoop ? "loop" : "" });
    });
  });

  if (typeof window.cytoscape === "undefined" || typeof window.dagre === "undefined" || typeof window.cytoscapeDagre === "undefined") {
    renderFallback();
    return;
  }
  try { window.cytoscape.use(window.cytoscapeDagre); } catch (e) {}

  function layoutOpts() {
    return { name: "dagre", rankDir: "TB", nodeSep: 80, rankSep: 140, edgeSep: 28, ranker: "network-simplex", padding: 30 };
  }

  var cy;
  try {
  cy = window.cytoscape({
    container: cyEl,
    elements: elements,
    wheelSensitivity: 0.2,
    style: [
      { selector: "node", style: {
        "label": "data(label)", "text-valign": "center", "text-halign": "center",
        "font-size": 13, "font-weight": 600, "color": "#0f172a",
        "shape": "round-rectangle", "width": "label", "height": "label",
        "padding": "12px", "border-width": 1.5, "border-color": "#94a3b8",
        "background-color": "#ffffff", "text-max-width": 200, "text-wrap": "wrap" } },
      { selector: "node.act-agent", style: { "background-color": "#eff6ff", "border-color": "#60a5fa" } },
      { selector: "node.act-wait", style: { "background-color": "#f1f5f9", "border-color": "#94a3b8", "border-style": "dashed" } },
      { selector: "node.act-merge_pr", style: { "background-color": "#f5f3ff", "border-color": "#8b5cf6" } },
      { selector: "node.act-default", style: { "background-color": "#ffffff", "border-color": "#94a3b8" } },
      { selector: "node.term-ok", style: { "background-color": "#dcfce7", "border-color": "#22c55e", "border-width": 2, "color": "#14532d" } },
      { selector: "node.term-block", style: { "background-color": "#fee2e2", "border-color": "#ef4444", "border-width": 2, "color": "#7f1d1d" } },
      { selector: "node.initial", style: { "border-width": 3, "border-color": "#2563eb" } },
      { selector: "node.missing", style: { "background-color": "#fff7ed", "border-color": "#fb923c", "border-style": "dotted", "color": "#9a3412" } },
      { selector: "node:selected", style: { "border-color": "#1d4ed8", "border-width": 3 } },
      { selector: "edge", style: {
        "width": 1.6, "line-color": "#9aa6b8", "target-arrow-color": "#9aa6b8",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1.0,
        "label": "data(label)", "font-size": 10, "color": "#334155",
        "text-wrap": "wrap", "text-max-width": 150,
        "text-background-color": "#ffffff", "text-background-opacity": 1, "text-background-shape": "roundrectangle",
        "text-border-color": "#e2e8f0", "text-border-width": 1, "text-border-opacity": 1,
        "text-background-padding": 3, "text-rotation": "none", "z-index": 30 } },
      { selector: "edge[?isDefault]", style: { "line-style": "dashed", "line-color": "#cbd5e1", "target-arrow-color": "#cbd5e1", "color": "#94a3b8" } },
      { selector: "edge.loop", style: {
        "curve-style": "unbundled-bezier", "control-point-distances": "90", "control-point-weights": "0.5",
        "line-color": "#f59e0b", "target-arrow-color": "#f59e0b", "line-style": "dashed",
        "color": "#b45309", "text-border-color": "#fde68a" } },
      { selector: "edge.hl", style: { "line-color": "#2563eb", "target-arrow-color": "#2563eb", "width": 2.4, "color": "#1e3a8a", "z-index": 40 } },
      { selector: "node.dim", style: { "opacity": 0.35 } },
      { selector: "edge.dim", style: { "opacity": 0.15 } }
    ],
    layout: layoutOpts()
  });
  } catch (initErr) {
    renderFallback();
    return;
  }

  cy.on("tap", "node", function (evt) { showDetail(evt.target); });
  cy.on("tap", function (evt) { if (evt.target === cy) clearDetail(); });
  var fitBtn = document.getElementById("wf-fit");
  var reBtn = document.getElementById("wf-relayout");
  if (fitBtn) fitBtn.addEventListener("click", function () { cy.fit(undefined, 30); });
  if (reBtn) reBtn.addEventListener("click", function () { cy.layout(layoutOpts()).run(); });
  cy.ready(function () { cy.fit(undefined, 30); });

  function highlight(node) {
    cy.elements().addClass("dim").removeClass("hl");
    node.closedNeighborhood().removeClass("dim");
    node.connectedEdges().removeClass("dim").addClass("hl");
    node.removeClass("dim");
  }
  function clearHighlight() { cy.elements().removeClass("dim hl"); }

  function showDetail(node) {
    highlight(node);
    var st = node.data("state");
    if (!st) {
      detailEl.innerHTML = "<h2>Details</h2><p class='wf-muted'>Unknown target <code>" + esc(node.data("label")) + "</code> (no matching state).</p>";
      return;
    }
    var badges = [];
    if (st.id === graph.initial) badges.push('<span class="wf-badge init">initial</span>');
    if (st.terminal === "success") badges.push('<span class="wf-badge term-ok">terminal &middot; success</span>');
    else if (st.terminal) badges.push('<span class="wf-badge term-block">terminal &middot; ' + esc(st.terminal) + '</span>');
    if (st.action && st.action.kind) badges.push('<span class="wf-badge">' + esc(st.action.kind) + '</span>');
    if (st.action && st.action.provider) badges.push('<span class="wf-badge">' + esc(st.action.provider) + '</span>');

    var html = "<h2>" + esc(st.id) + "</h2>";
    html += '<div class="wf-badges">' + (badges.join("") || '<span class="wf-muted">no attributes</span>') + "</div>";
    html += '<dl class="wf-dl">';
    if (st.action && st.action.prompt) html += "<dt>Prompt</dt><dd><code>" + esc(st.action.prompt) + "</code></dd>";
    if (st.action && st.action.method) html += "<dt>Method</dt><dd><code>" + esc(st.action.method) + "</code></dd>";
    var cw = condLines(st.completeWhen);
    if (cw.length) html += "<dt>Complete when</dt><dd><pre>" + esc(cw.join("\\n")) + "</pre></dd>";
    html += "<dt>Transitions</dt><dd>";
    if (!st.transitions || st.transitions.length === 0) {
      html += "<span class='wf-muted'>none (terminal)</span>";
    } else {
      html += "<ul class='wf-trans'>";
      st.transitions.forEach(function (tr) {
        var c = condLines(tr.when);
        html += "<li>&rarr; <code>" + esc(tr.to) + "</code><br><span class='wf-cond'>" +
                (c.length ? esc(c.join(", ")) : "otherwise") + "</span></li>";
      });
      html += "</ul>";
    }
    html += "</dd></dl>";
    detailEl.innerHTML = html;
  }

  function clearDetail() {
    clearHighlight();
    detailEl.innerHTML = "<h2>Details</h2><p class='wf-muted'>Click a state node to inspect its action and transitions.</p>";
  }

  function renderFallback() {
    var lines = ["Workflow: " + (graph.name || "(unknown)"), "Initial: " + (graph.initial || "(unknown)"), ""];
    states.forEach(function (st) {
      var tag = st.terminal ? " [terminal:" + st.terminal + "]" : (st.action ? " [" + st.action.kind + "]" : "");
      lines.push("- " + st.id + tag);
      (st.transitions || []).forEach(function (tr) {
        var c = condLines(tr.when);
        lines.push("    -> " + tr.to + (c.length ? "  when " + c.join(", ") : "  (otherwise)"));
      });
    });
    cyEl.innerHTML = '<div class="wf-fallback"><p class="wf-muted">Interactive renderer failed to load (offline?). Text view:</p><pre>' +
      esc(lines.join("\\n")) + "</pre></div>";
  }
})();`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
