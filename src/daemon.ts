import { readFile } from "node:fs/promises";

import { serve, type ServerType } from "@hono/node-server";
import type { Logger } from "pino";
import pino from "pino";
import { parse } from "yaml";

import { createHttpApp, type PollNowResult } from "./http/app.js";
import {
  removeDaemonEndpoint,
  writeDaemonEndpoint
} from "./daemon-endpoint.js";
import type { GitHubIssuesApi } from "./issue-polling.js";
import {
  DEFAULT_GITHUB_ISSUES_API,
  emptyIssuePollStatus,
  pollConfiguredGitHubIssuesFromConfig,
  replaceIssuePollStatus
} from "./issue-polling.js";
import { ActiveRunRegistry } from "./lifecycle/active-runs.js";
import type {
  LifecyclePolicy,
  ScheduledWorkInput
} from "./lifecycle/active-runs.js";
import { reconcileActiveRuns } from "./lifecycle/reconcile.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "./lifecycle/run-controller.js";
import { detectStaleClaims } from "./lifecycle/stale-claims.js";
import type { AgentProviderRegistry } from "./provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import { runPullRequestFollowup } from "./pull-request-followup.js";
import { RuntimeConfigReloader } from "./reload.js";
import {
  openRunStore,
  type RunState,
  type SyncProjectStateInput
} from "./run-store.js";
import { resolveStateRoot } from "./state.js";
import { buildStatusSnapshot } from "./status.js";
import { VERSION } from "./version.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "./workspace.js";

export type StartDaemonOptions = {
  agentProviders?: AgentProviderRegistry;
  configPath?: string;
  createRunId?: () => string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi?: GitHubIssuesApi;
  host?: string;
  lifecyclePolicy?: LifecyclePolicy;
  logger?: Logger;
  port?: number;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
};

export type DaemonHandle = {
  host: string;
  port: number;
  stateRoot: string;
  url: string;
  stop: () => Promise<void>;
};

export async function startDaemon(
  options: StartDaemonOptions = {}
): Promise<DaemonHandle> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? pino({ level: resolveLogLevel(env) });
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  const stateRootOptions: Parameters<typeof resolveStateRoot>[0] = {};
  if (options.configPath !== undefined) {
    stateRootOptions.configPath = options.configPath;
  }
  if (options.cwd !== undefined) {
    stateRootOptions.cwd = options.cwd;
  }
  const state = resolveStateRoot(stateRootOptions);
  const issuePollStatus = emptyIssuePollStatus();
  const runStore = openRunStore({
    stateRoot: state.stateRoot
  });
  const sweptOnStartup = runStore.markLeakedRunsAsStale();
  if (sweptOnStartup.length > 0) {
    logger.info(
      { swept: sweptOnStartup },
      "symphonika startup: marked leaked runs as stale"
    );
  }
  const agentProviders = options.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
  const githubIssuesApi = options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const runtimeConfig = new RuntimeConfigReloader({
    configPath: state.configPath,
    logger
  });
  const activeRuns = new ActiveRunRegistry();
  const dispatchMutex = createAsyncMutex();
  const dispatchRuntime = {
    get dispatching(): boolean {
      return dispatchMutex.held;
    }
  };
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let scheduledWork = Promise.resolve();
  let lastPollErrorsKey = "";
  let lastPullRequestFollowupAt = Date.now();
  let pendingPollNow: Promise<PollNowResult> | undefined;
  const inflightDispatches = new Set<Promise<void>>();
  const projectsLoader = (): Promise<
    Map<string, RunControllerProjectConfig>
  > => {
    return Promise.resolve(runtimeConfig.projectsByName());
  };
  const providersLoader = (): Promise<RunControllerProvidersConfig> => {
    return Promise.resolve(runtimeConfig.providersConfig());
  };
  const enqueueScheduledWork = (work: () => Promise<void>): void => {
    scheduledWork = scheduledWork.then(work, work);
    void scheduledWork;
  };
  const runController = new RunController({
    activeRuns,
    agentProviders,
    configDir: state.configDir,
    githubIssuesApi,
    logger,
    projectsLoader,
    providersLoader,
    runStore,
    schedule: (item: ScheduledWorkInput) => {
      activeRuns.scheduleDelayed({
        delayMs: item.delayMs,
        fire: async () => {
          // Register the entire fire callback in inflightDispatches BEFORE
          // awaiting the mutex, so a shutdown that races with a freshly-fired
          // timer (while another dispatch still holds the mutex) cannot snapshot
          // the set early and miss this work.
          const promise = (async () => {
            await dispatchMutex.acquire();
            try {
              await item.fire();
            } catch (error) {
              logger.error({ err: error }, "symphonika scheduled work failed");
            } finally {
              dispatchMutex.release();
            }
          })();
          inflightDispatches.add(promise);
          void promise.finally(() => {
            inflightDispatches.delete(promise);
          });
          await promise;
        },
        issueNumber: item.issueNumber,
        kind: item.kind,
        projectName: item.projectName,
        runId: item.runId
      });
    },
    stateRoot: state.stateRoot,
    ...(options.createRunId === undefined
      ? {}
      : { createRunId: options.createRunId }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.lifecyclePolicy === undefined
      ? {}
      : { lifecyclePolicy: options.lifecyclePolicy }),
    ...(options.prepareIssueWorkspace === undefined
      ? {}
      : { prepareIssueWorkspace: options.prepareIssueWorkspace })
  });
  const refreshIssuePollStatus = async (): Promise<void> => {
    if (!state.configExists || polling) {
      return;
    }

    polling = true;
    try {
      const snapshot = await runtimeConfig.reload();
      const reloadStatus = runtimeConfig.getStatus();
      if (snapshot === undefined) {
        replaceIssuePollStatus(issuePollStatus, {
          candidateIssues: [],
          errors: reloadStatus.errors,
          filteredIssues: [],
          projects: []
        });
        return;
      }
      const nextStatus = await pollConfiguredGitHubIssuesFromConfig({
        config: snapshot.polling,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.githubIssuesApi === undefined
          ? {}
          : { githubIssuesApi: options.githubIssuesApi }),
        initialErrors: reloadStatus.errors
      });
      replaceIssuePollStatus(issuePollStatus, nextStatus);
      await persistProjectPollState(runStore, state.configPath, nextStatus);
    } catch (error) {
      issuePollStatus.errors = [errorMessage(error)];
      issuePollStatus.projects = [];
      issuePollStatus.candidateIssues = [];
      issuePollStatus.filteredIssues = [];
    } finally {
      polling = false;
    }
    const errorsKey = issuePollStatus.errors.join("\n");
    if (errorsKey !== lastPollErrorsKey) {
      if (issuePollStatus.errors.length > 0) {
        logger.warn(
          { errors: issuePollStatus.errors },
          "symphonika polling has errors; no issues will be dispatched"
        );
      } else {
        logger.info("symphonika polling errors cleared");
      }
      lastPollErrorsKey = errorsKey;
    }
  };
  const reconcile = async (): Promise<void> => {
    if (!state.configExists) {
      return;
    }
    const projects = runtimeConfig.projectsByName();
    if (projects.size === 0) {
      return;
    }
    try {
      await reconcileActiveRuns({
        activeRuns,
        env,
        githubIssuesApi,
        logger,
        pollStatus: issuePollStatus,
        projects,
        runStore
      });
    } catch (error) {
      logger.error({ err: error }, "symphonika reconcile failed");
    }

    if (dispatchMutex.held) {
      return;
    }

    try {
      await detectStaleClaims({
        activeRuns,
        env,
        githubIssuesApi,
        logger,
        pollStatus: issuePollStatus,
        projects,
        runStore
      });
    } catch (error) {
      logger.error({ err: error }, "symphonika stale-claim detection failed");
    }
  };
  const launchWork = (): void => {
    if (
      !state.configExists ||
      !hasRegisteredProviders(agentProviders) ||
      !dispatchMutex.tryAcquire()
    ) {
      return;
    }
    const promise = (async () => {
      try {
        const now = Date.now();
        let prResult: Awaited<ReturnType<typeof runPullRequestFollowup>>;
        if (
          runStore.hasPullRequestFollowupWork() &&
          now - lastPullRequestFollowupAt >= PR_FOLLOWUP_MIN_INTERVAL_MS
        ) {
          lastPullRequestFollowupAt = now;
          const snapshot = runtimeConfig.getSnapshot();
          prResult = await runPullRequestFollowup({
            configPath: state.configPath,
            env,
            githubIssuesApi,
            logger,
            ...(snapshot === undefined
              ? {}
              : { policy: snapshot.pullRequestPolicy }),
            projectsLoader,
            runController,
            runStore
          });
        } else {
          prResult = {
            action: "none",
            reason: "pull request follow-up throttled"
          };
        }
        if (prResult.action === "review_dispatch" || prResult.action === "merged") {
          logger.info(prResult, "symphonika PR follow-up action completed");
          return;
        }
        const result = await runController.dispatchOneFresh(issuePollStatus);
        if (result.dispatched === false) {
          logger.debug(
            { reason: result.reason },
            "symphonika dispatch skipped"
          );
        }
      } catch (error) {
        issuePollStatus.errors.push(errorMessage(error));
        logger.error({ err: error }, "symphonika dispatch failed");
      } finally {
        dispatchMutex.release();
      }
    })();
    inflightDispatches.add(promise);
    void promise.finally(() => {
      inflightDispatches.delete(promise);
    });
  };
  const tick = async (): Promise<void> => {
    await refreshIssuePollStatus();
    refreshPollingInterval();
    await reconcile();
    launchWork();
    logger.debug(
      {
        candidates: issuePollStatus.candidateIssues.length,
        dispatching: dispatchMutex.held,
        errors: issuePollStatus.errors.length,
        filtered: issuePollStatus.filteredIssues.length,
        projects: issuePollStatus.projects.length
      },
      "symphonika tick"
    );
  };
  const refreshPollingInterval = (): void => {
    if (!state.configExists) {
      return;
    }
    const nextIntervalMs = runtimeConfig.getSnapshot()?.pollingIntervalMs;
    if (nextIntervalMs === undefined) {
      return;
    }
    if (nextIntervalMs === intervalMs) {
      return;
    }
    intervalMs = nextIntervalMs;
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
    }
    pollTimer = setInterval(scheduleTick, intervalMs);
    pollTimer.unref?.();
    logger.info(
      { pollingIntervalMs: intervalMs },
      "symphonika polling interval reloaded"
    );
  };
  const scheduleTick = (): void => {
    enqueueScheduledWork(tick);
  };
  const pollNowSummary = (kind: PollNowResult["kind"]): PollNowResult => ({
    candidateIssues: issuePollStatus.candidateIssues.length,
    dispatching: dispatchMutex.held,
    errors: issuePollStatus.errors.length,
    filteredIssues: issuePollStatus.filteredIssues.length,
    issuePolling: {
      errors: issuePollStatus.errors.slice(),
      projects: issuePollStatus.projects.map((project) => ({ ...project }))
    },
    kind,
    state: dispatchMutex.held ? "dispatching" : "idle"
  });
  const triggerPollNow = (): Promise<PollNowResult> => {
    if (pendingPollNow !== undefined) {
      return pendingPollNow.then((result) => ({
        ...result,
        kind: "coalesced"
      }));
    }

    const queued = new Promise<PollNowResult>((resolve, reject) => {
      enqueueScheduledWork(async () => {
        try {
          await tick();
          resolve(pollNowSummary("queued"));
        } catch (error) {
          const reason =
            error instanceof Error ? error : new Error(errorMessage(error));
          reject(reason);
          throw reason;
        }
      });
    });
    pendingPollNow = queued.finally(() => {
      pendingPollNow = undefined;
    });
    return pendingPollNow;
  };

  let intervalMs: number | undefined;
  if (state.configExists) {
    await refreshIssuePollStatus();
    intervalMs = runtimeConfig.getSnapshot()?.pollingIntervalMs;
  }
  const TERMINAL_STATES = new Set<RunState>([
    "cancelled",
    "failed",
    "input_required",
    "stale",
    "succeeded"
  ]);
  const cancelViaUi = async (
    runId: string
  ): Promise<
    | { kind: "cancelled" }
    | { kind: "not-found" }
    | { kind: "already-terminal"; state: RunState }
  > => {
    const detail = runStore.getRun(runId);
    if (detail === undefined) {
      return { kind: "not-found" };
    }
    if (TERMINAL_STATES.has(detail.state)) {
      return { kind: "already-terminal", state: detail.state };
    }
    runStore.markCancelRequested(runId, "operator");
    await activeRuns.requestCancel(runId, "operator");
    return { kind: "cancelled" };
  };
  const app = createHttpApp({
    cancelRun: cancelViaUi,
    dispatchRuntime,
    getActiveRuns: () =>
      activeRuns.list().map((entry) => ({
        cancelReason: entry.cancelReason ?? null,
        cancelRequested: entry.cancelRequested,
        issueNumber: entry.issueNumber,
        projectName: entry.projectName,
        runId: entry.runId
      })),
    getRuns: () => runStore.listRuns(),
    getScheduled: () => activeRuns.peekDelayed(),
    getStatusSnapshot: () =>
      buildStatusSnapshot({
        configPath: state.configPath,
        issuePollStatus,
        reloadStatus: runtimeConfig.getStatus(),
        runStore,
        stateRoot: state.stateRoot
      }),
    issuePollStatus,
    getReloadStatus: () => runtimeConfig.getStatus(),
    pollNow: triggerPollNow,
    runStore,
    stateRoot: state.stateRoot,
    version: VERSION
  });

  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port: requestedPort
  });
  await waitForListening(server);
  const port = resolveListeningPort(server, requestedPort);
  const url = `http://${host}:${port}`;
  try {
    await writeDaemonEndpoint(state.stateRoot, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      stateRoot: state.stateRoot,
      url
    });
  } catch (error) {
    await rollbackDaemonStartup(server, runStore, logger);
    throw error;
  }
  if (state.configExists) {
    await reconcile();
    launchWork();
    if (intervalMs !== undefined) {
      pollTimer = setInterval(scheduleTick, intervalMs);
      pollTimer.unref?.();
    }
  }

  logger.info(
    {
      configPath: state.configPath,
      host,
      port,
      stateRoot: state.stateRoot
    },
    "symphonika daemon started"
  );

  return {
    host,
    port,
    stateRoot: state.stateRoot,
    url,
    stop: async () => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      activeRuns.cancelAll();
      await scheduledWork;
      await Promise.allSettled(Array.from(inflightDispatches));
      try {
        await stopServer(server, logger);
        await removeDaemonEndpoint(state.stateRoot);
      } finally {
        runStore.close();
      }
    }
  };
}

function persistProjectPollState(
  runStore: ReturnType<typeof openRunStore>,
  configPath: string,
  status: import("./issue-polling.js").IssuePollStatus
): Promise<void> {
  return readProjectStateInputs(configPath, status).then((projects) => {
    runStore.syncProjectStates(projects);
    for (const project of status.projects) {
      runStore.recordProjectPollOutcome({
        candidateIssues: project.candidateIssues ?? 0,
        error: project.error ?? null,
        fetchedIssues: project.fetchedIssues,
        filteredIssues: project.filteredIssues ?? 0,
        ok: project.ok,
        projectName: project.name
      });
    }
  });
}

async function readProjectStateInputs(
  configPath: string,
  status: import("./issue-polling.js").IssuePollStatus
): Promise<SyncProjectStateInput[]> {
  const reports = new Map(
    status.projects.map((project) => [project.name, project])
  );
  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8")) ?? {};
  } catch {
    return status.projects.map(projectStateInputFromReport);
  }
  if (!isRecord(raw) || !Array.isArray(raw["projects"])) {
    return status.projects.map(projectStateInputFromReport);
  }
  const inputs: SyncProjectStateInput[] = [];
  raw["projects"].forEach((project, index) => {
    if (!isRecord(project) || typeof project["name"] !== "string") {
      return;
    }
    const report = reports.get(project["name"]);
    if (report !== undefined) {
      inputs.push(projectStateInputFromReport(report));
      return;
    }
    const errors = status.errors.filter((error) =>
      error.startsWith(`projects.${index}.`)
    );
    inputs.push({
      name: project["name"],
      validationMessage: errors.length === 0 ? null : errors.join("; "),
      validationState: errors.length === 0 ? "valid" : "invalid",
      weight: rawProjectWeight(project["weight"])
    });
  });
  return inputs;
}

function projectStateInputFromReport(
  project: import("./issue-polling.js").ProjectIssuePollReport
): SyncProjectStateInput {
  return {
    name: project.name,
    validationMessage: project.ok
      ? null
      : (project.error ?? "project poll failed"),
    validationState: project.ok ? "valid" : "invalid",
    weight: project.weight
  };
}

function rawProjectWeight(weight: unknown): number | undefined {
  return typeof weight === "number" && Number.isInteger(weight) && weight > 0
    ? weight
    : undefined;
}

function waitForListening(server: ServerType): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function resolveListeningPort(server: ServerType, fallbackPort: number): number {
  const address = server.address();

  if (typeof address === "object" && address !== null) {
    return address.port;
  }

  return fallbackPort;
}

function stopServer(server: ServerType, logger: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      logger.info("symphonika daemon stopped");
      resolve();
    });
  });
}

async function rollbackDaemonStartup(
  server: ServerType,
  runStore: ReturnType<typeof openRunStore>,
  logger: Logger
): Promise<void> {
  try {
    await stopServer(server, logger);
  } catch (error) {
    logger.warn(
      { error: errorMessage(error) },
      "symphonika daemon startup rollback failed to stop server"
    );
  }

  try {
    runStore.close();
  } catch (error) {
    logger.warn(
      { error: errorMessage(error) },
      "symphonika daemon startup rollback failed to close run store"
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRegisteredProviders(
  providers: AgentProviderRegistry | undefined
): providers is AgentProviderRegistry {
  return providers !== undefined && Object.values(providers).some(Boolean);
}

export function resolveLogLevel(env: NodeJS.ProcessEnv): string {
  return env["PINO_LOG_LEVEL"] ?? env["LOG_LEVEL"] ?? "info";
}

const PR_FOLLOWUP_MIN_INTERVAL_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AsyncMutex = {
  acquire: () => Promise<void>;
  readonly held: boolean;
  release: () => void;
  tryAcquire: () => boolean;
};

function createAsyncMutex(): AsyncMutex {
  const waiters: Array<() => void> = [];
  let locked = false;
  return {
    acquire(): Promise<void> {
      if (!locked) {
        locked = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    get held(): boolean {
      return locked;
    },
    release(): void {
      const next = waiters.shift();
      if (next !== undefined) {
        next();
        return;
      }
      locked = false;
    },
    tryAcquire(): boolean {
      if (locked) {
        return false;
      }
      locked = true;
      return true;
    }
  };
}
