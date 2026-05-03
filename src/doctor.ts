import { readFile } from "node:fs/promises";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { parse } from "yaml";
import { z } from "zod";

import {
  DEFAULT_GITHUB_ISSUES_API,
  type GitHubIssuesApi
} from "./issue-polling.js";
import { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";
import type { AgentProviderRegistry } from "./provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import { validateWorkflowContract } from "./workflow.js";

export { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";

export type DoctorOptions = {
  agentProviders?: AgentProviderRegistry;
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  githubApi?: GitHubApi;
  githubIssuesApi?: GitHubIssuesApi;
};

export type StaleIssueSummary = {
  number: number;
  title: string;
  url: string;
};

export type DoctorProjectReport = {
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
  onWarning?: (warning: string) => void;
  yes?: boolean;
};

export type InitProjectProjectReport = {
  createdOperationalLabels: string[];
  missingOperationalLabels: string[];
  name: string;
  repository: string;
};

export type InitProjectReport = {
  configPath: string;
  errors: string[];
  ok: boolean;
  projects: InitProjectProjectReport[];
  warnings: string[];
};

export type GitHubRepositoryInput = {
  owner: string;
  repo: string;
  token: string;
};

export type GitHubRepositoryAccess = {
  message?: string;
  ok: boolean;
};

export type GitHubApi = {
  createLabel: (input: GitHubRepositoryInput & { name: string }) => Promise<void>;
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
  "missingOperationalLabels" | "validForDispatch"
>;
type LabelDescription = {
  color: string;
  description: string;
};

const OPERATIONAL_LABEL_DESCRIPTIONS: Record<
  (typeof REQUIRED_OPERATIONAL_LABELS)[number],
  LabelDescription
> = {
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
const pathStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), "path must not contain NUL bytes");

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
    workspace: z
      .object({
        root: pathStringSchema,
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
    workflow: pathStringSchema
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
  const configPath = path.resolve(cwd, options.configPath ?? "symphonika.yml");
  const env = options.env ?? process.env;
  const githubApi = options.githubApi ?? DEFAULT_GITHUB_API;
  const githubIssuesApi = options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const agentProviders = options.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
  const errors: string[] = [];
  const projects: DoctorProjectReport[] = [];
  const rawConfig = await readConfig(configPath, errors);

  if (rawConfig === undefined) {
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
    const workflowPath = path.resolve(path.dirname(configPath), project.workflow);
    const workflowErrors = await validateWorkflowContract(workflowPath);
    errors.push(...workflowErrors);
    const staleIssues = await fetchStaleIssues(
      project,
      env,
      githubIssuesApi
    );
    projects.push({
      ...validation,
      name: project.name,
      staleIssues,
      workflowPath
    });
  }

  return report(configPath, errors, projects);
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
  const configPath = path.resolve(cwd, options.configPath ?? "symphonika.yml");
  const env = options.env ?? process.env;
  const errors: string[] = [];
  const warnings: string[] = [];
  const projects: InitProjectProjectReport[] = [];
  const rawConfig = await readConfig(configPath, errors);

  if (rawConfig === undefined) {
    return initProjectReport(configPath, errors, warnings, projects);
  }

  const parsedConfig = parseServiceConfig(rawConfig, errors);
  if (parsedConfig === undefined) {
    return initProjectReport(configPath, errors, warnings, projects);
  }

  const githubApi = options.githubApi ?? DEFAULT_GITHUB_API;

  for (const project of parsedConfig.projects) {
    const token = resolveEnvBackedValue(project.tracker.token, env);
    if (token === undefined) {
      const variableName = envReferenceName(project.tracker.token);
      errors.push(
        variableName === undefined
          ? `projects.${project.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
          : `projects.${project.name}.tracker.token references unset environment variable $${variableName}`
      );
      continue;
    }

    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };
    const repositoryName = `${project.tracker.owner}/${project.tracker.repo}`;
    const access = await githubApi.validateRepositoryAccess(repository);
    if (!access.ok) {
      errors.push(
        `projects.${project.name}.tracker.repository ${repositoryName} is not accessible: ${access.message ?? "unknown GitHub error"}`
      );
      continue;
    }

    let labels: Set<string>;
    try {
      labels = new Set(await githubApi.listLabels(repository));
    } catch (error) {
      errors.push(
        `projects.${project.name}.tracker.repository ${repositoryName} labels could not be listed: ${errorMessage(error)}`
      );
      continue;
    }

    const missingOperationalLabels = REQUIRED_OPERATIONAL_LABELS.filter(
      (label) => !labels.has(label)
    );
    const createdOperationalLabels: string[] = [];

    if (missingOperationalLabels.length > 0) {
      const warning = `init-project ${options.yes === true ? "will" : "would"} create operational labels in ${repositoryName}: ${missingOperationalLabels.join(", ")}`;
      warnings.push(warning);
      options.onWarning?.(warning);

      if (options.yes !== true) {
        errors.push(
          "pass --yes to create missing operational labels non-interactively"
        );
      } else {
        for (const label of missingOperationalLabels) {
          try {
            await githubApi.createLabel({
              ...repository,
              name: label
            });
            createdOperationalLabels.push(label);
          } catch (error) {
            errors.push(
              `projects.${project.name}.tracker.repository ${repositoryName} could not create operational label ${label}: ${errorMessage(error)}`
            );
          }
        }
      }
    }

    projects.push({
      createdOperationalLabels,
      missingOperationalLabels,
      name: project.name,
      repository: repositoryName
    });
  }

  return initProjectReport(configPath, errors, warnings, projects);
}

const STALE_CLEAR_LABELS = ["sym:stale", "sym:claimed"] as const;

export async function runClearStale(
  options: ClearStaleOptions
): Promise<ClearStaleReport> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath ?? "symphonika.yml");
  const env = options.env ?? process.env;
  const errors: string[] = [];
  const warnings: string[] = [];
  const removedLabels: string[] = [];
  const result = (
    repository: string,
    ok = false
  ): ClearStaleReport => ({
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
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      owner: input.owner,
      per_page: 100,
      repo: input.repo
    });

    return labels.map((label) => label.name);
  }

  async createLabel(
    input: GitHubRepositoryInput & { name: string }
  ): Promise<void> {
    const octokit = this.octokit(input.token);
    const labelDescription = operationalLabelDescription(input.name);

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
    errors.push(`service config not found at ${configPath}: ${errorMessage(error)}`);
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
      missingOperationalLabels: [],
      validForDispatch: false
    };
  }

  if (githubApi === undefined) {
    return {
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
      missingOperationalLabels: [],
      validForDispatch: false
    };
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
    missingOperationalLabels,
    validForDispatch: validForDispatch && missingOperationalLabels.length === 0
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
  projects: InitProjectProjectReport[]
): InitProjectReport {
  return {
    configPath,
    errors,
    ok: errors.length === 0,
    projects,
    warnings
  };
}

function formatZodIssue(issue: z.ZodIssue): string {
  const location = issue.path.length === 0 ? "service config" : issue.path.join(".");
  return `${location}: ${issue.message}`;
}

function operationalLabelDescription(name: string): LabelDescription {
  if (isOperationalLabel(name)) {
    return OPERATIONAL_LABEL_DESCRIPTIONS[name];
  }

  return {
    color: "6a737d",
    description: "Symphonika operational label."
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
