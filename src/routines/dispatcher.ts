import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type { ActiveRunRegistry } from "../lifecycle/active-runs.js";
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
import { evaluateRoutineSchedule } from "./schedule.js";
import {
  renderRoutinePrompt,
  RoutinePromptRenderError
} from "./prompt-renderer.js";
import type { RoutineStatus } from "./types.js";
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
  globalConcurrency: { maxInFlight: number | undefined };
  logger?: Logger;
  now?: Date;
  prepareRoutineWorkspace?: (
    input: PrepareRoutineWorkspaceInput
  ) => Promise<PreparedRoutineWorkspace>;
  projects: Map<string, RunControllerProjectConfig>;
  providersConfig: RunControllerProvidersConfig;
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

  for (const project of input.projects.values()) {
    if (project.disabled === true) {
      continue;
    }
    input.runStore.syncRoutines(project.name, project.routines ?? []);
    for (const routine of input.runStore.listRoutines({ project: project.name })) {
      const evaluation = evaluateRoutineSchedule({
        lastFiredAt: routine.lastFiredAt,
        now,
        schedule: { at: routine.scheduleAt },
        state: routine.state
      });
      if (evaluation.kind !== "fire_now") {
        continue;
      }
      const providerName = routine.provider ?? project.agent.provider;
      const provider = input.agentProviders[providerName];
      const providerCommand = input.providersConfig[providerName].command;
      if (provider === undefined) {
        skipped.push({
          projectName: project.name,
          reason: `provider_not_registered: ${providerName}`,
          routineName: routine.name
        });
        continue;
      }
      const capReason = capSkipReason(input.activeRuns, input.globalConcurrency, project);
      if (capReason !== null) {
        input.logger?.info(
          { project: project.name, reason: capReason, routine: routine.name },
          "symphonika routine firing skipped by concurrency cap"
        );
        skipped.push({
          projectName: project.name,
          reason: capReason,
          routineName: routine.name
        });
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
        now,
        schedule: { at: routineDetail.scheduleAt },
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
  firingId: string;
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
    input.runStore.updateRoutineFiringState(input.firingId, "preparing_workspace");
    prepared = await input.prepareRoutineWorkspace({
      configDir: input.configDir,
      firingId: input.firingId,
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
    const outcome = classifyRoutineOutcome(events);
    input.runStore.completeRoutineFiring({
      id: input.firingId,
      state: outcome.kind,
      terminalReason: outcome.reason.length === 0 ? null : outcome.reason,
      workspacePath: prepared.workspacePath
    });
  } catch (error) {
    const reason =
      error instanceof RoutinePromptRenderError
        ? error.terminalReason
        : errorMessage(error);
    input.runStore.completeRoutineFiring({
      id: input.firingId,
      state: "failed",
      terminalReason: reason,
      ...(prepared === undefined ? {} : { workspacePath: prepared.workspacePath })
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
    firing: { id: input.firingId },
    project: { name: input.project.name },
    provider: { command: input.providerCommand, name: input.providerName },
    routine: {
      kind: routine.kind,
      name: routine.name,
      schedule_at: routine.scheduleAt,
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
          firing: { id: input.firingId },
          project: { name: input.project.name },
          provider: { command: input.providerCommand, name: input.providerName },
          routine: {
            kind: routine.kind,
            name: routine.name,
            schedule_at: routine.scheduleAt,
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

function classifyRoutineOutcome(
  events: NormalizedProviderEvent[]
): RoutineTerminalOutcome {
  const inputRequired = events.find((event) => event.type === "input_required");
  if (inputRequired !== undefined) {
    return {
      kind: "failed",
      reason: stringField(inputRequired, "message") ?? "provider requested input"
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
  const segment = input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment.length === 0 ? "firing" : segment;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
