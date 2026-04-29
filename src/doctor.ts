import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export type DoctorOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type DoctorProjectReport = {
  name: string;
  workflowPath: string;
};

export type DoctorReport = {
  configPath: string;
  errors: string[];
  ok: boolean;
  projects: DoctorProjectReport[];
};

type ServiceConfig = z.infer<typeof serviceConfigSchema>;
type ProjectConfig = z.infer<typeof projectSchema>;

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
        labels: z.record(z.number().int().nonnegative()),
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

const allowedTemplateFields: Record<string, ReadonlySet<string>> = {
  branch: new Set(["name"]),
  issue: new Set([
    "body",
    "created_at",
    "id",
    "labels",
    "number",
    "priority",
    "state",
    "title",
    "updated_at",
    "url"
  ]),
  project: new Set(["name"]),
  provider: new Set(["command", "name"]),
  run: new Set(["attempt", "continuation", "id"]),
  workspace: new Set(["path", "root"])
};

const serviceDiscoveryFrontMatterKeys = new Set([
  "agent",
  "issue_filters",
  "priority",
  "projects",
  "provider",
  "providers",
  "tracker",
  "workflow",
  "workspace"
]);

export async function runDoctor(
  options: DoctorOptions = {}
): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath ?? "symphonika.yml");
  const env = options.env ?? process.env;
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
    validateProject(project, parsedConfig, env, errors);
    const workflowPath = path.resolve(path.dirname(configPath), project.workflow);
    const workflowErrors = await validateWorkflowContract(workflowPath);
    errors.push(...workflowErrors);
    projects.push({
      name: project.name,
      workflowPath
    });
  }

  return report(configPath, errors, projects);
}

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

function validateProject(
  project: ProjectConfig,
  config: ServiceConfig,
  env: NodeJS.ProcessEnv,
  errors: string[]
): void {
  const provider = config.providers[project.agent.provider];
  if (provider.command.trim().length === 0) {
    errors.push(
      `projects.${project.name}.agent.provider references ${project.agent.provider}, but its command is empty`
    );
  }

  if (resolveEnvBackedValue(project.tracker.token, env) === undefined) {
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
  }
}

async function validateWorkflowContract(
  workflowPath: string
): Promise<string[]> {
  const errors: string[] = [];
  let contents: string;

  try {
    contents = await readFile(workflowPath, "utf8");
  } catch (error) {
    return [`workflow contract not found at ${workflowPath}: ${errorMessage(error)}`];
  }

  const workflow = parseWorkflowContract(contents, workflowPath);
  errors.push(...workflow.errors);

  if (workflow.body.trim().length === 0) {
    errors.push(`workflow contract at ${workflowPath} must not be empty`);
  }

  errors.push(...validateTemplateVariables(workflow.body, workflowPath));
  return errors;
}

function parseWorkflowContract(
  contents: string,
  workflowPath: string
): { body: string; errors: string[] } {
  const lines = contents.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return { body: contents, errors: [] };
  }

  const closingLine = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---"
  );
  if (closingLine === -1) {
    return {
      body: "",
      errors: [`workflow front matter at ${workflowPath} is missing a closing ---`]
    };
  }

  const frontMatterSource = lines.slice(1, closingLine).join("\n");
  const errors: string[] = [];
  const frontMatter = parseFrontMatter(frontMatterSource, workflowPath, errors);

  if (frontMatter !== undefined) {
    for (const key of Object.keys(frontMatter)) {
      if (serviceDiscoveryFrontMatterKeys.has(key)) {
        errors.push(
          `workflow front matter at ${workflowPath} must not define service config key ${key}`
        );
      }
    }
  }

  return {
    body: lines.slice(closingLine + 1).join("\n"),
    errors
  };
}

function parseFrontMatter(
  source: string,
  workflowPath: string,
  errors: string[]
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parse(source) ?? {};
    if (isRecord(parsed)) {
      return parsed;
    }
    errors.push(`workflow front matter at ${workflowPath} must be a mapping`);
    return undefined;
  } catch (error) {
    errors.push(
      `workflow front matter at ${workflowPath} could not be parsed: ${errorMessage(error)}`
    );
    return undefined;
  }
}

function validateTemplateVariables(
  template: string,
  workflowPath: string
): string[] {
  const errors: string[] = [];
  const tagPattern = /{{\s*([^{}]+?)\s*}}/g;

  for (const match of template.matchAll(tagPattern)) {
    const expression = match[1]?.trim() ?? "";
    const parts = expression.split(".");
    const topLevel = parts[0];

    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(expression)) {
      errors.push(
        `workflow template at ${workflowPath} has unsupported tag {{${expression}}}`
      );
      continue;
    }

    if (topLevel === undefined || !(topLevel in allowedTemplateFields)) {
      errors.push(
        `workflow template at ${workflowPath} references unknown variable {{${expression}}}`
      );
      continue;
    }

    const field = parts[1];
    if (field !== undefined && !allowedTemplateFields[topLevel]!.has(field)) {
      errors.push(
        `workflow template at ${workflowPath} references unknown variable {{${expression}}}`
      );
    }
  }

  return errors;
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

function formatZodIssue(issue: z.ZodIssue): string {
  const location = issue.path.length === 0 ? "service config" : issue.path.join(".");
  return `${location}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
