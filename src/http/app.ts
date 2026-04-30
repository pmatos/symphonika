import { Hono } from "hono";

import type { IssuePollStatus } from "../issue-polling.js";
import { emptyIssuePollStatus } from "../issue-polling.js";
import type { RunStatus } from "../run-store.js";

export type HttpAppOptions = {
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
  stateRoot: string;
  version: string;
  startedAtMs?: number;
  now?: () => number;
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
      state: dispatchRuntime.dispatching ? "dispatching" : "idle",
      dispatching: dispatchRuntime.dispatching,
      stateRoot: options.stateRoot,
      uptimeMs: uptimeMs(startedAtMs, now)
    })
  );

  return app;
}

function uptimeMs(startedAtMs: number, now: () => number): number {
  return Math.max(0, now() - startedAtMs);
}
