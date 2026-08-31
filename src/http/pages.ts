import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { parse } from "yaml";

import { contentHash } from "../content-hash.js";
import type { WorkflowFormat } from "../config-schemas.js";
import {
  checkMutationAuthorized,
  checkSameOriginRequest,
  CSRF_FIELD_NAME,
  csrfTokenFor,
  ensureSession,
  type CsrfSecret
} from "./csrf.js";
import type {
  MergePullRequestFn,
  PollNowFn,
  WriteIssueLabelsFn
} from "./app.js";
import type { AsyncMutex } from "../lifecycle/async-mutex.js";
import type { PullRequestState } from "../pull-request-state.js";
import { describeIssueVerdict } from "../issues/verdict.js";
import { setRoutineDisabled } from "../routines/declaration-editor.js";
import {
  loadRoutineDeclaration,
  parseRoutineDeclaration
} from "../routines/declaration-loader.js";
import { validateWorkflowContractContent } from "../workflow/fsm-expansion.js";
import { runSavePipeline, type ReloadOutcome } from "./save-pipeline.js";
import {
  DEFAULT_POLLING_INTERVAL_MS,
  type FilteredProjectIssueSnapshot,
  type IssuePollStatus,
  type RawGitHubIssueDependencyRef
} from "../issue-polling.js";
import {
  formatCapReachedReason,
  parseCapReachedReason
} from "../lifecycle/terminal-reason.js";
import {
  DEFAULT_WATCHDOG_CONFIG,
  validateServiceConfigContent,
  type WatchdogConfig
} from "../reload.js";
import type {
  ListRunsFilter,
  ProjectIssueSnapshotRow,
  ProjectLastRunStatus,
  ProjectPullRequestSnapshotRow,
  ProjectSnapshotRepository,
  ProjectState,
  ProviderEventRecord,
  PullRequestBranchOrigin,
  RoutineFiringStateTransition,
  RoutineFiringStatus,
  RunArtifactDescriptor,
  RunArtifactKind,
  RunState,
  RunStatus,
  RunStore,
  TrackedPullRequest
} from "../run-store.js";
import {
  readRecentRoutineEvents,
  routineEvidencePaths,
  statRoutineEvidenceFile,
  type RoutineEvidencePaths
} from "../routines/evidence.js";
import type {
  RoutineFiringState,
  RoutineKind,
  RoutinePullRequestStatus,
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
  issueNumber: number;
  kind: "retry" | "continuation" | "state_advance" | "wait_park";
  projectName: string;
  runId: string;
};

export type RegisterPagesOptions = {
  app: Hono;
  // Every mutating form embeds a token derived from this secret. See
  // docs/adr/0075-mutation-authentication-and-superseding-0027.md.
  csrfSecret: CsrfSecret;
  // #308 part 3's clear-stale-claim liveness gate: the in-process registry
  // source `collectLiveKeys` (src/lifecycle/stale-claims.ts) unions with
  // runStore.listActiveRunIds/listWaitingRunIds. See HttpAppOptions.getActiveRuns
  // (src/http/app.ts).
  getActiveRuns?: () => Array<{
    cancelReason: string | null;
    cancelRequested: boolean;
    issueNumber: number;
    projectName: string;
    runId: string;
  }>;
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
  // The daemon's live periodic-timer deadline. Poll-now runs the same tick
  // without resetting this timer, so poll history cannot reconstruct it.
  getNextPollAtMonotonic?: () => number | undefined;
  getPollingIntervalMs?: () => number | undefined;
  getTickLoopStartedAtMonotonic?: () => number | undefined;
  getPullRequestFollowupPolicy?: () => {
    maxReviewDispatchesPerPr: number;
  };
  // #307's service-config editor: the absolute path to symphonika.yml. See
  // HttpAppOptions.getConfigPath (src/http/app.ts).
  getConfigPath?: () => string;
  // #307's workflow-contract editor: a Dispatch Project's current resolved
  // workflow path and configured format, or undefined for a Routine Host
  // (no workflow) or an unknown Project name. See
  // HttpAppOptions.getProjectWorkflowPath (src/http/app.ts).
  getProjectWorkflowPath?: (
    projectName: string
  ) => { format: WorkflowFormat; path: string } | undefined;
  // Every configured project name (including projectName itself) whose
  // tracker resolves to the same GitHub owner/repo as projectName's — the
  // PR-merge and clear-stale-claim ownership guards need this so two
  // differently-named Projects pointing at one repo can't cross-clear or
  // cross-merge each other's live work. Undefined (not wired) degrades to
  // "just this project name", matching pre-existing behavior. See
  // HttpAppOptions.getProjectRepoAliases (src/http/app.ts) — the resolver
  // itself needs runtimeConfig.projectsByName(), which only daemon.ts has.
  getProjectRepoAliases?: (projectName: string) => string[];
  // The project's configured issue_filters.labels_all -- handleIssueLabelWrite's
  // dependency gate only blocks adding a label in this set. See
  // HttpAppOptions.getProjectRequiredLabels (src/http/app.ts).
  getProjectRequiredLabels?: (projectName: string) => string[];
  // The dependency graph view (/issues/graph) needs a Project's GitHub
  // owner/repo to build node ids and resolve "## Parent" clustering.
  // Undefined for a Routine Host or an unknown Project name -- that
  // project's issues are skipped from the graph rather than erroring. See
  // HttpAppOptions.getProjectRepo (src/http/app.ts).
  getProjectRepo?: (
    projectName: string
  ) => { owner: string; repo: string } | undefined;
  // #303's "retry ETA" detail for a waiting Run.
  getScheduled?: () => ScheduledCallback[];
  getStatusSnapshot?: () => StatusSnapshot;
  // #308 part 3's clear-stale-claim. See HttpAppOptions.claimMutex
  // (src/http/app.ts).
  claimMutex?: AsyncMutex;
  getWatchdogConfig?: (
    projectName: string
  ) => Pick<
    WatchdogConfig,
    "enabled" | "graceMinutes" | "maxRunMinutes" | "outputTokenBudget"
  >;
  issuePollStatus?: IssuePollStatus;
  // #309 part 3's guarded-merge action. See HttpAppOptions.mergePullRequest
  // (src/http/app.ts).
  mergePullRequest?: MergePullRequestFn;
  monotonicNow: () => number;
  now?: () => number;
  // #308 part 2's "poll now" offer after a label write. See
  // HttpAppOptions.pollNow (src/http/app.ts).
  pollNow?: PollNowFn;
  // #307's editors: see HttpAppOptions.resolveWritePath (src/http/app.ts)
  // and src/path-safety.ts.
  resolveWritePath?: (candidatePath: string) => Promise<string | undefined>;
  runStore: RunStore;
  // #304's /firings/:id evidence — routineEvidencePaths derives a Firing's
  // log/prompt paths from stateRoot + firing id, the same convention
  // src/http/app.ts's /logs/firings/:id/:kind route already streams from.
  stateRoot: string;
  // #303's "pre-restart" staleness marker: a persisted snapshot whose last
  // successful poll predates process start hasn't been refreshed since the
  // daemon came up. See ADR 0073.
  startedAtMs?: number;
  // #307's editors: see HttpAppOptions.triggerReload (src/http/app.ts).
  triggerReload?: () => Promise<ReloadOutcome>;
  version: string;
  // #308 part 2's label-write action. See HttpAppOptions.writeIssueLabels
  // (src/http/app.ts).
  writeIssueLabels?: WriteIssueLabelsFn;
};

// Runs whose watchdog idle badge is meaningful on the active-runs list — a
// terminated Run's last persisted sample can still show idleSince set, but
// "time remaining before termination" no longer applies once it has already
// terminated (see the Run-detail page's final-Progress-Signal treatment
// instead). Attempt start clears the latest sample before exposing
// preparing_workspace, so including that active state cannot leak the prior
// attempt's idle clock.
const ACTIVE_WATCHDOG_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "preparing_workspace",
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

const TERMINAL_FIRING_STATES: ReadonlySet<RoutineFiringState> = new Set([
  "succeeded",
  "failed",
  "cancelled"
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

// #308's triage search: the only two verdict-filter values the page's own
// <select> ever submits — an unrecognized value (hand-edited URL) is treated
// as "no filter" rather than silently matching nothing, mirroring how /runs
// treats an unrecognized ?state= (KNOWN_RUN_STATES, above).
const KNOWN_ISSUE_VERDICT_FILTERS: ReadonlySet<string> = new Set([
  "eligible",
  "filtered"
]);

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
  // Same gate as src/http/app.ts's own mutating routes -- an editor's
  // preview step does no write, but it does meaningful server-side work
  // (validation) against caller-supplied content, so it gets the same
  // same-origin/CSRF check as the confirm step that actually writes. See
  // docs/adr/0075-mutation-authentication-and-superseding-0027.md.
  const requireAuthorizedMutation: MiddlewareHandler = async (
    context,
    next
  ) => {
    const authorization = await checkMutationAuthorized(
      context,
      options.csrfSecret
    );
    if (!authorization.ok) {
      return context.json({ error: authorization.reason }, 403);
    }
    await next();
  };

  // GET /config/edit returns the raw service config, including
  // providers.*.command secrets — a DNS-rebound attacker origin could read
  // it even though it could never forge a POST past requireAuthorizedMutation,
  // since a GET has no CSRF token to check. This is the Origin/Host half of
  // that same defense, without the token requirement a page load can't meet.
  const requireSameOriginRead: MiddlewareHandler = async (context, next) => {
    const authorization = checkSameOriginRequest(context);
    if (!authorization.ok) {
      return context.json({ error: authorization.reason }, 403);
    }
    await next();
  };

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

  // #467's bulk multi-select label editing: the /issues page's React
  // island (src/client/issues-bulk.tsx), bundled by esbuild
  // (scripts/build-client.mjs) into dist/client/issues-bulk.js. Resolved
  // relative to this compiled module's own location, two directories up to
  // the repo root then into dist/client -- that's the same relative path
  // whether this file is running as src/http/pages.ts (tsx, dev) or
  // dist/http/pages.js (tsc, prod), since dist/ is always a sibling of
  // src/ at the repo root. Not embedded as a source constant (unlike
  // src/http/fonts.ts): unlike the pinned, rarely-regenerated font bytes,
  // this bundle changes with every edit to actively-developed app code.
  const clientBundlePath = fileURLToPath(
    new URL("../../dist/client/issues-bulk.js", import.meta.url)
  );
  options.app.get("/assets/issues-bulk.js", async (context) => {
    let bytes: ArrayBuffer;
    try {
      const buffer = await readFile(clientBundlePath);
      bytes = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );
    } catch {
      return context.notFound();
    }
    return new Response(bytes, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
      status: 200
    });
  });

  // The dependency graph view's React island (src/client/issues-deps-graph.tsx),
  // bundled the same way as issues-bulk.js above -- see that route's comment
  // for why the path is resolved relative to this compiled module.
  const depsGraphBundlePath = fileURLToPath(
    new URL("../../dist/client/issues-deps-graph.js", import.meta.url)
  );
  options.app.get("/assets/issues-deps-graph.js", async (context) => {
    let bytes: ArrayBuffer;
    try {
      const buffer = await readFile(depsGraphBundlePath);
      bytes = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );
    } catch {
      return context.notFound();
    }
    return new Response(bytes, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
      status: 200
    });
  });

  // Shared by GET / and the /fragments/* routes below (#305 part 2) so a
  // live-update fetch renders from the exact same inputs a full page load
  // would, not a second hand-maintained assembly. See ADR 0074.
  function assembleDashboardData(): {
    activeFirings: RoutineFiringStatus[];
    activeRuns: RunStatus[];
    lastRunByProject: ReadonlyMap<string, ProjectLastRunStatus>;
    nowMs: number;
    snapshot: StatusSnapshot | undefined;
    watchdogByRun: Map<string, WatchdogIdleStatus>;
  } {
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
    // Lazily resolved and memoised: /fragments/active-band shares this
    // assembly but never reads lastRunByProject, and the query behind it
    // scans every Run and its state transitions on a fragment refetched on
    // every SSE event.
    let memoizedLastRunByProject:
      ReadonlyMap<string, ProjectLastRunStatus> | undefined;
    return {
      activeFirings,
      activeRuns,
      get lastRunByProject() {
        memoizedLastRunByProject ??= options.runStore.listLatestRunsByProject({
          projectNames: (snapshot?.projectStates ?? []).map(
            (project) => project.projectName
          ),
          states: PROJECT_LAST_RUN_STATES
        });
        return memoizedLastRunByProject;
      },
      nowMs,
      snapshot,
      watchdogByRun
    };
  }

  options.app.get("/fragments/active-band", (context) => {
    const data = assembleDashboardData();
    return context.html(
      renderActiveNowBand(
        data.activeRuns,
        data.activeFirings,
        data.watchdogByRun,
        data.nowMs
      )
    );
  });

  options.app.get("/fragments/projects-section", (context) => {
    const data = assembleDashboardData();
    return context.html(
      renderProjectsSection(
        data.snapshot,
        options.issuePollStatus,
        data.activeRuns,
        data.activeFirings,
        data.lastRunByProject,
        data.nowMs
      )
    );
  });

  options.app.get("/", (context) => {
    const data = assembleDashboardData();
    const includeInactive = context.req.query("include_inactive") === "true";
    const {
      activeFirings,
      activeRuns,
      lastRunByProject,
      nowMs,
      snapshot,
      watchdogByRun
    } = data;
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
    // Classify declarations from every durable target before applying the
    // inactive-target visibility policy. Otherwise an inactive current target
    // can disappear first and make its removed sibling look like an entirely
    // removed declaration.
    const routineGroups = groupRoutinesByName(
      options.runStore.listRoutines({ includeInactive: true })
    ).flatMap((group) => {
      const currentTargets = currentRoutineTargets(group);
      if (currentTargets.length === 0) {
        return [group];
      }
      const visibleTargets = includeInactive
        ? currentTargets
        : currentTargets.filter((target) => target.state !== "inactive");
      return visibleTargets.length === 0
        ? []
        : groupRoutinesByName(visibleTargets);
    });
    const html = layout(
      "Symphonika",
      [
        `<h1 class="page-title">Dashboard</h1>`,
        renderDaemonStaleBanner(tickAgeMs, pollingIntervalMs),
        renderHeader(options.version, snapshot),
        DASHBOARD_STREAM_BANNER,
        `<div id="active-now-band">${renderActiveNowBand(activeRuns, activeFirings, watchdogByRun, nowMs)}</div>`,
        renderRoutinesSection(routineGroups, includeInactive),
        `<div id="projects-section">${renderProjectsSection(snapshot, options.issuePollStatus, activeRuns, activeFirings, lastRunByProject, nowMs)}</div>`,
        renderStaleIssuesCard(options.issuePollStatus?.filteredIssues ?? []),
        `<script>${DASHBOARD_LIVE_CLIENT_JS}</script>`
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
      runCreatedAt: detail.createdAt,
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
    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const sections = [
      `<h1 class="page-title">Run <code>${escapeHtml(detail.id)}</code></h1>`,
      renderOutcomeBanner(detail, failureEvent, exitEvent),
      renderPullRequestFollowupAttention(pullRequestFollowup),
      renderRunSummary(detail, capContext),
      renderWatchdogSection(watchdog, outputTokenGrowth5m, detailNowMs),
      renderWorkflowGraphSummary(detail.id, workflowGraph),
      renderCancelForm(detail, csrfToken),
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
        renderWorkflowGraphPage(detail.id, workflowStateId(detail), graph)
      )
    );
  });

  options.app.get("/issues", (context) => {
    const verdictParam = normalizeQueryParam(context.req.query("verdict"));
    const filters: IssueSearchFilters = {
      label: normalizeQueryParam(context.req.query("label")),
      project: normalizeQueryParam(context.req.query("project")),
      q: normalizeQueryParam(context.req.query("q")),
      verdict:
        verdictParam !== undefined &&
        KNOWN_ISSUE_VERDICT_FILTERS.has(verdictParam)
          ? verdictParam
          : undefined
    };
    const nowMs = now();
    const projectNames = options.runStore.listActiveProjectNames();
    const rows = searchIssueSnapshots({
      filters,
      nowMs,
      projectNames,
      runStore: options.runStore,
      scheduled: options.getScheduled?.() ?? [],
      startedAtMs: options.startedAtMs
    });
    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      "Issue triage",
      renderIssueSearchPage({ csrfToken, filters, nowMs, projectNames, rows })
    );
    return context.html(html);
  });

  options.app.get("/issues/graph", (context) => {
    const projectFilter = normalizeQueryParam(context.req.query("project"));
    const projectNames = Array.from(
      new Set(
        options.runStore.listProjectStates().map((state) => state.projectName)
      )
    ).sort();
    const targetProjects =
      projectFilter === undefined
        ? projectNames
        : projectNames.filter((name) => name === projectFilter);
    const issues = buildDependencyGraphIssues({
      getProjectRepo: options.getProjectRepo,
      runStore: options.runStore,
      targetProjects
    });
    // Only resolvable when exactly one Project is selected -- with the
    // "all projects" view (projectFilter undefined) there's no way to know
    // which Project's repo a bare issue number belongs to.
    const issueParam = parsePositiveIntQueryParam(context.req.query("issue"));
    const focusRepo =
      projectFilter === undefined
        ? undefined
        : options.getProjectRepo?.(projectFilter);
    const focusIssue =
      issueParam === undefined || focusRepo === undefined
        ? undefined
        : {
            issueNumber: issueParam,
            owner: focusRepo.owner,
            repo: focusRepo.repo
          };
    const html = layout(
      "Issue dependency graph",
      renderIssueDependencyGraphPage({
        focusIssue,
        issues,
        projectFilter,
        projectNames
      })
    );
    return context.html(html);
  });

  options.app.get("/issues/:project/:number", (context) => {
    const projectName = context.req.param("project");
    const issueNumber = Number.parseInt(context.req.param("number"), 10);
    const detail = loadIssueDetail(
      options.runStore,
      projectName,
      issueNumber,
      options.getScheduled?.() ?? []
    );
    if (detail === undefined) {
      return context.html(
        renderIssueNotFound(projectName, context.req.param("number")),
        404
      );
    }
    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `#${issueNumber} ${detail.snapshot.title}`,
      renderIssueDetailPage({
        banner: undefined,
        csrfToken,
        detail,
        pollNowAvailable: options.pollNow !== undefined
      })
    );
    return context.html(html);
  });

  async function handleIssueLabelWrite(
    context: Context,
    projectName: string,
    issueNumberParam: string,
    action: "add" | "remove"
  ): Promise<Response> {
    const issueNumber = Number.parseInt(issueNumberParam, 10);
    const detail = loadIssueDetail(
      options.runStore,
      projectName,
      issueNumber,
      options.getScheduled?.() ?? []
    );
    if (detail === undefined) {
      return context.html(
        renderIssueNotFound(projectName, issueNumberParam),
        404
      );
    }

    const body = (await context.req.parseBody()) as Record<string, unknown>;
    const label = (readOptionalFormField(body, "label") ?? "").trim();
    const snapshotRepository = readSnapshotRepository(body);

    let banner: IssueLabelWriteBanner;
    if (label.length === 0) {
      banner = {
        action,
        error: "a label is required",
        kind: "label_write",
        label,
        ok: false
      };
    } else if (isOrchestratorLabel(label)) {
      banner = {
        action,
        error:
          "sym:* labels are managed by Symphonika and can't be edited here (ADR 0002/0024)",
        kind: "label_write",
        label,
        ok: false
      };
    } else if (
      action === "add" &&
      (options.getProjectRequiredLabels?.(projectName) ?? [])
        .map((requiredLabel) => requiredLabel.toLowerCase())
        .includes(label.toLowerCase()) &&
      issueDependencyGateBlocks(detail.snapshot)
    ) {
      // Hard block, no override (see docs/adr, issue dependency gating):
      // the only way past this is to actually resolve the dependency on
      // GitHub. This is best-effort UX against a snapshot that can be up
      // to ~30s stale (ADR 0073) -- the authoritative gate is
      // evaluateProjectEligibility, re-evaluated every poll regardless of
      // what this route allowed. offerPollNow lets an operator who just
      // closed the blocker refresh immediately rather than wait it out.
      banner = {
        action,
        error: `${issueDependencyGateMessage(detail.snapshot)} -- resolve on GitHub, then poll now`,
        kind: "label_write",
        label,
        offerPollNow: true,
        ok: false
      };
    } else if (options.writeIssueLabels === undefined) {
      banner = {
        action,
        error: "label writes are unavailable",
        kind: "label_write",
        label,
        ok: false
      };
    } else {
      const result = await options.writeIssueLabels({
        add: action === "add" ? [label] : [],
        kind: "issue",
        projectName,
        remove: action === "remove" ? [label] : [],
        snapshotRepository,
        subjectNumber: issueNumber
      });
      banner = result.ok
        ? { action, kind: "label_write", label, ok: true }
        : {
            action,
            error: result.error,
            kind: "label_write",
            label,
            ok: false
          };
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `#${issueNumber} ${detail.snapshot.title}`,
      renderIssueDetailPage({
        banner,
        csrfToken,
        detail,
        pollNowAvailable: options.pollNow !== undefined
      })
    );
    return context.html(html);
  }

  options.app.post(
    "/issues/:project/:number/labels/add",
    requireAuthorizedMutation,
    (context) =>
      handleIssueLabelWrite(
        context,
        context.req.param("project"),
        context.req.param("number"),
        "add"
      )
  );
  options.app.post(
    "/issues/:project/:number/labels/remove",
    requireAuthorizedMutation,
    (context) =>
      handleIssueLabelWrite(
        context,
        context.req.param("project"),
        context.req.param("number"),
        "remove"
      )
  );

  options.app.post(
    "/api/issues/bulk-labels",
    requireAuthorizedMutation,
    async (context) => {
      const body = (await context.req.json().catch(() => undefined)) as
        | {
            addLabels?: unknown;
            operations?: unknown;
            removeLabels?: unknown;
          }
        | undefined;
      const addLabelsResult = asStringArray("addLabels", body?.addLabels);
      const removeLabelsResult = asStringArray(
        "removeLabels",
        body?.removeLabels
      );
      const operationsResult = asBulkIssueOperations(body?.operations);
      if (!addLabelsResult.ok) {
        return context.json({ error: addLabelsResult.error }, 400);
      }
      if (!removeLabelsResult.ok) {
        return context.json({ error: removeLabelsResult.error }, 400);
      }
      if (!operationsResult.ok) {
        return context.json({ error: operationsResult.error }, 400);
      }
      const addLabels = addLabelsResult.values;
      const removeLabels = removeLabelsResult.values;
      const operations = operationsResult.values;
      const orchestratorLabel = [...addLabels, ...removeLabels].find((label) =>
        isOrchestratorLabel(label)
      );
      if (orchestratorLabel !== undefined) {
        return context.json(
          {
            error:
              "sym:* labels are managed by Symphonika and can't be edited here (ADR 0002/0024)"
          },
          400
        );
      }
      if (operations.length === 0) {
        return context.json(
          { error: "at least one issue in operations is required" },
          400
        );
      }
      if (addLabels.length === 0 && removeLabels.length === 0) {
        return context.json(
          { error: "at least one label to add or remove is required" },
          400
        );
      }
      if (options.writeIssueLabels === undefined) {
        return context.json({ error: "label writes are unavailable" }, 503);
      }
      const results = await runBulkIssueLabelWrites({
        addLabels,
        getProjectRequiredLabels: (projectName) =>
          options.getProjectRequiredLabels?.(projectName) ?? [],
        operations,
        removeLabels,
        runStore: options.runStore,
        writeIssueLabels: options.writeIssueLabels
      });
      return context.json({ results }, 200);
    }
  );

  async function handleClearStaleClaim(
    context: Context,
    projectName: string,
    issueNumberParam: string
  ): Promise<Response> {
    const issueNumber = Number.parseInt(issueNumberParam, 10);
    const detail = loadIssueDetail(
      options.runStore,
      projectName,
      issueNumber,
      options.getScheduled?.() ?? []
    );
    if (detail === undefined) {
      return context.html(
        renderIssueNotFound(projectName, issueNumberParam),
        404
      );
    }

    const body = (await context.req.parseBody()) as Record<string, unknown>;
    const snapshotRepository = readSnapshotRepository(body);

    const snapshotClaimLabels = detail.snapshot.labels.filter((label) =>
      STALE_CLEAR_LABELS.has(label)
    );
    // The snapshot decides whether this named action is relevant, but it is
    // deliberately allowed to lag live GitHub state. Always attempt the full
    // ADR-0038 set; the GitHub adapter treats an already-absent label as an
    // idempotent success inside its per-label loop.
    const labelsToClear = Array.from(STALE_CLEAR_LABELS);

    let banner: IssueClearStaleClaimBanner;
    if (snapshotClaimLabels.length === 0) {
      banner = {
        error: "This issue has no stale-claim labels to clear.",
        kind: "clear_stale_claim",
        ok: false
      };
    } else {
      // RunController's own retry-claim path (reserveSlot + the sym:claimed
      // label add) serializes through this same mutex (ADR 0052) — without
      // it, a claim could land between the liveness check below and the
      // label-removal write, and get wiped out as "stale" even though a
      // live Run now genuinely owns this issue.
      await options.claimMutex?.acquire();
      try {
        const liveRunId = findLiveRunIdForIssue({
          getActiveRuns: options.getActiveRuns,
          getProjectRepoAliases: options.getProjectRepoAliases,
          getScheduled: options.getScheduled,
          issueNumber,
          projectName,
          runStore: options.runStore
        });
        if (liveRunId !== undefined) {
          banner = {
            error: `Refused: run ${liveRunId} is live for this issue.`,
            kind: "clear_stale_claim",
            ok: false
          };
        } else if (options.writeIssueLabels === undefined) {
          banner = {
            error: "label writes are unavailable",
            kind: "clear_stale_claim",
            ok: false
          };
        } else {
          const result = await options.writeIssueLabels({
            add: [],
            kind: "issue",
            projectName,
            remove: labelsToClear,
            snapshotRepository,
            subjectNumber: issueNumber
          });
          banner = result.ok
            ? {
                clearedLabels: labelsToClear,
                kind: "clear_stale_claim",
                ok: true
              }
            : { error: result.error, kind: "clear_stale_claim", ok: false };
        }
      } finally {
        options.claimMutex?.release();
      }
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `#${issueNumber} ${detail.snapshot.title}`,
      renderIssueDetailPage({
        banner,
        csrfToken,
        detail,
        pollNowAvailable: options.pollNow !== undefined
      })
    );
    return context.html(html);
  }

  options.app.post(
    "/issues/:project/:number/clear-stale-claim",
    requireAuthorizedMutation,
    (context) =>
      handleClearStaleClaim(
        context,
        context.req.param("project"),
        context.req.param("number")
      )
  );

  options.app.post(
    "/issues/poll-now",
    requireAuthorizedMutation,
    async (context) => {
      const body = (await context.req.parseBody()) as Record<string, unknown>;
      const returnTo = normalizePollNowReturnTo(
        readOptionalFormField(body, "return_to")
      );
      const result = await Promise.resolve(options.pollNow?.());
      const html = layout(
        "Poll now",
        `<h1 class="page-title">Poll now</h1><p class="note">${result === undefined ? "Poll-now trigger unavailable." : `Poll ${escapeHtml(result.kind)}.`}</p><p class="note"><a href="${escapeHtml(returnTo)}">← Back to search</a></p>`
      );
      return context.html(html);
    }
  );

  options.app.get("/prs", (context) => {
    const filters: PullRequestSearchFilters = {
      origin: normalizePullRequestOriginFilter(context.req.query("origin")),
      project: normalizeQueryParam(context.req.query("project")),
      q: normalizeQueryParam(context.req.query("q")),
      tracking: normalizePullRequestTrackingFilter(
        context.req.query("tracking")
      )
    };
    const nowMs = now();
    const projectNames = Array.from(
      new Set(
        options.runStore.listProjectStates().map((state) => state.projectName)
      )
    ).sort();
    const rows = searchPullRequestSnapshots({
      filters,
      nowMs,
      projectNames,
      runStore: options.runStore,
      startedAtMs: options.startedAtMs
    });
    const html = layout(
      "Pull requests",
      renderPullRequestSearchPage({ filters, nowMs, projectNames, rows })
    );
    return context.html(html);
  });

  options.app.get("/prs/:project/:number", (context) => {
    const projectName = context.req.param("project");
    const prNumber = Number.parseInt(context.req.param("number"), 10);
    const detail = loadPullRequestDetail(
      options.runStore,
      projectName,
      prNumber,
      options.getProjectRepoAliases
    );
    if (detail === undefined) {
      return context.html(
        renderPullRequestNotFound(projectName, context.req.param("number")),
        404
      );
    }
    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `PR #${prNumber} ${detail.snapshot.title}`,
      renderPullRequestDetailPage({
        banner: undefined,
        csrfToken,
        detail,
        liveOwnerRunId: livePullRequestOwnerLabel({
          detail,
          getActiveRuns: options.getActiveRuns,
          getProjectRepoAliases: options.getProjectRepoAliases,
          getScheduled: options.getScheduled,
          runStore: options.runStore
        }),
        pollNowAvailable: options.pollNow !== undefined
      })
    );
    return context.html(html);
  });

  async function handlePullRequestLabelWrite(
    context: Context,
    projectName: string,
    prNumberParam: string,
    action: "add" | "remove"
  ): Promise<Response> {
    const prNumber = Number.parseInt(prNumberParam, 10);
    const detail = loadPullRequestDetail(
      options.runStore,
      projectName,
      prNumber,
      options.getProjectRepoAliases
    );
    if (detail === undefined) {
      return context.html(
        renderPullRequestNotFound(projectName, prNumberParam),
        404
      );
    }

    const body = (await context.req.parseBody()) as Record<string, unknown>;
    const label = (readOptionalFormField(body, "label") ?? "").trim();
    const snapshotRepository = readSnapshotRepository(body);

    let banner: PullRequestLabelWriteBanner;
    if (label.length === 0) {
      banner = {
        action,
        error: "a label is required",
        kind: "label_write",
        label,
        ok: false
      };
    } else if (isOrchestratorLabel(label)) {
      banner = {
        action,
        error:
          "sym:* labels are managed by Symphonika and can't be edited here (ADR 0002/0024)",
        kind: "label_write",
        label,
        ok: false
      };
    } else if (options.writeIssueLabels === undefined) {
      banner = {
        action,
        error: "label writes are unavailable",
        kind: "label_write",
        label,
        ok: false
      };
    } else {
      const result = await options.writeIssueLabels({
        add: action === "add" ? [label] : [],
        kind: "pull_request",
        projectName,
        remove: action === "remove" ? [label] : [],
        snapshotRepository,
        subjectNumber: prNumber
      });
      banner = result.ok
        ? { action, kind: "label_write", label, ok: true }
        : {
            action,
            error: result.error,
            kind: "label_write",
            label,
            ok: false
          };
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `PR #${prNumber} ${detail.snapshot.title}`,
      renderPullRequestDetailPage({
        banner,
        csrfToken,
        detail,
        liveOwnerRunId: livePullRequestOwnerLabel({
          detail,
          getActiveRuns: options.getActiveRuns,
          getProjectRepoAliases: options.getProjectRepoAliases,
          getScheduled: options.getScheduled,
          runStore: options.runStore
        }),
        pollNowAvailable: options.pollNow !== undefined
      })
    );
    return context.html(html);
  }

  options.app.post(
    "/prs/:project/:number/labels/add",
    requireAuthorizedMutation,
    (context) =>
      handlePullRequestLabelWrite(
        context,
        context.req.param("project"),
        context.req.param("number"),
        "add"
      )
  );
  options.app.post(
    "/prs/:project/:number/labels/remove",
    requireAuthorizedMutation,
    (context) =>
      handlePullRequestLabelWrite(
        context,
        context.req.param("project"),
        context.req.param("number"),
        "remove"
      )
  );

  async function handlePullRequestMerge(
    context: Context,
    projectName: string,
    prNumberParam: string
  ): Promise<Response> {
    const prNumber = Number.parseInt(prNumberParam, 10);
    const detail = loadPullRequestDetail(
      options.runStore,
      projectName,
      prNumber,
      options.getProjectRepoAliases
    );
    if (detail === undefined) {
      return context.html(
        renderPullRequestNotFound(projectName, prNumberParam),
        404
      );
    }

    // The SHA the merge is pinned to is whatever the operator's page
    // actually showed (submitted from the GET page's hidden field), not a
    // fresh re-read of the snapshot -- a poll landing between page-load
    // and the click would otherwise let this validate a commit the
    // operator never saw. Missing/blank is only permissive when the GET
    // page itself had no headSha to pin (renderPullRequestMergeSection
    // omits the hidden field in that case); when the page did have one,
    // a missing/blank submission means the pin was stripped, not that
    // there was nothing to pin, so that case is refused below rather than
    // silently proceeding unpinned.
    const body = await context.req.parseBody();
    const submittedHeadSha = readOptionalFormField(body, "expected_head_sha");
    const expectedHeadSha =
      submittedHeadSha === undefined || submittedHeadSha === ""
        ? undefined
        : submittedHeadSha;
    const snapshotRepository = readSnapshotRepository(body);

    let banner: PullRequestMergeBanner;
    let liveOwnerRunId: string | undefined;
    // Serializes the ownership check with RunController's claim path (ADR
    // 0052, dispatchMutex) and with handleClearStaleClaim — the same mutex
    // instance is threaded in as claimMutex. Without it, a new Run claiming
    // this PR's issue between the check and the merge call races an
    // in-flight merge instead of being seen by it.
    await options.claimMutex?.acquire();
    try {
      liveOwnerRunId = livePullRequestOwnerLabel({
        detail,
        getActiveRuns: options.getActiveRuns,
        getProjectRepoAliases: options.getProjectRepoAliases,
        getScheduled: options.getScheduled,
        runStore: options.runStore
      });

      if (detail.snapshot.headSha !== null && expectedHeadSha === undefined) {
        banner = {
          error:
            "Refused: missing the reviewed commit SHA to pin this merge to.",
          freshState: undefined,
          kind: "merge",
          ok: false
        };
      } else if (liveOwnerRunId !== undefined) {
        banner = {
          error: `Refused: ${liveOwnerRunId} is live for this PR.`,
          freshState: undefined,
          kind: "merge",
          ok: false
        };
      } else if (options.mergePullRequest === undefined) {
        banner = {
          error: "merge is unavailable",
          freshState: undefined,
          kind: "merge",
          ok: false
        };
      } else {
        const result = await options.mergePullRequest({
          ...(expectedHeadSha === undefined ? {} : { expectedHeadSha }),
          prNumber,
          projectName,
          ...(snapshotRepository === undefined ? {} : { snapshotRepository })
        });
        banner = result.ok
          ? { freshState: result.freshState, kind: "merge", ok: true }
          : {
              error: result.error,
              freshState: result.freshState,
              kind: "merge",
              ok: false
            };
      }
    } finally {
      options.claimMutex?.release();
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `PR #${prNumber} ${detail.snapshot.title}`,
      renderPullRequestDetailPage({
        banner,
        csrfToken,
        detail,
        liveOwnerRunId,
        pollNowAvailable: options.pollNow !== undefined
      })
    );
    return context.html(html);
  }

  options.app.post(
    "/prs/:project/:number/merge",
    requireAuthorizedMutation,
    (context) =>
      handlePullRequestMerge(
        context,
        context.req.param("project"),
        context.req.param("number")
      )
  );

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
    const nextPollAtMonotonicMs = options.getNextPollAtMonotonic?.();
    const nextPollAtMs =
      nextPollAtMonotonicMs === undefined
        ? undefined
        : nowMs + nextPollAtMonotonicMs - options.monotonicNow();
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
          globalCapacity: concurrency?.global,
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
          nextPollAtMs,
          options.startedAtMs,
          nowMs
        ),
        renderProjectIssuesTable(name, issueRows),
        renderProjectFiringsBlock(firings),
        options.getProjectWorkflowPath?.(name) === undefined
          ? ""
          : `<p class="note"><a href="/projects/${encodeURIComponent(name)}/workflow/edit">Edit workflow →</a></p>`,
        `<p class="note"><a href="/runs?project=${encodeURIComponent(name)}">Recent runs →</a></p>`
      ].join("")
    );
    return context.html(html);
  });

  options.app.get("/projects/:name/workflow/edit", async (context) => {
    const name = context.req.param("name");
    const workflow = options.getProjectWorkflowPath?.(name);
    if (workflow === undefined) {
      return context.html(
        layout(
          "Project has no workflow to edit",
          `<h1 class="page-title">Project has no workflow to edit</h1><p class="lede">Project <code>${escapeHtml(name)}</code> was not found, or is a Routine Host with no workflow contract.</p>`
        ),
        404
      );
    }

    let content: string;
    try {
      content = await readFile(workflow.path, "utf8");
    } catch (error) {
      return context.html(
        layout(
          "Workflow contract unreadable",
          `<h1 class="page-title">Workflow contract unreadable</h1><p class="lede">${escapeHtml(workflow.path)}: ${escapeHtml(errorMessage(error))}</p>`
        ),
        404
      );
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `Edit ${name} workflow`,
      renderEditorForm({
        action: `/projects/${encodeURIComponent(name)}/workflow/edit/preview`,
        blastRadiusHtml: renderWorkflowEditBlastRadius(name),
        content,
        contentHash: contentHash(content),
        csrfToken,
        name: `${name} workflow`,
        projectParam: undefined
      })
    );
    return context.html(html);
  });

  options.app.post(
    "/projects/:name/workflow/edit/preview",
    requireAuthorizedMutation,
    async (context) => {
      const name = context.req.param("name");
      const workflow = options.getProjectWorkflowPath?.(name);
      if (workflow === undefined) {
        return context.html(
          layout(
            "Project has no workflow to edit",
            `<h1 class="page-title">Project has no workflow to edit</h1>`
          ),
          404
        );
      }
      const body = await context.req.parseBody();
      const content = readRequiredFormField(body, "content");
      const expectedContentHash = readRequiredFormField(
        body,
        "expected_content_hash"
      );
      const validation = await validateWorkflowContractContent(
        content,
        workflow.path,
        workflow.format
      );
      const onDisk = await readFile(workflow.path, "utf8").catch(() => null);

      const csrfToken = csrfTokenFor(
        options.csrfSecret,
        ensureSession(context)
      );
      const html = layout(
        `Confirm changes to ${name} workflow`,
        renderEditorPreview({
          confirmAction: `/projects/${encodeURIComponent(name)}/workflow/edit/confirm`,
          content,
          csrfToken,
          errors: validation.errors,
          expectedContentHash,
          name: `${name} workflow`,
          onDisk,
          previewAction: `/projects/${encodeURIComponent(name)}/workflow/edit/preview`,
          projectParam: undefined,
          reviewAction: `/projects/${encodeURIComponent(name)}/workflow/edit`
        })
      );
      return context.html(html);
    }
  );

  options.app.post(
    "/projects/:name/workflow/edit/confirm",
    requireAuthorizedMutation,
    async (context) => {
      const name = context.req.param("name");
      const workflow = options.getProjectWorkflowPath?.(name);
      if (workflow === undefined) {
        return context.html(
          layout(
            "Project has no workflow to edit",
            `<h1 class="page-title">Project has no workflow to edit</h1>`
          ),
          404
        );
      }
      const body = await context.req.parseBody();
      const content = readRequiredFormField(body, "content");
      const expectedContentHash = readRequiredFormField(
        body,
        "expected_content_hash"
      );
      const resolvedPath =
        options.resolveWritePath === undefined
          ? workflow.path
          : await options.resolveWritePath(workflow.path);
      if (resolvedPath === undefined) {
        return context.html(
          layout(
            "Save refused",
            `<h1 class="page-title">Save refused</h1><p class="lede">${escapeHtml(workflow.path)} is not a path the current configuration references.</p>`
          ),
          403
        );
      }

      const result = await runSavePipeline({
        content,
        expectedContentHash,
        filePath: resolvedPath,
        kind: "workflow_contract",
        reload:
          options.triggerReload ??
          (() => Promise.resolve({ errors: [], ok: true })),
        validationPath: workflow.path,
        workflowFormat: workflow.format
      });

      const projectPath = `/projects/${encodeURIComponent(name)}`;
      if (result.kind === "saved") {
        // The pipeline writes before reload runs, so "saved" alone doesn't
        // mean the new contract took effect — redirecting to the project
        // page here regardless would read as success even when reload
        // rejected it and the last-known-good workflow is still live.
        if (!result.reload.ok) {
          return context.html(
            layout(
              `Saved but not active: ${name} workflow`,
              renderReloadFailedNotice({
                editAction: `/projects/${encodeURIComponent(name)}/workflow/edit`,
                errors: result.reload.errors,
                filePath: workflow.path
              })
            ),
            200
          );
        }
        return context.redirect(`${projectPath}?saved=1`, 303);
      }
      if (result.kind === "invalid") {
        const csrfToken = csrfTokenFor(
          options.csrfSecret,
          ensureSession(context)
        );
        return context.html(
          layout(
            `Confirm changes to ${name} workflow`,
            renderEditorPreview({
              confirmAction: `/projects/${encodeURIComponent(name)}/workflow/edit/confirm`,
              content,
              csrfToken,
              errors: result.errors,
              expectedContentHash,
              name: `${name} workflow`,
              onDisk: await readFile(workflow.path, "utf8").catch(() => null),
              previewAction: `/projects/${encodeURIComponent(name)}/workflow/edit/preview`,
              projectParam: undefined,
              reviewAction: `/projects/${encodeURIComponent(name)}/workflow/edit`
            })
          ),
          422
        );
      }
      if (result.kind === "stale") {
        return context.html(
          layout(
            "Save refused: changed on disk",
            renderStaleSaveNotice({
              currentContent: result.currentContent,
              editAction: `/projects/${encodeURIComponent(name)}/workflow/edit`,
              filePath: workflow.path
            })
          ),
          409
        );
      }
      return context.html(
        layout(
          "Save failed",
          `<h1 class="page-title">Save failed</h1><p class="lede">${escapeHtml(result.error)}</p>`
        ),
        500
      );
    }
  );

  options.app.get("/config/edit", requireSameOriginRead, async (context) => {
    const configPath = options.getConfigPath?.();
    if (configPath === undefined) {
      return context.html(
        layout(
          "Service config unavailable",
          `<h1 class="page-title">Service config unavailable</h1>`
        ),
        404
      );
    }

    let content: string;
    try {
      content = await readFile(configPath, "utf8");
    } catch (error) {
      return context.html(
        layout(
          "Service config unreadable",
          `<h1 class="page-title">Service config unreadable</h1><p class="lede">${escapeHtml(configPath)}: ${escapeHtml(errorMessage(error))}</p>`
        ),
        404
      );
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      "Edit service config",
      renderEditorForm({
        action: "/config/edit/preview",
        blastRadiusHtml: renderServiceConfigBlastRadius(),
        content,
        contentHash: contentHash(content),
        csrfToken,
        name: "service config",
        projectParam: undefined
      })
    );
    return context.html(html);
  });

  options.app.post(
    "/config/edit/preview",
    requireAuthorizedMutation,
    async (context) => {
      const configPath = options.getConfigPath?.();
      if (configPath === undefined) {
        return context.html(
          layout(
            "Service config unavailable",
            `<h1 class="page-title">Service config unavailable</h1>`
          ),
          404
        );
      }
      const body = await context.req.parseBody();
      const content = readRequiredFormField(body, "content");
      const expectedContentHash = readRequiredFormField(
        body,
        "expected_content_hash"
      );
      const validation = await validateServiceConfigContent(
        content,
        configPath
      );
      const onDisk = await readFile(configPath, "utf8").catch(() => null);

      const csrfToken = csrfTokenFor(
        options.csrfSecret,
        ensureSession(context)
      );
      const html = layout(
        "Confirm changes to service config",
        renderEditorPreview({
          confirmAction: "/config/edit/confirm",
          content,
          csrfToken,
          errors: validation.errors,
          expectedContentHash,
          ...(validation.errors.length === 0 &&
          onDisk !== null &&
          providerCommandsDiffer(onDisk, content)
            ? { extraConfirmationHtml: renderProviderCommandConfirmation() }
            : {}),
          name: "service config",
          onDisk,
          previewAction: "/config/edit/preview",
          projectParam: undefined,
          reviewAction: "/config/edit"
        })
      );
      return context.html(html);
    }
  );

  options.app.post(
    "/config/edit/confirm",
    requireAuthorizedMutation,
    async (context) => {
      const configPath = options.getConfigPath?.();
      if (configPath === undefined) {
        return context.html(
          layout(
            "Service config unavailable",
            `<h1 class="page-title">Service config unavailable</h1>`
          ),
          404
        );
      }
      const body = await context.req.parseBody();
      const content = readRequiredFormField(body, "content");
      const expectedContentHash = readRequiredFormField(
        body,
        "expected_content_hash"
      );
      const confirmedProviderCommandChange =
        readOptionalFormField(body, "confirm_provider_command_change") === "on";

      const onDisk = await readFile(configPath, "utf8").catch(() => null);
      if (
        onDisk !== null &&
        providerCommandsDiffer(onDisk, content) &&
        !confirmedProviderCommandChange
      ) {
        const csrfToken = csrfTokenFor(
          options.csrfSecret,
          ensureSession(context)
        );
        return context.html(
          layout(
            "Confirm changes to service config",
            renderEditorPreview({
              confirmAction: "/config/edit/confirm",
              content,
              csrfToken,
              errors: [],
              expectedContentHash,
              extraConfirmationHtml: renderProviderCommandConfirmation(),
              name: "service config",
              onDisk,
              previewAction: "/config/edit/preview",
              projectParam: undefined,
              reviewAction: "/config/edit"
            })
          ),
          422
        );
      }

      const resolvedPath =
        options.resolveWritePath === undefined
          ? configPath
          : await options.resolveWritePath(configPath);
      if (resolvedPath === undefined) {
        return context.html(
          layout(
            "Save refused",
            `<h1 class="page-title">Save refused</h1><p class="lede">${escapeHtml(configPath)} is not a path the current configuration references.</p>`
          ),
          403
        );
      }

      const result = await runSavePipeline({
        content,
        expectedContentHash,
        filePath: resolvedPath,
        kind: "service_config",
        reload:
          options.triggerReload ??
          (() => Promise.resolve({ errors: [], ok: true }))
      });

      if (result.kind === "saved") {
        // The pipeline writes before reload runs, so "saved" alone doesn't
        // mean the new config took effect — redirecting to the dashboard
        // here regardless would read as success even when reload rejected
        // it and the last-known-good config is still live.
        if (!result.reload.ok) {
          return context.html(
            layout(
              "Saved but not active: service config",
              renderReloadFailedNotice({
                editAction: "/config/edit",
                errors: result.reload.errors,
                filePath: configPath
              })
            ),
            200
          );
        }
        return context.redirect("/?saved=1", 303);
      }
      if (result.kind === "invalid") {
        const csrfToken = csrfTokenFor(
          options.csrfSecret,
          ensureSession(context)
        );
        return context.html(
          layout(
            "Confirm changes to service config",
            renderEditorPreview({
              confirmAction: "/config/edit/confirm",
              content,
              csrfToken,
              errors: result.errors,
              expectedContentHash,
              name: "service config",
              onDisk,
              previewAction: "/config/edit/preview",
              projectParam: undefined,
              reviewAction: "/config/edit"
            })
          ),
          422
        );
      }
      if (result.kind === "stale") {
        return context.html(
          layout(
            "Save refused: changed on disk",
            renderStaleSaveNotice({
              currentContent: result.currentContent,
              editAction: "/config/edit",
              filePath: configPath
            })
          ),
          409
        );
      }
      return context.html(
        layout(
          "Save failed",
          `<h1 class="page-title">Save failed</h1><p class="lede">${escapeHtml(result.error)}</p>`
        ),
        500
      );
    }
  );

  options.app.get("/routines/:name", async (context) => {
    const name = context.req.param("name");
    const projectParam = context.req.query("project");
    const includeInactive = context.req.query("include_inactive") === "true";
    const fireNotice = renderFireResultNotice(context);
    const resolved = resolveNamedRoutineGroup(
      options.runStore,
      name,
      projectParam,
      includeInactive
    );
    if (resolved.kind === "not_found") {
      return context.html(
        layout(
          projectParam === undefined
            ? "Routine not found"
            : "Routine target not found",
          fireNotice +
            (projectParam === undefined
              ? `<h1 class="page-title">Routine not found</h1><p class="lede">Routine <code>${escapeHtml(name)}</code> was not found.</p>`
              : `<h1 class="page-title">Routine target not found</h1><p class="lede">Routine <code>${escapeHtml(name)}</code> has no target in Project <code>${escapeHtml(projectParam)}</code>.</p>`)
        ),
        404
      );
    }
    if (resolved.kind === "ambiguous") {
      return context.html(
        layout(
          name,
          fireNotice +
            renderRoutineDisambiguation(name, resolved.groups, includeInactive)
        )
      );
    }
    const { group } = resolved;

    const declaration = resolveRoutineDeclaration(options.runStore, group);
    const currentTargets = currentRoutineTargets(group);
    const declarationDisabledPromise = readRoutineDisabledFallback(
      currentTargets,
      declaration.sourcePath
    );
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
    const declarationSourcePath = declaration.sourcePath;
    const reloadErrors =
      declarationSourcePath === "-"
        ? []
        : (options.getStatusSnapshot?.()?.reload.routineErrors ?? [])
            .filter((error) =>
              error.sourcePaths.includes(declarationSourcePath)
            )
            .map((error) => error.message);

    const lifecycleCsrfToken = csrfTokenFor(
      options.csrfSecret,
      ensureSession(context)
    );
    const declarationDisabled = await declarationDisabledPromise;
    const html = layout(
      name,
      [
        fireNotice,
        `<h1 class="page-title">${escapeHtml(name)}</h1>`,
        renderRoutineDeclarationCard(declaration, reloadErrors),
        renderRoutineTargetsTable(group),
        renderRoutineFiringHistory(firings),
        `<p class="note"><a href="${escapeHtml(`/routines/${encodeURIComponent(name)}/edit${routineQuerySuffix(projectParam, includeInactive)}`)}">Edit declaration →</a></p>`,
        renderRoutineLifecycleControls(
          name,
          currentTargets,
          projectParam,
          includeInactive,
          lifecycleCsrfToken,
          declaration.sourcePath,
          declarationDisabled
        ),
        renderRoutineFireControls(
          name,
          currentTargets,
          projectParam,
          includeInactive,
          lifecycleCsrfToken
        )
      ].join("")
    );
    return context.html(html);
  });

  options.app.get("/routines/:name/edit", async (context) => {
    const name = context.req.param("name");
    const projectParam = context.req.query("project");
    const requestedIncludeInactive =
      context.req.query("include_inactive") === "true";
    let resolved = resolveNamedRoutineGroup(
      options.runStore,
      name,
      projectParam,
      requestedIncludeInactive
    );
    // resolveNamedRoutineGroup was already queried with includeInactive:
    // true below, so resolved.group already carries every inactive
    // sibling target -- unlike the fallthrough case, there's nothing left
    // for includeInactiveRoutineTargets to add.
    let resolvedWithInactive = requestedIncludeInactive;
    if (!requestedIncludeInactive && resolved.kind === "not_found") {
      resolved = resolveNamedRoutineGroup(
        options.runStore,
        name,
        projectParam,
        true
      );
      resolvedWithInactive = true;
    }
    if (resolved.kind !== "ok") {
      return context.html(
        renderUneditableRoutine(name, resolved),
        resolved.kind === "ambiguous" ? 200 : 404
      );
    }
    const includeInactive =
      resolvedWithInactive ||
      routineSelectionRequiresInactive(resolved.group, projectParam);
    const disclosureGroup = resolvedWithInactive
      ? resolved.group
      : includeInactiveRoutineTargets(options.runStore, resolved.group);
    const declaration = resolveRoutineDeclaration(
      options.runStore,
      disclosureGroup
    );

    let content: string;
    try {
      content = await readFile(declaration.sourcePath, "utf8");
    } catch (error) {
      return context.html(
        layout(
          "Routine declaration unreadable",
          `<h1 class="page-title">Routine declaration unreadable</h1><p class="lede">${escapeHtml(declaration.sourcePath)}: ${escapeHtml(errorMessage(error))}</p>`
        ),
        404
      );
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `Edit ${name}`,
      renderEditorForm({
        action: `/routines/${encodeURIComponent(name)}/edit/preview`,
        blastRadiusHtml: renderRoutineEditBlastRadius(disclosureGroup.targets),
        content,
        contentHash: contentHash(content),
        csrfToken,
        expectedSourcePath: declaration.sourcePath,
        includeInactive,
        name,
        projectParam
      })
    );
    return context.html(html);
  });

  options.app.post(
    "/routines/:name/edit/preview",
    requireAuthorizedMutation,
    async (context) => {
      const name = context.req.param("name");
      const body = await context.req.parseBody();
      const projectParam = readOptionalFormField(body, "project_param");
      const expectedSourcePath = readOptionalFormField(
        body,
        "expected_source_path"
      );
      const includeInactive =
        readOptionalFormField(body, "include_inactive") === "true";
      const resolved = resolveNamedRoutineGroup(
        options.runStore,
        name,
        projectParam,
        includeInactive
      );
      if (resolved.kind !== "ok") {
        return context.html(
          renderUneditableRoutine(name, resolved),
          resolved.kind === "ambiguous" ? 200 : 404
        );
      }
      const declaration = resolveRoutineDeclaration(
        options.runStore,
        resolved.group
      );
      const staleDeclarationResponse = checkStaleRoutineDeclaration(context, {
        declaration,
        editAction: `/routines/${encodeURIComponent(name)}/edit${routineQuerySuffix(projectParam, includeInactive)}`,
        expectedSourcePath,
        name
      });
      if (staleDeclarationResponse !== undefined) {
        return staleDeclarationResponse;
      }

      const content = readRequiredFormField(body, "content");
      const expectedContentHash = readRequiredFormField(
        body,
        "expected_content_hash"
      );
      const validation = parseRoutineDeclaration(
        content,
        declaration.sourcePath
      );
      const onDisk = await readFile(declaration.sourcePath, "utf8").catch(
        () => null
      );

      const csrfToken = csrfTokenFor(
        options.csrfSecret,
        ensureSession(context)
      );
      const html = layout(
        `Confirm changes to ${name}`,
        renderEditorPreview({
          confirmAction: `/routines/${encodeURIComponent(name)}/edit/confirm`,
          content,
          csrfToken,
          errors: validation.errors,
          expectedContentHash,
          ...(expectedSourcePath === undefined ? {} : { expectedSourcePath }),
          includeInactive,
          name,
          onDisk,
          previewAction: `/routines/${encodeURIComponent(name)}/edit/preview`,
          projectParam,
          reviewAction: `/routines/${encodeURIComponent(name)}/edit`
        })
      );
      return context.html(html);
    }
  );

  options.app.post(
    "/routines/:name/edit/confirm",
    requireAuthorizedMutation,
    async (context) => {
      const name = context.req.param("name");
      const body = await context.req.parseBody();
      const projectParam = readOptionalFormField(body, "project_param");
      const expectedSourcePath = readOptionalFormField(
        body,
        "expected_source_path"
      );
      const includeInactive =
        readOptionalFormField(body, "include_inactive") === "true";
      const resolved = resolveNamedRoutineGroup(
        options.runStore,
        name,
        projectParam,
        includeInactive
      );
      if (resolved.kind !== "ok") {
        return context.html(
          renderUneditableRoutine(name, resolved),
          resolved.kind === "ambiguous" ? 200 : 404
        );
      }
      const declaration = resolveRoutineDeclaration(
        options.runStore,
        resolved.group
      );
      const staleDeclarationResponse = checkStaleRoutineDeclaration(context, {
        declaration,
        editAction: `/routines/${encodeURIComponent(name)}/edit${routineQuerySuffix(projectParam, includeInactive)}`,
        expectedSourcePath,
        name
      });
      if (staleDeclarationResponse !== undefined) {
        return staleDeclarationResponse;
      }

      const content = readRequiredFormField(body, "content");
      const expectedContentHash = readRequiredFormField(
        body,
        "expected_content_hash"
      );
      const resolvedPath =
        options.resolveWritePath === undefined
          ? declaration.sourcePath
          : await options.resolveWritePath(declaration.sourcePath);
      if (resolvedPath === undefined) {
        return context.html(
          layout(
            "Save refused",
            `<h1 class="page-title">Save refused</h1><p class="lede">${escapeHtml(declaration.sourcePath)} is not a path the current configuration references.</p>`
          ),
          403
        );
      }

      const result = await runSavePipeline({
        content,
        expectedContentHash,
        filePath: resolvedPath,
        kind: "routine_declaration",
        reload:
          options.triggerReload ??
          (() => Promise.resolve({ errors: [], ok: true }))
      });

      const routinePath = `/routines/${encodeURIComponent(name)}${routineQuerySuffix(projectParam, includeInactive)}`;
      if (result.kind === "saved") {
        // The pipeline writes before reload runs, so "saved" alone doesn't
        // mean the new declaration took effect — redirecting to the detail
        // page here regardless would read as success even when reload
        // rejected it and the last-known-good declaration is still live.
        if (!result.reload.ok) {
          return context.html(
            layout(
              `Saved but not active: ${name}`,
              renderReloadFailedNotice({
                editAction: `/routines/${encodeURIComponent(name)}/edit${routineQuerySuffix(projectParam, includeInactive)}`,
                errors: result.reload.errors,
                filePath: declaration.sourcePath
              })
            ),
            200
          );
        }
        return context.redirect(
          `${routinePath}${routinePath.includes("?") ? "&" : "?"}saved=1`,
          303
        );
      }
      if (result.kind === "invalid") {
        const csrfToken = csrfTokenFor(
          options.csrfSecret,
          ensureSession(context)
        );
        return context.html(
          layout(
            `Confirm changes to ${name}`,
            renderEditorPreview({
              confirmAction: `/routines/${encodeURIComponent(name)}/edit/confirm`,
              content,
              csrfToken,
              errors: result.errors,
              expectedContentHash,
              ...(expectedSourcePath === undefined
                ? {}
                : { expectedSourcePath }),
              includeInactive,
              name,
              onDisk: await readFile(declaration.sourcePath, "utf8").catch(
                () => null
              ),
              previewAction: `/routines/${encodeURIComponent(name)}/edit/preview`,
              projectParam,
              reviewAction: `/routines/${encodeURIComponent(name)}/edit`
            })
          ),
          422
        );
      }
      if (result.kind === "stale") {
        return context.html(
          layout(
            "Save refused: changed on disk",
            renderStaleSaveNotice({
              currentContent: result.currentContent,
              editAction: `/routines/${encodeURIComponent(name)}/edit${routineQuerySuffix(projectParam, includeInactive)}`,
              filePath: declaration.sourcePath
            })
          ),
          409
        );
      }
      return context.html(
        layout(
          "Save failed",
          `<h1 class="page-title">Save failed</h1><p class="lede">${escapeHtml(result.error)}</p>`
        ),
        500
      );
    }
  );

  // #307's disable/enable action: a targeted structured edit (setRoutineDisabled)
  // rather than the raw-text editor -- the operator picks a state, not text
  // to type. Renders through the SAME diff-before-write confirmation page
  // and the SAME /edit/confirm route the raw-text editor uses (#307 AC:
  // "Every save goes through #306's pipeline -- no editor writes files
  // directly"), just pre-filled with programmatically computed content
  // instead of a submitted textarea.
  async function renderRoutineDisabledTogglePreview(
    context: Context,
    name: string,
    disabled: boolean
  ): Promise<Response> {
    const body = await context.req.parseBody();
    const projectParam = readOptionalFormField(body, "project_param");
    const expectedSourcePath = readOptionalFormField(
      body,
      "expected_source_path"
    );
    const includeInactive =
      readOptionalFormField(body, "include_inactive") === "true";
    const resolved = resolveNamedRoutineGroup(
      options.runStore,
      name,
      projectParam,
      includeInactive
    );
    if (resolved.kind !== "ok") {
      return context.html(
        renderUneditableRoutine(name, resolved),
        resolved.kind === "ambiguous" ? 200 : 404
      );
    }
    const declaration = resolveRoutineDeclaration(
      options.runStore,
      resolved.group
    );
    const staleDeclarationResponse = checkStaleRoutineDeclaration(context, {
      declaration,
      editAction: `/routines/${encodeURIComponent(name)}${routineQuerySuffix(projectParam, includeInactive)}`,
      expectedSourcePath,
      name
    });
    if (staleDeclarationResponse !== undefined) {
      return staleDeclarationResponse;
    }
    const onDisk = await readFile(declaration.sourcePath, "utf8").catch(
      () => null
    );
    if (onDisk === null) {
      return context.html(
        layout(
          "Routine declaration unreadable",
          `<h1 class="page-title">Routine declaration unreadable</h1><p class="lede">${escapeHtml(declaration.sourcePath)}</p>`
        ),
        404
      );
    }
    const toggled = setRoutineDisabled(onDisk, disabled);
    if (toggled.kind === "error") {
      return context.html(
        layout(
          "Could not toggle routine",
          `<h1 class="page-title">Could not toggle routine</h1><p class="lede">${escapeHtml(toggled.error)}</p>`
        ),
        422
      );
    }

    const csrfToken = csrfTokenFor(options.csrfSecret, ensureSession(context));
    const html = layout(
      `Confirm ${disabled ? "disabling" : "enabling"} ${name}`,
      renderEditorPreview({
        confirmAction: `/routines/${encodeURIComponent(name)}/edit/confirm`,
        content: toggled.content,
        csrfToken,
        errors: [],
        expectedContentHash: contentHash(onDisk),
        expectedSourcePath: declaration.sourcePath,
        includeInactive,
        name,
        onDisk,
        previewAction: `/routines/${encodeURIComponent(name)}/edit/preview`,
        projectParam,
        reviewAction: `/routines/${encodeURIComponent(name)}`
      })
    );
    return context.html(html);
  }

  options.app.post(
    "/routines/:name/disable",
    requireAuthorizedMutation,
    (context) =>
      renderRoutineDisabledTogglePreview(
        context,
        context.req.param("name"),
        true
      )
  );
  options.app.post(
    "/routines/:name/enable",
    requireAuthorizedMutation,
    (context) =>
      renderRoutineDisabledTogglePreview(
        context,
        context.req.param("name"),
        false
      )
  );

  options.app.get("/firings/:id", async (context) => {
    const id = context.req.param("id");
    const detail = options.runStore.getRoutineFiring(id);
    if (detail === undefined) {
      return context.html(
        layout(
          "Routine firing not found",
          `<h1 class="page-title">Routine firing not found</h1><p class="lede">Routine firing <code>${escapeHtml(id)}</code> was not found.</p>`
        ),
        404
      );
    }
    const transitions = options.runStore.listRoutineFiringTransitions(id);
    const evidence = routineEvidencePaths(options.stateRoot, id);
    const { events: rawEvents, truncated: eventsTruncated } =
      await readRecentRoutineEvents(
        evidence.normalizedLogPath,
        EVENT_TAIL_LIMIT
      );
    const artifacts = await buildFiringArtifactDescriptors(evidence);
    const firingCsrfToken = csrfTokenFor(
      options.csrfSecret,
      ensureSession(context)
    );

    const html = layout(
      `Firing ${detail.id}`,
      [
        `<h1 class="page-title">Firing <code>${escapeHtml(detail.id)}</code></h1>`,
        `<p class="note">A Routine Firing has no GitHub Issue, no retried attempts, and no per-run workflow graph — a Firing is one execution of a scheduled prompt, not the issue-dispatch lifecycle a Run models.</p>`,
        renderFiringSummary(detail, transitions),
        renderFiringPullRequests(detail.pullRequests),
        renderFiringCancelForm(detail, firingCsrfToken),
        renderTransitionsTable(transitions),
        renderEventsTable(rawEvents, eventsTruncated),
        renderRunFileLinks(detail.id, artifacts, "firings")
      ].join("")
    );
    return context.html(html);
  });
}

// The one primitive the "only the affected fragment is replaced" AC (#305)
// actually needs: swap a named container's children, nothing else on the
// page. No key-matching / focus-and-selection restore — there is no editor
// or scrollable subregion inside active-now-band or projects-section today
// (#307 introduces editors; that's where a preservation mechanism belongs,
// once there's a real element to preserve). Exported so
// tests/dashboard-live-client.test.ts can exercise the exact source the
// browser runs, unmodified — see ADR 0074.
export const DASHBOARD_PATCH_FRAGMENT_JS = `function patchFragment(id, html) {
  var el = document.getElementById(id);
  if (!el) { return; }
  var temp = document.createElement("div");
  temp.innerHTML = html;
  var nodes = [];
  for (var i = 0; i < temp.childNodes.length; i++) { nodes.push(temp.childNodes[i]); }
  el.replaceChildren.apply(el, nodes);
}`;

const DASHBOARD_STREAM_BANNER = `<div id="live-stream-banner" class="alert" style="display:none" role="status">Live updates unavailable — some dashboard data may be stale. <a href="/">Refresh</a></div>`;

// EventSource reconnects on its own (fixed retry interval). The banner
// remains visible across a reconnect until both fragments reconcile;
// GET /events carries no replay, so a client that was disconnected must
// successfully re-fetch the current state before it is current (ADR 0074).
export const DASHBOARD_LIVE_CLIENT_JS = `(function () {
  ${DASHBOARD_PATCH_FRAGMENT_JS}
  var banner = document.getElementById("live-stream-banner");
  var reconcileGeneration = 0;
  var streamOpen = false;
  function showReconciliationFailure(generation) {
    if (generation === reconcileGeneration && banner) { banner.style.display = ""; }
  }
  function refreshFragment(url, id, generation) {
    return fetch(url)
      .then(function (r) {
        if (!r.ok) { showReconciliationFailure(generation); return false; }
        return r.text().then(function (html) {
          if (generation === reconcileGeneration) { patchFragment(id, html); }
          return true;
        });
      })
      .catch(function () {
        showReconciliationFailure(generation);
        return false;
      });
  }
  function reconcile() {
    var generation = ++reconcileGeneration;
    Promise.all([
      refreshFragment("/fragments/active-band", "active-now-band", generation),
      refreshFragment("/fragments/projects-section", "projects-section", generation)
    ]).then(function (successes) {
      if (generation === reconcileGeneration && streamOpen && successes[0] && successes[1] && banner) {
        banner.style.display = "none";
      }
    });
  }
  var source = new EventSource("/events");
  ["run-transition", "firing-transition", "project-poll"].forEach(function (kind) {
    source.addEventListener(kind, reconcile);
  });
  source.addEventListener("open", function () {
    streamOpen = true;
    reconcile();
  });
  source.addEventListener("error", function () {
    streamOpen = false;
    if (banner) { banner.style.display = ""; }
  });
})();`;

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
.alert--ok { border-color: var(--ok-ink); background: var(--ok-bg); color: var(--ok-ink); }
.label-list { list-style: none; margin: 0 0 var(--sp-4); padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
.label-list li { display: flex; align-items: center; gap: var(--sp-2); }
.label-list form { display: inline; }

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

.editor {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--sp-3);
  resize: vertical;
}
.diff {
  margin: 0 0 var(--sp-5);
  max-height: 32rem;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--sp-3);
}
.diff-line { display: block; white-space: pre-wrap; }
.diff-add { color: var(--ok-ink); background: var(--ok-bg); }
.diff-del { color: var(--fail-ink); background: var(--fail-bg); }
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--sp-3) var(--sp-4);
  margin: 0 0 var(--sp-5);
}
.filters label, .bulk-select-toolbar label {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  color: var(--ink-muted);
}
.filters input, .filters select, .bulk-select-toolbar label > input {
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
}

.bulk-select-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--sp-3) var(--sp-4);
  margin: 0 0 var(--sp-5);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.bulk-select-toolbar > span { font-size: var(--fs-meta); color: var(--ink-muted); }
.bulk-select-toolbar label > input { min-width: 14ch; }
.bulk-select-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.bulk-select-chips:empty { display: none; }
.bulk-select-chips li {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.14rem 0.5rem;
  border-radius: 999px;
  font-size: var(--fs-label);
  color: var(--accent-ink);
  background: var(--accent-quiet);
  border: 1px solid color-mix(in oklch, var(--accent) 22%, transparent);
}
.bulk-select-chips button {
  font-family: var(--font-mono);
  font-size: inherit;
  color: inherit;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  line-height: 1;
}
.bulk-select-error, .bulk-select-results { flex-basis: 100%; margin: 0; font-size: var(--fs-meta); }
.bulk-select-error { color: var(--fail-ink); }
.bulk-select-results {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  color: var(--ink-2);
}

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

const LOCAL_TIME_CLIENT_JS = `(function () {
  var selector = "time[data-local-time]";
  function localizeTimestamp(element) {
    var value = element.getAttribute("datetime");
    if (!value) { return; }
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) { return; }
    element.textContent = date.toLocaleString();
  }
  function localizeWithin(root) {
    if (root.nodeType === 1 && root.matches(selector)) {
      localizeTimestamp(root);
    }
    if (!root.querySelectorAll) { return; }
    var timestamps = root.querySelectorAll(selector);
    for (var i = 0; i < timestamps.length; i++) {
      localizeTimestamp(timestamps[i]);
    }
  }
  localizeWithin(document);
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var nodes = records[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        localizeWithin(nodes[j]);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();`;

function renderTimestamp(
  value: string | null | undefined,
  fallback = "-"
): string {
  if (!value) {
    return escapeHtml(fallback);
  }
  const escaped = escapeHtml(value);
  return `<time datetime="${escaped}" data-local-time>${escaped}</time>`;
}

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
  <nav class="nav" aria-label="Primary"><a href="/">Dashboard</a><a href="/runs">Runs</a><a href="/issues">Issues</a><a href="/prs">Pull requests</a><a href="/config/edit">Config</a></nav>
</header>
<main>
${body}
</main>
<script data-local-time-client>${LOCAL_TIME_CLIENT_JS}</script>
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
  lastRun: ProjectLastRunStatus | undefined;
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
  lastRunByProject: ReadonlyMap<string, ProjectLastRunStatus>
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
          : `${statePill(row.lastRun.state)} <code>${escapeHtml(formatAge(row.lastRun.lastTransitionAt, nowMs))}</code>`;
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
  lastRunByProject: ReadonlyMap<string, ProjectLastRunStatus>,
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
  nextPollAtMs: number | undefined,
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
  const lastPollAt = projectState.lastSuccessfulPollAt;
  const pollAge = lastPollAt === null ? "never" : formatAge(lastPollAt, nowMs);
  const preRestart =
    lastPollAt !== null &&
    startedAtMs !== undefined &&
    Date.parse(lastPollAt) < startedAtMs
      ? ' <span class="muted">(pre-restart)</span>'
      : "";
  parts.push(capacityKv("poll", `${escapeHtml(pollAge)}${preRestart}`));
  if (nextPollAtMs !== undefined) {
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
  // /issues/:project/:number (loadIssueDetail) resolves only against the
  // persisted snapshot table, never against Run history -- a row can exist
  // here from a Run alone (#303's union join) with no snapshot behind it.
  // This says whether that detail page actually exists for this row, so the
  // renderer knows whether "#N" may safely become a link.
  hasSnapshot: boolean;
  issueNumber: number;
  pillHtml: string;
  title: string;
};

function buildProjectIssueRow(input: {
  globalCapacity: { inFlight: number; maxInFlight: number | null } | undefined;
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
  const hasSnapshot = input.snapshot !== undefined;
  if (input.run !== undefined) {
    const run = input.run;
    const bucket = PROJECT_ISSUE_ROW_BUCKET[run.state];
    const pillHtml = statePill(run.state);
    if (bucket === "running") {
      return {
        detail: `attempt ${run.retryCount + 1} · ${formatAge(run.updatedAt, input.nowMs)}`,
        hasSnapshot,
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
        hasSnapshot,
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
        hasSnapshot,
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
      hasSnapshot,
      issueNumber: input.issueNumber,
      pillHtml,
      title: run.issueTitle
    };
  }

  const snapshot = input.snapshot;
  if (snapshot === undefined) {
    return {
      detail: "",
      hasSnapshot,
      issueNumber: input.issueNumber,
      pillHtml: labelPill("unknown", "neutral"),
      title: ""
    };
  }
  if (snapshot.kind === "filtered") {
    return {
      detail: snapshot.reasons.join(", "),
      hasSnapshot,
      issueNumber: input.issueNumber,
      pillHtml: labelPill("filtered", "neutral"),
      title: snapshot.title
    };
  }
  const globalCapacity = input.globalCapacity;
  const capDetail =
    globalCapacity !== undefined &&
    globalCapacity.maxInFlight !== null &&
    globalCapacity.inFlight >= globalCapacity.maxInFlight
      ? `queued behind global cap (${globalCapacity.inFlight}/${globalCapacity.maxInFlight})`
      : input.maxInFlight !== undefined && input.inFlight >= input.maxInFlight
        ? `queued behind cap (${input.inFlight}/${input.maxInFlight})`
        : undefined;
  return {
    detail: capDetail ?? "within cap, next by priority",
    hasSnapshot,
    issueNumber: input.issueNumber,
    pillHtml: labelPill("eligible", "neutral"),
    title: snapshot.title
  };
}

function renderProjectIssuesTable(
  projectName: string,
  rows: ProjectIssueRow[]
): string {
  const encodedProjectName = encodeURIComponent(projectName);
  // Matches the "Recent runs →" / "Edit workflow →" note-link convention
  // already used elsewhere on this page (see renderProjectPage).
  const editLabelsNote = `<p class="note"><a href="/issues?project=${encodedProjectName}">Edit labels →</a></p>`;
  if (rows.length === 0) {
    return `<section>${sectionHead("Issues", 0)}<div class="empty"><strong>No issues</strong>No open issue is currently eligible, filtered, or claimed for this Project.</div></section>${editLabelsNote}`;
  }
  const body = rows
    .map((row) => {
      // Only snapshot-backed rows have a working detail page (see
      // ProjectIssueRow.hasSnapshot) -- a Run-only row would 404.
      const numberCell = row.hasSnapshot
        ? `<a href="${escapeHtml(`/issues/${encodedProjectName}/${row.issueNumber}`)}">#${row.issueNumber}</a>`
        : `#${row.issueNumber}`;
      return `<tr><td>${numberCell}</td><td class="c-title">${escapeHtml(row.title)}</td><td>${row.pillHtml}</td><td class="c-detail">${escapeHtml(row.detail)}</td></tr>`;
    })
    .join("");
  return (
    tableSection(
      "Issues",
      rows.length,
      "<tr><th>#</th><th>Title</th><th>State</th><th>Detail</th></tr>",
      body
    ) + editLabelsNote
  );
}

// #308's cross-project triage search (ADR 0077): filter query params, all
// optional and combined with AND. `verdict` is coarse (matches the
// snapshot's own `kind`, not the rendered verdict string) so it stays a
// cheap equality check rather than parsing the human-readable verdict back
// apart.
type IssueSearchFilters = {
  label: string | undefined;
  project: string | undefined;
  q: string | undefined;
  verdict: string | undefined;
};

type IssueSearchRow = {
  blockedBy: RawGitHubIssueDependencyRef[];
  blockedByTruncated: boolean;
  issueNumber: number;
  labels: string[];
  polledAt: string;
  preRestart: boolean;
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
  title: string;
  verdict: string;
};

function normalizeQueryParam(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parsePositiveIntQueryParam(
  value: string | undefined
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// A claim-shaped operational-label reason (sym:claimed/sym:running) gets its
// Run id resolved through the Run Store — a local read, not a GitHub call —
// so describeIssueVerdict (src/issues/verdict.ts) can stay pure and DB-free.
// A scheduled callback keeps its Issue Reservation even when the backing Run
// row is terminal. Its runId is scheduling correlation, not durable claimant
// identity: wait_park can name the terminal parent while a waiting row owns
// the reservation, and contention reschedules can name an unpersisted id.
// Prefer the non-terminal states below, then use scheduled issue identity to
// resolve the latest persisted Run. Terminal history alone may legitimately
// retain sym:claimed for operator action (SPEC 9.3), but renders as
// blocked/stale evidence.
const CLAIM_REASON = /^has operational label sym:(claimed|running)$/;
const CLAIM_HOLDING_RUN_STATES: RunState[] = [
  "queued",
  "preparing_workspace",
  "running",
  "waiting"
];

function resolveScheduledClaimantRunId(
  runStore: RunStore,
  callback: ScheduledCallback
): string | undefined {
  return runStore.listRuns({
    issueNumber: callback.issueNumber,
    limit: 1,
    project: callback.projectName
  })[0]?.id;
}

function resolveClaimedRunId(
  runStore: RunStore,
  projectName: string,
  issueNumber: number,
  reasons: string[],
  scheduled: ScheduledCallback[]
): string | undefined {
  if (!reasons.some((reason) => CLAIM_REASON.test(reason))) {
    return undefined;
  }
  const claimHoldingRun = runStore.listRuns({
    issueNumber,
    limit: 1,
    project: projectName,
    state: CLAIM_HOLDING_RUN_STATES
  })[0];
  if (claimHoldingRun !== undefined) {
    return claimHoldingRun.id;
  }
  const scheduledClaimant = scheduled.find(
    (callback) =>
      callback.projectName === projectName &&
      callback.issueNumber === issueNumber
  );
  if (scheduledClaimant !== undefined) {
    return resolveScheduledClaimantRunId(runStore, scheduledClaimant);
  }
  return undefined;
}

// #308 part 3's clear-stale-claim liveness gate: the same three-source union
// detectStaleClaims's own collectLiveKeys uses (src/lifecycle/stale-claims.ts)
// — the in-process registry (getActiveRuns), queued/preparing_workspace/
// running Run rows, and parked `waiting` rows (which still wear sym:claimed
// across the wait, ADR 0047). Missing the waiting set would let an operator
// clear a claim on a parked-but-live Run — the exact double dispatch ADR
// 0077 exists to prevent.
// Shared by findLiveRunIdForIssue (#308) and isRunIdLive (#309): the same
// three-source union collectLiveKeys (src/lifecycle/stale-claims.ts) uses,
// concatenated in priority order (in-process registry, then
// queued/preparing_workspace/running rows, then parked `waiting` rows,
// which keep sym:claimed across the wait per ADR 0047 and still own a PR
// under a merge_pr FSM state). A single shared read means both callers
// filter one union rather than each re-deriving it.
function collectLiveRunEntries(input: {
  // Scoped to the issue being checked so scheduled-callback resolution below
  // only queries the Run Store for a match, not once per in-flight callback
  // across every project.
  aliasNames: Set<string>;
  getActiveRuns:
    | (() => Array<{ issueNumber: number; projectName: string; runId: string }>)
    | undefined;
  // A retry/continuation/state-advance timer registered via
  // RunController.schedule (RegisterPagesOptions.getScheduled) has already
  // unregistered its slot and moved the Run row to a terminal state — the
  // only remaining ownership signal is this callback. Without it, an issue
  // mid-backoff reads as unowned even though it will fire again. Resolve its
  // issue identity back to a persisted Run because callback.runId is not
  // guaranteed to name one.
  getScheduled: (() => ScheduledCallback[]) | undefined;
  issueNumber: number;
  runStore: RunStore;
}): Array<{ issueNumber: number; projectName: string; runId: string }> {
  const scheduledEntries: Array<{
    issueNumber: number;
    projectName: string;
    runId: string;
  }> = [];
  for (const callback of input.getScheduled?.() ?? []) {
    if (
      !input.aliasNames.has(callback.projectName) ||
      callback.issueNumber !== input.issueNumber
    ) {
      continue;
    }
    const runId = resolveScheduledClaimantRunId(input.runStore, callback);
    if (runId !== undefined) {
      scheduledEntries.push({
        issueNumber: callback.issueNumber,
        projectName: callback.projectName,
        runId
      });
    }
  }
  return [
    ...(input.getActiveRuns?.() ?? []),
    ...input.runStore.listActiveRunIds(),
    ...input.runStore.listWaitingRunIds(),
    ...scheduledEntries
  ];
}

// KNOWN GAP: a succeeded Run whose PR is under active PR-follow-up
// (runPullRequestFollowup, src/pull-request-followup.ts) is NOT represented
// here. Its Run already terminated (so it's absent from every source above)
// but sym:claimed stays attached while follow-up decides whether to
// dispatch a review round -- meaning both handleClearStaleClaim and the PR
// merge guard can act during that window. The natural fix (have
// runPullRequestFollowup hold dispatchMutex around its decide-then-dispatch
// step) deadlocks: dispatchReviewFollowup -> runFreshLifecycle ->
// claimAndPersistRun already acquires that same non-reentrant AsyncMutex.
// Closing this needs RunController to expose a lock-aware dispatch variant
// (or a restructured mutex ownership model), not a blind extra acquire()
// here.
function findLiveRunIdForIssue(input: {
  getActiveRuns:
    | (() => Array<{ issueNumber: number; projectName: string; runId: string }>)
    | undefined;
  getScheduled: (() => ScheduledCallback[]) | undefined;
  // Two configured Projects can point at the same GitHub owner/repo (an
  // alias); without this, a live Run dispatched under one alias's name is
  // invisible to a liveness check made under the other, letting the two
  // cross-clear or cross-merge each other's issues/PRs. Returns every
  // project name (including projectName itself) sharing the target's repo
  // identity — undefined (not wired) degrades to "just this project name",
  // i.e. today's behavior.
  getProjectRepoAliases: ((projectName: string) => string[]) | undefined;
  issueNumber: number;
  projectName: string;
  runStore: RunStore;
}): string | undefined {
  const aliasNames = new Set(
    input.getProjectRepoAliases?.(input.projectName) ?? [input.projectName]
  );
  return collectLiveRunEntries({ ...input, aliasNames }).find(
    (entry) =>
      aliasNames.has(entry.projectName) &&
      entry.issueNumber === input.issueNumber
  )?.runId;
}

// #309's merge guard/display (AC6/AC7): a tracked-but-not-live PR (its
// owning Run already terminated) is treated the same as an untracked PR —
// merge is offered — since AC6's rule is "no *live* Run owns the PR," not
// "no Run has ever owned the PR." Shared by the GET route (what the merge
// section renders) and the POST route (the actual refusal), so the button
// an operator sees always matches what the guard will do.
//
// Keyed by the PR's originating issueNumber, not just
// TrackedPullRequest.runId: a Run that re-engages an already-tracked PR
// (a review-dispatch retry, or a merge_pr-state waiting Run) can be a
// *different*, currently-live Run than the one that originally discovered
// it. Checking only the original runId's liveness would read this PR as
// unowned the moment that first Run terminates, even while a successor
// Run for the same issue is actively working it — findLiveRunIdForIssue
// already finds any live Run for that issue, including that successor.
function livePullRequestOwnerRunId(input: {
  getActiveRuns:
    | (() => Array<{ issueNumber: number; projectName: string; runId: string }>)
    | undefined;
  getProjectRepoAliases: ((projectName: string) => string[]) | undefined;
  getScheduled: (() => ScheduledCallback[]) | undefined;
  issueNumber: number | undefined;
  projectName: string;
  runStore: RunStore;
}): string | undefined {
  if (input.issueNumber === undefined) {
    return undefined;
  }
  return findLiveRunIdForIssue({
    getActiveRuns: input.getActiveRuns,
    getProjectRepoAliases: input.getProjectRepoAliases,
    getScheduled: input.getScheduled,
    issueNumber: input.issueNumber,
    projectName: input.projectName,
    runStore: input.runStore
  });
}

// Combines the two independent ownership signals a PR can have: a live Run
// (keyed by issueNumber, see livePullRequestOwnerRunId) and a live Routine
// Firing (keyed by branch directly on PullRequestDetail.liveRoutineFiringId
// — Routine Firings have no issue number, so they can't flow through the
// Run-keyed check). Formats a ready-to-display label so callers don't
// re-derive "run X" vs "routine firing X" wording independently.
function livePullRequestOwnerLabel(input: {
  detail: PullRequestDetail;
  getActiveRuns:
    | (() => Array<{ issueNumber: number; projectName: string; runId: string }>)
    | undefined;
  getProjectRepoAliases: ((projectName: string) => string[]) | undefined;
  getScheduled: (() => ScheduledCallback[]) | undefined;
  runStore: RunStore;
}): string | undefined {
  const liveRunId = livePullRequestOwnerRunId({
    getActiveRuns: input.getActiveRuns,
    getProjectRepoAliases: input.getProjectRepoAliases,
    getScheduled: input.getScheduled,
    issueNumber: input.detail.issueNumber,
    projectName: input.detail.projectName,
    runStore: input.runStore
  });
  if (liveRunId !== undefined) {
    return `run ${liveRunId}`;
  }
  return input.detail.liveRoutineFiringId === undefined
    ? undefined
    : `routine firing ${input.detail.liveRoutineFiringId}`;
}

// #303's own pre-restart check (renderProjectCapacityStrip, above) inlined
// here for a single row's polledAt rather than a project's lastPollFinishedAt
// — same rule (ADR 0073): a snapshot row timestamped before this process
// started hasn't been refreshed since the daemon came up.
function isPreRestartSnapshot(
  polledAt: string,
  startedAtMs: number | undefined
): boolean {
  return startedAtMs !== undefined && Date.parse(polledAt) < startedAtMs;
}

function searchIssueSnapshots(input: {
  filters: IssueSearchFilters;
  nowMs: number;
  projectNames: string[];
  runStore: RunStore;
  scheduled: ScheduledCallback[];
  startedAtMs: number | undefined;
}): IssueSearchRow[] {
  const targetProjects =
    input.filters.project === undefined
      ? input.projectNames
      : input.projectNames.filter((name) => name === input.filters.project);
  const q = input.filters.q?.toLowerCase();
  const rows: IssueSearchRow[] = [];
  for (const projectName of targetProjects) {
    for (const snapshot of input.runStore.listProjectIssueSnapshots(
      projectName
    )) {
      if (
        input.filters.verdict === "eligible" &&
        snapshot.kind !== "candidate"
      ) {
        continue;
      }
      if (
        input.filters.verdict === "filtered" &&
        snapshot.kind !== "filtered"
      ) {
        continue;
      }
      if (
        input.filters.label !== undefined &&
        !snapshot.labels.includes(input.filters.label)
      ) {
        continue;
      }
      if (q !== undefined && !snapshot.title.toLowerCase().includes(q)) {
        continue;
      }
      const claimedRunId = resolveClaimedRunId(
        input.runStore,
        projectName,
        snapshot.issueNumber,
        snapshot.reasons,
        input.scheduled
      );
      rows.push({
        blockedBy: snapshot.blockedBy,
        blockedByTruncated: snapshot.blockedByTruncated,
        issueNumber: snapshot.issueNumber,
        labels: snapshot.labels,
        polledAt: snapshot.polledAt,
        preRestart: isPreRestartSnapshot(snapshot.polledAt, input.startedAtMs),
        projectName,
        snapshotRepository: input.runStore.getProjectIssueSnapshotRepository(
          projectName,
          snapshot.issueNumber
        ),
        title: snapshot.title,
        verdict: describeIssueVerdict(snapshot, claimedRunId)
      });
    }
  }
  rows.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      b.issueNumber - a.issueNumber
  );
  return rows;
}

function issueVerdictFamily(
  verdict: string
): "ok" | "fail" | "blocked" | "progress" | "neutral" {
  if (verdict === "eligible") {
    return "ok";
  }
  // describeIssueVerdict joins multiple reasons with "; " (e.g. an issue
  // both missing its required label and blocked by an open dependency
  // reads "filtered: missing ...; blocked: dependency ..."), so a
  // whole-string prefix check would miss a blocked/claimed segment that
  // isn't first. Scan segments in order instead -- first non-neutral wins,
  // which preserves today's "claimed by run" precedence since operational
  // label reasons are always pushed before dependency reasons (see
  // evaluateProjectEligibility, src/issue-polling.ts).
  for (const segment of verdict.split("; ")) {
    if (segment.startsWith("blocked:")) {
      return "blocked";
    }
    if (segment.startsWith("claimed by run")) {
      return "progress";
    }
  }
  return "neutral";
}

function renderIssueSearchFilters(
  filters: IssueSearchFilters,
  projectNames: string[]
): string {
  const projectOptions = projectNames
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${filters.project === name ? " selected" : ""}>${escapeHtml(name)}</option>`
    )
    .join("");
  const verdictOption = (value: string, label: string) =>
    `<option value="${escapeHtml(value)}"${filters.verdict === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  return `<form class="filters" method="get" action="/issues">
<label>Search<input type="text" name="q" value="${escapeHtml(filters.q ?? "")}" placeholder="issue title"></label>
<label>Project<select name="project"><option value="">All projects</option>${projectOptions}</select></label>
<label>Verdict<select name="verdict">${verdictOption("", "Any")}${verdictOption("eligible", "Eligible")}${verdictOption("filtered", "Filtered")}</select></label>
<label>Label<input type="text" name="label" value="${escapeHtml(filters.label ?? "")}" placeholder="exact label"></label>
<button class="btn" type="submit">Search</button>
</form>`;
}

// #467's bulk multi-select label editing: the data window.__ISSUES__ hands
// the React island (src/client/issues-bulk.tsx) -- just enough to build
// selection state and a label autocomplete without a second network
// request. Mirrors the currently-rendered rows exactly, not the full
// IssueSearchRow (verdict/age/preRestart are display-only, not something
// the bulk-action UI needs).
type BulkSelectIssueData = {
  issueNumber: number;
  labels: string[];
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
  title: string;
};

// The /issues list row's "Deps" column: a bare count + link into the
// dependency graph view (Phase 2, GET /issues/graph), independent of the
// Verdict pill -- which already surfaces the same unresolved-dependency
// fact in eligibility-reason form (see evaluateProjectEligibility). This
// column exists for the itemized detail the terse verdict string doesn't
// carry, not to duplicate the eligibility signal.
function renderIssueSearchRowDeps(row: IssueSearchRow): string {
  if (row.blockedBy.length === 0 && !row.blockedByTruncated) {
    return "—";
  }
  const openCount = row.blockedBy.filter(
    (blocker) => blocker.state !== "CLOSED"
  ).length;
  const graphLink = `/issues/graph?project=${encodeURIComponent(row.projectName)}&issue=${row.issueNumber}`;
  // A truncated fetch means openCount is a lower bound, not the true
  // count -- the "+" signals more blockers exist than could be checked,
  // so this never reads as "0 open" (eligible) for an issue the gate
  // (issueDependencyGateBlocks) is actually treating as blocked.
  const label = row.blockedByTruncated
    ? `${openCount}+ open`
    : `${openCount} open`;
  return `<a href="${escapeHtml(graphLink)}">${label} ↗</a>`;
}

function renderIssueSearchPage(input: {
  csrfToken: string;
  filters: IssueSearchFilters;
  nowMs: number;
  projectNames: string[];
  rows: IssueSearchRow[];
}): string {
  const filterForm = renderIssueSearchFilters(
    input.filters,
    input.projectNames
  );
  const note = `<p class="note">Reads Symphonika's own poll snapshot (ADR 0073): open issues only, at most ~30s stale in steady state, scoped to configured Projects' repos. No GitHub Search API calls; search is over issue titles only.</p>`;
  if (input.rows.length === 0) {
    return `<h1 class="page-title">Issue triage</h1>${note}${filterForm}<div class="empty"><strong>No matching issues</strong>No polled issue matches these filters.</div>`;
  }
  const body = input.rows
    .map((row) => {
      const age = formatAge(row.polledAt, input.nowMs);
      const preRestart = row.preRestart
        ? ' <span class="muted">(pre-restart)</span>'
        : "";
      const labels =
        row.labels.length === 0
          ? "—"
          : row.labels.map((label) => escapeHtml(label)).join(", ");
      const issueLink = `/issues/${encodeURIComponent(row.projectName)}/${row.issueNumber}`;
      const checkbox = `<input type="checkbox" class="bulk-issue-checkbox" data-project="${escapeHtml(row.projectName)}" data-issue="${row.issueNumber}">`;
      const deps = renderIssueSearchRowDeps(row);
      return `<tr><td>${checkbox}</td><td>${escapeHtml(row.projectName)}</td><td><a href="${escapeHtml(issueLink)}">#${row.issueNumber}</a></td><td class="c-title">${escapeHtml(row.title)}</td><td>${labelPill(row.verdict, issueVerdictFamily(row.verdict))}</td><td>${labels}</td><td>${deps}</td><td>${escapeHtml(age)}${preRestart}</td></tr>`;
    })
    .join("");
  const table = tableSection(
    "Issues",
    input.rows.length,
    `<tr><th><input type="checkbox" id="bulk-select-all-checkbox"></th><th>Project</th><th>#</th><th>Title</th><th>Verdict</th><th>Labels</th><th>Deps</th><th>Polled</th></tr>`,
    body
  );
  const issuesData: BulkSelectIssueData[] = input.rows.map((row) => ({
    issueNumber: row.issueNumber,
    labels: row.labels,
    projectName: row.projectName,
    snapshotRepository: row.snapshotRepository,
    title: row.title
  }));
  const bulkSelectMount = `<div id="issues-bulk-root"></div>
<script>window.__ISSUES__ = ${escapeJsonForInlineScript(issuesData)};
window.__CSRF_TOKEN__ = ${escapeJsonForInlineScript(input.csrfToken)};</script>
<script src="/assets/issues-bulk.js"></script>`;
  return `<h1 class="page-title">Issue triage</h1>${note}${filterForm}${bulkSelectMount}${table}`;
}

// The shape embedded as window.__ISSUE_DEPS_GRAPH__ for the client-side
// buildDependencyGraphElements (src/client/dependency-graph-elements.ts) --
// duplicated locally rather than imported, matching this codebase's
// existing src/client/ convention (e.g. issues-bulk-select.tsx's own
// BulkSelectIssueData) of not sharing types across the server/client
// tsconfig boundary.
type DependencyGraphEmbedIssue = {
  blockedBy: RawGitHubIssueDependencyRef[];
  blockedByTruncated: boolean;
  issueNumber: number;
  owner: string;
  parentIssueNumber?: number;
  projectName: string;
  repo: string;
  title: string;
};

// Only projects whose owner/repo actually resolves contribute nodes -- a
// Routine Host or an unknown Project name is skipped rather than erroring,
// consistent with this route's other optional-injected accessors.
//
// Two Project names can alias the same GitHub owner/repo (a supported
// config -- see getProjectRepoAliases's own doc comment above), and each
// alias polls and persists its own snapshot row for the same physical
// GitHub issue. Since a graph node represents one physical issue, not one
// Project's view of it, `seenIssueKeys` keeps only the first row seen per
// owner/repo#issueNumber -- callers pass targetProjects pre-sorted, so
// "first seen" is deterministically the alphabetically-first Project name,
// not an accident of Map/object iteration order.
function buildDependencyGraphIssues(input: {
  getProjectRepo:
    | ((projectName: string) => { owner: string; repo: string } | undefined)
    | undefined;
  runStore: RunStore;
  targetProjects: string[];
}): DependencyGraphEmbedIssue[] {
  const issues: DependencyGraphEmbedIssue[] = [];
  const seenIssueKeys = new Set<string>();
  for (const projectName of input.targetProjects) {
    const repo = input.getProjectRepo?.(projectName);
    if (repo === undefined) {
      continue;
    }
    for (const snapshot of input.runStore.listProjectIssueSnapshots(
      projectName
    )) {
      // Lowercased for the same reason the client's issueNodeId is: GitHub
      // repo lookups are case-insensitive, so two aliased Projects can
      // configure the identical repo with different casing.
      const issueKey = `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}#${snapshot.issueNumber}`;
      if (seenIssueKeys.has(issueKey)) {
        continue;
      }
      seenIssueKeys.add(issueKey);
      issues.push({
        blockedBy: snapshot.blockedBy,
        blockedByTruncated: snapshot.blockedByTruncated,
        issueNumber: snapshot.issueNumber,
        owner: repo.owner,
        ...(snapshot.parentIssueNumber === undefined
          ? {}
          : { parentIssueNumber: snapshot.parentIssueNumber }),
        projectName,
        repo: repo.repo,
        title: snapshot.title
      });
    }
  }
  return issues;
}

// ADR-0056's graceful-degradation guardrail: always rendered, and only
// hidden by the client script (IssuesDepsGraphView) once cytoscape has
// mounted without throwing -- see that component's own comment. Only lists
// issues with at least one blocker, mirroring renderIssueDependenciesSection
// on the issue detail page rather than repeating every dependency-free
// issue here too.
function renderIssueDependencyGraphFallback(
  issues: DependencyGraphEmbedIssue[]
): string {
  const withBlockers = issues.filter(
    (issue) => issue.blockedBy.length > 0 || issue.blockedByTruncated
  );
  if (withBlockers.length === 0) {
    return `<p class="note">No open dependency links in this view.</p>`;
  }
  const rows = withBlockers
    .map((issue) => {
      const blockers = issue.blockedBy
        .map((blocker) => {
          const ref = `${blocker.owner}/${blocker.repo}#${blocker.number}`;
          const family = blocker.state === "CLOSED" ? "ok" : "blocked";
          return `<li>${labelPill(blocker.state, family)} ${escapeHtml(ref)} — ${escapeHtml(blocker.title)}</li>`;
        })
        .join("");
      // A truncated fetch means the fetched blockers above -- even if every
      // one shown is closed -- aren't the whole story; called out
      // separately so it can't be mistaken for one more (closed) blocker.
      const truncatedNote = issue.blockedByTruncated
        ? `<li class="pill pill--blocked">⚠ more dependency links than could be checked</li>`
        : "";
      return `<li><strong>${escapeHtml(issue.projectName)}#${issue.issueNumber}</strong> ${escapeHtml(issue.title)}<ul class="label-list">${blockers}${truncatedNote}</ul></li>`;
    })
    .join("");
  return `<ul class="label-list">${rows}</ul>`;
}

function renderIssueDependencyGraphPage(input: {
  focusIssue: { issueNumber: number; owner: string; repo: string } | undefined;
  issues: DependencyGraphEmbedIssue[];
  projectFilter: string | undefined;
  projectNames: string[];
}): string {
  const projectOptions = input.projectNames
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${input.projectFilter === name ? " selected" : ""}>${escapeHtml(name)}</option>`
    )
    .join("");
  const filterForm = `<form class="filters" method="get" action="/issues/graph">
<label>Project<select name="project"><option value="">All projects</option>${projectOptions}</select></label>
<button class="btn" type="submit">Filter</button>
</form>`;
  const fallback = renderIssueDependencyGraphFallback(input.issues);
  const mount = `<div id="issues-deps-graph-fallback">${fallback}</div>
<style>${DEPS_GRAPH_STYLES}</style>
<div id="issues-deps-graph-root"></div>
<script>window.__ISSUE_DEPS_GRAPH__ = ${escapeJsonForInlineScript({ focusIssue: input.focusIssue, issues: input.issues })};</script>
<script src="/assets/issues-deps-graph.js"></script>`;
  return `<h1 class="page-title">Issue dependency graph</h1><p class="note"><a href="/issues">&larr; back to triage</a></p>${filterForm}${mount}`;
}

// Without an explicit height, .deps-graph-canvas is an empty block with no
// content until cytoscape populates it -- it computes to zero height, so
// IssuesDepsGraphView's cytoscape instance would mount into an invisible
// container right before hideFallback() removes the only visible content.
// Mirrors WORKFLOW_GRAPH_STYLES's #wf-cy sizing for the pre-existing
// /runs/:id/graph cytoscape view.
const DEPS_GRAPH_STYLES = `
.deps-graph-wrap { display:flex; gap:1rem; align-items:stretch; }
.deps-graph-canvas { flex:1 1 auto; height:80vh; min-height:520px; border:1px solid #e2e8f0; border-radius:10px; }
.deps-graph-detail { flex:0 0 320px; border:1px solid #e2e8f0; border-radius:10px; padding:.8rem .9rem; }
`;

// #308 part 2: orchestrator-owned labels (ADR 0002/0024) render as read-only
// evidence of dispatch state, never as something the triage UI can add or
// remove — hand-editing one invites the double-dispatch / silent-block ADR
// 0077 documents. Enforced server-side here, not just hidden client-side.
const SYM_LABEL_PREFIX = "sym:";

// GitHub label names are matched case-insensitively (two labels differing
// only by case can't coexist in one repo), so a case-sensitive prefix check
// alone lets a caller-submitted "SYM:claimed" bypass this guard while still
// resolving to the real orchestrator-owned sym:claimed label on GitHub's
// side.
function isOrchestratorLabel(label: string): boolean {
  return label.toLowerCase().startsWith(SYM_LABEL_PREFIX);
}

// The label-write dependency gate's own read of "resolved" (state ===
// CLOSED, regardless of stateReason) -- kept in lockstep with
// evaluateProjectEligibility's identical rule (src/issue-polling.ts) since
// this route is a best-effort UX gate against the same snapshot data, not
// a second source of truth. See docs/adr/0081-issue-dependency-gating-and-graph-view.md.
function unresolvedIssueDependencies(
  snapshot: ProjectIssueSnapshotRow
): RawGitHubIssueDependencyRef[] {
  return snapshot.blockedBy.filter((blocker) => blocker.state !== "CLOSED");
}

// A truncated fetch (more blockedBy links than
// ISSUE_DEPENDENCIES_MAX_BLOCKERS_PER_ISSUE, src/issue-polling.ts) gates
// exactly like an open blocker -- fail closed on the unfetched overflow
// rather than gating only on the state of the blockers that happened to
// fit, which would silently allow dispatch when the true state is
// unknown.
function issueDependencyGateBlocks(snapshot: ProjectIssueSnapshotRow): boolean {
  return (
    snapshot.blockedByTruncated ||
    unresolvedIssueDependencies(snapshot).length > 0
  );
}

function issueDependencyGateMessage(snapshot: ProjectIssueSnapshotRow): string {
  const unresolved = unresolvedIssueDependencies(snapshot);
  if (unresolved.length === 0 && snapshot.blockedByTruncated) {
    return "blocked: this issue has more dependency links than could be checked";
  }
  return `blocked by open ${dependencyList(unresolved)}`;
}

function dependencyList(blockers: RawGitHubIssueDependencyRef[]): string {
  const refs = blockers
    .map((blocker) => `${blocker.owner}/${blocker.repo}#${blocker.number}`)
    .join(", ");
  return blockers.length === 1 ? `dependency ${refs}` : `dependencies ${refs}`;
}

type BulkIssueLabelResult =
  | { issueNumber: number; ok: true; projectName: string }
  | { error: string; issueNumber: number; ok: false; projectName: string };

// Array.isArray's lib.es5.d.ts signature narrows to `any[]`, not
// `unknown[]` -- these normalize a parsed JSON body's fields to properly
// typed arrays. A malformed element (wrong type, missing field) makes the
// whole field invalid rather than being silently dropped: the documented
// contract for a malformed request body is 400 with no writes attempted,
// and filtering out just the bad element let the route mutate the
// surviving, seemingly-valid entries -- a partial write the caller never
// asked for and has no way to detect from the response. An omitted field
// (`undefined`) is not malformed -- it just means "none provided" -- and
// stays valid-and-empty so the existing "at least one required" checks
// handle it.
type ArrayValidationResult<T> =
  { ok: true; values: T[] } | { error: string; ok: false };

function asStringArray(
  fieldName: string,
  value: unknown
): ArrayValidationResult<string> {
  if (value === undefined) {
    return { ok: true, values: [] };
  }
  if (!Array.isArray(value)) {
    return { error: `${fieldName} must be an array of strings`, ok: false };
  }
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { error: `${fieldName} must be an array of strings`, ok: false };
    }
    values.push(entry);
  }
  return { ok: true, values };
}

type BulkIssueOperation = {
  issueNumber: number;
  projectName: string;
  snapshotRepository?: ProjectSnapshotRepository;
};

function asBulkIssueOperations(
  value: unknown
): ArrayValidationResult<BulkIssueOperation> {
  if (value === undefined) {
    return { ok: true, values: [] };
  }
  if (!Array.isArray(value)) {
    return {
      error: "operations must be an array of {issueNumber, projectName}",
      ok: false
    };
  }
  const values: BulkIssueOperation[] = [];
  for (const entry of value) {
    const record = entry as Record<string, unknown> | null;
    const issueNumber = record?.issueNumber;
    const projectName = record?.projectName;
    const repository = record?.snapshotRepository;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof issueNumber !== "number" ||
      !Number.isInteger(issueNumber) ||
      issueNumber <= 0 ||
      typeof projectName !== "string" ||
      (repository !== undefined &&
        (typeof repository !== "object" ||
          repository === null ||
          typeof (repository as Record<string, unknown>).owner !== "string" ||
          (repository as Record<string, unknown>).owner === "" ||
          typeof (repository as Record<string, unknown>).repo !== "string" ||
          (repository as Record<string, unknown>).repo === ""))
    ) {
      return {
        error: "operations must be an array of {issueNumber, projectName}",
        ok: false
      };
    }
    values.push({
      issueNumber,
      projectName,
      ...(repository === undefined
        ? {}
        : { snapshotRepository: repository as ProjectSnapshotRepository })
    });
  }
  return { ok: true, values };
}

// Fast without bursting the GitHub API: a worker pool rather than fully
// sequential or fully parallel writes across a potentially large selection.
const BULK_LABEL_WRITE_CONCURRENCY = 4;

async function runBulkIssueLabelWrites(input: {
  addLabels: string[];
  getProjectRequiredLabels: (projectName: string) => string[];
  operations: BulkIssueOperation[];
  removeLabels: string[];
  runStore: RunStore;
  writeIssueLabels: WriteIssueLabelsFn;
}): Promise<BulkIssueLabelResult[]> {
  const {
    addLabels,
    getProjectRequiredLabels,
    operations,
    removeLabels,
    runStore,
    writeIssueLabels
  } = input;
  const results = new Array<BulkIssueLabelResult>(operations.length);
  let nextIndex = 0;
  // Cached per project (not per operation) since a bulk selection commonly
  // spans many issues in the same project -- avoids re-scanning
  // listProjectIssueSnapshots once per operation.
  const snapshotsByProject = new Map<string, ProjectIssueSnapshotRow[]>();

  function snapshotFor(
    projectName: string,
    issueNumber: number
  ): ProjectIssueSnapshotRow | undefined {
    let snapshots = snapshotsByProject.get(projectName);
    if (snapshots === undefined) {
      snapshots = runStore.listProjectIssueSnapshots(projectName);
      snapshotsByProject.set(projectName, snapshots);
    }
    return snapshots.find((row) => row.issueNumber === issueNumber);
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const operation = operations[index];
      if (operation === undefined) {
        return;
      }
      // Mirrors handleIssueLabelWrite's hard block on the single-issue
      // form: adding a configured required label to a dependency-blocked
      // issue is refused here too -- the bulk toolbar is a second
      // label-write path and must not bypass the same gate (see
      // docs/adr/0081-issue-dependency-gating-and-graph-view.md). Both add
      // and remove are skipped for this operation when blocked, since a
      // single writeIssueLabels call can't apply just one half of a
      // combined add+remove request.
      const requiredLabels = getProjectRequiredLabels(
        operation.projectName
      ).map((requiredLabel) => requiredLabel.toLowerCase());
      const addsRequiredLabel = addLabels.some((label) =>
        requiredLabels.includes(label.toLowerCase())
      );
      if (addsRequiredLabel) {
        const snapshot = snapshotFor(
          operation.projectName,
          operation.issueNumber
        );
        // A missing snapshot (not yet polled, or a stale/incorrect issue
        // number posted straight to the API) is unknown dependency state,
        // not clear dependency state -- fail closed the same way a
        // truncated fetch does (ADR 0081), rather than letting the add
        // through unchecked because there's nothing to gate against.
        if (snapshot === undefined || issueDependencyGateBlocks(snapshot)) {
          results[index] = {
            error:
              snapshot === undefined
                ? `issue #${operation.issueNumber} is not in the current poll snapshot -- poll now, then retry`
                : `${issueDependencyGateMessage(snapshot)} -- resolve on GitHub, then poll now`,
            issueNumber: operation.issueNumber,
            ok: false,
            projectName: operation.projectName
          };
          continue;
        }
      }
      // The full requested removeLabels goes to every issue, not narrowed
      // against the persisted poll snapshot -- the snapshot can lag live
      // GitHub state indefinitely (ADR 0073), so filtering against it can
      // silently drop a legitimate removal (e.g. add-then-immediate-remove
      // of the same label) and report false success. Removing a label an
      // issue doesn't have is instead made idempotent at the source
      // (tryRemoveLabelsFromIssue, src/issue-polling.ts, swallows the
      // resulting 404), which is safe against live state regardless of
      // snapshot staleness. Every operation runs regardless of earlier
      // outcomes -- best-effort, so one issue's GitHub-side failure
      // doesn't block the rest of the batch.
      const outcome = await writeIssueLabels({
        add: addLabels,
        kind: "issue",
        projectName: operation.projectName,
        remove: removeLabels,
        snapshotRepository: operation.snapshotRepository,
        subjectNumber: operation.issueNumber
      });
      results[index] = outcome.ok
        ? {
            issueNumber: operation.issueNumber,
            ok: true,
            projectName: operation.projectName
          }
        : {
            error: outcome.error,
            issueNumber: operation.issueNumber,
            ok: false,
            projectName: operation.projectName
          };
    }
  }

  const workerCount = Math.min(BULK_LABEL_WRITE_CONCURRENCY, operations.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

type IssueDetail = {
  claimedRunId: string | undefined;
  issueNumber: number;
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
  snapshot: ProjectIssueSnapshotRow;
  verdict: string;
};

function loadIssueDetail(
  runStore: RunStore,
  projectName: string,
  issueNumber: number,
  scheduled: ScheduledCallback[]
): IssueDetail | undefined {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return undefined;
  }
  const snapshot = runStore
    .listProjectIssueSnapshots(projectName)
    .find((row) => row.issueNumber === issueNumber);
  if (snapshot === undefined) {
    return undefined;
  }
  const claimedRunId = resolveClaimedRunId(
    runStore,
    projectName,
    issueNumber,
    snapshot.reasons,
    scheduled
  );
  return {
    claimedRunId,
    issueNumber,
    projectName,
    snapshotRepository: runStore.getProjectIssueSnapshotRepository(
      projectName,
      issueNumber
    ),
    snapshot,
    verdict: describeIssueVerdict(snapshot, claimedRunId)
  };
}

function renderIssueNotFound(projectName: string, issueNumber: string): string {
  return layout(
    "Issue not found",
    `<h1 class="page-title">Issue not found</h1><p class="lede">No polled snapshot for ${escapeHtml(projectName)}#${escapeHtml(issueNumber)} — it may be closed, outside a configured Project's repo, or not yet polled. Search only reads #303's persisted snapshot, never a live GitHub lookup.</p>`
  );
}

// #308 part 2's label-write outcome banner. A write's success or failure
// never changes what this page shows for `labels` below it — the persisted
// snapshot only advances on the next successful poll (AC7: "the issue's
// displayed labels unchanged" on a failed write holds for a *successful* one
// too, by the same read-only-snapshot design ADR 0077 documents in part 1).
type IssueLabelWriteBanner = {
  action: "add" | "remove";
  error?: string;
  kind: "label_write";
  label: string;
  ok: boolean;
  // Set on the dependency gate's own rejection: unlike every other failed
  // write, this one is worth offering a poll-now retry for, since the
  // fix (closing the blocker on GitHub) happens entirely outside
  // Symphonika and a fresh poll is exactly what lets the operator retry
  // without waiting out the poll interval.
  offerPollNow?: boolean;
};

// #308 part 3's clear-stale-claim action: its own named banner, distinct
// from a single label add/remove, since it clears a set of labels together
// and carries a distinct refusal reason (a live Run) a plain label write
// never has. See ADR 0077.
type IssueClearStaleClaimBanner = {
  clearedLabels?: string[];
  error?: string;
  kind: "clear_stale_claim";
  ok: boolean;
};

type IssueActionBanner = IssueClearStaleClaimBanner | IssueLabelWriteBanner;

function renderIssueLabelWriteBanner(banner: IssueLabelWriteBanner): string {
  const verb = banner.action === "add" ? "Add" : "Remove";
  if (!banner.ok) {
    return `<div class="alert" role="alert"><strong>${verb} label "${escapeHtml(banner.label)}" failed</strong>${banner.error === undefined ? "" : `<p>${escapeHtml(banner.error)}</p>`}<p>The labels shown below are unchanged.</p></div>`;
  }
  const past = banner.action === "add" ? "Added" : "Removed";
  return `<div class="alert alert--ok" role="status"><strong>${past} label "${escapeHtml(banner.label)}" on GitHub</strong><p>This page shows the last poll snapshot; the label list below and the verdict won't reflect this until the next poll.</p></div>`;
}

function renderIssueClearStaleClaimBanner(
  banner: IssueClearStaleClaimBanner
): string {
  if (!banner.ok) {
    return `<div class="alert" role="alert"><strong>Clear stale claim failed</strong>${banner.error === undefined ? "" : `<p>${escapeHtml(banner.error)}</p>`}<p>The labels shown below are unchanged.</p></div>`;
  }
  const cleared = (banner.clearedLabels ?? []).map(escapeHtml).join(", ");
  return `<div class="alert alert--ok" role="status"><strong>Cleared stale claim on GitHub</strong><p>Removed ${cleared}. This page shows the last poll snapshot; the label list below and the verdict won't reflect this until the next poll.</p></div>`;
}

function renderIssueActionBanner(banner: IssueActionBanner): string {
  return banner.kind === "label_write"
    ? renderIssueLabelWriteBanner(banner)
    : renderIssueClearStaleClaimBanner(banner);
}

// #309: the daemon's poll tick now refreshes both issues and PRs together
// (ADR 0078), so the PR detail page's write banner offers the same trigger
// the issue page does. `returnTo` carries the caller back to the search
// page it came from, rather than always landing on /issues regardless of
// origin — validated against a fixed allowlist server-side
// (normalizePollNowReturnTo), never trusted as a raw redirect target.
function renderPollNowForm(csrfToken: string, returnTo: string): string {
  return `<form method="post" action="/issues/poll-now"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(csrfToken)}"><input type="hidden" name="return_to" value="${escapeHtml(returnTo)}"><button class="btn" type="submit">Poll now</button></form>`;
}

const POLL_NOW_RETURN_TARGETS: ReadonlySet<string> = new Set([
  "/issues",
  "/prs"
]);

function normalizePollNowReturnTo(value: string | undefined): string {
  return value !== undefined && POLL_NOW_RETURN_TARGETS.has(value)
    ? value
    : "/issues";
}

// #308 part 3: the same three labels ADR 0038 / doctor.ts's `clear-stale`
// CLI command removes together (STALE_CLEAR_LABELS, src/doctor.ts) — kept
// as its own copy here rather than importing doctor.ts's private constant,
// since that module is CLI-only machinery this HTTP surface shouldn't
// couple to. See ADR 0077.
const STALE_CLEAR_LABELS: ReadonlySet<string> = new Set([
  "sym:stale",
  "sym:claimed",
  "sym:running"
]);

function renderClearStaleClaimSection(input: {
  csrfToken: string;
  issueNumber: number;
  labels: string[];
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
}): string {
  const hasClaimLabel = input.labels.some((label) =>
    STALE_CLEAR_LABELS.has(label)
  );
  if (!hasClaimLabel) {
    return "";
  }
  const action = `/issues/${encodeURIComponent(input.projectName)}/${input.issueNumber}/clear-stale-claim`;
  return `<section><h2>Clear stale claim</h2><p class="note">Removes ${Array.from(
    STALE_CLEAR_LABELS
  )
    .map((label) => `<code>${escapeHtml(label)}</code>`)
    .join(
      ", "
    )} together (ADR 0038) — refused if a live Run still holds this issue, so it never invites a double dispatch.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">${renderSnapshotRepositoryFields(input.snapshotRepository)}<button class="btn" type="submit">Clear stale claim</button></form></section>`;
}

function renderIssueLabelsSection(input: {
  csrfToken: string;
  issueNumber: number;
  labels: string[];
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
}): string {
  const repositoryFields = renderSnapshotRepositoryFields(
    input.snapshotRepository
  );
  const rows = input.labels.map((label) => {
    if (isOrchestratorLabel(label)) {
      return `<li>${labelPill(label, "neutral")} <span class="muted">managed by Symphonika — not editable here</span></li>`;
    }
    const removeAction = `/issues/${encodeURIComponent(input.projectName)}/${input.issueNumber}/labels/remove`;
    return `<li>${labelPill(label, "neutral")} <form method="post" action="${escapeHtml(removeAction)}"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">${repositoryFields}<input type="hidden" name="label" value="${escapeHtml(label)}"><button class="btn" type="submit">Remove</button></form></li>`;
  });
  const list =
    rows.length === 0
      ? `<p class="muted">No labels.</p>`
      : `<ul class="label-list">${rows.join("")}</ul>`;
  const addAction = `/issues/${encodeURIComponent(input.projectName)}/${input.issueNumber}/labels/add`;
  const addForm = `<form method="post" action="${escapeHtml(addAction)}"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">${repositoryFields}<label>Add a label<input type="text" name="label" placeholder="agent-ready" required></label> <button class="btn" type="submit">Add</button></form>`;
  return `<section><h2>Labels</h2><p class="note"><code>sym:*</code> labels are how Symphonika tracks dispatch state (ADR 0002/0024) — removing one by hand can trigger a double dispatch or silently block an issue, so they render here but can't be edited.</p>${list}${addForm}</section>`;
}

function renderIssueDetailPage(input: {
  banner: IssueActionBanner | undefined;
  csrfToken: string;
  detail: IssueDetail;
  pollNowAvailable: boolean;
}): string {
  const { detail } = input;
  const offerPollNow =
    input.banner !== undefined &&
    (input.banner.ok ||
      (input.banner.kind === "label_write" &&
        input.banner.offerPollNow === true));
  const bannerHtml =
    input.banner === undefined
      ? ""
      : `${renderIssueActionBanner(input.banner)}${offerPollNow && input.pollNowAvailable ? renderPollNowForm(input.csrfToken, "/issues") : ""}`;
  return `<h1 class="page-title">#${detail.issueNumber} ${escapeHtml(detail.snapshot.title)}</h1><p class="note">${escapeHtml(detail.projectName)} · ${labelPill(detail.verdict, issueVerdictFamily(detail.verdict))}</p>${bannerHtml}${renderIssueDependenciesSection(detail.snapshot.blockedBy, detail.snapshot.blockedByTruncated)}${renderIssueLabelsSection(
    {
      csrfToken: input.csrfToken,
      issueNumber: detail.issueNumber,
      labels: detail.snapshot.labels,
      projectName: detail.projectName,
      snapshotRepository: detail.snapshotRepository
    }
  )}${renderClearStaleClaimSection({
    csrfToken: input.csrfToken,
    issueNumber: detail.issueNumber,
    labels: detail.snapshot.labels,
    projectName: detail.projectName,
    snapshotRepository: detail.snapshotRepository
  })}<p class="note"><a href="/issues">← Back to search</a></p>`;
}

// Full itemized breakdown of a Deps-column count -- kind of every
// blockedBy entry (open and closed), unlike evaluateProjectEligibility's
// reasons, which only names the open (unresolved) ones. Absent entirely
// for an issue with no blockedBy links, rather than an empty section.
function renderIssueDependenciesSection(
  blockedBy: RawGitHubIssueDependencyRef[],
  blockedByTruncated: boolean
): string {
  if (blockedBy.length === 0 && !blockedByTruncated) {
    return "";
  }
  const rows = blockedBy
    .map((blocker) => {
      const ref = `${blocker.owner}/${blocker.repo}#${blocker.number}`;
      const family = blocker.state === "CLOSED" ? "ok" : "blocked";
      return `<li>${labelPill(blocker.state, family)} ${escapeHtml(ref)} — ${escapeHtml(blocker.title)}</li>`;
    })
    .join("");
  // Rendered even when blockedBy is empty (rather than short-circuiting
  // above) so a truncated fetch never omits the section entirely --
  // that would look identical to "no dependencies" for an issue the
  // gate is actually treating as blocked.
  const truncatedRow = blockedByTruncated
    ? `<li>${labelPill("unknown", "blocked")} this issue has more dependency links than could be checked</li>`
    : "";
  return `<section><h2>Dependencies</h2><p class="note">GitHub's native issue-dependency links (not parsed from body text). An open blocker here is also why this issue may show a "blocked:" verdict.</p><ul class="label-list">${rows}${truncatedRow}</ul></section>`;
}

// #309's PR search: filter query params, all optional and combined with AND
// — same shape as #308's IssueSearchFilters above.
type PullRequestSearchFilters = {
  origin: PullRequestBranchOrigin | undefined;
  project: string | undefined;
  q: string | undefined;
  tracking: "tracked" | "untracked" | undefined;
};

type PullRequestSearchRow = {
  branchOrigin: PullRequestBranchOrigin;
  checks: string | null;
  draft: boolean;
  mergeable: string | null;
  polledAt: string;
  preRestart: boolean;
  prNumber: number;
  projectName: string;
  reviewDecision: string | null;
  stateAvailable: boolean;
  title: string;
  trackedRunId: string | undefined;
  trackingState: "closed" | "merged" | "open";
  unresolvedReviewThreads: number | null;
};

const KNOWN_PR_ORIGIN_FILTERS: ReadonlySet<string> = new Set([
  "issue_branch",
  "routine_firing_branch",
  "neither"
]);
const KNOWN_PR_TRACKING_FILTERS: ReadonlySet<string> = new Set([
  "tracked",
  "untracked"
]);

function normalizePullRequestOriginFilter(
  value: string | undefined
): PullRequestBranchOrigin | undefined {
  const trimmed = normalizeQueryParam(value);
  return trimmed !== undefined && KNOWN_PR_ORIGIN_FILTERS.has(trimmed)
    ? (trimmed as PullRequestBranchOrigin)
    : undefined;
}

function normalizePullRequestTrackingFilter(
  value: string | undefined
): "tracked" | "untracked" | undefined {
  const trimmed = normalizeQueryParam(value);
  return trimmed !== undefined && KNOWN_PR_TRACKING_FILTERS.has(trimmed)
    ? (trimmed as "tracked" | "untracked")
    : undefined;
}

function trackedPullRequestKey(projectName: string, prNumber: number): string {
  return `${projectName}#${prNumber}`;
}

// #309: joins the poll snapshot against tracked_pull_requests at read time
// rather than persisting `runId` on the snapshot row — tracking status can
// change (cap reached, cancelled) independently of the next poll tick, and
// this table is already the single source for that join, matching how
// resolveClaimedRunId (above) reads the Run Store fresh for issues rather
// than caching a claimed-run id on the snapshot.
function buildTrackedPullRequestIndex(
  runStore: RunStore
): Map<string, TrackedPullRequest> {
  const index = new Map<string, TrackedPullRequest>();
  for (const tracked of runStore.listOpenTrackedPullRequests()) {
    index.set(
      trackedPullRequestKey(tracked.projectName, tracked.prNumber),
      tracked
    );
  }
  return index;
}

// A snapshot row's `trackingState` is null when Symphonika's Pull Request
// State (src/pull-request-state.ts) couldn't be fetched at poll time (see
// ProjectPullRequestSnapshotRow, src/run-store.ts) — the cheap REST-derived
// `open`/`merged` fields are always populated regardless, so this falls back
// to them rather than showing "unknown" for a PR that plainly is or isn't
// merged.
function pullRequestTrackingStateLabel(
  snapshot: ProjectPullRequestSnapshotRow
): "closed" | "merged" | "open" {
  if (snapshot.trackingState !== null) {
    return snapshot.trackingState;
  }
  if (snapshot.merged) {
    return "merged";
  }
  return snapshot.open ? "open" : "closed";
}

function pullRequestStateFamily(
  trackingState: "closed" | "merged" | "open",
  signals: {
    checks: string | null;
    mergeable: string | null;
    stateAvailable: boolean;
  }
): "ok" | "fail" | "blocked" | "progress" | "neutral" {
  if (trackingState === "merged") {
    return "ok";
  }
  if (trackingState === "closed") {
    return "neutral";
  }
  if (!signals.stateAvailable) {
    return "neutral";
  }
  if (signals.checks === "failure" || signals.mergeable === "conflicting") {
    return "fail";
  }
  if (signals.checks === "pending") {
    return "progress";
  }
  return "ok";
}

function pullRequestOriginLabel(origin: PullRequestBranchOrigin): string {
  switch (origin) {
    case "issue_branch":
      return "Issue Branch";
    case "routine_firing_branch":
      return "Routine Firing branch";
    default:
      return "neither";
  }
}

function pullRequestSignalsText(row: {
  checks: string | null;
  mergeable: string | null;
  reviewDecision: string | null;
  stateAvailable: boolean;
  unresolvedReviewThreads: number | null;
}): string {
  if (!row.stateAvailable) {
    return "state not fetched";
  }
  return [
    row.mergeable ?? "unknown",
    `checks: ${row.checks ?? "unknown"}`,
    `review: ${row.reviewDecision ?? "unknown"}`,
    `${row.unresolvedReviewThreads ?? 0} unresolved`
  ].join(" · ");
}

function searchPullRequestSnapshots(input: {
  filters: PullRequestSearchFilters;
  nowMs: number;
  projectNames: string[];
  runStore: RunStore;
  startedAtMs: number | undefined;
}): PullRequestSearchRow[] {
  const targetProjects =
    input.filters.project === undefined
      ? input.projectNames
      : input.projectNames.filter((name) => name === input.filters.project);
  const q = input.filters.q?.toLowerCase();
  const trackedIndex = buildTrackedPullRequestIndex(input.runStore);
  const rows: PullRequestSearchRow[] = [];
  for (const projectName of targetProjects) {
    for (const snapshot of input.runStore.listProjectPullRequestSnapshots(
      projectName
    )) {
      if (
        input.filters.origin !== undefined &&
        snapshot.branchOrigin !== input.filters.origin
      ) {
        continue;
      }
      if (q !== undefined && !snapshot.title.toLowerCase().includes(q)) {
        continue;
      }
      const tracked = trackedIndex.get(
        trackedPullRequestKey(projectName, snapshot.prNumber)
      );
      if (input.filters.tracking === "tracked" && tracked === undefined) {
        continue;
      }
      if (input.filters.tracking === "untracked" && tracked !== undefined) {
        continue;
      }
      rows.push({
        branchOrigin: snapshot.branchOrigin,
        checks: snapshot.checks,
        draft: snapshot.draft,
        mergeable: snapshot.mergeable,
        polledAt: snapshot.polledAt,
        preRestart: isPreRestartSnapshot(snapshot.polledAt, input.startedAtMs),
        prNumber: snapshot.prNumber,
        projectName,
        reviewDecision: snapshot.reviewDecision,
        stateAvailable: snapshot.stateAvailable,
        title: snapshot.title,
        trackedRunId: tracked?.runId,
        trackingState: pullRequestTrackingStateLabel(snapshot),
        unresolvedReviewThreads: snapshot.unresolvedReviewThreads
      });
    }
  }
  rows.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) || b.prNumber - a.prNumber
  );
  return rows;
}

function renderPullRequestSearchFilters(
  filters: PullRequestSearchFilters,
  projectNames: string[]
): string {
  const projectOptions = projectNames
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${filters.project === name ? " selected" : ""}>${escapeHtml(name)}</option>`
    )
    .join("");
  const originOption = (value: string, label: string) =>
    `<option value="${escapeHtml(value)}"${filters.origin === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const trackingOption = (value: string, label: string) =>
    `<option value="${escapeHtml(value)}"${filters.tracking === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  return `<form class="filters" method="get" action="/prs">
<label>Search<input type="text" name="q" value="${escapeHtml(filters.q ?? "")}" placeholder="PR title"></label>
<label>Project<select name="project"><option value="">All projects</option>${projectOptions}</select></label>
<label>Origin<select name="origin">${originOption("", "Any")}${originOption("issue_branch", "Issue Branch")}${originOption("routine_firing_branch", "Routine Firing branch")}${originOption("neither", "Neither")}</select></label>
<label>Tracking<select name="tracking">${trackingOption("", "Any")}${trackingOption("tracked", "Tracked")}${trackingOption("untracked", "Untracked")}</select></label>
<button class="btn" type="submit">Search</button>
</form>`;
}

function renderPullRequestSearchPage(input: {
  filters: PullRequestSearchFilters;
  nowMs: number;
  projectNames: string[];
  rows: PullRequestSearchRow[];
}): string {
  const filterForm = renderPullRequestSearchFilters(
    input.filters,
    input.projectNames
  );
  const note = `<p class="note">Reads Symphonika's own PR poll snapshot (ADR 0077): open pull requests, at most ~30s stale in steady state, scoped to configured Projects' repos. No live GitHub calls; search is over PR titles only.</p>`;
  if (input.rows.length === 0) {
    return `<h1 class="page-title">Pull requests</h1>${note}${filterForm}<div class="empty"><strong>No matching pull requests</strong>No polled PR matches these filters.</div>`;
  }
  const body = input.rows
    .map((row) => {
      const age = formatAge(row.polledAt, input.nowMs);
      const preRestart = row.preRestart
        ? ' <span class="muted">(pre-restart)</span>'
        : "";
      const prLink = `/prs/${encodeURIComponent(row.projectName)}/${row.prNumber}`;
      const tracked =
        row.trackedRunId === undefined
          ? labelPill("untracked", "blocked")
          : `<a href="/runs/${encodeURIComponent(row.trackedRunId)}">run ${escapeHtml(row.trackedRunId)}</a>`;
      const draftNote = row.draft ? " (draft)" : "";
      const statePill = labelPill(
        `${row.trackingState}${draftNote}`,
        pullRequestStateFamily(row.trackingState, row)
      );
      return `<tr><td>${escapeHtml(row.projectName)}</td><td><a href="${escapeHtml(prLink)}">#${row.prNumber}</a></td><td class="c-title">${escapeHtml(row.title)}</td><td>${statePill}</td><td>${escapeHtml(pullRequestSignalsText(row))}</td><td>${escapeHtml(pullRequestOriginLabel(row.branchOrigin))}</td><td>${tracked}</td><td>${escapeHtml(age)}${preRestart}</td></tr>`;
    })
    .join("");
  const table = tableSection(
    "Pull requests",
    input.rows.length,
    "<tr><th>Project</th><th>#</th><th>Title</th><th>State</th><th>Signals</th><th>Origin</th><th>Tracked</th><th>Polled</th></tr>",
    body
  );
  return `<h1 class="page-title">Pull requests</h1>${note}${filterForm}${table}`;
}

type PullRequestDetail = {
  // The issue this PR was originally discovered from -- used to find
  // whether ANY Run is currently live for that issue, not just the one
  // that originally discovered the PR. See livePullRequestOwnerRunId.
  // Resolved from (in order): the tracked_pull_requests row regardless of
  // its own state (a reopened PR's tracking row can be 'closed' while its
  // parked Run is still live), then falling back to a direct runs-table
  // lookup by branch for a still-running provider whose PR hasn't been
  // tracked yet (listRunsAwaitingPullRequestDiscovery only considers
  // 'succeeded' runs).
  issueNumber: number | undefined;
  // A live Routine Firing owning this PR's branch. Routine Firings are a
  // separate entity from Runs (no issue number), so this is a distinct
  // ownership signal alongside issueNumber/trackedRunId, not a replacement.
  liveRoutineFiringId: string | undefined;
  prNumber: number;
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
  snapshot: ProjectPullRequestSnapshotRow;
  trackedRunId: string | undefined;
  trackingState: "closed" | "merged" | "open";
};

function loadPullRequestDetail(
  runStore: RunStore,
  projectName: string,
  prNumber: number,
  // Two Projects can point at the same GitHub owner/repo; a PR opened
  // against that repo may have been tracked under either alias's name, so
  // the tracked-row lookup below checks every alias, not just projectName.
  // Undefined (not wired) degrades to just projectName, matching
  // pre-existing behavior.
  getProjectRepoAliases?: (projectName: string) => string[]
): PullRequestDetail | undefined {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return undefined;
  }
  const snapshot = runStore
    .listProjectPullRequestSnapshots(projectName)
    .find((row) => row.prNumber === prNumber);
  if (snapshot === undefined) {
    return undefined;
  }
  const aliasNames = getProjectRepoAliases?.(projectName) ?? [projectName];
  let tracked: TrackedPullRequest | undefined;
  for (const aliasName of aliasNames) {
    tracked = runStore.findTrackedPullRequestByProjectAndNumber({
      projectName: aliasName,
      prNumber
    });
    if (tracked !== undefined) {
      break;
    }
  }
  const branchName = snapshot.headRef;
  const untrackedLiveRun =
    tracked === undefined && branchName !== null
      ? runStore.findRunByProjectAndBranch({ branchName, projectName })
      : undefined;
  const liveRoutineFiring =
    snapshot.branchOrigin === "routine_firing_branch" && branchName !== null
      ? runStore.findLiveRoutineFiringByBranch({ branchName, projectName })
      : undefined;
  return {
    issueNumber: tracked?.issueNumber ?? untrackedLiveRun?.issueNumber,
    liveRoutineFiringId: liveRoutineFiring?.firingId,
    prNumber,
    projectName,
    snapshotRepository: runStore.getProjectPullRequestSnapshotRepository(
      projectName,
      prNumber
    ),
    snapshot,
    trackedRunId: tracked?.runId ?? untrackedLiveRun?.runId,
    trackingState: pullRequestTrackingStateLabel(snapshot)
  };
}

function renderPullRequestNotFound(
  projectName: string,
  prNumber: string
): string {
  return layout(
    "Pull request not found",
    `<h1 class="page-title">Pull request not found</h1><p class="lede">No polled snapshot for ${escapeHtml(projectName)}#${escapeHtml(prNumber)} — it may be closed, outside a configured Project's repo, or not yet polled. Search only reads #309's persisted snapshot, never a live GitHub lookup.</p>`
  );
}

// #309 part 2's label-write outcome banner for a PR — structurally identical
// to #308's IssueLabelWriteBanner. Widened into a union with
// PullRequestMergeBanner in part 3, the same point #308 part 3 widened its
// own banner union — only once a second action actually needed it.
type PullRequestLabelWriteBanner = {
  action: "add" | "remove";
  error?: string;
  kind: "label_write";
  label: string;
  ok: boolean;
};

// #309 part 3's guarded-merge outcome banner (AC6-AC9). `freshState` is
// carried through from MergePullRequestResult regardless of `ok` — a
// thrown merge error doesn't prove nothing changed, so both branches show
// whatever the post-attempt re-fetch actually found (AC8).
type PullRequestMergeBanner =
  | { freshState: PullRequestState | undefined; kind: "merge"; ok: true }
  | {
      error: string;
      freshState: PullRequestState | undefined;
      kind: "merge";
      ok: false;
    };

type PullRequestActionBanner =
  PullRequestLabelWriteBanner | PullRequestMergeBanner;

function renderPullRequestLabelWriteBanner(
  banner: PullRequestLabelWriteBanner
): string {
  const verb = banner.action === "add" ? "Add" : "Remove";
  if (!banner.ok) {
    return `<div class="alert" role="alert"><strong>${verb} label "${escapeHtml(banner.label)}" failed</strong>${banner.error === undefined ? "" : `<p>${escapeHtml(banner.error)}</p>`}<p>The labels shown below are unchanged.</p></div>`;
  }
  const past = banner.action === "add" ? "Added" : "Removed";
  return `<div class="alert alert--ok" role="status"><strong>${past} label "${escapeHtml(banner.label)}" on GitHub</strong><p>This page shows the last poll snapshot; the label list below won't reflect this until the next poll.</p></div>`;
}

// Renders the freshly re-derived Pull Request State a merge attempt
// produced (AC8) — never the persisted, possibly-stale snapshot. Absent
// `freshState` means the re-fetch itself failed or is unsupported, said
// plainly rather than silently falling back to stale data.
function renderPullRequestFreshStateNote(
  freshState: PullRequestState | undefined
): string {
  if (freshState === undefined) {
    return `<p class="note">Current state could not be re-derived after this attempt.</p>`;
  }
  return `<p class="note">Re-derived current state: <strong>${escapeHtml(freshState.trackingState)}</strong> · mergeable: ${escapeHtml(freshState.mergeable)} · checks: ${escapeHtml(freshState.checks)} · review: ${escapeHtml(freshState.reviewDecision)} · ${freshState.unresolvedReviewThreads} unresolved.</p>`;
}

function renderPullRequestMergeBanner(banner: PullRequestMergeBanner): string {
  if (!banner.ok) {
    return `<div class="alert" role="alert"><strong>Merge failed</strong><p>${escapeHtml(banner.error)}</p>${renderPullRequestFreshStateNote(banner.freshState)}</div>`;
  }
  return `<div class="alert alert--ok" role="status"><strong>Merge attempted on GitHub</strong>${renderPullRequestFreshStateNote(banner.freshState)}</div>`;
}

function renderPullRequestActionBanner(
  banner: PullRequestActionBanner
): string {
  return banner.kind === "label_write"
    ? renderPullRequestLabelWriteBanner(banner)
    : renderPullRequestMergeBanner(banner);
}

function renderPullRequestMergeSection(input: {
  csrfToken: string;
  headSha: string | null;
  liveOwnerRunId: string | undefined;
  prNumber: number;
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
}): string {
  if (input.liveOwnerRunId !== undefined) {
    return `<section><h2>Merge</h2><p class="note">${labelPill(`owned by ${input.liveOwnerRunId}`, "progress")} Cannot be merged until that Run is cancelled.</p></section>`;
  }
  const action = `/prs/${encodeURIComponent(input.projectName)}/${input.prNumber}/merge`;
  // Pins the SHA to what this page actually shows, not whatever the DB
  // holds when the merge POST lands -- a poll landing in between would
  // otherwise let the safety check validate a commit the operator never
  // saw. See handlePullRequestMerge, which reads this submitted value
  // rather than re-querying the snapshot.
  const headShaField =
    input.headSha === null
      ? ""
      : `<input type="hidden" name="expected_head_sha" value="${escapeHtml(input.headSha)}">`;
  const repositoryFields = renderSnapshotRepositoryFields(
    input.snapshotRepository
  );
  return `<section><h2>Merge</h2><p class="note">No live Run owns this PR — merge is available.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">${repositoryFields}${headShaField}<button class="btn" type="submit">Merge</button></form></section>`;
}

function renderPullRequestLabelsSection(input: {
  csrfToken: string;
  labels: string[];
  prNumber: number;
  projectName: string;
  snapshotRepository: ProjectSnapshotRepository | undefined;
}): string {
  const repositoryFields = renderSnapshotRepositoryFields(
    input.snapshotRepository
  );
  const rows = input.labels.map((label) => {
    if (isOrchestratorLabel(label)) {
      return `<li>${labelPill(label, "neutral")} <span class="muted">managed by Symphonika — not editable here</span></li>`;
    }
    const removeAction = `/prs/${encodeURIComponent(input.projectName)}/${input.prNumber}/labels/remove`;
    return `<li>${labelPill(label, "neutral")} <form method="post" action="${escapeHtml(removeAction)}"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">${repositoryFields}<input type="hidden" name="label" value="${escapeHtml(label)}"><button class="btn" type="submit">Remove</button></form></li>`;
  });
  const list =
    rows.length === 0
      ? `<p class="muted">No labels.</p>`
      : `<ul class="label-list">${rows.join("")}</ul>`;
  const addAction = `/prs/${encodeURIComponent(input.projectName)}/${input.prNumber}/labels/add`;
  const addForm = `<form method="post" action="${escapeHtml(addAction)}"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">${repositoryFields}<label>Add a label<input type="text" name="label" placeholder="agent-ready" required></label> <button class="btn" type="submit">Add</button></form>`;
  return `<section><h2>Labels</h2><p class="note">Labels are written under the same policy as issues (#308) — <code>sym:*</code> labels are how Symphonika tracks state (ADR 0002/0024) and render here as read-only.</p>${list}${addForm}</section>`;
}

function renderPullRequestDetailPage(input: {
  banner: PullRequestActionBanner | undefined;
  csrfToken: string;
  detail: PullRequestDetail;
  liveOwnerRunId: string | undefined;
  pollNowAvailable: boolean;
}): string {
  const { detail } = input;
  const { snapshot } = detail;
  const draftNote = snapshot.draft ? " (draft)" : "";
  const family = pullRequestStateFamily(detail.trackingState, snapshot);
  const trackedHtml =
    detail.trackedRunId === undefined
      ? `${labelPill("untracked", "blocked")} <span class="muted">Not tracked by PR Follow-up — review re-dispatch and auto-merge never act on this PR.</span>`
      : `Tracked by PR Follow-up, owned by <a href="/runs/${encodeURIComponent(detail.trackedRunId)}">run ${escapeHtml(detail.trackedRunId)}</a>`;
  const urlHtml =
    snapshot.url === null
      ? ""
      : `<p class="note"><a href="${escapeHtml(snapshot.url)}">${escapeHtml(snapshot.url)}</a></p>`;
  const branchHtml =
    snapshot.headRef === null
      ? ""
      : `<p class="note">Branch <code>${escapeHtml(snapshot.headRef)}</code> — ${escapeHtml(pullRequestOriginLabel(snapshot.branchOrigin))}</p>`;
  const signals = snapshot.stateAvailable
    ? `<dl class="fields"><dt>Mergeable</dt><dd>${escapeHtml(snapshot.mergeable ?? "unknown")}</dd><dt>Checks</dt><dd>${escapeHtml(snapshot.checks ?? "unknown")}</dd><dt>Review</dt><dd>${escapeHtml(snapshot.reviewDecision ?? "unknown")}</dd><dt>Unresolved threads</dt><dd>${snapshot.unresolvedReviewThreads ?? 0}</dd></dl>`
    : `<p class="note">Symphonika's Pull Request State could not be fetched for this PR at the last poll — mergeable/checks/review are unknown for this reason, not because GitHub reported no issues.</p>`;
  const bannerHtml =
    input.banner === undefined
      ? ""
      : `${renderPullRequestActionBanner(input.banner)}${input.banner.ok && input.pollNowAvailable ? renderPollNowForm(input.csrfToken, "/prs") : ""}`;
  const justMerged =
    input.banner?.kind === "merge" && input.banner.freshState?.merged === true;
  const mergeSectionHtml = justMerged
    ? ""
    : renderPullRequestMergeSection({
        csrfToken: input.csrfToken,
        headSha: snapshot.headSha,
        liveOwnerRunId: input.liveOwnerRunId,
        prNumber: detail.prNumber,
        projectName: detail.projectName,
        snapshotRepository: detail.snapshotRepository
      });
  return `<h1 class="page-title">PR #${detail.prNumber} ${escapeHtml(snapshot.title)}</h1><p class="note">${escapeHtml(detail.projectName)} · ${labelPill(`${detail.trackingState}${draftNote}`, family)}</p>${urlHtml}${branchHtml}${bannerHtml}<section><h2>Pull Request State</h2>${signals}</section><section><h2>Follow-up tracking</h2><p class="note">${trackedHtml}</p></section>${renderPullRequestLabelsSection({ csrfToken: input.csrfToken, labels: snapshot.labels, prNumber: detail.prNumber, projectName: detail.projectName, snapshotRepository: detail.snapshotRepository })}${mergeSectionHtml}<p class="note"><a href="/prs">← Back to search</a></p>`;
}

// A Routine name is globally unique across the *current* declared config
// (ADR 0069), but removed target rows are soft-disabled, never deleted, and
// still pass listRoutines()'s default `state != 'inactive'` filter. Source
// path is stable per declaration and shared by every target one `routines:`
// entry materializes, so grouping on (name, sourcePath) keeps distinct
// declarations apart while still collapsing an N-target Routine into one
// row. Grouping itself keeps every row it is handed; excluding removed
// targets is each caller's own decision. Full per-target detail
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
function renderRoutineSchedule(schedule: {
  scheduleAt: string | null;
  scheduleCron: string | null;
  scheduleTz: string | null;
}): string {
  if (schedule.scheduleCron !== null) {
    return escapeHtml(
      `${schedule.scheduleCron} (${schedule.scheduleTz ?? "UTC"})`
    );
  }
  return renderTimestamp(schedule.scheduleAt);
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
    return `<code>${renderTimestamp(nextFireAt)}</code>${partial}`;
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

function renderRoutinesSection(
  groups: RoutineGroup[],
  includeInactive: boolean
): string {
  if (groups.length === 0) {
    return `<section>${sectionHead("Routines", 0)}<div class="empty"><strong>No Routines configured</strong>A Routine is a scheduled prompt that can launch a Coding Agent against one or more Projects without a GitHub Issue. Declare one in the service config's top-level <code>routines:</code> block to see it here.</div></section>`;
  }
  const rows = groups
    .map((group) => {
      const href = `/routines/${encodeURIComponent(group.name)}${routineQuerySuffix(undefined, includeInactive)}`;
      const routineLink = `<a href="${href}">${escapeHtml(group.name)}</a>`;
      const targetsLink = `<a href="${href}">${group.targets.length}</a>`;
      return `<tr><td>${routineLink}</td><td>${escapeHtml(group.kind)}</td><td class="c-detail"><code>${renderRoutineSchedule(group)}</code></td><td>${targetsLink}</td><td>${renderRoutineGroupStatus(group)}</td></tr>`;
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
  groups: RoutineGroup[],
  includeInactive: boolean
): string {
  const items = groups
    .map((group) => {
      const [representative] = group.targets;
      const sourcePath =
        representative === undefined ? "-" : representative.sourcePath;
      const targetLinks = group.targets
        .map((target) => {
          const suffix = routineQuerySuffix(
            target.projectName,
            includeInactive
          );
          return `<a href="${escapeHtml(`/routines/${encodeURIComponent(name)}${suffix}`)}">${escapeHtml(target.projectName)}</a>`;
        })
        .join(", ");
      return `<li><code>${escapeHtml(sourcePath)}</code> — targets: ${targetLinks}</li>`;
    })
    .join("");
  return `<h1 class="page-title">${escapeHtml(name)}</h1><section><div class="empty"><strong>Multiple declarations share this name</strong>An earlier declaration was likely removed from config and a later one reused the name for a different target. Pick a target Project to disambiguate:<ul>${items}</ul></div></section>`;
}

// Shared by /routines/:name and #307's editor routes (GET .../edit,
// POST .../edit/preview, POST .../edit/confirm) so the same name+project
// disambiguation rules apply everywhere a routine is looked up by name —
// previously duplicated inline in /routines/:name alone.
function resolveNamedRoutineGroup(
  runStore: RunStore,
  name: string,
  projectParam: string | undefined,
  includeInactive: boolean
):
  | { kind: "not_found" }
  | { groups: RoutineGroup[]; kind: "ambiguous" }
  | { group: RoutineGroup; kind: "ok" } {
  const groups = groupRoutinesByName(
    runStore.listRoutines({ includeInactive })
  ).filter((group) => group.name === name);

  if (groups.length === 0) {
    return { kind: "not_found" };
  }
  if (projectParam !== undefined) {
    const group = groups.find((candidate) =>
      candidate.targets.some(
        (target: RoutineStatus) => target.projectName === projectParam
      )
    );
    return group === undefined ? { kind: "not_found" } : { group, kind: "ok" };
  }
  if (groups.length === 1) {
    return { group: groups[0]!, kind: "ok" };
  }
  return { groups, kind: "ambiguous" };
}

function routineSelectionRequiresInactive(
  group: RoutineGroup,
  projectParam: string | undefined
): boolean {
  const selectedTargets =
    projectParam === undefined
      ? group.targets
      : group.targets.filter((target) => target.projectName === projectParam);
  return (
    selectedTargets.length > 0 &&
    selectedTargets.every((target) => target.state === "inactive")
  );
}

function includeInactiveRoutineTargets(
  runStore: RunStore,
  selectedGroup: RoutineGroup
): RoutineGroup {
  const sourcePath = selectedGroup.targets[0]?.sourcePath;
  if (sourcePath === undefined) {
    return selectedGroup;
  }
  return (
    groupRoutinesByName(runStore.listRoutines({ includeInactive: true })).find(
      (candidate) =>
        candidate.name === selectedGroup.name &&
        candidate.targets[0]?.sourcePath === sourcePath
    ) ?? selectedGroup
  );
}

// Shared by #307's editor routes for the two ways resolveNamedRoutineGroup
// can fail to produce a single group to edit -- ambiguous renders the same
// disambiguation page /routines/:name itself uses (pick a target Project),
// rather than the misleading "not found" a bare 404 would show for a
// routine that does exist, just not uniquely by name alone.
function renderUneditableRoutine(
  name: string,
  resolved:
    { kind: "not_found" } | { groups: RoutineGroup[]; kind: "ambiguous" }
): string {
  if (resolved.kind === "ambiguous") {
    return layout(
      name,
      renderRoutineDisambiguation(name, resolved.groups, true)
    );
  }
  return layout(
    "Routine not found",
    `<h1 class="page-title">Routine not found</h1><p class="lede">Routine <code>${escapeHtml(name)}</code> was not found.</p>`
  );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Hono's parseBody() types a form-encoded field as string | File |
// (string | File)[] | BodyDataValueDotAll -- these two narrow that down to
// the plain string a hidden/textarea field always is here, refusing a
// missing or wrong-shaped field rather than silently coercing it.
function readOptionalFormField(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function readSnapshotRepository(
  body: Record<string, unknown>
): ProjectSnapshotRepository | undefined {
  const owner = readOptionalFormField(body, "snapshot_owner")?.trim();
  const repo = readOptionalFormField(body, "snapshot_repo")?.trim();
  return owner === undefined ||
    owner.length === 0 ||
    repo === undefined ||
    repo.length === 0
    ? undefined
    : { owner, repo };
}

function renderSnapshotRepositoryFields(
  repository: ProjectSnapshotRepository | undefined
): string {
  return repository === undefined
    ? ""
    : `<input type="hidden" name="snapshot_owner" value="${escapeHtml(repository.owner)}"><input type="hidden" name="snapshot_repo" value="${escapeHtml(repository.repo)}">`;
}

function readRequiredFormField(
  body: Record<string, unknown>,
  key: string
): string {
  const value = readOptionalFormField(body, key);
  if (value === undefined) {
    throw new Error(`missing required form field "${key}"`);
  }
  return value;
}

// Shared by the routine editor's preview/confirm routes and the
// disable/enable toggle preview: refuses a save when the routine name now
// resolves to a different declaration file than the one the form was
// opened for (e.g. the on-disk declaration was replaced between GET and
// POST), rather than silently writing to whatever it resolves to now.
function checkStaleRoutineDeclaration(
  context: Context,
  input: {
    declaration: RoutineDeclarationView;
    editAction: string;
    expectedSourcePath: string | undefined;
    name: string;
  }
): Response | undefined {
  if (
    input.expectedSourcePath === undefined ||
    input.declaration.sourcePath === input.expectedSourcePath
  ) {
    return undefined;
  }
  return context.html(
    layout(
      "Save refused: Routine declaration changed",
      renderRoutineDeclarationChangedNotice({
        actualSourcePath: input.declaration.sourcePath,
        editAction: input.editAction,
        expectedSourcePath: input.expectedSourcePath,
        name: input.name
      })
    ),
    409
  );
}

function routineQuerySuffix(
  projectParam: string | undefined,
  includeInactive: boolean
): string {
  const params = new URLSearchParams();
  if (projectParam !== undefined) {
    params.set("project", projectParam);
  }
  if (includeInactive) {
    params.set("include_inactive", "true");
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

// Shared by every #307 editor (routine declaration, workflow contract,
// service config): the raw-text-with-hidden-hash form each GET .../edit
// route renders. blastRadiusHtml is caller-rendered rather than a fixed
// shape here, since what a save affects differs per artifact (#307's issue
// text: Routine Targets + next fire times; a Project's next dispatch;
// the whole daemon) -- forcing one shared shape onto three different
// disclosures would be the wrong abstraction.
function renderEditorForm(input: {
  action: string;
  blastRadiusHtml: string;
  content: string;
  contentHash: string;
  csrfToken: string;
  expectedSourcePath?: string;
  includeInactive?: boolean;
  name: string;
  projectParam: string | undefined;
}): string {
  return `<h1 class="page-title">Edit ${escapeHtml(input.name)}</h1><p class="note">Raw text editing — this is the exact content written to disk; comments and key ordering elsewhere in the file are untouched by a save. Saving takes you to a diff review before anything is written.</p>${input.blastRadiusHtml}${renderContentTextareaForm(input)}`;
}

// The raw-text-with-hidden-hash form body shared by renderEditorForm's fresh
// edit and renderEditorPreview's invalid-resubmit branch -- kept as one
// function so the two forms can't silently drift apart (missing hidden
// field, changed textarea attrs) as they're extended.
function renderContentTextareaForm(input: {
  action: string;
  content: string;
  contentHash: string;
  csrfToken: string;
  expectedSourcePath?: string;
  includeInactive?: boolean;
  projectParam: string | undefined;
}): string {
  return `<form method="post" action="${escapeHtml(input.action)}">
  <input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">
  <input type="hidden" name="expected_content_hash" value="${escapeHtml(input.contentHash)}">
  ${input.expectedSourcePath === undefined ? "" : `<input type="hidden" name="expected_source_path" value="${escapeHtml(input.expectedSourcePath)}">`}
  ${input.projectParam === undefined ? "" : `<input type="hidden" name="project_param" value="${escapeHtml(input.projectParam)}">`}
  ${input.includeInactive === true ? '<input type="hidden" name="include_inactive" value="true">' : ""}
  <p><textarea name="content" rows="24" cols="100" class="editor">${escapeHtml(input.content)}</textarea></p>
  <button class="btn" type="submit">Review changes</button>
</form>`;
}

// #307 AC: "Routine declaration → which Routine Targets, and their next
// fire times." Targets share the same declaration (ADR 0069's fan-out), so
// every one of them is affected by a save to this file -- listed
// individually because "every target" without the list is exactly the
// vague disclosure the AC asks editors not to give.
function renderRoutineEditBlastRadius(targets: RoutineStatus[]): string {
  const items = targets
    .map(
      (target) =>
        `<li>${escapeHtml(target.projectName)} — next fire: <code>${renderTimestamp(target.nextFireAt, "—")}</code></li>`
    )
    .join("");
  return `<div class="empty"><strong>This save affects</strong>Every target below picks up the edited schedule and prompt on the next dispatch tick.<ul>${items}</ul></div>`;
}

// #307 AC: "Workflow contract -> which Project's next dispatch. In-flight
// Runs are immune (ADR 0045 persists the expanded graph per Run) -- say so
// in the UI, because operators will reasonably assume otherwise." Stated
// explicitly rather than left implicit precisely because it's the
// surprising direction (an operator watching a Run in progress would
// reasonably expect an urgent contract fix to apply to it).
function renderWorkflowEditBlastRadius(projectName: string): string {
  return `<div class="empty"><strong>This save affects</strong>Project <code>${escapeHtml(projectName)}</code>'s <em>next</em> dispatch. Any Run currently in progress keeps the workflow graph it started with (ADR 0045) and is unaffected by this edit.</div>`;
}

// #307 AC: "Service config -> the whole daemon: projects, caps, provider
// argv." Stated once, unconditionally -- unlike the routine/workflow
// disclosures, a symphonika.yml save can touch anything, so there's no
// narrower "affected set" to enumerate.
function renderServiceConfigBlastRadius(): string {
  return `<div class="empty"><strong>This save affects</strong>The whole daemon on its next reload: every Project's caps and eligibility, every Routine's declared targets, and (see below) which process each provider spawns.</div>`;
}

// #307 AC: "Editing providers.*.command requires an explicit confirmation
// step distinct from an ordinary save." providers.codex/claude/omp are the
// only three provider names the schema allows (src/reload.ts's
// serviceConfigSchema) -- compared directly rather than diffing an
// arbitrary map. A parse failure on either side returns undefined for that
// side's command, which reads as "unchanged" here; that's fine because a
// YAML syntax error is already caught and blocks the save entirely before
// this ever gets called with the invalid content standing for real.
function providerCommandsDiffer(before: string, after: string): boolean {
  const providerNames = ["claude", "codex", "omp"] as const;
  return providerNames.some(
    (name) =>
      extractProviderCommand(before, name) !==
      extractProviderCommand(after, name)
  );
}

function extractProviderCommand(
  content: string,
  providerName: string
): string | undefined {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.providers)) {
    return undefined;
  }
  const provider = parsed.providers[providerName];
  if (!isPlainRecord(provider) || typeof provider.command !== "string") {
    return undefined;
  }
  return provider.command;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderProviderCommandConfirmation(): string {
  return `<div class="alert" role="alert"><strong>This save changes a provider command</strong>Editing <code>providers.*.command</code> changes what process the daemon spawns for that provider — check the box to confirm you intend this.<label><input type="checkbox" name="confirm_provider_command_change" required> I understand this changes what process the daemon spawns</label></div>`;
}

function renderEditorPreview(input: {
  confirmAction: string;
  content: string;
  csrfToken: string;
  errors: string[];
  expectedContentHash: string;
  expectedSourcePath?: string;
  // #307 AC: "Editing providers.*.command requires an explicit confirmation
  // distinct from an ordinary save." Rendered between the diff and the
  // Confirm save button (not folded into it) so it reads as a distinct
  // step, not decoration on the normal one. Only the service-config editor
  // ever sets this.
  extraConfirmationHtml?: string;
  includeInactive?: boolean;
  name: string;
  onDisk: string | null;
  previewAction: string;
  projectParam: string | undefined;
  reviewAction: string;
}): string {
  const navigationSuffix = routineQuerySuffix(
    input.projectParam,
    input.includeInactive === true
  );
  if (input.errors.length > 0) {
    return `<h1 class="page-title">Changes to ${escapeHtml(input.name)} are invalid</h1><div class="alert" role="alert"><strong>Fix these before saving</strong><ul>${input.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>${renderContentTextareaForm(
      {
        action: input.previewAction,
        content: input.content,
        contentHash: input.expectedContentHash,
        csrfToken: input.csrfToken,
        ...(input.expectedSourcePath === undefined
          ? {}
          : { expectedSourcePath: input.expectedSourcePath }),
        includeInactive: input.includeInactive === true,
        projectParam: input.projectParam
      }
    )}<p class="note"><a href="${escapeHtml(`${input.reviewAction}${navigationSuffix}`)}">← Discard draft and reopen from disk</a></p>`;
  }
  const diffHtml =
    input.onDisk === null
      ? '<div class="empty"><strong>No on-disk content to diff against</strong>The file did not exist or could not be read.</div>'
      : renderLineDiff(input.onDisk, input.content);
  return `<h1 class="page-title">Confirm changes to ${escapeHtml(input.name)}</h1><p class="note">This is what will be written. Nothing is saved until you confirm.</p>${diffHtml}<form method="post" action="${escapeHtml(input.confirmAction)}">
  <input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(input.csrfToken)}">
  <input type="hidden" name="expected_content_hash" value="${escapeHtml(input.expectedContentHash)}">
  ${input.expectedSourcePath === undefined ? "" : `<input type="hidden" name="expected_source_path" value="${escapeHtml(input.expectedSourcePath)}">`}
  <input type="hidden" name="content" value="${escapeHtml(input.content)}">
  ${input.projectParam === undefined ? "" : `<input type="hidden" name="project_param" value="${escapeHtml(input.projectParam)}">`}
  ${input.includeInactive === true ? '<input type="hidden" name="include_inactive" value="true">' : ""}
  ${input.extraConfirmationHtml ?? ""}
  <button class="btn" type="submit">Confirm save</button>
</form><p class="note"><a href="${escapeHtml(`${input.reviewAction}${navigationSuffix}`)}">← Back to editor</a></p>`;
}

function renderStaleSaveNotice(input: {
  currentContent: string | null;
  editAction: string;
  filePath: string;
}): string {
  const body =
    input.currentContent === null
      ? "<p>The file was deleted since you opened the editor.</p>"
      : `<pre class="diff">${escapeHtml(input.currentContent)}</pre>`;
  return `<h1 class="page-title">Save refused: changed on disk</h1><div class="alert" role="alert"><strong>${escapeHtml(input.filePath)} was changed since you opened the editor</strong>Your edit was not written. Reopen the editor to start from the current content.</div>${body}<p class="note"><a href="${escapeHtml(input.editAction)}">← Reopen editor</a></p>`;
}

function renderRoutineDeclarationChangedNotice(input: {
  actualSourcePath: string;
  editAction: string;
  expectedSourcePath: string;
  name: string;
}): string {
  return `<h1 class="page-title">Save refused: Routine declaration changed</h1><div class="alert" role="alert"><strong>${escapeHtml(input.name)} now resolves to a different declaration</strong>The editor was opened for <code>${escapeHtml(input.expectedSourcePath)}</code>, but this request resolves to <code>${escapeHtml(input.actualSourcePath)}</code>. Nothing was written.</div><p class="note"><a href="${escapeHtml(input.editAction)}">← Reopen editor</a></p>`;
}

function renderReloadFailedNotice(input: {
  editAction: string;
  errors: string[];
  filePath: string;
}): string {
  return `<h1 class="page-title">Saved, but not active</h1><div class="alert" role="alert"><strong>${escapeHtml(input.filePath)} was written to disk, but reload failed</strong><ul>${input.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div><p class="note">The previous, last-known-good configuration is still what's running. Fix the issue above and save again.</p><p class="note"><a href="${escapeHtml(input.editAction)}">← Back to editor</a></p>`;
}

// A small line-based LCS diff -- not a general utility, just enough to
// render the "diff before every write" requirement (#307) for the three
// editors' confirmation screens. Keep the exact table bounded because an
// editor can submit arbitrarily large content (#442); a coarse, linear-space
// fallback still shows every line when the exact table would be too large.
const MAX_LCS_TABLE_CELLS = 1_000_000;

function renderLineDiff(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const diff = diffLines(beforeLines, afterLines);
  const rows: string[] = [];
  for (const op of diff.ops) {
    const cssClass =
      op.kind === "added" ? "add" : op.kind === "removed" ? "del" : "ctx";
    const marker =
      op.kind === "added" ? "+" : op.kind === "removed" ? "-" : " ";
    rows.push(
      `<span class="diff-line diff-${cssClass}">${marker} ${escapeHtml(op.line)}</span>`
    );
  }
  const notice = diff.simplified
    ? '<div class="empty"><strong>Large diff simplified</strong>The exact line comparison exceeded its safe size limit. This preview still shows the complete content, but unchanged lines inside the changed region may appear as removed and added.</div>'
    : "";
  return `${notice}<pre class="diff">${rows.join("\n")}</pre>`;
}

type DiffOp = { kind: "added" | "removed" | "unchanged"; line: string };
type DiffResult = { ops: DiffOp[]; simplified: boolean };

function diffLines(before: string[], after: string[]): DiffResult {
  const tableRows = before.length + 1;
  const tableColumns = after.length + 1;
  if (tableRows > Math.floor(MAX_LCS_TABLE_CELLS / tableColumns)) {
    return { ops: diffLinesByEdges(before, after), simplified: true };
  }

  const lcs: number[][] = Array.from({ length: tableRows }, () =>
    new Array<number>(tableColumns).fill(0)
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: "unchanged", line: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "removed", line: before[i]! });
      i++;
    } else {
      ops.push({ kind: "added", line: after[j]! });
      j++;
    }
  }
  while (i < before.length) {
    ops.push({ kind: "removed", line: before[i]! });
    i++;
  }
  while (j < after.length) {
    ops.push({ kind: "added", line: after[j]! });
    j++;
  }
  return { ops, simplified: false };
}

function diffLinesByEdges(before: string[], after: string[]): DiffOp[] {
  let prefixLength = 0;
  while (
    prefixLength < before.length &&
    prefixLength < after.length &&
    before[prefixLength] === after[prefixLength]
  ) {
    prefixLength++;
  }

  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    before[before.length - suffixLength - 1] ===
      after[after.length - suffixLength - 1]
  ) {
    suffixLength++;
  }

  const beforeChangedEnd = before.length - suffixLength;
  const afterChangedEnd = after.length - suffixLength;

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefixLength; i++) {
    ops.push({ kind: "unchanged", line: before[i]! });
  }
  for (let i = prefixLength; i < beforeChangedEnd; i++) {
    ops.push({ kind: "removed", line: before[i]! });
  }
  for (let i = prefixLength; i < afterChangedEnd; i++) {
    ops.push({ kind: "added", line: after[i]! });
  }
  for (let i = beforeChangedEnd; i < before.length; i++) {
    ops.push({ kind: "unchanged", line: before[i]! });
  }
  return ops;
}

function renderRoutineDeclarationCard(
  declaration: RoutineDeclarationView,
  reloadErrors: string[]
): string {
  const errorBanner =
    reloadErrors.length === 0
      ? ""
      : `<div class="alert" role="alert"><strong>Reload error</strong><ul>${reloadErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`;
  const promptSection =
    declaration.prompt === null
      ? `<div class="empty"><strong>Prompt unavailable</strong>${declaration.invalid ? "This declaration failed to reload." : "Every target for this declaration is inactive — the prompt body is not retained once a declaration has no live target."}</div>`
      : `<div class="msg">${escapeHtml(declaration.prompt)}</div>`;
  return `${errorBanner}<section><dl class="fields">
  <dt>Kind</dt><dd>${escapeHtml(declaration.kind)}</dd>
  <dt>Provider</dt><dd>${declaration.provider === null ? '<span class="muted">inherited</span>' : escapeHtml(declaration.provider)}</dd>
  <dt>Schedule</dt><dd><code>${renderRoutineSchedule(declaration)}</code></dd>
  <dt>Allow overlap</dt><dd>${declaration.allowOverlap ? "yes" : "no"}</dd>
  <dt>Catch up</dt><dd>${escapeHtml(declaration.catchUp)}</dd>
  <dt>Source</dt><dd><code>${escapeHtml(declaration.sourcePath)}</code></dd>
</dl></section><section>${sectionHead("Prompt")}${promptSection}</section>`;
}

function isCurrentRoutineTarget(target: RoutineStatus): boolean {
  return target.disabledReason !== "removed_from_config";
}

// A target removed from its declaration can remain as a durable
// removed_from_config row beside current siblings (ADR 0069), so it must
// not represent the declaration's lifecycle state -- unlike
// resolveRoutineDeclaration, which picks a target to carry the
// declaration's *content* and so orders by validity instead.
function currentRoutineTargets(group: RoutineGroup): RoutineStatus[] {
  return group.targets.filter(isCurrentRoutineTarget);
}

// #307 AC: "Disable/enable a Routine from its page affects every target; a
// live firing is unaffected until it terminates (ADR 0060)." An inactive
// Project target clears its disabledReason, so an operator-disabled
// current target takes precedence over other current targets. When every
// current target is inactive, this recovers that state from valid front
// matter instead.
async function readRoutineDisabledFallback(
  currentTargets: RoutineStatus[],
  sourcePath: string
): Promise<boolean | undefined> {
  if (
    currentTargets.length === 0 ||
    currentTargets.some(
      (target) =>
        target.disabledReason === "operator" || target.state !== "inactive"
    )
  ) {
    return undefined;
  }
  const declaration = await loadRoutineDeclaration(sourcePath);
  return declaration.routine?.disabled;
}

function renderRoutineLifecycleControls(
  name: string,
  currentTargets: RoutineStatus[],
  projectParam: string | undefined,
  includeInactive: boolean,
  csrfToken: string,
  expectedSourcePath: string,
  declarationDisabled: boolean | undefined
): string {
  if (currentTargets.length === 0) {
    return "";
  }
  const operatorDisabled =
    declarationDisabled === true ||
    currentTargets.some((target) => target.disabledReason === "operator");
  const projectField =
    projectParam === undefined
      ? ""
      : `<input type="hidden" name="project_param" value="${escapeHtml(projectParam)}">`;
  const includeInactiveField = includeInactive
    ? '<input type="hidden" name="include_inactive" value="true">'
    : "";
  const expectedSourcePathField = `<input type="hidden" name="expected_source_path" value="${escapeHtml(expectedSourcePath)}">`;
  const csrfField = `<input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(csrfToken)}">`;
  if (operatorDisabled) {
    return `<section><form method="post" action="/routines/${encodeURIComponent(name)}/enable">${csrfField}${projectField}${includeInactiveField}${expectedSourcePathField}<button class="btn" type="submit">Enable routine</button></form><p class="note">A live firing in progress is unaffected until it terminates (ADR 0060).</p></section>`;
  }
  return `<section><form method="post" action="/routines/${encodeURIComponent(name)}/disable">${csrfField}${projectField}${includeInactiveField}${expectedSourcePathField}<button class="btn" type="submit">Disable routine</button></form><p class="note">A live firing in progress is unaffected until it terminates (ADR 0060).</p></section>`;
}

// #469: fire-now posts straight at /api/routines/:id/fire (ADR 0075),
// mirroring /api/runs/:id/cancel's form/JSON duality rather than
// disable/enable's diff-preview route -- firing isn't a declaration edit,
// so there's no diff to confirm. One button per target, since
// fireRoutineNow requires an unambiguous (routineName, projectName) pair
// once a Routine fans out to more than one Project (ADR 0069).
function renderRoutineFireControls(
  name: string,
  currentTargets: RoutineStatus[],
  projectParam: string | undefined,
  includeInactive: boolean,
  csrfToken: string
): string {
  if (currentTargets.length === 0) {
    return "";
  }
  const projectField =
    projectParam === undefined
      ? ""
      : `<input type="hidden" name="project_param" value="${escapeHtml(projectParam)}">`;
  const csrfField = `<input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(csrfToken)}">`;
  const buttons = currentTargets
    .map((target) => {
      const label =
        currentTargets.length > 1
          ? `Fire now — ${escapeHtml(target.projectName)}`
          : "Fire now";
      const suffix = routineQuerySuffix(target.projectName, includeInactive);
      return `<form method="post" action="${escapeHtml(`/api/routines/${encodeURIComponent(name)}/fire${suffix}`)}">${csrfField}${projectField}<button class="btn" type="submit">${label}</button></form>`;
    })
    .join("");
  return `<section>${buttons}<p class="note">Fires target the routine's last reloaded declaration, not any pending edit (#364).</p></section>`;
}

const FIRE_REFUSAL_REASON_TEXT: Readonly<Record<string, string>> = {
  concurrency_cap: "the concurrency cap for this Project is currently reached",
  daemon_shutdown: "the daemon is shutting down",
  host_pressure: "the host is stalled on memory or I/O",
  disabled: "the routine is disabled",
  expired: "the routine's schedule has expired",
  inactive: "the target Project is inactive",
  invalid: "the routine declaration is invalid",
  overlap: "a firing for this Routine/Project is already in progress",
  self_update_draining:
    "a self-update is draining in-flight work before cutover"
};

// #469 AC: refused (with reason), ambiguous, and not_found/unavailable
// must render as legible page state, not a raw JSON error -- the fire
// route redirects here with the outcome flattened into query params
// (POST has no response body of its own to render). Whitelisted against
// known literals rather than reflected verbatim, since these are
// attacker-reachable query params on an otherwise-unauthenticated GET.
function renderFireResultNotice(context: Context): string {
  const kind = context.req.query("fire");
  if (kind === undefined) {
    return "";
  }
  const projectName = context.req.query("fire_project");
  const projectSuffix =
    projectName === undefined ? "" : ` for Project ${escapeHtml(projectName)}`;
  switch (kind) {
    case "accepted":
      return `<div class="alert alert--ok" role="status"><strong>Fire accepted</strong><p>Firing queued${projectSuffix}.</p></div>`;
    case "refused": {
      const reason = context.req.query("fire_reason");
      const reasonText =
        reason !== undefined && Object.hasOwn(FIRE_REFUSAL_REASON_TEXT, reason)
          ? FIRE_REFUSAL_REASON_TEXT[reason]
          : "the routine is not currently eligible to fire";
      return `<div class="alert" role="alert"><strong>Fire refused</strong><p>Refused${projectSuffix}: ${escapeHtml(reasonText ?? "")}.</p></div>`;
    }
    case "not_found":
      return `<div class="alert" role="alert"><strong>Fire target not found</strong><p>No matching Routine target${projectSuffix}.</p></div>`;
    case "ambiguous":
      return `<div class="alert" role="alert"><strong>Fire request was ambiguous</strong><p>Specify a Project to disambiguate.</p></div>`;
    case "unavailable":
      return `<div class="alert" role="alert"><strong>Manual firing unavailable</strong><p>The daemon does not support manual firing right now.</p></div>`;
    default:
      return "";
  }
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
          : `${escapeHtml(target.lastSkipReason)} <code>${renderTimestamp(target.lastSkipAt)}</code>`;
      const counts = `overlap ${target.skipCounts24h.overlap} · cap ${target.skipCounts24h.concurrency_cap} · pressure ${target.skipCounts24h.host_pressure} · catch-up ${target.skipCounts24h.catch_up_window}`;
      return `<tr><td>${escapeHtml(target.projectName)}</td><td>${routineStatePill(target.state)}${reason}</td><td><code>${renderTimestamp(target.nextFireAt)}</code></td><td><code>${renderTimestamp(target.lastFiredAt)}</code></td><td class="c-detail">${skip}</td><td class="c-detail">${counts}</td></tr>`;
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
            `<tr><td class="c-detail">${escapeHtml(eventLabel)}</td><td><a href="/firings/${encodeURIComponent(firing.id)}"><code>${escapeHtml(firing.id)}</code></a></td><td>${escapeHtml(firing.projectName)}</td><td>${statePill(firing.state)}</td><td class="c-detail">${escapeHtml(firing.terminalReason ?? "")}</td><td><code>${renderTimestamp(firing.createdAt)}</code></td></tr>`
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

// Mirrors /runs/:id's renderRunSummary — same <dl class="fields"> layout —
// but for a Firing: no issue, no retries/continuation, and started/ended
// derived from its own transitions rather than carried on the row itself.
function renderFiringSummary(
  detail: RoutineFiringStatus,
  transitions: RoutineFiringStateTransition[]
): string {
  const startedAt = transitions.find(
    (transition) => transition.state === "queued"
  )?.createdAt;
  const endedAt = [...transitions]
    .reverse()
    .find((transition) =>
      TERMINAL_FIRING_STATES.has(transition.state)
    )?.createdAt;
  const terminalRow =
    detail.terminalReason === null
      ? ""
      : `<dt>Terminal reason</dt><dd><code>${escapeHtml(detail.terminalReason)}</code></dd>`;
  const cancelLine = detail.cancelRequested
    ? `<div class="field-note"><strong>Cancel requested</strong> (reason: ${escapeHtml(detail.cancelReason ?? "unknown")})</div>`
    : "";
  return `<section><dl class="fields">
  <dt>Routine</dt><dd><a href="/routines/${encodeURIComponent(detail.routineName)}">${escapeHtml(detail.routineName)}</a></dd>
  <dt>Project</dt><dd>${escapeHtml(detail.projectName)}</dd>
  <dt>State</dt><dd>${statePill(detail.state)}</dd>
  <dt>Provider</dt><dd>${escapeHtml(detail.provider)}</dd>
  <dt>Trigger</dt><dd>${escapeHtml(detail.triggerSource)}</dd>
  <dt>Scheduled</dt><dd><code>${renderTimestamp(detail.scheduledAt)}</code></dd>
  <dt>Started</dt><dd><code>${renderTimestamp(startedAt)}</code></dd>
  <dt>Ended</dt><dd><code>${renderTimestamp(endedAt)}</code></dd>
  <dt>Workspace</dt><dd><code>${escapeHtml(detail.workspacePath)}</code></dd>
  <dt>Branch</dt><dd><code>${escapeHtml(detail.branchName)}</code></dd>
  ${terminalRow}
  ${cancelLine}
</dl></section>`;
}

// Read-only association per CONTEXT.md: a Routine Pull Request is never a
// PR Follow-up (that machinery is Run-only, driven by tracked_pull_requests
// / review dispatch caps). Plain informational text, not a link — like the
// show-firing CLI command's own rendering of the same data,
// RoutinePullRequestStatus carries no prUrl to link to.
function renderFiringPullRequests(
  pullRequests: RoutinePullRequestStatus[]
): string {
  if (pullRequests.length === 0) {
    return "";
  }
  const items = pullRequests
    .map(
      (pullRequest) =>
        `<li>PR #${pullRequest.prNumber} <code>${escapeHtml(pullRequest.headSha)}</code> <small>(informational — not a PR Follow-up)</small></li>`
    )
    .join("");
  return `<section>${sectionHead("Pull requests", pullRequests.length)}<ul class="files">${items}</ul></section>`;
}

async function buildFiringArtifactDescriptors(
  evidence: RoutineEvidencePaths
): Promise<RunArtifactDescriptor[]> {
  const entries: Array<[RunArtifactKind, string]> = [
    ["prompt", evidence.promptPath],
    ["prompt_metadata", evidence.promptMetadataPath],
    ["provider_raw", evidence.rawLogPath],
    ["provider_normalized", evidence.normalizedLogPath]
  ];
  return Promise.all(
    entries.map(async ([kind, filePath]) => {
      const sizeBytes = await statRoutineEvidenceFile(filePath);
      return { kind, present: sizeBytes !== undefined, sizeBytes };
    })
  );
}

function collectActiveWatchdogIdleStatuses(
  runStore: RunStore,
  runs: RunStatus[],
  getWatchdogConfig: (
    projectName: string
  ) => Pick<
    WatchdogConfig,
    "enabled" | "graceMinutes" | "maxRunMinutes" | "outputTokenBudget"
  >,
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
  "<tr><th>Run id</th><th>Project</th><th>Issue</th><th>State</th><th>Current state</th><th>Provider</th><th>Started</th><th>Updated</th><th>Branch</th></tr>";

function formatCurrentStateCell(
  currentStateId: string | null,
  mutedClass: "muted" | "wf-muted" = "muted"
): string {
  return currentStateId === null
    ? `<span class="${mutedClass}">not recorded</span>`
    : `<code>${escapeHtml(currentStateId)}</code>`;
}

function workflowStateId(
  run: Pick<RunStatus, "currentStateId" | "terminalStateId">
): string | null {
  return run.currentStateId ?? run.terminalStateId;
}

function runRowHtml(
  run: RunStatus,
  watchdogByRun: Map<string, WatchdogIdleStatus>,
  nowMs: number
): string {
  const currentState = formatCurrentStateCell(workflowStateId(run));
  return `<tr><td><a href="/runs/${encodeURIComponent(run.id)}"><code>${escapeHtml(run.id)}</code></a></td><td>${escapeHtml(run.project)}</td><td class="c-title">#${run.issueNumber} ${escapeHtml(run.issueTitle)}</td><td>${statePill(run.state)}${renderWatchdogIdleBadge(watchdogByRun.get(run.id), nowMs)}</td><td>${currentState}</td><td>${escapeHtml(run.provider)}</td><td><code>${renderTimestamp(run.createdAt)}</code></td><td><code>${renderTimestamp(run.updatedAt)}</code></td><td><code>${escapeHtml(run.branchName)}</code></td></tr>`;
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
  return `<tr><td><a href="/routines/${encodeURIComponent(firing.routineName)}">${escapeHtml(firing.routineName)}</a></td><td>${escapeHtml(firing.projectName)}</td><td>${statePill(firing.state)}</td><td><code>${renderTimestamp(firing.createdAt)}</code></td></tr>`;
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
  <dt>Current state</dt><dd>${formatCurrentStateCell(workflowStateId(detail))}</dd>
  <dt>Provider</dt><dd>${escapeHtml(detail.provider)}</dd>
  <dt>Started</dt><dd><code>${renderTimestamp(detail.createdAt)}</code></dd>
  <dt>Updated</dt><dd><code>${renderTimestamp(detail.updatedAt)}</code></dd>
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
      ? `<dt>idle_since</dt><dd><code>${renderTimestamp(watchdog.idleSince)}</code></dd>`
      : "";
  const graceRow =
    watchdog.graceRemainingMs !== undefined
      ? `<dt>Grace remaining</dt><dd>${escapeHtml(formatWatchdogDuration(watchdog.graceRemainingMs))}</dd>`
      : "";
  const budgetRow =
    watchdog.outputTokenBudget > 0
      ? `<dt>Output tokens</dt><dd>${watchdog.outputTokensTotal ?? 0} / ${watchdog.outputTokenBudget} budget</dd>`
      : "";
  const runTimeoutRow =
    watchdog.runRemainingMs !== undefined
      ? `<dt>Run timeout in</dt><dd>${escapeHtml(formatWatchdogDuration(watchdog.runRemainingMs))} <span class="muted">(cap ${escapeHtml(formatWatchdogDuration(watchdog.maxRunMs))})</span></dd>`
      : "";
  return `<section>${sectionHead("Watchdog")}<dl class="fields">
  <dt>Last tool_call</dt><dd>${escapeHtml(formatAge(watchdog.lastToolCallAt, nowMs))}</dd>
  <dt>Last progress marker</dt><dd>${escapeHtml(formatAge(watchdog.lastProgressAt, nowMs))}</dd>
  <dt>Workspace mtime</dt><dd>${escapeHtml(formatAge(watchdog.workspaceMtimeMax, nowMs))}</dd>
  <dt>turn_ids observed</dt><dd>${watchdog.turnIdSetSize ?? 0}</dd>
  <dt>Output tokens / 5m</dt><dd>${outputTokenGrowth5m === 0 ? "0" : `+${outputTokenGrowth5m}`}</dd>
  ${budgetRow}
  ${idleRow}
  ${graceRow}
  ${runTimeoutRow}
</dl></section>`;
}

function renderCancelForm(
  detail: { id: string; state: RunState },
  csrfToken: string
): string {
  if (TERMINAL_STATES.has(detail.state)) {
    return "";
  }
  return `<section><form method="post" action="/api/runs/${encodeURIComponent(detail.id)}/cancel" onsubmit="return window.confirm('Cancel this run? Any active provider process will be stopped. This action cannot be undone.')"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(csrfToken)}"><button class="btn" type="submit">Cancel run</button></form></section>`;
}

// #307's routine-lifecycle controls: cancellation already generalized
// server-side (ADR 0060 -- /api/runs/:id/cancel id-sniffs a Run vs. a
// Routine Firing and cancelViaUi/cancelRunInStore already handle both), so
// this is the same form as renderCancelForm posting to the same endpoint,
// not a new cancel mechanism.
function renderFiringCancelForm(
  detail: { id: string; state: RoutineFiringState },
  csrfToken: string
): string {
  if (TERMINAL_FIRING_STATES.has(detail.state)) {
    return "";
  }
  return `<section><form method="post" action="/api/runs/${encodeURIComponent(detail.id)}/cancel"><input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeHtml(csrfToken)}"><button class="btn" type="submit">Cancel firing</button></form></section>`;
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
        `<tr><td>${attempt.attemptNumber}</td><td><code>${escapeHtml(attempt.id)}</code></td><td>${statePill(attempt.state)}</td><td>${escapeHtml(attempt.providerName)}</td><td><code>${renderTimestamp(attempt.createdAt)}</code></td><td><code>${renderTimestamp(attempt.updatedAt)}</code></td><td><code>${escapeHtml(attempt.branchName)}</code></td></tr>`
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
  transitions: {
    sequence: number;
    state: RunState | RoutineFiringState;
    createdAt: string;
  }[]
): string {
  if (transitions.length === 0) {
    return "";
  }
  const rows = transitions
    .map(
      (transition) =>
        `<tr><td>${transition.sequence}</td><td>${statePill(transition.state)}</td><td><code>${renderTimestamp(transition.createdAt)}</code></td></tr>`
    )
    .join("");
  return tableSection(
    "State transitions",
    transitions.length,
    "<tr><th>Seq</th><th>State</th><th>At</th></tr>",
    rows
  );
}

// The DB-backed ProviderEventRecord (Run events) satisfies this structurally
// with no adapter — Firing events, read from a normalized-log file (see
// routines/evidence.ts) rather than the provider_events table, have no
// per-event createdAt of their own (the log line is the raw normalized
// event exactly as the provider emitted it, with no timestamp injected at
// write time — see routines/dispatcher.ts's appendRoutineEvent) and no
// attemptId/runId/raw to fabricate, so this only requires what
// coalesceEvents/renderEventsTable actually read.
type CoalesceableProviderEvent = {
  createdAt?: string;
  normalized: Record<string, unknown>;
  sequence: number | null;
  type: string;
};

function renderEventsTable(
  events: CoalesceableProviderEvent[],
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
            ? formatEventSequence(row.firstSequence)
            : `${formatEventSequence(row.firstSequence)}–${formatEventSequence(row.lastSequence)}`;
        return `<tr><td>${seq}</td><td>message</td><td class="c-detail"><div class="msg">${escapeHtml(row.text)}</div></td><td><code>${renderTimestamp(row.createdAt)}</code></td></tr>`;
      }
      if (row.kind === "thinking") {
        const detail =
          row.status === "started"
            ? `thinking since <code>${renderTimestamp(row.createdAt)}</code>`
            : `thinking completed${row.summary.length > 0 ? ` &mdash; ${escapeHtml(row.summary)}` : ""}`;
        return `<tr><td>${formatEventSequence(row.sequence)}</td><td>thinking</td><td class="c-detail">${detail}</td><td><code>${renderTimestamp(row.createdAt)}</code></td></tr>`;
      }
      return `<tr><td>${formatEventSequence(row.sequence)}</td><td>${escapeHtml(row.type)}</td><td class="c-detail"><code>${escapeHtml(row.detail)}</code></td><td><code>${renderTimestamp(row.createdAt)}</code></td></tr>`;
    })
    .join("");
  const scope = truncated
    ? `most recent ${events.length}`
    : `all ${events.length}`;
  return `<section>${sectionHead("Transcript & events", events.length)}<p class="hint">Showing ${scope} events, oldest first. Streamed message tokens are merged into blocks; full logs are under Files below.</p><div class="table-wrap"><table><thead><tr><th>Seq</th><th>Type</th><th>Detail</th><th>At</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderRunFileLinks(
  id: string,
  artifacts: RunArtifactDescriptor[],
  basePath: "runs" | "firings" = "runs"
): string {
  const items = artifacts
    .filter((artifact) => artifact.present)
    .map((artifact) => {
      const size =
        artifact.sizeBytes === undefined
          ? ""
          : ` <small>(${artifact.sizeBytes} bytes)</small>`;
      return `<li><a href="/logs/${basePath}/${encodeURIComponent(id)}/${encodeURIComponent(artifact.kind)}">${escapeHtml(formatArtifactKind(artifact.kind))}</a>${size}</li>`;
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
      firstSequence: number | null;
      lastSequence: number | null;
      text: string;
      createdAt: string;
    }
  | {
      kind: "event";
      sequence: number | null;
      type: string;
      detail: string;
      createdAt: string;
    }
  | {
      kind: "thinking";
      sequence: number | null;
      status: "completed" | "started";
      summary: string;
      createdAt: string;
    };

function formatEventSequence(sequence: number | null): string {
  return sequence === null ? "?" : String(sequence);
}

// Codex streams assistant text one token per event; merge runs of adjacent
// message events into a single readable block, breaking on any other event.
function coalesceEvents(
  events: CoalesceableProviderEvent[]
): EventDisplayRow[] {
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
    const eventTimestamp = event.normalized.timestamp;
    const createdAt =
      event.type === "thinking" && typeof eventTimestamp === "string"
        ? eventTimestamp
        : (event.createdAt ?? "");
    if (event.type === "message" && typeof message === "string") {
      if (buffer === undefined) {
        buffer = {
          createdAt,
          firstSequence: event.sequence,
          kind: "message",
          lastSequence: event.sequence,
          text: message
        };
      } else {
        buffer.text += message;
        buffer.lastSequence = event.sequence;
        buffer.createdAt = createdAt;
      }
      continue;
    }

    flush();
    if (event.type === "thinking") {
      const summary = event.normalized.summary;
      rows.push({
        createdAt,
        kind: "thinking",
        sequence: event.sequence,
        status:
          event.normalized.status === "completed" ? "completed" : "started",
        summary: Array.isArray(summary)
          ? summary
              .filter((value): value is string => typeof value === "string")
              .join(" ")
          : ""
      });
      continue;
    }
    rows.push({
      createdAt,
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
  return escapeJsonForInlineScript(graph);
}

function renderWorkflowGraphPage(
  runId: string,
  currentStateId: string | null,
  graph: ExpandedWorkflow
): string {
  const encodedId = encodeURIComponent(runId);
  const name = typeof graph.name === "string" ? graph.name : "(unknown)";
  const currentState = formatCurrentStateCell(currentStateId, "wf-muted");
  return `<style>${WORKFLOW_GRAPH_STYLES}</style>
<h1>Workflow graph</h1>
<p class="wf-sub">Run <a href="/runs/${encodedId}"><code>${escapeHtml(runId)}</code></a> &middot; <code>${escapeHtml(name)}</code> &middot; Current state ${currentState} &middot; <a href="/logs/runs/${encodedId}/workflow_graph">raw JSON</a></p>
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
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#ecfeff;border-color:#0e7490;border-width:3px"></span> current state</div>
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
<script>window.__WORKFLOW_GRAPH__ = ${serializeGraphForScript(graph)};
window.__WORKFLOW_CURRENT_STATE__ = ${escapeJsonForInlineScript(currentStateId)};</script>
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
.wf-badge.current { background:#ecfeff; color:#155e75; border-color:#67e8f9; }
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

export const WORKFLOW_GRAPH_CLIENT_JS = `(function () {
  var graph = window.__WORKFLOW_GRAPH__;
  var currentStateId = window.__WORKFLOW_CURRENT_STATE__;
  var cyEl = document.getElementById("wf-cy");
  var detailEl = document.getElementById("wf-detail");
  if (!graph || !cyEl) return;
  var states = Array.isArray(graph.states) ? graph.states : [];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtVal(v) {
    if (Array.isArray(v)) return "[" + v.map(fmtVal).join(", ") + "]";
    return typeof v === "string" ? '"' + v + '"' : String(v);
  }
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
    if (st.id === currentStateId) cls.push("current");
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
    var label = st.id === currentStateId ? st.id + "\\ncurrent" : st.id;
    elements.push({ data: { id: st.id, label: label, state: st }, classes: nodeClasses(st) });
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
      { selector: "node.current", style: {
        "border-width": 4, "border-color": "#0e7490",
        "underlay-color": "#06b6d4", "underlay-opacity": 0.16, "underlay-padding": 8 } },
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
    if (st.id === currentStateId) badges.push('<span class="wf-badge current">current</span>');
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
    var lines = ["Workflow: " + (graph.name || "(unknown)"), "Current: " + (currentStateId === null ? "(not recorded)" : currentStateId), "Initial: " + (graph.initial || "(unknown)"), ""];
    states.forEach(function (st) {
      var tag = st.terminal ? " [terminal:" + st.terminal + "]" : (st.action ? " [" + st.action.kind + "]" : "");
      if (st.id === currentStateId) tag += " [current]";
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

// JSON.stringify does not escape "<", ">", "&", or the JS line-terminator
// characters U+2028/U+2029 -- embedding its output verbatim inside an
// inline <script> lets attacker-controlled data (e.g. an issue title) close
// the tag early with a literal "</script>" and inject a sibling script.
// \u-escaping those characters keeps the JSON value identical after
// JSON.parse/eval while making that impossible.
function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  );
}
