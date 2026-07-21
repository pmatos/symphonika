import { Readable } from "node:stream";

import { Hono, type Context } from "hono";

import type {
  IssuePollStatus,
  ProjectIssuePollReport
} from "../issue-polling.js";
import { emptyIssuePollStatus } from "../issue-polling.js";
import {
  DEFAULT_WATCHDOG_CONFIG,
  type RuntimeReloadStatus,
  type WatchdogConfig
} from "../reload.js";
import type { StatusSnapshot } from "../status.js";
import type {
  ListRunsFilter,
  RunArtifactKind,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";
import {
  buildWatchdogIdleStatus,
  buildWatchdogStatus
} from "../watchdog-status.js";
import { registerPages } from "./pages.js";

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

type PollNowFn = () => PollNowResult | Promise<PollNowResult>;

export type HttpAppOptions = {
  cancelRun?: CancelRunFn;
  dispatchRuntime?: {
    dispatching: boolean;
    inFlight?: number;
  };
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
  getRuns?: () => RunStatus[];
  getReloadStatus?: () => RuntimeReloadStatus;
  getScheduled?: () => Array<{
    dueAt: number;
    kind: "retry" | "continuation" | "state_advance" | "wait_park";
    runId: string;
  }>;
  getStatusSnapshot?: () => StatusSnapshot;
  getWatchdogConfig?: (
    projectName: string
  ) => Pick<WatchdogConfig, "enabled" | "graceMinutes">;
  issuePollStatus?: IssuePollStatus;
  now?: () => number;
  pollNow?: PollNowFn;
  runStore?: RunStore;
  startedAtMs?: number;
  stateRoot: string;
  version: string;
};

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
  provider_normalized: "application/x-ndjson"
};

const RUN_ARTIFACT_KINDS: ReadonlySet<string> = new Set(
  Object.keys(RUN_ARTIFACT_CONTENT_TYPES)
);

export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();
  const startedAtMs = options.startedAtMs ?? Date.now();
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

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "symphonika",
      version: options.version,
      stateRoot: options.stateRoot,
      uptimeMs: uptimeMs(startedAtMs, now)
    })
  );

  app.get("/api/status", (context) =>
    context.json({
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
      uptimeMs: uptimeMs(startedAtMs, now)
    })
  );

  app.post("/api/poll-now", async (context) => {
    if (options.pollNow === undefined) {
      return context.json(
        { error: "poll-now trigger unavailable", kind: "unavailable" },
        503
      );
    }

    return context.json(await Promise.resolve(options.pollNow()));
  });

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
      if (matches.length > 1) {
        return context.json(
          {
            error:
              "routine name is ambiguous; provide the project query parameter"
          },
          409
        );
      }
      const routine = matches[0]!;
      return context.json({
        firings: runStore.listRoutineFirings({
          project: routine.projectName,
          routineName: routine.name
        }),
        routine
      });
    });

    app.get("/api/runs/:id", (context) => {
      const detail = runStore.getRun(context.req.param("id"));
      if (detail === undefined) {
        return context.json({ error: "run not found" }, 404);
      }
      const events = runStore.listProviderEvents(detail.id, { limit: 100 });
      const { attempts, transitions, ...run } = detail;
      return context.json({
        attempts,
        events,
        run,
        transitions,
        watchdog: buildWatchdogStatus({
          config:
            options.getWatchdogConfig?.(run.project) ?? DEFAULT_WATCHDOG_CONFIG,
          nowMs: now(),
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

    app.post("/api/runs/:id/cancel", async (context) => {
      const id = context.req.param("id");
      const wantsRedirect = (
        context.req.header("content-type") ?? ""
      ).startsWith("application/x-www-form-urlencoded");

      if (cancelRun === undefined) {
        if (wantsRedirect) {
          return context.redirect(`/runs/${encodeURIComponent(id)}`, 303);
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
          return context.redirect(`/runs/${encodeURIComponent(id)}`, 303);
        }
        return context.json(outcome, 409);
      }
      if (wantsRedirect) {
        return context.redirect(`/runs/${encodeURIComponent(id)}`, 303);
      }
      return context.json(outcome, 200);
    });

    registerPages({
      app,
      ...(options.getStatusSnapshot === undefined
        ? {}
        : { getStatusSnapshot: options.getStatusSnapshot }),
      issuePollStatus,
      runStore,
      version: options.version
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

function cancelRunInStore(
  runStore: RunStore,
  runId: string
): ReturnType<CancelRunFn> {
  const detail = runStore.getRun(runId);
  if (detail === undefined) {
    return { kind: "not-found" };
  }
  if (TERMINAL_RUN_STATES.has(detail.state)) {
    return { kind: "already-terminal", state: detail.state };
  }
  runStore.markCancelRequested(runId, "operator");
  runStore.recordTerminalReason(runId, "operator");
  runStore.updateRunState(runId, "cancelled");
  return { kind: "cancelled" };
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
