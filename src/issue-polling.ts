import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { parse } from "yaml";
import { z } from "zod";

import { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";

export type GitHubIssueRepositoryInput = {
  owner: string;
  repo: string;
  token: string;
};

export type GitHubIssueLabelInput = GitHubIssueRepositoryInput & {
  issueNumber: number;
  labels: string[];
};

export type RawGitHubIssue = {
  body?: string | null;
  created_at?: string | null;
  html_url?: string | null;
  id?: number;
  labels?: unknown[];
  number?: number;
  pull_request?: unknown;
  state?: string;
  title?: string;
  updated_at?: string | null;
  url?: string | null;
};

export type GitHubIssuesApi = {
  addLabelsToIssue?: (input: GitHubIssueLabelInput) => Promise<void>;
  listOpenIssues: (
    input: GitHubIssueRepositoryInput
  ) => Promise<RawGitHubIssue[]>;
  removeLabelsFromIssue?: (input: GitHubIssueLabelInput) => Promise<void>;
};

export type IssueSnapshot = {
  body: string;
  created_at: string;
  id: number;
  labels: string[];
  number: number;
  priority: number;
  state: string;
  title: string;
  updated_at: string;
  url: string;
};

export type ProjectIssueSnapshot = {
  issue: IssueSnapshot;
  project: string;
};

export type FilteredProjectIssueSnapshot = ProjectIssueSnapshot & {
  reasons: string[];
};

export type ProjectIssuePollReport = {
  fetchedIssues: number;
  name: string;
  ok: boolean;
  error?: string;
};

export type IssuePollStatus = {
  candidateIssues: ProjectIssueSnapshot[];
  errors: string[];
  filteredIssues: FilteredProjectIssueSnapshot[];
  projects: ProjectIssuePollReport[];
};

export type PollConfiguredGitHubIssuesOptions = {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi?: GitHubIssuesApi;
};

type PollingProjectConfig = z.infer<typeof pollingProjectSchema>;
type PollingServiceConfig = {
  polling?: {
    interval_ms?: number | undefined;
  };
  projects: PollingProjectConfig[];
};

const providerNameSchema = z.enum(["codex", "claude"]);

const pollingProjectSchema = z
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
    agent: z
      .object({
        provider: providerNameSchema
      })
      .passthrough()
  })
  .passthrough();

const pollingServiceConfigSchema = z
  .object({
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional()
      })
      .passthrough()
      .optional(),
    projects: z.array(z.unknown()).min(1)
  })
  .passthrough();

const SILENT_OCTOKIT_LOG = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

class OctokitGitHubIssuesApi implements GitHubIssuesApi {
  async addLabelsToIssue(input: GitHubIssueLabelInput): Promise<void> {
    const octokit = this.octokit(input.token);
    await octokit.rest.issues.addLabels({
      issue_number: input.issueNumber,
      labels: input.labels,
      owner: input.owner,
      repo: input.repo
    });
  }

  async listOpenIssues(
    input: GitHubIssueRepositoryInput
  ): Promise<RawGitHubIssue[]> {
    const octokit = this.octokit(input.token);
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner: input.owner,
      per_page: 100,
      repo: input.repo,
      state: "open"
    });

    return issues;
  }

  async removeLabelsFromIssue(input: GitHubIssueLabelInput): Promise<void> {
    const octokit = this.octokit(input.token);
    for (const label of input.labels) {
      await octokit.rest.issues.removeLabel({
        issue_number: input.issueNumber,
        name: label,
        owner: input.owner,
        repo: input.repo
      });
    }
  }

  private octokit(token: string): Octokit {
    return new Octokit({
      auth: token,
      log: SILENT_OCTOKIT_LOG
    });
  }
}

export const DEFAULT_GITHUB_ISSUES_API = new OctokitGitHubIssuesApi();
export const DEFAULT_POLLING_INTERVAL_MS = 30_000;

export function emptyIssuePollStatus(): IssuePollStatus {
  return {
    candidateIssues: [],
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

export function replaceIssuePollStatus(
  target: IssuePollStatus,
  source: IssuePollStatus
): void {
  target.candidateIssues = source.candidateIssues;
  target.errors = source.errors;
  target.filteredIssues = source.filteredIssues;
  target.projects = source.projects;
}

export async function readConfiguredPollingIntervalMs(
  configPath: string
): Promise<number> {
  const config = await readPollingConfig(configPath, []);
  return config?.polling?.interval_ms ?? DEFAULT_POLLING_INTERVAL_MS;
}

export async function pollConfiguredGitHubIssues(
  options: PollConfiguredGitHubIssuesOptions
): Promise<IssuePollStatus> {
  const env = options.env ?? process.env;
  const githubIssuesApi = options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const status = emptyIssuePollStatus();
  const config = await readPollingConfig(options.configPath, status.errors);

  if (config === undefined) {
    return status;
  }

  for (const project of config.projects) {
    if (project.disabled === true) {
      continue;
    }

    await pollProject(project, env, githubIssuesApi, status);
  }

  status.candidateIssues.sort(compareProjectIssues);
  status.filteredIssues.sort(compareProjectIssues);

  return status;
}

async function pollProject(
  project: PollingProjectConfig,
  env: NodeJS.ProcessEnv,
  githubIssuesApi: GitHubIssuesApi,
  status: IssuePollStatus
): Promise<void> {
  const token = resolveEnvBackedValue(project.tracker.token, env);
  if (token === undefined) {
    const variableName = envReferenceName(project.tracker.token);
    const error =
      variableName === undefined
        ? `projects.${project.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
        : `projects.${project.name}.tracker.token references unset environment variable $${variableName}`;
    status.errors.push(error);
    status.projects.push({
      error,
      fetchedIssues: 0,
      name: project.name,
      ok: false
    });
    return;
  }

  let rawIssues: RawGitHubIssue[];
  try {
    rawIssues = await githubIssuesApi.listOpenIssues({
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    });
  } catch (error) {
    const message = `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} issues could not be listed: ${errorMessage(error)}`;
    status.errors.push(message);
    status.projects.push({
      error: message,
      fetchedIssues: 0,
      name: project.name,
      ok: false
    });
    return;
  }

  let fetchedIssues = 0;
  for (const rawIssue of rawIssues) {
    if (rawIssue.pull_request !== undefined) {
      continue;
    }

    fetchedIssues += 1;
    const issue = normalizeIssueSnapshot(rawIssue, project);
    const reasons = issueFilterReasons(issue, project);

    if (reasons.length === 0) {
      status.candidateIssues.push({
        issue,
        project: project.name
      });
      continue;
    }

    status.filteredIssues.push({
      issue,
      project: project.name,
      reasons
    });
  }

  status.projects.push({
    fetchedIssues,
    name: project.name,
    ok: true
  });
}

async function readPollingConfig(
  configPath: string,
  errors: string[]
): Promise<PollingServiceConfig | undefined> {
  let contents: string;

  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    errors.push(`service config not found at ${configPath}: ${errorMessage(error)}`);
    return undefined;
  }

  let rawConfig: unknown;
  try {
    rawConfig = parse(contents) ?? {};
  } catch (error) {
    errors.push(`service config could not be parsed: ${errorMessage(error)}`);
    return undefined;
  }

  const parsed = pollingServiceConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(formatZodIssue));
    return undefined;
  }

  const projects: PollingProjectConfig[] = [];
  parsed.data.projects.forEach((rawProject, index) => {
    const parsedProject = pollingProjectSchema.safeParse(rawProject);
    if (parsedProject.success) {
      projects.push(parsedProject.data);
      return;
    }

    errors.push(
      ...parsedProject.error.issues.map((issue) =>
        formatZodIssueWithPrefix(issue, ["projects", String(index)])
      )
    );
  });

  const config: PollingServiceConfig = {
    projects
  };
  if (parsed.data.polling !== undefined) {
    config.polling = parsed.data.polling;
  }

  return config;
}

function normalizeIssueSnapshot(
  rawIssue: RawGitHubIssue,
  project: PollingProjectConfig
): IssueSnapshot {
  const labels = normalizeLabels(rawIssue.labels ?? []);

  return {
    body: rawIssue.body ?? "",
    created_at: rawIssue.created_at ?? "",
    id: rawIssue.id ?? 0,
    labels,
    number: rawIssue.number ?? 0,
    priority: priorityForLabels(labels, project),
    state: rawIssue.state ?? "open",
    title: rawIssue.title ?? "",
    updated_at: rawIssue.updated_at ?? "",
    url: rawIssue.html_url ?? rawIssue.url ?? ""
  };
}

function normalizeLabels(labels: unknown[]): string[] {
  const normalized: string[] = [];

  for (const label of labels) {
    if (typeof label === "string") {
      normalized.push(label);
      continue;
    }

    if (isRecord(label) && typeof label.name === "string") {
      normalized.push(label.name);
    }
  }

  return normalized;
}

function priorityForLabels(
  labels: string[],
  project: PollingProjectConfig
): number {
  const priorities = labels.flatMap((label) => {
    const priority = project.priority.labels[label];
    return priority === undefined ? [] : [priority];
  });

  return priorities.length === 0 ? project.priority.default : Math.min(...priorities);
}

function issueFilterReasons(
  issue: IssueSnapshot,
  project: PollingProjectConfig
): string[] {
  const reasons: string[] = [];
  const labels = new Set(issue.labels);

  if (!project.issue_filters.states.includes("open") || issue.state !== "open") {
    reasons.push(`state ${issue.state} is not eligible`);
  }

  for (const requiredLabel of project.issue_filters.labels_all) {
    if (!labels.has(requiredLabel)) {
      reasons.push(`missing required label ${requiredLabel}`);
    }
  }

  for (const excludedLabel of project.issue_filters.labels_none) {
    if (labels.has(excludedLabel)) {
      reasons.push(`has excluded label ${excludedLabel}`);
    }
  }

  for (const operationalLabel of REQUIRED_OPERATIONAL_LABELS) {
    if (labels.has(operationalLabel)) {
      reasons.push(`has operational label ${operationalLabel}`);
    }
  }

  return reasons;
}

function compareProjectIssues(
  left: ProjectIssueSnapshot,
  right: ProjectIssueSnapshot
): number {
  return (
    left.project.localeCompare(right.project) ||
    left.issue.priority - right.issue.priority ||
    left.issue.created_at.localeCompare(right.issue.created_at) ||
    left.issue.number - right.issue.number
  );
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

function formatZodIssue(issue: z.ZodIssue): string {
  const location = issue.path.length === 0 ? "service config" : issue.path.join(".");
  return `${location}: ${issue.message}`;
}

function formatZodIssueWithPrefix(
  issue: z.ZodIssue,
  prefix: string[]
): string {
  const location = [...prefix, ...issue.path].join(".");
  return `${location}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
