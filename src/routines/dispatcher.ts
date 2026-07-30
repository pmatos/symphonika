import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type { ActiveRunRegistry } from "../lifecycle/active-runs.js";
import { classifyFailure } from "../lifecycle/classify-failure.js";
import {
  resolveEnvBackedValue,
  tryListPullRequestsForBranch,
  type GitHubIssuesApi,
  type RawGitHubPullRequest
} from "../issue-polling.js";
import type {
  AgentProviderName,
  AgentProviderRegistry,
  NormalizedProviderEvent,
  ProviderEvent
} from "../provider.js";
import type {
  RunControllerProjectConfig,
  RunControllerProvidersConfig
} from "../lifecycle/run-controller.js";
import type { EmailNotificationConfig } from "../notifications/config.js";
import { deliverRoutineFiringNotification } from "../notifications/routine-firing.js";
import type { NotificationSink } from "../notifications/types.js";
import type { RunStore } from "../run-store.js";
import {
  evaluateRoutineSchedule,
  nextRecurringFireAt,
  type RoutineScheduleEvaluation
} from "./schedule.js";
import {
  renderRoutinePrompt,
  RoutinePromptRenderError
} from "./prompt-renderer.js";
import type {
  RoutineSchedule,
  RoutineState,
  RoutineStatus,
  TargetedRoutineDeclaration
} from "./types.js";
import { createUlid } from "./ulid.js";
import {
  prepareRoutineWorkspace as defaultPrepareRoutineWorkspace,
  type PreparedRoutineWorkspace,
  type PrepareRoutineWorkspaceInput
} from "./workspace.js";

export type DispatchDueRoutinesInput = {
  activeRuns: ActiveRunRegistry;
  agentProviders: AgentProviderRegistry;
  configDir: string;
  createFiringId?: () => string;
  env?: NodeJS.ProcessEnv;
  globalConcurrency: { maxInFlight: number | undefined };
  githubIssuesApi?: GitHubIssuesApi;
  logger?: Logger;
  notification?: {
    createSink: (config: EmailNotificationConfig) => NotificationSink;
    resolveConfig: () => EmailNotificationConfig | undefined;
  };
  now?: Date;
  prepareRoutineWorkspace?: (
    input: PrepareRoutineWorkspaceInput
  ) => Promise<PreparedRoutineWorkspace>;
  projects: Map<string, RunControllerProjectConfig>;
  providersConfig: RunControllerProvidersConfig;
  recomputeSchedulesFromNow?: boolean;
  runStore: RunStore;
  stateRoot: string;
};

export type DispatchDueRoutinesResult = {
  fired: string[];
  skipped: Array<{ reason: string; routineName: string; projectName: string }>;
};

export type FireRoutineNowInput = Omit<
  DispatchDueRoutinesInput,
  "now" | "recomputeSchedulesFromNow"
> & {
  request: {
    force?: boolean;
    projectName?: string;
    routineName: string;
  };
};

export type FireRoutineNowResult =
  | {
      completion: Promise<void>;
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
      reason: RoutineState | "concurrency_cap" | "daemon_shutdown" | "overlap";
    }
  | { error: string; kind: "unavailable" };

type RoutineTerminalOutcome =
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "succeeded"; reason: string };

export function fireRoutineNow(
  input: FireRoutineNowInput
): FireRoutineNowResult {
  const matches = input.runStore
    .listRoutines({
      includeInactive: true,
      ...(input.request.projectName === undefined
        ? {}
        : { project: input.request.projectName })
    })
    .filter((routine) => routine.name === input.request.routineName);
  if (matches.length === 0) {
    return {
      error: `routine ${input.request.routineName} not found`,
      kind: "not_found"
    };
  }
  if (matches.length > 1) {
    const candidates = matches.map((routine) => ({
      projectName: routine.projectName,
      routineName: routine.name
    }));
    return {
      candidates,
      error: `routine ${input.request.routineName} is ambiguous; candidates: ${candidates
        .map((candidate) => `${candidate.projectName}/${candidate.routineName}`)
        .join(", ")}; provide --project`,
      kind: "ambiguous"
    };
  }
  const routine = matches[0]!;
  const forceOperatorDisabled =
    input.request.force === true &&
    routine.state === "disabled" &&
    routine.disabledReason === "operator";
  if (routine.state !== "active" && !forceOperatorDisabled) {
    const disabledDetail =
      routine.state === "disabled" && routine.disabledReason !== null
        ? ` (${routine.disabledReason})`
        : "";
    return {
      error: `routine ${routine.name} is ${routine.state}${disabledDetail}`,
      kind: "refused",
      reason: routine.state
    };
  }
  const project = input.projects.get(routine.projectName);
  if (project === undefined || project.disabled === true) {
    return {
      error: `routine ${routine.name} is inactive`,
      kind: "refused",
      reason: "inactive"
    };
  }
  if (
    !routine.allowOverlap &&
    input.runStore.hasActiveRoutineFiring({
      name: routine.name,
      projectName: routine.projectName
    })
  ) {
    return {
      error: `routine ${routine.name} already has an active firing`,
      kind: "refused",
      reason: "overlap"
    };
  }
  const providerName = routine.provider ?? project.agent.provider;
  const provider = input.agentProviders[providerName];
  const providerCommand = (
    input.providersConfig as Partial<RunControllerProvidersConfig>
  )[providerName]?.command;
  if (provider === undefined) {
    return {
      error: `provider not registered: ${providerName}`,
      kind: "unavailable"
    };
  }
  if (providerCommand === undefined) {
    return {
      error: `provider command missing: ${providerName}`,
      kind: "unavailable"
    };
  }
  const capReason = capSkipReason(
    input.activeRuns,
    input.globalConcurrency,
    project
  );
  if (capReason !== null) {
    return {
      error: `concurrency cap reached: ${capReason}`,
      kind: "refused",
      reason: "concurrency_cap"
    };
  }
  if (input.activeRuns.isShuttingDown()) {
    return {
      error: "daemon is shutting down",
      kind: "refused",
      reason: "daemon_shutdown"
    };
  }
  const detail = input.runStore.getRoutine({
    name: routine.name,
    projectName: routine.projectName
  });
  if (detail === undefined) {
    return {
      error: `routine ${routine.name} is no longer available`,
      kind: "not_found"
    };
  }

  const firingId = input.createFiringId?.() ?? createUlid();
  const claimed = input.runStore.claimManualRoutineFiring({
    firingId,
    forceOperatorDisabled,
    projectName: routine.projectName,
    providerCommand,
    providerName,
    routineName: routine.name
  });
  if (!claimed) {
    return {
      error: `routine ${routine.name} is no longer eligible for manual firing`,
      kind: "refused",
      reason: detail.state
    };
  }
  input.activeRuns.reserveSlot({
    issueNumber: syntheticRoutineIssueNumber(firingId),
    projectName: routine.projectName,
    respectsIssueLabels: false,
    runId: firingId
  });
  const completion = runRoutineFiring({
    activeRuns: input.activeRuns,
    configDir: input.configDir,
    env: input.env ?? process.env,
    firingId,
    githubIssuesApi: input.githubIssuesApi,
    logger: input.logger,
    prepareRoutineWorkspace:
      input.prepareRoutineWorkspace ?? defaultPrepareRoutineWorkspace,
    project,
    provider,
    providerCommand,
    providerName,
    routine: detail,
    runStore: input.runStore,
    stateRoot: input.stateRoot
  }).finally(() => {
    input.activeRuns.unregister(firingId);
  });
  return {
    completion,
    firingId,
    kind: "accepted",
    projectName: routine.projectName,
    routineName: routine.name,
    state: "queued"
  };
}

class RoutineFiringTimeoutError extends Error {
  readonly terminalReason = "firing_timeout";

  constructor() {
    super("routine firing exceeded its declared wall-clock timeout");
    this.name = "RoutineFiringTimeoutError";
  }
}

export async function dispatchDueRoutines(
  input: DispatchDueRoutinesInput
): Promise<DispatchDueRoutinesResult> {
  const fired: string[] = [];
  const skipped: DispatchDueRoutinesResult["skipped"] = [];
  const now = input.now ?? new Date();
  const prepareRoutineWorkspace =
    input.prepareRoutineWorkspace ?? defaultPrepareRoutineWorkspace;
  const createFiringId = input.createFiringId ?? (() => createUlid());
  const projects = [...input.projects.values()];

  for (const project of projects) {
    if (project.disabled === true) {
      input.runStore.markRoutinesInactiveForProject(project.name, {
        now,
        trackerlessGitRoutines: project.trackerlessGitRoutines ?? []
      });
      continue;
    }
    if (input.recomputeSchedulesFromNow === true) {
      const declarations = new Map(
        (project.routines ?? []).map((routine) => [routine.name, routine])
      );
      for (const persisted of input.runStore.listRoutines({
        project: project.name
      })) {
        const declaration = declarations.get(persisted.name);
        if (
          declaration === undefined ||
          !("cron" in declaration.schedule) ||
          (declaration.catchUp ?? "skip") !== "skip" ||
          persisted.state !== "active" ||
          persisted.nextFireAt === null ||
          new Date(persisted.nextFireAt).getTime() > now.getTime() ||
          persisted.scheduleCron !== declaration.schedule.cron ||
          persisted.scheduleTz !== declaration.schedule.tz
        ) {
          continue;
        }
        const nextFireAt = nextRecurringFireAt(declaration.schedule, now);
        if (
          input.runStore.skipRoutineFiring({
            attemptedAt: now.toISOString(),
            name: persisted.name,
            nextFireAt,
            projectName: project.name,
            reason: "catch_up_window"
          })
        ) {
          logRoutineSkip(input.logger, {
            reason: "catch_up_window",
            routine: persisted.name,
            scheduledAt: persisted.nextFireAt
          });
          skipped.push({
            projectName: project.name,
            reason: "catch_up_window",
            routineName: persisted.name
          });
        }
      }
    }
  }
  // Service-level routines: one sync call with all targeted routines across
  // projects, each carrying its own projectName. protectedNamesByProject
  // holds invalid-routine names per project (ADR 0060/0063), while the
  // tracker-less set identifies valid files rejected by host compatibility
  // for a precise soft-disable (ADR 0066).
  const allRoutines: TargetedRoutineDeclaration[] = [];
  const protectedNamesByProject: Record<string, string[]> = {};
  const trackerlessGitRoutinesByProject: Record<
    string,
    TargetedRoutineDeclaration[]
  > = {};
  const syncedProjects: string[] = [];
  for (const project of projects) {
    if (project.disabled === true) {
      continue;
    }
    syncedProjects.push(project.name);
    for (const routine of project.routines ?? []) {
      allRoutines.push(routine);
    }
    if ((project.invalidRoutineNames ?? []).length > 0) {
      protectedNamesByProject[project.name] = project.invalidRoutineNames ?? [];
    }
    if ((project.trackerlessGitRoutines ?? []).length > 0) {
      trackerlessGitRoutinesByProject[project.name] =
        project.trackerlessGitRoutines ?? [];
    }
  }
  input.runStore.syncRoutines(allRoutines, {
    now,
    // Include projects with zero routines so removal-detection runs for a
    // project whose last routine was just removed (ADR 0063).
    projects: syncedProjects,
    protectedNamesByProject,
    trackerlessGitRoutinesByProject,
    recomputeRecurring: input.recomputeSchedulesFromNow === true
  });
  input.runStore.pruneRoutinesForUnknownProjects(
    projects.map((project) => project.name)
  );

  for (const project of projects) {
    if (project.disabled === true) {
      continue;
    }
    for (const routine of input.runStore.listRoutines({
      project: project.name
    })) {
      // A disabled/invalid/expired/inactive routine can have no persisted
      // schedule at all (an invalid stub's schedule columns are unreadable
      // sentinels). evaluateRoutineSchedule already treats every non-active
      // state as never-fire, but routineSchedule() below is evaluated
      // eagerly as a function argument, so it must never be reached for a
      // non-active row — skip here rather than let it throw and abort the
      // whole dispatch tick (which would also block issue dispatch, since
      // both share one try/catch in daemon.ts's launchWork).
      if (routine.state !== "active") {
        continue;
      }
      const evaluation = evaluateRoutineSchedule({
        lastFiredAt: routine.lastFiredAt,
        nextFireAt: routine.nextFireAt,
        now,
        schedule: routineSchedule(routine),
        state: routine.state
      });
      if (evaluation.kind !== "fire_now") {
        continue;
      }
      if (
        !routine.allowOverlap &&
        input.runStore.hasActiveRoutineFiring({
          name: routine.name,
          projectName: project.name
        })
      ) {
        if (
          recordDueRoutineSkip(input.runStore, {
            evaluation,
            now,
            projectName: project.name,
            reason: "overlap",
            routine
          })
        ) {
          logRoutineSkip(input.logger, {
            reason: "overlap",
            routine: routine.name,
            scheduledAt: routine.nextFireAt ?? now.toISOString()
          });
          skipped.push({
            projectName: project.name,
            reason: "overlap",
            routineName: routine.name
          });
        }
        continue;
      }
      const providerName = routine.provider ?? project.agent.provider;
      const provider = input.agentProviders[providerName];
      const providerCommand = (
        input.providersConfig as Partial<RunControllerProvidersConfig>
      )[providerName]?.command;
      if (provider === undefined) {
        skipped.push({
          projectName: project.name,
          reason: `provider_not_registered: ${providerName}`,
          routineName: routine.name
        });
        continue;
      }
      if (providerCommand === undefined) {
        skipped.push({
          projectName: project.name,
          reason: `provider_command_missing: ${providerName}`,
          routineName: routine.name
        });
        continue;
      }
      const capReason = capSkipReason(
        input.activeRuns,
        input.globalConcurrency,
        project
      );
      if (capReason !== null) {
        if (
          recordDueRoutineSkip(input.runStore, {
            evaluation,
            now,
            projectName: project.name,
            reason: "concurrency_cap",
            routine
          })
        ) {
          logRoutineSkip(input.logger, {
            reason: "concurrency_cap",
            routine: routine.name,
            scheduledAt: routine.nextFireAt ?? now.toISOString()
          });
          skipped.push({
            projectName: project.name,
            reason: "concurrency_cap",
            routineName: routine.name
          });
        }
        continue;
      }

      const routineDetail = input.runStore.getRoutine({
        name: routine.name,
        projectName: project.name
      });
      if (routineDetail === undefined) {
        skipped.push({
          projectName: project.name,
          reason: "routine disappeared before firing",
          routineName: routine.name
        });
        continue;
      }

      const reEvaluation = evaluateRoutineSchedule({
        lastFiredAt: routineDetail.lastFiredAt,
        nextFireAt: routineDetail.nextFireAt,
        now,
        schedule: routineSchedule(routineDetail),
        state: routineDetail.state
      });
      if (reEvaluation.kind !== "fire_now") {
        skipped.push({
          projectName: project.name,
          reason: "routine no longer eligible after re-read",
          routineName: routine.name
        });
        continue;
      }

      // The claim below through reserveSlot is await-free, so this check
      // is race-free: a skipped firing never creates a row that shutdown
      // would fail to mark daemon_shutdown. See ADR 0052.
      if (input.activeRuns.isShuttingDown()) {
        skipped.push({
          projectName: project.name,
          reason: "daemon shutting down",
          routineName: routine.name
        });
        continue;
      }

      const firingId = createFiringId();
      const claimed = input.runStore.claimRoutineFiring({
        firedAt: now.toISOString(),
        firingId,
        ...(reEvaluation.nextAt === undefined
          ? {}
          : { nextFireAt: reEvaluation.nextAt }),
        projectName: project.name,
        providerCommand,
        providerName,
        routineName: routine.name
      });
      if (!claimed) {
        skipped.push({
          projectName: project.name,
          reason: "routine already claimed by another worker",
          routineName: routine.name
        });
        continue;
      }

      let firingResult: RoutineFiringResult;
      try {
        input.activeRuns.reserveSlot({
          issueNumber: syntheticRoutineIssueNumber(firingId),
          projectName: project.name,
          respectsIssueLabels: false,
          runId: firingId
        });
        fired.push(firingId);
        firingResult = await runRoutineFiring({
          firingId,
          env: input.env ?? process.env,
          githubIssuesApi: input.githubIssuesApi,
          logger: input.logger,
          prepareRoutineWorkspace,
          project,
          provider,
          providerCommand,
          providerName,
          routine: routineDetail,
          runStore: input.runStore,
          stateRoot: input.stateRoot,
          configDir: input.configDir,
          activeRuns: input.activeRuns
        });
      } finally {
        input.activeRuns.unregister(firingId);
      }
      // Notification delivery is best-effort and can be as slow as the SMTP
      // server allows (see ADR 0067), bounded per attempt by
      // deliverWithTimeout. Releasing the slot above before this await lets
      // a concurrent or later dispatch tick fire this project's next
      // routine without seeing a stale reservation; within this same
      // sequential loop, the next due routine (here or in another project)
      // still waits behind this await.
      await recordRoutineFiringNotification(
        {
          env: input.env ?? process.env,
          firingId,
          logger: input.logger,
          notification: input.notification,
          project,
          routine: routineDetail,
          runStore: input.runStore
        },
        firingResult.events,
        firingResult.prepared
      );
    }
  }

  return { fired, skipped };
}

type RoutineFiringResult = {
  events: NormalizedProviderEvent[];
  prepared: PreparedRoutineWorkspace | undefined;
};

async function runRoutineFiring(input: {
  activeRuns: ActiveRunRegistry;
  configDir: string;
  env: NodeJS.ProcessEnv;
  firingId: string;
  githubIssuesApi: GitHubIssuesApi | undefined;
  logger: Logger | undefined;
  prepareRoutineWorkspace: (
    input: PrepareRoutineWorkspaceInput
  ) => Promise<PreparedRoutineWorkspace>;
  project: RunControllerProjectConfig;
  provider: NonNullable<AgentProviderRegistry[AgentProviderName]>;
  providerCommand: string;
  providerName: AgentProviderName;
  routine: RoutineStatus & { prompt: string };
  runStore: RunStore;
  stateRoot: string;
}): Promise<RoutineFiringResult> {
  const events: NormalizedProviderEvent[] = [];
  const deadline = routineFiringDeadline(input.routine.timeoutMinutes);
  let prepared: PreparedRoutineWorkspace | undefined;
  let providerAttempt: Promise<void> | undefined;
  let rawLogPath: string | undefined;
  let normalizedLogPath: string | undefined;
  try {
    input.runStore.updateRoutineFiringState(
      input.firingId,
      "preparing_workspace"
    );
    prepared = await deadline.race(
      input.prepareRoutineWorkspace({
        configDir: input.configDir,
        firingId: input.firingId,
        kind: input.routine.kind,
        project: input.project,
        routineName: input.routine.name
      })
    );
    const evidence = await deadline.race(
      prepareRoutineEvidence({
        configDir: input.configDir,
        firingId: input.firingId,
        prepared,
        project: input.project,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        routine: input.routine,
        stateRoot: input.stateRoot
      })
    );
    rawLogPath = evidence.rawLogPath;
    normalizedLogPath = evidence.normalizedLogPath;
    input.runStore.updateRoutineFiringWorkspace({
      id: input.firingId,
      normalizedLogPath,
      promptPath: evidence.promptPath,
      rawLogPath,
      workspacePath: prepared.workspacePath
    });
    await deadline.race(input.provider.validate(input.providerCommand));
    input.runStore.updateRoutineFiringState(input.firingId, "running");
    input.activeRuns.attachProvider(input.firingId, {
      cancel: () => input.provider.cancel(input.firingId),
      provider: input.provider,
      respectsIssueLabels: false
    });

    // A cancel can land DURING the potentially long workspace prep above (or
    // provider.validate) — before this point only the reserveSlot noop
    // cancel handler existed, so the attachProvider hand-off just fired
    // provider.cancel against a provider that runAttempt has not started
    // yet, which is a no-op, and the latched cancelRequested suppresses any
    // later cancel. Re-check here and skip launching a provider we could no
    // longer stop; the catch block below classifies the cancellation.
    // Mirrors run-controller.ts's cancelDuringPrepare checkpoint (ADR 0052).
    const cancelDuringPrepare = input.activeRuns.get(input.firingId);
    if (cancelDuringPrepare?.cancelRequested === true) {
      throw new Error(
        `routine firing ${input.firingId} was cancelled before provider start`
      );
    }

    providerAttempt = (async () => {
      for await (const event of input.provider.runAttempt({
        branchName: prepared.branchName,
        issue: routineIssueSnapshot(input.routine),
        prompt: evidence.prompt,
        promptPath: evidence.promptPath,
        provider: {
          command: input.providerCommand,
          name: input.providerName
        },
        run: {
          attempt: 1,
          id: input.firingId
        },
        routine: {
          ...(input.routine.effort === undefined
            ? {}
            : { effort: input.routine.effort }),
          ...(input.routine.model === undefined
            ? {}
            : { model: input.routine.model }),
          ...(input.routine.permissionMode === undefined
            ? {}
            : { permissionMode: input.routine.permissionMode })
        },
        workspacePath: prepared.workspacePath
      })) {
        await appendRoutineEvent({
          event,
          normalizedLogPath,
          rawLogPath
        });
        if (event.normalized !== undefined) {
          events.push(event.normalized);
        }
      }
    })();
    await deadline.race(providerAttempt);
    // Mirrors classifyFailure's cancelRequested fast path (checked before
    // any exit-code/event inspection there too): once an operator cancel is
    // observed, the firing reports cancelled even if the process happened
    // to exit cleanly in the same race.
    const cancelEntry = input.activeRuns.get(input.firingId);
    const outcome =
      cancelEntry?.cancelRequested === true
        ? { kind: "cancelled" as const, reason: "cancelled" }
        : await deadline.race(
            classifyRoutineOutcome(events, {
              baseBranch: input.project.workspace.git.base_branch,
              kind: input.routine.kind,
              workspacePath: prepared.workspacePath
            })
          );
    input.runStore.completeRoutineFiring({
      id: input.firingId,
      state: outcome.kind,
      terminalReason: outcome.reason.length === 0 ? null : outcome.reason,
      ...(cancelEntry?.cancelReason === undefined
        ? {}
        : { cancelReason: cancelEntry.cancelReason }),
      workspacePath: prepared.workspacePath
    });
    // The firing is terminal now. PR discovery is post-terminal enrichment,
    // so it must not let the execution deadline rewrite a completed outcome.
    deadline.clear();
    if (outcome.kind === "succeeded" && input.routine.kind === "git") {
      await discoverRoutinePullRequests({
        branchName: prepared.branchName,
        env: input.env,
        firingId: input.firingId,
        githubIssuesApi: input.githubIssuesApi,
        logger: input.logger,
        project: input.project,
        routineName: input.routine.name,
        runStore: input.runStore
      });
    }
  } catch (error) {
    const timedOut = error instanceof RoutineFiringTimeoutError;
    if (timedOut) {
      await input.provider.cancel(input.firingId).catch(() => undefined);
      await providerAttempt?.catch(() => undefined);
    }
    const cancelEntry = input.activeRuns.get(input.firingId);
    const cancelled = !timedOut && cancelEntry?.cancelRequested === true;
    const reason = timedOut
      ? error.terminalReason
      : cancelled
        ? "cancelled"
        : error instanceof RoutinePromptRenderError
          ? error.terminalReason
          : errorMessage(error);
    input.runStore.completeRoutineFiring({
      id: input.firingId,
      state: cancelled ? "cancelled" : "failed",
      terminalReason: reason,
      ...(cancelEntry?.cancelReason === undefined
        ? {}
        : { cancelReason: cancelEntry.cancelReason }),
      ...(prepared === undefined
        ? {}
        : { workspacePath: prepared.workspacePath })
    });
  } finally {
    deadline.clear();
  }
  return { events, prepared };
}

async function recordRoutineFiringNotification(
  input: {
    env: NodeJS.ProcessEnv;
    firingId: string;
    logger: Logger | undefined;
    notification:
      | {
          createSink: (config: EmailNotificationConfig) => NotificationSink;
          resolveConfig: () => EmailNotificationConfig | undefined;
        }
      | undefined;
    project: RunControllerProjectConfig;
    routine: RoutineStatus & { prompt: string };
    runStore: RunStore;
  },
  events: NormalizedProviderEvent[],
  prepared: PreparedRoutineWorkspace | undefined
): Promise<void> {
  if (input.notification === undefined) {
    return;
  }
  const firing = input.runStore.getRoutineFiring(input.firingId);
  if (
    firing === undefined ||
    (firing.state !== "succeeded" &&
      firing.state !== "failed" &&
      firing.state !== "cancelled")
  ) {
    return;
  }
  // Resolved at delivery time (not at dispatch time) so a Service Config
  // reload during a long-running firing still affects this delivery per
  // ADR 0067.
  const config = input.notification.resolveConfig();
  if (config === undefined) {
    return;
  }
  const sink = input.notification.createSink(config);
  const outcome = await deliverRoutineFiringNotification({
    config,
    firing: {
      branchName:
        prepared?.branchName ?? input.project.workspace.git.base_branch,
      durationMs: Math.max(
        0,
        Date.parse(firing.updatedAt) - Date.parse(firing.createdAt)
      ),
      firingId: firing.id,
      kind: input.routine.kind,
      projectName: input.project.name,
      pullRequests: firing.pullRequests,
      reportOutput: redactSecret(
        reportOutputFromEvents(events),
        input.env[config.smtpPasswordEnv]
      ),
      routineName: input.routine.name,
      state: firing.state,
      terminalReason: firing.terminalReason,
      title: `${input.project.name}: ${input.routine.name}`
    },
    notifyEnabled: input.routine.notify !== false,
    sink
  });
  if (outcome.state === "failed") {
    const error = redactNotificationError(outcome.error, config, input.env);
    input.runStore.recordRoutineFiringNotification({
      error,
      id: input.firingId,
      state: "failed"
    });
    input.logger?.warn(
      {
        error,
        firingId: input.firingId,
        project: input.project.name,
        routine: input.routine.name
      },
      "symphonika routine notification delivery failed"
    );
    return;
  }
  input.runStore.recordRoutineFiringNotification({
    id: input.firingId,
    state: outcome.state
  });
}

function reportOutputFromEvents(events: NormalizedProviderEvent[]): string {
  return events
    .filter(
      (event) =>
        event.type === "message" &&
        event.messageKind !== "thinking" &&
        typeof event.message === "string"
    )
    .map((event) => event.message as string)
    .join("")
    .trim();
}

function redactNotificationError(
  message: string,
  config: EmailNotificationConfig,
  env: NodeJS.ProcessEnv
): string {
  const secret =
    config.smtpUsername === undefined ? undefined : env[config.smtpPasswordEnv];
  return redactSecret(message, secret);
}

function redactSecret(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) {
    return message;
  }
  return message.split(secret).join("[REDACTED]");
}

function routineFiringDeadline(timeoutMinutes: number | undefined): {
  clear: () => void;
  race: <T>(operation: Promise<T>) => Promise<T>;
} {
  if (timeoutMinutes === undefined) {
    return {
      clear: () => undefined,
      race: (operation) => operation
    };
  }

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RoutineFiringTimeoutError());
    }, timeoutMinutes * 60_000);
  });
  return {
    clear: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    race: (operation) => Promise.race([operation, expired])
  };
}

async function prepareRoutineEvidence(input: {
  firingId: string;
  configDir: string;
  prepared: PreparedRoutineWorkspace;
  project: RunControllerProjectConfig;
  providerCommand: string;
  providerName: AgentProviderName;
  routine: RoutineStatus & { prompt: string };
  stateRoot: string;
}): Promise<{
  normalizedLogPath: string;
  prompt: string;
  promptPath: string;
  rawLogPath: string;
}> {
  const routine = input.routine;
  const rendered = renderRoutinePrompt({
    ...(routine.kind === "git"
      ? {
          branch: {
            name: input.prepared.branchName,
            ref: input.prepared.branchRef
          }
        }
      : {}),
    firing: { id: input.firingId },
    project: { name: input.project.name },
    provider: { command: input.providerCommand, name: input.providerName },
    routine: {
      kind: routine.kind,
      name: routine.name,
      schedule_at: routine.scheduleAt,
      schedule_cron: routine.scheduleCron,
      schedule_tz: routine.scheduleTz,
      source_path: routine.sourcePath
    },
    template: routine.prompt,
    templatePath: routine.sourcePath,
    workspace: {
      path: input.prepared.workspacePath,
      root: path.resolve(input.configDir, input.project.workspace.root)
    }
  });
  const directory = path.join(
    path.resolve(input.stateRoot),
    "logs",
    "routines",
    safePathSegment(input.firingId)
  );
  await mkdir(directory, { recursive: true });
  const promptPath = path.join(directory, "prompt.md");
  const metadataPath = path.join(directory, "prompt-metadata.json");
  const rawLogPath = path.join(directory, "provider.raw.jsonl");
  const normalizedLogPath = path.join(directory, "provider.normalized.jsonl");
  await Promise.all([
    writeFile(promptPath, rendered.prompt, "utf8"),
    writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          autonomy_preamble_version: rendered.preambleVersion,
          ...(routine.kind === "git"
            ? {
                branch: {
                  name: input.prepared.branchName,
                  ref: input.prepared.branchRef
                }
              }
            : {}),
          firing: { id: input.firingId },
          project: { name: input.project.name },
          provider: {
            command: input.providerCommand,
            name: input.providerName
          },
          routine: {
            kind: routine.kind,
            name: routine.name,
            schedule_at: routine.scheduleAt,
            schedule_cron: routine.scheduleCron,
            schedule_tz: routine.scheduleTz,
            source_path: routine.sourcePath
          },
          template_content_hash: rendered.templateContentHash,
          workspace: {
            path: input.prepared.workspacePath,
            root: path.resolve(input.configDir, input.project.workspace.root)
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    ),
    writeFile(rawLogPath, "", "utf8"),
    writeFile(normalizedLogPath, "", "utf8")
  ]);
  return {
    normalizedLogPath,
    prompt: rendered.prompt,
    promptPath,
    rawLogPath
  };
}

async function appendRoutineEvent(input: {
  event: ProviderEvent;
  normalizedLogPath: string;
  rawLogPath: string;
}): Promise<void> {
  await Promise.all([
    appendJsonl(input.rawLogPath, input.event.raw),
    ...(input.event.normalized === undefined
      ? []
      : [appendJsonl(input.normalizedLogPath, input.event.normalized)])
  ]);
}

async function classifyRoutineOutcome(
  events: NormalizedProviderEvent[],
  workspace: {
    baseBranch: string;
    kind: RoutineStatus["kind"];
    workspacePath: string;
  }
): Promise<RoutineTerminalOutcome> {
  if (workspace.kind === "git") {
    // The caller (runRoutineFiring) always intercepts a real cancel before
    // reaching this call, so this classifyFailure fast path is never live —
    // kept false rather than threaded through for a call the caller has
    // already ruled out.
    const classified = await classifyFailure({
      cancelRequested: false,
      events,
      successWorkspace: {
        baseBranch: workspace.baseBranch,
        workspacePath: workspace.workspacePath
      }
    });
    switch (classified.kind) {
      case "success":
        return { kind: "succeeded", reason: classified.reason };
      case "cancelled":
        return { kind: "cancelled", reason: classified.reason };
      case "failed":
      case "input_required":
        return { kind: "failed", reason: classified.reason };
    }
  }
  const inputRequired = events.find((event) => event.type === "input_required");
  if (inputRequired !== undefined) {
    return {
      kind: "failed",
      reason:
        stringField(inputRequired, "message") ?? "provider requested input"
    };
  }
  if (events.some((event) => event.type === "malformed_event")) {
    return { kind: "failed", reason: "malformed_provider_event" };
  }
  const turnFailed = events.find((event) => event.type === "turn_failed");
  if (turnFailed !== undefined) {
    return {
      kind: "failed",
      reason: stringField(turnFailed, "message") ?? "turn_failed"
    };
  }
  const exit = events.find((event) => event.type === "process_exit");
  if (exit === undefined) {
    return { kind: "failed", reason: "no_process_exit_event" };
  }
  if (exit.cancelled === true) {
    return { kind: "cancelled", reason: "provider_cancelled" };
  }
  const exitCode = numberField(exit, "exitCode");
  if (exitCode === 0) {
    return { kind: "succeeded", reason: "" };
  }
  return {
    kind: "failed",
    reason:
      exitCode === undefined
        ? `process_exit_signal_${stringField(exit, "signal") ?? "unknown"}`
        : `process_exit_${exitCode}`
  };
}

async function discoverRoutinePullRequests(input: {
  branchName: string;
  env: NodeJS.ProcessEnv;
  firingId: string;
  githubIssuesApi: GitHubIssuesApi | undefined;
  logger: Logger | undefined;
  project: RunControllerProjectConfig;
  routineName: string;
  runStore: RunStore;
}): Promise<void> {
  if (
    input.githubIssuesApi === undefined ||
    input.project.tracker === undefined
  ) {
    return;
  }
  const token = resolveEnvBackedValue(input.project.tracker.token, input.env);
  if (token === undefined) {
    input.logger?.warn(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine PR discovery token unavailable"
    );
    return;
  }

  let pullRequests: RawGitHubPullRequest[] | undefined;
  try {
    pullRequests = await tryListPullRequestsForBranch(input.githubIssuesApi, {
      branch: input.branchName,
      owner: input.project.tracker.owner,
      repo: input.project.tracker.repo,
      token
    });
  } catch (error) {
    input.logger?.warn(
      { branch: input.branchName, err: error },
      "symphonika routine PR discovery failed"
    );
    return;
  }

  for (const pullRequest of pullRequests ?? []) {
    if (!isOpenPullRequestForBranch(pullRequest, input.branchName)) {
      continue;
    }
    input.runStore.recordRoutinePullRequest({
      firingId: input.firingId,
      headSha: pullRequest.head.sha,
      prNumber: pullRequest.number,
      projectName: input.project.name,
      routineName: input.routineName
    });
  }
}

function isOpenPullRequestForBranch(
  pullRequest: RawGitHubPullRequest,
  branchName: string
): pullRequest is RawGitHubPullRequest & {
  head: { ref: string; sha: string };
  number: number;
} {
  return (
    pullRequest.state === "open" &&
    pullRequest.number !== undefined &&
    pullRequest.number > 0 &&
    pullRequest.head?.ref === branchName &&
    pullRequest.head.sha !== undefined &&
    pullRequest.head.sha.length > 0
  );
}

function capSkipReason(
  activeRuns: ActiveRunRegistry,
  globalConcurrency: { maxInFlight: number | undefined },
  project: RunControllerProjectConfig
): string | null {
  if (
    globalConcurrency.maxInFlight !== undefined &&
    activeRuns.countInFlight() >= globalConcurrency.maxInFlight
  ) {
    return `global max_in_flight (${globalConcurrency.maxInFlight}) reached`;
  }
  const projectMax = project.max_in_flight ?? 1;
  if (activeRuns.countInFlightByProject(project.name) >= projectMax) {
    return `project ${project.name} max_in_flight (${projectMax}) reached`;
  }
  return null;
}

function routineIssueSnapshot(routine: RoutineStatus) {
  return {
    body: "",
    created_at: "",
    id: 0,
    labels: [`routine:${routine.name}`],
    number: 0,
    priority: 99,
    state: "open" as const,
    title: routine.name,
    updated_at: "",
    url: ""
  };
}

function syntheticRoutineIssueNumber(firingId: string): number {
  let hash = 0;
  for (const char of firingId) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return -Math.max(1, Math.abs(hash));
}

function routineSchedule(routine: RoutineStatus): RoutineSchedule {
  if (routine.scheduleCron !== null) {
    return {
      cron: routine.scheduleCron,
      tz: routine.scheduleTz ?? "Etc/UTC"
    };
  }
  if (routine.scheduleAt === null) {
    throw new Error(
      `routine ${routine.projectName}/${routine.name} has no persisted schedule`
    );
  }
  return { at: routine.scheduleAt };
}

function recordDueRoutineSkip(
  runStore: RunStore,
  input: {
    evaluation: Extract<RoutineScheduleEvaluation, { kind: "fire_now" }>;
    now: Date;
    projectName: string;
    reason: "overlap" | "concurrency_cap";
    routine: RoutineStatus;
  }
): boolean {
  return runStore.skipRoutineFiring({
    attemptedAt: input.now.toISOString(),
    name: input.routine.name,
    ...(input.evaluation.nextAt === undefined
      ? {}
      : { nextFireAt: input.evaluation.nextAt }),
    projectName: input.projectName,
    reason: input.reason
  });
}

function logRoutineSkip(
  logger: Logger | undefined,
  input: {
    reason: "overlap" | "concurrency_cap" | "catch_up_window";
    routine: string;
    scheduledAt: string;
  }
): void {
  logger?.info(
    {
      reason: input.reason,
      routine: input.routine,
      scheduled_at: input.scheduledAt
    },
    "routine.skipped"
  );
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value === "object" && value !== null && key in value) {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
  }
  return undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value === "object" && value !== null && key in value) {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "number" ? field : undefined;
  }
  return undefined;
}

function safePathSegment(input: string): string {
  const segment = input
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment.length === 0 ? "firing" : segment;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
