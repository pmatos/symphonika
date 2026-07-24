import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Octokit } from "@octokit/rest";
import { isSeq, parse, parseDocument } from "yaml";
import { z } from "zod";

import type { WorkflowFormat } from "./config-schemas.js";
import {
  pathStringSchema,
  projectWorkspaceSchema,
  workflowReferenceSchema
} from "./config-schemas.js";
import {
  missingUserConfigHint,
  resolveServiceConfigPath
} from "./config-paths.js";
import {
  defaultWorkflowContract,
  inspectCurrentGitHubProject,
  type InitProvider
} from "./init.js";
import {
  DEFAULT_GITHUB_ISSUES_API,
  type GitHubIssuesApi
} from "./issue-polling.js";
import { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";
import type { AgentProviderRegistry } from "./provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import { loadRoutineDeclaration } from "./routines/declaration-loader.js";
import { resolveStateRoot } from "./state.js";
import {
  loadExpandedWorkflow,
  resolveWorkflowFormat,
  validateExpandedWorkflowReferences
} from "./workflow.js";

export { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";

export type DoctorOptions = {
  agentProviders?: AgentProviderRegistry;
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  githubApi?: GitHubApi;
  githubIssuesApi?: GitHubIssuesApi;
};

type StaleIssueSummary = {
  number: number;
  title: string;
  url: string;
};

export type DoctorProjectReport = {
  missingEligibilityLabels: string[];
  missingOperationalLabels: string[];
  name: string;
  staleIssues: StaleIssueSummary[];
  validForDispatch: boolean;
  workflowPath: string;
};

export type DoctorReport = {
  configPath: string;
  errors: string[];
  ok: boolean;
  projects: DoctorProjectReport[];
};

export type InitProjectOptions = DoctorOptions & {
  force?: boolean;
  onWarning?: (warning: string) => void;
  prompt?: InitProjectPrompt;
  yes?: boolean;
};

type InitProjectPromptInput = {
  defaultValue: string;
  key:
    | "baseBranch"
    | "excludedLabels"
    | "priorityLabels"
    | "projectName"
    | "provider"
    | "confirmEligibilityLabels"
    | "confirmOperationalLabels"
    | "requiredLabels"
    | "workflowPath";
  message: string;
};

type InitProjectPrompt = (input: InitProjectPromptInput) => Promise<string>;

type InitProjectProjectReport = {
  createdEligibilityLabels: string[];
  createdOperationalLabels: string[];
  missingEligibilityLabels: string[];
  missingOperationalLabels: string[];
  name: string;
  repository: string;
};

export type InitProjectReport = {
  configPath: string;
  createdWorkflowPath: string | null;
  errors: string[];
  ok: boolean;
  projects: InitProjectProjectReport[];
  warnings: string[];
};

type GitHubRepositoryInput = {
  owner: string;
  repo: string;
  token: string;
};

type GitHubRepositoryAccess = {
  message?: string;
  ok: boolean;
};

export type GitHubApi = {
  createLabel: (
    input: GitHubRepositoryInput & { name: string }
  ) => Promise<void>;
  listLabels: (input: GitHubRepositoryInput) => Promise<string[]>;
  removeIssueLabel?: (
    input: GitHubRepositoryInput & { issueNumber: number; name: string }
  ) => Promise<void>;
  validateRepositoryAccess: (
    input: GitHubRepositoryInput
  ) => Promise<GitHubRepositoryAccess>;
};

export type ClearStaleOptions = DoctorOptions & {
  issueNumber: number;
  onWarning?: (warning: string) => void;
  project: string;
  yes?: boolean;
};

export type ClearStaleReport = {
  configPath: string;
  errors: string[];
  issueNumber: number;
  ok: boolean;
  project: string;
  removedLabels: string[];
  repository: string;
  warnings: string[];
};

type ServiceConfig = z.infer<typeof serviceConfigSchema>;
type ProjectConfig = z.infer<typeof projectSchema>;
type ProjectValidation = Pick<
  DoctorProjectReport,
  "missingEligibilityLabels" | "missingOperationalLabels" | "validForDispatch"
>;
type LabelDescription = {
  color: string;
  description: string;
};

const OPERATIONAL_LABEL_DESCRIPTIONS: Record<
  (typeof REQUIRED_OPERATIONAL_LABELS)[number],
  LabelDescription
> = {
  "sym:blocked": {
    color: "d4c5f9",
    description:
      "A non-actionable blocked run: the agent declined the task, or a workflow needs a human decision."
  },
  "sym:claimed": {
    color: "5319e7",
    description: "Symphonika has claimed this issue for an orchestrated run."
  },
  "sym:failed": {
    color: "d73a4a",
    description: "A Symphonika run reached a deterministic failed state."
  },
  "sym:running": {
    color: "0e8a16",
    description: "A Symphonika coding-agent run is currently active."
  },
  "sym:stale": {
    color: "fbca04",
    description: "A Symphonika claim exists without a live local run."
  }
};

const SILENT_OCTOKIT_LOG = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

const providerNameSchema = z.enum(["codex", "claude"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .passthrough();

const projectSchema = z
  .object({
    name: z.string().trim().min(1),
    disabled: z.boolean().optional(),
    weight: z.number().int().positive().optional(),
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
    routines: z.array(pathStringSchema).optional(),
    workflow: workflowReferenceSchema
  })
  .passthrough();

const serviceConfigSchema = z
  .object({
    state: z
      .object({
        root: pathStringSchema.optional()
      })
      .passthrough()
      .optional(),
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional()
      })
      .passthrough()
      .optional(),
    providers: z
      .object({
        codex: providerCommandSchema,
        claude: providerCommandSchema
      })
      .passthrough(),
    projects: z.array(projectSchema).min(1)
  })
  .passthrough();

export async function runDoctor(
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const resolvedConfig = resolveServiceConfigPath({
    ...withConfigPath(options.configPath),
    cwd,
    env
  });
  const configPath = resolvedConfig.configPath;
  const githubApi = options.githubApi ?? DEFAULT_GITHUB_API;
  const githubIssuesApi = options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const agentProviders = options.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
  const errors: string[] = [];
  const projects: DoctorProjectReport[] = [];
  const rawConfig = await readConfig(configPath, errors);

  if (rawConfig === undefined) {
    if (resolvedConfig.source === "user" && !resolvedConfig.configExists) {
      errors.push(missingUserConfigHint(configPath));
    }
    return report(configPath, errors, projects);
  }

  const parsedConfig = parseServiceConfig(rawConfig, errors);
  if (parsedConfig === undefined) {
    return report(configPath, errors, projects);
  }

  for (const project of parsedConfig.projects) {
    const validation = await validateProject(
      project,
      parsedConfig,
      agentProviders,
      env,
      errors,
      githubApi
    );
    const workflowPath = path.resolve(
      path.dirname(configPath),
      project.workflow.path
    );
    const workflowErrors = await collectWorkflowErrors(
      workflowPath,
      project.workflow.format
    );
    errors.push(...workflowErrors);
    errors.push(
      ...(await collectRoutineErrors(
        (project.routines ?? []).map((routinePath) =>
          path.resolve(path.dirname(configPath), routinePath)
        )
      ))
    );
    const staleIssues = await fetchStaleIssues(project, env, githubIssuesApi);
    projects.push({
      ...validation,
      name: project.name,
      staleIssues,
      workflowPath
    });
  }

  return report(configPath, errors, projects);
}

async function collectRoutineErrors(routinePaths: string[]): Promise<string[]> {
  const errors: string[] = [];
  const seenNames = new Map<string, string>();
  for (const routinePath of routinePaths) {
    const result = await loadRoutineDeclaration(routinePath);
    if (result.routine === null) {
      errors.push(...result.errors);
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
  }
  return errors;
}

async function collectWorkflowErrors(
  workflowPath: string,
  format: WorkflowFormat
): Promise<string[]> {
  try {
    const expanded = await loadExpandedWorkflow(workflowPath, format);
    if (expanded.errors.length > 0) {
      return expanded.errors;
    }
    return validateExpandedWorkflowReferences(expanded.workflow, workflowPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`workflow contract not found at ${workflowPath}: ${message}`];
  }
}

async function fetchStaleIssues(
  project: ProjectConfig,
  env: NodeJS.ProcessEnv,
  githubIssuesApi: GitHubIssuesApi
): Promise<StaleIssueSummary[]> {
  const token = resolveEnvBackedValue(project.tracker.token, env);
  if (token === undefined) {
    return [];
  }
  let issues;
  try {
    issues = await githubIssuesApi.listOpenIssues({
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    });
  } catch {
    return [];
  }
  const stale: StaleIssueSummary[] = [];
  for (const raw of issues) {
    const labelNames = labelNamesOf(raw.labels);
    if (!labelNames.includes("sym:stale")) {
      continue;
    }
    const number = typeof raw.number === "number" ? raw.number : undefined;
    if (number === undefined) {
      continue;
    }
    stale.push({
      number,
      title: typeof raw.title === "string" ? raw.title : "",
      url:
        typeof raw.html_url === "string"
          ? raw.html_url
          : typeof raw.url === "string"
            ? raw.url
            : ""
    });
  }
  return stale;
}

function labelNamesOf(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      names.push(entry);
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      typeof (entry as { name: unknown }).name === "string"
    ) {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

export async function runInitProject(
  options: InitProjectOptions = {}
): Promise<InitProjectReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const resolvedConfig = resolveServiceConfigPath({
    ...withConfigPath(options.configPath),
    cwd,
    env
  });
  const configPath = resolvedConfig.configPath;
  const errors: string[] = [];
  const warnings: string[] = [];
  const projects: InitProjectProjectReport[] = [];
  if (!resolvedConfig.configExists) {
    errors.push(
      resolvedConfig.source === "user"
        ? missingUserConfigHint(configPath)
        : `service config not found at ${configPath}`
    );
    return initProjectReport(configPath, errors, warnings, projects);
  }

  let configContents: string;
  try {
    configContents = await readFile(configPath, "utf8");
  } catch (error) {
    errors.push(
      `service config could not be read at ${configPath}: ${errorMessage(error)}`
    );
    return initProjectReport(configPath, errors, warnings, projects);
  }

  const document = parseDocument(configContents);
  if (document.errors.length > 0) {
    errors.push(
      ...document.errors.map(
        (error) => `service config could not be parsed: ${error.message}`
      )
    );
    return initProjectReport(configPath, errors, warnings, projects);
  }
  const projectsNode = document.get("projects", true);
  if (!isSeq(projectsNode)) {
    errors.push(
      "service config must contain a projects sequence; run `symphonika init --force` to recreate the global config"
    );
    return initProjectReport(configPath, errors, warnings, projects);
  }

  let metadata: Awaited<ReturnType<typeof inspectCurrentGitHubProject>>;
  try {
    metadata = await inspectCurrentGitHubProject(cwd);
  } catch (error) {
    errors.push(errorMessage(error));
    return initProjectReport(configPath, errors, warnings, projects);
  }

  let settings: ProjectInitSettings;
  try {
    settings = await collectProjectSettings({
      metadata,
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      yes: options.yes === true
    });
  } catch (error) {
    errors.push(errorMessage(error));
    return initProjectReport(configPath, errors, warnings, projects);
  }

  let stateRoot: string;
  try {
    stateRoot = resolveStateRoot({ configPath, cwd, env }).stateRoot;
  } catch (error) {
    errors.push(errorMessage(error));
    return initProjectReport(configPath, errors, warnings, projects);
  }

  const project = buildProjectConfig({ metadata, settings, stateRoot });
  const rawProjects = projectsNode.toJSON();
  const matchingIndexes = rawProjects.reduce<number[]>(
    (indexes, entry, index) => {
      const rawName =
        typeof entry === "object" && entry !== null && "name" in entry
          ? (entry as { name?: unknown }).name
          : undefined;
      if (
        typeof rawName === "string" &&
        rawName.trim() === settings.projectName
      ) {
        indexes.push(index);
      }
      return indexes;
    },
    []
  );
  if (matchingIndexes.length > 1) {
    errors.push(
      `project ${settings.projectName} appears ${matchingIndexes.length} times in ${configPath}; remove the duplicate Projects before running init-project`
    );
    return initProjectReport(configPath, errors, warnings, projects);
  }
  const existingIndex = matchingIndexes[0] ?? -1;
  if (existingIndex >= 0 && options.force !== true) {
    errors.push(
      `project ${settings.projectName} already exists in ${configPath}; pass --force to replace that Project`
    );
    return initProjectReport(configPath, errors, warnings, projects);
  }
  if (existingIndex >= 0) {
    document.setIn(["projects", existingIndex], project);
  } else {
    projectsNode.add(project);
  }

  const parsedConfig = parseServiceConfig(document.toJS(), errors);
  if (parsedConfig === undefined) {
    return initProjectReport(configPath, errors, warnings, projects);
  }

  const registeredProject = parsedConfig.projects.find(
    (entry) => entry.name === settings.projectName
  );
  if (registeredProject === undefined) {
    errors.push(`registered Project ${settings.projectName} could not be read`);
    return initProjectReport(configPath, errors, warnings, projects);
  }

  const githubApi = options.githubApi ?? DEFAULT_GITHUB_API;
  const accessValidation = await validateProjectGitHubAccess({
    env,
    errors,
    githubApi,
    project: registeredProject
  });
  if (accessValidation === undefined) {
    return initProjectReport(configPath, errors, warnings, projects);
  }

  let createdWorkflow = false;
  if (!(await fileExists(settings.workflowPath))) {
    const resolvedFormat = resolveWorkflowFormat(
      registeredProject.workflow.format,
      settings.workflowPath
    );
    if (resolvedFormat.kind !== "markdown") {
      errors.push(
        resolvedFormat.kind === "error"
          ? `starter Workflow Contract could not be created at ${settings.workflowPath}: ${resolvedFormat.error}`
          : `starter Workflow Contract could not be created at ${settings.workflowPath}: the path resolves to the raw_fsm workflow format; init-project only scaffolds Markdown contracts, so create this file manually or choose a path ending in .md`
      );
      return initProjectReport(configPath, errors, warnings, projects);
    }
    try {
      await mkdir(path.dirname(settings.workflowPath), { recursive: true });
      await writeFile(settings.workflowPath, defaultWorkflowContract(), "utf8");
      createdWorkflow = true;
    } catch (error) {
      errors.push(
        `starter Workflow Contract could not be created at ${settings.workflowPath}: ${errorMessage(error)}`
      );
      return initProjectReport(configPath, errors, warnings, projects);
    }
  }

  projects.push(
    await createProjectLabels({
      errors,
      githubApi,
      ...(options.onWarning === undefined
        ? {}
        : { onWarning: options.onWarning }),
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      project: registeredProject,
      validation: accessValidation,
      warnings,
      yes: options.yes === true
    })
  );
  if (errors.length > 0) {
    await removeCreatedWorkflow(settings.workflowPath, createdWorkflow, errors);
    return initProjectReport(configPath, errors, warnings, projects);
  }

  try {
    await writeFile(configPath, document.toString(), "utf8");
  } catch (error) {
    errors.push(
      `service config could not be written at ${configPath}: ${errorMessage(error)}`
    );
    await removeCreatedWorkflow(settings.workflowPath, createdWorkflow, errors);
  }

  return initProjectReport(
    configPath,
    errors,
    warnings,
    projects,
    createdWorkflow && errors.length === 0 ? settings.workflowPath : null
  );
}

type ProjectInitSettings = {
  baseBranch: string;
  excludedLabels: string[];
  priorityLabels: Record<string, number>;
  projectName: string;
  provider: InitProvider;
  requiredLabels: string[];
  workflowPath: string;
};

async function collectProjectSettings(input: {
  metadata: Awaited<ReturnType<typeof inspectCurrentGitHubProject>>;
  prompt?: InitProjectPrompt;
  yes: boolean;
}): Promise<ProjectInitSettings> {
  const defaultWorkflowPath = path.join(
    input.metadata.projectRoot,
    "WORKFLOW.md"
  );
  const promptController = createInitProjectPromptController(
    input.prompt,
    input.yes
  );

  try {
    const projectName = await promptController.ask({
      defaultValue: input.metadata.projectName,
      key: "projectName",
      message: "Project name"
    });
    const provider = parseInitProvider(
      await promptController.ask({
        defaultValue: "codex",
        key: "provider",
        message: "Agent Provider (codex or claude)"
      })
    );
    const baseBranch = await promptController.ask({
      defaultValue: input.metadata.baseBranch,
      key: "baseBranch",
      message: "Base branch"
    });
    const requiredLabels = parseLabelList(
      await promptController.ask({
        defaultValue: "agent-ready",
        key: "requiredLabels",
        message: "Required issue labels (comma-separated)"
      }),
      "required issue labels"
    );
    const excludedLabels = parseLabelList(
      await promptController.ask({
        defaultValue: "blocked, needs-human, sym:stale",
        key: "excludedLabels",
        message: "Excluded issue labels (comma-separated)"
      }),
      "excluded issue labels"
    );
    const priorityLabels = parsePriorityLabels(
      await promptController.ask({
        defaultValue:
          "priority:critical=0, priority:high=1, priority:medium=2, priority:low=3",
        key: "priorityLabels",
        message: "Priority labels (comma-separated label=number pairs)"
      })
    );
    const workflowAnswer = await promptController.ask({
      defaultValue: defaultWorkflowPath,
      key: "workflowPath",
      message: "Workflow Contract path"
    });

    if (projectName.trim().length === 0) {
      throw new Error("Project name must not be empty");
    }
    if (baseBranch.trim().length === 0) {
      throw new Error("base branch must not be empty");
    }
    if (workflowAnswer.trim().length === 0) {
      throw new Error("Workflow Contract path must not be empty");
    }

    return {
      baseBranch,
      excludedLabels,
      priorityLabels,
      projectName,
      provider,
      requiredLabels,
      workflowPath: path.isAbsolute(workflowAnswer)
        ? path.normalize(workflowAnswer)
        : path.resolve(input.metadata.projectRoot, workflowAnswer)
    };
  } finally {
    promptController.close();
  }
}

function createInitProjectPromptController(
  injectedPrompt: InitProjectPrompt | undefined,
  yes: boolean
): { ask: InitProjectPrompt; close: () => void } {
  if (yes) {
    return {
      ask: (input) => Promise.resolve(input.defaultValue),
      close: () => undefined
    };
  }
  if (injectedPrompt !== undefined) {
    return {
      ask: async (input) => {
        const answer = await injectedPrompt(input);
        return answer.trim().length === 0 ? input.defaultValue : answer.trim();
      },
      close: () => undefined
    };
  }

  const readline = createInterface({ input: stdin, output: stdout });
  return {
    ask: async (input) => {
      const answer = await readline.question(
        `${input.message} [${input.defaultValue}]: `
      );
      return answer.trim().length === 0 ? input.defaultValue : answer.trim();
    },
    close: () => readline.close()
  };
}

function parseInitProvider(value: string): InitProvider {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error("Agent Provider must be one of codex, claude");
}

function parseLabelList(value: string, label: string): string[] {
  const labels = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (labels.length === 0) {
    throw new Error(`${label} must contain at least one label`);
  }
  return labels;
}

function parsePriorityLabels(value: string): Record<string, number> {
  const priorities: Record<string, number> = {};
  for (const entry of value.split(",")) {
    const match = /^(.+)=([0-9]+)$/.exec(entry.trim());
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(
        "priority labels must use comma-separated label=non-negative-integer pairs"
      );
    }
    priorities[match[1].trim()] = Number(match[2]);
  }
  return priorities;
}

function buildProjectConfig(input: {
  metadata: Awaited<ReturnType<typeof inspectCurrentGitHubProject>>;
  settings: ProjectInitSettings;
  stateRoot: string;
}): unknown {
  return {
    name: input.settings.projectName,
    disabled: false,
    weight: 1,
    tracker: {
      kind: "github",
      owner: input.metadata.owner,
      repo: input.metadata.repo,
      token: "$GITHUB_TOKEN"
    },
    issue_filters: {
      states: ["open"],
      labels_all: input.settings.requiredLabels,
      labels_none: input.settings.excludedLabels
    },
    priority: {
      labels: input.settings.priorityLabels,
      default: 99
    },
    workspace: {
      root: path.join(
        input.stateRoot,
        "workspaces",
        input.settings.projectName
      ),
      git: {
        remote: input.metadata.remote,
        base_branch: input.settings.baseBranch
      }
    },
    agent: {
      provider: input.settings.provider
    },
    workflow: input.settings.workflowPath
  };
}

type ProjectGitHubAccessValidation = {
  missingEligibilityLabels: string[];
  missingOperationalLabels: string[];
  repository: { owner: string; repo: string; token: string };
  repositoryName: string;
};

async function validateProjectGitHubAccess(input: {
  env: NodeJS.ProcessEnv;
  errors: string[];
  githubApi: GitHubApi;
  project: ProjectConfig;
}): Promise<ProjectGitHubAccessValidation | undefined> {
  const token = resolveEnvBackedValue(input.project.tracker.token, input.env);
  if (token === undefined) {
    const variableName = envReferenceName(input.project.tracker.token);
    input.errors.push(
      variableName === undefined
        ? `projects.${input.project.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
        : `projects.${input.project.name}.tracker.token references unset environment variable $${variableName}`
    );
    return undefined;
  }

  const repository = {
    owner: input.project.tracker.owner,
    repo: input.project.tracker.repo,
    token
  };
  const repositoryName = `${repository.owner}/${repository.repo}`;
  const repositoryAccess =
    await input.githubApi.validateRepositoryAccess(repository);
  if (!repositoryAccess.ok) {
    input.errors.push(
      `projects.${input.project.name}.tracker.repository ${repositoryName} is not accessible: ${repositoryAccess.message ?? "unknown GitHub error"}`
    );
    return undefined;
  }

  let labels: Set<string>;
  try {
    labels = new Set(await input.githubApi.listLabels(repository));
  } catch (error) {
    input.errors.push(
      `projects.${input.project.name}.tracker.repository ${repositoryName} labels could not be listed: ${errorMessage(error)}`
    );
    return undefined;
  }

  const missingOperationalLabels = REQUIRED_OPERATIONAL_LABELS.filter(
    (label) => !labels.has(label)
  );
  const missingEligibilityLabels = findMissingEligibilityLabels(
    input.project,
    labels
  );
  return {
    missingEligibilityLabels,
    missingOperationalLabels,
    repository,
    repositoryName
  };
}

async function createProjectLabels(input: {
  errors: string[];
  githubApi: GitHubApi;
  onWarning?: (warning: string) => void;
  prompt?: InitProjectPrompt;
  project: ProjectConfig;
  validation: ProjectGitHubAccessValidation;
  warnings: string[];
  yes: boolean;
}): Promise<InitProjectProjectReport> {
  const {
    missingEligibilityLabels,
    missingOperationalLabels,
    repository,
    repositoryName
  } = input.validation;
  const createdEligibilityLabels: string[] = [];
  const createdOperationalLabels: string[] = [];
  if (missingOperationalLabels.length > 0) {
    const warning = `init-project ${input.yes ? "will" : "would"} create operational labels in ${repositoryName}: ${missingOperationalLabels.join(", ")}`;
    input.warnings.push(warning);
    input.onWarning?.(warning);
    let confirmed = input.yes;
    if (!confirmed) {
      try {
        confirmed = await confirmOperationalLabelCreation({
          missingOperationalLabels,
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          repositoryName
        });
        if (!confirmed) {
          input.errors.push("operational label creation was declined");
        }
      } catch (error) {
        input.errors.push(errorMessage(error));
      }
    }
    if (confirmed) {
      for (const label of missingOperationalLabels) {
        try {
          await input.githubApi.createLabel({ ...repository, name: label });
          createdOperationalLabels.push(label);
        } catch (error) {
          input.errors.push(
            `projects.${input.project.name}.tracker.repository ${repositoryName} could not create operational label ${label}: ${errorMessage(error)}`
          );
        }
      }
    }
  }
  if (missingEligibilityLabels.length > 0) {
    const warning = `init-project ${input.yes ? "will" : "would"} create required eligibility labels in ${repositoryName}: ${missingEligibilityLabels.join(", ")}`;
    input.warnings.push(warning);
    input.onWarning?.(warning);
    let confirmed = input.yes;
    if (!confirmed) {
      try {
        confirmed = await confirmEligibilityLabelCreation({
          missingEligibilityLabels,
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          repositoryName
        });
        if (!confirmed) {
          input.errors.push("required eligibility label creation was declined");
        }
      } catch (error) {
        input.errors.push(errorMessage(error));
      }
    }
    if (confirmed) {
      for (const label of missingEligibilityLabels) {
        try {
          await input.githubApi.createLabel({ ...repository, name: label });
          createdEligibilityLabels.push(label);
        } catch (error) {
          input.errors.push(
            `projects.${input.project.name}.tracker.repository ${repositoryName} could not create required eligibility label ${label}: ${errorMessage(error)}`
          );
        }
      }
    }
  }

  return {
    createdEligibilityLabels,
    createdOperationalLabels,
    missingEligibilityLabels,
    missingOperationalLabels,
    name: input.project.name,
    repository: repositoryName
  };
}

async function confirmOperationalLabelCreation(input: {
  missingOperationalLabels: string[];
  prompt?: InitProjectPrompt;
  repositoryName: string;
}): Promise<boolean> {
  const promptController = createInitProjectPromptController(
    input.prompt,
    false
  );
  try {
    const answer = (
      await promptController.ask({
        defaultValue: "yes",
        key: "confirmOperationalLabels",
        message: `Create missing operational labels in ${input.repositoryName}: ${input.missingOperationalLabels.join(", ")}? (yes/no)`
      })
    ).toLowerCase();
    if (answer === "yes" || answer === "y") {
      return true;
    }
    if (answer === "no" || answer === "n") {
      return false;
    }
    throw new Error("operational label confirmation must be yes or no");
  } finally {
    promptController.close();
  }
}

async function confirmEligibilityLabelCreation(input: {
  missingEligibilityLabels: string[];
  prompt?: InitProjectPrompt;
  repositoryName: string;
}): Promise<boolean> {
  const promptController = createInitProjectPromptController(
    input.prompt,
    false
  );
  try {
    const answer = (
      await promptController.ask({
        defaultValue: "yes",
        key: "confirmEligibilityLabels",
        message: `Create missing required eligibility labels in ${input.repositoryName}: ${input.missingEligibilityLabels.join(", ")}? (yes/no)`
      })
    ).toLowerCase();
    if (answer === "yes" || answer === "y") {
      return true;
    }
    if (answer === "no" || answer === "n") {
      return false;
    }
    throw new Error("eligibility label confirmation must be yes or no");
  } finally {
    promptController.close();
  }
}

async function removeCreatedWorkflow(
  workflowPath: string,
  createdWorkflow: boolean,
  errors: string[]
): Promise<void> {
  if (!createdWorkflow) {
    return;
  }
  try {
    await rm(workflowPath);
  } catch (error) {
    errors.push(
      `starter Workflow Contract could not be removed after failed initialization at ${workflowPath}: ${errorMessage(error)}`
    );
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const STALE_CLEAR_LABELS = ["sym:stale", "sym:claimed", "sym:running"] as const;

export async function runClearStale(
  options: ClearStaleOptions
): Promise<ClearStaleReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const resolvedConfig = resolveServiceConfigPath({
    ...withConfigPath(options.configPath),
    cwd,
    env
  });
  const configPath = resolvedConfig.configPath;
  const errors: string[] = [];
  const warnings: string[] = [];
  const removedLabels: string[] = [];
  const result = (repository: string, ok = false): ClearStaleReport => ({
    configPath,
    errors,
    issueNumber: options.issueNumber,
    ok,
    project: options.project,
    removedLabels,
    repository,
    warnings
  });

  const rawConfig = await readConfig(configPath, errors);
  if (rawConfig === undefined) {
    if (resolvedConfig.source === "user" && !resolvedConfig.configExists) {
      errors.push(missingUserConfigHint(configPath));
    }
    return result("");
  }
  const parsedConfig = parseServiceConfig(rawConfig, errors);
  if (parsedConfig === undefined) {
    return result("");
  }

  const project = parsedConfig.projects.find(
    (entry) => entry.name === options.project
  );
  if (project === undefined) {
    errors.push(`projects.${options.project} not found in config`);
    return result("");
  }

  const repositoryName = `${project.tracker.owner}/${project.tracker.repo}`;
  const token = resolveEnvBackedValue(project.tracker.token, env);
  if (token === undefined) {
    const variableName = envReferenceName(project.tracker.token);
    errors.push(
      variableName === undefined
        ? `projects.${project.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
        : `projects.${project.name}.tracker.token references unset environment variable $${variableName}`
    );
    return result(repositoryName);
  }

  const githubApi = options.githubApi ?? DEFAULT_GITHUB_API;
  const repository = {
    owner: project.tracker.owner,
    repo: project.tracker.repo,
    token
  };
  const access = await githubApi.validateRepositoryAccess(repository);
  if (!access.ok) {
    errors.push(
      `projects.${project.name}.tracker.repository ${repositoryName} is not accessible: ${access.message ?? "unknown GitHub error"}`
    );
    return result(repositoryName);
  }

  const warning = `clear-stale ${options.yes === true ? "will" : "would"} remove ${STALE_CLEAR_LABELS.join(", ")} from ${repositoryName}#${options.issueNumber}`;
  warnings.push(warning);
  options.onWarning?.(warning);

  if (options.yes !== true) {
    errors.push("pass --yes to remove stale-claim labels non-interactively");
    return result(repositoryName);
  }

  if (githubApi.removeIssueLabel === undefined) {
    errors.push(
      `projects.${project.name}.tracker.repository ${repositoryName} GitHub adapter does not support removeIssueLabel`
    );
    return result(repositoryName);
  }

  let allOk = true;
  for (const label of STALE_CLEAR_LABELS) {
    try {
      await githubApi.removeIssueLabel({
        ...repository,
        issueNumber: options.issueNumber,
        name: label
      });
      removedLabels.push(label);
    } catch (error) {
      if (isOctokitNotFoundError(error)) {
        removedLabels.push(label);
        continue;
      }
      allOk = false;
      errors.push(
        `projects.${project.name}.tracker.repository ${repositoryName} could not remove label ${label} from issue ${options.issueNumber}: ${errorMessage(error)}`
      );
    }
  }

  return result(repositoryName, allOk);
}

function isOctokitNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status === 404;
}

class OctokitGitHubApi implements GitHubApi {
  async validateRepositoryAccess(
    input: GitHubRepositoryInput
  ): Promise<GitHubRepositoryAccess> {
    const octokit = this.octokit(input.token);

    try {
      await octokit.rest.repos.get({
        owner: input.owner,
        repo: input.repo
      });
      return { ok: true };
    } catch (error) {
      return {
        message: githubErrorMessage(error),
        ok: false
      };
    }
  }

  async listLabels(input: GitHubRepositoryInput): Promise<string[]> {
    const octokit = this.octokit(input.token);
    const labels = await octokit.paginate(
      octokit.rest.issues.listLabelsForRepo,
      {
        owner: input.owner,
        per_page: 100,
        repo: input.repo
      }
    );

    return labels.map((label) => label.name);
  }

  async createLabel(
    input: GitHubRepositoryInput & { name: string }
  ): Promise<void> {
    const octokit = this.octokit(input.token);
    const labelDescription = labelDescriptionFor(input.name);

    await octokit.rest.issues.createLabel({
      color: labelDescription.color,
      description: labelDescription.description,
      name: input.name,
      owner: input.owner,
      repo: input.repo
    });
  }

  async removeIssueLabel(
    input: GitHubRepositoryInput & { issueNumber: number; name: string }
  ): Promise<void> {
    const octokit = this.octokit(input.token);
    await octokit.rest.issues.removeLabel({
      issue_number: input.issueNumber,
      name: input.name,
      owner: input.owner,
      repo: input.repo
    });
  }

  private octokit(token: string): Octokit {
    return new Octokit({
      auth: token,
      log: SILENT_OCTOKIT_LOG
    });
  }
}

const DEFAULT_GITHUB_API = new OctokitGitHubApi();

async function readConfig(
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

function parseServiceConfig(
  rawConfig: unknown,
  errors: string[]
): ServiceConfig | undefined {
  const parsed = serviceConfigSchema.safeParse(rawConfig);

  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(formatZodIssue));
    return undefined;
  }

  return parsed.data;
}

function withConfigPath(configPath: string | undefined): {
  configPath?: string;
} {
  return configPath === undefined ? {} : { configPath };
}

async function validateProject(
  project: ProjectConfig,
  config: ServiceConfig,
  agentProviders: AgentProviderRegistry,
  env: NodeJS.ProcessEnv,
  errors: string[],
  githubApi: GitHubApi | undefined
): Promise<ProjectValidation> {
  const provider = config.providers[project.agent.provider];
  let validForDispatch = true;

  if (provider.command.trim().length === 0) {
    errors.push(
      `projects.${project.name}.agent.provider references ${project.agent.provider}, but its command is empty`
    );
    validForDispatch = false;
  }
  const providerAdapter = agentProviders[project.agent.provider];
  if (providerAdapter === undefined) {
    errors.push(
      `projects.${project.name}.agent.provider references ${project.agent.provider}, but no adapter is registered`
    );
    validForDispatch = false;
  } else {
    try {
      await providerAdapter.validate(provider.command);
    } catch (error) {
      errors.push(
        `projects.${project.name}.providers.${project.agent.provider}.command is invalid: ${errorMessage(error)}`
      );
      validForDispatch = false;
    }
  }

  const token = resolveEnvBackedValue(project.tracker.token, env);
  if (token === undefined) {
    const variableName = envReferenceName(project.tracker.token);
    if (variableName === undefined) {
      errors.push(
        `projects.${project.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
      );
    } else {
      errors.push(
        `projects.${project.name}.tracker.token references unset environment variable $${variableName}`
      );
    }
    return {
      missingEligibilityLabels: [],
      missingOperationalLabels: [],
      validForDispatch: false
    };
  }

  if (githubApi === undefined) {
    return {
      missingEligibilityLabels: [],
      missingOperationalLabels: [],
      validForDispatch
    };
  }

  const repository = {
    owner: project.tracker.owner,
    repo: project.tracker.repo,
    token
  };
  const access = await githubApi.validateRepositoryAccess(repository);
  if (!access.ok) {
    errors.push(
      `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} is not accessible: ${access.message ?? "unknown GitHub error"}`
    );
    return {
      missingEligibilityLabels: [],
      missingOperationalLabels: [],
      validForDispatch: false
    };
  }

  let labels: Set<string>;
  try {
    labels = new Set(await githubApi.listLabels(repository));
  } catch (error) {
    errors.push(
      `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} labels could not be listed: ${errorMessage(error)}`
    );
    return {
      missingEligibilityLabels: [],
      missingOperationalLabels: [],
      validForDispatch: false
    };
  }

  const missingEligibilityLabels = findMissingEligibilityLabels(
    project,
    labels
  );
  if (missingEligibilityLabels.length > 0) {
    errors.push(
      `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} is missing required eligibility labels: ${missingEligibilityLabels.join(", ")}`
    );
  }

  const missingOperationalLabels = REQUIRED_OPERATIONAL_LABELS.filter(
    (label) => !labels.has(label)
  );
  if (missingOperationalLabels.length > 0) {
    errors.push(
      `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} is missing operational labels: ${missingOperationalLabels.join(", ")}`
    );
  }

  return {
    missingEligibilityLabels,
    missingOperationalLabels,
    validForDispatch:
      validForDispatch &&
      missingEligibilityLabels.length === 0 &&
      missingOperationalLabels.length === 0
  };
}

function resolveEnvBackedValue(
  input: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const variableName = envReferenceName(input);
  if (variableName === undefined) {
    return undefined;
  }

  const value = env[variableName];
  return value === undefined || value.length === 0 ? undefined : value;
}

function findMissingEligibilityLabels(
  project: ProjectConfig,
  repositoryLabels: ReadonlySet<string>
): string[] {
  return [...new Set(project.issue_filters.labels_all)].filter(
    (label) => !repositoryLabels.has(label)
  );
}

function envReferenceName(input: string): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(input);
  return match?.[1];
}

function report(
  configPath: string,
  errors: string[],
  projects: DoctorProjectReport[]
): DoctorReport {
  return {
    configPath,
    errors,
    ok: errors.length === 0,
    projects
  };
}

function initProjectReport(
  configPath: string,
  errors: string[],
  warnings: string[],
  projects: InitProjectProjectReport[],
  createdWorkflowPath: string | null = null
): InitProjectReport {
  return {
    configPath,
    createdWorkflowPath,
    errors,
    ok: errors.length === 0,
    projects,
    warnings
  };
}

function formatZodIssue(issue: z.ZodIssue): string {
  const location =
    issue.path.length === 0 ? "service config" : issue.path.join(".");
  return `${location}: ${issue.message}`;
}

function labelDescriptionFor(name: string): LabelDescription {
  if (isOperationalLabel(name)) {
    return OPERATIONAL_LABEL_DESCRIPTIONS[name];
  }

  return {
    color: "1d76db",
    description: "Required for Symphonika dispatch eligibility."
  };
}

function isOperationalLabel(
  name: string
): name is (typeof REQUIRED_OPERATIONAL_LABELS)[number] {
  return (REQUIRED_OPERATIONAL_LABELS as readonly string[]).includes(name);
}

function githubErrorMessage(error: unknown): string {
  if (error instanceof Error && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return `${error.message} (HTTP ${status})`;
    }
  }

  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
