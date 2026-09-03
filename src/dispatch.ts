import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

import {
  projectDispatchSchema,
  projectWorkspaceSchema,
  workflowReferenceSchema
} from "./config-schemas.js";
import type { GitHubIssuesApi, IssuePollStatus } from "./issue-polling.js";
import { emailNotificationConfigSchema } from "./notifications/config.js";
import {
  ActiveRunRegistry,
  type LifecyclePolicy
} from "./lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "./lifecycle/run-controller.js";
import type { AgentProviderRegistry } from "./provider.js";
import type { RunStore } from "./run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "./workspace.js";

export type DispatchIssueOptions = {
  activeRuns?: ActiveRunRegistry;
  agentProviders: AgentProviderRegistry;
  configDir: string;
  configPath: string;
  createRunId?: () => string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  issuePollStatus: IssuePollStatus;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  runStore: RunStore;
  stateRoot: string;
};

export type DispatchIssueResult =
  | {
      dispatched: false;
      reason: string;
    }
  | {
      dispatched: true;
      runId: string;
    };

const providerNameSchema = z.enum(["codex", "claude", "omp"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .passthrough();

const dispatchProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: z.literal("dispatch").default("dispatch"),
    disabled: z.boolean().optional(),
    weight: z.number().int().positive().optional(),
    // Accept but ignore in the one-shot CLI; preserves parsing parity with
    // the runtime daemon path. See ADR 0053.
    max_in_flight: z.number().int().positive().optional(),
    dispatch: projectDispatchSchema.optional(),
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
    workspace: projectWorkspaceSchema,
    agent: z
      .object({
        provider: providerNameSchema
      })
      .passthrough(),
    workflow: workflowReferenceSchema
  })
  .passthrough();

const dispatchServiceConfigSchema = z
  .object({
    email: emailNotificationConfigSchema.optional(),
    global: z
      .object({
        max_in_flight: z.number().int().positive().optional()
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
    projects: z.array(dispatchProjectSchema).min(1)
  })
  .passthrough();

const ONE_SHOT_LIFECYCLE_POLICY: LifecyclePolicy = {
  continuation: { cap: 0, delayMs: 0 },
  retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
};

export async function dispatchOneEligibleIssue(
  options: DispatchIssueOptions
): Promise<DispatchIssueResult> {
  const config = await readDispatchConfig(options.configPath);
  const projectsLoader = (): Promise<
    Map<string, RunControllerProjectConfig>
  > => {
    const map = new Map<string, RunControllerProjectConfig>();
    for (const project of config.projects) {
      map.set(project.name, project);
    }
    return Promise.resolve(map);
  };
  const providersLoader = (): Promise<RunControllerProvidersConfig> =>
    Promise.resolve({
      claude: { command: config.providers.claude.command },
      codex: { command: config.providers.codex.command },
      ...(config.providers.omp === undefined
        ? {}
        : { omp: { command: config.providers.omp.command } })
    });
  const activeRuns = options.activeRuns ?? new ActiveRunRegistry();
  const controllerOptions: ConstructorParameters<typeof RunController>[0] = {
    activeRuns,
    agentProviders: options.agentProviders,
    configDir: options.configDir,
    emailConfigLoader: () => config.email,
    githubIssuesApi: options.githubIssuesApi,
    lifecyclePolicy: ONE_SHOT_LIFECYCLE_POLICY,
    providerBuildCapacityLoader: () =>
      Promise.resolve({ maxInFlight: config.global?.max_in_flight }),
    projectsLoader,
    providersLoader,
    runStore: options.runStore,
    schedule: () => true,
    stateRoot: options.stateRoot
  };
  if (options.createRunId !== undefined) {
    controllerOptions.createRunId = options.createRunId;
  }
  if (options.env !== undefined) {
    controllerOptions.env = options.env;
  }
  if (options.prepareIssueWorkspace !== undefined) {
    controllerOptions.prepareIssueWorkspace = options.prepareIssueWorkspace;
  }
  const controller = new RunController(controllerOptions);
  return controller.dispatchOneFresh(options.issuePollStatus);
}

// Routine Hosts (ADR 0062) are never dispatch candidates and lack the
// tracker/issue_filters/priority/workflow fields dispatchProjectSchema
// requires — drop them from the raw config before validation, mirroring
// reload.ts's own exclusion of hosts from `snapshot.polling.projects`,
// rather than letting one host fail the whole array parse.
function excludeRoutineHostProjects(raw: unknown): unknown {
  if (
    raw === null ||
    typeof raw !== "object" ||
    !("projects" in raw) ||
    !Array.isArray(raw.projects)
  ) {
    return raw;
  }
  const projects = raw.projects.filter(
    (rawProject: unknown) =>
      !(
        rawProject !== null &&
        typeof rawProject === "object" &&
        "mode" in rawProject &&
        rawProject.mode === "routine_host"
      )
  );
  return { ...raw, projects };
}

async function readDispatchConfig(
  configPath: string
): Promise<z.infer<typeof dispatchServiceConfigSchema>> {
  const contents = await readFile(configPath, "utf8");
  const parsed = dispatchServiceConfigSchema.safeParse(
    excludeRoutineHostProjects(parse(contents) ?? {})
  );

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.length === 0 ? "service config" : issue.path.join(".")}: ${issue.message}`
        )
        .join("\n")
    );
  }

  return parsed.data;
}
