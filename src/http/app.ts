import { createReadStream, type ReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { Hono, type Context } from "hono";

import type {
  IssuePollStatus,
  ProjectIssuePollReport
} from "../issue-polling.js";
import { emptyIssuePollStatus } from "../issue-polling.js";
import { isPathInside } from "../path-safety.js";
import type { RuntimeReloadStatus } from "../reload.js";
import type { StatusSnapshot } from "../status.js";
import type {
  ListRunsFilter,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";
import { registerPages } from "./pages.js";

export type CancelRunFn = (
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

export type HttpAppOptions = {
  cancelRun?: CancelRunFn;
  dispatchRuntime?: {
    dispatching: boolean;
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
    kind: "retry" | "continuation" | "state_advance";
    runId: string;
  }>;
  getStatusSnapshot?: () => StatusSnapshot;
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
  "succeeded",
  "cancelled",
  "stale"
]);

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "cancelled",
  "failed",
  "input_required",
  "stale",
  "succeeded"
]);

type FileColumn =
  | "issueSnapshotPath"
  | "metadataPath"
  | "normalizedLogPath"
  | "promptPath"
  | "rawLogPath";

type RunFileDescriptor = { column: FileColumn; contentType: string };

const FILE_DESCRIPTORS: Record<
  string,
  RunFileDescriptor
> = {
  "issue-snapshot": {
    column: "issueSnapshotPath",
    contentType: "application/json; charset=utf-8"
  },
  metadata: {
    column: "metadataPath",
    contentType: "application/json; charset=utf-8"
  },
  "normalized-log": {
    column: "normalizedLogPath",
    contentType: "application/x-ndjson"
  },
  prompt: {
    column: "promptPath",
    contentType: "text/markdown; charset=utf-8"
  },
  "raw-log": {
    column: "rawLogPath",
    contentType: "application/x-ndjson"
  }
};

const LOG_FILE_DESCRIPTORS: Record<string, RunFileDescriptor> = {
  "issue-snapshot.json": {
    column: "issueSnapshotPath",
    contentType: "application/json; charset=utf-8"
  },
  "prompt-metadata.json": {
    column: "metadataPath",
    contentType: "application/json; charset=utf-8"
  },
  "prompt.md": {
    column: "promptPath",
    contentType: "text/markdown; charset=utf-8"
  },
  "provider.normalized.jsonl": {
    column: "normalizedLogPath",
    contentType: "application/x-ndjson"
  },
  "provider.raw.jsonl": {
    column: "rawLogPath",
    contentType: "application/x-ndjson"
  }
};

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
      active: getActiveRuns(),
      candidateIssues: issuePollStatus.candidateIssues,
      filteredIssues: issuePollStatus.filteredIssues,
      issuePolling: {
        errors: issuePollStatus.errors,
        projects: issuePollStatus.projects
      },
      projectStates: runStore?.listProjectStates() ?? [],
      reload: options.getReloadStatus?.() ?? emptyReloadStatus(),
      runs: getRuns(),
      scheduled: getScheduled(),
      service: "symphonika",
      staleIssues: issuePollStatus.filteredIssues.filter((entry) =>
        entry.issue.labels.includes("sym:stale")
      ),
      state: dispatchRuntime.dispatching ? "dispatching" : "idle",
      dispatching: dispatchRuntime.dispatching,
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
        transitions
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
      const fileKind = context.req.param("fileKind");
      const descriptor = FILE_DESCRIPTORS[fileKind];
      if (descriptor === undefined) {
        return context.json({ error: "unknown file kind" }, 404);
      }
      return streamRunFile(context, runStore, options.stateRoot, id, descriptor);
    });

    app.get("/logs/runs/:id/:fileName", async (context) => {
      const id = context.req.param("id");
      const fileName = context.req.param("fileName");
      const descriptor = LOG_FILE_DESCRIPTORS[fileName];
      if (descriptor !== undefined) {
        return streamRunFile(context, runStore, options.stateRoot, id, descriptor);
      }
      const workflowGraphRequest = parseWorkflowGraphFileName(fileName);
      if (workflowGraphRequest !== undefined) {
        return streamWorkflowGraphFile(
          context,
          runStore,
          options.stateRoot,
          id,
          workflowGraphRequest
        );
      }
      return context.json({ error: "unknown file" }, 404);
    });

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

async function streamRunFile(
  context: Context,
  runStore: RunStore,
  stateRoot: string,
  id: string,
  descriptor: RunFileDescriptor
): Promise<Response> {
  const detail = runStore.getRun(id);
  if (detail === undefined) {
    return context.json({ error: "run not found" }, 404);
  }
  const filePath = detail[descriptor.column];
  if (typeof filePath !== "string" || filePath.length === 0) {
    return context.json({ error: "file not yet recorded" }, 404);
  }
  return streamEvidenceFile(context, stateRoot, id, filePath, descriptor.contentType);
}

type WorkflowGraphRequest = { attemptNumber: number | null };

function parseWorkflowGraphFileName(
  fileName: string
): WorkflowGraphRequest | undefined {
  if (fileName === "workflow-graph.json") {
    return { attemptNumber: null };
  }
  const match = /^workflow-graph\.attempt-(\d+)\.json$/.exec(fileName);
  if (match === null) {
    return undefined;
  }
  return { attemptNumber: Number(match[1]) };
}

async function streamWorkflowGraphFile(
  context: Context,
  runStore: RunStore,
  stateRoot: string,
  id: string,
  request: WorkflowGraphRequest
): Promise<Response> {
  const detail = runStore.getRun(id);
  if (detail === undefined) {
    return context.json({ error: "run not found" }, 404);
  }
  const attemptNumber = request.attemptNumber ?? 1;
  const attemptPath = detail.attempts.find(
    (attempt) => attempt.attemptNumber === attemptNumber
  )?.workflowGraphPath;
  const filePath = (attemptPath !== undefined && attemptPath.length > 0)
    ? attemptPath
    : request.attemptNumber === null
      ? detail.workflowGraphPath
      : "";
  if (filePath.length === 0) {
    return context.json({ error: "file not yet recorded" }, 404);
  }
  return streamEvidenceFile(
    context,
    stateRoot,
    id,
    filePath,
    "application/json; charset=utf-8"
  );
}

async function streamEvidenceFile(
  context: Context,
  stateRoot: string,
  id: string,
  filePath: string,
  contentType: string
): Promise<Response> {
  const evidenceRoot = path.join(path.resolve(stateRoot), "logs", "runs", id);
  if (!isPathInside(filePath, evidenceRoot)) {
    return context.json({ error: "file not available" }, 404);
  }
  try {
    await access(filePath);
  } catch {
    return context.json({ error: "file not found" }, 404);
  }
  const stream: ReadStream = createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { "content-type": contentType },
    status: 200
  });
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
