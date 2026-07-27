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
import {
  createDaemonHeartbeat,
  isTickRecentEnoughForWatchdog,
  type DaemonHeartbeat
} from "./lifecycle/daemon-heartbeat.js";
import {
  createProcessScope,
  type ProcessScope
} from "./lifecycle/process-scope.js";
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
import { resolveWatchdogConfig, RuntimeConfigReloader } from "./reload.js";
import {
  INPUT_REQUIRED_LEGACY_BACKFILL_GRACE_MS,
  openRunStore,
  type RunState,
  type SyncProjectStateInput
} from "./run-store.js";
import { dispatchDueRoutines } from "./routines/dispatcher.js";
import type { RoutineFiringState } from "./routines/types.js";
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
  daemonHeartbeat?: DaemonHeartbeat;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi?: GitHubIssuesApi;
  host?: string;
  legacyInputRequiredRecheckDelayMs?: number;
  lifecyclePolicy?: LifecyclePolicy;
  logger?: Logger;
  port?: number;
  processScope?: ProcessScope;
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
  const processScope = options.processScope ?? createProcessScope();
  const daemonHeartbeat =
    options.daemonHeartbeat ?? createDaemonHeartbeat({ env, logger });
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
  const RUN_CLEANUP_PENDING_REASON = "leaked_active_run_cleanup_pending";
  const FIRING_CLEANUP_PENDING_REASON = "leaked_routine_firing_cleanup_pending";

  // Provider processes run in symphonika-providers.slice, a sibling of the
  // daemon's own service cgroup (docs/adr/0064), so a previous daemon
  // instance dying no longer tears its in-flight provider scopes down with
  // it — this sweep has to reap them itself. Every stopProviderScope call is
  // started together and awaited via Promise.all (not one-by-one) so N
  // leaked entries don't each add their own stopTimeoutMs delay in series
  // before serve() starts listening below. A row whose cleanup could not be
  // confirmed keeps a distinct terminal_reason instead of the plain leaked
  // reason, so runStore.findLeakedRuns()/findLeakedRoutineFirings() surface
  // it again on the next restart — see docs/adr/0064.
  const leakedRuns = runStore.findLeakedRuns();
  const runOutcomes = await Promise.all(
    leakedRuns.map(async (entry) => {
      // Only a run that reached "running" ever had a provider spawned —
      // queued/preparing_workspace orphans have no attempt, and therefore no
      // scope, to reap. A row re-swept from a prior pending sweep is already
      // 'stale', not 'running', but still had a live attempt to retry.
      // Attempts are ordered by attempt_number ascending, so the last one is
      // the attempt that was actually live when this daemon's predecessor
      // died.
      const hadLiveAttempt =
        entry.previousState === "running" ||
        entry.previousTerminalReason === RUN_CLEANUP_PENDING_REASON;
      if (!hadLiveAttempt) {
        return { confirmed: true, entry };
      }
      const attempts = runStore.listAttempts(entry.runId);
      const latestAttempt = attempts[attempts.length - 1];
      if (latestAttempt === undefined) {
        return { confirmed: true, entry };
      }
      const confirmed = await processScope.stopProviderScope({
        attempt: latestAttempt.attemptNumber,
        id: entry.runId
      });
      return { confirmed, entry };
    })
  );
  for (const { confirmed, entry } of runOutcomes) {
    if (confirmed) {
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
    } else {
      logger.warn(
        {
          issueNumber: entry.issueNumber,
          previousState: entry.previousState,
          project: entry.projectName,
          runId: entry.runId,
          terminalReason: RUN_CLEANUP_PENDING_REASON
        },
        "symphonika startup: orphaned run scope cleanup could not be confirmed"
      );
    }
  }
  runStore.markRunsStale(
    runOutcomes.map(({ confirmed, entry }) => ({
      previousState: entry.previousState,
      reason: confirmed ? "leaked_active_run" : RUN_CLEANUP_PENDING_REASON,
      runId: entry.runId
    }))
  );
  if (runOutcomes.length === 0) {
    logger.info({ count: 0 }, "symphonika startup: no orphaned runs found");
  } else {
    const byState: Partial<Record<RunState, number>> = {};
    for (const { entry } of runOutcomes) {
      byState[entry.previousState] = (byState[entry.previousState] ?? 0) + 1;
    }
    logger.info(
      { byState, count: runOutcomes.length },
      "symphonika startup: orphan sweep complete"
    );
  }

  const leakedFirings = runStore.findLeakedRoutineFirings();
  const firingOutcomes = await Promise.all(
    leakedFirings.map(async (entry) => {
      // Same gap as the regular-run sweep above, for the separate Routine
      // Firing subsystem (src/routines/dispatcher.ts). Firings never retry,
      // so their provider is always spawned as attempt 1 — no listAttempts
      // lookup needed here.
      const hadLiveAttempt =
        entry.previousState === "running" ||
        entry.previousTerminalReason === FIRING_CLEANUP_PENDING_REASON;
      if (!hadLiveAttempt) {
        return { confirmed: true, entry };
      }
      const confirmed = await processScope.stopProviderScope({
        attempt: 1,
        id: entry.firingId
      });
      return { confirmed, entry };
    })
  );
  for (const { confirmed, entry } of firingOutcomes) {
    if (confirmed) {
      logger.warn(
        {
          firingId: entry.firingId,
          previousState: entry.previousState,
          project: entry.projectName,
          routine: entry.routineName,
          terminalReason: "leaked_routine_firing"
        },
        "symphonika startup: marked orphaned routine firing as failed"
      );
    } else {
      logger.warn(
        {
          firingId: entry.firingId,
          previousState: entry.previousState,
          project: entry.projectName,
          routine: entry.routineName,
          terminalReason: FIRING_CLEANUP_PENDING_REASON
        },
        "symphonika startup: orphaned routine firing scope cleanup could not be confirmed"
      );
    }
  }
  runStore.markRoutineFiringsFailed(
    firingOutcomes.map(({ confirmed, entry }) => ({
      firingId: entry.firingId,
      previousState: entry.previousState,
      reason: confirmed
        ? "leaked_routine_firing"
        : FIRING_CLEANUP_PENDING_REASON
    }))
  );
  if (firingOutcomes.length > 0) {
    logger.info(
      { count: firingOutcomes.length },
      "symphonika startup: routine firing sweep complete"
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
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let lastTickAtMs: number | undefined;
  let tickLoopStartedAtMs: number | undefined;
  let polling = false;
  let scheduledWork = Promise.resolve();
  let lastPollErrorsKey = "";
  let lastPullRequestFollowupAt = Date.now();
  let lastWatchdogSampleAt = Date.now();
  let recomputeRoutineSchedulesFromNow = true;
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
      if (snapshot !== undefined) {
        // A brand-new routine declaration with no prior valid snapshot gets
        // a state = 'invalid' identity here (see docs/adr/0060). Reload
        // itself never touches the run store; this is the one call site
        // that has both the fresh snapshot and the store in scope.
        for (const invalid of snapshot.invalidRoutines) {
          if (invalid.name !== undefined) {
            runStore.upsertInvalidRoutineStub({
              name: invalid.name,
              projectName: invalid.projectName,
              sourcePath: invalid.path
            });
          }
        }
      }
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
        const recomputeSchedulesFromNow = recomputeRoutineSchedulesFromNow;
        recomputeRoutineSchedulesFromNow = false;
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
          recomputeSchedulesFromNow,
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
    // Reaching here means the event loop is still advancing. The watchdog
    // ping itself runs on its own independent timer (see watchdogTimer
    // below), not from here directly -- coupling it to the tick would
    // either kill a healthy daemon whose configured polling interval
    // exceeds WatchdogSec, or never ping at all before a config is loaded
    // (see docs/adr/0065). This timestamp is what that timer's liveness
    // gate reads to decide whether a hung tick should withhold the ping.
    lastTickAtMs = Date.now();
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
    tickLoopStartedAtMs ??= Date.now();
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
    "blocked",
    "input_required",
    "stale",
    "succeeded"
  ]);
  const TERMINAL_FIRING_STATES = new Set<RoutineFiringState>([
    "succeeded",
    "failed",
    "cancelled"
  ]);
  const cancelViaUi = async (
    id: string
  ): Promise<
    | { kind: "cancelled" }
    | { kind: "not-found" }
    | { kind: "already-terminal"; state: RunState | RoutineFiringState }
  > => {
    const detail = runStore.getRun(id);
    if (detail !== undefined) {
      if (TERMINAL_STATES.has(detail.state)) {
        return { kind: "already-terminal", state: detail.state };
      }
      runStore.markCancelRequested(id, "operator");
      await activeRuns.requestCancel(id, "operator");
      return { kind: "cancelled" };
    }
    const firing = runStore.getRoutineFiring(id);
    if (firing !== undefined) {
      if (TERMINAL_FIRING_STATES.has(firing.state)) {
        return { kind: "already-terminal", state: firing.state };
      }
      runStore.markRoutineFiringCancelRequested(id, "operator");
      await activeRuns.requestCancel(id, "operator");
      return { kind: "cancelled" };
    }
    return { kind: "not-found" };
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
    getLastTickAt: () => lastTickAtMs,
    getPollingIntervalMs: () => intervalMs,
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
    getPullRequestFollowupPolicy: () => runtimeConfig.pullRequestPolicy(),
    getRuns: () => runStore.listRuns(),
    getWatchdogConfig: (projectName) =>
      resolveWatchdogConfig(runtimeConfig.watchdogServiceConfig(), projectName),
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
      tickLoopStartedAtMs = Date.now();
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
  // Defense in depth: createDaemonHeartbeat's own notify functions already
  // swallow a failed systemd-notify call, but daemonHeartbeat is injectable
  // (options.daemonHeartbeat), so a caller-supplied implementation isn't
  // guaranteed to. Either call site rejecting would be severe -- notifyReady
  // is awaited directly, so it would abort startDaemon() itself, and
  // notifyWatchdog runs from a timer with nothing else to observe a
  // rejection -- so both are caught here too rather than trusting the
  // implementation.
  await daemonHeartbeat.notifyReady().catch((error: unknown) => {
    logger.warn(
      { err: error },
      "symphonika systemd-notify readiness call failed"
    );
  });
  if (daemonHeartbeat.watchdogPingIntervalMs !== undefined) {
    watchdogTimer = setInterval(() => {
      if (
        isTickRecentEnoughForWatchdog({
          configExists: state.configExists,
          effectiveIntervalMs: intervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
          lastTickAtMs,
          now: Date.now(),
          tickLoopStartedAtMs
        })
      ) {
        daemonHeartbeat.notifyWatchdog().catch((error: unknown) => {
          logger.warn(
            { err: error },
            "symphonika systemd-notify watchdog call failed"
          );
        });
      }
    }, daemonHeartbeat.watchdogPingIntervalMs);
    watchdogTimer.unref?.();
  }

  return {
    host,
    port,
    stateRoot: state.stateRoot,
    url,
    stop: async () => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      if (watchdogTimer !== undefined) {
        clearInterval(watchdogTimer);
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
