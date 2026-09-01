import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type { ActiveRunRegistry } from "../lifecycle/active-runs.js";
import {
  classifyFailure,
  inspectWorkspaceCommitsAhead
} from "../lifecycle/classify-failure.js";
import { evaluateConcurrencyCapacity } from "../lifecycle/concurrency-capacity.js";
import type { HostPressureVerdict } from "../lifecycle/host-pressure.js";
import {
  createProviderScratch,
  removeProviderScratch
} from "../lifecycle/provider-scratch.js";
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
import { withProviderStderrTail } from "../providers/provider-stderr.js";
import type {
  RunControllerProjectConfig,
  RunControllerProvidersConfig
} from "../lifecycle/run-controller.js";
import {
  secretsForEmailConfig,
  type EmailNotificationConfig
} from "../notifications/config.js";
import type { NotificationDeliveryTracker } from "../notifications/delivery-tracker.js";
import { deliverRoutineFanoutNotification } from "../notifications/routine-fanout.js";
import { deliverRoutineFiringNotification } from "../notifications/routine-firing.js";
import type { NotificationSink } from "../notifications/types.js";
import { redactAll, redactValueDeep } from "../redaction.js";
import type { RoutineFanoutHoldReason, RunStore } from "../run-store.js";
import { WorkspacePreparationCleanupError } from "../workspace.js";
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
import {
  encodeRoutineEventIndexRecord,
  routineEvidencePaths
} from "./evidence.js";
import type {
  RoutineDeferralReason,
  RoutineSchedule,
  RoutineSkipReason,
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
  // Host pressure-stall verdict, sampled once per daemon tick by the caller
  // so every firing evaluated in that tick sees one consistent reading.
  // Omitted means the host is not gated at all. See ADR 0088.
  hostPressure?: HostPressureVerdict;
  inspectWorkspaceCommitsAhead?: typeof inspectWorkspaceCommitsAhead;
  logger?: Logger;
  notification?: RoutineNotificationDelivery;
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

type RoutineNotificationDelivery = {
  createSink: (config: EmailNotificationConfig) => NotificationSink;
  deliveries: NotificationDeliveryTracker;
  resolveConfig: () => EmailNotificationConfig | undefined;
  timeoutMs?: number;
};

type RoutineDispatchOutcome = {
  reason: string;
  routineName: string;
  projectName: string;
};

export type DispatchDueRoutinesResult = {
  // Due targets parked by a capacity refusal: no firing yet, no clock event
  // consumed, retried on the next tick (ADR 0093).
  deferred: RoutineDispatchOutcome[];
  fired: string[];
  // Deferrals whose clock event lapsed before a slot freed. These are
  // failures to run, not policy drops.
  missed: RoutineDispatchOutcome[];
  skipped: RoutineDispatchOutcome[];
};

export type SynchronizeRoutineTargetsInput = Pick<
  DispatchDueRoutinesInput,
  "projects" | "runStore"
> & {
  logger?: Logger;
  now?: Date;
  recomputeSchedulesFromNow?: boolean;
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
      reason:
        | RoutineState
        | "concurrency_cap"
        | "daemon_shutdown"
        | "host_pressure"
        | "overlap";
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

// A one-shot Routine has no next clock event to bound a capacity deferral,
// so it retries for a day before being recorded as missed — long enough to
// outlast an overnight backlog, short enough that its fan-out summary is
// never withheld indefinitely.
const ONE_SHOT_DEFERRAL_HORIZON_MS = 24 * 60 * 60 * 1000;

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
  const pressureReason = hostPressureSkipReason(input.hostPressure);
  if (pressureReason !== null) {
    return {
      error: pressureReason,
      kind: "refused",
      reason: "host_pressure"
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
    kind: detail.kind,
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
    .then((firingResult) => {
      // The concurrency slot above is released before background
      // notification delivery starts. The daemon-owned tracker drains it
      // during graceful shutdown without keeping manual firing completion
      // open on SMTP I/O (ADR 0085).
      enqueueRoutineFiringNotification(
        input,
        firingId,
        project,
        detail,
        firingResult
      );
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

export function synchronizeRoutineTargets(
  input: SynchronizeRoutineTargetsInput
): void {
  const now = input.now ?? new Date();
  const projects = [...input.projects.values()];
  const allRoutines: TargetedRoutineDeclaration[] = [];
  const protectedNamesByProject: Record<string, string[]> = {};
  const trackerlessGitRoutinesByProject: Record<
    string,
    TargetedRoutineDeclaration[]
  > = {};
  const templateRejectedRoutinesByProject: Record<
    string,
    TargetedRoutineDeclaration[]
  > = {};
  const syncedProjects: string[] = [];

  for (const project of projects) {
    if (project.disabled === true) {
      const trackerlessGitRoutines = project.trackerlessGitRoutines ?? [];
      const templateRejectedRoutines = project.templateRejectedRoutines ?? [];
      input.runStore.markRoutinesInactiveForProject(project.name, {
        currentRoutineNames: [
          ...(project.invalidRoutineNames ?? []),
          ...[
            ...(project.routines ?? []),
            ...trackerlessGitRoutines,
            ...templateRejectedRoutines
          ].map((routine) => routine.name)
        ],
        now,
        trackerlessGitRoutines,
        templateRejectedRoutines
      });
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
    if ((project.templateRejectedRoutines ?? []).length > 0) {
      templateRejectedRoutinesByProject[project.name] =
        project.templateRejectedRoutines ?? [];
    }
  }

  // Service-level routines synchronize in one pass across all targets.
  // Include enabled Projects with zero declarations so removal detection
  // soft-disables a target whose last declaration was just removed.
  input.runStore.syncRoutines(allRoutines, {
    now,
    projects: syncedProjects,
    protectedNamesByProject,
    trackerlessGitRoutinesByProject,
    templateRejectedRoutinesByProject,
    recomputeRecurring: input.recomputeSchedulesFromNow === true
  });
  input.runStore.pruneRoutinesForUnknownProjects(
    projects.map((project) => project.name)
  );
  // A swept leg that was waiting for capacity is a Routine that did not run,
  // so it owes the same `routine.missed` event as the deadline path — an
  // operator whose Routine stopped running mid-wait is exactly who that
  // event is for (ADR 0093). Legs settled as ordinary `target_unavailable`
  // skips carry no deferral and emit nothing.
  for (const settled of input.runStore.settleUnavailableRoutineFanoutTargets()) {
    if (settled.deferral === undefined) {
      continue;
    }
    logRoutineMiss(input.logger, {
      deferral: settled.deferral,
      projectName: settled.projectName,
      reason: settled.deferral.reason,
      routine: settled.routineName,
      scheduledAt: settled.scheduledAt
    });
  }
}

export async function dispatchDueRoutines(
  input: DispatchDueRoutinesInput
): Promise<DispatchDueRoutinesResult> {
  const deferred: DispatchDueRoutinesResult["deferred"] = [];
  const fired: string[] = [];
  const missed: DispatchDueRoutinesResult["missed"] = [];
  const skipped: DispatchDueRoutinesResult["skipped"] = [];
  const now = input.now ?? new Date();
  const prepareRoutineWorkspace =
    input.prepareRoutineWorkspace ?? defaultPrepareRoutineWorkspace;
  const createFiringId = input.createFiringId ?? (() => createUlid());
  const createFanoutId = input.createFanoutId ?? (() => createUlid());
  const projects = [...input.projects.values()];
  const fanoutIds = new Map<string, string>();
  const recomputedCatchUpGroups = new Map<
    string,
    {
      routineName: string;
      scheduledAt: string;
      targets: Array<{ nextFireAt: string; projectName: string }>;
    }
  >();
  const firingTasks: Promise<void>[] = [];
  const redactSecrets = (): string[] =>
    resolveRedactSecrets(input.notification, input.env ?? process.env);

  for (const project of projects) {
    if (project.disabled === true) {
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
          declaration.disabled === true ||
          !("cron" in declaration.schedule) ||
          (declaration.catchUp ?? "skip") !== "skip" ||
          persisted.state !== "active" ||
          persisted.nextFireAt === null ||
          new Date(persisted.nextFireAt).getTime() > now.getTime() ||
          persisted.scheduleCron !== declaration.schedule.cron ||
          persisted.scheduleTz !== declaration.schedule.tz ||
          // A parked capacity deferral is not a clock event the daemon
          // missed while it was down — it is one it is still retrying, so
          // the due-event loop below owns it (ADR 0093).
          input.runStore.getRoutineTargetDeferral({
            name: persisted.name,
            projectName: project.name,
            scheduledAt: persisted.nextFireAt
          }) !== undefined
        ) {
          continue;
        }
        const scheduledAt = persisted.nextFireAt;
        const fanoutKey = routineFanoutKey(persisted.name, scheduledAt);
        const group = recomputedCatchUpGroups.get(fanoutKey) ?? {
          routineName: persisted.name,
          scheduledAt,
          targets: []
        };
        group.targets.push({
          nextFireAt: nextRecurringFireAt(declaration.schedule, now),
          projectName: project.name
        });
        recomputedCatchUpGroups.set(fanoutKey, group);
      }
    }
  }

  // Capture every Project sharing the missed clock event before the first
  // skip advances its target's schedule and destroys that grouping key.
  for (const [fanoutKey, group] of recomputedCatchUpGroups) {
    const projectNames = group.targets.map((target) => target.projectName);
    const ensured = input.runStore.ensureRoutineFanout({
      id: createFanoutId(),
      projectNames,
      routineName: group.routineName,
      scheduledAt: group.scheduledAt
    });
    const fanoutId = ensured.id;
    fanoutIds.set(fanoutKey, fanoutId);
    // A freshly created row's membership is exactly this group, all still
    // pending, so no extra read is needed. An existing row may already be
    // notified, or may cover a narrower membership snapshot from an earlier
    // restart (ensureRoutineFanout never extends membership on an existing
    // row — see its own comment in src/run-store.ts) — only then do we need
    // to read it back to learn what's actually pending. A sent or
    // policy-skipped fan-out is also an immutable one-shot snapshot (ADR
    // 0084): only settle a target that belongs to a notification-pending
    // group; otherwise record the schedule advance as an ungrouped
    // catch_up_window skip without rewriting that snapshot.
    const pendingTargetProjectNames = ensured.created
      ? undefined
      : input.runStore.getPendingRoutineFanoutTargetProjectNames(fanoutId);
    for (const target of group.targets) {
      const shouldSettleFanout =
        pendingTargetProjectNames === undefined ||
        pendingTargetProjectNames.has(target.projectName);
      if (
        input.runStore.skipRoutineFiring({
          attemptedAt: now.toISOString(),
          ...(shouldSettleFanout ? { fanoutId } : {}),
          name: group.routineName,
          nextFireAt: target.nextFireAt,
          projectName: target.projectName,
          reason: "catch_up_window"
        })
      ) {
        logRoutineSkip(input.logger, {
          reason: "catch_up_window",
          routine: group.routineName,
          scheduledAt: group.scheduledAt
        });
        skipped.push({
          projectName: target.projectName,
          reason: "catch_up_window",
          routineName: group.routineName
        });
      }
    }
  }
  synchronizeRoutineTargets({
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    now,
    projects: input.projects,
    recomputeSchedulesFromNow: input.recomputeSchedulesFromNow === true,
    runStore: input.runStore
  });

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
      const fanoutKey = routineFanoutKey(routine.name, scheduledAt);
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
      // A parked event that outlived its own clock never fires late: the
      // successor event supersedes it, so it settles as a missed run
      // whatever the current capacity looks like (ADR 0093).
      const deferral = input.runStore.getRoutineTargetDeferral({
        name: routine.name,
        projectName: project.name,
        scheduledAt
      });
      if (
        deferral !== undefined &&
        now.getTime() >=
          new Date(deferralDeadline(routine, scheduledAt)).getTime()
      ) {
        if (
          recordMissedRoutineFiring(input.runStore, {
            evaluation,
            fanoutId,
            now,
            projectName: project.name,
            reason: deferral.reason,
            routine,
            scheduledAt
          })
        ) {
          logRoutineMiss(input.logger, {
            deferral,
            projectName: project.name,
            reason: deferral.reason,
            routine: routine.name,
            scheduledAt
          });
          missed.push({
            projectName: project.name,
            reason: deferral.reason,
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
        const holdReason: RoutineFanoutHoldReason = `provider_not_registered: ${providerName}`;
        input.runStore.holdRoutineFanoutTarget({
          fanoutId,
          projectName: project.name,
          reason: holdReason
        });
        input.logger?.warn(
          {
            project: project.name,
            provider: providerName,
            routine: routine.name,
            scheduled_at: scheduledAt
          },
          "routine dispatch held: provider adapter not registered"
        );
        skipped.push({
          projectName: project.name,
          reason: holdReason,
          routineName: routine.name
        });
        continue;
      }
      if (providerCommand === undefined) {
        const holdReason: RoutineFanoutHoldReason = `provider_command_missing: ${providerName}`;
        input.runStore.holdRoutineFanoutTarget({
          fanoutId,
          projectName: project.name,
          reason: holdReason
        });
        input.logger?.warn(
          {
            project: project.name,
            provider: providerName,
            routine: routine.name,
            scheduled_at: scheduledAt
          },
          "routine dispatch held: provider command missing"
        );
        skipped.push({
          projectName: project.name,
          reason: holdReason,
          routineName: routine.name
        });
        continue;
      }
      // A capacity refusal is transient, so it parks the clock event rather
      // than consuming it: the target keeps retrying every tick until a slot
      // frees or its own event lapses. Routine dispatch runs ahead of fresh
      // issue dispatch in the daemon tick, and a persisted deferral also gets
      // a pre-pass ahead of PR review follow-up, so neither can take the slot
      // it is already waiting for (ADRs 0093 and 0094).
      const capacityReason = capacityRefusalReason({
        activeRuns: input.activeRuns,
        globalConcurrency: input.globalConcurrency,
        ...(input.hostPressure === undefined
          ? {}
          : { hostPressure: input.hostPressure }),
        project
      });
      if (capacityReason !== null) {
        const deadline = deferralDeadline(routine, scheduledAt);
        if (now.getTime() < new Date(deadline).getTime()) {
          if (
            input.runStore.deferRoutineFanoutTarget({
              deferredAt: now.toISOString(),
              fanoutId,
              name: routine.name,
              projectName: project.name,
              reason: capacityReason
            })
          ) {
            input.logger?.info(
              {
                deferred_until: deadline,
                project: project.name,
                reason: capacityReason,
                routine: routine.name,
                scheduled_at: scheduledAt
              },
              "routine.deferred"
            );
            deferred.push({
              projectName: project.name,
              reason: capacityReason,
              routineName: routine.name
            });
          }
          continue;
        }
        if (
          recordMissedRoutineFiring(input.runStore, {
            evaluation,
            fanoutId,
            now,
            projectName: project.name,
            reason: capacityReason,
            routine,
            scheduledAt
          })
        ) {
          logRoutineMiss(input.logger, {
            ...(deferral === undefined ? {} : { deferral }),
            projectName: project.name,
            reason: capacityReason,
            routine: routine.name,
            scheduledAt
          });
          missed.push({
            projectName: project.name,
            reason: capacityReason,
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
        kind: routineDetail.kind,
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
        .then((firingResult) => {
          // Notification delivery is best-effort and can be as slow as the
          // SMTP server allows (see ADR 0067); enqueue it after the slot is
          // released so a stalled relay holds neither project capacity nor
          // this routine dispatch open (ADR 0085).
          enqueueRoutineFiringNotification(
            input,
            firingId,
            project,
            routineDetail,
            firingResult
          );
        });
      firingTasks.push(firingTask);
    }
  }

  await Promise.all(firingTasks);
  input.notification?.deliveries.enqueue(
    () => deliverReadyRoutineFanouts(input),
    { scope: "routine_fanout" }
  );
  return { deferred, fired, missed, skipped };
}

type RoutineFiringResult = {
  events: NormalizedProviderEvent[];
  prepared: PreparedRoutineWorkspace | undefined;
};

async function deliverReadyRoutineFanouts(
  input: DispatchDueRoutinesInput
): Promise<void> {
  if (input.notification === undefined) {
    return;
  }
  let config: EmailNotificationConfig | undefined;
  let sink: NotificationSink;
  try {
    // Resolved once per tick, before any claim: an unconfigured email: block
    // means "no sink to deliver through yet", not a policy decision, so
    // every ready fan-out this tick must stay pending rather than being
    // claimed and then abandoned (see ADR 0069 and ADR 0072).
    config = input.notification.resolveConfig();
    if (config === undefined) {
      return;
    }
    sink = input.notification.createSink(config);
  } catch (error) {
    // Sink construction is best-effort and must never fail a daemon tick
    // (SPEC.md §5.5); every ready fan-out simply stays pending for the next
    // tick to retry, exactly like an unconfigured email: block above. A
    // custom createSink can echo the SMTP password back in its thrown
    // error, so redact it the same way a delivery failure already is below
    // — secretsForEmailConfig tolerates config still being undefined if
    // resolveConfig() itself is what threw.
    const message = redactAll(
      errorMessage(error),
      secretsForEmailConfig(config, input.env ?? process.env)
    );
    input.logger?.warn(
      { err: message },
      "symphonika routine fan-out notification sink construction failed"
    );
    return;
  }
  // Derived from this SAME once-resolved config, not re-resolved per
  // fan-out: deliverRoutineFanoutNotification below awaits real SMTP I/O
  // (up to the configured delivery timeout, ADR 0067), so a mid-tick
  // Service Config reload (ADR 0052) can land between one fan-out's
  // delivery and the next. Re-resolving here would let a later fan-out's
  // redaction secret drift from the config `sink` above actually delivers
  // through for the rest of this tick.
  const fanoutRedactSecrets = [
    ...secretsForEmailConfig(config, input.env ?? process.env),
    // A fan-out renders several projects' firings into one email, so every
    // participating project's tracker token has to be scrubbed, not just the
    // one whose firing is being rendered at the time.
    ...projectTrackerTokens(input.projects, input.env ?? process.env)
  ];
  // notify is uniform across every target of one fan-out (it lives on the
  // shared RoutineDeclaration, materialized identically per project — ADR
  // 0069), so any one target row's value is authoritative for the group.
  // includeInactive: true is required here (not getRoutine's single-row
  // lookup) so a target whose Project was since removed from config still
  // resolves its notify setting instead of silently defaulting to enabled.
  const routines = input.runStore.listRoutines({ includeInactive: true });
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
    // Routine names are unique only per (project_name, name) — a routine
    // soft-disabled with disabled_reason "removed_from_config" is never
    // deleted, so an unrelated, later-declared routine elsewhere can
    // legitimately reuse its name. Matching by name alone could therefore
    // resolve notify from that stale, unrelated row instead of this fan-out's
    // own declaration; scoping to one of this fan-out's own target projects
    // makes the "authoritative for the group" comment above actually true.
    const notifyEnabled =
      routines.find(
        (routine) =>
          routine.name === claimed.routineName &&
          claimed.targets.some(
            (target) => target.projectName === routine.projectName
          )
      )?.notify !== false;
    // Defense-in-depth: terminalReason is already redacted when persisted
    // (runRoutineFiring), but a fan-out claimed here can carry a target
    // firing whose row predates that hardening, or that reached the store
    // through a path that didn't have redactSecrets — this PR is the first
    // one to ever actually deliver a rendered fan-out, so redact again
    // before rendering rather than trust the persisted value.
    const redactedFanout =
      fanoutRedactSecrets.length === 0
        ? claimed
        : {
            ...claimed,
            targets: claimed.targets.map((target) =>
              target.firing === null
                ? target
                : {
                    ...target,
                    firing: {
                      ...target.firing,
                      terminalReason:
                        target.firing.terminalReason === null
                          ? null
                          : redactAll(
                              target.firing.terminalReason,
                              fanoutRedactSecrets
                            )
                    }
                  }
            )
          };
    const outcome = await deliverRoutineFanoutNotification({
      config,
      fanout: redactedFanout,
      notifyEnabled,
      sink,
      ...(input.notification.timeoutMs === undefined
        ? {}
        : { timeoutMs: input.notification.timeoutMs })
    });
    try {
      if (outcome.state === "failed") {
        const error = redactNotificationError(
          outcome.error,
          config,
          input.env ?? process.env
        );
        input.runStore.completeRoutineFanoutNotification({
          error,
          id: claimed.id
        });
        input.logger?.warn(
          {
            err: error,
            fanout: claimed.id,
            routine: claimed.routineName
          },
          "symphonika routine fan-out notification failed"
        );
        continue;
      }
      input.runStore.completeRoutineFanoutNotification({
        id: claimed.id,
        state: outcome.state
      });
    } catch (error) {
      // Delivery-evidence writes are best-effort too (SPEC.md §5.5): a
      // disk-full or SQLite I/O error here must not abort this tick or its
      // subsequent issue dispatch. The row is left at 'sending' and
      // released back to 'pending' by releaseInterruptedRoutineFanoutNotifications
      // on the next daemon restart, so a message that already sent can be
      // retried and duplicated — the price of failing open here rather than
      // aborting orchestration.
      input.logger?.warn(
        {
          err: errorMessage(error),
          fanout: claimed.id,
          routine: claimed.routineName
        },
        "symphonika routine fan-out notification evidence write failed"
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
  // One secret list for every writer in this firing. The notification config
  // supplies the SMTP password; the tracker token is env-backed and resolved
  // here rather than stored. Providers run full-permission and inherit this
  // process's environment, so either can come back out of a provider's own
  // output and must be scrubbed from the JSONL evidence, the stderr tee, and
  // any terminal reason derived from them alike (SPEC.md §6).
  const redactSecrets = (): string[] => [
    ...input.redactSecrets(),
    ...routineTrackerTokens(input.project, input.env)
  ];
  const deadline = routineFiringDeadline(input.routine.timeoutMinutes);
  const scratchIdentity = { attempt: 1, id: input.firingId };
  let prepared: PreparedRoutineWorkspace | undefined;
  let preparationAttempt: Promise<PreparedRoutineWorkspace> | undefined;
  let providerAttempt: Promise<void> | undefined;
  let rawLogPath: string | undefined;
  let stderrLogPath: string | undefined;
  let normalizedIndexPath: string | undefined;
  let normalizedLogPath: string | undefined;
  let normalizedLogOffset = 0;
  let normalizedLogSequence = 1;
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
    preparationAttempt = input.prepareRoutineWorkspace({
      configDir: input.configDir,
      firingId: input.firingId,
      kind: input.routine.kind,
      project: input.project,
      routineName: input.routine.name,
      ...(deadline.signal === undefined ? {} : { signal: deadline.signal })
    });
    prepared = await deadline.race(preparationAttempt);
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
    stderrLogPath = evidence.stderrLogPath;
    normalizedIndexPath = evidence.normalizedIndexPath;
    normalizedLogPath = evidence.normalizedLogPath;
    input.runStore.updateRoutineFiringWorkspace({
      id: input.firingId,
      normalizedLogPath,
      promptPath: evidence.promptPath,
      rawLogPath,
      workspacePath: prepared.workspacePath
    });
    // One object feeds the adapter's single command-template render in both
    // validate() and runAttempt(), so the two paths cannot drift. The result
    // is not the final argv — the adapter still layers routine arguments and
    // the process scope on top.
    const routineOverrides = {
      ...(input.routine.effort === undefined
        ? {}
        : { effort: input.routine.effort }),
      ...(input.routine.model === undefined
        ? {}
        : { model: input.routine.model }),
      ...(input.routine.permissionMode === undefined
        ? {}
        : { permissionMode: input.routine.permissionMode })
    };
    await deadline.race(
      input.provider.validate(input.providerCommand, routineOverrides)
    );
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

    // Disk-backed TMPDIR for this firing, removed in the finally below, so a
    // Routine's build output never lands on a RAM-backed /tmp. See ADR 0088.
    const scratchPath = await createProviderScratch(
      input.stateRoot,
      scratchIdentity
    );
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
        run: scratchIdentity,
        routine: routineOverrides,
        scratchPath,
        stderrLogPath: evidence.stderrLogPath,
        // The stderr tee lands in the same evidence directory as the raw and
        // normalized logs and is served by the same artifact routes, so it
        // scrubs the same secrets they do.
        stderrRedactSecrets: redactSecrets(),
        workspacePath: prepared.workspacePath
      })) {
        const normalizedLogCursor = await appendRoutineEvent({
          event,
          normalizedIndexPath,
          normalizedLogPath,
          normalizedLogOffset,
          normalizedLogSequence,
          rawLogPath,
          redactSecrets
        });
        normalizedLogOffset = normalizedLogCursor.offset;
        normalizedLogSequence = normalizedLogCursor.sequence;
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
              redactSecrets: redactSecrets(),
              stderrLogPath: evidence.stderrLogPath,
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
    const resolvedRedactSecrets = redactSecrets();
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
      // A deadline can win its race before AbortSignal-driven Git cleanup
      // settles. Keep the firing's slot until preparation has actually
      // stopped so later callers never serialize behind abandoned work.
      const preparationError = await preparationAttempt?.then(
        () => undefined,
        (preparationError: unknown) => preparationError
      );
      if (
        preparationError instanceof WorkspacePreparationCleanupError ||
        (preparationError instanceof Error &&
          (preparationError.name === "WorkspacePreparationCleanupError" ||
            preparationError.name === "RoutineWorkspaceCleanupError"))
      ) {
        input.logger?.warn(
          {
            err: errorMessage(preparationError),
            firing: input.firingId
          },
          "symphonika timed-out routine workspace cleanup failed"
        );
      }
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
    let failureCommitsInspectionTimedOut = false;
    const commitsAhead =
      prepared === undefined
        ? false
        : await deadline
            .race(
              inspectRoutineCommitsAhead({
                baseBranch: input.project.workspace.git.base_branch,
                kind: input.routine.kind,
                logger: input.logger,
                routineName: input.routine.name,
                inspectWorkspaceCommitsAhead:
                  input.inspectWorkspaceCommitsAhead,
                workspacePath: prepared.workspacePath
              })
            )
            .catch((inspectionError: unknown) => {
              if (inspectionError instanceof RoutineFiringTimeoutError) {
                failureCommitsInspectionTimedOut = true;
                // The inspection is now unknown, so preserve the workspace
                // under Routine Workspace Retention's conservative rule.
                return true;
              }
              throw inspectionError;
            });
    // Re-read after the Git subprocess for the same reason as the try path.
    // Any timeout signal still wins over a cancellation that arrived
    // during snapshot capture or commit inspection.
    const completionCancelEntry = input.activeRuns.get(input.firingId);
    const timeoutWon =
      timedOut || failureSnapshotTimedOut || failureCommitsInspectionTimedOut;
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
    // A firing killed at its deadline reports `firing_timeout` and nothing
    // else; whatever the provider wrote on stderr before dying is the only
    // account of why it went quiet, so it rides along on the reason here as
    // well as staying in the evidence directory.
    const explainedFinalReason = finalCancelled
      ? finalReason
      : await withProviderStderrTail(finalReason, stderrLogPath);
    const resolvedRedactSecrets = redactSecrets();
    const redactedFinalReason = redactAll(
      explainedFinalReason,
      resolvedRedactSecrets
    );
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
    // Best effort, and a no-op when the firing never reached the provider.
    // A timed-out firing has already had its provider cancelled above, so
    // nothing meaningful is still writing here; anything left behind is
    // reclaimed by the next startup sweep.
    try {
      await removeProviderScratch(input.stateRoot, scratchIdentity);
    } catch (error) {
      input.logger?.warn(
        { err: error, firingId: input.firingId },
        "routine firing scratch cleanup failed; continuing"
      );
    }
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

// Shared by fireRoutineNow and dispatchDueRoutines's per-firing task chain so
// both enqueue notification delivery identically instead of each hand-rolling
// the same `.deliveries.enqueue(...)` call.
function enqueueRoutineFiringNotification(
  input: Pick<
    DispatchDueRoutinesInput,
    "env" | "logger" | "notification" | "runStore"
  >,
  firingId: string,
  project: RunControllerProjectConfig,
  routine: RoutineStatus & { prompt: string },
  firingResult: RoutineFiringResult
): void {
  input.notification?.deliveries.enqueue(
    () =>
      recordRoutineFiringNotification(
        {
          env: input.env ?? process.env,
          firingId,
          logger: input.logger,
          notification: input.notification,
          project,
          routine,
          runStore: input.runStore
        },
        firingResult.events,
        firingResult.prepared
      ),
    { firingId }
  );
}

async function recordRoutineFiringNotification(
  input: {
    env: NodeJS.ProcessEnv;
    firingId: string;
    logger: Logger | undefined;
    notification: RoutineNotificationDelivery | undefined;
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
  // The tracker token belongs here for the same reason the SMTP password
  // does: this text leaves the machine, so it is the last place a leaked
  // credential can still be caught.
  const redactSecrets = [
    ...resolveRedactSecrets(input.notification, input.env),
    ...routineTrackerTokens(input.project, input.env)
  ];
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
  signal: AbortSignal | undefined;
} {
  if (timeoutMinutes === undefined) {
    return {
      clear: () => undefined,
      race: (operation) => operation,
      signal: undefined
    };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new RoutineFiringTimeoutError();
      reject(error);
      controller.abort(error);
    }, timeoutMinutes * 60_000);
  });
  return {
    clear: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    race: (operation) => Promise.race([operation, expired]),
    signal: controller.signal
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
  normalizedIndexPath: string;
  normalizedLogPath: string;
  prompt: string;
  promptPath: string;
  rawLogPath: string;
  stderrLogPath: string;
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
    normalizedIndexPath,
    normalizedLogPath,
    promptMetadataPath: metadataPath,
    promptPath,
    rawLogPath,
    stderrLogPath
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
    writeFile(normalizedIndexPath, ""),
    writeFile(normalizedLogPath, "", "utf8")
  ]);
  return {
    normalizedIndexPath,
    normalizedLogPath,
    prompt: rendered.prompt,
    promptPath,
    rawLogPath,
    stderrLogPath
  };
}

async function appendRoutineEvent(input: {
  event: ProviderEvent;
  normalizedIndexPath: string;
  normalizedLogPath: string;
  normalizedLogOffset: number;
  normalizedLogSequence: number;
  rawLogPath: string;
  redactSecrets: () => string[];
}): Promise<{ offset: number; sequence: number }> {
  const redactSecrets = input.redactSecrets();
  if (input.event.normalized === undefined) {
    await appendJsonl(input.rawLogPath, input.event.raw, redactSecrets);
    return {
      offset: input.normalizedLogOffset,
      sequence: input.normalizedLogSequence
    };
  }
  const [, offset] = await Promise.all([
    appendJsonl(input.rawLogPath, input.event.raw, redactSecrets),
    appendIndexedJsonl({
      filePath: input.normalizedLogPath,
      indexPath: input.normalizedIndexPath,
      offset: input.normalizedLogOffset,
      redactSecrets,
      sequence: input.normalizedLogSequence,
      value: input.event.normalized
    })
  ]);
  return {
    offset,
    sequence: input.normalizedLogSequence + 1
  };
}

async function classifyRoutineOutcome(
  events: NormalizedProviderEvent[],
  workspace: {
    baseBranch: string;
    kind: RoutineStatus["kind"];
    redactSecrets: readonly string[];
    stderrLogPath?: string;
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
      redactSecrets: workspace.redactSecrets,
      ...(workspace.stderrLogPath === undefined
        ? {}
        : { stderrLogPath: workspace.stderrLogPath }),
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
    return {
      kind: "failed",
      reason: await withProviderStderrTail(
        "no_process_exit_event",
        workspace.stderrLogPath
      )
    };
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
    reason: await withProviderStderrTail(
      exitCode === undefined
        ? `process_exit_signal_${stringField(exit, "signal") ?? "unknown"}`
        : `process_exit_${exitCode}`,
      workspace.stderrLogPath
    )
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

function hostPressureSkipReason(
  hostPressure: HostPressureVerdict | undefined
): string | null {
  if (hostPressure === undefined || hostPressure.admitted) {
    return null;
  }
  return hostPressure.reason;
}

// Host pressure outranks the count caps: a stalled host has no capacity to
// give even when the caps leave headroom (ADR 0088).
function capacityRefusalReason(input: {
  activeRuns: ActiveRunRegistry;
  globalConcurrency: { maxInFlight: number | undefined };
  hostPressure?: HostPressureVerdict;
  project: RunControllerProjectConfig;
}): RoutineDeferralReason | null {
  if (hostPressureSkipReason(input.hostPressure) !== null) {
    return "host_pressure";
  }
  return capSkipReason(
    input.activeRuns,
    input.globalConcurrency,
    input.project
  ) === null
    ? null
    : "concurrency_cap";
}

// How long a parked clock event stays retryable. A recurring Routine defers
// until its own next event is due — that event supersedes the parked one, so
// carrying the old one further would double-fire. A one-shot Routine has no
// successor to bound it, so it gets an explicit horizon instead.
function deferralDeadline(routine: RoutineStatus, scheduledAt: string): string {
  const schedule = routineSchedule(routine);
  if ("cron" in schedule) {
    return nextRecurringFireAt(schedule, new Date(scheduledAt));
  }
  return new Date(
    new Date(scheduledAt).getTime() + ONE_SHOT_DEFERRAL_HORIZON_MS
  ).toISOString();
}

function capSkipReason(
  activeRuns: ActiveRunRegistry,
  globalConcurrency: { maxInFlight: number | undefined },
  project: RunControllerProjectConfig
): string | null {
  const verdict = evaluateConcurrencyCapacity({
    configuredProjectMax: project.max_in_flight,
    globalInFlight: activeRuns.countInFlight(),
    globalMax: globalConcurrency.maxInFlight,
    projectInFlight: activeRuns.countInFlightByProject(project.name),
    projectName: project.name
  });
  return verdict.admitted ? null : verdict.reason;
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

// Shared by both places dispatchDueRoutines groups Routine Targets by clock
// event: the restart catch-up recompute pass and the normal due-event loop.
// A NUL separator can't appear in either a routine name or an ISO timestamp,
// so this stays collision-free without escaping.
function routineFanoutKey(routineName: string, scheduledAt: string): string {
  return `${routineName}\0${scheduledAt}`;
}

function recordDueRoutineSkip(
  runStore: RunStore,
  input: {
    evaluation: Extract<RoutineScheduleEvaluation, { kind: "fire_now" }>;
    fanoutId?: string;
    now: Date;
    projectName: string;
    reason: RoutineSkipReason;
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

function recordMissedRoutineFiring(
  runStore: RunStore,
  input: {
    evaluation: Extract<RoutineScheduleEvaluation, { kind: "fire_now" }>;
    fanoutId: string;
    now: Date;
    projectName: string;
    reason: RoutineDeferralReason;
    routine: RoutineStatus;
    scheduledAt: string;
  }
): boolean {
  const nextFireAt = missedClockAdvance(input);
  return runStore.missRoutineFiring({
    attemptedAt: input.now.toISOString(),
    fanoutId: input.fanoutId,
    name: input.routine.name,
    ...(nextFireAt === undefined ? {} : { nextFireAt }),
    projectName: input.projectName,
    reason: input.reason
  });
}

// Where the clock lands once a parked event is recorded as missed. The event
// that ended the wait is the successor of the parked one, and it has had no
// admission attempt of its own — handing the clock to it, rather than to the
// next event after `now`, is what stops one lost run from silently costing
// two. A backlog older than a whole period still collapses to the next future
// event, exactly as a skip's advance does (ADR 0058).
function missedClockAdvance(input: {
  evaluation: Extract<RoutineScheduleEvaluation, { kind: "fire_now" }>;
  now: Date;
  routine: RoutineStatus;
  scheduledAt: string;
}): string | undefined {
  if (input.evaluation.nextAt === undefined) {
    return undefined;
  }
  const schedule = routineSchedule(input.routine);
  if (!("cron" in schedule)) {
    return input.evaluation.nextAt;
  }
  const successor = nextRecurringFireAt(schedule, new Date(input.scheduledAt));
  const afterSuccessor = nextRecurringFireAt(schedule, new Date(successor));
  return input.now.getTime() < new Date(afterSuccessor).getTime()
    ? successor
    : input.evaluation.nextAt;
}

function logRoutineMiss(
  logger: Logger | undefined,
  input: {
    deferral?: { attempts: number; since: string };
    projectName: string;
    reason: RoutineDeferralReason;
    routine: string;
    scheduledAt: string;
  }
): void {
  logger?.warn(
    {
      deferred_attempts: input.deferral?.attempts ?? 0,
      deferred_since: input.deferral?.since ?? input.scheduledAt,
      project: input.projectName,
      reason: input.reason,
      routine: input.routine,
      scheduled_at: input.scheduledAt
    },
    "routine.missed"
  );
}

function logRoutineSkip(
  logger: Logger | undefined,
  input: {
    reason: RoutineSkipReason;
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
  await appendFile(filePath, serializeJsonl(value, redactSecrets));
}

async function appendIndexedJsonl(input: {
  filePath: string;
  indexPath: string;
  offset: number;
  redactSecrets: string[];
  sequence: number;
  value: unknown;
}): Promise<number> {
  const line = serializeJsonl(input.value, input.redactSecrets);
  const record = encodeRoutineEventIndexRecord(input.offset, input.sequence);
  await Promise.all([
    appendFile(input.filePath, line),
    appendFile(input.indexPath, record)
  ]);
  return input.offset + line.length;
}

function serializeJsonl(value: unknown, redactSecrets: string[]): Buffer {
  // Redact string values BEFORE serializing, not after: JSON.stringify
  // escapes quotes, backslashes, and control characters, so a secret
  // containing any of them no longer appears as a contiguous substring of
  // the serialized text and a post-serialization redact silently misses it.
  const redacted =
    redactSecrets.length === 0 ? value : redactValueDeep(value, redactSecrets);
  return Buffer.from(`${JSON.stringify(redacted)}\n`, "utf8");
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

// The tracker token is env-backed and resolved per call rather than stored,
// mirroring captureRoutineGithubSnapshot. Absent tracker or unset variable
// yields nothing to redact.
// Every distinct tracker token across the projects a fan-out can render.
function projectTrackerTokens(
  projects: ReadonlyMap<string, RunControllerProjectConfig>,
  env: NodeJS.ProcessEnv
): string[] {
  return [
    ...new Set(
      [...projects.values()].flatMap((project) =>
        routineTrackerTokens(project, env)
      )
    )
  ];
}

function routineTrackerTokens(
  project: RunControllerProjectConfig,
  env: NodeJS.ProcessEnv
): string[] {
  if (project.tracker === undefined) {
    return [];
  }
  const token = resolveEnvBackedValue(project.tracker.token, env);
  return token === undefined ? [] : [token];
}

function resolveRedactSecrets(
  notification: DispatchDueRoutinesInput["notification"],
  env: NodeJS.ProcessEnv
): string[] {
  if (notification === undefined) {
    return [];
  }
  return secretsForEmailConfig(notification.resolveConfig(), env);
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
