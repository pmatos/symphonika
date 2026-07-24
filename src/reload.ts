import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";

import type { WorkflowFormat } from "./config-schemas.js";
import {
  projectWorkspaceSchema,
  pathStringSchema,
  workflowReferenceSchema
} from "./config-schemas.js";
import type {
  PollingProjectConfig,
  PollingServiceConfig
} from "./issue-polling.js";
import { DEFAULT_POLLING_INTERVAL_MS } from "./issue-polling.js";
import type {
  RunControllerProjectConfig,
  RunControllerProvidersConfig,
  WorkflowSnapshot
} from "./lifecycle/run-controller.js";
import {
  DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
  pullRequestFollowupPolicyFromRaw,
  type PullRequestFollowupPolicy
} from "./pull-request-followup.js";
import {
  expandWorkflowDefinition,
  parseWorkflowContract,
  validateExpandedWorkflowReferences
} from "./workflow.js";
import { loadRoutineDeclaration } from "./routines/declaration-loader.js";
import type { RoutineDeclaration } from "./routines/types.js";

export type RuntimeConfigSnapshot = {
  configPath: string;
  // Global concurrency cap snapshot. `maxInFlight: undefined` means
  // unbounded. See ADR 0053.
  globalConcurrency: { maxInFlight: number | undefined };
  // Routine declarations that failed to load this reload and have no prior
  // valid snapshot to carry forward — a brand-new file, invalid from the
  // start. `name` is present only when the front matter's `name` field
  // itself parsed successfully; entries with no resolvable name can only be
  // surfaced through `errors`, never as a store row (no identity to key on).
  invalidRoutines: Array<{
    name?: string;
    path: string;
    projectName: string;
  }>;
  loadedAt: string;
  polling: PollingServiceConfig;
  pollingIntervalMs: number;
  projects: RuntimeProjectConfig[];
  providers: RunControllerProvidersConfig;
  pullRequestPolicy: PullRequestFollowupPolicy;
  watchdog: WatchdogConfig;
};

export type RuntimeReloadStatus = {
  errors: string[];
  lastAttemptedAt: string | null;
  lastLoadedAt: string | null;
  ok: boolean;
  usingLastKnownGood: boolean;
};

export type RuntimeConfigReloaderOptions = {
  configPath: string;
  logger?: Logger;
};

export type WatchdogConfig = {
  enabled: boolean;
  graceMinutes: number;
  mtimeIgnore: string[];
  sampleIntervalSeconds: number;
};

type ProjectWatchdogConfig = {
  graceMinutes: number;
};

type RuntimeProjectConfig = RunControllerProjectConfig & {
  watchdog?: ProjectWatchdogConfig;
};

export type WatchdogServiceConfig = {
  projects: readonly {
    name: string;
    watchdog?: ProjectWatchdogConfig;
  }[];
  watchdog: WatchdogConfig;
};

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  graceMinutes: 30,
  mtimeIgnore: [],
  sampleIntervalSeconds: 60
};

const providerNameSchema = z.enum(["codex", "claude"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .passthrough();

const watchdogConfigSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_WATCHDOG_CONFIG.enabled),
    grace_minutes: z
      .number()
      .positive()
      .default(DEFAULT_WATCHDOG_CONFIG.graceMinutes),
    sample_interval_seconds: z
      .number()
      .positive()
      .default(DEFAULT_WATCHDOG_CONFIG.sampleIntervalSeconds),
    // Extra workspace-relative globs whose files are dropped from the mtime
    // walk so build-output churn cannot keep a wedged Run alive (ADR 0054).
    mtime_ignore: z.array(z.string().trim().min(1)).default([])
  })
  .passthrough();

const projectWatchdogConfigSchema = z
  .object({
    grace_minutes: z.number().int().positive()
  })
  .strict();

const pollingProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    disabled: z.boolean().optional(),
    weight: z.number().int().positive().optional(),
    // Per-project concurrency cap. Omitted defaults to 1 at consume-time.
    // Zero / negative values are rejected. See ADR 0053.
    max_in_flight: z.number().int().positive().optional(),
    tracker: z
      .object({
        kind: z.literal("github"),
        owner: z.string().trim().min(1),
        repo: z.string().trim().min(1),
        token: z.string().trim().min(1)
      })
      .passthrough(),
    issue_filters: z
      .object({
        states: z.array(z.literal("open")).min(1),
        labels_all: z.array(z.string().trim().min(1)),
        labels_none: z.array(z.string().trim().min(1))
      })
      .passthrough(),
    priority: z
      .object({
        labels: z.record(z.string(), z.number().int().nonnegative()),
        default: z.number().int().nonnegative()
      })
      .passthrough(),
    agent: z
      .object({
        provider: providerNameSchema
      })
      .passthrough()
  })
  .passthrough();

const runtimeProjectDetailSchema = z
  .object({
    name: z.string().trim().min(1),
    routines: z.array(pathStringSchema).optional(),
    watchdog: projectWatchdogConfigSchema.optional(),
    workspace: projectWorkspaceSchema,
    workflow: workflowReferenceSchema
  })
  .passthrough();

const serviceConfigSchema = z
  .object({
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional()
      })
      .passthrough()
      .optional(),
    // Optional global concurrency cap. Omitted = unbounded. See ADR 0053.
    global: z
      .object({
        max_in_flight: z.number().int().positive().optional()
      })
      .passthrough()
      .optional(),
    watchdog: watchdogConfigSchema.optional(),
    providers: z
      .object({
        codex: providerCommandSchema,
        claude: providerCommandSchema
      })
      .passthrough(),
    projects: z.array(z.unknown()).min(1)
  })
  .passthrough();

export class RuntimeConfigReloader {
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly logger?: Logger;
  private snapshot: RuntimeConfigSnapshot | undefined;
  private status: RuntimeReloadStatus = {
    errors: [],
    lastAttemptedAt: null,
    lastLoadedAt: null,
    ok: false,
    usingLastKnownGood: false
  };

  constructor(options: RuntimeConfigReloaderOptions) {
    this.configPath = options.configPath;
    this.configDir = path.dirname(options.configPath);
    if (options.logger !== undefined) {
      this.logger = options.logger;
    }
  }

  getSnapshot(): RuntimeConfigSnapshot | undefined {
    return this.snapshot;
  }

  getStatus(): RuntimeReloadStatus {
    return {
      ...this.status,
      errors: this.status.errors.slice()
    };
  }

  projectsByName(): Map<string, RunControllerProjectConfig> {
    const map = new Map<string, RunControllerProjectConfig>();
    for (const project of this.snapshot?.projects ?? []) {
      map.set(project.name, project);
    }
    return map;
  }

  providersConfig(): RunControllerProvidersConfig {
    return this.snapshot?.providers ?? defaultProvidersConfig();
  }

  pullRequestPolicy(): PullRequestFollowupPolicy {
    return (
      this.snapshot?.pullRequestPolicy ?? DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY
    );
  }

  globalConcurrency(): { maxInFlight: number | undefined } {
    return this.snapshot?.globalConcurrency ?? { maxInFlight: undefined };
  }

  watchdogServiceConfig(): WatchdogServiceConfig {
    return {
      projects: this.snapshot?.projects ?? [],
      watchdog: this.snapshot?.watchdog ?? DEFAULT_WATCHDOG_CONFIG
    };
  }

  async reload(): Promise<RuntimeConfigSnapshot | undefined> {
    const attemptedAt = new Date().toISOString();
    const reloadInput = {
      attemptedAt,
      configDir: this.configDir,
      configPath: this.configPath
    };
    const result = await loadRuntimeConfigSnapshot({
      ...reloadInput,
      ...(this.snapshot === undefined ? {} : { previous: this.snapshot })
    });

    this.status.lastAttemptedAt = attemptedAt;
    if (result.snapshot !== undefined) {
      this.snapshot = result.snapshot;
      this.status.lastLoadedAt = result.snapshot.loadedAt;
    }
    this.status.errors = result.errors;
    this.status.ok = result.errors.length === 0;
    this.status.usingLastKnownGood = result.usingLastKnownGood;

    if (result.errors.length > 0) {
      this.logger?.warn(
        {
          errors: result.errors,
          usingLastKnownGood: result.usingLastKnownGood
        },
        "symphonika config reload failed"
      );
    } else {
      this.logger?.debug(
        {
          pollingIntervalMs: this.snapshot?.pollingIntervalMs,
          projects: this.snapshot?.polling.projects.length ?? 0
        },
        "symphonika config reload succeeded"
      );
    }

    return this.snapshot;
  }
}

async function loadRuntimeConfigSnapshot(input: {
  attemptedAt: string;
  configDir: string;
  configPath: string;
  previous?: RuntimeConfigSnapshot;
}): Promise<{
  errors: string[];
  snapshot?: RuntimeConfigSnapshot;
  usingLastKnownGood: boolean;
}> {
  const errors: string[] = [];
  const raw = await readRawServiceConfig(input.configPath, errors);
  if (raw === undefined) {
    return lastKnownGoodOrNothing(input.previous, errors);
  }

  const parsed = serviceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(formatZodIssue));
    return lastKnownGoodOrNothing(input.previous, errors);
  }

  const pollingProjects: PollingProjectConfig[] = [];
  const dispatchProjects: RuntimeProjectConfig[] = [];
  const invalidRoutines: RuntimeConfigSnapshot["invalidRoutines"] = [];

  for (const [index, rawProject] of parsed.data.projects.entries()) {
    const pollingProject = pollingProjectSchema.safeParse(rawProject);
    if (!pollingProject.success) {
      errors.push(
        ...pollingProject.error.issues.map((issue) =>
          formatZodIssueWithPrefix(issue, ["projects", String(index)])
        )
      );
      continue;
    }
    pollingProjects.push(pollingProject.data);

    // SPEC 5.1: an invalid Project watchdog override — a non-positive-integer
    // grace_minutes or an unknown key — rejects the entire candidate snapshot
    // for all Projects, even on first load (where there is no last-known-good,
    // so nothing goes live). This is stricter than the other detail fields
    // below (workspace, workflow, ...), whose first-load failure only drops the
    // offending Project from dispatch while valid siblings keep polling.
    const rawWatchdog = (rawProject as { watchdog?: unknown }).watchdog;
    if (rawWatchdog !== undefined) {
      const watchdogOverride =
        projectWatchdogConfigSchema.safeParse(rawWatchdog);
      if (!watchdogOverride.success) {
        errors.push(
          ...watchdogOverride.error.issues.map((issue) =>
            formatZodIssueWithPrefix(issue, [
              "projects",
              String(index),
              "watchdog"
            ])
          )
        );
        return lastKnownGoodOrNothing(input.previous, errors);
      }
    }

    const detail = runtimeProjectDetailSchema.safeParse(rawProject);
    if (!detail.success) {
      errors.push(
        ...detail.error.issues.map((issue) =>
          formatZodIssueWithPrefix(issue, ["projects", String(index)])
        )
      );
      if (input.previous !== undefined) {
        return lastKnownGoodOrNothing(input.previous, errors);
      }
      continue;
    }

    if (pollingProject.data.disabled === true) {
      // Disabling a Project halts new dispatch but does not cancel an active
      // run, and the Project stays in the runtime map. Carry forward the last
      // loaded WorkflowSnapshot when one exists so the Watchdog keeps this
      // Project's evidence.ignore policy for its still-running rows; otherwise
      // build-output churn would masquerade as progress and keep a wedged run
      // alive (ADR 0054).
      const previousWorkflow = input.previous?.projects.find(
        (project) => project.name === pollingProject.data.name
      )?.workflow;
      dispatchProjects.push({
        ...pollingProject.data,
        routines: [],
        ...(detail.data.watchdog === undefined
          ? {}
          : {
              watchdog: {
                graceMinutes: detail.data.watchdog.grace_minutes
              }
            }),
        workflow:
          previousWorkflow !== undefined &&
          "expandedWorkflow" in previousWorkflow
            ? previousWorkflow
            : detail.data.workflow,
        workspace: detail.data.workspace
      });
      continue;
    }

    const previousRoutines =
      input.previous?.projects.find(
        (project) => project.name === pollingProject.data.name
      )?.routines ?? [];
    const routineResult = await readRoutineDeclarations(
      (detail.data.routines ?? []).map((routinePath) =>
        path.resolve(input.configDir, routinePath)
      ),
      previousRoutines,
      errors
    );
    for (const invalid of routineResult.invalidNew) {
      invalidRoutines.push({
        ...(invalid.name === undefined ? {} : { name: invalid.name }),
        path: invalid.path,
        projectName: pollingProject.data.name
      });
    }

    const workflow = await readWorkflowSnapshot(
      path.resolve(input.configDir, detail.data.workflow.path),
      detail.data.workflow.format,
      errors
    );
    if (workflow === undefined) {
      return lastKnownGoodOrNothing(input.previous, errors);
    }
    const invalidRoutineNames = routineResult.invalidNew
      .map((invalid) => invalid.name)
      .filter((name): name is string => name !== undefined);
    dispatchProjects.push({
      ...pollingProject.data,
      ...(invalidRoutineNames.length === 0 ? {} : { invalidRoutineNames }),
      routines: routineResult.routines,
      ...(detail.data.watchdog === undefined
        ? {}
        : {
            watchdog: {
              graceMinutes: detail.data.watchdog.grace_minutes
            }
          }),
      workflow,
      workspace: detail.data.workspace
    });
  }

  if (pollingProjects.length === 0 && input.previous !== undefined) {
    return lastKnownGoodOrNothing(input.previous, errors);
  }

  const polling: PollingServiceConfig = {
    projects: pollingProjects
  };
  if (parsed.data.polling !== undefined) {
    polling.polling = parsed.data.polling;
  }

  return {
    errors,
    snapshot: {
      configPath: input.configPath,
      globalConcurrency: {
        maxInFlight: parsed.data.global?.max_in_flight
      },
      invalidRoutines,
      loadedAt: input.attemptedAt,
      polling,
      pollingIntervalMs:
        parsed.data.polling?.interval_ms ?? DEFAULT_POLLING_INTERVAL_MS,
      projects: dispatchProjects,
      providers: {
        claude: { command: parsed.data.providers.claude.command },
        codex: { command: parsed.data.providers.codex.command }
      },
      pullRequestPolicy:
        pullRequestFollowupPolicyFromRaw(raw) ??
        DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
      watchdog: normalizeWatchdogConfig(parsed.data.watchdog)
    },
    usingLastKnownGood: false
  };
}

function normalizeWatchdogConfig(
  raw: z.infer<typeof watchdogConfigSchema> | undefined
): WatchdogConfig {
  return {
    enabled: raw?.enabled ?? DEFAULT_WATCHDOG_CONFIG.enabled,
    graceMinutes: raw?.grace_minutes ?? DEFAULT_WATCHDOG_CONFIG.graceMinutes,
    mtimeIgnore: raw?.mtime_ignore ?? DEFAULT_WATCHDOG_CONFIG.mtimeIgnore,
    sampleIntervalSeconds:
      raw?.sample_interval_seconds ??
      DEFAULT_WATCHDOG_CONFIG.sampleIntervalSeconds
  };
}

export function resolveWatchdogConfig(
  serviceConfig: WatchdogServiceConfig,
  projectName: string
): WatchdogConfig {
  const projectOverride = serviceConfig.projects.find(
    (project) => project.name === projectName
  )?.watchdog;
  if (projectOverride === undefined) {
    return serviceConfig.watchdog;
  }
  return {
    ...serviceConfig.watchdog,
    graceMinutes: projectOverride.graceMinutes
  };
}

async function readRawServiceConfig(
  configPath: string,
  errors: string[]
): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    errors.push(
      `service config not found at ${configPath}: ${errorMessage(error)}`
    );
    return undefined;
  }

  try {
    return parse(contents) ?? {};
  } catch (error) {
    errors.push(`service config could not be parsed: ${errorMessage(error)}`);
    return undefined;
  }
}

async function readWorkflowSnapshot(
  workflowPath: string,
  format: WorkflowFormat,
  errors: string[]
): Promise<WorkflowSnapshot | undefined> {
  let contents: string;
  try {
    contents = await readFile(workflowPath, "utf8");
  } catch (error) {
    errors.push(
      `workflow contract not found at ${workflowPath}: ${errorMessage(error)}`
    );
    return undefined;
  }

  const expanded = await expandWorkflowDefinition(
    contents,
    workflowPath,
    format
  );
  // Raw FSM YAML files can open with `---` (the YAML document marker); the
  // markdown contract parser would mistake that for unterminated front matter,
  // so skip it. The expanded workflow's contentHash is sufficient for snapshot
  // equality; the body is unused for raw FSM (per-state action.prompt drives
  // the actual prompt).
  if (expanded.workflow.source.kind === "raw_fsm") {
    if (expanded.errors.length > 0) {
      errors.push(...expanded.errors);
      return undefined;
    }
    const referenceErrors = await validateExpandedWorkflowReferences(
      expanded.workflow,
      workflowPath
    );
    if (referenceErrors.length > 0) {
      errors.push(...referenceErrors);
      return undefined;
    }
    return {
      body: "",
      contentHash: expanded.workflow.contentHash,
      evidence: { ignore: [] },
      expandedWorkflow: expanded.workflow,
      format,
      path: workflowPath
    };
  }
  const workflow = parseWorkflowContract(contents, workflowPath);
  const workflowErrors = [...workflow.errors, ...expanded.errors];
  if (workflowErrors.length > 0) {
    errors.push(...workflowErrors);
    return undefined;
  }

  return {
    body: workflow.body,
    contentHash: workflow.contentHash,
    evidence: workflow.evidence,
    expandedWorkflow: expanded.workflow,
    format,
    path: workflow.path
  };
}

async function readRoutineDeclarations(
  routinePaths: string[],
  previousRoutines: RoutineDeclaration[],
  errors: string[]
): Promise<{
  invalidNew: Array<{ name?: string; path: string }>;
  routines: RoutineDeclaration[];
}> {
  const routines: RoutineDeclaration[] = [];
  const invalidNew: Array<{ name?: string; path: string }> = [];
  const seenNames = new Map<string, string>();
  const previousBySourcePath = new Map(
    previousRoutines.map((routine) => [routine.sourcePath, routine])
  );
  for (const routinePath of routinePaths) {
    const result = await loadRoutineDeclaration(routinePath);
    if (result.routine === null) {
      errors.push(...result.errors);
      // Carry-forward is keyed on the file's own path, not on the freshly
      // parsed name — a broken edit can corrupt the name field itself while
      // the path symphonika.yml references stays the same. Falling back to
      // name would wrongly treat that as "no prior valid declaration" and
      // let the removal-detection path in RunStore.syncRoutines demote a
      // still-configured routine to disabled/removed_from_config.
      const previous = previousBySourcePath.get(routinePath);
      if (previous !== undefined) {
        routines.push(previous);
      } else {
        invalidNew.push({
          ...(result.partialName === undefined
            ? {}
            : { name: result.partialName }),
          path: routinePath
        });
      }
      continue;
    }
    const existing = seenNames.get(result.routine.name);
    if (existing !== undefined) {
      errors.push(
        `duplicate routine name "${result.routine.name}" declared by ${existing} and ${result.routine.sourcePath}`
      );
      continue;
    }
    seenNames.set(result.routine.name, result.routine.sourcePath);
    routines.push(result.routine);
  }
  return { invalidNew, routines };
}

function lastKnownGoodOrNothing(
  previous: RuntimeConfigSnapshot | undefined,
  errors: string[]
): {
  errors: string[];
  snapshot?: RuntimeConfigSnapshot;
  usingLastKnownGood: boolean;
} {
  return {
    errors,
    ...(previous === undefined ? {} : { snapshot: previous }),
    usingLastKnownGood: previous !== undefined
  };
}

function defaultProvidersConfig(): RunControllerProvidersConfig {
  return {
    claude: {
      command:
        "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json"
    },
    codex: {
      command:
        "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"
    }
  };
}

function formatZodIssue(issue: z.ZodIssue): string {
  const location =
    issue.path.length === 0 ? "service config" : issue.path.join(".");
  return `${location}: ${issue.message}`;
}

function formatZodIssueWithPrefix(issue: z.ZodIssue, prefix: string[]): string {
  const location = [...prefix, ...issue.path].join(".");
  return `${location}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
