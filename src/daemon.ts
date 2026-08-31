import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

import { serve, type ServerType } from "@hono/node-server";
import type { Logger } from "pino";
import pino from "pino";
import { parse } from "yaml";

import {
  createHttpApp,
  type FireRoutineResult,
  type MergePullRequestResult,
  type PollNowResult,
  type WriteIssueLabelsResult
} from "./http/app.js";
import {
  removeDaemonEndpoint,
  writeDaemonEndpoint
} from "./daemon-endpoint.js";
import type {
  GitHubIssuesApi,
  GitHubRepositoryIdentity,
  PollingProjectConfig
} from "./issue-polling.js";
import {
  backoffUntil,
  DEFAULT_GITHUB_ISSUES_API,
  DEFAULT_POLLING_INTERVAL_MS,
  emptyIssuePollStatus,
  mergeIssuePollStatus,
  pollConfiguredGitHubIssuesFromConfig,
  projectPollIdentityKey,
  rateLimitedTokens,
  readConfiguredPollingIntervalMs,
  replaceIssuePollStatus,
  resolveEnvBackedValue,
  tryAddLabelsToIssue,
  tryGetPullRequestFollowupState,
  tryMergePullRequest,
  tryRemoveLabelsFromIssue
} from "./issue-polling.js";
import { interpretPullRequest } from "./pull-request-state.js";
import { ActiveRunRegistry, CANCEL_REASONS } from "./lifecycle/active-runs.js";
import { createAsyncMutex } from "./lifecycle/async-mutex.js";
import { resolveProjectMaxInFlight } from "./lifecycle/concurrency-capacity.js";
import {
  createHostPressureGate,
  type HostPressureSample
} from "./lifecycle/host-pressure.js";
import { sweepProviderScratch } from "./lifecycle/provider-scratch.js";
import { resolveToken } from "./lifecycle/token.js";
import {
  createDaemonHeartbeat,
  isTickRecentEnoughForSystemdWatchdog,
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
  type RunControllerProvidersConfig,
  type WorkflowSnapshot
} from "./lifecycle/run-controller.js";
import { resumeShutdownCancelledRuns } from "./lifecycle/shutdown-resume.js";
import { detectStaleClaims } from "./lifecycle/stale-claims.js";
import { pollConfiguredGitHubPullRequestsFromConfig } from "./pull-request-polling.js";
import type { AgentProviderRegistry } from "./provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import { createSmtpNotificationSink } from "./notifications/smtp.js";
import { DaemonHealthNotifier } from "./notifications/daemon-health.js";
import { NotificationDeliveryTracker } from "./notifications/delivery-tracker.js";
import { IssueRunNotificationCoordinator } from "./notifications/issue-run.js";
import type { NotificationSink } from "./notifications/types.js";
import {
  runPullRequestFollowup,
  type PullRequestFollowupPolicy
} from "./pull-request-followup.js";
import {
  computeReferencedRealPaths,
  resolveConfinedWritePath
} from "./path-safety.js";
import { resolveWatchdogConfig, RuntimeConfigReloader } from "./reload.js";
import {
  INPUT_REQUIRED_LEGACY_BACKFILL_GRACE_MS,
  openRunStore,
  type ProjectState,
  type ProjectSnapshotRepository,
  type RunState,
  type SyncProjectStateInput
} from "./run-store.js";
import {
  dispatchDueRoutines,
  fireRoutineNow,
  synchronizeRoutineTargets
} from "./routines/dispatcher.js";
import type { RoutineFiringState } from "./routines/types.js";
import type {
  PreparedRoutineWorkspace,
  PrepareRoutineWorkspaceInput
} from "./routines/workspace.js";
import {
  pruneRoutineWorkspaces as pruneRoutineWorkspacesReal,
  type RoutineWorkspaceRetentionPolicy
} from "./routines/workspace-retention.js";
import { defaultScriptPath } from "./service.js";
import { resolveStateRoot } from "./state.js";
import { buildStatusSnapshot } from "./status.js";
import {
  createDefaultUpdateOps,
  UpdateCoordinator
} from "./update/coordinator.js";
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
  notificationSink?: NotificationSink;
  port?: number;
  processScope?: ProcessScope;
  // Overrides the PSI counter read behind the host-pressure gate (ADR 0088).
  // Production leaves this unset and reads /proc/pressure; tests inject a
  // reading so a stalled host is reproducible off a healthy machine.
  readHostPressure?: () => Promise<HostPressureSample>;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  createRoutineFanoutId?: () => string;
  createRoutineFiringId?: () => string;
  prepareRoutineWorkspace?: (
    input: PrepareRoutineWorkspaceInput
  ) => Promise<PreparedRoutineWorkspace>;
  pruneRoutineWorkspaces?: typeof pruneRoutineWorkspacesReal;
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
  const pruneRoutineWorkspaces =
    options.pruneRoutineWorkspaces ?? pruneRoutineWorkspacesReal;
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
  // Updated alongside issuePollStatus on each poll tick (persistProjectPollState);
  // left at its last-known value on a reload that fails outright, matching
  // issuePollStatus's own precedent for that path.
  let projectModes = new Map<string, "dispatch" | "routine_host">();
  const runStore = openRunStore({
    stateRoot: state.stateRoot
  });
  const recoveredRunNotifications =
    runStore.releaseInterruptedRunNotifications();
  if (recoveredRunNotifications > 0) {
    logger.warn(
      { recovered: recoveredRunNotifications },
      "symphonika startup: released interrupted issue Run notification claims"
    );
  }
  const recoveredRoutineFanoutNotifications =
    runStore.releaseInterruptedRoutineFanoutNotifications();
  if (recoveredRoutineFanoutNotifications > 0) {
    logger.warn(
      { recovered: recoveredRoutineFanoutNotifications },
      "symphonika startup: released interrupted routine fan-out notification claims"
    );
  }
  const failedLegacyInputRequired = runStore.failLegacyInputRequiredRuns();
  if (failedLegacyInputRequired.length > 0) {
    logger.info(
      { migrated: failedLegacyInputRequired },
      "symphonika startup: failed legacy input_required runs"
    );
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
  // A crashed or SIGKILLed daemon never runs its attempts' cleanup, so
  // provider scratch trees can survive it. No attempt of THIS instance owns
  // one yet, so every directory found here is stale. See ADR 0088.
  const scratchSweep = await sweepProviderScratch(state.stateRoot);
  if (scratchSweep.removed.length > 0 || scratchSweep.failures.length > 0) {
    logger.info(
      {
        failures: scratchSweep.failures.length,
        removed: scratchSweep.removed.length
      },
      "symphonika startup: provider scratch sweep complete"
    );
  }
  const agentProviders = options.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
  const githubIssuesApi = options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const runtimeConfig = new RuntimeConfigReloader({
    configPath: state.configPath,
    logger
  });
  const issueRunNotifications = new IssueRunNotificationCoordinator({
    createSink: (config) =>
      options.notificationSink ?? createSmtpNotificationSink(config, { env }),
    logger,
    resolveConfig: () => runtimeConfig.emailConfig(),
    runStore
  });
  const daemonHealthNotifications = new DaemonHealthNotifier({
    createSink: (config) =>
      options.notificationSink ?? createSmtpNotificationSink(config, { env }),
    logger,
    resolveConfig: () => runtimeConfig.emailConfig()
  });
  const routineNotificationDeliveries = new NotificationDeliveryTracker(logger);
  const activeRuns = new ActiveRunRegistry();
  // Drain gate read by launchWork and the fireRoutine HTTP handler (ADR
  // 0079): blocks NEW dispatch admission only, never cancels in-flight
  // work. Constructed before launchWork below so both readers close over
  // the same instance.
  const updateCoordinator = new UpdateCoordinator({
    activeRuns,
    currentVersion: VERSION,
    daemonHealthNotifier: daemonHealthNotifications,
    isSelfUpdateEnabled: () => runtimeConfig.selfUpdateEnabled(),
    logger,
    ops: createDefaultUpdateOps({
      env,
      homeDir: homedir(),
      scriptPath: defaultScriptPath(),
      stateRoot: state.stateRoot
    })
  });
  const dispatchMutex = createAsyncMutex();
  // launchWork is explicitly re-entrant per tick (see comment at its
  // definition), so a retention pass that outlives one polling interval
  // would otherwise overlap with the next tick's pass, running concurrent
  // `git worktree remove`/`prune`/branch-delete against the same cache.
  // Narrow skip-if-in-flight guard, consistent with ADR 0052's per-operation
  // (not whole-tick) locking scope.
  const retentionMutex = createAsyncMutex();
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
  let systemdWatchdogTimer: ReturnType<typeof setInterval> | undefined;
  let lastTickAtMs: number | undefined;
  let lastTickAtMonotonicMs: number | undefined;
  let nextPollAtMonotonicMs: number | undefined;
  let tickLoopStartedAtMonotonicMs: number | undefined;
  let polling = false;
  // Guards the PR-enrichment fire-and-forget below (refreshIssuePollStatus)
  // against overlapping itself; deliberately separate from `polling` --
  // its own GraphQL round-trips must not gate issue dispatch, so it isn't
  // awaited by refreshIssuePollStatus and needs its own reentrancy check.
  let prPolling = false;
  // Keyed by resolved GitHub token -- shared between issue polling and PR
  // polling below (both draw on the same per-token rate-limit budget for a
  // given project, so a rate-limit error from either one backs off both),
  // but scoped per token rather than globally: SPEC.md §6 lets each
  // project's tracker reference an independent $VAR_NAME, and GitHub
  // tracks rate-limit budgets per token, not per Symphonika deployment.
  // Values are only ever used as opaque Map keys, never logged (the
  // resolved token is a secret -- see SPEC.md §6's redaction requirement).
  const githubBackoffUntilByToken = new Map<string, number>();
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
  // One PSI sample per configured interval, shared by fresh dispatch, retry
  // re-admission and Routine Firings so a single tick cannot dispatch on two
  // different readings of the same host. The policy is read through the
  // reloader, so a config change takes effect without rebuilding the gate.
  // See ADR 0088.
  const hostPressureGate = createHostPressureGate({
    policy: () => runtimeConfig.hostPressurePolicy(),
    ...(options.readHostPressure === undefined
      ? {}
      : { readPressure: options.readHostPressure })
  });
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
    hostPressureGate,
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
  // Shared by the poll tick (refreshIssuePollStatus) and #307's editor save
  // routes (triggerReload, below): reload symphonika.yml, record the
  // outcome (health notifier + #305's change-event publish), and upsert
  // invalid-routine stubs. Deliberately does not touch `polling` -- an
  // editor save's reload is a distinct, cheap, file-scoped operation with no
  // shared mutable state to race against a concurrent poll tick, so it runs
  // even while one is in flight rather than silently no-oping.
  const reloadConfigAndRecordOutcome = async () => {
    const snapshot = await runtimeConfig.reload();
    const reloadStatus = runtimeConfig.getStatus();
    // Deliberately NOT `|| reloadStatus.errors.length > 0`: per-routine
    // declaration errors (ADR 0060) land in this same `errors` array but are
    // isolated by design -- they get their own "Routine declarations became
    // invalid" alert via observeInvalidRoutines below, and must not also
    // trip the whole-snapshot "Service Config reload failed" alert or make
    // an unrelated editor save report a spurious reload failure. Every
    // genuine whole-config error already forces usingLastKnownGood=true or
    // snapshot===undefined, so those two conditions alone correctly capture
    // "the reload itself is broken."
    const reloadBroken =
      snapshot === undefined || reloadStatus.usingLastKnownGood === true;
    daemonHealthNotifications.observeReload({
      broken: reloadBroken,
      errors: reloadStatus.errors
    });
    runStore.publishReloadOutcome({
      errors: reloadStatus.errors,
      ok: !reloadBroken
    });
    daemonHealthNotifications.observeInvalidRoutines(
      snapshot?.invalidRoutines ?? []
    );
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
    return { errors: reloadStatus.errors, ok: !reloadBroken, snapshot };
  };

  // A clean poll result is never allowed to clear an active window -- only
  // to let it lapse on its own once `nowMs` passes it (self-cleaning here,
  // with a one-time log on the transition, per token). The issue poll and
  // the fire-and-forget PR poll each call engageGithubBackoff with their
  // own results; a PR poll started before backoff was engaged can still be
  // in flight when a later tick's issue poll engages it, and that stale
  // poll's own eventual clean result doesn't prove the limit that triggered
  // the newer window has recovered. Proactively clearing on any clean
  // result would let that stale result erase a still-current window.
  const isGithubBackoffActive = (nowMs: number, token: string): boolean => {
    const until = githubBackoffUntilByToken.get(token);
    if (until === undefined) {
      return false;
    }
    if (nowMs >= until) {
      githubBackoffUntilByToken.delete(token);
      logger.info(
        "symphonika GitHub API backoff window elapsed for one credential"
      );
      return false;
    }
    return true;
  };

  // Engages (or extends) the backoff window for every rate-limited token
  // found in `reports` (each project's own poll report, e.g.
  // IssuePollStatus.projects / PullRequestPollStatus.projects). Logs only
  // on a given token's transition, not on every tick, so a sustained
  // outage doesn't spam the log.
  const engageGithubBackoff = (
    reports: ReadonlyArray<{
      error?: string;
      name: string;
      ok: boolean;
      repository: GitHubRepositoryIdentity;
    }>,
    projects: readonly PollingProjectConfig[],
    env: NodeJS.ProcessEnv
  ): void => {
    const nowMs = Date.now();
    for (const token of rateLimitedTokens(reports, projects, env)) {
      const wasActive = isGithubBackoffActive(nowMs, token);
      githubBackoffUntilByToken.set(token, backoffUntil(nowMs));
      if (!wasActive) {
        logger.warn(
          { backoffUntilMs: githubBackoffUntilByToken.get(token) },
          "symphonika GitHub API rate limited; backing off polling for one credential"
        );
      }
    }
  };

  // A project whose token can't be resolved (e.g. an unset $VAR_NAME) is
  // always pollable here -- pollProject reports that failure itself,
  // unrelated to rate-limit backoff. Structurally typed on tracker alone
  // (rather than the full PollingProjectConfig) so the fresh-claim boundary
  // re-check (ADR 0083) below can reuse it for a DispatchProjectConfig too.
  const isProjectPollable = (
    project: { tracker: PollingProjectConfig["tracker"] },
    env: NodeJS.ProcessEnv,
    nowMs: number
  ): boolean => {
    const token = resolveEnvBackedValue(project.tracker.token, env);
    return token === undefined || !isGithubBackoffActive(nowMs, token);
  };

  // Splits `projects` into those whose resolved token isn't currently
  // backing off (pollable now) and the rest (currently skipped).
  const partitionProjectsForPolling = (
    projects: readonly PollingProjectConfig[],
    env: NodeJS.ProcessEnv,
    nowMs: number
  ): PollingProjectConfig[] => {
    return projects.filter((project) => isProjectPollable(project, env, nowMs));
  };

  const refreshIssuePollStatus = async (): Promise<void> => {
    if (!state.configExists || polling) {
      return;
    }

    polling = true;
    try {
      const { errors, snapshot } = await reloadConfigAndRecordOutcome();
      if (snapshot === undefined) {
        replaceIssuePollStatus(issuePollStatus, {
          candidateIssues: [],
          errors,
          filteredIssues: [],
          projects: []
        });
        return;
      }
      const env = options.env ?? process.env;
      // Excludes any project whose resolved token is currently backing off
      // -- config reload above still runs every tick regardless (so an
      // interval_ms edit or a fixed token still takes effect promptly),
      // and a project excluded here keeps its issuePollStatus entries and
      // persisted snapshot exactly as the last successful poll produced
      // them, same as pollProject's own "leave prior snapshot untouched"
      // contract on a failed project -- mergeIssuePollStatus below carries
      // those entries forward instead of a bare replace.
      const pollableForIssues = partitionProjectsForPolling(
        snapshot.polling.projects,
        env,
        Date.now()
      );
      // Always called, even with zero pollable projects (a cheap no-op
      // loop in that case) -- persistProjectPollState below must still run
      // every tick regardless, since it also derives projectModes (the
      // Routine Host dashboard state) from the full config file via
      // readProjectStateInputs, independent of which projects were
      // actually polled for GitHub issues this tick.
      const nextStatus = await pollConfiguredGitHubIssuesFromConfig({
        config: { ...snapshot.polling, projects: pollableForIssues },
        env,
        ...(options.githubIssuesApi === undefined
          ? {}
          : { githubIssuesApi: options.githubIssuesApi }),
        initialErrors: errors
      });
      engageGithubBackoff(nextStatus.projects, pollableForIssues, env);
      // A project can be pollable at tick start but skipped by the issue
      // poll after an earlier project sharing its token hits a rate limit.
      // Reports identify the name and repository actually attempted, so
      // deriving these keys from them lets mergeIssuePollStatus carry an
      // intra-tick skip's prior entries forward just like a window-backed-off
      // skip, even when declarations share a Project name.
      const polledIssueProjectKeys = new Set(
        nextStatus.projects.map((project) =>
          projectPollIdentityKey(project.name, project.repository)
        )
      );
      // The full enabled configured set (not just pollableForIssues) so an
      // enabled project skipped for backoff keeps its prior status, while a
      // project disabled, removed, or renamed by a config reload -- absent
      // from this set -- has its stale carried-over entries dropped rather
      // than retained forever; see mergeIssuePollStatus.
      const configuredIssueProjectKeys = new Set(
        snapshot.polling.projects
          .filter((project) => project.disabled !== true)
          .map((project) =>
            projectPollIdentityKey(project.name, project.tracker)
          )
      );
      // Name-keyed runtime lookup lets the last declaration win. Persisted
      // project state and issue snapshots use that same name key, so only
      // that declaration may replace them or expose dispatch candidates; a
      // shadowed declaration can still contribute diagnostics to the
      // in-memory poll status.
      const selectedIssueProjectKeysByName = new Map(
        snapshot.polling.projects.map((project) => [
          project.name,
          projectPollIdentityKey(project.name, project.tracker)
        ])
      );
      const skippedIssueProjectKeys = new Set(
        Array.from(configuredIssueProjectKeys).filter(
          (key) => !polledIssueProjectKeys.has(key)
        )
      );
      replaceIssuePollStatus(
        issuePollStatus,
        mergeIssuePollStatus(
          issuePollStatus,
          nextStatus,
          polledIssueProjectKeys,
          configuredIssueProjectKeys,
          selectedIssueProjectKeysByName
        )
      );
      // Persisted with the polled subset only (not the merged status).
      // Poll outcome and issue-snapshot writes iterate only fresh reports;
      // project-state sync still reconciles the full raw config, but retains
      // the prior validation result for identities skipped by backoff.
      projectModes = await persistProjectPollState(
        runStore,
        state.configPath,
        nextStatus,
        skippedIssueProjectKeys,
        selectedIssueProjectKeysByName,
        snapshot.projects
      );

      // #309: a cheap per-repo PR list, persisted alongside the issue
      // snapshot above (ADR 0077). Fire-and-forget, not awaited: its
      // GraphQL round-trips must not delay the issue-dispatch tick this
      // function's own callers (reconcile/launchWork, and startup before
      // the HTTP server is created) are waiting on. `prPolling` keeps two
      // ticks' worth from overlapping if a poll runs long; a PR-poll
      // failure must not blank out issuePollStatus, which dispatch
      // eligibility depends on, so it's isolated in its own try/catch same
      // as before. Re-partitioned rather than reusing pollableForIssues --
      // the issue poll above may have just engaged backoff for a token,
      // and that project's PR poll must be excluded from this same tick
      // too, not just the next one. Unlike the issue poll, genuinely
      // skipped (not called with an empty list) when nothing is pollable,
      // since PR-poll persistence has no routine-host-adjacent side effect
      // to preserve.
      const pollableForPrs = partitionProjectsForPolling(
        snapshot.polling.projects,
        env,
        Date.now()
      );
      if (!prPolling && pollableForPrs.length > 0) {
        prPolling = true;
        void (async () => {
          try {
            const pullRequestStatus =
              await pollConfiguredGitHubPullRequestsFromConfig({
                config: { ...snapshot.polling, projects: pollableForPrs },
                env,
                githubIssuesApi
              });
            engageGithubBackoff(
              pullRequestStatus.projects,
              pollableForPrs,
              env
            );
            persistProjectPullRequestPollState(runStore, pullRequestStatus);
            if (pullRequestStatus.errors.length > 0) {
              logger.warn(
                { errors: pullRequestStatus.errors },
                "symphonika PR polling has errors"
              );
            }
          } catch (error) {
            logger.warn(
              { error: errorMessage(error) },
              "symphonika PR polling failed"
            );
          } finally {
            prPolling = false;
          }
        })();
      }
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
    issueRunNotifications.schedulePending();
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
    //
    // Also gated on the self-update drain flag: reEvaluateWaitingRun can
    // reserve a slot and spawn a fresh provider run, the same admission
    // launchWork and fireRoutine already refuse while draining. Skipping
    // this tick's wait reconciliation while draining closes that gap —
    // any still-waiting rows are simply picked up again once draining
    // clears.
    if (!updateCoordinator.isDrainRequested() && dispatchMutex.tryAcquire()) {
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

    // Recovers the Issues the previous daemon's graceful shutdown cancelled
    // (#594). Gated on the drain flag for the same reason wait
    // reconciliation is — the resume it schedules ends in a fresh provider
    // run — and skipped while the mutex is held so its liveness reads
    // (isIssueReserved) never race a claim in progress, exactly as
    // detectStaleClaims below does. The pass only registers scheduled work,
    // so it must not hold the mutex itself: each resumed advance acquires it
    // over its own narrowed claim section when the timer fires.
    if (!updateCoordinator.isDrainRequested() && !dispatchMutex.held) {
      try {
        await resumeShutdownCancelledRuns({
          activeRuns,
          env,
          githubIssuesApi,
          logger,
          pollStatus: issuePollStatus,
          projects,
          runController,
          runStore
        });
      } catch (error) {
        logger.error({ err: error }, "symphonika shutdown resume failed");
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
        const watchdogTerminations: Array<{
          issueNumber: number;
          projectName: string;
          runId: string;
        }> = [];
        await reconcileWatchdog({
          activeRuns,
          config: watchdog,
          evidenceIgnoreForProject: (projectName) => {
            const workflow = projects.get(projectName)?.workflow;
            return workflow !== undefined && "expandedWorkflow" in workflow
              ? workflow.evidence.ignore
              : undefined;
          },
          logger,
          now: () => new Date(nowMs),
          onTerminated: (run) => {
            watchdogTerminations.push(run);
          },
          projects: serviceConfig.projects,
          runStore
        });
        daemonHealthNotifications.notifyWatchdogTerminations(
          watchdogTerminations
        );
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
    if (
      !state.configExists ||
      !hasRegisteredProviders(agentProviders) ||
      updateCoordinator.isDrainRequested()
    ) {
      return;
    }
    // The mutex is acquired INSIDE runController.dispatchOneFresh (and inside
    // dispatchReviewFollowup) around the narrowed claim section. launchWork
    // itself is re-entrant per tick; provider event streaming runs outside
    // the mutex so two ticks' worth of fresh dispatches can overlap. See
    // ADR 0052.
    const promise = (async () => {
      try {
        const retentionSnapshot = runtimeConfig.getSnapshot();
        if (
          retentionSnapshot?.routineWorkspaceRetention.enabled === true &&
          retentionMutex.tryAcquire()
        ) {
          try {
            await runAutomaticRoutineWorkspaceRetention({
              logger,
              policy: retentionSnapshot.routineWorkspaceRetention,
              pruneRoutineWorkspaces,
              runStore
            });
          } finally {
            retentionMutex.release();
          }
        }
        const now = Date.now();
        let prResult: Awaited<ReturnType<typeof runPullRequestFollowup>>;
        if (
          runStore.hasPullRequestFollowupWork() &&
          now - lastPullRequestFollowupAt >= PR_FOLLOWUP_MIN_INTERVAL_MS
        ) {
          lastPullRequestFollowupAt = now;
          const snapshot = runtimeConfig.getSnapshot();
          const projectsByName =
            snapshot === undefined
              ? undefined
              : new Map(
                  snapshot.polling.projects.map((project) => [
                    project.name,
                    project
                  ])
                );
          prResult = await runPullRequestFollowup({
            configPath: state.configPath,
            env,
            githubIssuesApi,
            logger,
            ...(snapshot === undefined || projectsByName === undefined
              ? {}
              : {
                  onProjectRateLimited: ({ error, projectName }) => {
                    const project = projectsByName.get(projectName);
                    if (project === undefined) {
                      return;
                    }
                    engageGithubBackoff(
                      [
                        {
                          error: errorMessage(error),
                          name: projectName,
                          ok: false,
                          repository: {
                            owner: project.tracker.owner,
                            repo: project.tracker.repo
                          }
                        }
                      ],
                      snapshot.polling.projects,
                      env
                    );
                  },
                  policy: snapshot.pullRequestPolicy,
                  shouldPollProject: (projectName: string) => {
                    const project = projectsByName.get(projectName);
                    return (
                      project !== undefined &&
                      isProjectPollable(project, env, Date.now())
                    );
                  }
                }),
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
          ...(options.createRoutineFanoutId === undefined
            ? {}
            : { createFanoutId: options.createRoutineFanoutId }),
          ...(options.createRoutineFiringId === undefined
            ? {}
            : { createFiringId: options.createRoutineFiringId }),
          env,
          globalConcurrency: runtimeConfig.globalConcurrency(),
          githubIssuesApi,
          hostPressure: hostPressureGate.current(),
          logger,
          notification: {
            createSink: (config) =>
              options.notificationSink ??
              createSmtpNotificationSink(config, { env }),
            deliveries: routineNotificationDeliveries,
            // Resolved at delivery time so a reload mid-firing is honored
            // for that firing's own notification (ADR 0067).
            resolveConfig: () => runtimeConfig.emailConfig()
          },
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
        const snapshot = runtimeConfig.getSnapshot();
        const dispatchableProjectNames = new Set(
          partitionProjectsForPolling(
            snapshot?.polling.projects ?? [],
            env,
            Date.now()
          ).map((project) => project.name)
        );
        // ADR 0083 deliberately carries backed-off Projects' candidates in
        // issuePollStatus for status and snapshot continuity. Keep that
        // shared evidence intact, but do not let a carried-over candidate
        // cross the fresh-claim boundary while its credential is backing
        // off: the claim itself is another GitHub label write.
        const result = await runController.dispatchOneFresh(
          {
            ...issuePollStatus,
            candidateIssues: issuePollStatus.candidateIssues.filter(
              (candidate) => dispatchableProjectNames.has(candidate.project)
            )
          },
          {
            // The fire-and-forget PR poll can engage backoff after the
            // candidate view above is formed while dispatchOneFresh is still
            // loading config or workflow state. Re-check from inside its
            // narrowed claim section immediately before sym:claimed.
            isClaimAllowed: (project) =>
              isProjectPollable(project, env, Date.now())
          }
        );
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
    // Sample before reconcile/launchWork so every admission decision this
    // tick makes -- Routine Firings included, which read the cached verdict
    // synchronously -- sees the same reading. See ADR 0088.
    await refreshHostPressure();
    await reconcile();
    launchWork();
    updateCoordinator.tick();
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
    // Reaching here means the event loop is still advancing. The systemd
    // watchdog ping itself runs on its own independent timer (see
    // systemdWatchdogTimer below), not from here directly -- coupling it to
    // the tick would either kill a healthy daemon whose configured polling
    // interval exceeds WatchdogSec, or never ping at all before a config is
    // loaded (see docs/adr/0065). This timestamp is what that timer's
    // liveness gate reads to decide whether a hung tick should withhold the
    // ping. Keep the externally exposed epoch timestamp separate from the
    // monotonic timestamp used for elapsed-time liveness decisions.
    lastTickAtMs = Date.now();
    lastTickAtMonotonicMs = performance.now();
  };
  // A /proc read cannot be allowed to abort the tick: an unreadable counter
  // already degrades to "admit" inside the gate, and anything unexpected
  // here must leave the daemon ticking rather than stalling dispatch.
  const refreshHostPressure = async (): Promise<void> => {
    try {
      await hostPressureGate.refresh();
    } catch (error) {
      logger.warn({ err: error }, "symphonika host pressure sample failed");
    }
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
    nextPollAtMonotonicMs = performance.now() + intervalMs;
    tickLoopStartedAtMonotonicMs ??= performance.now();
    logger.info(
      { pollingIntervalMs: intervalMs },
      "symphonika polling interval reloaded"
    );
  };
  const scheduleTick = (): void => {
    if (intervalMs !== undefined) {
      nextPollAtMonotonicMs = performance.now() + intervalMs;
    }
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
  const shutdownController = new AbortController();
  const app = createHttpApp({
    cancelRun: cancelViaUi,
    // Shares RunController's own claim-serialization primitive so
    // clear-stale-claim can't wipe a claim landing mid-check (ADR 0052) --
    // same mutex detectStaleClaims already gates its own automatic sweep
    // behind (dispatchMutex.held, above).
    claimMutex: dispatchMutex,
    dispatchRuntime,
    fireRoutine: async (request): Promise<FireRoutineResult> => {
      // fireRoutineNow is a second admission path outside launchWork's
      // drain check above -- a manual `symphonika fire-now` during a
      // self-update drain must be refused too, or drain could wait forever
      // on work the drain gate never saw coming (ADR 0079).
      if (updateCoordinator.isDrainRequested()) {
        return {
          error: "self-update is draining in-flight work before cutover",
          kind: "refused",
          reason: "self_update_draining"
        };
      }
      // Manual firing is an explicit admission boundary, so resolve it from
      // a freshly reloaded effective snapshot rather than waiting for the
      // next daemon tick. Synchronize that snapshot through the same path as
      // scheduled dispatch before reading the persisted Routine Target; this
      // preserves precise disabled/invalid/rejection states while ensuring
      // an accepted firing uses the current prompt and provider declaration.
      await reloadConfigAndRecordOutcome();
      const projects = runtimeConfig.projectsByName();
      synchronizeRoutineTargets({ projects, runStore });
      // Re-sample for the same reason the snapshot is reloaded above: a
      // manual fire is its own admission boundary and must not ride the tick
      // cadence. `current()` applies no TTL, so between ticks it can hand
      // back a verdict older than sample_interval_seconds (30s polling vs 10s
      // sampling by default) — long enough for a host to become stalled and
      // still admit. refresh() is TTL-guarded and collapses concurrent reads,
      // so this costs at most one /proc read on a rare operator-driven path.
      // Awaited HERE, before the drain re-check below, so the verdict is
      // resolved to a value and the re-check remains the last thing between
      // this await and the synchronous claim section. See ADR 0088.
      const hostPressure = await hostPressureGate.refresh();
      // The reload awaits the reloader mutex and filesystem reads. A
      // self-update drain can begin during that gap, so repeat the admission
      // check immediately before the synchronous claim section.
      if (updateCoordinator.isDrainRequested()) {
        return {
          error: "self-update is draining in-flight work before cutover",
          kind: "refused",
          reason: "self_update_draining"
        };
      }
      const result = fireRoutineNow({
        activeRuns,
        agentProviders,
        configDir: state.configDir,
        ...(options.createRoutineFiringId === undefined
          ? {}
          : { createFiringId: options.createRoutineFiringId }),
        env,
        globalConcurrency: runtimeConfig.globalConcurrency(),
        githubIssuesApi,
        hostPressure,
        logger,
        notification: {
          createSink: (config) =>
            options.notificationSink ??
            createSmtpNotificationSink(config, { env }),
          deliveries: routineNotificationDeliveries,
          // Resolved at delivery time so a reload mid-firing is honored
          // for that firing's own notification (ADR 0067).
          resolveConfig: () => runtimeConfig.emailConfig()
        },
        ...(options.prepareRoutineWorkspace === undefined
          ? {}
          : { prepareRoutineWorkspace: options.prepareRoutineWorkspace }),
        projects,
        providersConfig: runtimeConfig.providersConfig(),
        request,
        runStore,
        stateRoot: state.stateRoot
      });
      if (result.kind !== "accepted") {
        return result;
      }
      const { completion, ...response } = result;
      inflightDispatches.add(completion);
      void completion.finally(() => {
        inflightDispatches.delete(completion);
      });
      return response;
    },
    getActiveRuns: () =>
      activeRuns.list().map((entry) => ({
        cancelReason: entry.cancelReason ?? null,
        cancelRequested: entry.cancelRequested,
        issueNumber: entry.issueNumber,
        projectName: entry.projectName,
        runId: entry.runId
      })),
    getLastTickAt: () => lastTickAtMs,
    getLastTickAtMonotonic: () => lastTickAtMonotonicMs,
    getNextPollAtMonotonic: () => nextPollAtMonotonicMs,
    getPollingIntervalMs: () => intervalMs,
    getTickLoopStartedAtMonotonic: () => tickLoopStartedAtMonotonicMs,
    monotonicNow: () => performance.now(),
    getHostPressure: () => {
      const verdict = hostPressureGate.current();
      const sample = hostPressureGate.lastSample();
      return {
        admitted: verdict.admitted,
        ...(verdict.admitted
          ? {}
          : {
              observed: verdict.observed,
              reason: verdict.reason,
              resource: verdict.resource,
              threshold: verdict.threshold
            }),
        ...(sample === undefined
          ? {}
          : {
              sample: {
                fullAvg60: sample.fullAvg60,
                unavailable: sample.unavailable
              }
            })
      };
    },
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
          maxInFlight: resolveProjectMaxInFlight(project.max_in_flight),
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
    getConfigPath: () => state.configPath,
    getProjectWorkflowPath: (projectName) => {
      const workflow = runtimeConfig
        .projectsByName()
        .get(projectName)?.workflow;
      if (workflow === undefined || !("expandedWorkflow" in workflow)) {
        return undefined;
      }
      return { format: workflow.format, path: workflow.path };
    },
    getProjectRepoAliases: (projectName) => {
      const tracker = runtimeConfig.projectsByName().get(projectName)?.tracker;
      if (tracker === undefined) {
        return [projectName];
      }
      const aliases: string[] = [];
      for (const project of runtimeConfig.projectsByName().values()) {
        if (
          project.tracker?.owner === tracker.owner &&
          project.tracker.repo === tracker.repo
        ) {
          aliases.push(project.name);
        }
      }
      return aliases;
    },
    getProjectRequiredLabels: (projectName) =>
      runtimeConfig.projectsByName().get(projectName)?.issue_filters
        ?.labels_all ?? [],
    getProjectRepo: (projectName) => {
      const tracker = runtimeConfig.projectsByName().get(projectName)?.tracker;
      return tracker === undefined
        ? undefined
        : { owner: tracker.owner, repo: tracker.repo };
    },
    mergePullRequest: async (input): Promise<MergePullRequestResult> => {
      const project = runtimeConfig.projectsByName().get(input.projectName);
      if (project?.tracker === undefined) {
        return {
          error: `projects.${input.projectName}.tracker is not configured`,
          freshState: undefined,
          ok: false
        };
      }
      const repositoryError = verifySnapshotRepositoryBinding({
        action: "merging",
        currentRepository: {
          owner: project.tracker.owner,
          repo: project.tracker.repo
        },
        renderedRepository: input.snapshotRepository,
        resolveSnapshotRepository: () =>
          runStore.getProjectPullRequestSnapshotRepository(
            input.projectName,
            input.prNumber
          ),
        subjectLabel: `pull request #${input.prNumber}`
      });
      if (repositoryError !== undefined) {
        return { error: repositoryError, freshState: undefined, ok: false };
      }
      const token = resolveToken(project.tracker.token, env);
      if (token === undefined) {
        return {
          error: `projects.${input.projectName}.tracker.token is not available`,
          freshState: undefined,
          ok: false
        };
      }
      const repository = {
        owner: project.tracker.owner,
        repo: project.tracker.repo,
        token
      };

      // The project's own configured merge method (default squash, see
      // DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY), not a hardcoded "merge" --
      // repos configured to disallow merge commits (Allow merge commits
      // unchecked, the common case for a squash-only default) rejected
      // every dashboard merge with a 405 regardless of what the automatic
      // PR-follow-up merge (which already used this policy) was doing.
      const mergeMethod = runtimeConfig.pullRequestPolicy().merge.method;
      let mergeError: string | undefined;
      try {
        const merged = await tryMergePullRequest(githubIssuesApi, {
          ...repository,
          ...(input.expectedHeadSha === undefined
            ? {}
            : { expectedHeadSha: input.expectedHeadSha }),
          method: mergeMethod,
          pullNumber: input.prNumber
        });
        if (!merged) {
          return {
            error: "merging is not supported by the configured GitHub API",
            freshState: undefined,
            ok: false
          };
        }
      } catch (error) {
        mergeError = errorMessage(error);
      }

      // Re-derive the PR's actual state after every attempted merge
      // (AC8: "the PR's displayed state is re-derived rather than
      // assumed merged") — a thrown merge error doesn't necessarily mean
      // nothing changed (e.g. GitHub could reject the response but have
      // already applied the merge), and a reported success is not proof
      // either. `undefined` here means the re-fetch itself failed or is
      // unsupported, distinct from a fetch that succeeded with an
      // unresolved/unknown field.
      let freshState;
      try {
        const followup = await tryGetPullRequestFollowupState(githubIssuesApi, {
          ...repository,
          pullNumber: input.prNumber
        });
        freshState =
          followup === null || followup === undefined
            ? undefined
            : interpretPullRequest(followup);
      } catch {
        freshState = undefined;
      }

      runStore.recordPullRequestMergeAttempt({
        error: mergeError ?? null,
        freshTrackingState: freshState?.trackingState ?? null,
        method: mergeMethod,
        ok: mergeError === undefined,
        prNumber: input.prNumber,
        projectName: input.projectName
      });

      return mergeError === undefined
        ? { freshState, ok: true }
        : { error: mergeError, freshState, ok: false };
    },
    writeIssueLabels: async (input): Promise<WriteIssueLabelsResult> => {
      const project = runtimeConfig.projectsByName().get(input.projectName);
      if (project?.tracker === undefined) {
        return {
          error: `projects.${input.projectName}.tracker is not configured`,
          ok: false
        };
      }
      const subjectLabel = input.kind === "issue" ? "issue" : "pull request";
      const repositoryError = verifySnapshotRepositoryBinding({
        action: "writing labels",
        currentRepository: {
          owner: project.tracker.owner,
          repo: project.tracker.repo
        },
        renderedRepository: input.snapshotRepository,
        resolveSnapshotRepository: () =>
          input.kind === "issue"
            ? runStore.getProjectIssueSnapshotRepository(
                input.projectName,
                input.subjectNumber
              )
            : runStore.getProjectPullRequestSnapshotRepository(
                input.projectName,
                input.subjectNumber
              ),
        subjectLabel: `${subjectLabel} #${input.subjectNumber}`
      });
      if (repositoryError !== undefined) {
        return { error: repositoryError, ok: false };
      }
      const token = resolveToken(project.tracker.token, env);
      if (token === undefined) {
        return {
          error: `projects.${input.projectName}.tracker.token is not available`,
          ok: false
        };
      }
      const repository = {
        owner: project.tracker.owner,
        repo: project.tracker.repo,
        token
      };
      try {
        if (input.add.length > 0) {
          const added = await tryAddLabelsToIssue(githubIssuesApi, {
            ...repository,
            issueNumber: input.subjectNumber,
            labels: input.add
          });
          if (!added) {
            return {
              error:
                "adding labels is not supported by the configured GitHub API",
              ok: false
            };
          }
        }
        if (input.remove.length > 0) {
          const removed = await tryRemoveLabelsFromIssue(githubIssuesApi, {
            ...repository,
            issueNumber: input.subjectNumber,
            labels: input.remove
          });
          if (!removed) {
            return {
              error:
                "removing labels is not supported by the configured GitHub API",
              ok: false
            };
          }
        }
        return { ok: true };
      } catch (error) {
        return { error: errorMessage(error), ok: false };
      }
    },
    getRuns: () => runStore.listRuns(),
    getWatchdogConfig: (projectName) =>
      resolveWatchdogConfig(runtimeConfig.watchdogServiceConfig(), projectName),
    getScheduled: () => activeRuns.peekDelayed(),
    getStatusSnapshot: () =>
      buildStatusSnapshot({
        configDir: state.configDir,
        configPath: state.configPath,
        issuePollStatus,
        projectModes,
        projectsByName: runtimeConfig.projectsByName(),
        reloadStatus: runtimeConfig.getStatus(),
        runStore,
        stateRoot: state.stateRoot
      }),
    issuePollStatus,
    getReloadStatus: () => runtimeConfig.getStatus(),
    pollNow: triggerPollNow,
    updateNow: ({ checkOnly }) =>
      checkOnly ? updateCoordinator.checkNow() : updateCoordinator.runNow(),
    // #307's editors: validate-and-write goes through the save pipeline,
    // reload picks the edit up (routine declarations/workflow contracts
    // take effect on the next dispatch tick; an invalid symphonika.yml
    // edit is refused and the daemon keeps its last-good snapshot).
    resolveWritePath: async (candidatePath: string) => {
      const referenced = await computeReferencedRealPaths({
        configPath: state.configPath,
        // listRoutines()'s default already excludes state = 'inactive'; disabled_reason
        // only means anything on state = 'disabled', so this filter alone also excludes
        // routines dropped from config via the whole-project inactive cascade.
        routineSourcePaths: runStore
          .listRoutines()
          .filter((routine) => routine.disabledReason !== "removed_from_config")
          .map((routine) => routine.sourcePath),
        workflowPaths: [...runtimeConfig.projectsByName().values()]
          .map((project) => project.workflow)
          .filter(
            (workflow): workflow is WorkflowSnapshot =>
              workflow !== undefined && "expandedWorkflow" in workflow
          )
          .map((workflow) => workflow.path)
      });
      return resolveConfinedWritePath(candidatePath, referenced);
    },
    triggerReload: async () => {
      const { errors, ok } = await reloadConfigAndRecordOutcome();
      return { errors, ok };
    },
    runStore,
    shutdownSignal: shutdownController.signal,
    stateRoot: state.stateRoot,
    version: VERSION
  });

  // Seed the pressure gate before anything can dispatch. Both synchronous
  // readers -- the Routine Firing path inside launchWork() and the manual
  // /api/routines/.../fire endpoint -- take createHostPressureGate's cached
  // verdict, which admits until a first sample exists. Without this the
  // startup launchWork() below (and any manual fire in the window before the
  // first tick, up to a whole polling interval later) would claim work
  // unsampled -- on a host stalled badly enough that an operator has just
  // restarted the daemon, which is exactly the #599 scenario. See ADR 0088.
  await refreshHostPressure();

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
      nextPollAtMonotonicMs = performance.now() + intervalMs;
      tickLoopStartedAtMonotonicMs = performance.now();
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
  daemonHealthNotifications.notifyDaemonStarted({
    orphanedRoutineFirings: firingOutcomes.length,
    orphanedRuns: runOutcomes.length
  });
  // Defense in depth: createDaemonHeartbeat's own notify functions already
  // swallow a failed systemd-notify call, but daemonHeartbeat is injectable
  // (options.daemonHeartbeat), so a caller-supplied implementation isn't
  // guaranteed to. Either call site rejecting would be severe -- notifyReady
  // is awaited directly, so it would abort startDaemon() itself, and
  // notifySystemdWatchdog runs from a timer with nothing else to observe a
  // rejection -- so both are caught here too rather than trusting the
  // implementation.
  await daemonHeartbeat.notifyReady().catch((error: unknown) => {
    logger.warn(
      { err: error },
      "symphonika systemd-notify readiness call failed"
    );
  });
  if (daemonHeartbeat.systemdWatchdogPingIntervalMs !== undefined) {
    systemdWatchdogTimer = setInterval(() => {
      if (
        isTickRecentEnoughForSystemdWatchdog({
          configExists: state.configExists,
          effectiveIntervalMs: intervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
          lastTickAtMonotonicMs,
          nowMonotonicMs: performance.now(),
          tickLoopStartedAtMonotonicMs
        })
      ) {
        daemonHeartbeat.notifySystemdWatchdog().catch((error: unknown) => {
          logger.warn(
            { err: error },
            "symphonika systemd-notify watchdog call failed"
          );
        });
      }
    }, daemonHeartbeat.systemdWatchdogPingIntervalMs);
    systemdWatchdogTimer.unref?.();
  }

  // Rows updated within the grace window at startup are skipped by the
  // initial sweep, so schedule one more pass after the window elapses to
  // catch rows that an outgoing daemon wrote moments before restart. Arm the
  // timer only now that startup has completed: the delay budget belongs to
  // the serving daemon, and a slow startup must not consume it and fire the
  // sweep before the daemon is ready.
  let legacyRecheckTimer: ReturnType<typeof setTimeout> | undefined;
  const legacyRecheckDelayMs =
    options.legacyInputRequiredRecheckDelayMs ??
    INPUT_REQUIRED_LEGACY_BACKFILL_GRACE_MS * 2;
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

  return {
    host,
    port,
    stateRoot: state.stateRoot,
    url,
    stop: async () => {
      // Close the registry to new claims FIRST, synchronously: this must
      // not wait on the dispatch mutex, because a claim section parked in a
      // slow GitHub label write must not delay cancellation of already-live
      // providers. Pre-claim dispatches now hit the gate at reserveSlot and
      // roll back instead of starting an uncancelled provider. See ADR 0052.
      activeRuns.beginShutdown();
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        nextPollAtMonotonicMs = undefined;
      }
      if (systemdWatchdogTimer !== undefined) {
        clearInterval(systemdWatchdogTimer);
      }
      if (legacyRecheckTimer !== undefined) {
        clearTimeout(legacyRecheckTimer);
        legacyRecheckTimer = undefined;
      }
      issueRunNotifications.stop();
      for (const entry of activeRuns.list()) {
        if (runStore.getRun(entry.runId) !== undefined) {
          runStore.markCancelRequested(
            entry.runId,
            CANCEL_REASONS.DAEMON_SHUTDOWN
          );
          continue;
        }
        if (runStore.getRoutineFiring(entry.runId) !== undefined) {
          runStore.markRoutineFiringCancelRequested(
            entry.runId,
            CANCEL_REASONS.DAEMON_SHUTDOWN
          );
        }
      }
      await activeRuns.cancelAll(CANCEL_REASONS.DAEMON_SHUTDOWN);
      await scheduledWork;
      await Promise.allSettled(Array.from(inflightDispatches));
      await Promise.all([
        routineNotificationDeliveries.settled(),
        daemonHealthNotifications.settled()
      ]);
      try {
        shutdownController.abort();
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
  status: import("./issue-polling.js").IssuePollStatus,
  skippedProjectKeys: ReadonlySet<string>,
  selectedProjectKeysByName: ReadonlyMap<string, string>,
  effectiveProjects: readonly RunControllerProjectConfig[]
): Promise<Map<string, "dispatch" | "routine_host">> {
  return readProjectStateInputs(configPath, status, {
    effectiveProjects,
    priorProjectStates: runStore.getProjectStatesByName(),
    skippedProjectKeys
  }).then(({ inputs, modes }) => {
    runStore.syncProjectStates(inputs);
    for (const project of status.projects) {
      if (
        selectedProjectKeysByName.get(project.name) !==
        projectPollIdentityKey(project.name, project.repository)
      ) {
        continue;
      }
      runStore.recordProjectPollOutcome({
        candidateIssues: project.candidateIssues ?? 0,
        error: project.error ?? null,
        fetchedIssues: project.fetchedIssues,
        filteredIssues: project.filteredIssues ?? 0,
        ok: project.ok,
        projectName: project.name
      });
      // ADR 0073: only a project whose poll succeeded this tick gets its
      // issue snapshot replaced — a failed poll leaves the last known
      // snapshot in place rather than blanking the table.
      if (project.ok) {
        runStore.replaceProjectIssueSnapshots({
          polledAt: project.lastPolledAt ?? timestamp(),
          projectName: project.name,
          repository: project.repository,
          rows: projectIssueSnapshotRows(
            project.name,
            project.repository,
            status
          )
        });
      }
    }
    return modes;
  });
}

function projectIssueSnapshotRows(
  projectName: string,
  repository: ProjectSnapshotRepository,
  status: import("./issue-polling.js").IssuePollStatus
): Array<{
  blockedBy: import("./issue-polling.js").RawGitHubIssueDependencyRef[];
  blockedByTruncated: boolean;
  issueNumber: number;
  kind: "candidate" | "filtered";
  labels: string[];
  parentIssueNumber?: number;
  priority: number;
  reasons: string[];
  title: string;
}> {
  const candidateRows = status.candidateIssues
    .filter(
      (entry) =>
        entry.project === projectName &&
        sameGitHubRepository(entry.repository, repository)
    )
    .map((entry) => ({
      blockedBy: entry.issue.blockedBy ?? [],
      blockedByTruncated: entry.issue.blockedByTruncated === true,
      issueNumber: entry.issue.number,
      kind: "candidate" as const,
      labels: entry.issue.labels,
      ...(entry.issue.parentIssueNumber === undefined
        ? {}
        : { parentIssueNumber: entry.issue.parentIssueNumber }),
      priority: entry.issue.priority,
      reasons: [],
      title: entry.issue.title
    }));
  const filteredRows = status.filteredIssues
    .filter(
      (entry) =>
        entry.project === projectName &&
        sameGitHubRepository(entry.repository, repository)
    )
    .map((entry) => ({
      blockedBy: entry.issue.blockedBy ?? [],
      blockedByTruncated: entry.issue.blockedByTruncated === true,
      issueNumber: entry.issue.number,
      kind: "filtered" as const,
      labels: entry.issue.labels,
      ...(entry.issue.parentIssueNumber === undefined
        ? {}
        : { parentIssueNumber: entry.issue.parentIssueNumber }),
      priority: entry.issue.priority,
      reasons: entry.reasons,
      title: entry.issue.title
    }));
  return [...candidateRows, ...filteredRows];
}

// #309 (ADR 0077): mirrors persistProjectPollState's per-project
// wholesale-replace rule (ADR 0073) for PR snapshots — a project whose PR
// poll failed this tick keeps its last-known snapshot rather than being
// blanked.
function persistProjectPullRequestPollState(
  runStore: ReturnType<typeof openRunStore>,
  status: import("./pull-request-polling.js").PullRequestPollStatus
): void {
  for (const project of status.projects) {
    if (!project.ok) {
      continue;
    }
    runStore.replaceProjectPullRequestSnapshots({
      polledAt: project.lastPolledAt ?? timestamp(),
      projectName: project.name,
      repository: project.repository,
      rows: status.pullRequests
        .filter(
          (entry) =>
            entry.project === project.name &&
            sameGitHubRepository(entry.repository, project.repository)
        )
        .map((entry) => ({
          branchOrigin: entry.branchOrigin,
          checks: entry.checks,
          draft: entry.draft,
          headRef: entry.headRef,
          headSha: entry.headSha,
          labels: entry.labels,
          mergeable: entry.mergeable,
          merged: entry.merged,
          open: entry.open,
          prNumber: entry.prNumber,
          reviewDecision: entry.reviewDecision,
          stateAvailable: entry.stateAvailable,
          title: entry.title,
          trackingState: entry.trackingState,
          unresolvedReviewThreads: entry.unresolvedReviewThreads,
          url: entry.url
        }))
    });
  }
}

function sameGitHubRepository(
  left: ProjectSnapshotRepository,
  right: ProjectSnapshotRepository
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

// Shared by mergePullRequest and writeIssueLabels (ADR 0078/0077): both bind
// a rendered form value through the durable snapshot to the current tracker
// before mutating anything. `resolveSnapshotRepository` stays a callback so a
// missing rendered value fails closed without an unnecessary store lookup.
function verifySnapshotRepositoryBinding(input: {
  action: string;
  currentRepository: ProjectSnapshotRepository;
  renderedRepository: ProjectSnapshotRepository | undefined;
  resolveSnapshotRepository: () => ProjectSnapshotRepository | undefined;
  subjectLabel: string;
}): string | undefined {
  if (input.renderedRepository === undefined) {
    return `${input.subjectLabel} rendered snapshot repository identity is unavailable; reload the page after a successful poll before ${input.action}`;
  }
  const snapshotRepository = input.resolveSnapshotRepository();
  if (snapshotRepository === undefined) {
    return `${input.subjectLabel} snapshot repository identity is unavailable; poll the Project successfully before ${input.action}`;
  }
  if (!sameGitHubRepository(input.renderedRepository, snapshotRepository)) {
    return `rendered snapshot repository ${input.renderedRepository.owner}/${input.renderedRepository.repo} does not match current snapshot repository ${snapshotRepository.owner}/${snapshotRepository.repo}; reload the page before ${input.action}`;
  }
  if (!sameGitHubRepository(snapshotRepository, input.currentRepository)) {
    return `snapshot repository ${snapshotRepository.owner}/${snapshotRepository.repo} does not match current tracker repository ${input.currentRepository.owner}/${input.currentRepository.repo}; poll the Project successfully before ${input.action}`;
  }
  return undefined;
}

function timestamp(): string {
  return new Date().toISOString();
}

type ProjectStateInputs = {
  inputs: SyncProjectStateInput[];
  // Parsed straight from the raw config file, not the validated runtime
  // config: a Project that fails validation (e.g. a Routine Host missing
  // the tracker its own `kind: git` Routine requires, ADR 0062) never
  // reaches the validated config, but still gets a project_states row
  // here — and the dashboard's Dispatch/Routine Host split (#302) needs
  // its mode to classify that row correctly even while invalid.
  modes: Map<string, "dispatch" | "routine_host">;
};

type ReadProjectStateInputsOptions = {
  effectiveProjects: readonly RunControllerProjectConfig[];
  priorProjectStates: ReadonlyMap<string, ProjectState>;
  skippedProjectKeys: ReadonlySet<string>;
};

async function readProjectStateInputs(
  configPath: string,
  status: import("./issue-polling.js").IssuePollStatus,
  options: ReadProjectStateInputsOptions
): Promise<ProjectStateInputs> {
  const reports = new Map(
    status.projects.map((project) => [
      projectPollIdentityKey(project.name, project.repository),
      project
    ])
  );
  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8")) ?? {};
  } catch {
    return fallbackProjectStateInputs(reports, options);
  }
  if (!isRecord(raw) || !Array.isArray(raw["projects"])) {
    return fallbackProjectStateInputs(reports, options);
  }
  const inputs: SyncProjectStateInput[] = [];
  const modes = new Map<string, "dispatch" | "routine_host">();
  raw["projects"].forEach((project, index) => {
    if (!isRecord(project) || typeof project["name"] !== "string") {
      return;
    }
    modes.set(project["name"], rawProjectMode(project["mode"]));
    const projectKey = rawProjectPollIdentityKey(project["name"], project);
    const report =
      projectKey === undefined ? undefined : reports.get(projectKey);
    if (report !== undefined) {
      inputs.push(projectStateInputFromReport(report));
      return;
    }
    const errors = status.errors.filter((error) =>
      error.startsWith(`projects.${index}.`)
    );
    if (errors.length > 0) {
      inputs.push({
        name: project["name"],
        validationMessage: errors.join("; "),
        validationState: "invalid",
        weight: rawProjectWeight(project["weight"])
      });
      return;
    }
    const prior =
      projectKey !== undefined && options.skippedProjectKeys.has(projectKey)
        ? options.priorProjectStates.get(project["name"])
        : undefined;
    inputs.push({
      name: project["name"],
      validationMessage:
        prior?.validationState === "invalid" ? prior.validationMessage : null,
      validationState:
        prior?.validationState === "invalid" ? "invalid" : "valid",
      weight: rawProjectWeight(project["weight"])
    });
  });
  return { inputs, modes };
}

function fallbackProjectStateInputs(
  reports: ReadonlyMap<
    string,
    import("./issue-polling.js").ProjectIssuePollReport
  >,
  options: ReadProjectStateInputsOptions
): ProjectStateInputs {
  const inputsByName = new Map<string, SyncProjectStateInput>();
  const modes = new Map<string, "dispatch" | "routine_host">();

  // A broken edit is not evidence that a Project in the last-known-good
  // runtime snapshot was removed. Unlike status.projects, this set still
  // contains Projects whose GitHub token caused this tick to back off.
  for (const project of options.effectiveProjects) {
    modes.set(project.name, project.mode);
    const report =
      project.tracker === undefined
        ? undefined
        : reports.get(projectPollIdentityKey(project.name, project.tracker));
    const prior = options.priorProjectStates.get(project.name);
    inputsByName.set(
      project.name,
      report !== undefined
        ? projectStateInputFromReport(report)
        : prior !== undefined
          ? projectStateInputFromPrior(prior)
          : {
              name: project.name,
              validationMessage: null,
              validationState: "valid",
              weight: project.weight
            }
    );
  }

  return { inputs: Array.from(inputsByName.values()), modes };
}

function projectStateInputFromPrior(
  project: ProjectState
): SyncProjectStateInput {
  return {
    name: project.projectName,
    validationMessage:
      project.validationState === "invalid" ? project.validationMessage : null,
    validationState:
      project.validationState === "invalid" ? "invalid" : "valid",
    weight: project.weight
  };
}

function rawProjectPollIdentityKey(
  name: string,
  project: Record<string, unknown>
): string | undefined {
  const tracker = project["tracker"];
  if (
    !isRecord(tracker) ||
    typeof tracker["owner"] !== "string" ||
    typeof tracker["repo"] !== "string"
  ) {
    return undefined;
  }
  return projectPollIdentityKey(name, {
    owner: tracker["owner"],
    repo: tracker["repo"]
  });
}

// Mirrors the schema default: an omitted or unrecognized `mode` is a
// Dispatch Project (ADR 0062).
function rawProjectMode(mode: unknown): "dispatch" | "routine_host" {
  return mode === "routine_host" ? "routine_host" : "dispatch";
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

const SERVER_CLOSE_GRACE_MS = 5_000;

function stopServer(server: ServerType, logger: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    // close() waits for every open connection to end on its own. A peer that
    // stops reading mid-response never lets its socket go idle, so without a
    // bound the daemon would wait on it forever; destroy the stragglers once
    // the grace window elapses.
    const forceClose = setTimeout(() => {
      if ("closeAllConnections" in server) {
        logger.warn(
          "symphonika daemon forcing lingering HTTP connections closed"
        );
        server.closeAllConnections();
      }
    }, SERVER_CLOSE_GRACE_MS);

    server.close((error) => {
      clearTimeout(forceClose);

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

async function runAutomaticRoutineWorkspaceRetention(input: {
  logger: Logger;
  policy: RoutineWorkspaceRetentionPolicy;
  pruneRoutineWorkspaces: typeof pruneRoutineWorkspacesReal;
  runStore: ReturnType<typeof openRunStore>;
}): Promise<void> {
  try {
    const report = await input.pruneRoutineWorkspaces({
      policy: input.policy,
      runStore: input.runStore
    });
    if (report.pruned.length > 0) {
      input.logger.info(
        { firingIds: report.pruned.map((entry) => entry.firingId) },
        "symphonika pruned Routine Firing workspaces"
      );
    }
    for (const failure of report.failures) {
      input.logger.warn(
        {
          err: failure.error,
          firingId: failure.firingId,
          workspacePath: failure.workspacePath
        },
        "symphonika failed to prune Routine Firing workspace"
      );
    }
  } catch (error) {
    input.logger.error(
      { err: error },
      "symphonika Routine Firing workspace retention failed"
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
