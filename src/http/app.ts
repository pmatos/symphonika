import { createReadStream, type ReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { Hono } from "hono";

import type { IssuePollStatus } from "../issue-polling.js";
import { emptyIssuePollStatus } from "../issue-polling.js";
import { isPathInside } from "../path-safety.js";
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
  getScheduled?: () => Array<{
    dueAt: number;
    kind: "retry" | "continuation";
    runId: string;
  }>;
  issuePollStatus?: IssuePollStatus;
  now?: () => number;
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

type FileColumn =
  | "issueSnapshotPath"
  | "metadataPath"
  | "normalizedLogPath"
  | "promptPath"
  | "rawLogPath";

const FILE_DESCRIPTORS: Record<
  string,
  { column: FileColumn; contentType: string }
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
  const cancelRun = options.cancelRun;

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
      const detail = runStore.getRun(id);
      if (detail === undefined) {
        return context.json({ error: "run not found" }, 404);
      }
      const fileKind = context.req.param("fileKind");
      const descriptor = FILE_DESCRIPTORS[fileKind];
      if (descriptor === undefined) {
        return context.json({ error: "unknown file kind" }, 404);
      }
      const filePath = detail[descriptor.column];
      if (typeof filePath !== "string" || filePath.length === 0) {
        return context.json({ error: "file not yet recorded" }, 404);
      }
      const evidenceRoot = path.join(
        path.resolve(options.stateRoot),
        "logs",
        "runs",
        id
      );
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
        headers: { "content-type": descriptor.contentType },
        status: 200
      });
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
      ...(options.runStore !== undefined ? { runStore: options.runStore } : {}),
      version: options.version
    } as Parameters<typeof registerPages>[0]);
  }

  return app;
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
