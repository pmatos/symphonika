import { createReadStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";

import {
  checkMutationAuthorized,
  createCsrfSecret,
  type CsrfSecret
} from "./csrf.js";
import type { WorkflowFormat } from "../config-schemas.js";
import type {
  IssuePollStatus,
  ProjectIssuePollReport
} from "../issue-polling.js";
import { emptyIssuePollStatus } from "../issue-polling.js";
import type { AsyncMutex } from "../lifecycle/async-mutex.js";
import {
  DEFAULT_WATCHDOG_CONFIG,
  type RuntimeReloadStatus,
  type WatchdogConfig
} from "../reload.js";
import {
  routineEvidencePaths,
  statRoutineEvidenceFile,
  type RoutineEvidencePaths
} from "../routines/evidence.js";
import { reconcileRoutineOutcome } from "../routines/outcome.js";
import type { RoutineFiringState, RoutineState } from "../routines/types.js";
import type { PullRequestState } from "../pull-request-state.js";
import type { ReloadOutcome } from "./save-pipeline.js";
import type { StatusSnapshot } from "../status.js";
import type { UpdateActionResult } from "../update/coordinator.js";
import type {
  ChangeEvent,
  ListRunsFilter,
  ProjectSnapshotRepository,
  RunArtifactKind,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";
import {
  buildWatchdogIdleStatus,
  buildWatchdogStatus,
  resolveWatchdogNowMs
} from "../watchdog-status.js";
import {
  buildPullRequestFollowupAttention,
  registerPages,
  type ScheduledCallback
} from "./pages.js";

type CancelRunFn = (
  runId: string,
  source: "ui"
) =>
  | { kind: "cancelled" }
  | { kind: "not-found" }
  | { kind: "already-terminal"; state: RunState }
  | Promise<
      | { kind: "cancelled" }
      | { kind: "not-found" }
      | { kind: "already-terminal"; state: RunState }
    >;

export type PollNowResult = {
  candidateIssues: number;
  dispatching: boolean;
  errors: number;
  filteredIssues: number;
  issuePolling: {
    errors: string[];
    projects: ProjectIssuePollReport[];
  };
  kind: "coalesced" | "queued";
  state: "dispatching" | "idle";
};

export type PollNowFn = () => PollNowResult | Promise<PollNowResult>;

// #582's `symphonika update`. Driven through the daemon rather than run
// standalone so the forced cycle shares the one drain gate that keeps a
// cutover from landing underneath live runs.
type UpdateNowFn = (input: {
  checkOnly: boolean;
}) => Promise<UpdateActionResult>;

// #308 part 2's label-write action: the only mutation the triage UI performs
// against GitHub directly (everything else in #307 writes local files). See
// docs/adr/0077-issue-triage-and-label-writes.md. #309 part 2 reuses this same
// callback for PR label writes — GitHub's labels endpoint treats an issue and
// a PR number identically — so the field is `subjectNumber`, not
// `issueNumber`: a PR-label call site passing a PR number through a field
// named `issueNumber` would misname what it actually holds. `kind` is
// carried for the same clarity reason, even though the daemon-side
// implementation doesn't currently need to branch on it.
export type WriteIssueLabelsResult =
  { ok: true } | { error: string; ok: false };

export type WriteIssueLabelsFn = (input: {
  add: string[];
  kind: "issue" | "pull_request";
  projectName: string;
  remove: string[];
  snapshotRepository?: ProjectSnapshotRepository | undefined;
  subjectNumber: number;
}) => Promise<WriteIssueLabelsResult>;

// #309 part 3's guarded-merge action: the only other GitHub mutation the
// triage UI performs directly. `freshState` is the PR's Pull Request State
// re-fetched immediately after the merge attempt (success or failure) —
// AC8 asks that the displayed state be re-derived, not assumed merged, so
// the caller renders this instead of the (still-stale-until-next-poll)
// persisted snapshot. `undefined` means the re-fetch itself failed or is
// unsupported by the configured GitHub API — distinct from a fetch that
// succeeded and genuinely reported an unresolved/unknown field, the same
// stateAvailable honesty the poll snapshot itself carries (ADR 0078).
// `snapshotRepository` is the repository identity rendered with the Merge
// action. It stays optional at this boundary so missing or malformed form
// input reaches the daemon guard and fails closed before GitHub.
// `method` is always "merge" here — a dashboard click is the operator
// explicitly overriding the FSM's own configured merge policy (ADR 0044),
// not subject to it.
export type MergePullRequestResult =
  | { freshState: PullRequestState | undefined; ok: true }
  | { error: string; freshState: PullRequestState | undefined; ok: false };

export type MergePullRequestFn = (input: {
  expectedHeadSha?: string;
  prNumber: number;
  projectName: string;
  snapshotRepository?: ProjectSnapshotRepository | undefined;
}) => Promise<MergePullRequestResult>;

type FireRoutineRequest = {
  force: boolean;
  projectName?: string;
  routineName: string;
};

export type FireRoutineResult =
  | {
      firingId: string;
      kind: "accepted";
      projectName: string;
      routineName: string;
      state: "queued";
    }
  | {
      candidates: Array<{ projectName: string; routineName: string }>;
      error: string;
      kind: "ambiguous";
    }
  | { error: string; kind: "not_found" }
  | {
      error: string;
      kind: "refused";
      reason:
        | RoutineState
        | "concurrency_cap"
        | "daemon_shutdown"
        | "overlap"
        | "self_update_draining";
    }
  | { error: string; kind: "unavailable" };

type FireRoutineFn = (
  request: FireRoutineRequest
) => FireRoutineResult | Promise<FireRoutineResult>;

export type HttpAppOptions = {
  cancelRun?: CancelRunFn;
  // Test-only override; production always mints a fresh secret per
  // process. See docs/adr/0075-mutation-authentication-and-superseding-0027.md.
  csrfSecret?: CsrfSecret;
  dispatchRuntime?: {
    dispatching: boolean;
    inFlight?: number;
  };
  fireRoutine?: FireRoutineFn;
  // Per-Slice-2: cap snapshot + live in-flight counts. See ADR 0053.
  getConcurrency?: () => {
    global: { inFlight: number; maxInFlight: number | null };
    perProject: Array<{
      inFlight: number;
      maxInFlight: number;
      projectName: string;
    }>;
  };
  getActiveRuns?: () => Array<{
    cancelReason: string | null;
    cancelRequested: boolean;
    issueNumber: number;
    projectName: string;
    runId: string;
  }>;
  // Epoch timestamp exposed by /api/status.
  getLastTickAt?: () => number | undefined;
  // Internal liveness timestamps share monotonicNow's clock domain.
  getLastTickAtMonotonic?: () => number | undefined;
  getNextPollAtMonotonic?: () => number | undefined;
  getPollingIntervalMs?: () => number | undefined;
  getTickLoopStartedAtMonotonic?: () => number | undefined;
  getPullRequestFollowupPolicy?: () => {
    maxReviewDispatchesPerPr: number;
  };
  // #307's service-config editor: the absolute path to symphonika.yml.
  getConfigPath?: () => string;
  // #307's workflow-contract editor: a Dispatch Project's current resolved
  // workflow path and configured format, or undefined for a Routine Host
  // (no workflow) or an unknown Project name. format is the project's own
  // resolved WorkflowFormat (config-schemas.ts) -- required so the editor
  // validates a save against the same format reload would actually use,
  // not always the file-extension guess (fsm-expansion.ts's "auto").
  getProjectWorkflowPath?: (
    projectName: string
  ) => { format: WorkflowFormat; path: string } | undefined;
  // Ownership/liveness guards (clear-stale-claim, PR merge) key on Project
  // name, but two Projects can point at the same GitHub owner/repo (a
  // supported config). Returns every Project name sharing that repo,
  // including projectName itself, so those guards union liveness across the
  // whole alias group instead of missing a claim/run parked under a sibling
  // Project name. See src/http/pages.ts's getProjectRepoAliases usage.
  getProjectRepoAliases?: (projectName: string) => string[];
  // The issue dependency graph (src/http/pages.ts's /issues/graph) needs a
  // Project's GitHub owner/repo to build each issue's node id and to
  // resolve its "## Parent" heading (same-repo only) into a compound-node
  // cluster. Undefined for a Routine Host or an unknown Project name --
  // that project's issues are simply skipped from the graph.
  getProjectRepo?: (
    projectName: string
  ) => { owner: string; repo: string } | undefined;
  // The project's configured issue_filters.labels_all -- the label-write
  // dependency gate (src/http/pages.ts's handleIssueLabelWrite) only blocks
  // adding a label in this set, never a hardcoded "agent-ready" string,
  // since which label actually gates dispatch is per-project config. Absent
  // (or an unknown project name) degrades to an empty set, i.e. no gate.
  getProjectRequiredLabels?: (projectName: string) => string[];
  getRuns?: () => RunStatus[];
  getReloadStatus?: () => RuntimeReloadStatus;
  getScheduled?: () => ScheduledCallback[];
  getStatusSnapshot?: () => StatusSnapshot;
  getWatchdogConfig?: (
    projectName: string
  ) => Pick<WatchdogConfig, "enabled" | "graceMinutes" | "outputTokenBudget">;
  issuePollStatus?: IssuePollStatus;
  monotonicNow?: () => number;
  // Wall clock used by human/API-facing timestamps and ages.
  now?: () => number;
  pollNow?: PollNowFn;
  // #307's editors: confines a save target to a path the current valid
  // config actually references (routine declaration, workflow contract, or
  // symphonika.yml itself) -- see src/path-safety.ts and
  // docs/adr/0075-mutation-authentication-and-superseding-0027.md. Returns
  // the resolved (symlink-following) path on success, undefined otherwise.
  resolveWritePath?: (candidatePath: string) => Promise<string | undefined>;
  runStore?: RunStore;
  // #308 part 3's clear-stale-claim: the same mutex RunController's retry
  // path serializes its own claim (reserveSlot + sym:claimed label add)
  // through (src/lifecycle/run-controller.ts, ADR 0052). Clearing a claim
  // without it would let a claim landing between the liveness check and
  // the label-removal write get silently wiped as "stale".
  claimMutex?: AsyncMutex;
  // #309 part 3's guarded-merge action: see
  // docs/adr/0078-pr-surface-poll-snapshot-and-state-projection.md.
  mergePullRequest?: MergePullRequestFn;
  // Aborted by stopServer before it calls server.close(), so open /events
  // streams exit their loop instead of holding the shutdown open forever.
  shutdownSignal?: AbortSignal;
  // Test-only override; production always uses SSE_HEARTBEAT_MS. See
  // docs/adr/0074-live-notification-path.md.
  sseHeartbeatMs?: number;
  startedAtMs?: number;
  stateRoot: string;
  // #582's `symphonika update`: forces one self-update cycle (or, with
  // checkOnly, just the release check) without waiting for the coordinator's
  // own check interval.
  updateNow?: UpdateNowFn;
  // #308 part 2's label-write action: adds/removes non-sym:* labels on a
  // GitHub issue. See docs/adr/0077-issue-triage-and-label-writes.md.
  writeIssueLabels?: WriteIssueLabelsFn;
  // #307's editors: the same reload path #305 wired to the daemon's poll
  // tick, driven synchronously by an editor save so an invalid edit (or one
  // that's schema-valid but fails reload) is reported on save, not on the
  // next tick. See src/http/save-pipeline.ts.
  triggerReload?: () => Promise<ReloadOutcome>;
  version: string;
};

const SSE_HEARTBEAT_MS = 20_000;
const SSE_MAX_PENDING_EVENTS = 100;

const KNOWN_RUN_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "preparing_workspace",
  "running",
  "input_required",
  "failed",
  "blocked",
  "succeeded",
  "cancelled",
  "stale",
  "waiting"
]);

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "cancelled",
  "failed",
  "blocked",
  "input_required",
  "stale",
  "succeeded"
]);

const RUN_ARTIFACT_CONTENT_TYPES: Record<RunArtifactKind, string> = {
  issue_snapshot: "application/json; charset=utf-8",
  prompt: "text/markdown; charset=utf-8",
  prompt_metadata: "application/json; charset=utf-8",
  workflow_graph: "application/json; charset=utf-8",
  provider_raw: "application/x-ndjson",
  provider_normalized: "application/x-ndjson",
  provider_stderr: "text/plain; charset=utf-8"
};

const RUN_ARTIFACT_KINDS: ReadonlySet<string> = new Set(
  Object.keys(RUN_ARTIFACT_CONTENT_TYPES)
);

export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();
  const startedAtMs = options.startedAtMs ?? Date.now();
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const now = options.now ?? Date.now;
  const issuePollStatus = options.issuePollStatus ?? emptyIssuePollStatus();
  const dispatchRuntime = options.dispatchRuntime ?? {
    dispatching: false
  };
  const getRuns = options.getRuns ?? (() => []);
  const getActiveRuns = options.getActiveRuns ?? (() => []);
  const getScheduled = options.getScheduled ?? (() => []);
  const runStore = options.runStore;
  const cancelRun =
    options.cancelRun ??
    (runStore === undefined
      ? undefined
      : (runId: string) => cancelRunInStore(runStore, runId));
  const csrfSecret = options.csrfSecret ?? createCsrfSecret();
  const requireAuthorizedMutation: MiddlewareHandler = async (
    context,
    next
  ) => {
    const authorization = await checkMutationAuthorized(context, csrfSecret);
    if (!authorization.ok) {
      return context.json({ error: authorization.reason }, 403);
    }
    await next();
  };

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "symphonika",
      version: options.version,
      stateRoot: options.stateRoot,
      uptimeMs: uptimeMs(startedAtMs, now)
    })
  );

  app.get("/api/status", (context) => {
    const lastTickAt = options.getLastTickAt?.() ?? null;
    return context.json({
      active: getActiveRuns().map((run) =>
        runStore === undefined
          ? run
          : {
              ...run,
              watchdog: buildWatchdogIdleStatus({
                config:
                  options.getWatchdogConfig?.(run.projectName) ??
                  DEFAULT_WATCHDOG_CONFIG,
                nowMs: now(),
                runId: run.runId,
                runStore
              })
            }
      ),
      candidateIssues: issuePollStatus.candidateIssues,
      filteredIssues: issuePollStatus.filteredIssues,
      issuePolling: {
        errors: issuePollStatus.errors,
        projects: issuePollStatus.projects
      },
      lastTickAt,
      projectStates: runStore?.listProjectStates() ?? [],
      reload: options.getReloadStatus?.() ?? emptyReloadStatus(),
      routines: runStore?.listRoutines() ?? [],
      runs: getRuns(),
      scheduled: getScheduled(),
      service: "symphonika",
      staleIssues: issuePollStatus.filteredIssues.filter((entry) =>
        entry.issue.labels.includes("sym:stale")
      ),
      state: dispatchRuntime.dispatching ? "dispatching" : "idle",
      dispatching: dispatchRuntime.dispatching,
      inFlight: dispatchRuntime.inFlight ?? 0,
      concurrency:
        options.getConcurrency === undefined
          ? undefined
          : options.getConcurrency(),
      stateRoot: options.stateRoot,
      tickAgeMs: lastTickAt === null ? null : now() - lastTickAt,
      uptimeMs: uptimeMs(startedAtMs, now)
    });
  });

  app.post("/api/poll-now", requireAuthorizedMutation, async (context) => {
    if (options.pollNow === undefined) {
      return context.json(
        { error: "poll-now trigger unavailable", kind: "unavailable" },
        503
      );
    }

    return context.json(await Promise.resolve(options.pollNow()));
  });

  app.post("/api/update-now", requireAuthorizedMutation, async (context) => {
    if (options.updateNow === undefined) {
      return context.json(
        { error: "update trigger unavailable", kind: "unavailable" },
        503
      );
    }

    const checkOnly = context.req.query("check") === "true";
    return context.json(await options.updateNow({ checkOnly }));
  });

  app.post(
    "/api/routines/:id/fire",
    requireAuthorizedMutation,
    async (context) => {
      const routineName = context.req.param("id");
      const projectName = context.req.query("project");
      const includeInactive = context.req.query("include_inactive") === "true";
      // #469: a plain <form> POST from /routines/:name gets a 303 redirect
      // back to the page with the outcome encoded as query params instead
      // of the JSON body a fetch()/CLI caller expects -- same content-type
      // sniff /api/runs/:id/cancel already uses (ADR 0075).
      const wantsRedirect = (
        context.req.header("content-type") ?? ""
      ).startsWith("application/x-www-form-urlencoded");
      const redirectTo = async (result: FireRoutineResult) => {
        const body = await context.req.parseBody();
        const pageProject = body.project_param;
        const params = new URLSearchParams();
        if (typeof pageProject === "string") {
          params.set("project", pageProject);
        }
        if (includeInactive) {
          params.set("include_inactive", "true");
        }
        params.set("fire", result.kind);
        if (projectName !== undefined) {
          params.set("fire_project", projectName);
        }
        if (result.kind === "refused") {
          params.set("fire_reason", result.reason);
        }
        return context.redirect(
          `/routines/${encodeURIComponent(routineName)}?${params.toString()}`,
          303
        );
      };

      if (options.fireRoutine === undefined) {
        const result: FireRoutineResult = {
          error: "manual Routine trigger unavailable",
          kind: "unavailable"
        };
        return wantsRedirect ? redirectTo(result) : context.json(result, 503);
      }
      const result = await Promise.resolve(
        options.fireRoutine({
          force: context.req.query("force") === "true",
          ...(projectName === undefined ? {} : { projectName }),
          routineName
        })
      );
      if (wantsRedirect) {
        return redirectTo(result);
      }
      switch (result.kind) {
        case "accepted":
          return context.json(result, 202);
        case "not_found":
          return context.json(result, 404);
        case "ambiguous":
          return context.json(result, 409);
        case "unavailable":
          return context.json(result, 503);
        case "refused":
          return context.json(
            result,
            result.reason === "concurrency_cap" ? 429 : 409
          );
      }
    }
  );

  if (runStore !== undefined) {
    app.get("/api/runs", (context) => {
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
      const limit = parsePositiveInt(context.req.query("limit"));
      if (limit !== undefined) {
        filter.limit = limit;
      }
      return context.json({ runs: runStore.listRuns(filter) });
    });

    app.get("/api/routines", (context) => {
      const project = context.req.query("project");
      return context.json({
        routines: runStore.listRoutines({
          includeInactive: context.req.query("include_inactive") === "true",
          ...(project === undefined ? {} : { project })
        })
      });
    });

    app.get("/api/routines/:id/firings", (context) => {
      const routineName = context.req.param("id");
      const project = context.req.query("project");
      const matches = runStore
        .listRoutines({
          includeInactive: context.req.query("include_inactive") === "true",
          ...(project === undefined ? {} : { project })
        })
        .filter((routine) => routine.name === routineName);
      if (matches.length === 0) {
        return context.json({ error: "routine not found" }, 404);
      }
      return context.json({
        firings: runStore.listRoutineFirings({
          ...(project === undefined ? {} : { project }),
          routineName
        }),
        targets: matches
      });
    });

    app.get("/api/runs/:id", (context) => {
      const detail = runStore.getRun(context.req.param("id"));
      if (detail === undefined) {
        return context.json({ error: "run not found" }, 404);
      }
      const events = runStore.listProviderEvents(detail.id, { limit: 100 });
      const { attempts, transitions, ...run } = detail;
      const pullRequestFollowup = buildPullRequestFollowupAttention({
        detail,
        maxDispatches:
          options.getPullRequestFollowupPolicy?.().maxReviewDispatchesPerPr ??
          null,
        runStore
      });
      return context.json({
        attempts,
        events,
        pullRequestFollowup,
        run,
        transitions,
        watchdog: buildWatchdogStatus({
          config:
            options.getWatchdogConfig?.(run.project) ?? DEFAULT_WATCHDOG_CONFIG,
          nowMs: resolveWatchdogNowMs({
            liveNowMs: now(),
            runId: run.id,
            runState: run.state,
            runStore
          }),
          runId: run.id,
          runStore
        })
      });
    });

    app.get("/api/runs/:id/events", (context) => {
      const id = context.req.param("id");
      if (runStore.getRun(id) === undefined) {
        return context.json({ error: "run not found" }, 404);
      }
      const limit = parsePositiveInt(context.req.query("limit"));
      const after = parsePositiveInt(context.req.query("after"));
      const events = runStore.listProviderEvents(id, {
        ...(after !== undefined ? { afterSequence: after } : {}),
        ...(limit !== undefined ? { limit } : {})
      });
      return context.json({ events });
    });

    app.get("/api/runs/:id/files/:fileKind", async (context) => {
      const id = context.req.param("id");
      const kind = parseRunArtifactKind(context.req.param("fileKind"));
      if (kind === undefined) {
        return context.json({ error: "unknown file kind" }, 404);
      }
      return streamRunArtifact(context, runStore, id, kind);
    });

    app.get("/logs/runs/:id/:kind", async (context) => {
      const id = context.req.param("id");
      const kind = parseRunArtifactKind(context.req.param("kind"));
      if (kind === undefined) {
        return context.json({ error: "unknown file" }, 404);
      }
      return streamRunArtifact(context, runStore, id, kind);
    });

    app.get(
      "/api/runs/:id/attempts/:attemptId/files/:fileKind",
      async (context) =>
        streamAttemptArtifact(
          context,
          runStore,
          context.req.param("id"),
          context.req.param("attemptId"),
          parseRunArtifactKind(context.req.param("fileKind"))
        )
    );

    app.get("/logs/runs/:id/attempts/:attemptId/:kind", async (context) =>
      streamAttemptArtifact(
        context,
        runStore,
        context.req.param("id"),
        context.req.param("attemptId"),
        parseRunArtifactKind(context.req.param("kind"))
      )
    );

    // Firing evidence lives on disk at a path routineEvidencePaths derives
    // from stateRoot + firing id (see routines/evidence.ts) — a Firing has
    // no attempts model and no DB-backed artifact registry the way a Run's
    // openArtifactStream reads, so this streams straight off the
    // filesystem, mirroring the show-firing CLI command's own approach.
    app.get("/logs/firings/:id/:kind", async (context) =>
      streamRoutineFiringArtifact(
        context,
        runStore,
        options.stateRoot,
        context.req.param("id"),
        parseRunArtifactKind(context.req.param("kind"))
      )
    );

    // One long-lived SSE stream per client; each connection gets its own
    // subscription so multiple tabs are independent. See
    // docs/adr/0074-live-notification-path.md.
    app.get("/events", (context) =>
      streamChangeEvents(
        context,
        runStore,
        options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS,
        options.shutdownSignal
      )
    );

    app.post(
      "/api/runs/:id/cancel",
      requireAuthorizedMutation,
      async (context) => {
        const id = context.req.param("id");
        const wantsRedirect = (
          context.req.header("content-type") ?? ""
        ).startsWith("application/x-www-form-urlencoded");
        // This route id-sniffs a Run vs. a Routine Firing (ADR 0060: one
        // cancel endpoint, generalized server-side); a form-post redirect
        // must sniff the same way, or cancelling from /firings/:id would
        // bounce the operator to a /runs/:id page for an id that was never
        // a Run. Falls back to /runs/:id when neither lookup matches (a
        // stale id in an already-rendered form) -- /runs/:id renders a
        // proper 404 either way.
        const redirectPath = `${
          runStore.getRun(id) === undefined &&
          runStore.getRoutineFiring(id) !== undefined
            ? "/firings/"
            : "/runs/"
        }${encodeURIComponent(id)}`;

        if (cancelRun === undefined) {
          if (wantsRedirect) {
            return context.redirect(redirectPath, 303);
          }
          return context.json({ kind: "unavailable" }, 503);
        }

        const outcome = await Promise.resolve(cancelRun(id, "ui"));
        if (outcome.kind === "not-found") {
          if (wantsRedirect) {
            return context.redirect("/", 303);
          }
          return context.json({ kind: "not-found" }, 404);
        }
        if (outcome.kind === "already-terminal") {
          if (wantsRedirect) {
            return context.redirect(redirectPath, 303);
          }
          return context.json(outcome, 409);
        }
        if (wantsRedirect) {
          return context.redirect(redirectPath, 303);
        }
        return context.json(outcome, 200);
      }
    );

    registerPages({
      app,
      csrfSecret,
      ...(options.getActiveRuns === undefined
        ? {}
        : { getActiveRuns: options.getActiveRuns }),
      ...(options.getConcurrency === undefined
        ? {}
        : { getConcurrency: options.getConcurrency }),
      ...(options.getLastTickAtMonotonic === undefined
        ? {}
        : { getLastTickAtMonotonic: options.getLastTickAtMonotonic }),
      ...(options.getNextPollAtMonotonic === undefined
        ? {}
        : { getNextPollAtMonotonic: options.getNextPollAtMonotonic }),
      ...(options.getScheduled === undefined
        ? {}
        : { getScheduled: options.getScheduled }),
      ...(options.getPollingIntervalMs === undefined
        ? {}
        : { getPollingIntervalMs: options.getPollingIntervalMs }),
      ...(options.getTickLoopStartedAtMonotonic === undefined
        ? {}
        : {
            getTickLoopStartedAtMonotonic: options.getTickLoopStartedAtMonotonic
          }),
      ...(options.getPullRequestFollowupPolicy === undefined
        ? {}
        : {
            getPullRequestFollowupPolicy: options.getPullRequestFollowupPolicy
          }),
      ...(options.getConfigPath === undefined
        ? {}
        : { getConfigPath: options.getConfigPath }),
      ...(options.getProjectWorkflowPath === undefined
        ? {}
        : { getProjectWorkflowPath: options.getProjectWorkflowPath }),
      ...(options.getProjectRepoAliases === undefined
        ? {}
        : { getProjectRepoAliases: options.getProjectRepoAliases }),
      ...(options.getProjectRepo === undefined
        ? {}
        : { getProjectRepo: options.getProjectRepo }),
      ...(options.getProjectRequiredLabels === undefined
        ? {}
        : { getProjectRequiredLabels: options.getProjectRequiredLabels }),
      ...(options.getStatusSnapshot === undefined
        ? {}
        : { getStatusSnapshot: options.getStatusSnapshot }),
      ...(options.claimMutex === undefined
        ? {}
        : { claimMutex: options.claimMutex }),
      ...(options.getWatchdogConfig === undefined
        ? {}
        : { getWatchdogConfig: options.getWatchdogConfig }),
      issuePollStatus,
      ...(options.mergePullRequest === undefined
        ? {}
        : { mergePullRequest: options.mergePullRequest }),
      monotonicNow,
      now,
      ...(options.pollNow === undefined ? {} : { pollNow: options.pollNow }),
      ...(options.resolveWritePath === undefined
        ? {}
        : { resolveWritePath: options.resolveWritePath }),
      runStore,
      startedAtMs,
      stateRoot: options.stateRoot,
      ...(options.triggerReload === undefined
        ? {}
        : { triggerReload: options.triggerReload }),
      version: options.version,
      ...(options.writeIssueLabels === undefined
        ? {}
        : { writeIssueLabels: options.writeIssueLabels })
    });
  }

  return app;
}

function emptyReloadStatus(): RuntimeReloadStatus {
  return {
    errors: [],
    lastAttemptedAt: null,
    lastLoadedAt: null,
    ok: true,
    routineErrors: [],
    usingLastKnownGood: false
  };
}

async function streamRunArtifact(
  context: Context,
  runStore: RunStore,
  id: string,
  kind: RunArtifactKind
): Promise<Response> {
  const detail = runStore.getRun(id);
  if (detail === undefined) {
    return context.json({ error: "run not found" }, 404);
  }
  const stream = await runStore.openArtifactStream(id, kind);
  if (stream === undefined) {
    return context.json({ error: "file not found" }, 404);
  }
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { "content-type": RUN_ARTIFACT_CONTENT_TYPES[kind] },
    status: 200
  });
}

async function streamAttemptArtifact(
  context: Context,
  runStore: RunStore,
  runId: string,
  attemptId: string,
  kind: RunArtifactKind | undefined
): Promise<Response> {
  if (kind === undefined) {
    return context.json({ error: "unknown file kind" }, 404);
  }
  const detail = runStore.getRun(runId);
  if (detail === undefined) {
    return context.json({ error: "run not found" }, 404);
  }
  if (!detail.attempts.some((attempt) => attempt.id === attemptId)) {
    return context.json({ error: "attempt not found" }, 404);
  }
  const stream = await runStore.openAttemptArtifactStream(attemptId, kind);
  if (stream === undefined) {
    return context.json({ error: "file not found" }, 404);
  }
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { "content-type": RUN_ARTIFACT_CONTENT_TYPES[kind] },
    status: 200
  });
}

function parseRunArtifactKind(value: string): RunArtifactKind | undefined {
  return RUN_ARTIFACT_KINDS.has(value) ? (value as RunArtifactKind) : undefined;
}

// Only these five RunArtifactKind values have a Firing evidence-path
// analogue — issue_snapshot and workflow_graph are Run-only concepts (a
// Firing has no issue and no workflow graph) and fall through to 404.
function resolveRoutineEvidenceFilePath(
  paths: RoutineEvidencePaths,
  kind: RunArtifactKind
): string | undefined {
  switch (kind) {
    case "prompt":
      return paths.promptPath;
    case "prompt_metadata":
      return paths.promptMetadataPath;
    case "provider_raw":
      return paths.rawLogPath;
    case "provider_normalized":
      return paths.normalizedLogPath;
    case "provider_stderr":
      return paths.stderrLogPath;
    default:
      return undefined;
  }
}

async function streamRoutineFiringArtifact(
  context: Context,
  runStore: RunStore,
  stateRoot: string,
  firingId: string,
  kind: RunArtifactKind | undefined
): Promise<Response> {
  if (kind === undefined) {
    return context.json({ error: "unknown file kind" }, 404);
  }
  if (runStore.getRoutineFiring(firingId) === undefined) {
    return context.json({ error: "routine firing not found" }, 404);
  }
  const filePath = resolveRoutineEvidenceFilePath(
    routineEvidencePaths(stateRoot, firingId),
    kind
  );
  if (filePath === undefined) {
    return context.json({ error: "unknown file kind" }, 404);
  }
  const size = await statRoutineEvidenceFile(filePath);
  if (size === undefined) {
    return context.json({ error: "file not found" }, 404);
  }
  return new Response(
    Readable.toWeb(createReadStream(filePath)) as ReadableStream,
    {
      headers: { "content-type": RUN_ARTIFACT_CONTENT_TYPES[kind] },
      status: 200
    }
  );
}

// Events are invalidation signals (identity + new state), not a replay
// log: a client that misses events while disconnected is expected to
// reconcile once on reconnect rather than be caught up here. Idle
// connections only wake on the heartbeat interval, never on a poll —
// see docs/adr/0074-live-notification-path.md.
function streamChangeEvents(
  context: Context,
  runStore: RunStore,
  heartbeatMs: number,
  shutdownSignal: AbortSignal | undefined
): Response {
  return streamSSE(context, async (stream) => {
    const queue: ChangeEvent[] = [];
    let wake: (() => void) | undefined;
    let done = shutdownSignal?.aborted ?? false;
    stream.onAbort(() => {
      done = true;
      wake?.();
    });
    // A writeSSE already blocked on a stalled client's backpressure never
    // resolves on its own, so waking the idle-wait is not enough. Aborting
    // errors the underlying writer, which makes that pending write return
    // and lets the loop reach its finally.
    const closeStream = () => {
      done = true;
      wake?.();
      stream.abort();
    };
    // Node's server.close() waits for every open connection to end on its
    // own; an SSE stream never does that by itself, so without this a
    // daemon shutdown would hang as long as any /events tab stayed open.
    // stopServer aborts this signal before calling close() (daemon.ts).
    shutdownSignal?.addEventListener("abort", closeStream);
    const unsubscribe = runStore.subscribeToChanges((event) => {
      if (done) {
        return;
      }
      if (queue.length >= SSE_MAX_PENDING_EVENTS) {
        queue.length = 0;
        closeStream();
        // Unsubscribe immediately rather than waiting for the loop's
        // finally: a synchronous publish burst would otherwise keep
        // paying a Set-iteration and try/catch per remaining event for a
        // listener that already does nothing but check `done`.
        unsubscribe();
        return;
      }
      queue.push(event);
      wake?.();
    });
    try {
      let id = 0;
      while (!done && !stream.aborted && !stream.closed) {
        if (queue.length === 0) {
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve;
            }),
            stream.sleep(heartbeatMs)
          ]);
          wake = undefined;
          if (done || stream.aborted || stream.closed) {
            break;
          }
          if (queue.length === 0) {
            await stream.writeSSE({
              data: "",
              event: "heartbeat",
              id: String(id++)
            });
            continue;
          }
        }
        const event = queue.shift();
        if (event === undefined) {
          continue;
        }
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: event.kind,
          id: String(id++)
        });
      }
    } finally {
      unsubscribe();
      shutdownSignal?.removeEventListener("abort", closeStream);
    }
  });
}

const TERMINAL_FIRING_STATES: ReadonlySet<RoutineFiringState> = new Set([
  "succeeded",
  "failed",
  "cancelled"
]);

function cancelRunInStore(
  runStore: RunStore,
  id: string
): ReturnType<CancelRunFn> {
  const detail = runStore.getRun(id);
  if (detail !== undefined) {
    if (TERMINAL_RUN_STATES.has(detail.state)) {
      return { kind: "already-terminal", state: detail.state };
    }
    runStore.markCancelRequested(id, "operator");
    runStore.recordTerminalReason(id, "operator");
    runStore.updateRunState(id, "cancelled");
    return { kind: "cancelled" };
  }
  const firing = runStore.getRoutineFiring(id);
  if (firing !== undefined) {
    if (TERMINAL_FIRING_STATES.has(firing.state)) {
      return { kind: "already-terminal", state: firing.state };
    }
    runStore.markRoutineFiringCancelRequested(id, "operator");
    runStore.completeRoutineFiring({
      cancelReason: "operator",
      id,
      outcome: reconcileRoutineOutcome({
        claim: null,
        commitsAhead: firing.commitsAhead,
        githubObservationAvailable: false,
        observedAction: null,
        provider: firing.provider,
        terminalReason: "cancelled",
        terminalState: "cancelled"
      }),
      state: "cancelled"
    });
    return { kind: "cancelled" };
  }
  return { kind: "not-found" };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return undefined;
  }
  return n;
}

function uptimeMs(startedAtMs: number, now: () => number): number {
  return Math.max(0, now() - startedAtMs);
}
