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
import type { RoutineSchedule, RoutineStatus } from "./types.js";
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

type RoutineTerminalOutcome =
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "succeeded"; reason: string };

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
      input.runStore.markRoutinesInactiveForProject(project.name);
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
    input.runStore.syncRoutines(project.name, project.routines ?? [], {
      now,
      protectedNames: project.invalidRoutineNames ?? [],
      recomputeRecurring: input.recomputeSchedulesFromNow === true
    });
  }
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
      if (provider === undefined || providerCommand === undefined) {
        skipped.push({
          projectName: project.name,
          reason: `provider_not_registered: ${providerName}`,
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

      try {
        input.activeRuns.reserveSlot({
          issueNumber: syntheticRoutineIssueNumber(firingId),
          projectName: project.name,
          respectsIssueLabels: false,
          runId: firingId
        });
        fired.push(firingId);
        await runRoutineFiring({
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
    }
  }

  return { fired, skipped };
}

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
}): Promise<void> {
  const events: NormalizedProviderEvent[] = [];
  let prepared: PreparedRoutineWorkspace | undefined;
  let rawLogPath: string | undefined;
  let normalizedLogPath: string | undefined;
  try {
    input.runStore.updateRoutineFiringState(
      input.firingId,
      "preparing_workspace"
    );
    prepared = await input.prepareRoutineWorkspace({
      configDir: input.configDir,
      firingId: input.firingId,
      kind: input.routine.kind,
      project: input.project,
      routineName: input.routine.name
    });
    const evidence = await prepareRoutineEvidence({
      configDir: input.configDir,
      firingId: input.firingId,
      prepared,
      project: input.project,
      providerCommand: input.providerCommand,
      providerName: input.providerName,
      routine: input.routine,
      stateRoot: input.stateRoot
    });
    rawLogPath = evidence.rawLogPath;
    normalizedLogPath = evidence.normalizedLogPath;
    input.runStore.updateRoutineFiringWorkspace({
      id: input.firingId,
      normalizedLogPath,
      promptPath: evidence.promptPath,
      rawLogPath,
      workspacePath: prepared.workspacePath
    });
    await input.provider.validate(input.providerCommand);
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
    // Mirrors classifyFailure's cancelRequested fast path (checked before
    // any exit-code/event inspection there too): once an operator cancel is
    // observed, the firing reports cancelled even if the process happened
    // to exit cleanly in the same race.
    const cancelEntry = input.activeRuns.get(input.firingId);
    const outcome =
      cancelEntry?.cancelRequested === true
        ? { kind: "cancelled" as const, reason: "cancelled" }
        : await classifyRoutineOutcome(events, {
            baseBranch: input.project.workspace.git.base_branch,
            kind: input.routine.kind,
            workspacePath: prepared.workspacePath
          });
    input.runStore.completeRoutineFiring({
      id: input.firingId,
      state: outcome.kind,
      terminalReason: outcome.reason.length === 0 ? null : outcome.reason,
      ...(cancelEntry?.cancelReason === undefined
        ? {}
        : { cancelReason: cancelEntry.cancelReason }),
      workspacePath: prepared.workspacePath
    });
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
    const cancelEntry = input.activeRuns.get(input.firingId);
    const cancelled = cancelEntry?.cancelRequested === true;
    const reason = cancelled
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
  }
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
  if (input.githubIssuesApi === undefined) {
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
