import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Octokit } from "@octokit/rest";
import { isSeq, parse, parseDocument } from "yaml";
import { z } from "zod";

import type { WorkflowFormat } from "./config-schemas.js";
import {
  pathStringSchema,
  projectDispatchSchema,
  projectWorkspaceSchema,
  rejectDispatchOnlyKeysOnRoutineHost,
  workflowReferenceSchema
} from "./config-schemas.js";
import {
  missingUserConfigHint,
  resolveServiceConfigPath
} from "./config-paths.js";
import {
  defaultWorkflowContract,
  inspectCurrentGitHubProject,
  inspectCurrentGitProject,
  type GitHubProjectMetadata,
  type GitProjectMetadata,
  type InitProvider
} from "./init.js";
import {
  DEFAULT_GITHUB_ISSUES_API,
  type GitHubIssuesApi
} from "./issue-polling.js";
import { emailNotificationConfigSchema } from "./notifications/config.js";
import { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";
import type { AgentProviderName, AgentProviderRegistry } from "./provider.js";
import { renderProviderCommandTemplate } from "./provider-command-template.js";
import { probeProviderCommand } from "./provider-probe.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import { loadRoutineDeclaration } from "./routines/declaration-loader.js";
import type { RoutineExecutionOverrides } from "./routines/types.js";
import { userUnitDir } from "./service.js";
import { resolveStateRoot } from "./state.js";
import type { ExpandedWorkflow } from "./workflow/types.js";
import {
  loadExpandedWorkflow,
  resolveWorkflowFormat,
  validateExpandedWorkflowReferences
} from "./workflow/fsm-expansion.js";

export { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";

export type DoctorOptions = {
  agentProviders?: AgentProviderRegistry;
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  githubApi?: GitHubApi;
  githubIssuesApi?: GitHubIssuesApi;
  homeDir?: string;
  // Opt-in: spawns providers.<name>.command for real with a trivial prompt
  // and waits for a reply, instead of only the static protocol checks every
  // doctor run already does. Not run by default — it is a real billed call
  // that can take tens of seconds. See probeProviderCommand.
  liveCheckProvider?: AgentProviderName;
  liveCheckTimeoutMs?: number;
};

type DoctorLiveCheckReport = {
  detail: string;
  ok: boolean;
  provider: AgentProviderName;
};

type StaleIssueSummary = {
  number: number;
  title: string;
  url: string;
};

export type DoctorProjectReport = {
  missingEligibilityLabels: string[];
  missingOperationalLabels: string[];
  mode: "dispatch" | "routine_host";
  name: string;
  staleIssues: StaleIssueSummary[];
  // Dispatch Projects: repo access + Operational Labels + Eligibility Labels
  // + provider. Routine Hosts: provider + workspace only — no GitHub/label
  // checks. A host reports validForDispatch=false (it never dispatches) and
  // validForHosting=true when its provider+workspace resolve. See ADR 0062.
  validForDispatch: boolean;
  validForHosting: boolean;
  // Dispatch Projects only. A Routine Host has no workflow contract.
  workflowPath?: string;
};

export type DoctorReport = {
  configPath: string;
  errors: string[];
  liveCheck?: DoctorLiveCheckReport;
  ok: boolean;
  projects: DoctorProjectReport[];
  warnings: string[];
};

export type InitProjectOptions = DoctorOptions & {
  force?: boolean;
  mode?: "dispatch" | "routine_host";
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
    | "workspaceRoot"
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
  listIssueNumbersByLabel?: (
    input: GitHubRepositoryInput & { label: string }
  ) => Promise<number[]>;
  listLabels: (input: GitHubRepositoryInput) => Promise<string[]>;
  removeIssueLabel?: (
    input: GitHubRepositoryInput & { issueNumber: number; name: string }
  ) => Promise<void>;
  validateRepositoryAccess: (
    input: GitHubRepositoryInput
  ) => Promise<GitHubRepositoryAccess>;
};

export type ClearStaleOptions = DoctorOptions & {
  onWarning?: (warning: string) => void;
  project: string;
  yes?: boolean;
} & ({ all: true; issueNumber?: never } | { all?: false; issueNumber: number });

type ClearStaleIssueOutcome = {
  errors: string[];
  issueNumber: number;
  removedLabels: string[];
  status: "already-removed" | "cleared" | "error";
};

export type ClearStaleReport = {
  configPath: string;
  errors: string[];
  ok: boolean;
  outcomes: ClearStaleIssueOutcome[];
  project: string;
  repository: string;
  warnings: string[];
};

type ServiceConfig = z.infer<typeof serviceConfigSchema>;
type ProjectConfig = z.infer<typeof projectSchema>;
type DispatchProjectConfig = Extract<ProjectConfig, { mode: "dispatch" }>;
type RoutineHostProjectConfig = Extract<
  ProjectConfig,
  { mode: "routine_host" }
>;
type ProjectValidation = Pick<
  DoctorProjectReport,
  | "missingEligibilityLabels"
  | "missingOperationalLabels"
  | "validForDispatch"
  | "validForHosting"
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
  "sym:human-needed": {
    color: "b60205",
    description:
      "A Symphonika run hit a terminal state that needs human attention."
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

const providerNameSchema = z.enum(["codex", "claude", "omp"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
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

// Explicitly reject the removed per-project `routines:` key so a legacy config
// fails loudly with a migration pointer instead of silently stopping firing.
// See ADR 0069.
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

const dispatchProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: z.literal("dispatch").default("dispatch"),
    disabled: z.boolean().optional(),
    weight: z.number().int().positive().optional(),
    dispatch: projectDispatchSchema.optional(),
    tracker: trackerSchema,
    issue_filters: issueFiltersSchema,
    priority: prioritySchema,
    workspace: projectWorkspaceSchema,
    agent: agentSchema,
    workflow: workflowReferenceSchema
  })
  .passthrough()
  .superRefine(rejectPerProjectRoutines);

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

const projectSchema = z.union([
  dispatchProjectSchema,
  routineHostProjectSchema
]);

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

const routineExecutionDefaultsSchema = z
  .object({
    effort: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    permission_mode: z.string().trim().min(1).optional(),
    timeout_minutes: z.number().positive().optional()
  })
  .strict();

const serviceConfigSchema = z
  .object({
    email: emailNotificationConfigSchema.optional(),
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
        claude: providerCommandSchema,
        omp: providerCommandSchema.optional()
      })
      .passthrough(),
    routine_defaults: routineExecutionDefaultsSchema.optional(),
    routines: z.array(serviceRoutineSchema).optional(),
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
  const warnings = await checkInstalledUnitDrift(
    options.homeDir ?? homedir(),
    env
  );
  const rawConfig = await readConfig(configPath, errors);

  if (rawConfig === undefined) {
    if (resolvedConfig.source === "user" && !resolvedConfig.configExists) {
      errors.push(missingUserConfigHint(configPath));
    }
    return report(configPath, errors, projects, warnings);
  }

  const parsedConfig = parseServiceConfig(rawConfig, errors);
  if (parsedConfig === undefined) {
    return report(configPath, errors, projects, warnings);
  }

  const email = parsedConfig.email;
  if (
    email?.smtpUsername !== undefined &&
    (env[email.smtpPasswordEnv]?.trim().length ?? 0) === 0
  ) {
    errors.push(
      `email.smtp_password_env references $${email.smtpPasswordEnv}, but it is not set; for a manual run, load the daemon's env file first (for example: set -a; . /path/to/symphonika.env; set +a)`
    );
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
    if (project.mode === "routine_host") {
      // A Routine Host has no workflow, no issue polling, no sym:* label
      // requirements. Only provider + workspace checks apply (see
      // validateProject). No stale issues — it owns no issues.
      projects.push({
        ...validation,
        mode: "routine_host",
        name: project.name,
        staleIssues: []
      });
      continue;
    }
    const workflowPath = path.resolve(
      path.dirname(configPath),
      project.workflow.path
    );
    const workflowErrors = await collectWorkflowErrors(
      workflowPath,
      project.workflow.format,
      project,
      parsedConfig,
      agentProviders
    );
    errors.push(...workflowErrors);
    const staleIssues = await fetchStaleIssues(project, env, githubIssuesApi);
    projects.push({
      ...validation,
      mode: "dispatch",
      name: project.name,
      staleIssues,
      workflowPath
    });
  }

  // Service-level routine declarations (top-level `routines:` block). Replaces
  // the removed per-project `routines:` key. Validates each declaration with
  // its target: global name uniqueness, known target project, and the
  // kind:git+tracker-less-host invariant (which flips the host's
  // validForHosting false, not just report.ok). See ADR 0062 / 0063.
  errors.push(
    ...(await validateServiceRoutines(
      (parsedConfig.routines ?? []).map((entry) => ({
        projectNames: entry.projects,
        sourcePath: path.resolve(path.dirname(configPath), entry.path)
      })),
      parsedConfig.projects,
      projects,
      parsedConfig.providers,
      agentProviders,
      routineDefaultsFromParsed(parsedConfig.routine_defaults)
    ))
  );

  const liveCheck = await runLiveCheck(
    options.liveCheckProvider,
    options.liveCheckTimeoutMs,
    parsedConfig.providers,
    agentProviders,
    errors
  );

  return report(configPath, errors, projects, warnings, liveCheck);
}

async function runLiveCheck(
  providerName: AgentProviderName | undefined,
  timeoutMs: number | undefined,
  providers: { [name in AgentProviderName]?: { command: string } | undefined },
  agentProviders: AgentProviderRegistry,
  errors: string[]
): Promise<DoctorLiveCheckReport | undefined> {
  if (providerName === undefined) {
    return undefined;
  }

  const providerConfig = providers[providerName];
  if (providerConfig === undefined) {
    errors.push(
      `--live-check ${providerName} requested, but providers.${providerName}.command is not configured`
    );
    return undefined;
  }

  const adapter = agentProviders[providerName];
  if (adapter === undefined) {
    errors.push(
      `--live-check ${providerName} requested, but no adapter is registered`
    );
    return undefined;
  }

  const probe = await probeProviderCommand({
    command: providerConfig.command,
    provider: adapter,
    providerName,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  if (!probe.ok) {
    errors.push(`--live-check ${providerName} failed: ${probe.detail}`);
  }
  return { detail: probe.detail, ok: probe.ok, provider: providerName };
}

// Detects an installed unit that predates a systemd-unit-shape change (the
// daemon/provider cgroup split, docs/adr/0064; or the watchdog heartbeat,
// docs/adr/0065) so operators learn to re-run `service install --force`
// instead of silently running on stale units indefinitely. Skips entirely
// when no unit is installed at all (`service install` was never run) —
// that's not a doctor concern. `ExecStart`/`Environment=PATH` are baked in
// at install time from the operator's own environment, so the `.service`
// file can't be regenerated and byte-compared generically; only structural
// markers (Slice=, Type=notify) are checked there. The `.slice` files are
// also checked structurally because their resource-limit values are
// operator-customizable (README.md).
async function checkInstalledUnitDrift(
  homeDir: string,
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  const unitDir = userUnitDir(homeDir, env);
  const servicePath = path.join(unitDir, "symphonika.service");
  const serviceContent = await readFileIfExists(servicePath);
  if (serviceContent === undefined) {
    return [];
  }

  const warnings: string[] = [];
  // `--force` only rewrites unit files and runs `systemctl --user
  // daemon-reload` (see runServiceInstall/defaultReload in service.ts) --
  // it never restarts an already-running daemon, which keeps its old unit
  // (and lacks whatever protection this drift check is warning about) until
  // an operator separately restarts it.
  const reinstallHint =
    "re-run `symphonika service install --force` to refresh it; a running " +
    "daemon only picks up the change after `systemctl --user restart " +
    "symphonika.service`";
  if (!serviceContent.includes("Slice=symphonika-daemon.slice")) {
    warnings.push(
      `${servicePath} predates the daemon/provider cgroup split (docs/adr/0064) — ${reinstallHint}`
    );
  }
  if (
    !/^[ \t]*Type[ \t]*=[ \t]*notify[ \t]*$/m.test(serviceContent) ||
    !serviceContent.includes("NotifyAccess=all") ||
    !/^WatchdogSec=/m.test(serviceContent) ||
    !/^TimeoutStartSec=/m.test(serviceContent)
  ) {
    warnings.push(
      `${servicePath} predates the systemd watchdog heartbeat (docs/adr/0065) — ${reinstallHint}`
    );
  }

  warnings.push(
    ...(await checkSliceDrift(
      path.join(unitDir, "symphonika-daemon.slice"),
      ["MemoryHigh", "MemoryMax"],
      reinstallHint
    ))
  );
  warnings.push(
    ...(await checkSliceDrift(
      path.join(unitDir, "symphonika-providers.slice"),
      ["MemoryHigh", "MemoryMax", "TasksMax"],
      reinstallHint
    ))
  );

  return warnings;
}

async function checkSliceDrift(
  slicePath: string,
  requiredDirectives: string[],
  reinstallHint: string
): Promise<string[]> {
  const content = await readFileIfExists(slicePath);
  if (content === undefined) {
    return [`${slicePath} is missing — ${reinstallHint}`];
  }
  const directives = sliceDirectiveNames(content);
  if (directives === undefined) {
    return [`${slicePath} has no [Slice] section — ${reinstallHint}`];
  }
  const missingDirectives = requiredDirectives.filter(
    (directive) => !directives.has(directive)
  );
  if (missingDirectives.length > 0) {
    return [
      `${slicePath} is missing required [Slice] directives (${missingDirectives
        .map((directive) => `${directive}=`)
        .join(", ")}) — ${reinstallHint}`
    ];
  }
  return [];
}

function sliceDirectiveNames(content: string): Set<string> | undefined {
  const directives = new Set<string>();
  let inSliceSection = false;
  let sawSliceSection = false;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section !== null) {
      inSliceSection = section[1] === "Slice";
      sawSliceSection ||= inSliceSection;
      continue;
    }
    if (!inSliceSection || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex > 0) {
      directives.add(trimmed.slice(0, equalsIndex).trim());
    }
  }

  return sawSliceSection ? directives : undefined;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function routineDefaultsFromParsed(
  raw: z.infer<typeof routineExecutionDefaultsSchema> | undefined
): RoutineExecutionOverrides {
  if (raw === undefined) {
    return {};
  }
  return {
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.effort === undefined ? {} : { effort: raw.effort }),
    ...(raw.permission_mode === undefined
      ? {}
      : { permissionMode: raw.permission_mode }),
    ...(raw.timeout_minutes === undefined
      ? {}
      : { timeoutMinutes: raw.timeout_minutes })
  };
}

async function validateServiceRoutines(
  entries: Array<{ projectNames: string[]; sourcePath: string }>,
  declaredProjects: ProjectConfig[],
  projectReports: DoctorProjectReport[],
  providers: ServiceConfig["providers"],
  agentProviders: AgentProviderRegistry,
  routineDefaults: RoutineExecutionOverrides
): Promise<string[]> {
  const errors: string[] = [];
  const seenNames = new Map<string, string>();
  const hostsByName = new Map<string, RoutineHostProjectConfig>();
  for (const project of declaredProjects) {
    if (project.mode === "routine_host") {
      hostsByName.set(project.name, project);
    }
  }
  // A routine's target Project name must be unambiguous: `.find()` below
  // resolves a duplicated name to the first declared Project, but a
  // duplicate is itself a config error — mirrors the `projectNameCounts`
  // guard in `src/reload.ts`, which rejects the same ambiguity before
  // attaching a routine at runtime.
  const projectNameCounts = new Map<string, number>();
  for (const project of declaredProjects) {
    projectNameCounts.set(
      project.name,
      (projectNameCounts.get(project.name) ?? 0) + 1
    );
  }
  for (const entry of entries) {
    // Validate the target project independently of whether the declaration
    // itself parses — both come from the top-level `routines:` entry, so a
    // broken file and an unknown/ambiguous target are independent,
    // simultaneously diagnosable errors. Checking this first means both
    // surface in the same `doctor` pass instead of requiring a
    // fix-and-rerun cycle to find the second one.
    const declaredTargets = new Map<string, ProjectConfig>();
    for (const projectName of entry.projectNames) {
      const isDuplicateTarget = (projectNameCounts.get(projectName) ?? 0) > 1;
      const declared = isDuplicateTarget
        ? undefined
        : declaredProjects.find((p) => p.name === projectName);
      if (isDuplicateTarget) {
        errors.push(
          `routines entry targets project "${projectName}" (declared at ${entry.sourcePath}), but "${projectName}" is declared more than once; routine targets require a unique project name`
        );
      } else if (declared === undefined) {
        errors.push(
          `routines entry targets project "${projectName}" (declared at ${entry.sourcePath}), but no project with that name is declared`
        );
      } else {
        declaredTargets.set(projectName, declared);
      }
    }

    const result = await loadRoutineDeclaration(entry.sourcePath);
    if (result.routine === null) {
      errors.push(...result.errors);
      // Reserve an invalid declaration's recovered name too — otherwise a
      // later declaration in this pass can legitimately claim the same name
      // while this file remains broken, violating the service-level
      // global-name uniqueness requirement (ADR 0069).
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
      continue;
    }
    const routine = result.routine;
    const existing = seenNames.get(routine.name);
    if (existing !== undefined) {
      errors.push(
        `duplicate routine name "${routine.name}" declared by ${existing} and ${routine.sourcePath}`
      );
      continue;
    }
    seenNames.set(routine.name, routine.sourcePath);

    if (routine.provider !== null) {
      const providerConfig = providers[routine.provider];
      const providerAdapter = agentProviders[routine.provider];
      if (providerConfig === undefined) {
        errors.push(
          `routine "${routine.name}" provider ${routine.provider} references providers.${routine.provider}.command, but it is missing`
        );
      } else if (providerAdapter === undefined) {
        errors.push(
          `routine "${routine.name}" provider ${routine.provider} has no registered adapter`
        );
      } else {
        const resolved: RoutineExecutionOverrides = {
          ...routineDefaults,
          ...(routine.effort === undefined ? {} : { effort: routine.effort }),
          ...(routine.model === undefined ? {} : { model: routine.model }),
          ...(routine.permissionMode === undefined
            ? {}
            : { permissionMode: routine.permissionMode }),
          ...(routine.timeoutMinutes === undefined
            ? {}
            : { timeoutMinutes: routine.timeoutMinutes })
        };
        try {
          const { rendered, unreferencedFields } =
            renderProviderCommandTemplate(providerConfig.command, resolved);
          for (const field of unreferencedFields) {
            errors.push(
              `routine "${routine.name}" declares ${field}, but providers.${routine.provider}.command never references it`
            );
          }
          await providerAdapter.validate(rendered);
        } catch (error) {
          errors.push(
            `routine "${routine.name}" providers.${routine.provider}.command is invalid: ${errorMessage(error)}`
          );
        }
      }
    }

    // kind: git on a tracker-less Routine Host is a declaration-time error
    // (ADR 0062). Flip the host's validForHosting false so the report is not
    // self-contradictory.
    for (const projectName of declaredTargets.keys()) {
      const host = hostsByName.get(projectName);
      if (
        routine.kind === "git" &&
        host !== undefined &&
        host.tracker === undefined
      ) {
        errors.push(
          `routine "${routine.name}" (kind: git) targets routine host "${projectName}" which declares no tracker; a kind: git routine requires a tracker for PR discovery`
        );
        const reportEntry = projectReports.find((p) => p.name === projectName);
        if (reportEntry !== undefined) {
          reportEntry.validForHosting = false;
        }
      }
    }
  }
  return errors;
}

async function collectWorkflowErrors(
  workflowPath: string,
  format: WorkflowFormat,
  project: ProjectConfig,
  config: ServiceConfig,
  agentProviders: AgentProviderRegistry
): Promise<string[]> {
  try {
    const expanded = await loadExpandedWorkflow(workflowPath, format);
    if (expanded.errors.length > 0) {
      return expanded.errors;
    }
    const errors = await validateExpandedWorkflowReferences(
      expanded.workflow,
      workflowPath
    );
    errors.push(
      ...(await validateWorkflowProviderReferences(
        expanded.workflow,
        project,
        config,
        agentProviders
      ))
    );
    return errors;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`workflow contract not found at ${workflowPath}: ${message}`];
  }
}

async function validateWorkflowProviderReferences(
  workflow: ExpandedWorkflow,
  project: ProjectConfig,
  config: ServiceConfig,
  agentProviders: AgentProviderRegistry
): Promise<string[]> {
  const referenced = new Set<AgentProviderName>();
  for (const state of workflow.states) {
    const action = state.action;
    if (action?.kind === "agent" && action.provider !== undefined) {
      referenced.add(action.provider);
    }
  }
  // The project default provider is already validated by validateProject.
  referenced.delete(project.agent.provider);

  const errors: string[] = [];
  for (const providerName of referenced) {
    const provider = config.providers[providerName];
    if (provider === undefined) {
      errors.push(
        `projects.${project.name} workflow references provider ${providerName}, but providers.${providerName}.command is missing`
      );
      continue;
    }
    if (provider.command.trim().length === 0) {
      errors.push(
        `projects.${project.name} workflow references provider ${providerName}, but its command is empty`
      );
      continue;
    }
    const adapter = agentProviders[providerName];
    if (adapter === undefined) {
      errors.push(
        `projects.${project.name} workflow references provider ${providerName}, but no adapter is registered`
      );
      continue;
    }
    try {
      await adapter.validate(
        renderProviderCommandTemplate(provider.command, {}).rendered
      );
    } catch (error) {
      errors.push(
        `projects.${project.name} providers.${providerName}.command is invalid: ${errorMessage(error)}`
      );
    }
  }
  return errors;
}

async function fetchStaleIssues(
  project: DispatchProjectConfig,
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

  const mode = options.mode ?? "dispatch";
  let metadata: GitHubProjectMetadata | GitProjectMetadata;
  try {
    metadata =
      mode === "routine_host"
        ? await inspectCurrentGitProject(cwd)
        : await inspectCurrentGitHubProject(cwd);
  } catch (error) {
    errors.push(errorMessage(error));
    return initProjectReport(configPath, errors, warnings, projects);
  }

  let settings: ProjectInitSettings;
  try {
    settings = await collectProjectSettings({
      metadata,
      mode,
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

  if (settings.mode === "routine_host") {
    // A Routine Host has no workflow, no GitHub access check, no sym:*
    // labels. Write the config directly. See ADR 0062.
    try {
      await writeFile(configPath, document.toString(), "utf8");
    } catch (error) {
      errors.push(
        `service config could not be written at ${configPath}: ${errorMessage(error)}`
      );
    }
    const github = asGitHubMetadata(metadata);
    projects.push({
      createdEligibilityLabels: [],
      createdOperationalLabels: [],
      missingEligibilityLabels: [],
      missingOperationalLabels: [],
      name: settings.projectName,
      repository:
        github === undefined
          ? metadata.remote
          : `${github.owner}/${github.repo}`
    });
    return initProjectReport(configPath, errors, warnings, projects);
  }
  if (registeredProject.mode !== "dispatch") {
    errors.push(
      `registered Project ${settings.projectName} is not a dispatch project; dispatch init requires mode: dispatch`
    );
    return initProjectReport(configPath, errors, warnings, projects);
  }
  const dispatchProject: DispatchProjectConfig = registeredProject;

  const githubApi = options.githubApi ?? DEFAULT_GITHUB_API;
  const accessValidation = await validateProjectGitHubAccess({
    env,
    errors,
    githubApi,
    project: dispatchProject
  });
  if (accessValidation === undefined) {
    return initProjectReport(configPath, errors, warnings, projects);
  }

  let createdWorkflow = false;
  if (!(await fileExists(settings.workflowPath))) {
    const resolvedFormat = resolveWorkflowFormat(
      dispatchProject.workflow.format,
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
      project: dispatchProject,
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
  mode: "dispatch" | "routine_host";
  priorityLabels: Record<string, number>;
  projectName: string;
  provider: InitProvider;
  requiredLabels: string[];
  // Host-only: the operator-chosen workspace root. Dispatch projects derive
  // workspace from stateRoot + projectName (unchanged).
  workspaceRoot?: string;
  workflowPath: string;
};
async function collectProjectSettings(input: {
  metadata: GitHubProjectMetadata | GitProjectMetadata;
  mode: "dispatch" | "routine_host";
  prompt?: InitProjectPrompt;
  yes: boolean;
}): Promise<ProjectInitSettings> {
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
        message: "Agent Provider (codex, claude, or omp)"
      })
    );
    const baseBranch = await promptController.ask({
      defaultValue: input.metadata.baseBranch,
      key: "baseBranch",
      message: "Base branch"
    });

    if (projectName.trim().length === 0) {
      throw new Error("Project name must not be empty");
    }
    if (baseBranch.trim().length === 0) {
      throw new Error("base branch must not be empty");
    }

    if (input.mode === "routine_host") {
      // A Routine Host has no issue filters, priority labels, or workflow
      // contract. Prompts: name + provider + base branch + workspace root.
      // See ADR 0062.
      const defaultWorkspaceRoot = path.join(
        ".symphonika",
        "workspaces",
        projectName
      );
      const workspaceRoot = await promptController.ask({
        defaultValue: defaultWorkspaceRoot,
        key: "workspaceRoot",
        message: "Workspace root"
      });
      if (workspaceRoot.trim().length === 0) {
        throw new Error("workspace root must not be empty");
      }
      return {
        baseBranch,
        excludedLabels: [],
        mode: "routine_host",
        priorityLabels: {},
        projectName,
        provider,
        requiredLabels: [],
        workspaceRoot,
        workflowPath: ""
      };
    }

    const defaultWorkflowPath = path.join(
      input.metadata.projectRoot,
      "WORKFLOW.md"
    );
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

    if (workflowAnswer.trim().length === 0) {
      throw new Error("Workflow Contract path must not be empty");
    }

    return {
      baseBranch,
      excludedLabels,
      mode: "dispatch",
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
  if (value === "codex" || value === "claude" || value === "omp") {
    return value;
  }
  throw new Error("Agent Provider must be one of codex, claude, omp");
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
  metadata: GitHubProjectMetadata | GitProjectMetadata;
  settings: ProjectInitSettings;
  stateRoot: string;
}): unknown {
  const workspace = {
    root:
      input.settings.mode === "routine_host" &&
      input.settings.workspaceRoot !== undefined
        ? input.settings.workspaceRoot
        : path.join(input.stateRoot, "workspaces", input.settings.projectName),
    git: {
      remote: input.metadata.remote,
      base_branch: input.settings.baseBranch
    }
  };
  const agent = { provider: input.settings.provider };

  if (input.settings.mode === "routine_host") {
    // A Routine Host: name + workspace + agent + mode. tracker only if the
    // origin is a GitHub remote (parsed into owner/repo); a non-GitHub remote
    // gets no tracker, and kind:git routines targeting it are rejected at
    // reload/doctor. See ADR 0062.
    const github = asGitHubMetadata(input.metadata);
    return {
      ...(github === undefined
        ? {}
        : {
            tracker: {
              kind: "github",
              owner: github.owner,
              repo: github.repo,
              token: "$GITHUB_TOKEN"
            }
          }),
      agent,
      mode: "routine_host",
      name: input.settings.projectName,
      workspace
    };
  }

  const github = asGitHubMetadata(input.metadata);
  if (github === undefined) {
    // Dispatch mode runs from inspectCurrentGitHubProject, which throws on a
    // non-GitHub origin, so this is unreachable. Throw rather than serialize a
    // knowingly-invalid empty tracker that would hide a control-flow bug.
    throw new Error(
      `dispatch Project ${input.settings.projectName} requires a GitHub origin remote, but none was detected`
    );
  }
  return {
    name: input.settings.projectName,
    disabled: false,
    weight: 1,
    tracker: {
      kind: "github",
      owner: github.owner,
      repo: github.repo,
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
    workspace,
    agent,
    workflow: input.settings.workflowPath
  };
}

// Returns GitHub owner/repo from either metadata variant: the dispatch
// inspector carries them directly; the host inspector carries them as
// optional githubOwner/githubRepo only when the origin parsed as github.com.
// Dispatch mode always has them (inspectCurrentGitHubProject throws on a
// non-GitHub origin); host mode has them only for a GitHub origin.
function asGitHubMetadata(
  metadata: GitHubProjectMetadata | GitProjectMetadata
): { owner: string; repo: string } | undefined {
  if ("owner" in metadata && "repo" in metadata) {
    return { owner: metadata.owner, repo: metadata.repo };
  }
  if (
    "githubOwner" in metadata &&
    "githubRepo" in metadata &&
    metadata.githubOwner !== undefined &&
    metadata.githubRepo !== undefined
  ) {
    return { owner: metadata.githubOwner, repo: metadata.githubRepo };
  }
  return undefined;
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
  project: DispatchProjectConfig;
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
  project: DispatchProjectConfig;
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
  const errorsBeforeLabelSetup = input.errors.length;
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
  if (
    missingEligibilityLabels.length > 0 &&
    input.errors.length === errorsBeforeLabelSetup
  ) {
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

export function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

const STALE_CLEAR_LABELS = ["sym:stale", "sym:claimed", "sym:running"] as const;

function describeClearStaleTargets(
  all: boolean,
  issueNumbers: number[]
): string {
  if (!all) {
    return `#${issueNumbers[0]}`;
  }
  if (issueNumbers.length === 0) {
    return " issues (none)";
  }
  const noun = pluralize("issue", issueNumbers.length);
  const numbers = issueNumbers
    .map((issueNumber) => `#${issueNumber}`)
    .join(", ");
  return ` ${noun} ${numbers}`;
}

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
  const outcomes: ClearStaleIssueOutcome[] = [];
  const result = (repository: string, ok = false): ClearStaleReport => ({
    configPath,
    errors,
    ok,
    outcomes,
    project: options.project,
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
  if (project.mode !== "dispatch") {
    errors.push(
      `projects.${options.project} is a ${project.mode} project; clear-stale only applies to dispatch projects with sym:* labels`
    );
    return result("");
  }
  const dispatchProject: DispatchProjectConfig = project;

  const repositoryName = `${dispatchProject.tracker.owner}/${dispatchProject.tracker.repo}`;
  const token = resolveEnvBackedValue(dispatchProject.tracker.token, env);
  if (token === undefined) {
    const variableName = envReferenceName(dispatchProject.tracker.token);
    errors.push(
      variableName === undefined
        ? `projects.${dispatchProject.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
        : `projects.${dispatchProject.name}.tracker.token references unset environment variable $${variableName}`
    );
    return result(repositoryName);
  }

  const githubApi = options.githubApi ?? DEFAULT_GITHUB_API;
  const repository = {
    owner: dispatchProject.tracker.owner,
    repo: dispatchProject.tracker.repo,
    token
  };
  const access = await githubApi.validateRepositoryAccess(repository);
  if (!access.ok) {
    errors.push(
      `projects.${project.name}.tracker.repository ${repositoryName} is not accessible: ${access.message ?? "unknown GitHub error"}`
    );
    return result(repositoryName);
  }

  let issueNumbers: number[];
  if (options.all === true) {
    if (githubApi.listIssueNumbersByLabel === undefined) {
      errors.push(
        `projects.${project.name}.tracker.repository ${repositoryName} GitHub adapter does not support listIssueNumbersByLabel`
      );
      return result(repositoryName);
    }
    try {
      issueNumbers = [
        ...new Set(
          await githubApi.listIssueNumbersByLabel({
            ...repository,
            label: "sym:stale"
          })
        )
      ].sort((left, right) => left - right);
    } catch (error) {
      errors.push(
        `projects.${project.name}.tracker.repository ${repositoryName} could not list issues carrying sym:stale: ${errorMessage(error)}`
      );
      return result(repositoryName);
    }
  } else {
    issueNumbers = [options.issueNumber];
  }

  const targets = describeClearStaleTargets(options.all === true, issueNumbers);
  const warning = `clear-stale ${options.yes === true ? "will" : "would"} remove ${STALE_CLEAR_LABELS.join(", ")} from ${repositoryName}${targets}`;
  warnings.push(warning);
  options.onWarning?.(warning);

  if (options.yes !== true) {
    errors.push("pass --yes to remove stale-claim labels non-interactively");
    return result(repositoryName);
  }

  if (issueNumbers.length === 0) {
    return result(repositoryName, true);
  }

  if (githubApi.removeIssueLabel === undefined) {
    errors.push(
      `projects.${project.name}.tracker.repository ${repositoryName} GitHub adapter does not support removeIssueLabel`
    );
    return result(repositoryName);
  }

  let allOk = true;
  for (const issueNumber of issueNumbers) {
    const removedLabels: string[] = [];
    const outcomeErrors: string[] = [];

    for (const label of STALE_CLEAR_LABELS) {
      try {
        await githubApi.removeIssueLabel({
          ...repository,
          issueNumber,
          name: label
        });
        removedLabels.push(label);
      } catch (error) {
        if (isOctokitNotFoundError(error)) {
          continue;
        }
        allOk = false;
        const message = `projects.${project.name}.tracker.repository ${repositoryName} could not remove label ${label} from issue ${issueNumber}: ${errorMessage(error)}`;
        errors.push(message);
        outcomeErrors.push(message);
      }
    }

    outcomes.push({
      errors: outcomeErrors,
      issueNumber,
      removedLabels,
      status:
        outcomeErrors.length > 0
          ? "error"
          : removedLabels.length === 0
            ? "already-removed"
            : "cleared"
    });
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

  async listIssueNumbersByLabel(
    input: GitHubRepositoryInput & { label: string }
  ): Promise<number[]> {
    const octokit = this.octokit(input.token);
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      labels: input.label,
      owner: input.owner,
      per_page: 100,
      repo: input.repo,
      state: "all"
    });

    return issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => issue.number);
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
  // Provider command + adapter checks are shared by both modes.
  const provider = config.providers[project.agent.provider];
  let providerOk = true;
  if (provider === undefined) {
    errors.push(
      `projects.${project.name}.agent.provider references ${project.agent.provider}, but providers.${project.agent.provider}.command is missing`
    );
    providerOk = false;
  } else if (provider.command.trim().length === 0) {
    errors.push(
      `projects.${project.name}.agent.provider references ${project.agent.provider}, but its command is empty`
    );
    providerOk = false;
  }
  const providerAdapter = agentProviders[project.agent.provider];
  if (providerAdapter === undefined) {
    errors.push(
      `projects.${project.name}.agent.provider references ${project.agent.provider}, but no adapter is registered`
    );
    providerOk = false;
  } else if (provider !== undefined) {
    try {
      await providerAdapter.validate(
        renderProviderCommandTemplate(provider.command, {}).rendered
      );
    } catch (error) {
      errors.push(
        `projects.${project.name}.providers.${project.agent.provider}.command is invalid: ${errorMessage(error)}`
      );
      providerOk = false;
    }
  }

  if (project.mode === "routine_host") {
    // A Routine Host needs only a resolvable provider + workspace. No GitHub
    // access, no Operational/Eligibility Labels. It never dispatches, so
    // validForDispatch is false by construction; validForHosting reflects the
    // provider check. The kind:git+tracker invariant is enforced in
    // runDoctor's routine-validation pass (it needs the loaded declarations).
    // See ADR 0062.
    return {
      missingEligibilityLabels: [],
      missingOperationalLabels: [],
      validForDispatch: false,
      validForHosting: providerOk
    };
  }

  // Dispatch Project: repo access + Operational Labels + Eligibility Labels.
  const validForDispatch = providerOk;
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
      validForDispatch: false,
      validForHosting: false
    };
  }

  if (githubApi === undefined) {
    return {
      missingEligibilityLabels: [],
      missingOperationalLabels: [],
      validForDispatch,
      validForHosting: false
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
      validForDispatch: false,
      validForHosting: false
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
      validForDispatch: false,
      validForHosting: false
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
      missingOperationalLabels.length === 0,
    validForHosting: false
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
  project: DispatchProjectConfig,
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
  projects: DoctorProjectReport[],
  warnings: string[] = [],
  liveCheck?: DoctorLiveCheckReport
): DoctorReport {
  return {
    configPath,
    errors,
    ...(liveCheck === undefined ? {} : { liveCheck }),
    ok: errors.length === 0,
    projects,
    warnings
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
