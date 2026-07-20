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
  DEFAULT_POLLING_INTERVAL_MS,
  emptyIssuePollStatus,
  pollConfiguredGitHubIssuesFromConfig,
  readConfiguredPollingIntervalMs,
  replaceIssuePollStatus
} from "./issue-polling.js";
import { ActiveRunRegistry } from "./lifecycle/active-runs.js";
import { createAsyncMutex } from "./lifecycle/async-mutex.js";
import type {
  LifecyclePolicy,
  ScheduledWorkInput
} from "./lifecycle/active-runs.js";
import {
  reconcileActiveRuns,
  reconcileWaitingRuns
} from "./lifecycle/reconcile.js";
import { reconcileWatchdog } from "./lifecycle/watchdog.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "./lifecycle/run-controller.js";
import { detectStaleClaims } from "./lifecycle/stale-claims.js";
import type { AgentProviderRegistry } from "./provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import {
  runPullRequestFollowup,
  type PullRequestFollowupPolicy
} from "./pull-request-followup.js";
import { RuntimeConfigReloader } from "./reload.js";
import {
  INPUT_REQUIRED_LEGACY_BACKFILL_GRACE_MS,
  openRunStore,
  type RunState,
  type SyncProjectStateInput
} from "./run-store.js";
import { dispatchDueRoutines } from "./routines/dispatcher.js";
import type {
  PreparedRoutineWorkspace,
  PrepareRoutineWorkspaceInput
} from "./routines/workspace.js";
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
  legacyInputRequiredRecheckDelayMs?: number;
  lifecyclePolicy?: LifecyclePolicy;
  logger?: Logger;
  port?: number;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  createRoutineFiringId?: () => string;
  prepareRoutineWorkspace?: (
    input: PrepareRoutineWorkspaceInput
  ) => Promise<PreparedRoutineWorkspace>;
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
  stateRootOptions.env = env;
  const state = resolveStateRoot(stateRootOptions);
  const issuePollStatus = emptyIssuePollStatus();
  const runStore = openRunStore({
    stateRoot: state.stateRoot
  });
  const failedLegacyInputRequired = runStore.failLegacyInputRequiredRuns();
  if (failedLegacyInputRequired.length > 0) {
    logger.info(
      { migrated: failedLegacyInputRequired },
      "symphonika startup: failed legacy input_required runs"
    );
  }
  // Rows updated within the grace window at startup are skipped by the
  // initial sweep, so schedule one more pass after the window elapses to
  // catch rows that an outgoing daemon wrote moments before restart.
  const legacyRecheckDelayMs =
    options.legacyInputRequiredRecheckDelayMs ??
    INPUT_REQUIRED_LEGACY_BACKFILL_GRACE_MS * 2;
  let legacyRecheckTimer: ReturnType<typeof setTimeout> | undefined;
  if (legacyRecheckDelayMs > 0) {
    legacyRecheckTimer = setTimeout(() => {
      legacyRecheckTimer = undefined;
      try {
        const migrated = runStore.failLegacyInputRequiredRuns();
        if (migrated.length > 0) {
          logger.info(
            { migrated },
            "symphonika legacy input_required recheck: failed remaining runs"
          );
        }
      } catch (error) {
        logger.error(
          { err: error },
          "symphonika legacy input_required recheck failed"
        );
      }
    }, legacyRecheckDelayMs);
    legacyRecheckTimer.unref?.();
  }
  const sweptOnStartup = runStore.markLeakedRunsAsStale();
  for (const entry of sweptOnStartup) {
    logger.warn(
      {
        issueNumber: entry.issueNumber,
        previousState: entry.previousState,
        project: entry.projectName,
        runId: entry.runId,
        terminalReason: "leaked_active_run"
      },
      "symphonika startup: marked orphaned run as stale"
    );
  }
  if (sweptOnStartup.length === 0) {
    logger.info({ count: 0 }, "symphonika startup: no orphaned runs found");
  } else {
    const byState: Partial<Record<RunState, number>> = {};
    for (const entry of sweptOnStartup) {
      byState[entry.previousState] = (byState[entry.previousState] ?? 0) + 1;
    }
    logger.info(
      { byState, count: sweptOnStartup.length },
      "symphonika startup: orphan sweep complete"
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
  // After Slice 1 narrowing, dispatchMutex is held only during the brief
  // claim section, so consumers that want "is a provider run active" should
  // read inFlight instead. The legacy dispatching boolean is preserved as a
  // derived alias (true iff inFlight > 0) so existing clients keep working.
  // See ADR 0052.
  const dispatchRuntime = {
    get dispatching(): boolean {
      return activeRuns.countInFlight() > 0;
    },
    get inFlight(): number {
      return activeRuns.countInFlight();
    }
  };
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let scheduledWork = Promise.resolve();
  let lastPollErrorsKey = "";
  let lastPullRequestFollowupAt = Date.now();
  let lastWatchdogSampleAt = Date.now();
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
  const pullRequestPolicyLoader = (): Promise<PullRequestFollowupPolicy> => {
    return Promise.resolve(runtimeConfig.pullRequestPolicy());
  };
  const globalConcurrencyLoader = (): Promise<{
    maxInFlight: number | undefined;
  }> => {
    return Promise.resolve(runtimeConfig.globalConcurrency());
  };
  const enqueueScheduledWork = (work: () => Promise<void>): void => {
    scheduledWork = scheduledWork.then(work, work);
    void scheduledWork;
  };
  const runController = new RunController({
    activeRuns,
    agentProviders,
    configDir: state.configDir,
    // Share the daemon's mutex so RunController's narrowed claim section
    // and reconcile/stale-claim gates (which consult held/tryAcquire) all
    // serialize on the same primitive. See ADR 0052.
    dispatchMutex,
    githubIssuesApi,
    globalConcurrencyLoader,
    logger,
    projectsLoader,
    providersLoader,
    pullRequestPolicyLoader,
    runStore,
    schedule: (item: ScheduledWorkInput) => {
      activeRuns.scheduleDelayed({
        delayMs: item.delayMs,
        fire: async () => {
          // The scheduled fire callback no longer wraps a mutex acquire — each
          // execute* path (retry / continuation / state_advance / wait_park)
          // acquires the (shared) mutex internally over its own narrowed
          // critical section. inflightDispatches still tracks the full fire
          // promise so shutdown drain works.
          const promise = (async () => {
            try {
              await item.fire();
            } catch (error) {
              logger.error({ err: error }, "symphonika scheduled work failed");
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
    const serviceConfig = runtimeConfig.getSnapshot();
    if (serviceConfig === undefined) {
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

    // Serialize against scheduled wait_park callbacks (and any other
    // scheduled work that mutates run rows). Scheduled callbacks acquire
    // `dispatchMutex` before firing; if one is in flight, skip this tick's
    // wait reconciliation and let the callback handle the row it owns —
    // the next tick will re-pick anything else. Acquiring the mutex here
    // also prevents two concurrent waiting-run readers from both deciding
    // to advance the same row.
    if (dispatchMutex.tryAcquire()) {
      try {
        await reconcileWaitingRuns({
          logger,
          runController,
          runStore
        });
      } catch (error) {
        logger.error({ err: error }, "symphonika waiting reconcile failed");
      } finally {
        dispatchMutex.release();
      }
    }

    try {
      const watchdog = serviceConfig.watchdog;
      const nowMs = Date.now();
      if (
        watchdog.enabled &&
        nowMs - lastWatchdogSampleAt >= watchdog.sampleIntervalSeconds * 1_000
      ) {
        lastWatchdogSampleAt = nowMs;
        await reconcileWatchdog({
          activeRuns,
          config: watchdog,
          evidenceIgnoreForProject: (projectName) => {
            const workflow = projects.get(projectName)?.workflow;
            return workflow !== undefined && "expandedWorkflow" in workflow
              ? workflow.evidence.ignore
              : [];
          },
          logger,
          now: () => new Date(nowMs),
          projects: serviceConfig.projects,
          runStore
        });
      }
    } catch (error) {
      logger.error({ err: error }, "symphonika watchdog reconcile failed");
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
    if (!state.configExists || !hasRegisteredProviders(agentProviders)) {
      return;
    }
    // The mutex is acquired INSIDE runController.dispatchOneFresh (and inside
    // dispatchReviewFollowup) around the narrowed claim section. launchWork
    // itself is re-entrant per tick; provider event streaming runs outside
    // the mutex so two ticks' worth of fresh dispatches can overlap. See
    // ADR 0052.
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
        if (
          prResult.action === "review_dispatch" ||
          prResult.action === "merged"
        ) {
          logger.info(prResult, "symphonika PR follow-up action completed");
          return;
        }
        const routineResult = await dispatchDueRoutines({
          activeRuns,
          agentProviders,
          configDir: state.configDir,
          ...(options.createRoutineFiringId === undefined
            ? {}
            : { createFiringId: options.createRoutineFiringId }),
          env,
          globalConcurrency: runtimeConfig.globalConcurrency(),
          githubIssuesApi,
          logger,
          ...(options.prepareRoutineWorkspace === undefined
            ? {}
            : { prepareRoutineWorkspace: options.prepareRoutineWorkspace }),
          projects: runtimeConfig.projectsByName(),
          providersConfig: runtimeConfig.providersConfig(),
          runStore,
          stateRoot: state.stateRoot
        });
        if (routineResult.fired.length > 0) {
          logger.info(
            { fired: routineResult.fired.length },
            "symphonika routine firing action completed"
          );
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
        dispatching: dispatchRuntime.dispatching,
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
    const nextIntervalMs =
      runtimeConfig.getSnapshot()?.pollingIntervalMs ??
      intervalMs ??
      DEFAULT_POLLING_INTERVAL_MS;
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
    dispatching: dispatchRuntime.dispatching,
    errors: issuePollStatus.errors.length,
    filteredIssues: issuePollStatus.filteredIssues.length,
    issuePolling: {
      errors: issuePollStatus.errors.slice(),
      projects: issuePollStatus.projects.map((project) => ({ ...project }))
    },
    kind,
    state: dispatchRuntime.dispatching ? "dispatching" : "idle"
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
    intervalMs =
      runtimeConfig.getSnapshot()?.pollingIntervalMs ??
      (await readConfiguredPollingIntervalMs(state.configPath));
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
    getConcurrency: () => {
      const { maxInFlight } = runtimeConfig.globalConcurrency();
      const perProject: Array<{
        inFlight: number;
        maxInFlight: number;
        projectName: string;
      }> = [];
      for (const project of runtimeConfig.projectsByName().values()) {
        perProject.push({
          inFlight: activeRuns.countInFlightByProject(project.name),
          maxInFlight: project.max_in_flight ?? 1,
          projectName: project.name
        });
      }
      return {
        global: {
          inFlight: activeRuns.countInFlight(),
          maxInFlight: maxInFlight ?? null
        },
        perProject
      };
    },
    getRuns: () => runStore.listRuns(),
    getScheduled: () => activeRuns.peekDelayed(),
    getStatusSnapshot: () =>
      buildStatusSnapshot({
        configDir: state.configDir,
        configPath: state.configPath,
        issuePollStatus,
        projectsByName: runtimeConfig.projectsByName(),
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
      if (legacyRecheckTimer !== undefined) {
        clearTimeout(legacyRecheckTimer);
        legacyRecheckTimer = undefined;
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

function resolveListeningPort(
  server: ServerType,
  fallbackPort: number
): number {
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
