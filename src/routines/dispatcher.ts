import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type { ActiveRunRegistry } from "../lifecycle/active-runs.js";
import {
  classifyFailure,
  inspectWorkspaceCommitsAhead
} from "../lifecycle/classify-failure.js";
import {
  resolveEnvBackedValue,
  tryListIssues,
  tryListPullRequestsForBranch,
  type GitHubIssuesApi,
  type RawGitHubIssue,
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
  renderRoutineFanoutNotification,
  type RoutineFanoutNotification
} from "./fanout-summary.js";
import {
  evaluateRoutineSchedule,
  nextRecurringFireAt,
  type RoutineScheduleEvaluation
} from "./schedule.js";
import {
  diffRoutineGithubSnapshots,
  parseRoutineOutcomeClaim,
  reconcileRoutineOutcome,
  ROUTINE_OUTCOME_JSON_SCHEMA,
  type RoutineGithubSnapshot,
  type RoutineOutcomeClaim
} from "./outcome.js";
import {
  renderRoutinePrompt,
  RoutinePromptRenderError
} from "./prompt-renderer.js";
import { routineEvidencePaths } from "./evidence.js";
import type {
  RoutineSchedule,
  RoutineState,
  RoutineStatus,
  TargetedRoutineDeclaration
} from "./types.js";
import { createUlid } from "./ulid.js";
import {
  planRoutineWorkspacePaths,
  prepareRoutineWorkspace as defaultPrepareRoutineWorkspace,
  type PreparedRoutineWorkspace,
  type PrepareRoutineWorkspaceInput
} from "./workspace.js";

export type DispatchDueRoutinesInput = {
  activeRuns: ActiveRunRegistry;
  agentProviders: AgentProviderRegistry;
  configDir: string;
  createFanoutId?: () => string;
  createFiringId?: () => string;
  env?: NodeJS.ProcessEnv;
  globalConcurrency: { maxInFlight: number | undefined };
  githubIssuesApi?: GitHubIssuesApi;
  inspectWorkspaceCommitsAhead?: typeof inspectWorkspaceCommitsAhead;
  logger?: Logger;
  notification?: {
    createSink: (config: EmailNotificationConfig) => NotificationSink;
    resolveConfig: () => EmailNotificationConfig | undefined;
    timeoutMs?: number;
  };
  notifyRoutineFanout?: (
    notification: RoutineFanoutNotification
  ) => Promise<void>;
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

// A single firing's before/after GitHub snapshots are captured minutes apart
// at most, so bounding `state: "all"` issue pagination to this window (well
// above any realistic firing duration) avoids paginating a repository's
// entire issue/PR history on every firing.
const ISSUE_SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000;

const EPOCH_ISO = new Date(0).toISOString();

type CapturedRoutineGithubSnapshot = {
  issuesAvailable: boolean;
  pullRequests: RawGitHubPullRequest[];
  pullRequestsAvailable: boolean;
  snapshot: RoutineGithubSnapshot;
};

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
  const workspacePlan = planRoutineWorkspacePaths({
    configDir: input.configDir,
    firingId,
    kind: detail.kind,
    project,
    routineName: routine.name
  });
  const claimed = input.runStore.claimManualRoutineFiring({
    branchName: workspacePlan.branchName,
    branchRef: workspacePlan.branchRef,
    firingId,
    forceOperatorDisabled,
    projectName: routine.projectName,
    providerCommand,
    providerName,
    routineName: routine.name,
    workspacePath: workspacePlan.workspacePath
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
    inspectWorkspaceCommitsAhead:
      input.inspectWorkspaceCommitsAhead ?? inspectWorkspaceCommitsAhead,
    logger: input.logger,
    now: new Date(),
    prepareRoutineWorkspace:
      input.prepareRoutineWorkspace ?? defaultPrepareRoutineWorkspace,
    project,
    provider,
    providerCommand,
    providerName,
    // A closure, not a snapshot: resolved fresh on every call so a Service
    // Config reload mid-firing (changing smtp_password_env or its value) is
    // honored by evidence recorded after the reload, matching the delivery
    // config's own re-resolution in recordRoutineFiringNotification (ADR
    // 0067).
    redactSecrets: () =>
      resolveRedactSecrets(input.notification, input.env ?? process.env),
    routine: detail,
    runStore: input.runStore,
    stateRoot: input.stateRoot
  })
    .finally(() => {
      input.activeRuns.unregister(firingId);
    })
    .then((firingResult) =>
      // Same ordering as dispatchDueRoutines's per-firing task chain: the
      // concurrency slot above is released before notification delivery
      // starts, so a stalled relay does not suppress further dispatch.
      recordRoutineFiringNotification(
        {
          env: input.env ?? process.env,
          firingId,
          logger: input.logger,
          notification: input.notification,
          project,
          routine: detail,
          runStore: input.runStore
        },
        firingResult.events,
        firingResult.prepared
      )
    );
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
  const createFanoutId = input.createFanoutId ?? (() => createUlid());
  const projects = [...input.projects.values()];
  const fanoutIds = new Map<string, string>();
  const firingTasks: Promise<void>[] = [];
  const redactSecrets = (): string[] =>
    resolveRedactSecrets(input.notification, input.env ?? process.env);

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
  input.runStore.settleUnavailableRoutineFanoutTargets();

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
      const scheduledAt = routine.nextFireAt ?? now.toISOString();
      const fanoutKey = `${routine.name}\0${scheduledAt}`;
      let fanoutId = fanoutIds.get(fanoutKey);
      if (fanoutId === undefined) {
        const targetProjectNames = input.runStore
          .listRoutines()
          .filter(
            (target) =>
              target.name === routine.name &&
              target.state === "active" &&
              target.nextFireAt === scheduledAt
          )
          .map((target) => target.projectName);
        fanoutId = input.runStore.ensureRoutineFanout({
          id: createFanoutId(),
          projectNames: targetProjectNames,
          routineName: routine.name,
          scheduledAt
        }).id;
        fanoutIds.set(fanoutKey, fanoutId);
      }
      // Fan-out membership is the immutable snapshot captured when this
      // clock event first began. A one-shot target added by a later reload
      // can still carry the same due scheduled_at, but must not join the
      // already-running or delivered event and force a duplicate summary.
      if (
        !input.runStore.hasRoutineFanoutTarget({
          id: fanoutId,
          projectName: project.name
        })
      ) {
        if (
          recordDueRoutineSkip(input.runStore, {
            evaluation,
            now,
            projectName: project.name,
            reason: "catch_up_window",
            routine
          })
        ) {
          logRoutineSkip(input.logger, {
            reason: "catch_up_window",
            routine: routine.name,
            scheduledAt
          });
          skipped.push({
            projectName: project.name,
            reason: "catch_up_window",
            routineName: routine.name
          });
        }
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
            fanoutId,
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
            fanoutId,
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
      const workspacePlan = planRoutineWorkspacePaths({
        configDir: input.configDir,
        firingId,
        kind: routineDetail.kind,
        project,
        routineName: routine.name
      });
      const claimed = input.runStore.claimRoutineFiring({
        branchName: workspacePlan.branchName,
        branchRef: workspacePlan.branchRef,
        fanoutId,
        firedAt: now.toISOString(),
        firingId,
        ...(reEvaluation.nextAt === undefined
          ? {}
          : { nextFireAt: reEvaluation.nextAt }),
        projectName: project.name,
        providerCommand,
        providerName,
        routineName: routine.name,
        scheduledAt: routineDetail.nextFireAt ?? now.toISOString(),
        workspacePath: workspacePlan.workspacePath
      });
      if (!claimed) {
        skipped.push({
          projectName: project.name,
          reason: "routine already claimed by another worker",
          routineName: routine.name
        });
        continue;
      }

      input.activeRuns.reserveSlot({
        issueNumber: syntheticRoutineIssueNumber(firingId),
        projectName: project.name,
        respectsIssueLabels: false,
        runId: firingId
      });
      fired.push(firingId);
      const firingTask = runRoutineFiring({
        firingId,
        env: input.env ?? process.env,
        githubIssuesApi: input.githubIssuesApi,
        inspectWorkspaceCommitsAhead:
          input.inspectWorkspaceCommitsAhead ?? inspectWorkspaceCommitsAhead,
        logger: input.logger,
        now,
        prepareRoutineWorkspace,
        project,
        provider,
        providerCommand,
        providerName,
        redactSecrets,
        routine: routineDetail,
        runStore: input.runStore,
        stateRoot: input.stateRoot,
        configDir: input.configDir,
        activeRuns: input.activeRuns
      })
        .finally(() => {
          input.activeRuns.unregister(firingId);
        })
        .then((firingResult) =>
          // Notification delivery is best-effort and can be as slow as the
          // SMTP server allows (see ADR 0067); it runs after the slot above
          // is released so a stalled relay does not suppress further
          // dispatch for this project.
          recordRoutineFiringNotification(
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
          )
        );
      firingTasks.push(firingTask);
    }
  }

  await Promise.all(firingTasks);
  await deliverReadyRoutineFanouts(input);
  return { fired, skipped };
}

type RoutineFiringResult = {
  events: NormalizedProviderEvent[];
  prepared: PreparedRoutineWorkspace | undefined;
};

async function deliverReadyRoutineFanouts(
  input: DispatchDueRoutinesInput
): Promise<void> {
  if (input.notifyRoutineFanout === undefined) {
    return;
  }
  for (const fanout of input.runStore.listReadyRoutineFanouts()) {
    if (!input.runStore.claimRoutineFanoutNotification(fanout.id)) {
      continue;
    }
    // Re-fetch rather than reuse the pre-claim snapshot: a re-entrant reload
    // (ADR 0052) can add and even terminate a new target between the
    // snapshot above and this claim succeeding, and that target's result
    // must still make it into the rendered payload.
    const claimed = input.runStore.getRoutineFanout(fanout.id);
    if (claimed === undefined) {
      throw new Error("claimed routine fan-out could not be reloaded");
    }
    try {
      await input.notifyRoutineFanout(renderRoutineFanoutNotification(claimed));
      input.runStore.completeRoutineFanoutNotification({
        id: claimed.id
      });
    } catch (error) {
      const message = errorMessage(error);
      input.runStore.completeRoutineFanoutNotification({
        error: message,
        id: claimed.id
      });
      input.logger?.warn(
        { err: error, fanout: claimed.id, routine: claimed.routineName },
        "symphonika routine fan-out notification failed"
      );
    }
  }
}

async function runRoutineFiring(input: {
  activeRuns: ActiveRunRegistry;
  configDir: string;
  env: NodeJS.ProcessEnv;
  firingId: string;
  githubIssuesApi: GitHubIssuesApi | undefined;
  inspectWorkspaceCommitsAhead: typeof inspectWorkspaceCommitsAhead;
  logger: Logger | undefined;
  now: Date;
  prepareRoutineWorkspace: (
    input: PrepareRoutineWorkspaceInput
  ) => Promise<PreparedRoutineWorkspace>;
  project: RunControllerProjectConfig;
  provider: NonNullable<AgentProviderRegistry[AgentProviderName]>;
  providerCommand: string;
  providerName: AgentProviderName;
  redactSecrets: () => string[];
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
  let githubBefore: CapturedRoutineGithubSnapshot | null = null;
  // Bounds `state: "all"` issue pagination to records that could plausibly
  // have changed during this firing, instead of the repository's entire
  // issue/PR history (a single firing runs for at most this window).
  const githubSnapshotSince = new Date(
    input.now.getTime() - ISSUE_SNAPSHOT_WINDOW_MS
  ).toISOString();
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
    input.runStore.updateRoutineFiringWorkspace({
      branchName: prepared.branchName,
      branchRef: prepared.branchRef,
      id: input.firingId,
      workspacePath: prepared.workspacePath
    });
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

    githubBefore = await deadline.race(
      captureRoutineGithubSnapshot({
        branchName: prepared.branchName,
        env: input.env,
        githubIssuesApi: input.githubIssuesApi,
        kind: input.routine.kind,
        logger: input.logger,
        project: input.project,
        routineName: input.routine.name,
        since: githubSnapshotSince
      })
    );

    // A cancel can also land DURING the snapshot read just above; the
    // cancelDuringPrepare check earlier only covers the window before it.
    // Re-check before spawning the provider for the same reason as that
    // earlier check (ADR 0052).
    const cancelBeforeProviderStart = input.activeRuns.get(input.firingId);
    if (cancelBeforeProviderStart?.cancelRequested === true) {
      throw new Error(
        `routine firing ${input.firingId} was cancelled before provider start`
      );
    }

    providerAttempt = (async () => {
      for await (const event of input.provider.runAttempt({
        branchName: prepared.branchName,
        issue: routineIssueSnapshot(input.routine),
        outputSchema: ROUTINE_OUTCOME_JSON_SCHEMA,
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
          rawLogPath,
          redactSecrets: input.redactSecrets
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
    let outcome: RoutineTerminalOutcome =
      cancelEntry?.cancelRequested === true
        ? { kind: "cancelled" as const, reason: "cancelled" }
        : await deadline.race(
            classifyRoutineOutcome(events, {
              baseBranch: input.project.workspace.git.base_branch,
              kind: input.routine.kind,
              workspacePath: prepared.workspacePath
            })
          );
    const githubAfter =
      githubBefore === null
        ? null
        : await deadline.race(
            captureRoutineGithubSnapshot({
              branchName: prepared.branchName,
              env: input.env,
              githubIssuesApi: input.githubIssuesApi,
              kind: input.routine.kind,
              logger: input.logger,
              project: input.project,
              routineName: input.routine.name,
              since: githubSnapshotSince
            })
          );
    // A cancel can also land DURING the snapshot read just above, after
    // `outcome` above was already classified as succeeded/failed. Downgrade
    // the lifecycle state here; the independent retention inspection below
    // still protects any commits already created in the workspace.
    const cancelAfterGithubAfter = input.activeRuns.get(input.firingId);
    if (cancelAfterGithubAfter?.cancelRequested === true) {
      outcome = { kind: "cancelled", reason: "cancelled" };
    }
    // The firing's own execution phase is done. PR discovery is post-terminal
    // enrichment, so it must not let the execution deadline rewrite a
    // completed outcome.
    deadline.clear();
    // Pull-request discovery must finish before this firing is recorded as
    // terminal: listReadyRoutineFanouts() only looks at routine_firings.state,
    // and daemon ticks are explicitly re-entrant (ADR 0052), so a concurrent
    // tick could otherwise observe "succeeded" and send the grouped summary
    // with this leg's PRs missing, before discovery has recorded them.
    if (outcome.kind === "succeeded" && input.routine.kind === "git") {
      if (githubAfter?.pullRequestsAvailable === true) {
        recordRoutinePullRequests({
          branchName: prepared.branchName,
          firingId: input.firingId,
          projectName: input.project.name,
          pullRequests: githubAfter.pullRequests,
          routineName: input.routine.name,
          runStore: input.runStore
        });
      } else {
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
    }
    // Re-check for a cancel that landed during discovery: an operator cancel
    // still wins even though the provider itself already finished (ADR 0060).
    const cancelBeforeCommitInspection = input.activeRuns.get(input.firingId);
    if (cancelBeforeCommitInspection?.cancelRequested === true) {
      outcome = { kind: "cancelled", reason: "cancelled" };
    }
    const commitsAhead =
      outcome.kind === "succeeded"
        ? input.routine.kind === "git"
        : await inspectRoutineCommitsAhead({
            baseBranch: input.project.workspace.git.base_branch,
            kind: input.routine.kind,
            logger: input.logger,
            routineName: input.routine.name,
            inspectWorkspaceCommitsAhead: input.inspectWorkspaceCommitsAhead,
            workspacePath: prepared.workspacePath
          });
    // The failed/cancelled retention inspection above shells out to Git. A
    // cancel can land while that subprocess is running, so use a fresh entry
    // for both lifecycle classification and its matching cancel reason.
    const completionCancelEntry = input.activeRuns.get(input.firingId);
    if (completionCancelEntry?.cancelRequested === true) {
      outcome = { kind: "cancelled", reason: "cancelled" };
    }
    const githubObservation = routineGithubObservation(
      githubBefore,
      githubAfter,
      input.routine.kind,
      githubSnapshotSince
    );
    const resolvedRedactSecrets = input.redactSecrets();
    const redactedTerminalReason =
      outcome.reason.length === 0
        ? null
        : redactAll(outcome.reason, resolvedRedactSecrets);
    input.runStore.completeRoutineFiring({
      commitsAhead,
      id: input.firingId,
      outcome: reconcileRoutineOutcome({
        claim: redactRoutineOutcomeClaim(
          parseRoutineOutcomeClaim(events),
          resolvedRedactSecrets
        ),
        commitsAhead,
        githubObservationAvailable: githubObservation.available,
        observedAction: githubObservation.action,
        provider: input.providerName,
        terminalReason: redactedTerminalReason,
        terminalState: outcome.kind
      }),
      state: outcome.kind,
      terminalReason: redactedTerminalReason,
      ...(completionCancelEntry?.cancelReason === undefined
        ? {}
        : { cancelReason: completionCancelEntry.cancelReason }),
      workspacePath: prepared.workspacePath
    });
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
    // The deadline may already be expired here (we can be in this catch
    // block precisely because it expired). deadline.race would then reject
    // again immediately with the same timeout error, and — unlike the try
    // block above — there is no outer catch left to route that into; left
    // unhandled, it would abort runRoutineFiring before completeRoutineFiring
    // runs, stranding the row in a non-terminal state. Treat that as
    // "snapshot unavailable" — but still surface the expiry itself: SPEC.md
    // §12.2/ADR 0067 make terminal outcome classification part of the raced
    // scope and require `firing_timeout` to win over whatever reason drove
    // us into this catch block, the same precedence `timedOut` already
    // applies to the entry error above.
    let failureSnapshotTimedOut = false;
    const githubAfter =
      githubBefore === null || prepared === undefined
        ? null
        : await deadline
            .race(
              captureRoutineGithubSnapshot({
                branchName: prepared.branchName,
                env: input.env,
                githubIssuesApi: input.githubIssuesApi,
                kind: input.routine.kind,
                logger: input.logger,
                project: input.project,
                routineName: input.routine.name,
                since: githubSnapshotSince
              })
            )
            .catch((snapshotError: unknown) => {
              if (snapshotError instanceof RoutineFiringTimeoutError) {
                failureSnapshotTimedOut = true;
              }
              return null;
            });
    // A cancel can also land DURING the snapshot read just above, after
    // `cancelled`/`reason` above were already computed from the pre-await
    // state. Re-check so a cancel arriving in this window doesn't get
    // persisted as a stale failed/pre-cancellation reason. A timeout newly
    // discovered by the snapshot race takes precedence over both, matching
    // `timedOut`'s precedence over `cancelled` above.
    const cancelAfterFailureSnapshot = input.activeRuns.get(input.firingId);
    const githubObservation = routineGithubObservation(
      githubBefore,
      githubAfter,
      input.routine.kind,
      githubSnapshotSince
    );
    const commitsAhead =
      prepared === undefined
        ? false
        : await inspectRoutineCommitsAhead({
            baseBranch: input.project.workspace.git.base_branch,
            kind: input.routine.kind,
            logger: input.logger,
            routineName: input.routine.name,
            inspectWorkspaceCommitsAhead: input.inspectWorkspaceCommitsAhead,
            workspacePath: prepared.workspacePath
          });
    // Re-read after the Git subprocess for the same reason as the try path.
    // Either timeout signal still wins over a cancellation that arrived
    // during snapshot capture or commit inspection.
    const completionCancelEntry = input.activeRuns.get(input.firingId);
    const timeoutWon = timedOut || failureSnapshotTimedOut;
    const finalCancelled =
      !timeoutWon &&
      (cancelled ||
        cancelAfterFailureSnapshot?.cancelRequested === true ||
        completionCancelEntry?.cancelRequested === true);
    const finalReason = timeoutWon
      ? "firing_timeout"
      : finalCancelled
        ? "cancelled"
        : reason;
    const resolvedRedactSecrets = input.redactSecrets();
    const redactedFinalReason = redactAll(finalReason, resolvedRedactSecrets);
    input.runStore.completeRoutineFiring({
      commitsAhead,
      id: input.firingId,
      outcome: reconcileRoutineOutcome({
        claim: redactRoutineOutcomeClaim(
          parseRoutineOutcomeClaim(events),
          resolvedRedactSecrets
        ),
        commitsAhead,
        githubObservationAvailable: githubObservation.available,
        observedAction: githubObservation.action,
        provider: input.providerName,
        terminalReason: redactedFinalReason,
        terminalState: finalCancelled ? "cancelled" : "failed"
      }),
      state: finalCancelled ? "cancelled" : "failed",
      terminalReason: redactedFinalReason,
      ...(completionCancelEntry?.cancelReason === undefined
        ? {}
        : { cancelReason: completionCancelEntry.cancelReason }),
      ...(prepared === undefined
        ? {}
        : { workspacePath: prepared.workspacePath })
    });
  } finally {
    deadline.clear();
  }
  return { events, prepared };
}

async function inspectRoutineCommitsAhead(input: {
  baseBranch: string;
  kind: RoutineStatus["kind"];
  logger: Logger | undefined;
  routineName: string;
  inspectWorkspaceCommitsAhead: typeof inspectWorkspaceCommitsAhead;
  workspacePath: string;
}): Promise<boolean> {
  if (input.kind !== "git") {
    return false;
  }
  try {
    return await input.inspectWorkspaceCommitsAhead({
      baseBranch: input.baseBranch,
      workspacePath: input.workspacePath
    });
  } catch (error) {
    input.logger?.warn(
      {
        err: error,
        routine: input.routineName,
        workspacePath: input.workspacePath
      },
      "symphonika routine commits-ahead inspection failed; retaining workspace conservatively"
    );
    return true;
  }
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
          timeoutMs?: number;
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
  const redactSecrets = resolveRedactSecrets(input.notification, input.env);
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
      outcome: firing.outcome,
      projectName: input.project.name,
      pullRequests: firing.pullRequests,
      // The provider's own report output can echo back an inherited env
      // value (full-permission execution, see CLAUDE.md) — redact it here
      // too, not just in the persisted evidence, since this text (not the
      // evidence file) is what actually ends up in the sent email.
      reportOutput: redactAll(reportOutputFromEvents(events), redactSecrets),
      routineName: input.routine.name,
      state: firing.state,
      // Defense-in-depth: terminalReason is already redacted when persisted
      // (runRoutineFiring), but redact again here in case it predates that
      // or reached the store through a path that didn't have redactSecrets.
      terminalReason:
        firing.terminalReason === null
          ? null
          : redactAll(firing.terminalReason, redactSecrets),
      title: `${input.project.name}: ${input.routine.name}`
    },
    notifyEnabled: input.routine.notify !== false,
    sink,
    ...(input.notification.timeoutMs === undefined
      ? {}
      : { timeoutMs: input.notification.timeoutMs })
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
  const output = events
    .filter(
      (event) =>
        event.type === "message" &&
        event.messageKind !== "thinking" &&
        typeof event.message === "string"
    )
    .map((event) => event.message as string)
    .join("")
    .trim();
  const completed = [...events]
    .reverse()
    .find((event) => event.type === "turn_completed");
  if (
    completed === undefined ||
    typeof completed.result !== "string" ||
    parseRoutineOutcomeClaim([completed]) === null
  ) {
    return output;
  }
  const claimText = completed.result.trim();
  return output.endsWith(claimText)
    ? output.slice(0, -claimText.length).trim()
    : output;
}

function redactNotificationError(
  message: string,
  config: EmailNotificationConfig,
  env: NodeJS.ProcessEnv
): string {
  const secret =
    config.smtpUsername === undefined ? undefined : env[config.smtpPasswordEnv];
  if (secret === undefined || secret.length === 0) {
    return message;
  }
  return message.split(secret).join("[REDACTED]");
}

async function captureRoutineGithubSnapshot(input: {
  branchName: string;
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi | undefined;
  kind: RoutineStatus["kind"];
  logger: Logger | undefined;
  project: RunControllerProjectConfig;
  routineName: string;
  since: string;
}): Promise<CapturedRoutineGithubSnapshot | null> {
  if (input.project.tracker === undefined) {
    input.logger?.info(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine issue observation skipped: tracker absent"
    );
    return null;
  }
  if (input.githubIssuesApi === undefined) {
    input.logger?.info(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine GitHub observation skipped: API unavailable"
    );
    return null;
  }
  const token = resolveEnvBackedValue(input.project.tracker.token, input.env);
  if (token === undefined) {
    input.logger?.warn(
      { project: input.project.name, routine: input.routineName },
      "symphonika routine GitHub observation token unavailable"
    );
    return null;
  }

  let issues: RawGitHubIssue[] = [];
  let issuesAvailable = false;
  try {
    const listed = await tryListIssues(input.githubIssuesApi, {
      owner: input.project.tracker.owner,
      repo: input.project.tracker.repo,
      since: input.since,
      state: "all",
      token
    });
    if (listed === undefined) {
      input.logger?.info(
        { project: input.project.name, routine: input.routineName },
        "symphonika routine issue observation skipped: API unsupported"
      );
    } else {
      issues = listed;
      issuesAvailable = true;
    }
  } catch (error) {
    input.logger?.warn(
      { err: error, project: input.project.name, routine: input.routineName },
      "symphonika routine issue observation failed"
    );
  }

  let pullRequests: RawGitHubPullRequest[] = [];
  let pullRequestsAvailable = false;
  if (input.kind === "git") {
    try {
      const listed = await tryListPullRequestsForBranch(input.githubIssuesApi, {
        branch: input.branchName,
        owner: input.project.tracker.owner,
        repo: input.project.tracker.repo,
        token
      });
      if (listed !== undefined) {
        pullRequests = listed;
        pullRequestsAvailable = true;
      }
    } catch (error) {
      input.logger?.warn(
        { branch: input.branchName, err: error },
        "symphonika routine PR observation failed"
      );
    }
  }

  if (!issuesAvailable && !pullRequestsAvailable) {
    return null;
  }
  return {
    issuesAvailable,
    pullRequests,
    pullRequestsAvailable,
    snapshot: {
      issues: routineIssueObservations(issues),
      pullRequests: routinePullRequestObservations(
        pullRequests,
        input.branchName
      )
    }
  };
}

function routineGithubObservation(
  before: CapturedRoutineGithubSnapshot | null,
  after: CapturedRoutineGithubSnapshot | null,
  kind: RoutineStatus["kind"],
  windowStart: string
): {
  action: ReturnType<typeof diffRoutineGithubSnapshots>;
  available: boolean;
} {
  if (before === null || after === null) {
    return { action: null, available: false };
  }
  const issuesAvailable = before.issuesAvailable && after.issuesAvailable;
  const pullRequestsAvailable =
    before.pullRequestsAvailable && after.pullRequestsAvailable;
  if (!issuesAvailable && !pullRequestsAvailable) {
    return { action: null, available: false };
  }
  // A `kind: git` firing's primary evidence channel is its branch's PRs, so
  // a silently-failed PR read must not be masked by a succeeding issue read
  // (or vice versa); report firings never observe PRs, so issues alone
  // suffice there.
  const available =
    kind === "git" ? issuesAvailable && pullRequestsAvailable : issuesAvailable;
  return {
    action: diffRoutineGithubSnapshots(
      {
        issues: issuesAvailable ? before.snapshot.issues : {},
        pullRequests: pullRequestsAvailable ? before.snapshot.pullRequests : {}
      },
      {
        issues: issuesAvailable ? after.snapshot.issues : {},
        pullRequests: pullRequestsAvailable ? after.snapshot.pullRequests : {}
      },
      windowStart
    ),
    available
  };
}

function routineIssueObservations(
  issues: RawGitHubIssue[]
): RoutineGithubSnapshot["issues"] {
  const observations: RoutineGithubSnapshot["issues"] = {};
  for (const issue of issues) {
    if (
      issue.pull_request !== undefined ||
      issue.number === undefined ||
      issue.number <= 0
    ) {
      continue;
    }
    observations[String(issue.number)] = {
      closedAt: issue.closed_at ?? null,
      // A missing created_at is treated as "always predates the window" so
      // an issue never falsely counts as newly opened for lack of evidence.
      createdAt: issue.created_at ?? EPOCH_ISO,
      state: issue.state ?? "",
      title: issue.title ?? `Issue #${issue.number}`,
      url: issue.html_url ?? null
    };
  }
  return observations;
}

function routinePullRequestObservations(
  pullRequests: RawGitHubPullRequest[],
  branchName: string
): RoutineGithubSnapshot["pullRequests"] {
  const observations: RoutineGithubSnapshot["pullRequests"] = {};
  for (const pullRequest of pullRequests) {
    if (!isPullRequestForBranch(pullRequest, branchName)) {
      continue;
    }
    observations[String(pullRequest.number)] = {
      title: pullRequest.title ?? `Pull request #${pullRequest.number}`,
      url: pullRequest.html_url ?? null
    };
  }
  return observations;
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
  const evidencePaths = routineEvidencePaths(input.stateRoot, input.firingId);
  await mkdir(evidencePaths.directory, { recursive: true });
  const {
    normalizedLogPath,
    promptMetadataPath: metadataPath,
    promptPath,
    rawLogPath
  } = evidencePaths;
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
  redactSecrets: () => string[];
}): Promise<void> {
  const redactSecrets = input.redactSecrets();
  await Promise.all([
    appendJsonl(input.rawLogPath, input.event.raw, redactSecrets),
    ...(input.event.normalized === undefined
      ? []
      : [
          appendJsonl(
            input.normalizedLogPath,
            input.event.normalized,
            redactSecrets
          )
        ])
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

  recordRoutinePullRequests({
    branchName: input.branchName,
    firingId: input.firingId,
    projectName: input.project.name,
    pullRequests: pullRequests ?? [],
    routineName: input.routineName,
    runStore: input.runStore
  });
}

function recordRoutinePullRequests(input: {
  branchName: string;
  firingId: string;
  projectName: string;
  pullRequests: RawGitHubPullRequest[];
  routineName: string;
  runStore: RunStore;
}): void {
  for (const pullRequest of input.pullRequests) {
    if (!isOpenPullRequestForBranch(pullRequest, input.branchName)) {
      continue;
    }
    input.runStore.recordRoutinePullRequest({
      firingId: input.firingId,
      headSha: pullRequest.head.sha,
      prNumber: pullRequest.number,
      projectName: input.projectName,
      routineName: input.routineName
    });
  }
}

// Unlike isOpenPullRequestForBranch, this admits a closed/merged PR: outcome
// observation needs to detect a PR that was opened AND closed within the same
// firing window, not just associate currently-open ones (see
// routinePullRequestObservations).
function isPullRequestForBranch(
  pullRequest: RawGitHubPullRequest,
  branchName: string
): pullRequest is RawGitHubPullRequest & {
  head: { ref: string; sha: string };
  number: number;
} {
  return (
    pullRequest.number !== undefined &&
    pullRequest.number > 0 &&
    pullRequest.head?.ref === branchName &&
    pullRequest.head.sha !== undefined &&
    pullRequest.head.sha.length > 0
  );
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
    fanoutId?: string;
    now: Date;
    projectName: string;
    reason: "overlap" | "concurrency_cap" | "catch_up_window";
    routine: RoutineStatus;
  }
): boolean {
  return runStore.skipRoutineFiring({
    attemptedAt: input.now.toISOString(),
    ...(input.fanoutId === undefined ? {} : { fanoutId: input.fanoutId }),
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

async function appendJsonl(
  filePath: string,
  value: unknown,
  redactSecrets: string[]
): Promise<void> {
  // Redact string values BEFORE serializing, not after: JSON.stringify
  // escapes quotes, backslashes, and control characters, so a secret
  // containing any of them no longer appears as a contiguous substring of
  // the serialized text and a post-serialization redact silently misses it.
  const redacted =
    redactSecrets.length === 0 ? value : redactValueDeep(value, redactSecrets);
  await appendFile(filePath, `${JSON.stringify(redacted)}\n`, "utf8");
}

// A provider's own output can echo back environment values it inherited
// (full-permission execution, see CLAUDE.md) — persisted evidence and any
// terminal reason derived from it must never retain the raw SMTP password.
function redactAll(message: string, redactSecrets: string[]): string {
  return redactSecrets.reduce(
    (acc, secret) =>
      secret.length === 0 ? acc : acc.split(secret).join("[REDACTED]"),
    message
  );
}

function redactRoutineOutcomeClaim(
  claim: RoutineOutcomeClaim | null,
  redactSecrets: string[]
): RoutineOutcomeClaim | null {
  if (claim === null) {
    return null;
  }
  return {
    ...claim,
    summary: redactAll(claim.summary, redactSecrets),
    title: redactAll(claim.title, redactSecrets),
    url: claim.url === null ? null : redactAll(claim.url, redactSecrets)
  };
}

function redactValueDeep(value: unknown, redactSecrets: string[]): unknown {
  if (typeof value === "string") {
    return redactAll(value, redactSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValueDeep(entry, redactSecrets));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactValueDeep(entry, redactSecrets)
      ])
    );
  }
  return value;
}

function resolveRedactSecrets(
  notification: DispatchDueRoutinesInput["notification"],
  env: NodeJS.ProcessEnv
): string[] {
  if (notification === undefined) {
    return [];
  }
  const config = notification.resolveConfig();
  if (config === undefined || config.smtpUsername === undefined) {
    return [];
  }
  const secret = env[config.smtpPasswordEnv];
  return secret === undefined || secret.length === 0 ? [] : [secret];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
