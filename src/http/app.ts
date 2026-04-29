import { Hono } from "hono";

import type { IssuePollStatus } from "../issue-polling.js";
import { emptyIssuePollStatus } from "../issue-polling.js";
import type { RunStatus } from "../run-store.js";

export type HttpAppOptions = {
  dispatchRuntime?: {
    dispatching: boolean;
  };
  getRuns?: () => RunStatus[];
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
      candidateIssues: issuePollStatus.candidateIssues,
      filteredIssues: issuePollStatus.filteredIssues,
      issuePolling: {
        errors: issuePollStatus.errors,
        projects: issuePollStatus.projects
      },
      runs: getRuns(),
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
