import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";

import type { WorkflowFormat } from "./config-schemas.js";
import {
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

export type RuntimeConfigSnapshot = {
  configPath: string;
  loadedAt: string;
  polling: PollingServiceConfig;
  pollingIntervalMs: number;
  projects: RunControllerProjectConfig[];
  providers: RunControllerProvidersConfig;
  pullRequestPolicy: PullRequestFollowupPolicy;
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

const providerNameSchema = z.enum(["codex", "claude"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .passthrough();

const pollingProjectSchema = z
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
  const dispatchProjects: RunControllerProjectConfig[] = [];

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
      dispatchProjects.push({
        ...pollingProject.data,
        workflow: detail.data.workflow,
        workspace: detail.data.workspace
      });
      continue;
    }

    const workflow = await readWorkflowSnapshot(
      path.resolve(input.configDir, detail.data.workflow.path),
      detail.data.workflow.format,
      errors
    );
    if (workflow === undefined) {
      return lastKnownGoodOrNothing(input.previous, errors);
    }
    dispatchProjects.push({
      ...pollingProject.data,
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
        pullRequestFollowupPolicyFromRaw(raw) ?? DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY
    },
    usingLastKnownGood: false
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

async function readWorkflowSnapshot(
  workflowPath: string,
  format: WorkflowFormat,
  errors: string[]
): Promise<WorkflowSnapshot | undefined> {
  let contents: string;
  try {
    contents = await readFile(workflowPath, "utf8");
  } catch (error) {
    errors.push(`workflow contract not found at ${workflowPath}: ${errorMessage(error)}`);
    return undefined;
  }

  const expanded = await expandWorkflowDefinition(contents, workflowPath, format);
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
      expandedWorkflow: expanded.workflow,
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
    expandedWorkflow: expanded.workflow,
    path: workflow.path
  };
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
        "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"
    },
    codex: {
      command:
        "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"
    }
  };
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
