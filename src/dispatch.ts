import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

import type {
  GitHubIssueLabelInput,
  GitHubIssuesApi,
  IssuePollStatus
} from "./issue-polling.js";
import { ActiveRunRegistry } from "./lifecycle/active-runs.js";
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

export type LabelWritingGitHubIssuesApi = GitHubIssuesApi & {
  addLabelsToIssue: (input: GitHubIssueLabelInput) => Promise<void>;
  removeLabelsFromIssue: (input: GitHubIssueLabelInput) => Promise<void>;
};

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

const providerNameSchema = z.enum(["codex", "claude"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .passthrough();

const dispatchProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    disabled: z.boolean().optional(),
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
    workspace: z
      .object({
        root: z.string().trim().min(1),
        git: z
          .object({
            remote: z.string().trim().min(1),
            base_branch: z.string().trim().min(1)
          })
          .passthrough()
      })
      .passthrough(),
    agent: z
      .object({
        provider: providerNameSchema
      })
      .passthrough(),
    workflow: z.string().trim().min(1)
  })
  .passthrough();

const dispatchServiceConfigSchema = z
  .object({
    providers: z
      .object({
        codex: providerCommandSchema,
        claude: providerCommandSchema
      })
      .passthrough(),
    projects: z.array(dispatchProjectSchema).min(1)
  })
  .passthrough();

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
      codex: { command: config.providers.codex.command }
    });
  const activeRuns = options.activeRuns ?? new ActiveRunRegistry();
  const controllerOptions: ConstructorParameters<typeof RunController>[0] = {
    activeRuns,
    agentProviders: options.agentProviders,
    configDir: options.configDir,
    githubIssuesApi: options.githubIssuesApi,
    projectsLoader,
    providersLoader,
    runStore: options.runStore,
    schedule: () => undefined,
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

async function readDispatchConfig(
  configPath: string
): Promise<z.infer<typeof dispatchServiceConfigSchema>> {
  const contents = await readFile(configPath, "utf8");
  const parsed = dispatchServiceConfigSchema.safeParse(parse(contents) ?? {});

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) =>
          `${issue.path.length === 0 ? "service config" : issue.path.join(".")}: ${issue.message}`
        )
        .join("\n")
    );
  }

  return parsed.data;
}
