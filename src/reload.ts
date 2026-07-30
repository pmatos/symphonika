import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";

import type { WorkflowFormat } from "./config-schemas.js";
import {
  pathStringSchema,
  projectWorkspaceSchema,
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
import { renderProviderCommandTemplate } from "./provider-command-template.js";
import type {
  RoutineEffort,
  RoutinePermissionMode,
  RoutineStatus,
  TargetedRoutineDeclaration
} from "./routines/types.js";

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
  routineDefaults: RoutineDefaultsConfig;
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

const providerNameSchema = z.enum(["codex", "claude", "omp"]);
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

// Service-level fallback for per-routine model/effort/permission_mode/
// timeout_minutes (issue #291): a routine's own front-matter value wins,
// else this block, else the provider command as authored (no timeout).
const routineDefaultsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    permission_mode: z.literal("bypass").optional(),
    timeout_minutes: z.number().int().positive().optional()
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
    tracker: trackerSchema,
    issue_filters: issueFiltersSchema,
    priority: prioritySchema,
    agent: agentSchema
  })
  .passthrough()
  .superRefine(rejectPerProjectRoutines);

// A Routine Host has no use for dispatch-only fields — ADR 0062 says they are
// "unused and rejected", so a stale or copy-pasted dispatch block must be a
// declaration-time error rather than silently ignored.
const DISPATCH_ONLY_KEYS = ["issue_filters", "priority", "workflow"] as const;

function rejectDispatchOnlyKeysOnRoutineHost(
  rawProject: unknown,
  ctx: z.RefinementCtx
): void {
  if (rawProject === null || typeof rawProject !== "object") {
    return;
  }
  for (const key of DISPATCH_ONLY_KEYS) {
    if (key in rawProject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `\`${key}\` is a dispatch-only field and is unused and rejected on a Routine Host (mode: routine_host); see ADR 0062`,
        path: [key]
      });
    }
  }
}

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

// A service-level routine entry: targets one declared Project by name and
// points at a routine declaration file. Single target only; fan-out is #295.
// See ADR 0063.
const serviceRoutineSchema = z
  .object({
    project: z.string().trim().min(1),
    path: pathStringSchema
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
    routine_defaults: routineDefaultsSchema.optional(),
    providers: z
      .object({
        codex: providerCommandSchema,
        claude: providerCommandSchema,
        omp: providerCommandSchema.optional()
      })
      .passthrough(),
    // Service-level routine declarations targeting declared Projects. See
    // ADR 0063. Optional; omitted means no routines.
    routines: z.array(serviceRoutineSchema).optional(),
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

  routineDefaultsConfig(): RoutineDefaultsConfig {
    return this.snapshot?.routineDefaults ?? {};
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
  const projectIndexByProject = new Map<RuntimeProjectConfig, number>();

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
    const routineDefaults = normalizeRoutineDefaults(
      parsed.data.routine_defaults
    );
    const routineProviderCommandsByName: Partial<Record<string, string>> = {
      claude: parsed.data.providers.claude.command,
      codex: parsed.data.providers.codex.command,
      ...(parsed.data.providers.omp === undefined
        ? {}
        : { omp: parsed.data.providers.omp.command })
    };
    const previousRoutines =
      input.previous?.projects.flatMap((project) => project.routines ?? []) ??
      [];
    const routineResult = await readRoutineDeclarations(
      serviceRoutines.map((entry) => ({
        projectName: entry.project,
        sourcePath: path.resolve(input.configDir, entry.path)
      })),
      previousRoutines,
      errors
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
    for (const routine of routineResult.routines) {
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
          errors.push(
            `routines entry targets project "${projectName}" (routine "${routine.name}" at ${routine.sourcePath}), but "${projectName}" is declared more than once; routine targets require a unique project name`
          );
        }
        continue;
      }
      const project = dispatchProjects.find((p) => p.name === projectName);
      if (project === undefined) {
        for (const routine of routines) {
          errors.push(
            `routines entry targets project "${projectName}" (routine "${routine.name}" at ${routine.sourcePath}), but no project with that name is declared`
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
      for (const routine of routines) {
        if (needsTracker && routine.kind === "git") {
          const projectIndex = projectIndexByProject.get(project);
          const projectPrefix =
            projectIndex === undefined
              ? ""
              : `projects.${projectIndex}.routines: `;
          errors.push(
            `${projectPrefix}routine "${routine.name}" (kind: git) targets routine host "${projectName}" which declares no tracker; a kind: git routine requires a tracker for PR discovery`
          );
          trackerlessGitRoutines.push(routine);
          continue;
        }
        // Cross-check the routine's resolved model/effort/permission_mode
        // against its resolved provider's authored command template — this is
        // the reload-time surface that satisfies "validated at declaration
        // load" (issue #291): a routine can only know its own front-matter
        // fields, and providers:/routine_defaults: are parsed in this same
        // function, so this is the earliest point both are known together.
        // Runs BEFORE attaching, like the tracker-less check above — a
        // template-invalid routine must not fire, so on failure it is never
        // attached (`continue`s instead), falling through to `syncRoutines`'s
        // existing removed_from_config demotion/restore path rather than
        // silently keeping the misconfigured routine active.
        const routineProviderName = routine.provider ?? project.agent.provider;
        const routineProviderCommand =
          routineProviderCommandsByName[routineProviderName];
        if (routineProviderCommand !== undefined) {
          const resolved = resolveRoutineExecutionConfig(routineDefaults, {
            effort: routine.effort ?? null,
            model: routine.model ?? null,
            permissionMode: routine.permissionMode ?? null,
            timeoutMinutes: routine.timeoutMinutes ?? null
          });
          try {
            const { unreferencedFields } = renderProviderCommandTemplate(
              routineProviderCommand,
              resolved
            );
            if (unreferencedFields.length > 0) {
              for (const field of unreferencedFields) {
                errors.push(
                  `routine "${routine.name}" at ${routine.sourcePath} declares ${field}, but providers.${routineProviderName}.command never references it`
                );
              }
              continue;
            }
          } catch (error) {
            errors.push(
              `routine "${routine.name}" at ${routine.sourcePath} providers.${routineProviderName}.command is invalid: ${errorMessage(error)}`
            );
            continue;
          }
        }
        attached.push(routine);
      }
      project.routines = attached;
      if (trackerlessGitRoutines.length > 0) {
        project.trackerlessGitRoutines = trackerlessGitRoutines;
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
        codex: { command: parsed.data.providers.codex.command },
        ...(parsed.data.providers.omp === undefined
          ? {}
          : { omp: { command: parsed.data.providers.omp.command } })
      },
      pullRequestPolicy:
        pullRequestFollowupPolicyFromRaw(raw) ??
        DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
      routineDefaults: normalizeRoutineDefaults(parsed.data.routine_defaults),
      watchdog: normalizeWatchdogConfig(parsed.data.watchdog)
    },
    usingLastKnownGood: false
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
// block. See ADR 0063.
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
        "per-project `routines:` was removed; move routine entries to the top-level `routines:` block with a `project:` target (see ADR 0063)",
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
      ...(detail.data.watchdog === undefined
        ? {}
        : {
            watchdog: {
              graceMinutes: detail.data.watchdog.grace_minutes
            }
          }),
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
    ...(detail.data.watchdog === undefined
      ? {}
      : {
          watchdog: {
            graceMinutes: detail.data.watchdog.grace_minutes
          }
        }),
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
    sampleIntervalSeconds:
      raw?.sample_interval_seconds ??
      DEFAULT_WATCHDOG_CONFIG.sampleIntervalSeconds
  };
}

function normalizeRoutineDefaults(
  raw: z.infer<typeof routineDefaultsSchema> | undefined
): RoutineDefaultsConfig {
  return {
    ...(raw?.model === undefined ? {} : { model: raw.model }),
    ...(raw?.effort === undefined ? {} : { effort: raw.effort }),
    ...(raw?.permission_mode === undefined
      ? {}
      : { permissionMode: raw.permission_mode }),
    ...(raw?.timeout_minutes === undefined
      ? {}
      : { timeoutMinutes: raw.timeout_minutes })
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

export type RoutineDefaultsConfig = {
  effort?: RoutineEffort;
  model?: string;
  permissionMode?: RoutinePermissionMode;
  timeoutMinutes?: number;
};

export function resolveRoutineExecutionConfig(
  defaults: RoutineDefaultsConfig,
  routine: Pick<
    RoutineStatus,
    "effort" | "model" | "permissionMode" | "timeoutMinutes"
  >
): RoutineDefaultsConfig {
  const effort = routine.effort ?? defaults.effort;
  const model = routine.model ?? defaults.model;
  const permissionMode = routine.permissionMode ?? defaults.permissionMode;
  const timeoutMinutes = routine.timeoutMinutes ?? defaults.timeoutMinutes;
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(model === undefined ? {} : { model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes })
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
  entries: Array<{ projectName: string; sourcePath: string }>,
  previousRoutines: TargetedRoutineDeclaration[],
  errors: string[]
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
          errors.push(
            `duplicate routine name "${previous.name}" declared by ${existingForCarryForward} and ${previous.sourcePath}`
          );
        } else {
          seenNames.set(previous.name, previous.sourcePath);
          routines.push({ ...previous, projectName: entry.projectName });
        }
      } else {
        // Reserve a brand-new invalid declaration's recovered name too —
        // otherwise a later declaration in this same pass (especially one
        // targeting another Project) can legitimately claim the same name
        // while this file remains broken, violating the service-level
        // global-name uniqueness requirement (ADR 0063).
        if (result.partialName !== undefined) {
          const existingForPartialName = seenNames.get(result.partialName);
          if (existingForPartialName !== undefined) {
            errors.push(
              `duplicate routine name "${result.partialName}" declared by ${existingForPartialName} and ${entry.sourcePath}`
            );
          } else {
            seenNames.set(result.partialName, entry.sourcePath);
          }
        }
        invalidNew.push({
          ...(result.partialName === undefined
            ? {}
            : { name: result.partialName }),
          path: entry.sourcePath,
          projectName: entry.projectName
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
    routines.push({ ...result.routine, projectName: entry.projectName });
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
