import { randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";

import type { WorkflowFormat } from "./config-schemas.js";
import {
  pathStringSchema,
  projectDispatchSchema,
  projectWorkspaceSchema,
  rejectDispatchOnlyKeysOnRoutineHost,
  workflowReferenceSchema
} from "./config-schemas.js";
import type {
  PollingProjectConfig,
  PollingServiceConfig
} from "./issue-polling.js";
import { DEFAULT_POLLING_INTERVAL_MS } from "./issue-polling.js";
import {
  emailNotificationConfigSchema,
  type EmailNotificationConfig
} from "./notifications/config.js";
import type {
  RunControllerProjectConfig,
  RunControllerProvidersConfig,
  WorkflowSnapshot
} from "./lifecycle/run-controller.js";
import {
  DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
  pullRequestFollowupPolicyFromRaw,
  pullRequestPolicySchema,
  type PullRequestFollowupPolicy
} from "./pull-request-followup.js";
import { parseWorkflowContract } from "./workflow/contract-loading.js";
import {
  expandWorkflowDefinition,
  validateExpandedWorkflowReferences
} from "./workflow/fsm-expansion.js";
import { loadRoutineDeclaration } from "./routines/declaration-loader.js";
import { renderProviderCommandTemplate } from "./provider-command-template.js";
import type {
  RoutineExecutionOverrides,
  TargetedRoutineDeclaration
} from "./routines/types.js";
import {
  DEFAULT_ROUTINE_WORKSPACE_RETENTION,
  MAX_ROUTINE_WORKSPACE_RETENTION_DAYS,
  type RoutineWorkspaceRetentionPolicy
} from "./routines/workspace-retention.js";
import { createAsyncMutex } from "./lifecycle/async-mutex.js";

export type RuntimeConfigSnapshot = {
  configPath: string;
  email: EmailNotificationConfig | undefined;
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
  routineDefaults?: RoutineExecutionOverrides;
  routineWorkspaceRetention: RoutineWorkspaceRetentionPolicy;
  // Opt-in daemon self-update (ADR 0079). Boolean-only in this slice --
  // no configurable check interval or channel.
  selfUpdate: boolean;
  watchdog: WatchdogConfig;
};

export type RuntimeReloadStatus = {
  errors: string[];
  lastAttemptedAt: string | null;
  lastLoadedAt: string | null;
  ok: boolean;
  routineErrors: RoutineReloadError[];
  usingLastKnownGood: boolean;
};

type RoutineReloadError = {
  message: string;
  sourcePaths: string[];
};

export type RuntimeConfigReloaderOptions = {
  configPath: string;
  logger?: Logger;
};

export type WatchdogConfig = {
  enabled: boolean;
  graceMinutes: number;
  mtimeIgnore: string[];
  // Cumulative output tokens a single Run may spend before the Watchdog stops
  // it as non-converging (ADR 0086). Zero disables the convergence guard and
  // leaves only the ADR 0054 liveness rule.
  outputTokenBudget: number;
  sampleIntervalSeconds: number;
};

type ProjectWatchdogConfig = {
  graceMinutes?: number;
  outputTokenBudget?: number;
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
  outputTokenBudget: 150_000,
  sampleIntervalSeconds: 60
};

const providerNameSchema = z.enum(["codex", "claude", "omp"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .passthrough();

const routineExecutionDefaultsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
    permission_mode: z.string().trim().min(1).optional(),
    timeout_minutes: z.number().positive().optional()
  })
  .strict();

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
    mtime_ignore: z.array(z.string().trim().min(1)).default([]),
    output_token_budget: z
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_WATCHDOG_CONFIG.outputTokenBudget)
  })
  .passthrough();

const projectWatchdogConfigSchema = z
  .object({
    grace_minutes: z.number().int().positive().optional(),
    output_token_budget: z.number().int().nonnegative().optional()
  })
  .strict();

const routineWorkspaceRetentionSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_ROUTINE_WORKSPACE_RETENTION.enabled),
    succeeded_days: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_ROUTINE_WORKSPACE_RETENTION_DAYS)
      .default(DEFAULT_ROUTINE_WORKSPACE_RETENTION.succeededDays),
    failed_days: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_ROUTINE_WORKSPACE_RETENTION_DAYS)
      .default(DEFAULT_ROUTINE_WORKSPACE_RETENTION.failedDays),
    cancelled_days: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_ROUTINE_WORKSPACE_RETENTION_DAYS)
      .default(DEFAULT_ROUTINE_WORKSPACE_RETENTION.cancelledDays)
  })
  .passthrough();

const trackerSchema = z
  .object({
    kind: z.literal("github"),
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    token: z.string().trim().min(1)
  })
  .passthrough();

const issueFiltersSchema = z
  .object({
    states: z.array(z.literal("open")).min(1),
    labels_all: z.array(z.string().trim().min(1)),
    labels_none: z.array(z.string().trim().min(1))
  })
  .passthrough();

const prioritySchema = z
  .object({
    labels: z.record(z.string(), z.number().int().nonnegative()),
    default: z.number().int().nonnegative()
  })
  .passthrough();

const agentSchema = z
  .object({
    provider: providerNameSchema
  })
  .passthrough();

// A Dispatch Project: polled for issues, requires tracker + filters + priority.
// `mode` defaults to "dispatch" when omitted, so existing configs are unchanged.
// This is the shape `PollingProjectConfig` (issue-polling.ts) infers; Routine
// Hosts never enter `polling.projects`. See ADR 0062.
const pollingProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: z.literal("dispatch").default("dispatch"),
    disabled: z.boolean().optional(),
    weight: z.number().int().positive().optional(),
    // Per-project concurrency cap. Omitted defaults to 1 at consume-time.
    // Zero / negative values are rejected. See ADR 0053.
    max_in_flight: z.number().int().positive().optional(),
    dispatch: projectDispatchSchema.optional(),
    tracker: trackerSchema,
    issue_filters: issueFiltersSchema,
    priority: prioritySchema,
    agent: agentSchema
  })
  .passthrough()
  .superRefine(rejectPerProjectRoutines);

// A Routine Host: never polled for issues, exists only to host Routine Firings.
// Requires name + workspace + agent + mode. `tracker` is optional here; the
// unconditional "kind: git requires tracker" rule is enforced after routine
// declarations load (see loadRuntimeConfigSnapshot). See ADR 0062.
const routineHostProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: z.literal("routine_host"),
    disabled: z.boolean().optional(),
    max_in_flight: z.number().int().positive().optional(),
    tracker: trackerSchema.optional(),
    workspace: projectWorkspaceSchema,
    agent: agentSchema
  })
  .passthrough()
  .superRefine(rejectPerProjectRoutines)
  .superRefine(rejectDispatchOnlyKeysOnRoutineHost);

// Runtime detail that varies by mode. Dispatch Projects need workspace +
// workflow; Routine Hosts need workspace only (no workflow, no per-project
// routines — routines are service-level now; see ADR 0063).
const runtimeDispatchDetailSchema = z
  .object({
    name: z.string().trim().min(1),
    watchdog: projectWatchdogConfigSchema.optional(),
    workspace: projectWorkspaceSchema,
    workflow: workflowReferenceSchema
  })
  .passthrough();

const runtimeRoutineHostDetailSchema = z
  .object({
    name: z.string().trim().min(1),
    watchdog: projectWatchdogConfigSchema.optional(),
    workspace: projectWorkspaceSchema
  })
  .passthrough();

// A service-level routine entry fans one declaration file out to an explicit,
// non-empty list of declared Projects. The transitional ADR 0063 `project:`
// spelling is rejected below with a migration error. See ADR 0069.
const serviceRoutineSchema = z
  .object({
    projects: z.array(z.string().trim().min(1)).min(1).optional(),
    path: pathStringSchema
  })
  .passthrough()
  .superRefine((entry, ctx) => {
    if ("project" in entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "service-level `project:` was replaced by the explicit `projects: [<name>, ...]` target list (see ADR 0069)",
        path: ["project"]
      });
    }
    if (entry.projects === undefined) {
      if (!("project" in entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "an explicit non-empty `projects: [<name>, ...]` target list is required",
          path: ["projects"]
        });
      }
      return;
    }
    const seen = new Set<string>();
    for (const [index, projectName] of entry.projects.entries()) {
      if (seen.has(projectName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate target project "${projectName}"`,
          path: ["projects", index]
        });
      }
      seen.add(projectName);
    }
  })
  .transform((entry) => ({ ...entry, projects: entry.projects! }));

const serviceConfigSchema = z
  .object({
    email: emailNotificationConfigSchema.optional(),
    // Mirrors src/state.ts's own resolveStateRoot schema so a malformed
    // `state:` block is rejected here, at save/reload time, instead of only
    // surfacing at startup via resolveStateRoot's throw.
    state: z
      .object({
        root: z.string().min(1).optional()
      })
      .optional(),
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
    retention: z
      .object({
        routine_workspaces: routineWorkspaceRetentionSchema.optional()
      })
      .passthrough()
      .optional(),
    providers: z
      .object({
        codex: providerCommandSchema,
        claude: providerCommandSchema,
        omp: providerCommandSchema.optional()
      })
      .passthrough(),
    routine_defaults: routineExecutionDefaultsSchema.optional(),
    // Service-level routine declarations targeting declared Projects. See
    // ADR 0069. Optional; omitted means no routines.
    routines: z.array(serviceRoutineSchema).optional(),
    // Opt-in daemon self-update (ADR 0079). Defaults to false; boolean-only
    // in this slice, matching the issue's own proposed `self-update: true`
    // shape with no configurable check interval or channel.
    self_update: z.boolean().default(false),
    projects: z.array(z.unknown()).min(1)
  })
  .passthrough();

export class RuntimeConfigReloader {
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly logger?: Logger;
  // Serializes concurrent reload() calls (a poll-tick reload racing an
  // editor-triggered reload): without this, whichever call's I/O happens to
  // finish last wins `this.snapshot`, regardless of which reload actually
  // started later, so a just-installed editor save could be overwritten by
  // an in-flight scheduled reload that started before it.
  private readonly reloadMutex = createAsyncMutex();
  private snapshot: RuntimeConfigSnapshot | undefined;
  private status: RuntimeReloadStatus = {
    errors: [],
    lastAttemptedAt: null,
    lastLoadedAt: null,
    ok: false,
    routineErrors: [],
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
      errors: this.status.errors.slice(),
      routineErrors: this.status.routineErrors.map((error) => ({
        ...error,
        sourcePaths: error.sourcePaths.slice()
      }))
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

  emailConfig(): EmailNotificationConfig | undefined {
    return this.snapshot?.email;
  }

  watchdogServiceConfig(): WatchdogServiceConfig {
    return {
      projects: this.snapshot?.projects ?? [],
      watchdog: this.snapshot?.watchdog ?? DEFAULT_WATCHDOG_CONFIG
    };
  }

  selfUpdateEnabled(): boolean {
    return this.snapshot?.selfUpdate ?? false;
  }

  async reload(): Promise<RuntimeConfigSnapshot | undefined> {
    await this.reloadMutex.acquire();
    try {
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
      this.status.routineErrors = result.routineErrors;
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
    } finally {
      this.reloadMutex.release();
    }
  }
}

// #307's service-config editor: validates submitted symphonika.yml content
// the same way a real reload would, before anything is written. Deferred
// in #306 (ADR 0075) for lack of a real caller and a clean seam --
// loadRuntimeConfigSnapshot already reads from a caller-given configPath
// and configDir independently, so the seam turns out to be a temp file
// written into the SAME directory as the real config (never system tmpdir
// -- relative paths in routines:/projects[].workflow entries must resolve
// against the real directory tree, exactly like the live reload). The temp
// file is validation-only scratch: never the write target, always removed
// before this returns. loadRuntimeConfigSnapshot itself never writes
// anything and has no side effects beyond its return value, so calling it
// against a throwaway path is safe even while a real reload is in flight.
export async function validateServiceConfigContent(
  content: string,
  configPath: string
): Promise<{ errors: string[] }> {
  const configDir = path.dirname(configPath);
  // pid + millisecond timestamp alone can collide: two concurrent preview
  // requests would write the identical temp path and could each see a mix
  // of the other's content, or have their `finally` cleanup race and
  // delete the file out from under the other's read. The random suffix
  // plus exclusive-create makes that an EEXIST retry instead.
  const tempPath = path.join(
    configDir,
    `.${path.basename(configPath)}.editor-validate-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`
  );
  // Match the live config file's own permissions rather than Node's default
  // (0o666 minus umask) -- this scratch copy carries the same
  // provider-command/token content the live file does, so it should never
  // be more readable than the file it's validating. Falls back to 0o600
  // (not the live file's mode) when the live file can't be stat'd, since an
  // unreadable-permissions failure should fail closed, not open.
  const mode = await currentConfigMode(configPath);
  await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode });
  try {
    const result = await loadRuntimeConfigSnapshot({
      attemptedAt: new Date().toISOString(),
      configDir,
      configPath: tempPath
    });
    return { errors: result.errors };
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function loadRuntimeConfigSnapshot(input: {
  attemptedAt: string;
  configDir: string;
  configPath: string;
  previous?: RuntimeConfigSnapshot;
}): Promise<{
  errors: string[];
  routineErrors: RoutineReloadError[];
  snapshot?: RuntimeConfigSnapshot;
  usingLastKnownGood: boolean;
}> {
  const errors: string[] = [];
  const routineErrors: RoutineReloadError[] = [];
  const raw = await readRawServiceConfig(input.configPath, errors);
  if (raw === undefined) {
    return lastKnownGoodOrNothing(input.previous, errors);
  }

  const parsed = serviceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(formatZodIssue));
    return lastKnownGoodOrNothing(input.previous, errors);
  }

  // Validate every configured provider's command template unconditionally,
  // independent of whether any routine references it. Rendering a
  // provider's command happens per-provider-name below (in the routine
  // attach loop) and per-adapter at spawn time, but a provider used only by
  // issue-driven dispatch Projects would otherwise never have its template
  // rendered at reload time — an unrecognized/malformed tag would first
  // surface deep in a provider adapter's runAttempt, well after an issue has
  // been claimed and its workspace prepared, instead of failing loudly at
  // config-load time.
  const configuredProviderCommands: Array<[string, string]> = [
    ["claude", parsed.data.providers.claude.command],
    ["codex", parsed.data.providers.codex.command],
    ...(parsed.data.providers.omp === undefined
      ? []
      : [["omp", parsed.data.providers.omp.command] as [string, string]])
  ];
  const errorsBeforeProviderTemplateCheck = errors.length;
  for (const [providerName, command] of configuredProviderCommands) {
    try {
      renderProviderCommandTemplate(command, {});
    } catch (error) {
      errors.push(
        `providers.${providerName}.command is invalid: ${errorMessage(error)}`
      );
    }
  }
  if (errors.length > errorsBeforeProviderTemplateCheck) {
    // A malformed providers.<name>.command sits at the same Service Config
    // tier as a malformed watchdog/routine_defaults mapping — reject the
    // candidate snapshot through the normal last-known-good path (like the
    // `!parsed.success` branch above) instead of continuing to build and
    // return a "live" snapshot with an already-invalid provider command.
    return lastKnownGoodOrNothing(input.previous, errors);
  }

  // pullRequestPolicy (below) falls back to DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY
  // whenever pullRequestFollowupPolicyFromRaw's own parse fails, silently
  // masking a malformed `pull_requests:` block. Validate it here, against
  // the same schema, so that failure surfaces as a reload error instead.
  const pullRequestPolicyParse = pullRequestPolicySchema.safeParse(raw);
  if (!pullRequestPolicyParse.success) {
    errors.push(...pullRequestPolicyParse.error.issues.map(formatZodIssue));
    return lastKnownGoodOrNothing(input.previous, errors);
  }

  const pollingProjects: PollingProjectConfig[] = [];
  const dispatchProjects: RuntimeProjectConfig[] = [];
  const invalidRoutines: RuntimeConfigSnapshot["invalidRoutines"] = [];
  const projectIndexByProject = new Map<RuntimeProjectConfig, number>();
  const routineDefaults = normalizeRoutineExecutionDefaults(
    parsed.data.routine_defaults
  );
  const routineProviderCommandsByName: Partial<Record<string, string>> = {
    claude: parsed.data.providers.claude.command,
    codex: parsed.data.providers.codex.command,
    ...(parsed.data.providers.omp === undefined
      ? {}
      : { omp: parsed.data.providers.omp.command })
  };

  // First pass: validate each Project against its mode-specific schema and
  // build the runtime map. Dispatch Projects enter both `pollingProjects`
  // (so issue polling reads them) and `dispatchProjects` (the runtime map the
  // routine dispatcher and issue dispatch share). Routine Hosts enter only
  // `dispatchProjects` — they are never polled. See ADR 0062.
  for (const [index, rawProject] of parsed.data.projects.entries()) {
    const loadedProjectIndex = dispatchProjects.length;
    if (projectModeOf(rawProject) === "routine_host") {
      if (
        loadRoutineHostProject({
          dispatchProjects,
          errors,
          index,
          ...(input.previous === undefined ? {} : { previous: input.previous }),
          rawProject
        }) === "fatal"
      ) {
        return lastKnownGoodOrNothing(input.previous, errors);
      }
      const loadedProject = dispatchProjects[loadedProjectIndex];
      if (loadedProject !== undefined) {
        projectIndexByProject.set(loadedProject, index);
      }
      continue;
    }
    if (
      (await loadDispatchProject({
        configDir: input.configDir,
        dispatchProjects,
        errors,
        index,
        pollingProjects,
        ...(input.previous === undefined ? {} : { previous: input.previous }),
        rawProject
      })) === "fatal"
    ) {
      return lastKnownGoodOrNothing(input.previous, errors);
    }
    const loadedProject = dispatchProjects[loadedProjectIndex];
    if (loadedProject !== undefined) {
      projectIndexByProject.set(loadedProject, index);
    }
  }

  // Second pass: load service-level routine declarations and attach each to
  // its declared target Project in the runtime map. Enforces the
  // "kind: git on a Routine Host with no tracker is a declaration-time error"
  // rule after declarations load, when the routine's kind is known. See
  // ADR 0062 / 0063.
  const serviceRoutines = parsed.data.routines ?? [];
  if (serviceRoutines.length > 0) {
    const previousRoutines =
      input.previous?.projects.flatMap((project) => project.routines ?? []) ??
      [];
    const routineResult = await readRoutineDeclarations(
      serviceRoutines.map((entry) => ({
        projectNames: entry.projects,
        sourcePath: path.resolve(input.configDir, entry.path)
      })),
      previousRoutines,
      errors,
      routineErrors
    );
    for (const invalid of routineResult.invalidNew) {
      invalidRoutines.push({
        ...(invalid.name === undefined ? {} : { name: invalid.name }),
        path: invalid.path,
        projectName: invalid.projectName
      });
    }
    // Group valid routines by target project, enforcing the
    // kind:git-requires-tracker rule per host (a rejected routine is dropped,
    // never attached, but its name is carried separately for precise store
    // demotion). Invalid names are attached independently below so a target
    // with ALL-invalid routines still gets invalidRoutineNames — otherwise
    // syncRoutines would treat them as removed, not state=invalid.
    const routinesByProject = new Map<string, TargetedRoutineDeclaration[]>();
    for (const declaration of routineResult.routines) {
      const routine = { ...routineDefaults, ...declaration };
      const list = routinesByProject.get(routine.projectName);
      if (list === undefined) {
        routinesByProject.set(routine.projectName, [routine]);
      } else {
        list.push(routine);
      }
    }
    const invalidNamesByProject = new Map<string, string[]>();
    for (const invalid of routineResult.invalidNew) {
      if (invalid.name === undefined) {
        continue;
      }
      const list = invalidNamesByProject.get(invalid.projectName);
      if (list === undefined) {
        invalidNamesByProject.set(invalid.projectName, [invalid.name]);
      } else {
        list.push(invalid.name);
      }
    }
    // Every target project with valid OR invalid routines gets visited, so a
    // project whose routines are all invalid still receives its
    // invalidRoutineNames (and an empty routines list).
    const targetedProjectNames = new Set<string>([
      ...routinesByProject.keys(),
      ...invalidNamesByProject.keys()
    ]);
    // `.find()` below resolves a duplicated Project name to its first
    // match, but `projectsByName()` (what the dispatcher and daemon
    // actually consume) keeps the last Project declared with that name —
    // so routines attached to the shadowed duplicate would silently never
    // run. Reject the target instead of guessing which duplicate should
    // host it.
    const projectNameCounts = new Map<string, number>();
    for (const project of dispatchProjects) {
      projectNameCounts.set(
        project.name,
        (projectNameCounts.get(project.name) ?? 0) + 1
      );
    }
    for (const projectName of targetedProjectNames) {
      const routines = routinesByProject.get(projectName) ?? [];
      if ((projectNameCounts.get(projectName) ?? 0) > 1) {
        for (const routine of routines) {
          addRoutineReloadError(
            errors,
            routineErrors,
            `routines entry targets project "${projectName}" (routine "${routine.name}" at ${routine.sourcePath}), but "${projectName}" is declared more than once; routine targets require a unique project name`,
            routine.sourcePath
          );
        }
        continue;
      }
      const project = dispatchProjects.find((p) => p.name === projectName);
      if (project === undefined) {
        for (const routine of routines) {
          addRoutineReloadError(
            errors,
            routineErrors,
            `routines entry targets project "${projectName}" (routine "${routine.name}" at ${routine.sourcePath}), but no project with that name is declared`,
            routine.sourcePath
          );
        }
        continue;
      }
      // A kind: git routine on a tracker-less Routine Host is a declaration-
      // time error (ADR 0062). Push the error, record its rejected identity,
      // AND drop the offending routine so it is never attached — a rejected
      // routine must not fire. Report routines are unaffected (they need no
      // PR discovery).
      const needsTracker =
        project.mode === "routine_host" && project.tracker === undefined;
      const attached: TargetedRoutineDeclaration[] = [];
      const trackerlessGitRoutines: TargetedRoutineDeclaration[] = [];
      const templateRejectedRoutines: TargetedRoutineDeclaration[] = [];
      for (const routine of routines) {
        if (needsTracker && routine.kind === "git") {
          const projectIndex = projectIndexByProject.get(project);
          const projectPrefix =
            projectIndex === undefined
              ? ""
              : `projects.${projectIndex}.routines: `;
          addRoutineReloadError(
            errors,
            routineErrors,
            `${projectPrefix}routine "${routine.name}" (kind: git) targets routine host "${projectName}" which declares no tracker; a kind: git routine requires a tracker for PR discovery`,
            routine.sourcePath
          );
          trackerlessGitRoutines.push(routine);
          continue;
        }
        // Cross-check the routine's resolved model/effort/permission_mode
        // against its resolved provider's authored command template — the
        // earliest point both routines: and providers:/routine_defaults: are
        // known together. Runs BEFORE attaching, like the tracker-less check
        // above — a template-invalid routine must not fire, so on failure it
        // is never attached. Unlike a bare `continue`, the rejected routine
        // is tracked separately (mirroring trackerlessGitRoutines) so
        // syncRoutines can soft-disable it with a dedicated disabled_reason
        // instead of the generic removed_from_config, which would otherwise
        // misreport a still-configured-but-rejected routine as removed from
        // the top-level routines: list entirely (see ADR 0067 amendment).
        const routineProviderName = routine.provider ?? project.agent.provider;
        const routineProviderCommand =
          routineProviderCommandsByName[routineProviderName];
        if (routineProviderCommand !== undefined) {
          try {
            const { unreferencedFields } = renderProviderCommandTemplate(
              routineProviderCommand,
              routine
            );
            if (unreferencedFields.length > 0) {
              for (const field of unreferencedFields) {
                addRoutineReloadError(
                  errors,
                  routineErrors,
                  `routine "${routine.name}" at ${routine.sourcePath} declares ${field}, but providers.${routineProviderName}.command never references it`,
                  routine.sourcePath
                );
              }
              templateRejectedRoutines.push(routine);
              continue;
            }
          } catch (error) {
            addRoutineReloadError(
              errors,
              routineErrors,
              `routine "${routine.name}" at ${routine.sourcePath} providers.${routineProviderName}.command is invalid: ${errorMessage(error)}`,
              routine.sourcePath
            );
            templateRejectedRoutines.push(routine);
            continue;
          }
        }
        attached.push(routine);
      }
      project.routines = attached;
      if (trackerlessGitRoutines.length > 0) {
        project.trackerlessGitRoutines = trackerlessGitRoutines;
      }
      if (templateRejectedRoutines.length > 0) {
        project.templateRejectedRoutines = templateRejectedRoutines;
      }
      const invalidNames = invalidNamesByProject.get(projectName) ?? [];
      if (invalidNames.length > 0) {
        project.invalidRoutineNames = invalidNames;
      }
    }
  }

  // Fall back to the last-known-good only when the reload produced NO
  // runtime projects at all — a genuinely empty/broken config. A host-only
  // config (zero polling projects by design) must still go live. See ADR 0062.
  if (dispatchProjects.length === 0 && input.previous !== undefined) {
    return lastKnownGoodOrNothing(input.previous, errors, routineErrors);
  }

  const polling: PollingServiceConfig = {
    projects: pollingProjects
  };
  if (parsed.data.polling !== undefined) {
    polling.polling = parsed.data.polling;
  }

  return {
    errors,
    routineErrors,
    snapshot: {
      configPath: input.configPath,
      email: parsed.data.email,
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
        codex: { command: parsed.data.providers.codex.command },
        ...(parsed.data.providers.omp === undefined
          ? {}
          : { omp: { command: parsed.data.providers.omp.command } })
      },
      pullRequestPolicy:
        pullRequestFollowupPolicyFromRaw(raw) ??
        DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
      routineDefaults,
      routineWorkspaceRetention: normalizeRoutineWorkspaceRetention(
        parsed.data.retention?.routine_workspaces
      ),
      selfUpdate: parsed.data.self_update,
      watchdog: normalizeWatchdogConfig(parsed.data.watchdog)
    },
    usingLastKnownGood: false
  };
}

function normalizeRoutineWorkspaceRetention(
  config: z.infer<typeof routineWorkspaceRetentionSchema> | undefined
): RoutineWorkspaceRetentionPolicy {
  if (config === undefined) {
    return { ...DEFAULT_ROUTINE_WORKSPACE_RETENTION };
  }
  return {
    cancelledDays: config.cancelled_days,
    enabled: config.enabled,
    failedDays: config.failed_days,
    succeededDays: config.succeeded_days
  };
}

function normalizeRoutineExecutionDefaults(
  defaults:
    | {
        effort?: string | undefined;
        model?: string | undefined;
        permission_mode?: string | undefined;
        timeout_minutes?: number | undefined;
      }
    | undefined
): RoutineExecutionOverrides {
  if (defaults === undefined) {
    return {};
  }
  return {
    ...(defaults.effort === undefined ? {} : { effort: defaults.effort }),
    ...(defaults.model === undefined ? {} : { model: defaults.model }),
    ...(defaults.permission_mode === undefined
      ? {}
      : { permissionMode: defaults.permission_mode }),
    ...(defaults.timeout_minutes === undefined
      ? {}
      : { timeoutMinutes: defaults.timeout_minutes })
  };
}

// Outcome of validating one Project: `"ok"` means the project was loaded (or
// dropped on first-load detail/workflow failure, leaving siblings polling);
// `"fatal"` means a whole-snapshot last-known-good revert is required, matching
// the pre-mode-split semantics (watchdog-override failure always; detail or
// workflow failure only when a prior snapshot exists). See SPEC §5.1.
type ProjectLoadOutcome = "ok" | "fatal";

// Reads a raw Project entry's `mode` without an unchecked cast. Omitted mode
// defaults to "dispatch" (ADR 0062); an explicit non-string or unknown value
// falls through to the dispatch branch, which will then fail its
// `z.literal("dispatch")` discriminator and report a precise error.
function projectModeOf(rawProject: unknown): "dispatch" | "routine_host" {
  if (
    rawProject !== null &&
    typeof rawProject === "object" &&
    "mode" in rawProject &&
    rawProject.mode === "routine_host"
  ) {
    return "routine_host";
  }
  return "dispatch";
}

// Reads an optional `watchdog` override from a raw Project entry without an
// unchecked cast. Returns `undefined` when absent.
function optionalWatchdogOf(rawProject: unknown): unknown {
  if (
    rawProject !== null &&
    typeof rawProject === "object" &&
    "watchdog" in rawProject
  ) {
    return rawProject.watchdog;
  }
  return undefined;
}

// Explicitly reject the removed per-project `routines:` key. The project
// schemas use `.passthrough()`, so without this a legacy `routines:` list
// would validate silently and then be ignored — its routines would stop
// firing with no error. Force a migration error pointing at the top-level
// block. See ADR 0069.
function rejectPerProjectRoutines(
  rawProject: unknown,
  ctx: z.RefinementCtx
): void {
  if (
    rawProject !== null &&
    typeof rawProject === "object" &&
    "routines" in rawProject
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "per-project `routines:` was removed; move routine entries to the top-level `routines:` block with a `projects: [<name>, ...]` target list (see ADR 0069)",
      path: ["routines"]
    });
  }
}

// Validates and loads a Dispatch Project: tracker + issue_filters + priority +
// workflow are all required. Enters both `pollingProjects` and the runtime map.
// Returns `"fatal"` when the failure semantics require a whole-snapshot revert.
async function loadDispatchProject(input: {
  configDir: string;
  dispatchProjects: RuntimeProjectConfig[];
  errors: string[];
  index: number;
  pollingProjects: PollingProjectConfig[];
  previous?: RuntimeConfigSnapshot;
  rawProject: unknown;
}): Promise<ProjectLoadOutcome> {
  const pollingProject = pollingProjectSchema.safeParse(input.rawProject);
  if (!pollingProject.success) {
    input.errors.push(
      ...pollingProject.error.issues.map((issue) =>
        formatZodIssueWithPrefix(issue, ["projects", String(input.index)])
      )
    );
    return "ok";
  }
  input.pollingProjects.push(pollingProject.data);

  // SPEC 5.1: an invalid Project watchdog override — a non-positive-integer
  // grace_minutes or an unknown key — rejects the entire candidate snapshot
  // for all Projects, even on first load (where there is no last-known-good,
  // so nothing goes live). This is stricter than the other detail fields
  // below (workspace, workflow, ...), whose first-load failure only drops the
  // offending Project from dispatch while valid siblings keep polling.
  const rawWatchdog = optionalWatchdogOf(input.rawProject);
  if (rawWatchdog !== undefined) {
    const watchdogOverride = projectWatchdogConfigSchema.safeParse(rawWatchdog);
    if (!watchdogOverride.success) {
      input.errors.push(
        ...watchdogOverride.error.issues.map((issue) =>
          formatZodIssueWithPrefix(issue, [
            "projects",
            String(input.index),
            "watchdog"
          ])
        )
      );
      return "fatal";
    }
  }

  const detail = runtimeDispatchDetailSchema.safeParse(input.rawProject);
  if (!detail.success) {
    input.errors.push(
      ...detail.error.issues.map((issue) =>
        formatZodIssueWithPrefix(issue, ["projects", String(input.index)])
      )
    );
    // On reload, a detail failure reverts the whole snapshot to LKG; on first
    // load, drop just this project and keep parsing siblings.
    return input.previous !== undefined ? "fatal" : "ok";
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
    input.dispatchProjects.push({
      ...pollingProject.data,
      routines: [],
      ...projectWatchdogOverride(detail.data.watchdog),
      workflow:
        previousWorkflow !== undefined && "expandedWorkflow" in previousWorkflow
          ? previousWorkflow
          : detail.data.workflow,
      workspace: detail.data.workspace
    });
    return "ok";
  }

  const workflow = await readWorkflowSnapshot(
    path.resolve(input.configDir, detail.data.workflow.path),
    detail.data.workflow.format,
    input.errors
  );
  if (workflow === undefined) {
    // A missing/invalid workflow reverts the whole snapshot on reload and
    // publishes nothing on first load — a Dispatch Project in the polling
    // list without a runtime workflow would break dispatchOneFresh's
    // loadWorkflow(target.project.workflow). Unconditional, matching the
    // pre-mode-split semantics.
    return "fatal";
  }
  input.dispatchProjects.push({
    ...pollingProject.data,
    ...projectWatchdogOverride(detail.data.watchdog),
    workflow,
    workspace: detail.data.workspace
  });
  return "ok";
}

// Validates and loads a Routine Host: name + workspace + agent + mode, optional
// tracker. Enters the runtime map only — never `pollingProjects`. No workflow.
// Returns `"fatal"` when the failure semantics require a whole-snapshot revert.
function loadRoutineHostProject(input: {
  dispatchProjects: RuntimeProjectConfig[];
  errors: string[];
  index: number;
  previous?: RuntimeConfigSnapshot;
  rawProject: unknown;
}): ProjectLoadOutcome {
  const host = routineHostProjectSchema.safeParse(input.rawProject);
  if (!host.success) {
    input.errors.push(
      ...host.error.issues.map((issue) =>
        formatZodIssueWithPrefix(issue, ["projects", String(input.index)])
      )
    );
    return "ok";
  }

  // Same watchdog-override whole-snapshot rejection as Dispatch Projects.
  const rawWatchdog = optionalWatchdogOf(input.rawProject);
  if (rawWatchdog !== undefined) {
    const watchdogOverride = projectWatchdogConfigSchema.safeParse(rawWatchdog);
    if (!watchdogOverride.success) {
      input.errors.push(
        ...watchdogOverride.error.issues.map((issue) =>
          formatZodIssueWithPrefix(issue, [
            "projects",
            String(input.index),
            "watchdog"
          ])
        )
      );
      return "fatal";
    }
  }

  const detail = runtimeRoutineHostDetailSchema.safeParse(input.rawProject);
  if (!detail.success) {
    input.errors.push(
      ...detail.error.issues.map((issue) =>
        formatZodIssueWithPrefix(issue, ["projects", String(input.index)])
      )
    );
    // On reload, a detail failure reverts the whole snapshot to LKG; on first
    // load, drop just this host and keep parsing siblings.
    return input.previous !== undefined ? "fatal" : "ok";
  }

  input.dispatchProjects.push({
    ...(host.data.tracker === undefined ? {} : { tracker: host.data.tracker }),
    ...(host.data.disabled === undefined
      ? {}
      : { disabled: host.data.disabled }),
    ...(host.data.max_in_flight === undefined
      ? {}
      : { max_in_flight: host.data.max_in_flight }),
    agent: host.data.agent,
    mode: "routine_host",
    name: host.data.name,
    routines: [],
    ...projectWatchdogOverride(detail.data.watchdog),
    workspace: detail.data.workspace
  });
  return "ok";
}

function normalizeWatchdogConfig(
  raw: z.infer<typeof watchdogConfigSchema> | undefined
): WatchdogConfig {
  return {
    enabled: raw?.enabled ?? DEFAULT_WATCHDOG_CONFIG.enabled,
    graceMinutes: raw?.grace_minutes ?? DEFAULT_WATCHDOG_CONFIG.graceMinutes,
    mtimeIgnore: raw?.mtime_ignore ?? DEFAULT_WATCHDOG_CONFIG.mtimeIgnore,
    outputTokenBudget:
      raw?.output_token_budget ?? DEFAULT_WATCHDOG_CONFIG.outputTokenBudget,
    sampleIntervalSeconds:
      raw?.sample_interval_seconds ??
      DEFAULT_WATCHDOG_CONFIG.sampleIntervalSeconds
  };
}

function projectWatchdogOverride(
  raw: z.infer<typeof projectWatchdogConfigSchema> | undefined
): { watchdog: ProjectWatchdogConfig } | Record<string, never> {
  if (raw === undefined) {
    return {};
  }
  return {
    watchdog: {
      ...(raw.grace_minutes === undefined
        ? {}
        : { graceMinutes: raw.grace_minutes }),
      ...(raw.output_token_budget === undefined
        ? {}
        : { outputTokenBudget: raw.output_token_budget })
    }
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
    ...(projectOverride.graceMinutes === undefined
      ? {}
      : { graceMinutes: projectOverride.graceMinutes }),
    ...(projectOverride.outputTokenBudget === undefined
      ? {}
      : { outputTokenBudget: projectOverride.outputTokenBudget })
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
  entries: Array<{ projectNames: string[]; sourcePath: string }>,
  previousRoutines: TargetedRoutineDeclaration[],
  errors: string[],
  routineErrors: RoutineReloadError[]
): Promise<{
  invalidNew: Array<{ name?: string; path: string; projectName: string }>;
  routines: TargetedRoutineDeclaration[];
}> {
  const routines: TargetedRoutineDeclaration[] = [];
  const invalidNew: Array<{
    name?: string;
    path: string;
    projectName: string;
  }> = [];
  const seenNames = new Map<string, string>();
  const previousBySourcePath = new Map(
    previousRoutines.map((routine) => [routine.sourcePath, routine])
  );
  for (const entry of entries) {
    const result = await loadRoutineDeclaration(entry.sourcePath);
    if (result.routine === null) {
      errors.push(...result.errors);
      routineErrors.push(
        ...result.errors.map((message) => ({
          message,
          sourcePaths: [entry.sourcePath]
        }))
      );
      // Carry-forward is keyed on the file's own path, not on the freshly
      // parsed name — a broken edit can corrupt the name field itself while
      // the path symphonika.yml references stays the same. Falling back to
      // name would wrongly treat that as "no prior valid declaration" and
      // let the removal-detection path in RunStore.syncRoutines demote a
      // still-configured routine to disabled/removed_from_config.
      const previous = previousBySourcePath.get(entry.sourcePath);
      if (previous !== undefined) {
        // Register the carried-forward name too — otherwise a later file in
        // this same pass that legitimately (re)uses this name slips past
        // the duplicate check below, since seenNames would have no record
        // of it ever being declared.
        const existingForCarryForward = seenNames.get(previous.name);
        if (existingForCarryForward !== undefined) {
          addRoutineReloadError(
            errors,
            routineErrors,
            `duplicate routine name "${previous.name}" declared by ${existingForCarryForward} and ${previous.sourcePath}`,
            existingForCarryForward,
            previous.sourcePath
          );
        } else {
          seenNames.set(previous.name, previous.sourcePath);
          routines.push(
            ...entry.projectNames.map((projectName) => ({
              ...previous,
              projectName
            }))
          );
        }
      } else {
        // Reserve a brand-new invalid declaration's recovered name too —
        // otherwise a later declaration in this same pass (especially one
        // targeting another Project) can legitimately claim the same name
        // while this file remains broken, violating the service-level
        // global-name uniqueness requirement (ADR 0069).
        if (result.partialName !== undefined) {
          const existingForPartialName = seenNames.get(result.partialName);
          if (existingForPartialName !== undefined) {
            addRoutineReloadError(
              errors,
              routineErrors,
              `duplicate routine name "${result.partialName}" declared by ${existingForPartialName} and ${entry.sourcePath}`,
              existingForPartialName,
              entry.sourcePath
            );
          } else {
            seenNames.set(result.partialName, entry.sourcePath);
          }
        }
        invalidNew.push(
          ...entry.projectNames.map((projectName) => ({
            ...(result.partialName === undefined
              ? {}
              : { name: result.partialName }),
            path: entry.sourcePath,
            projectName
          }))
        );
      }
      continue;
    }
    const routine = result.routine;
    const existing = seenNames.get(routine.name);
    if (existing !== undefined) {
      addRoutineReloadError(
        errors,
        routineErrors,
        `duplicate routine name "${routine.name}" declared by ${existing} and ${routine.sourcePath}`,
        existing,
        routine.sourcePath
      );
      continue;
    }
    seenNames.set(routine.name, routine.sourcePath);
    routines.push(
      ...entry.projectNames.map((projectName) => ({
        ...routine,
        projectName
      }))
    );
  }
  return { invalidNew, routines };
}

function addRoutineReloadError(
  errors: string[],
  routineErrors: RoutineReloadError[],
  message: string,
  ...sourcePaths: string[]
): void {
  errors.push(message);
  routineErrors.push({
    message,
    sourcePaths: [...new Set(sourcePaths)]
  });
}

function lastKnownGoodOrNothing(
  previous: RuntimeConfigSnapshot | undefined,
  errors: string[],
  routineErrors: RoutineReloadError[] = []
): {
  errors: string[];
  routineErrors: RoutineReloadError[];
  snapshot?: RuntimeConfigSnapshot;
  usingLastKnownGood: boolean;
} {
  return {
    errors,
    routineErrors,
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
    },
    omp: {
      command: "omp --mode rpc --auto-approve"
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

async function currentConfigMode(configPath: string): Promise<number> {
  try {
    return (await stat(configPath)).mode & 0o777;
  } catch {
    return 0o600;
  }
}
