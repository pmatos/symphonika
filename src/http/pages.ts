import { Hono } from "hono";

import {
  DEFAULT_POLLING_INTERVAL_MS,
  type FilteredProjectIssueSnapshot,
  type IssuePollStatus
} from "../issue-polling.js";
import {
  formatCapReachedReason,
  parseCapReachedReason
} from "../lifecycle/terminal-reason.js";
import { DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig } from "../reload.js";
import type {
  ListRunsFilter,
  ProjectIssueSnapshotRow,
  ProjectState,
  ProviderEventRecord,
  RoutineFiringStatus,
  RunArtifactDescriptor,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";
import type {
  RoutineFiringState,
  RoutineKind,
  RoutineState,
  RoutineStatus
} from "../routines/types.js";
import type { StatusSnapshot } from "../status.js";
import {
  buildWatchdogIdleStatus,
  buildWatchdogStatus,
  formatAge,
  formatWatchdogDuration,
  resolveWatchdogNowMs,
  type WatchdogIdleStatus,
  type WatchdogStatus
} from "../watchdog-status.js";
import type { ExpandedWorkflow } from "../workflow/types.js";
import { BUNDLED_FONTS, getBundledFont, getFontHash } from "./fonts.js";

// Shared by RegisterPagesOptions.getScheduled and buildProjectIssueRow's
// input — one shape, matching HttpAppOptions.getScheduled's own (src/http/
// app.ts), rather than three independent inline copies of the same four
// fields.
export type ScheduledCallback = {
  dueAt: number;
  kind: "retry" | "continuation" | "state_advance" | "wait_park";
  runId: string;
};

export type RegisterPagesOptions = {
  app: Hono;
  // Per-Slice-2 live cap snapshot; #303's capacity strip. See ADR 0053.
  getConcurrency?: () => {
    global: { inFlight: number; maxInFlight: number | null };
    perProject: Array<{
      inFlight: number;
      maxInFlight: number;
      projectName: string;
    }>;
  };
  getLastTickAtMonotonic?: () => number | undefined;
  getPollingIntervalMs?: () => number | undefined;
  getTickLoopStartedAtMonotonic?: () => number | undefined;
  getPullRequestFollowupPolicy?: () => {
    maxReviewDispatchesPerPr: number;
  };
  // #303's "retry ETA" detail for a waiting Run.
  getScheduled?: () => ScheduledCallback[];
  getStatusSnapshot?: () => StatusSnapshot;
  getWatchdogConfig?: (
    projectName: string
  ) => Pick<WatchdogConfig, "enabled" | "graceMinutes">;
  issuePollStatus?: IssuePollStatus;
  monotonicNow: () => number;
  now?: () => number;
  runStore: RunStore;
  // #303's "pre-restart" staleness marker: a persisted snapshot whose last
  // successful poll predates process start hasn't been refreshed since the
  // daemon came up. See ADR 0073.
  startedAtMs?: number;
  version: string;
};

// Runs whose watchdog idle badge is meaningful on the active-runs list — a
// terminated Run's last persisted sample can still show idleSince set, but
// "time remaining before termination" no longer applies once it has already
// terminated (see the Run-detail page's final-Progress-Signal treatment
// instead). preparing_workspace is deliberately excluded even though it's
// "active": runAttemptLifecycle enters it at the start of every attempt,
// including a retry, but the run's watchdog_samples row is keyed by run_id
// (not per attempt) and is only reset once the new attempt's first running
// sample lands. Including preparing_workspace here would surface the prior
// (failed) attempt's stale idleSince as a live countdown that has nothing to
// do with the current attempt.
const ACTIVE_WATCHDOG_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "running",
  "waiting"
]);

// The dashboard's "active now" band (#302): queued, preparing_workspace, or
// running is "happening right now" and belongs above the drill-in. `waiting`
// and `input_required` are deliberately excluded — both park a Run for
// external state (PR review, or an autonomous Run that failed needing
// input, per ADR-0016) with no provider process running, so they read as
// dormant rather than active; a scheduled-but-not-yet-due Routine Target
// (queued via next_fire_at, not this state) never reaches this list either,
// since it has no routine_firings row until admitted. All three still show
// up on /runs or their own listing. This same text is rendered on the page
// (see ACTIVE_NOW_DEFINITION_NOTE) so the definition is documented whether
// or not the band is empty.
const ACTIVE_NOW_DEFINITION_NOTE =
  'Active means queued, preparing its workspace, or running. A waiting Run (parked for external state, such as PR review) or one needing operator input is not active right now — see <a href="/runs">Runs</a> for those.';

const ACTIVE_NOW_RUN_STATES_LIST: RunState[] = [
  "queued",
  "preparing_workspace",
  "running"
];
const ACTIVE_NOW_FIRING_STATES_LIST: RoutineFiringState[] = [
  "queued",
  "preparing_workspace",
  "running"
];

// Floor for the banner's threshold, well beyond a typical polling interval
// but far below the multi-hour wedges that motivated this banner (see
// docs/adr/0065) — an operator should notice within one dashboard visit,
// not just after the systemd watchdog eventually restarts the unit.
// polling.interval_ms has no configured upper bound, though, so the actual
// threshold scales with the live interval (see renderDaemonStaleBanner)
// rather than using this floor alone — otherwise a healthy daemon with a
// longer configured interval would show a permanent false positive.
const DAEMON_STALE_THRESHOLD_FLOOR_MS = 5 * 60_000;

// Same multiplier isTickRecentEnoughForSystemdWatchdog uses for the same
// reason:
// a long-configured polling interval must not be indistinguishable from a
// genuine stall.
const DAEMON_STALE_THRESHOLD_INTERVAL_MULTIPLIER = 3;

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
  const now = options.now ?? Date.now;
  const getWatchdogConfig =
    options.getWatchdogConfig ?? (() => DEFAULT_WATCHDOG_CONFIG);

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
    const activeRuns = options.runStore.listRuns({
      state: ACTIVE_NOW_RUN_STATES_LIST
    });
    const activeFirings = options.runStore.listRoutineFirings({
      state: ACTIVE_NOW_FIRING_STATES_LIST
    });
    const nowMs = now();
    const watchdogByRun = collectActiveWatchdogIdleStatuses(
      options.runStore,
      activeRuns,
      getWatchdogConfig,
      nowMs
    );
    const lastTickAtMonotonic = options.getLastTickAtMonotonic?.() ?? null;
    // The banner's own reference point falls back to when the tick loop
    // started scheduling (mirroring isTickRecentEnoughForSystemdWatchdog's
    // identical fallback) so a hung first tick isn't indistinguishable from
    // "nothing has been scheduled yet" -- /api/status's own lastTickAt stays
    // truthfully null pre-first-tick; only this banner's age uses the
    // fallback.
    const bannerReferenceAt =
      lastTickAtMonotonic ?? options.getTickLoopStartedAtMonotonic?.() ?? null;
    const tickAgeMs =
      bannerReferenceAt === null
        ? null
        : options.monotonicNow() - bannerReferenceAt;
    const pollingIntervalMs =
      options.getPollingIntervalMs?.() ?? DEFAULT_POLLING_INTERVAL_MS;
    const html = layout(
      "Symphonika",
      [
        `<h1 class="page-title">Dashboard</h1>`,
        renderDaemonStaleBanner(tickAgeMs, pollingIntervalMs),
        renderHeader(options.version, snapshot),
        renderActiveNowBand(activeRuns, activeFirings, watchdogByRun, nowMs),
        renderRoutinesSection(
          groupRoutinesByName(
            options.runStore.listRoutines({
              includeInactive: context.req.query("include_inactive") === "true"
            })
          )
        ),
        renderProjectsSection(
          snapshot,
          options.issuePollStatus,
          activeRuns,
          activeFirings,
          options.runStore.listLatestRunsByProject({
            projectNames: (snapshot?.projectStates ?? []).map(
              (project) => project.projectName
            ),
            states: PROJECT_LAST_RUN_STATES
          }),
          nowMs
        ),
        renderStaleIssuesCard(options.issuePollStatus?.filteredIssues ?? [])
      ].join("")
    );
    return context.html(html);
  });

  options.app.get("/runs", (context) => {
    const filter: ListRunsFilter = {};
    const stateParam = context.req.query("state");
    const validState =
      stateParam !== undefined && KNOWN_RUN_STATES.has(stateParam as RunState)
        ? (stateParam as RunState)
        : undefined;
    if (validState !== undefined) {
      filter.state = validState;
    }
    const project = context.req.query("project");
    if (project !== undefined) {
      filter.project = project;
    }
    const runs = options.runStore.listRuns(filter);
    const nowMs = now();
    const watchdogByRun = collectActiveWatchdogIdleStatuses(
      options.runStore,
      runs,
      getWatchdogConfig,
      nowMs
    );
    const title =
      validState === undefined ? "All runs" : `Runs (${validState})`;
    const html = layout(
      title,
      `<h1 class="page-title">Runs</h1>${renderRunsTable(title, runs, watchdogByRun, nowMs)}`
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
    const detailNowMs = resolveWatchdogNowMs({
      liveNowMs: now(),
      runId: detail.id,
      runState: detail.state,
      runStore: options.runStore
    });
    const watchdog = buildWatchdogStatus({
      config: getWatchdogConfig(detail.project),
      nowMs: detailNowMs,
      runId: detail.id,
      runStore: options.runStore
    });
    const outputTokenGrowth5m =
      watchdog.enabled && watchdog.sampledAt !== undefined
        ? options.runStore.watchdogOutputTokenGrowth(
            detail.id,
            new Date(Date.parse(watchdog.sampledAt) - 5 * 60_000).toISOString()
          )
        : 0;
    const sections = [
      `<h1 class="page-title">Run <code>${escapeHtml(detail.id)}</code></h1>`,
      renderOutcomeBanner(detail, failureEvent, exitEvent),
      renderPullRequestFollowupAttention(pullRequestFollowup),
      renderRunSummary(detail, capContext),
      renderWatchdogSection(watchdog, outputTokenGrowth5m, detailNowMs),
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

  options.app.get("/projects/:name", (context) => {
    const name = context.req.param("name");
    const projectState = options.runStore.getProjectStatesByName().get(name);
    if (projectState === undefined) {
      return context.html(
        layout(
          "Project not found",
          `<h1 class="page-title">Project not found</h1><p class="lede">Project <code>${escapeHtml(name)}</code> was not found.</p>`
        ),
        404
      );
    }
    const mode =
      options.getStatusSnapshot?.()?.projectModes.get(name) ?? "dispatch";
    const nowMs = now();
    // The in-flight numerator is computed the same way #302's Projects
    // section computes it (active Runs + active Routine Firings for this
    // Project) rather than trusted from getConcurrency()'s perProject
    // entry, which — like ActiveRunRegistry.countInFlightByProject before
    // #302's fix — only counts Runs. A Routine Target on a Dispatch Project
    // (ADR 0069) can hold a capacity slot with no Run at all.
    const activeRuns = options.runStore.listRuns({
      project: name,
      state: ACTIVE_NOW_RUN_STATES_LIST
    });
    const activeFirings = options.runStore.listRoutineFirings({
      project: name,
      state: ACTIVE_NOW_FIRING_STATES_LIST
    });
    const inFlight = activeRuns.length + activeFirings.length;
    const firings = options.runStore.listRoutineFirings({ project: name });

    if (mode === "routine_host") {
      const html = layout(
        name,
        [
          `<h1 class="page-title">${escapeHtml(name)}</h1>`,
          renderRoutineHostCapacityStrip(name, projectState, inFlight),
          `<section>${sectionHead("Issues", 0)}<div class="empty"><strong>No issues — this is a Routine Host</strong>A Routine Host (ADR 0062) never polls or dispatches issues; it only hosts Routine Firings, listed below.</div></section>`,
          renderProjectFiringsBlock(firings),
          `<p class="note"><a href="/runs?project=${encodeURIComponent(name)}">Recent runs →</a></p>`
        ].join("")
      );
      return context.html(html);
    }

    const concurrency = options.getConcurrency?.();
    const projectCapacity = concurrency?.perProject.find(
      (entry) => entry.projectName === name
    );
    const pollingIntervalMs =
      options.getPollingIntervalMs?.() ?? DEFAULT_POLLING_INTERVAL_MS;
    const scheduled = options.getScheduled?.() ?? [];

    const runs = options.runStore.listRuns({ project: name });
    const latestRunByIssue = new Map<number, RunStatus>();
    for (const run of runs) {
      if (!latestRunByIssue.has(run.issueNumber)) {
        latestRunByIssue.set(run.issueNumber, run);
      }
    }
    const snapshotByIssue = new Map<number, ProjectIssueSnapshotRow>();
    for (const row of options.runStore.listProjectIssueSnapshots(name)) {
      snapshotByIssue.set(row.issueNumber, row);
    }
    // #303's join (ADR 0073): union of persisted snapshot rows and Runs for
    // this Project, keyed by issue number. A closed issue with a Run but no
    // snapshot row still renders — driven entirely by the Run — because
    // this is a union, not filtered down to snapshot rows.
    const issueNumbers = new Set<number>([
      ...snapshotByIssue.keys(),
      ...latestRunByIssue.keys()
    ]);
    const issueRows = Array.from(issueNumbers)
      .sort((a, b) => b - a)
      .map((issueNumber) =>
        buildProjectIssueRow({
          inFlight,
          issueNumber,
          maxInFlight: projectCapacity?.maxInFlight,
          nowMs,
          projectName: name,
          run: latestRunByIssue.get(issueNumber),
          runStore: options.runStore,
          scheduled,
          snapshot: snapshotByIssue.get(issueNumber)
        })
      );

    const html = layout(
      name,
      [
        `<h1 class="page-title">${escapeHtml(name)}</h1>`,
        renderProjectCapacityStrip(
          name,
          projectState,
          inFlight,
          projectCapacity?.maxInFlight,
          concurrency?.global,
          pollingIntervalMs,
          options.startedAtMs,
          nowMs
        ),
        renderProjectIssuesTable(issueRows),
        renderProjectFiringsBlock(firings),
        `<p class="note"><a href="/runs?project=${encodeURIComponent(name)}">Recent runs →</a></p>`
      ].join("")
    );
    return context.html(html);
  });

  options.app.get("/routines/:name", (context) => {
    const name = context.req.param("name");
    const projectParam = context.req.query("project");
    const groups = groupRoutinesByName(
      options.runStore.listRoutines({ includeInactive: true })
    ).filter((group) => group.name === name);

    if (groups.length === 0) {
      return context.html(
        layout(
          "Routine not found",
          `<h1 class="page-title">Routine not found</h1><p class="lede">Routine <code>${escapeHtml(name)}</code> was not found.</p>`
        ),
        404
      );
    }

    let group: RoutineGroup | undefined;
    if (projectParam !== undefined) {
      group = groups.find((candidate) =>
        candidate.targets.some((target) => target.projectName === projectParam)
      );
      if (group === undefined) {
        return context.html(
          layout(
            "Routine target not found",
            `<h1 class="page-title">Routine target not found</h1><p class="lede">Routine <code>${escapeHtml(name)}</code> has no target in Project <code>${escapeHtml(projectParam)}</code>.</p>`
          ),
          404
        );
      }
    } else if (groups.length === 1) {
      group = groups[0];
    }
    if (group === undefined) {
      return context.html(
        layout(name, renderRoutineDisambiguation(name, groups))
      );
    }

    const declaration = resolveRoutineDeclaration(options.runStore, group);
    const groupProjectNames = new Set(
      group.targets.map((target) => target.projectName)
    );
    // Scoped to this group's own targets: a stale, soft-disabled
    // declaration that reused this name for a different Project (the same
    // "stale name reuse" case groupRoutinesByName documents) has its own,
    // unrelated firing history that must not bleed into this one.
    const firings = options.runStore
      .listRoutineFirings({ routineName: name })
      .filter((firing) => groupProjectNames.has(firing.projectName));
    // invalidRoutines carries no error text of its own (see reload.ts) —
    // the reload error lives only in the flat, process-lifetime
    // reload.errors list, so this is a best-effort match on the routine's
    // own name rather than a guaranteed per-routine correlation.
    const reloadErrors = (
      options.getStatusSnapshot?.()?.reload.errors ?? []
    ).filter((error) => error.includes(name));

    const html = layout(
      name,
      [
        `<h1 class="page-title">${escapeHtml(name)}</h1>`,
        renderRoutineDeclarationCard(declaration, reloadErrors),
        renderRoutineTargetsTable(group),
        renderRoutineFiringHistory(firings),
        `<p class="note">Enable/disable and manual-fire controls land with #306's write-surface plumbing — this page is read-only until then.</p>`
      ].join("")
    );
    return context.html(html);
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

/* The active-now band is the one section that must not read as "just
   another table" — a visible border keeps "what's happening right now"
   glance-able without a decorative hero treatment (PRODUCT.md anti-refs). */
.active-now {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: var(--sp-4);
  background: var(--raised);
}
.active-now .table-wrap { margin: 0 0 var(--sp-4); }
.active-now .table-wrap:last-child { margin: 0; }
.subhead {
  font-size: var(--fs-label);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ink-muted);
  margin: 0 0 var(--sp-2);
}

/* Routine Hosts never dispatch, so their group stays visually subordinate
   to Dispatch Projects rather than competing for the same attention. */
/* No opacity here: it would scale down --ink-muted/pill text contrast
   below the PRODUCT.md bar. Subordinate reads from the heading weight/color
   and section order alone. */
.subdued .section-head h2 { color: var(--ink-2); font-weight: 500; }

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

.badge {
  display: inline-flex;
  align-items: center;
  padding: 0.14rem 0.5rem;
  border-radius: 999px;
  font-size: var(--fs-label);
  white-space: nowrap;
  border: 1px solid transparent;
}
.badge--watchdog { color: var(--progress-ink); background: var(--progress-bg); border-color: color-mix(in oklch, var(--progress-ink) 22%, transparent); }

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
  state: RunState | RoutineFiringState
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

function statePill(state: RunState | RoutineFiringState): string {
  const family = stateFamily(state);
  const running = state === "running" ? " is-running" : "";
  return `<span class="pill pill--${family}${running}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(state)}</span>`;
}

// Routine (not Routine Firing) lifecycle states are a separate, smaller enum
// — active/expired/inactive/disabled/invalid — with no direct RunState
// analogue, so it gets its own family mapping rather than widening
// stateFamily further.
function routineStateFamily(
  state: RoutineState
): "ok" | "fail" | "progress" | "neutral" {
  switch (state) {
    case "active":
      return "progress";
    case "expired":
    case "invalid":
      return "fail";
    case "inactive":
    case "disabled":
      return "neutral";
    default:
      return "neutral";
  }
}

function routineStatePill(state: RoutineState): string {
  const family = routineStateFamily(state);
  return `<span class="pill pill--${family}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(state)}</span>`;
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

// One row of the new Projects section, joined from ProjectState (identity +
// validity — always populated, unlike DoctorProjectReport, which only
// exists when a caller passes a live doctorReport; the daemon's hot
// getStatusSnapshot path does not, see #302), the snapshot's own mode map
// (the one source of `mode` that doesn't need a doctor run), issue polling
// (eligible count), the active-now query already fetched for the band above
// (in-flight count, so this section doesn't re-derive its own notion of "in
// flight"), and a bulk last-terminal-run lookup. See ADR 0062 for the
// Dispatch Project / Routine Host split this groups by.
type ProjectRow = {
  eligible: number;
  inFlight: number;
  lastRun: RunStatus | undefined;
  mode: "dispatch" | "routine_host";
  name: string;
  validationMessage: string | null;
  validationState: ProjectState["validationState"];
};

// Runs whose terminal outcome is worth showing as a project's "last run" —
// TERMINAL_STATES minus nothing; a currently-running/queued Run would just
// restate the In-flight column instead of answering "how did the last one
// go" (PRODUCT.md principle 4 wants the real outcome, not the live state).
const PROJECT_LAST_RUN_STATES = Array.from(TERMINAL_STATES);

function buildProjectRows(
  projectStates: ProjectState[],
  projectModes: ReadonlyMap<string, "dispatch" | "routine_host">,
  issuePollStatus: IssuePollStatus | undefined,
  activeRuns: RunStatus[],
  activeFirings: RoutineFiringStatus[],
  lastRunByProject: ReadonlyMap<string, RunStatus>
): ProjectRow[] {
  // A Routine Firing consumes the same per-project in-flight capacity as an
  // issue Run (ADR 0053/0069), and a Routine Host — which never has Runs —
  // can still be mid-firing. Counting only activeRuns would silently read
  // 0 for a capped Routine Host or a Dispatch Project currently running a
  // Routine Firing instead of an issue Run.
  const inFlightByProject = new Map<string, number>();
  for (const run of activeRuns) {
    inFlightByProject.set(
      run.project,
      (inFlightByProject.get(run.project) ?? 0) + 1
    );
  }
  for (const firing of activeFirings) {
    inFlightByProject.set(
      firing.projectName,
      (inFlightByProject.get(firing.projectName) ?? 0) + 1
    );
  }
  const eligibleByProject = new Map<string, number>();
  for (const candidate of issuePollStatus?.candidateIssues ?? []) {
    eligibleByProject.set(
      candidate.project,
      (eligibleByProject.get(candidate.project) ?? 0) + 1
    );
  }
  return projectStates.map((project) => ({
    eligible: eligibleByProject.get(project.projectName) ?? 0,
    inFlight: inFlightByProject.get(project.projectName) ?? 0,
    lastRun: lastRunByProject.get(project.projectName),
    // Omitted mode defaults to "dispatch" (ADR 0062) — the same default the
    // service config schema uses, so a caller with no live project config
    // (projectModes empty) still gets a sensible split.
    mode: projectModes.get(project.projectName) ?? "dispatch",
    name: project.projectName,
    validationMessage: project.validationMessage,
    validationState: project.validationState
  }));
}

function renderValidityPill(row: ProjectRow): string {
  const valid = row.validationState === "valid";
  const family = valid ? "ok" : "fail";
  const reason =
    !valid && row.validationMessage !== null
      ? ` <span class="muted">(${escapeHtml(row.validationMessage)})</span>`
      : "";
  return `<span class="pill pill--${family}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(row.validationState)}</span>${reason}`;
}

function renderDispatchProjectsTable(
  rows: ProjectRow[],
  nowMs: number
): string {
  if (rows.length === 0) {
    return `<section>${sectionHead("Projects", 0)}<div class="empty"><strong>No Projects configured</strong>A Dispatch Project polls its issue tracker and dispatches eligible Issues to a Coding Agent. Add one to the service config to see it here.</div></section>`;
  }
  const bodyRows = rows
    .map((row) => {
      const lastRun =
        row.lastRun === undefined
          ? '<span class="muted">never</span>'
          : `${statePill(row.lastRun.state)} <code>${escapeHtml(formatAge(row.lastRun.updatedAt, nowMs))}</code>`;
      return `<tr><td><a href="/projects/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></td><td>${renderValidityPill(row)}</td><td>${row.eligible}</td><td>${row.inFlight}</td><td class="c-detail">${lastRun}</td></tr>`;
    })
    .join("");
  return tableSection(
    "Projects",
    rows.length,
    "<tr><th>Name</th><th>Validation</th><th>Eligible</th><th>In-flight</th><th>Last run</th></tr>",
    bodyRows
  );
}

// Routine Hosts never dispatch (ADR 0062), so "eligible" issues would only
// ever read zero and is dropped — but a Host can still be mid-Routine-Firing,
// which consumes its in-flight capacity slot exactly like a Run (ADR 0053),
// so that column stays. A subdued, minimal table keeps permanently-idle
// hosts from diluting the Dispatch Projects section.
function renderRoutineHostsTable(rows: ProjectRow[]): string {
  if (rows.length === 0) {
    return "";
  }
  const bodyRows = rows
    .map(
      (row) =>
        `<tr><td><a href="/projects/${encodeURIComponent(row.name)}">${escapeHtml(row.name)}</a></td><td>${renderValidityPill(row)}</td><td>${row.inFlight}</td></tr>`
    )
    .join("");
  return `<section class="subdued">${sectionHead("Routine hosts", rows.length)}<div class="table-wrap"><table><thead><tr><th>Name</th><th>Validation</th><th>In-flight</th></tr></thead><tbody>${bodyRows}</tbody></table></div></section>`;
}

function renderProjectsSection(
  snapshot: StatusSnapshot | undefined,
  issuePollStatus: IssuePollStatus | undefined,
  activeRuns: RunStatus[],
  activeFirings: RoutineFiringStatus[],
  lastRunByProject: ReadonlyMap<string, RunStatus>,
  nowMs: number
): string {
  const projectStates = snapshot?.projectStates ?? [];
  if (projectStates.length > 0) {
    const rows = buildProjectRows(
      projectStates,
      snapshot?.projectModes ?? new Map(),
      // Read eligible counts off the snapshot's own issuePolling, matching
      // renderHeader — not the separately-threaded issuePollStatus option,
      // which is only a fallback for the poll-status-only tier below.
      snapshot?.issuePolling,
      activeRuns,
      activeFirings,
      lastRunByProject
    );
    return [
      renderDispatchProjectsTable(
        rows.filter((row) => row.mode === "dispatch"),
        nowMs
      ),
      renderRoutineHostsTable(rows.filter((row) => row.mode === "routine_host"))
    ].join("");
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

function capacityKv(label: string, valueHtml: string): string {
  return `<span class="kv"><span class="k">${escapeHtml(label)}</span><span class="v">${valueHtml}</span></span>`;
}

function renderProjectFiringsBlock(firings: RoutineFiringStatus[]): string {
  if (firings.length === 0) {
    return `<section>${sectionHead("Routine firings", 0)}<div class="empty"><strong>No Routine firings</strong>No Routine currently targets this Project.</div></section>`;
  }
  const rows = firings.map((firing) => firingRowHtml(firing)).join("");
  return tableSection(
    "Routine firings",
    firings.length,
    ROUTINE_FIRINGS_TABLE_HEAD,
    rows
  );
}

// #303's capacity strip for a Routine Host: validity + in-flight only.
// Poll age / next poll don't apply — a host is never polled for issues
// (ADR 0062) — and it has no per-host max_in_flight surfaced through
// getConcurrency(), which only iterates Dispatch Projects.
function renderRoutineHostCapacityStrip(
  name: string,
  projectState: ProjectState,
  inFlight: number
): string {
  const validity = renderValidityPill({
    eligible: 0,
    inFlight: 0,
    lastRun: undefined,
    mode: "routine_host",
    name,
    validationMessage: projectState.validationMessage,
    validationState: projectState.validationState
  });
  return `<section class="capacity-strip">${capacityKv("validity", validity)}${capacityKv("in-flight", `${inFlight}`)}</section>`;
}

// #303's capacity strip for a Dispatch Project: this is the page's
// load-bearing element (PRODUCT.md principle 4) — without it, a table full
// of eligible issues and nothing running reads as idle rather than capped.
function renderProjectCapacityStrip(
  name: string,
  projectState: ProjectState,
  inFlight: number,
  maxInFlight: number | undefined,
  globalCapacity: { inFlight: number; maxInFlight: number | null } | undefined,
  pollingIntervalMs: number,
  startedAtMs: number | undefined,
  nowMs: number
): string {
  const validity = renderValidityPill({
    eligible: 0,
    inFlight: 0,
    lastRun: undefined,
    mode: "dispatch",
    name,
    validationMessage: projectState.validationMessage,
    validationState: projectState.validationState
  });
  const parts = [capacityKv("validity", validity)];
  const inFlightLabel =
    maxInFlight === undefined ? `${inFlight}` : `${inFlight}/${maxInFlight}`;
  parts.push(capacityKv("in-flight", escapeHtml(inFlightLabel)));
  if (globalCapacity !== undefined && globalCapacity.maxInFlight !== null) {
    parts.push(
      capacityKv(
        "global",
        escapeHtml(`${globalCapacity.inFlight}/${globalCapacity.maxInFlight}`)
      )
    );
  }
  const lastPollAt = projectState.lastPollFinishedAt;
  const pollAge = lastPollAt === null ? "never" : formatAge(lastPollAt, nowMs);
  const preRestart =
    lastPollAt !== null &&
    startedAtMs !== undefined &&
    Date.parse(lastPollAt) < startedAtMs
      ? ' <span class="muted">(pre-restart)</span>'
      : "";
  parts.push(capacityKv("poll", `${escapeHtml(pollAge)}${preRestart}`));
  if (lastPollAt !== null) {
    const nextPollAtMs = Date.parse(lastPollAt) + pollingIntervalMs;
    parts.push(
      capacityKv(
        "next poll",
        escapeHtml(formatAge(new Date(nextPollAtMs).toISOString(), nowMs))
      )
    );
  }
  if (projectState.lastPollOk === false) {
    const reason =
      projectState.lastPollError === null
        ? ""
        : ` <span class="muted">(${escapeHtml(projectState.lastPollError)})</span>`;
    parts.push(
      capacityKv(
        "polling",
        `<span class="pill pill--fail"><span class="pill-dot" aria-hidden="true"></span>failing</span>${reason}`
      )
    );
  }
  return `<section class="capacity-strip">${parts.join("")}</section>`;
}

function labelPill(
  label: string,
  family: "ok" | "fail" | "blocked" | "progress" | "neutral"
): string {
  return `<span class="pill pill--${family}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

// #303's per-row state bucket. A Run's own RunState wins whenever a Run
// exists — see the ADR 0073 join note above the route handler — so this
// table maps every RunState into one of the AC's buckets rather than
// inventing a second state vocabulary. queued/preparing_workspace read as
// "claimed" (the daemon has picked the issue but no attempt is running
// yet); input_required folds into "waiting" since it, like `waiting`, has
// no active provider process (see ACTIVE_NOW_RUN_STATES_LIST above).
const PROJECT_ISSUE_ROW_BUCKET: Record<
  RunState,
  "claimed" | "running" | "waiting" | "blocked" | "terminal"
> = {
  blocked: "blocked",
  cancelled: "terminal",
  failed: "terminal",
  input_required: "waiting",
  preparing_workspace: "claimed",
  queued: "claimed",
  running: "running",
  stale: "terminal",
  succeeded: "terminal",
  waiting: "waiting"
};

type ProjectIssueRow = {
  detail: string;
  issueNumber: number;
  pillHtml: string;
  title: string;
};

function buildProjectIssueRow(input: {
  inFlight: number;
  issueNumber: number;
  maxInFlight: number | undefined;
  nowMs: number;
  projectName: string;
  run: RunStatus | undefined;
  runStore: RunStore;
  scheduled: ScheduledCallback[];
  snapshot: ProjectIssueSnapshotRow | undefined;
}): ProjectIssueRow {
  if (input.run !== undefined) {
    const run = input.run;
    const bucket = PROJECT_ISSUE_ROW_BUCKET[run.state];
    const pillHtml = statePill(run.state);
    if (bucket === "running") {
      return {
        detail: `attempt ${run.retryCount + 1} · ${formatAge(run.updatedAt, input.nowMs)}`,
        issueNumber: input.issueNumber,
        pillHtml,
        title: run.issueTitle
      };
    }
    if (bucket === "waiting") {
      const due = input.scheduled.find((entry) => entry.runId === run.id);
      const detail =
        due !== undefined
          ? `recheck ${formatAge(new Date(due.dueAt).toISOString(), input.nowMs)}`
          : (run.stateTransitionReason ??
            (run.state === "input_required" ? "needs operator input" : ""));
      return {
        detail,
        issueNumber: input.issueNumber,
        pillHtml,
        title: run.issueTitle
      };
    }
    if (bucket === "terminal" || bucket === "blocked") {
      // A blocked Run's own reason is recorded as its terminalReason (e.g.
      // "workflow_terminal_blocked" — see recordTerminalReason call sites
      // in lifecycle/run-controller.ts), the same field a "terminal" Run
      // uses — not stateTransitionReason, which stays unset on that path.
      const tracked = input.runStore.findTrackedPullRequestByIssue({
        issueNumber: input.issueNumber,
        projectName: input.projectName
      });
      const prDetail =
        tracked === undefined
          ? ""
          : ` · PR #${tracked.prNumber} ${tracked.state}`;
      const reason = run.terminalReason ?? run.stateTransitionReason ?? "";
      return {
        detail: `${reason}${prDetail}`,
        issueNumber: input.issueNumber,
        pillHtml,
        title: run.issueTitle
      };
    }
    // "claimed" (queued/preparing_workspace): no terminalReason exists yet
    // (the Run hasn't terminated), so fall back to a plain description of
    // what's happening rather than leaving the AC's required detail blank.
    return {
      detail:
        run.stateTransitionReason ??
        (run.state === "queued"
          ? "queued for dispatch"
          : "preparing workspace"),
      issueNumber: input.issueNumber,
      pillHtml,
      title: run.issueTitle
    };
  }

  const snapshot = input.snapshot;
  if (snapshot === undefined) {
    return {
      detail: "",
      issueNumber: input.issueNumber,
      pillHtml: labelPill("unknown", "neutral"),
      title: ""
    };
  }
  if (snapshot.kind === "filtered") {
    return {
      detail: snapshot.reasons.join(", "),
      issueNumber: input.issueNumber,
      pillHtml: labelPill("filtered", "neutral"),
      title: snapshot.title
    };
  }
  const atCap =
    input.maxInFlight !== undefined && input.inFlight >= input.maxInFlight;
  return {
    detail: atCap
      ? `queued behind cap (${input.inFlight}/${input.maxInFlight})`
      : "within cap, next by priority",
    issueNumber: input.issueNumber,
    pillHtml: labelPill("eligible", "neutral"),
    title: snapshot.title
  };
}

function renderProjectIssuesTable(rows: ProjectIssueRow[]): string {
  if (rows.length === 0) {
    return `<section>${sectionHead("Issues", 0)}<div class="empty"><strong>No issues</strong>No open issue is currently eligible, filtered, or claimed for this Project.</div></section>`;
  }
  const body = rows
    .map(
      (row) =>
        `<tr><td>#${row.issueNumber}</td><td class="c-title">${escapeHtml(row.title)}</td><td>${row.pillHtml}</td><td class="c-detail">${escapeHtml(row.detail)}</td></tr>`
    )
    .join("");
  return tableSection(
    "Issues",
    rows.length,
    "<tr><th>#</th><th>Title</th><th>State</th><th>Detail</th></tr>",
    body
  );
}

// A Routine name is globally unique across the *current* declared config
// (ADR 0069), but a removed declaration's target rows are soft-disabled,
// never deleted (src/routines/dispatcher.ts documents this: "Routine names
// are unique only per (project_name, name) — a routine soft-disabled with
// disabled_reason 'removed_from_config' is never deleted, so an unrelated,
// later-declared routine elsewhere can legitimately reuse its name"). A
// stale disabled row still passes listRoutines()'s default
// `state != 'inactive'` filter, so grouping by name alone could fold a dead
// declaration's row into a live, unrelated routine's target count. Source
// path is stable per declaration and shared by every target one `routines:`
// entry materializes, so grouping on (name, sourcePath) keeps that
// cross-declaration merge from happening while still collapsing an
// N-target Routine into one row — the failure mode #302 exists to prevent.
// Full per-target detail
// (skip counters, firing history, latest outcome) moves to /routines/:name
// (#304); this row only needs enough to answer "is it scheduled, and when
// does it next run."
type RoutineGroup = {
  kind: RoutineKind;
  name: string;
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
  targets: RoutineStatus[];
};

function groupRoutinesByName(routines: RoutineStatus[]): RoutineGroup[] {
  const byKey = new Map<string, RoutineGroup>();
  for (const routine of routines) {
    const key = `${routine.name} ${routine.sourcePath}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = {
        kind: routine.kind,
        name: routine.name,
        scheduleAt: routine.scheduleAt,
        scheduleCron: routine.scheduleCron,
        scheduleTz: routine.scheduleTz,
        targets: []
      };
      byKey.set(key, group);
    }
    group.targets.push(routine);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Widened past RoutineGroup so #304's declaration card can format a
// specific resolved target's schedule (see resolveRoutineDeclaration)
// without a duplicate copy of this two-line rule.
function formatRoutineSchedule(schedule: {
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
}): string {
  if (schedule.scheduleCron !== null) {
    return `${schedule.scheduleCron} (${schedule.scheduleTz ?? "UTC"})`;
  }
  return schedule.scheduleAt ?? "-";
}

// A group with no active target shows its shared lifecycle state (plus
// reason, when the representative target has one) instead of a next-fire
// time that will never come.
function renderRoutineGroupStatus(group: RoutineGroup): string {
  const active = group.targets.filter((target) => target.state === "active");
  if (active.length > 0) {
    const nextFireAt = active
      .map((target) => target.nextFireAt)
      .filter((value): value is string => value !== null)
      .sort()[0];
    const partial =
      active.length === group.targets.length
        ? ""
        : ` <span class="muted">(${active.length}/${group.targets.length} active)</span>`;
    return `<code>${escapeHtml(nextFireAt ?? "-")}</code>${partial}`;
  }
  const [representative] = group.targets;
  if (representative === undefined) {
    return "-";
  }
  const reason =
    representative.disabledReason === null
      ? ""
      : ` <span class="muted">(${escapeHtml(representative.disabledReason)})</span>`;
  return `${routineStatePill(representative.state)}${reason}`;
}

function renderRoutinesSection(groups: RoutineGroup[]): string {
  if (groups.length === 0) {
    return `<section>${sectionHead("Routines", 0)}<div class="empty"><strong>No Routines configured</strong>A Routine is a scheduled prompt that can launch a Coding Agent against one or more Projects without a GitHub Issue. Declare one in the service config's top-level <code>routines:</code> block to see it here.</div></section>`;
  }
  const rows = groups
    .map((group) => {
      const routineLink = `<a href="/routines/${encodeURIComponent(group.name)}">${escapeHtml(group.name)}</a>`;
      const targetsLink = `<a href="/routines/${encodeURIComponent(group.name)}">${group.targets.length}</a>`;
      return `<tr><td>${routineLink}</td><td>${escapeHtml(group.kind)}</td><td class="c-detail"><code>${escapeHtml(formatRoutineSchedule(group))}</code></td><td>${targetsLink}</td><td>${renderRoutineGroupStatus(group)}</td></tr>`;
    })
    .join("");
  return tableSection(
    "Routines",
    groups.length,
    "<tr><th>Routine</th><th>Kind</th><th>Schedule</th><th>Targets</th><th>Next fire</th></tr>",
    rows
  );
}

// More than one distinct (name, sourcePath) declaration currently shares
// this name — the same stale-name-reuse case groupRoutinesByName's own
// comment documents. Rather than guess which one the caller meant, list
// them and let ?project=<name> pick one, mirroring the disambiguation
// contract GET /api/routines/:id/firings already exposes via its own
// ?project= parameter.
function renderRoutineDisambiguation(
  name: string,
  groups: RoutineGroup[]
): string {
  const items = groups
    .map((group) => {
      const [representative] = group.targets;
      const sourcePath =
        representative === undefined ? "-" : representative.sourcePath;
      const targetLinks = group.targets
        .map(
          (target) =>
            `<a href="/routines/${encodeURIComponent(name)}?project=${encodeURIComponent(target.projectName)}">${escapeHtml(target.projectName)}</a>`
        )
        .join(", ");
      return `<li><code>${escapeHtml(sourcePath)}</code> — targets: ${targetLinks}</li>`;
    })
    .join("");
  return `<h1 class="page-title">${escapeHtml(name)}</h1><section><div class="empty"><strong>Multiple declarations share this name</strong>An earlier declaration was likely removed from config and a later one reused the name for a different target. Pick a target Project to disambiguate:<ul>${items}</ul></div></section>`;
}

type RoutineDeclarationView = {
  allowOverlap: boolean;
  catchUp: string;
  invalid: boolean;
  kind: RoutineKind;
  prompt: string | null;
  provider: string | null;
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
  sourcePath: string;
};

// The declaration (prompt, kind, provider, schedule, allowOverlap,
// catchUp, sourcePath) is materialized identically on every target row for
// the same (name, sourcePath) group (ADR 0069), so any one *valid* target
// carries the full declaration. 'invalid' targets are placeholder stubs
// (upsertInvalidRoutineStub writes prompt_body/schedule_at as '') and are
// tried last, so one target's reload failure doesn't blank out a sibling
// target's real schedule/prompt — the #304 AC: "an invalid declaration
// shows the reload error without losing sibling schedule state." Only when
// every target is invalid or inactive does this fall back to the group's
// own bare fields, with prompt unavailable.
function resolveRoutineDeclaration(
  runStore: RunStore,
  group: RoutineGroup
): RoutineDeclarationView {
  const ordered = [
    ...group.targets.filter((target) => target.state !== "invalid"),
    ...group.targets.filter((target) => target.state === "invalid")
  ];
  for (const target of ordered) {
    const detail = runStore.getRoutine({
      name: target.name,
      projectName: target.projectName
    });
    if (detail !== undefined) {
      return {
        allowOverlap: detail.allowOverlap,
        catchUp: detail.catchUp,
        invalid: target.state === "invalid",
        kind: detail.kind,
        prompt: detail.prompt === "" ? null : detail.prompt,
        provider: detail.provider,
        scheduleAt: detail.scheduleAt,
        scheduleCron: detail.scheduleCron,
        scheduleTz: detail.scheduleTz,
        sourcePath: detail.sourcePath
      };
    }
  }
  const [representative] = group.targets;
  return {
    allowOverlap: representative?.allowOverlap ?? false,
    catchUp: representative?.catchUp ?? "skip",
    invalid: representative?.state === "invalid",
    kind: group.kind,
    prompt: null,
    provider: representative?.provider ?? null,
    scheduleAt: representative?.scheduleAt ?? null,
    scheduleCron: representative?.scheduleCron ?? null,
    scheduleTz: representative?.scheduleTz ?? null,
    sourcePath: representative?.sourcePath ?? "-"
  };
}

function renderRoutineDeclarationCard(
  declaration: RoutineDeclarationView,
  reloadErrors: string[]
): string {
  const errorBanner =
    !declaration.invalid || reloadErrors.length === 0
      ? ""
      : `<div class="alert" role="alert"><strong>Reload error</strong><ul>${reloadErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
  const promptSection =
    declaration.prompt === null
      ? `<div class="empty"><strong>Prompt unavailable</strong>${declaration.invalid ? "This declaration failed to reload." : "Every target for this declaration is inactive — the prompt body is not retained once a declaration has no live target."}</div>`
      : `<div class="msg">${escapeHtml(declaration.prompt)}</div>`;
  return `${errorBanner}<section><dl class="fields">
  <dt>Kind</dt><dd>${escapeHtml(declaration.kind)}</dd>
  <dt>Provider</dt><dd>${declaration.provider === null ? '<span class="muted">inherited</span>' : escapeHtml(declaration.provider)}</dd>
  <dt>Schedule</dt><dd><code>${escapeHtml(formatRoutineSchedule(declaration))}</code></dd>
  <dt>Allow overlap</dt><dd>${declaration.allowOverlap ? "yes" : "no"}</dd>
  <dt>Catch up</dt><dd>${escapeHtml(declaration.catchUp)}</dd>
  <dt>Source</dt><dd><code>${escapeHtml(declaration.sourcePath)}</code></dd>
</dl></section><section>${sectionHead("Prompt")}${promptSection}</section>`;
}

function renderRoutineTargetsTable(group: RoutineGroup): string {
  const rows = group.targets
    .map((target) => {
      const reason =
        target.disabledReason === null
          ? ""
          : ` <span class="muted">(${escapeHtml(target.disabledReason)})</span>`;
      const skip =
        target.lastSkipReason === null
          ? '<span class="muted">none</span>'
          : `${escapeHtml(target.lastSkipReason)} <code>${escapeHtml(target.lastSkipAt ?? "-")}</code>`;
      const counts = `overlap ${target.skipCounts24h.overlap} · cap ${target.skipCounts24h.concurrency_cap} · catch-up ${target.skipCounts24h.catch_up_window}`;
      return `<tr><td>${escapeHtml(target.projectName)}</td><td>${routineStatePill(target.state)}${reason}</td><td><code>${escapeHtml(target.nextFireAt ?? "-")}</code></td><td><code>${escapeHtml(target.lastFiredAt ?? "-")}</code></td><td class="c-detail">${skip}</td><td class="c-detail">${counts}</td></tr>`;
    })
    .join("");
  return tableSection(
    "Targets",
    group.targets.length,
    "<tr><th>Project</th><th>State</th><th>Next fire</th><th>Last fired</th><th>Last skip</th><th>Skips (24h)</th></tr>",
    rows
  );
}

// Sibling firings admitted by one clock event share a fanoutId (ADR 0069);
// a manually triggered or pre-fan-out firing has none and stands alone.
// Grouping (rather than a flat newest-first list) is what makes an N-target
// event read as one event instead of N unrelated rows — the #304 AC.
function renderRoutineFiringHistory(firings: RoutineFiringStatus[]): string {
  if (firings.length === 0) {
    return `<section>${sectionHead("Firing history", 0)}<div class="empty"><strong>No firings yet</strong>This Routine has not fired for any of its current targets.</div></section>`;
  }
  const groups = new Map<string, RoutineFiringStatus[]>();
  for (const firing of firings) {
    const key = firing.fanoutId ?? firing.id;
    const members = groups.get(key);
    if (members === undefined) {
      groups.set(key, [firing]);
    } else {
      members.push(firing);
    }
  }
  // firings arrives ordered `created_at desc, id desc` (listRoutineFirings),
  // so each group's first-seen member is already its newest — this sort is
  // a defensive restatement of that invariant, not a correctness dependency
  // on Map insertion order.
  const ordered = [...groups.values()].sort((a, b) => {
    const left = a[0];
    const right = b[0];
    if (left === undefined || right === undefined) {
      return 0;
    }
    return right.createdAt.localeCompare(left.createdAt);
  });
  const rows = ordered
    .flatMap((members) => {
      const eventLabel =
        members.length > 1 ? `fan-out · ${members.length} targets` : "single";
      return [...members]
        .sort((a, b) => a.projectName.localeCompare(b.projectName))
        .map(
          (firing) =>
            `<tr><td class="c-detail">${escapeHtml(eventLabel)}</td><td><a href="/firings/${encodeURIComponent(firing.id)}"><code>${escapeHtml(firing.id)}</code></a></td><td>${escapeHtml(firing.projectName)}</td><td>${statePill(firing.state)}</td><td class="c-detail">${escapeHtml(firing.terminalReason ?? "")}</td><td><code>${escapeHtml(firing.createdAt)}</code></td></tr>`
        );
    })
    .join("");
  return tableSection(
    "Firing history",
    firings.length,
    "<tr><th>Event</th><th>Firing</th><th>Project</th><th>State</th><th>Terminal reason</th><th>Created</th></tr>",
    rows
  );
}

function collectActiveWatchdogIdleStatuses(
  runStore: RunStore,
  runs: RunStatus[],
  getWatchdogConfig: (
    projectName: string
  ) => Pick<WatchdogConfig, "enabled" | "graceMinutes">,
  nowMs: number
): Map<string, WatchdogIdleStatus> {
  const statuses = new Map<string, WatchdogIdleStatus>();
  for (const run of runs) {
    if (!ACTIVE_WATCHDOG_STATES.has(run.state)) {
      continue;
    }
    statuses.set(
      run.id,
      buildWatchdogIdleStatus({
        config: getWatchdogConfig(run.project),
        nowMs,
        runId: run.id,
        runStore
      })
    );
  }
  return statuses;
}

function renderWatchdogIdleBadge(
  watchdog: WatchdogIdleStatus | undefined,
  nowMs: number
): string {
  if (
    watchdog === undefined ||
    !watchdog.enabled ||
    watchdog.idleSince === undefined ||
    watchdog.graceRemainingMs === undefined
  ) {
    return "";
  }
  return ` <span class="badge badge--watchdog">watchdog idle since ${escapeHtml(formatAge(watchdog.idleSince, nowMs))} (${escapeHtml(formatWatchdogDuration(watchdog.graceRemainingMs))} remaining)</span>`;
}

const RUNS_TABLE_HEAD =
  "<tr><th>Run id</th><th>Project</th><th>Issue</th><th>State</th><th>Provider</th><th>Started</th><th>Updated</th><th>Branch</th></tr>";

function runRowHtml(
  run: RunStatus,
  watchdogByRun: Map<string, WatchdogIdleStatus>,
  nowMs: number
): string {
  return `<tr><td><a href="/runs/${encodeURIComponent(run.id)}"><code>${escapeHtml(run.id)}</code></a></td><td>${escapeHtml(run.project)}</td><td class="c-title">#${run.issueNumber} ${escapeHtml(run.issueTitle)}</td><td>${statePill(run.state)}${renderWatchdogIdleBadge(watchdogByRun.get(run.id), nowMs)}</td><td>${escapeHtml(run.provider)}</td><td><code>${escapeHtml(run.createdAt)}</code></td><td><code>${escapeHtml(run.updatedAt)}</code></td><td><code>${escapeHtml(run.branchName)}</code></td></tr>`;
}

function renderRunsTable(
  title: string,
  runs: RunStatus[],
  watchdogByRun: Map<string, WatchdogIdleStatus>,
  nowMs: number
): string {
  if (runs.length === 0) {
    const message = title.startsWith("Runs (")
      ? "No runs in this state yet."
      : "No runs yet. A Run appears here once the daemon claims an eligible issue and dispatches a coding agent; its state and evidence stay recorded for review.";
    return `<section>${sectionHead(title, 0)}<div class="empty"><strong>Nothing to show</strong>${escapeHtml(message)}</div></section>`;
  }

  const rows = runs
    .map((run) => runRowHtml(run, watchdogByRun, nowMs))
    .join("");
  return tableSection(title, runs.length, RUNS_TABLE_HEAD, rows);
}

const ROUTINE_FIRINGS_TABLE_HEAD =
  "<tr><th>Routine</th><th>Project</th><th>State</th><th>Started</th></tr>";

function firingRowHtml(firing: RoutineFiringStatus): string {
  return `<tr><td><a href="/routines/${encodeURIComponent(firing.routineName)}">${escapeHtml(firing.routineName)}</a></td><td>${escapeHtml(firing.projectName)}</td><td>${statePill(firing.state)}</td><td><code>${escapeHtml(firing.createdAt)}</code></td></tr>`;
}

// The active-now band (#302): every in-flight Run and Routine Firing,
// labelled by kind, above the drill-in. "In-flight" is defined as queued,
// preparing_workspace, or running — see ACTIVE_NOW_RUN_STATES_LIST /
// ACTIVE_NOW_FIRING_STATES_LIST for the deliberate exclusion of `waiting`.
// Rendered as two sub-tables under one heading, reusing the exact Runs row
// markup /runs uses (including the watchdog idle badge) rather than a
// bespoke component, per PRODUCT.md's "keep them legible tables" anti-
// reference against card-grid decoration.
function renderActiveNowBand(
  runs: RunStatus[],
  firings: RoutineFiringStatus[],
  watchdogByRun: Map<string, WatchdogIdleStatus>,
  nowMs: number
): string {
  const total = runs.length + firings.length;
  if (total === 0) {
    return `<section class="active-now">${sectionHead("Active now", 0)}<div class="empty"><strong>Nothing running right now</strong>${ACTIVE_NOW_DEFINITION_NOTE}</div></section>`;
  }
  const runsBlock =
    runs.length === 0
      ? ""
      : `<h3 class="subhead">Runs</h3><div class="table-wrap"><table><thead>${RUNS_TABLE_HEAD}</thead><tbody>${runs.map((run) => runRowHtml(run, watchdogByRun, nowMs)).join("")}</tbody></table></div>`;
  const firingsBlock =
    firings.length === 0
      ? ""
      : `<h3 class="subhead">Routine firings</h3><div class="table-wrap"><table><thead>${ROUTINE_FIRINGS_TABLE_HEAD}</thead><tbody>${firings.map((firing) => firingRowHtml(firing)).join("")}</tbody></table></div>`;
  return `<section class="active-now">${sectionHead("Active now", total)}<p class="note">${ACTIVE_NOW_DEFINITION_NOTE}</p>${runsBlock}${firingsBlock}</section>`;
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

function renderDaemonStaleBanner(
  tickAgeMs: number | null,
  pollingIntervalMs: number
): string {
  const threshold = Math.max(
    DAEMON_STALE_THRESHOLD_FLOOR_MS,
    pollingIntervalMs * DAEMON_STALE_THRESHOLD_INTERVAL_MULTIPLIER
  );
  if (tickAgeMs === null || tickAgeMs < threshold) {
    return "";
  }
  const minutes = Math.floor(tickAgeMs / 60_000);
  return `<section class="banner banner--attention"><p class="banner-title">Daemon may be unresponsive</p><p class="banner-reason">The daemon has stopped ticking — its last successful poll/reconcile cycle was ${minutes} minute${minutes === 1 ? "" : "s"} ago. Issue polling and run dispatch are likely stalled. If a systemd watchdog is configured, it will restart the daemon automatically; otherwise restart it manually.</p></section>`;
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

function renderWatchdogSection(
  watchdog: WatchdogStatus,
  outputTokenGrowth5m: number,
  nowMs: number
): string {
  if (!watchdog.enabled) {
    return "";
  }
  if (watchdog.sampledAt === undefined) {
    return `<section>${sectionHead("Watchdog")}<div class="empty"><strong>No sample yet</strong>No Progress Signal has been persisted for this Run.</div></section>`;
  }
  const idleRow =
    watchdog.idleSince !== undefined
      ? `<dt>idle_since</dt><dd><code>${escapeHtml(watchdog.idleSince)}</code></dd>`
      : "";
  const graceRow =
    watchdog.graceRemainingMs !== undefined
      ? `<dt>Grace remaining</dt><dd>${escapeHtml(formatWatchdogDuration(watchdog.graceRemainingMs))}</dd>`
      : "";
  return `<section>${sectionHead("Watchdog")}<dl class="fields">
  <dt>Last tool_call</dt><dd>${escapeHtml(formatAge(watchdog.lastToolCallAt, nowMs))}</dd>
  <dt>Workspace mtime</dt><dd>${escapeHtml(formatAge(watchdog.workspaceMtimeMax, nowMs))}</dd>
  <dt>turn_ids observed</dt><dd>${watchdog.turnIdSetSize ?? 0}</dd>
  <dt>Output tokens / 5m</dt><dd>${outputTokenGrowth5m === 0 ? "0" : `+${outputTokenGrowth5m}`}</dd>
  ${idleRow}
  ${graceRow}
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
