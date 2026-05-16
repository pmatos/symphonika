import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./builtin-templates.js";
import type { WorkflowFormat } from "./config-schemas.js";
import type { IssueSnapshot } from "./issue-polling.js";
import { isPathInside } from "./path-safety.js";

export const AUTONOMY_PREAMBLE_VERSION = "autonomy-preamble-v2";

export type PromptProject = {
  name: string;
};

export type PromptWorkspace = {
  path: string;
  previous_attempt: boolean;
  root: string;
};

export type PromptBranch = {
  name: string;
  ref: string;
};

export type PromptRun = {
  attempt: number;
  continuation: boolean;
  id: string;
};

export type PromptProvider = {
  command: string;
  name: "codex" | "claude";
};

export type RenderAutonomousPromptInput = {
  branch: PromptBranch;
  extraInstructions?: string;
  issue: IssueSnapshot;
  project: PromptProject;
  provider: PromptProvider;
  run: PromptRun;
  template: string;
  workflowContentHash?: string;
  workflowPath: string;
  workspace: PromptWorkspace;
};

export type RenderedAutonomousPrompt = {
  preambleVersion: string;
  prompt: string;
  workflowContentHash: string;
};

export type PersistRunEvidenceInput = RenderAutonomousPromptInput & {
  attemptNumber: number;
  expandedWorkflow: ExpandedWorkflow;
  renderedPrompt: RenderedAutonomousPrompt;
  stateRoot: string;
};

export type RunEvidencePaths = {
  issueSnapshotPath: string;
  metadataPath: string;
  promptPath: string;
  runEvidenceDirectory: string;
  workflowGraphPath: string;
};

export type WorkflowContract = {
  body: string;
  contentHash: string;
  errors: string[];
  path: string;
};

export type WorkflowSourceKind = "markdown" | "raw_fsm";

export type WorkflowActionKind =
  | "agent"
  | "close_issue"
  | "comment"
  | "fail"
  | "label_issue"
  | "merge_pr"
  | "wait";

export type WorkflowPredicateValue = boolean | number | string;

export type WorkflowPredicateMap = Record<string, WorkflowPredicateValue>;

export type WorkflowAction = {
  kind: WorkflowActionKind;
  method?: string;
  prompt?: string;
  provider?: "codex" | "claude";
};

export type WorkflowTransition = {
  to: string;
  when: WorkflowPredicateMap;
};

export type ExpandedWorkflowState = {
  action?: WorkflowAction;
  completeWhen: WorkflowPredicateMap;
  id: string;
  terminal?: string;
  transitions: WorkflowTransition[];
};

export type ExpandedWorkflow = {
  contentHash: string;
  initial: string;
  name: string;
  source: {
    kind: WorkflowSourceKind;
    path: string;
  };
  states: ExpandedWorkflowState[];
  templateFiles: string[];
};

type WorkflowTemplateInputType =
  | "boolean"
  | "label"
  | "number"
  | "path"
  | "provider"
  | "string";

type WorkflowTemplateScalar = boolean | number | string;

type WorkflowTemplateInput = {
  type: WorkflowTemplateInputType;
  defaultValue?: WorkflowTemplateScalar;
};

type WorkflowTemplateUse = {
  exitMappings: Record<string, string>;
  id: string;
  template: string;
  withValues: Record<string, unknown>;
};

type ParsedWorkflowTemplate = {
  contents: string;
  entry: string;
  exits: Record<string, string>;
  inputs: Record<string, WorkflowTemplateInput>;
  path: string;
  states: Record<string, unknown>;
};

type LoadedWorkflowTemplateUse = {
  template: ParsedWorkflowTemplate;
  use: WorkflowTemplateUse;
};

type WorkflowTemplateUseExpansion = {
  states: ExpandedWorkflowState[];
  unresolvedExitTargets: Set<string>;
};

export type ExpandedWorkflowLoadResult = {
  errors: string[];
  workflow: ExpandedWorkflow;
};

export type ProjectWorkflowLoadResult = {
  errors: string[];
  projectName: string | null;
  workflow: ExpandedWorkflow | null;
  workflowPath: string | null;
};

type PromptContext = {
  branch: PromptBranch;
  issue: IssueSnapshot;
  project: PromptProject;
  provider: PromptProvider;
  run: PromptRun;
  workspace: PromptWorkspace;
};

const allowedTemplateFields: Record<keyof PromptContext, ReadonlySet<string>> = {
  branch: new Set(["name", "ref"]),
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
  workspace: new Set(["path", "previous_attempt", "root"])
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

const actionKinds = new Set<WorkflowActionKind>([
  "agent",
  "close_issue",
  "comment",
  "fail",
  "label_issue",
  "merge_pr",
  "wait"
]);

const mergeMethods = new Set<string>(["merge", "rebase", "squash"]);

const completionPredicateKeys = new Set([
  "artifact_exists",
  "branch_ahead_of_base",
  "branch_pushed",
  "checks",
  "has_unresolved_reviews",
  "mergeable",
  "pr_merged",
  "pr_open",
  "provider_success",
  "review_decision",
  "timeout",
  "unresolved_review_threads"
]);

const terminalStates = new Set(["blocked", "failure", "success"]);

const tagPattern = /{{\s*([^{}]+?)\s*}}/g;

const AUTONOMY_PREAMBLE = [
  "# Autonomous run instructions",
  "",
  "You are running as an autonomous full-permission coding worker. No operator will respond to prompts, approve tool calls, or read intermediate output during this run; behaviour that depends on a human answering mid-run is a failure mode.",
  "Use the prepared workspace as your current working directory and stay on the assigned issue branch. Work only on the assigned issue unless the workflow contract explicitly says otherwise. Preserve useful evidence in the workspace when blocked or when you cannot complete the task.",
  "",
  "## Operating contract",
  "",
  "1. **Make best-effort decisions and document them.** When information is missing or a judgement call is needed, choose the most defensible option, proceed, and leave a `gh issue comment` (or PR comment if a PR exists) explaining the choice and the alternatives considered. A future operator or reviewer can override.",
  "2. **Never request approval at runtime.** Use the local gh CLI (`gh issue ...`, `gh pr ...`, `gh issue comment ...`, `gh issue edit ...`) for every GitHub mutation — issues, pull requests, comments, labels. Do not call the GitHub MCP connector tools (for example `add_issue_labels`, `create_pull_request`) — those tools elicit per-call operator approval through the provider transport, which Symphonika classifies as `input_required` and ends the run with `terminal_reason=\"provider requested input\"`.",
  "3. **Do not self-apply `needs-human` as an exit strategy.** If you cannot proceed at all, post an explanatory comment with `gh issue comment` describing what blocked you and what would unblock it, then exit cleanly without applying handoff labels. The operator may still apply `needs-human` from outside the run; that is unchanged.",
  "4. **Branch and PR hygiene.** Commit, push, and open the PR via `gh pr create` with explicit non-interactive flags (`--base`, `--head`, `--title`, `--body`). Do not use `--web` or any other flag that opens a browser or waits for input.",
  ""
].join("\n");

export function renderAutonomousPrompt(
  input: RenderAutonomousPromptInput
): RenderedAutonomousPrompt {
  const context: PromptContext = {
    branch: input.branch,
    issue: input.issue,
    project: input.project,
    provider: input.provider,
    run: input.run,
    workspace: input.workspace
  };
  const renderedWorkflow = input.template.replace(tagPattern, (_tag, expression) =>
    stringifyTemplateValue(
      resolveTemplateValue(String(expression).trim(), context, input.workflowPath),
      input.workflowPath
    )
  );

  return {
    preambleVersion: AUTONOMY_PREAMBLE_VERSION,
    prompt: [
      AUTONOMY_PREAMBLE,
      previousAttemptNotice(input.workspace),
      input.extraInstructions ?? "",
      renderedWorkflow
    ]
      .filter((section) => section.length > 0)
      .join("\n"),
    workflowContentHash: input.workflowContentHash ?? contentHash(input.template)
  };
}

export async function loadWorkflowContract(
  workflowPath: string
): Promise<WorkflowContract> {
  const contents = await readFile(workflowPath, "utf8");
  return parseWorkflowContract(contents, workflowPath);
}

export async function loadExpandedWorkflow(
  workflowPath: string,
  format: WorkflowFormat = "auto"
): Promise<ExpandedWorkflowLoadResult> {
  const contents = await readFile(workflowPath, "utf8");
  return expandWorkflowDefinition(contents, workflowPath, format);
}

export async function validateExpandedWorkflowReferences(
  workflow: ExpandedWorkflow,
  workflowPath: string
): Promise<string[]> {
  if (workflow.source.kind !== "raw_fsm") {
    return [];
  }
  const workflowDir = path.dirname(workflowPath);
  const errors: string[] = [];
  for (const state of workflow.states) {
    const action = state.action;
    if (action?.kind !== "agent" || typeof action.prompt !== "string") {
      continue;
    }
    const promptPath = path.resolve(workflowDir, action.prompt);
    try {
      await readFile(promptPath, "utf8");
    } catch (error) {
      errors.push(
        `workflow state ${state.id} prompt not found at ${promptPath}: ${errorMessage(error)}`
      );
    }
  }
  return errors;
}

export async function loadProjectWorkflow(input: {
  configPath: string;
  projectName?: string;
}): Promise<ProjectWorkflowLoadResult> {
  const configPath = path.resolve(input.configPath);
  const errors: string[] = [];
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    return {
      errors: [`service config not found at ${configPath}: ${errorMessage(error)}`],
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(contents) ?? {};
  } catch (error) {
    return {
      errors: [`service config could not be parsed: ${errorMessage(error)}`],
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
    return {
      errors: ["service config must define projects"],
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  const projects = projectWorkflowReferences(parsed.projects, configPath, errors);
  const selected = selectProjectWorkflow(projects, input.projectName, configPath, errors);
  if (selected === undefined) {
    return {
      errors,
      projectName: input.projectName ?? null,
      workflow: null,
      workflowPath: null
    };
  }

  const workflowPath = path.resolve(path.dirname(configPath), selected.workflowPath);
  let result: ExpandedWorkflowLoadResult;
  try {
    result = await loadExpandedWorkflow(workflowPath, selected.workflowFormat);
  } catch (error) {
    return {
      errors: [
        ...errors,
        `workflow contract not found at ${workflowPath}: ${errorMessage(error)}`
      ],
      projectName: selected.name,
      workflow: null,
      workflowPath
    };
  }

  return {
    errors: [...errors, ...result.errors],
    projectName: selected.name,
    workflow: result.workflow,
    workflowPath
  };
}

export function explainWorkflow(workflow: ExpandedWorkflow): string {
  const lines = [
    `workflow: ${workflow.name}`,
    `source: ${workflow.source.path}`,
    `source kind: ${workflow.source.kind}`,
    `content hash: ${workflow.contentHash}`,
    `initial: ${workflow.initial}`,
    `template files: ${workflow.templateFiles.length === 0 ? "(none)" : workflow.templateFiles.join(", ")}`,
    "states:"
  ];

  for (const state of workflow.states) {
    lines.push(`  state: ${state.id}`);
    if (state.action !== undefined) {
      lines.push(`    action: ${formatWorkflowAction(state.action)}`);
    }
    if (Object.keys(state.completeWhen).length > 0) {
      lines.push(`    complete_when: ${formatPredicateMap(state.completeWhen)}`);
    }
    if (state.transitions.length > 0) {
      lines.push("    transitions:");
      for (const transition of state.transitions) {
        const predicate =
          Object.keys(transition.when).length === 0
            ? ""
            : ` when ${formatPredicateMap(transition.when)}`;
        lines.push(`      -> ${transition.to}${predicate}`);
      }
    }
    if (state.terminal !== undefined) {
      lines.push(`    terminal: ${state.terminal}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function validateWorkflowContract(
  workflowPath: string
): Promise<string[]> {
  let contents: string;

  try {
    contents = await readFile(workflowPath, "utf8");
  } catch (error) {
    return [`workflow contract not found at ${workflowPath}: ${errorMessage(error)}`];
  }

  const workflow = parseWorkflowContract(contents, workflowPath);
  const errors = [...workflow.errors];

  if (workflow.body.trim().length === 0) {
    errors.push(`workflow contract at ${workflowPath} must not be empty`);
  }

  errors.push(...validateWorkflowTemplate(workflow.body, workflowPath));
  return errors;
}

export function parseWorkflowContract(
  contents: string,
  workflowPath: string
): WorkflowContract {
  const lines = contents.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return {
      body: contents,
      contentHash: contentHash(contents),
      errors: [],
      path: workflowPath
    };
  }

  const closingLine = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---"
  );
  if (closingLine === -1) {
    return {
      body: "",
      contentHash: contentHash(contents),
      errors: [`workflow front matter at ${workflowPath} is missing a closing ---`],
      path: workflowPath
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
    contentHash: contentHash(contents),
    errors,
    path: workflowPath
  };
}

export function validateWorkflowTemplate(
  template: string,
  workflowPath: string
): string[] {
  const errors: string[] = [];

  for (const match of template.matchAll(tagPattern)) {
    const expression = match[1]?.trim() ?? "";
    const error = templateExpressionError(expression, workflowPath);
    if (error !== undefined) {
      errors.push(error);
    }
  }

  return errors;
}

export async function expandWorkflowDefinition(
  contents: string,
  workflowPath: string,
  format: WorkflowFormat = "auto"
): Promise<ExpandedWorkflowLoadResult> {
  const resolved = resolveWorkflowFormat(format, workflowPath);
  if (resolved.kind === "error") {
    return {
      errors: [resolved.error],
      workflow: emptyExpandedWorkflow(contents, workflowPath, "markdown")
    };
  }

  if (resolved.kind === "raw_fsm") {
    const errors: string[] = [];
    const explicit = parseExplicitWorkflowDefinition(contents, workflowPath, errors);
    if (explicit === undefined) {
      return {
        errors,
        workflow: emptyExpandedWorkflow(contents, workflowPath, "raw_fsm")
      };
    }
    return expandRawStateMachineWorkflow(
      explicit,
      workflowPath,
      contents,
      errors
    );
  }

  const errors: string[] = [];
  const workflow = parseWorkflowContract(contents, workflowPath);
  errors.push(...workflow.errors);
  if (workflow.body.trim().length === 0) {
    errors.push(`workflow contract at ${workflowPath} must not be empty`);
  }
  errors.push(...validateWorkflowTemplate(workflow.body, workflowPath));
  return {
    errors,
    workflow: markdownCompatibilityWorkflow(workflow)
  };
}

type ResolvedWorkflowFormat =
  | { kind: "markdown" | "raw_fsm" }
  | { error: string; kind: "error" };

function resolveWorkflowFormat(
  format: WorkflowFormat,
  workflowPath: string
): ResolvedWorkflowFormat {
  if (format === "markdown") {
    return { kind: "markdown" };
  }
  if (format === "raw_fsm") {
    return { kind: "raw_fsm" };
  }
  const extension = path.extname(workflowPath).toLowerCase();
  if (extension === ".md") {
    return { kind: "markdown" };
  }
  if (extension === ".yaml" || extension === ".yml" || extension === ".json") {
    return { kind: "raw_fsm" };
  }
  return {
    error: `workflow at ${workflowPath} has no recognized extension (.md, .yaml, .yml, .json); declare format explicitly`,
    kind: "error"
  };
}

function emptyExpandedWorkflow(
  contents: string,
  workflowPath: string,
  kind: WorkflowSourceKind
): ExpandedWorkflow {
  return {
    contentHash: contentHash(contents),
    initial: "",
    name: path.basename(workflowPath, path.extname(workflowPath)),
    source: { kind, path: workflowPath },
    states: [],
    templateFiles: []
  };
}

function projectWorkflowReferences(
  rawProjects: unknown[],
  configPath: string,
  errors: string[]
): Array<{ name: string; workflowFormat: WorkflowFormat; workflowPath: string }> {
  const projects: Array<{
    name: string;
    workflowFormat: WorkflowFormat;
    workflowPath: string;
  }> = [];
  for (const [index, rawProject] of rawProjects.entries()) {
    if (!isRecord(rawProject)) {
      errors.push(`projects.${index} in ${configPath} must be a mapping`);
      continue;
    }
    const name = stringProperty(rawProject, "name");
    if (name === undefined) {
      errors.push(`projects.${index}.name in ${configPath} must be a non-empty string`);
      continue;
    }
    const reference = parseWorkflowReference(
      rawProject.workflow,
      `projects.${name}.workflow`,
      configPath,
      errors
    );
    if (reference === undefined) {
      continue;
    }
    projects.push({
      name,
      workflowFormat: reference.format,
      workflowPath: reference.path
    });
  }
  return projects;
}

function parseWorkflowReference(
  rawWorkflow: unknown,
  fieldLabel: string,
  configPath: string,
  errors: string[]
): { format: WorkflowFormat; path: string } | undefined {
  if (typeof rawWorkflow === "string") {
    const trimmed = rawWorkflow.trim();
    if (trimmed.length === 0) {
      errors.push(`${fieldLabel} in ${configPath} must be a non-empty path`);
      return undefined;
    }
    return { format: "auto", path: trimmed };
  }
  if (isRecord(rawWorkflow)) {
    const pathValue = stringProperty(rawWorkflow, "path");
    if (pathValue === undefined) {
      errors.push(`${fieldLabel}.path in ${configPath} must be a non-empty path`);
      return undefined;
    }
    const formatRaw = rawWorkflow.format;
    let format: WorkflowFormat = "auto";
    if (formatRaw !== undefined) {
      if (
        formatRaw === "markdown" ||
        formatRaw === "raw_fsm" ||
        formatRaw === "auto"
      ) {
        format = formatRaw;
      } else {
        errors.push(
          `${fieldLabel}.format in ${configPath} must be one of markdown, raw_fsm, auto`
        );
        return undefined;
      }
    }
    return { format, path: pathValue };
  }
  errors.push(`${fieldLabel} in ${configPath} must be a non-empty path or mapping`);
  return undefined;
}

function selectProjectWorkflow(
  projects: Array<{
    name: string;
    workflowFormat: WorkflowFormat;
    workflowPath: string;
  }>,
  requestedProject: string | undefined,
  configPath: string,
  errors: string[]
):
  | { name: string; workflowFormat: WorkflowFormat; workflowPath: string }
  | undefined {
  if (requestedProject !== undefined) {
    const selected = projects.find((project) => project.name === requestedProject);
    if (selected === undefined) {
      errors.push(
        `project ${requestedProject} is not defined in service config ${configPath}`
      );
    }
    return selected;
  }

  if (projects.length === 1) {
    return projects[0];
  }

  if (projects.length === 0) {
    errors.push(`service config ${configPath} does not contain a project workflow`);
  } else {
    errors.push(
      `service config ${configPath} has ${projects.length} projects; pass --project`
    );
  }
  return undefined;
}

function parseExplicitWorkflowDefinition(
  contents: string,
  workflowPath: string,
  errors: string[]
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parse(contents) ?? {};
  } catch (error) {
    errors.push(
      `workflow definition at ${workflowPath} could not be parsed: ${errorMessage(error)}`
    );
    return undefined;
  }

  if (!isRecord(parsed) || !isRecord(parsed.workflow)) {
    errors.push(
      `workflow definition at ${workflowPath} must define a top-level workflow mapping`
    );
    return undefined;
  }

  return parsed.workflow;
}

async function expandRawStateMachineWorkflow(
  rawWorkflow: Record<string, unknown>,
  workflowPath: string,
  workflowContents: string,
  errors: string[]
): Promise<ExpandedWorkflowLoadResult> {
  const name = stringProperty(rawWorkflow, "name");
  if (name === undefined) {
    errors.push(`workflow definition at ${workflowPath} must define workflow.name`);
  }

  const initial = stringProperty(rawWorkflow, "initial");
  if (initial === undefined) {
    errors.push(`workflow definition at ${workflowPath} must define workflow.initial`);
  }

  const rawStates = recordProperty(rawWorkflow, "states");
  const rawUse = rawWorkflow.use;
  const uses = parseWorkflowTemplateUses(rawUse, workflowPath, errors);
  if (rawStates === undefined && uses.length === 0) {
    errors.push(`workflow definition at ${workflowPath} must define workflow.states`);
  }

  const states: ExpandedWorkflowState[] = [];
  if (rawStates !== undefined) {
    for (const [stateId, rawState] of Object.entries(rawStates)) {
      states.push(parseWorkflowState(stateId, rawState, workflowPath, errors));
    }
  }

  const rawStateIds = new Set(states.map((state) => state.id));
  const stateIds = new Set(rawStateIds);
  for (const use of uses) {
    if (rawStateIds.has(use.id)) {
      errors.push(
        `workflow template instance ${use.id} at ${workflowPath} conflicts with a workflow state`
      );
    }
  }

  const loadedUses = await loadWorkflowTemplateUses(uses, workflowPath, errors);
  const templateEntryTargets = new Map(
    loadedUses.map((loaded) => [
      loaded.use.id,
      `${loaded.use.id}.${loaded.template.entry}`
    ])
  );
  const unresolvedTemplateExitTargets = new Set<string>();
  for (const loaded of loadedUses) {
    const expansion = expandWorkflowTemplateUse(
      loaded,
      templateEntryTargets,
      workflowPath,
      errors
    );
    for (const state of expansion.states) {
      if (stateIds.has(state.id)) {
        errors.push(
          `workflow template instance ${loaded.use.id} at ${workflowPath} expands state ${state.id} that conflicts with an existing workflow state`
        );
        continue;
      }
      stateIds.add(state.id);
      states.push(state);
    }
    for (const target of expansion.unresolvedExitTargets) {
      unresolvedTemplateExitTargets.add(target);
    }
  }

  const templateFiles = uniqueStrings(loadedUses.map((loaded) => loaded.template.path));
  const expandedInitial =
    initial === undefined ? undefined : templateEntryTargets.get(initial) ?? initial;
  if (expandedInitial !== undefined && !stateIds.has(expandedInitial)) {
    errors.push(
      `workflow definition at ${workflowPath} initial state ${initial} is not declared`
    );
  }
  for (const state of states) {
    if (rawStateIds.has(state.id)) {
      state.transitions = state.transitions.map((transition) => ({
        ...transition,
        to: templateEntryTargets.get(transition.to) ?? transition.to
      }));
    }
    for (const transition of state.transitions) {
      if (!stateIds.has(transition.to) && !unresolvedTemplateExitTargets.has(transition.to)) {
        errors.push(
          `workflow state ${state.id} at ${workflowPath} transitions to unknown state ${transition.to}`
        );
      }
    }
  }

  return {
    errors,
    workflow: {
      contentHash: contentHash(
        [
          workflowContents,
          ...loadedUses.map(
            (loaded) => `${loaded.template.path}\n${loaded.template.contents}`
          )
        ].join("\n\0\n")
      ),
      initial: expandedInitial ?? "",
      name: name ?? path.basename(workflowPath, path.extname(workflowPath)),
      source: {
        kind: "raw_fsm",
        path: workflowPath
      },
      states,
      templateFiles
    }
  };
}

function parseWorkflowTemplateUses(
  rawUse: unknown,
  workflowPath: string,
  errors: string[]
): WorkflowTemplateUse[] {
  if (rawUse === undefined) {
    return [];
  }
  if (!isRecord(rawUse)) {
    errors.push(`workflow definition at ${workflowPath} workflow.use must be a mapping`);
    return [];
  }

  const uses: WorkflowTemplateUse[] = [];
  for (const [instanceId, rawInstance] of Object.entries(rawUse)) {
    if (!isPathSafeIdentifier(instanceId)) {
      errors.push(
        `workflow template instance ${instanceId} at ${workflowPath} must use a path-safe identifier`
      );
    }
    if (!isRecord(rawInstance)) {
      errors.push(
        `workflow template instance ${instanceId} at ${workflowPath} must be a mapping`
      );
      continue;
    }
    const template = stringProperty(rawInstance, "template");
    if (template === undefined) {
      errors.push(
        `workflow template instance ${instanceId} at ${workflowPath} must define template`
      );
      continue;
    }
    if (!template.startsWith("builtin:") && path.isAbsolute(template)) {
      errors.push(
        `workflow template instance ${instanceId} at ${workflowPath} template must be a repo-local relative path`
      );
      continue;
    }
    uses.push({
      exitMappings: parseStringMap(
        rawInstance.exits,
        `workflow template instance ${instanceId} at ${workflowPath} exits`,
        errors
      ),
      id: instanceId,
      template,
      withValues: parseUnknownMap(
        rawInstance.with,
        `workflow template instance ${instanceId} at ${workflowPath} with`,
        errors
      )
    });
  }
  return uses;
}

async function loadWorkflowTemplateUses(
  uses: WorkflowTemplateUse[],
  workflowPath: string,
  errors: string[]
): Promise<LoadedWorkflowTemplateUse[]> {
  const loaded: LoadedWorkflowTemplateUse[] = [];
  for (const use of uses) {
    const template = await loadWorkflowTemplate(use, workflowPath, errors);
    if (template !== undefined) {
      loaded.push({ template, use });
    }
  }
  return loaded;
}

async function loadWorkflowTemplate(
  use: WorkflowTemplateUse,
  workflowPath: string,
  errors: string[]
): Promise<ParsedWorkflowTemplate | undefined> {
  if (use.template.startsWith("builtin:")) {
    return loadBuiltinWorkflowTemplate(use, workflowPath, errors);
  }

  const workflowDir = path.dirname(workflowPath);
  const templatePath = path.resolve(workflowDir, use.template);
  if (!isPathInside(templatePath, workflowDir)) {
    errors.push(
      `workflow template instance ${use.id} at ${workflowPath} template ${use.template} must stay inside ${workflowDir}`
    );
    return undefined;
  }

  let contents: string;
  try {
    contents = await readFile(templatePath, "utf8");
  } catch (error) {
    errors.push(
      `workflow template instance ${use.id} at ${workflowPath} could not read ${templatePath}: ${errorMessage(error)}`
    );
    return undefined;
  }

  return parseWorkflowTemplate(contents, templatePath, errors);
}

function loadBuiltinWorkflowTemplate(
  use: WorkflowTemplateUse,
  workflowPath: string,
  errors: string[]
): ParsedWorkflowTemplate | undefined {
  const name = use.template.slice("builtin:".length);
  const contents = BUILTIN_WORKFLOW_TEMPLATES[name];
  if (contents === undefined) {
    errors.push(
      `workflow template instance ${use.id} at ${workflowPath} references unknown built-in template ${use.template}`
    );
    return undefined;
  }
  return parseWorkflowTemplate(contents, use.template, errors);
}

function parseWorkflowTemplate(
  contents: string,
  templatePath: string,
  errors: string[]
): ParsedWorkflowTemplate | undefined {
  let parsed: unknown;
  try {
    parsed = parse(contents) ?? {};
  } catch (error) {
    errors.push(
      `workflow template at ${templatePath} could not be parsed: ${errorMessage(error)}`
    );
    return undefined;
  }
  if (!isRecord(parsed)) {
    errors.push(`workflow template at ${templatePath} must be a mapping`);
    return undefined;
  }

  const entry = stringProperty(parsed, "entry");
  if (entry === undefined) {
    errors.push(`workflow template at ${templatePath} must define entry`);
  }
  const states = recordProperty(parsed, "states");
  if (states === undefined) {
    errors.push(`workflow template at ${templatePath} must define states`);
  }
  const exits = parseStringMap(
    parsed.exits,
    `workflow template at ${templatePath} exits`,
    errors
  );

  return {
    contents,
    entry: entry ?? "",
    exits,
    inputs: parseWorkflowTemplateInputs(parsed.inputs, templatePath, errors),
    path: templatePath,
    states: states ?? {}
  };
}

function parseWorkflowTemplateInputs(
  rawInputs: unknown,
  templatePath: string,
  errors: string[]
): Record<string, WorkflowTemplateInput> {
  if (rawInputs === undefined) {
    return {};
  }
  if (!isRecord(rawInputs)) {
    errors.push(`workflow template at ${templatePath} inputs must be a mapping`);
    return {};
  }
  const inputs: Record<string, WorkflowTemplateInput> = {};
  for (const [name, rawInput] of Object.entries(rawInputs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`workflow template input ${name} at ${templatePath} must be an identifier`);
      continue;
    }
    if (!isRecord(rawInput)) {
      errors.push(`workflow template input ${name} at ${templatePath} must be a mapping`);
      continue;
    }
    const type = stringProperty(rawInput, "type");
    if (!isWorkflowTemplateInputType(type)) {
      errors.push(
        `workflow template input ${name} at ${templatePath} type must be one of boolean, label, number, path, provider, string`
      );
      continue;
    }
    const defaultValue = Object.hasOwn(rawInput, "default")
      ? validateWorkflowTemplateInputValue(
          name,
          type,
          rawInput.default,
          templatePath,
          errors
        )
      : undefined;
    inputs[name] = {
      type,
      ...(defaultValue === undefined ? {} : { defaultValue })
    };
  }
  return inputs;
}

function expandWorkflowTemplateUse(
  loaded: LoadedWorkflowTemplateUse,
  templateEntryTargets: Map<string, string>,
  workflowPath: string,
  errors: string[]
): WorkflowTemplateUseExpansion {
  const { template, use } = loaded;
  const inputValues = resolveWorkflowTemplateInputs(template, use, errors);
  const templateExitStates = templateExitStateMap(template, errors);
  const expandedStates: ExpandedWorkflowState[] = [];
  const unresolvedExitTargets = new Set<string>();
  for (const exitName of Object.keys(use.exitMappings)) {
    if (!Object.hasOwn(template.exits, exitName)) {
      errors.push(
        `workflow template instance ${use.id} at ${workflowPath} maps undeclared exit ${exitName} from ${template.path}`
      );
    }
  }
  if (!Object.hasOwn(template.states, template.entry)) {
    errors.push(`workflow template at ${template.path} entry state ${template.entry} is not declared`);
  }

  for (const [stateId, rawState] of Object.entries(template.states)) {
    const exitName = templateExitStates.get(stateId);
    if (
      exitName !== undefined &&
      (Object.hasOwn(use.exitMappings, exitName) ||
        !isTemplateTerminalState(template, stateId))
    ) {
      continue;
    }
    const expandedStateId = `${use.id}.${stateId}`;
    const interpolated = interpolateWorkflowTemplateValue(
      rawState,
      inputValues,
      template.path,
      errors
    );
    const state = parseWorkflowState(expandedStateId, interpolated, template.path, errors);
    state.transitions = state.transitions.map((transition) => ({
      ...transition,
      to: rewriteTemplateTransitionTarget(
        stateId,
        transition.to,
        loaded,
        templateExitStates,
        templateEntryTargets,
        unresolvedExitTargets,
        workflowPath,
        errors
      )
    }));
    expandedStates.push(state);
  }
  return { states: expandedStates, unresolvedExitTargets };
}

function templateExitStateMap(
  template: ParsedWorkflowTemplate,
  errors: string[]
): Map<string, string> {
  const exitStates = new Map<string, string>();
  for (const [exitName, targetState] of Object.entries(template.exits)) {
    if (!Object.hasOwn(template.states, targetState)) {
      errors.push(
        `workflow template at ${template.path} exit ${exitName} targets unknown state ${targetState}`
      );
      continue;
    }
    const rawState = template.states[targetState];
    if (!isRecord(rawState)) {
      errors.push(`workflow template state ${targetState} at ${template.path} must be a mapping`);
      continue;
    }
    const existingExitName = exitStates.get(targetState);
    if (existingExitName !== undefined) {
      errors.push(
        `workflow template at ${template.path} exits ${existingExitName} and ${exitName} both target state ${targetState}`
      );
      continue;
    }
    const terminal = stringProperty(rawState, "terminal");
    if (terminal !== undefined && terminalStates.has(terminal)) {
      exitStates.set(targetState, exitName);
      continue;
    }
    const declaredExit = stringProperty(rawState, "exit");
    if (declaredExit !== exitName) {
      errors.push(
        `workflow template at ${template.path} exit ${exitName} must target a state declaring exit: ${exitName}`
      );
      continue;
    }
    exitStates.set(targetState, exitName);
  }
  return exitStates;
}

function rewriteTemplateTransitionTarget(
  fromStateId: string,
  target: string,
  loaded: LoadedWorkflowTemplateUse,
  templateExitStates: Map<string, string>,
  templateEntryTargets: Map<string, string>,
  unresolvedExitTargets: Set<string>,
  workflowPath: string,
  errors: string[]
): string {
  const { template, use } = loaded;
  if (!Object.hasOwn(template.states, target)) {
    errors.push(
      `workflow template state ${fromStateId} at ${template.path} transitions to ${target} outside declared exits`
    );
    return target;
  }

  const exitName = templateExitStates.get(target);
  if (exitName === undefined) {
    return `${use.id}.${target}`;
  }

  const mappedTarget = use.exitMappings[exitName];
  if (mappedTarget === undefined) {
    if (isTemplateTerminalState(template, target)) {
      return `${use.id}.${target}`;
    }
    const unresolvedTarget = `${use.id}.${target}`;
    unresolvedExitTargets.add(unresolvedTarget);
    errors.push(
      `workflow template instance ${use.id} at ${workflowPath} must map exit ${exitName}`
    );
    return unresolvedTarget;
  }
  return templateEntryTargets.get(mappedTarget) ?? mappedTarget;
}

function isTemplateTerminalState(
  template: ParsedWorkflowTemplate,
  stateId: string
): boolean {
  const state = template.states[stateId];
  if (!isRecord(state)) {
    return false;
  }
  const terminal = stringProperty(state, "terminal");
  return terminal !== undefined && terminalStates.has(terminal);
}

function parseWorkflowState(
  stateId: string,
  rawState: unknown,
  workflowPath: string,
  errors: string[]
): ExpandedWorkflowState {
  if (!isPathSafeIdentifier(stateId)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} must use a path-safe identifier`
    );
  }

  if (!isRecord(rawState)) {
    errors.push(`workflow state ${stateId} at ${workflowPath} must be a mapping`);
    return {
      completeWhen: {},
      id: stateId,
      transitions: []
    };
  }

  const action = parseWorkflowAction(stateId, rawState.action, workflowPath, errors);
  const completeWhen = parsePredicateMap(
    stateId,
    "complete_when",
    rawState.complete_when,
    workflowPath,
    errors
  );
  const transitions = parseWorkflowTransitions(
    stateId,
    rawState.transitions,
    workflowPath,
    errors
  );
  const terminal = stringProperty(rawState, "terminal");
  if (rawState.terminal !== undefined && !terminalStates.has(terminal ?? "")) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} terminal must be success, blocked, or failure`
    );
  }
  if (terminal !== undefined) {
    const disallowedFields = [
      ...(rawState.action === undefined ? [] : ["action"]),
      ...(rawState.complete_when === undefined ? [] : ["complete_when"]),
      ...(rawState.transitions === undefined ? [] : ["transitions"])
    ];
    if (disallowedFields.length > 0) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} terminal states must not define ${formatTerminalStateDisallowedFields(disallowedFields)}`
      );
    }
  }
  if (action === undefined && terminal === undefined) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} must define action or terminal`
    );
  }

  return {
    ...(action === undefined ? {} : { action }),
    completeWhen,
    id: stateId,
    ...(terminal === undefined ? {} : { terminal }),
    transitions
  };
}

function formatTerminalStateDisallowedFields(fields: string[]): string {
  if (fields.length < 2) {
    return fields[0] ?? "";
  }
  const prefix = fields.slice(0, -1).join(", ");
  const last = fields[fields.length - 1] ?? "";
  return fields.length === 2 ? `${prefix} or ${last}` : `${prefix}, or ${last}`;
}

function parseWorkflowAction(
  stateId: string,
  rawAction: unknown,
  workflowPath: string,
  errors: string[]
): WorkflowAction | undefined {
  if (rawAction === undefined) {
    return undefined;
  }
  if (!isRecord(rawAction)) {
    errors.push(`workflow state ${stateId} at ${workflowPath} action must be a mapping`);
    return undefined;
  }

  const rawKind = stringProperty(rawAction, "kind");
  if (rawKind === undefined || !actionKinds.has(rawKind as WorkflowActionKind)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} action.kind must be one of ${[...actionKinds].join(", ")}`
    );
    return undefined;
  }

  const kind = rawKind as WorkflowActionKind;
  const provider = stringProperty(rawAction, "provider");
  const prompt = stringProperty(rawAction, "prompt");
  const method = stringProperty(rawAction, "method");

  if (kind === "agent") {
    if (
      provider !== undefined &&
      provider !== "codex" &&
      provider !== "claude"
    ) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} agent action provider must be codex or claude`
      );
    }
    if (prompt === undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} agent action must define prompt`
      );
    }
  }

  if (kind === "wait") {
    if (provider !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} wait action must not define provider`
      );
    }
    if (prompt !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} wait action must not define prompt`
      );
    }
  }

  if (kind === "merge_pr") {
    if (provider !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} merge_pr action must not define provider`
      );
    }
    if (prompt !== undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} merge_pr action must not define prompt`
      );
    }
    if (method !== undefined && !mergeMethods.has(method)) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} merge_pr method must be one of ${[...mergeMethods].join(", ")}`
      );
    }
  }

  return {
    kind,
    ...(method === undefined ? {} : { method }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(provider === "codex" || provider === "claude" ? { provider } : {})
  };
}

function parseWorkflowTransitions(
  stateId: string,
  rawTransitions: unknown,
  workflowPath: string,
  errors: string[]
): WorkflowTransition[] {
  if (rawTransitions === undefined) {
    return [];
  }
  if (!Array.isArray(rawTransitions)) {
    errors.push(
      `workflow state ${stateId} at ${workflowPath} transitions must be a sequence`
    );
    return [];
  }

  const transitions: WorkflowTransition[] = [];
  for (const [index, rawTransition] of rawTransitions.entries()) {
    if (!isRecord(rawTransition)) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} transition ${index} must be a mapping`
      );
      continue;
    }
    const to = stringProperty(rawTransition, "to");
    if (to === undefined) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} transition ${index} must define to`
      );
      continue;
    }
    transitions.push({
      to,
      when: parsePredicateMap(
        stateId,
        `transitions[${index}].when`,
        rawTransition.when,
        workflowPath,
        errors
      )
    });
  }
  return transitions;
}

function parsePredicateMap(
  stateId: string,
  field: string,
  rawValue: unknown,
  workflowPath: string,
  errors: string[]
): WorkflowPredicateMap {
  if (rawValue === undefined) {
    return {};
  }
  if (!isRecord(rawValue)) {
    errors.push(`workflow state ${stateId} at ${workflowPath} ${field} must be a mapping`);
    return {};
  }

  const predicates: WorkflowPredicateMap = {};
  for (const [key, value] of Object.entries(rawValue)) {
    if (!completionPredicateKeys.has(key)) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} ${field} uses unknown predicate ${key}`
      );
      continue;
    }
    if (
      typeof value !== "boolean" &&
      typeof value !== "number" &&
      typeof value !== "string"
    ) {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} ${field}.${key} must be a scalar`
      );
      continue;
    }
    predicates[key] = value;
  }
  return predicates;
}

function markdownCompatibilityWorkflow(
  workflow: WorkflowContract
): ExpandedWorkflow {
  return {
    contentHash: workflow.contentHash,
    initial: "run_agent",
    name: "single_agent_workflow",
    source: {
      kind: "markdown",
      path: workflow.path
    },
    states: [
      {
        action: {
          kind: "agent"
        },
        completeWhen: {
          branch_ahead_of_base: true,
          provider_success: true
        },
        id: "run_agent",
        transitions: [
          {
            to: "done",
            when: {}
          }
        ]
      },
      {
        completeWhen: {},
        id: "done",
        terminal: "success",
        transitions: []
      }
    ],
    templateFiles: []
  };
}

function formatWorkflowAction(action: WorkflowAction): string {
  const parts = [`${action.kind}`];
  if (action.provider !== undefined) {
    parts.push(`provider=${action.provider}`);
  }
  if (action.prompt !== undefined) {
    parts.push(`prompt=${action.prompt}`);
  }
  if (action.method !== undefined) {
    parts.push(`method=${action.method}`);
  }
  return parts.join(" ");
}

function formatPredicateMap(predicates: WorkflowPredicateMap): string {
  return Object.entries(predicates)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function stringProperty(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function recordProperty(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function parseStringMap(
  rawValue: unknown,
  fieldLabel: string,
  errors: string[]
): Record<string, string> {
  if (rawValue === undefined) {
    return {};
  }
  if (!isRecord(rawValue)) {
    errors.push(`${fieldLabel} must be a mapping`);
    return {};
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawValue)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`${fieldLabel}.${key} must be a non-empty string`);
      continue;
    }
    values[key] = value.trim();
  }
  return values;
}

function parseUnknownMap(
  rawValue: unknown,
  fieldLabel: string,
  errors: string[]
): Record<string, unknown> {
  if (rawValue === undefined) {
    return {};
  }
  if (!isRecord(rawValue)) {
    errors.push(`${fieldLabel} must be a mapping`);
    return {};
  }
  return rawValue;
}

function resolveWorkflowTemplateInputs(
  template: ParsedWorkflowTemplate,
  use: WorkflowTemplateUse,
  errors: string[]
): Record<string, WorkflowTemplateScalar> {
  const values: Record<string, WorkflowTemplateScalar> = {};

  for (const key of Object.keys(use.withValues)) {
    if (!Object.hasOwn(template.inputs, key)) {
      errors.push(
        `workflow template instance ${use.id} at ${template.path} supplies undeclared input ${key}`
      );
    }
  }

  for (const [name, input] of Object.entries(template.inputs)) {
    const rawValue = Object.hasOwn(use.withValues, name)
      ? use.withValues[name]
      : input.defaultValue;
    if (rawValue === undefined) {
      errors.push(
        `workflow template instance ${use.id} at ${template.path} must provide input ${name}`
      );
      continue;
    }
    const value = validateWorkflowTemplateInputValue(
      name,
      input.type,
      rawValue,
      template.path,
      errors
    );
    if (value !== undefined) {
      values[name] = value;
    }
  }

  return values;
}

function validateWorkflowTemplateInputValue(
  inputName: string,
  inputType: WorkflowTemplateInputType,
  value: unknown,
  templatePath: string,
  errors: string[]
): WorkflowTemplateScalar | undefined {
  if (inputType === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
  } else if (inputType === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  } else if (inputType === "provider") {
    if (value === "codex" || value === "claude") {
      return value;
    }
  } else if (typeof value === "string" && value.trim().length > 0) {
    if (inputType !== "path" || !value.includes("\0")) {
      return value.trim();
    }
  }

  errors.push(
    `workflow template input ${inputName} at ${templatePath} must be a ${inputType} scalar`
  );
  return undefined;
}

function interpolateWorkflowTemplateValue(
  value: unknown,
  inputValues: Record<string, WorkflowTemplateScalar>,
  templatePath: string,
  errors: string[]
): unknown {
  if (typeof value === "string") {
    return interpolateWorkflowTemplateString(value, inputValues, templatePath, errors);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      interpolateWorkflowTemplateValue(item, inputValues, templatePath, errors)
    );
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = interpolateWorkflowTemplateValue(
        nested,
        inputValues,
        templatePath,
        errors
      );
    }
    return result;
  }
  return value;
}

function interpolateWorkflowTemplateString(
  value: string,
  inputValues: Record<string, WorkflowTemplateScalar>,
  templatePath: string,
  errors: string[]
): WorkflowTemplateScalar {
  const exact = /^{{\s*([^{}]+?)\s*}}$/.exec(value);
  if (exact !== null) {
    const expression = exact[1]?.trim() ?? "";
    const input = workflowTemplateInputValue(expression, inputValues, templatePath, errors);
    return input ?? value;
  }

  return value.replace(tagPattern, (_tag, expression) => {
    const input = workflowTemplateInputValue(
      String(expression).trim(),
      inputValues,
      templatePath,
      errors
    );
    return input === undefined ? "" : String(input);
  });
}

function workflowTemplateInputValue(
  expression: string,
  inputValues: Record<string, WorkflowTemplateScalar>,
  templatePath: string,
  errors: string[]
): WorkflowTemplateScalar | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) {
    errors.push(`workflow template at ${templatePath} has unsupported tag {{${expression}}}`);
    return undefined;
  }
  if (!Object.hasOwn(inputValues, expression)) {
    errors.push(
      `workflow template at ${templatePath} references unknown input {{${expression}}}`
    );
    return undefined;
  }
  return inputValues[expression];
}

function isWorkflowTemplateInputType(
  value: string | undefined
): value is WorkflowTemplateInputType {
  return (
    value === "boolean" ||
    value === "label" ||
    value === "number" ||
    value === "path" ||
    value === "provider" ||
    value === "string"
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isPathSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

export async function persistRunEvidence(
  input: PersistRunEvidenceInput
): Promise<RunEvidencePaths> {
  const runEvidenceDirectory = path.join(
    path.resolve(input.stateRoot),
    "logs",
    "runs",
    safePathSegment(input.run.id)
  );

  if (isPathInside(runEvidenceDirectory, input.workspace.path)) {
    throw new Error(
      `run evidence directory ${runEvidenceDirectory} must be outside issue workspace ${input.workspace.path}`
    );
  }

  await mkdir(runEvidenceDirectory, { recursive: true });

  const promptPath = path.join(
    runEvidenceDirectory,
    attemptEvidenceFileName("prompt", input.attemptNumber, "md")
  );
  const metadataPath = path.join(
    runEvidenceDirectory,
    attemptEvidenceFileName("prompt-metadata", input.attemptNumber, "json")
  );
  const issueSnapshotPath = path.join(
    runEvidenceDirectory,
    attemptEvidenceFileName("issue-snapshot", input.attemptNumber, "json")
  );
  const workflowGraphPath = path.join(
    runEvidenceDirectory,
    workflowGraphFileName(input.attemptNumber)
  );
  const metadata = {
    autonomy_preamble_version: input.renderedPrompt.preambleVersion,
    branch: input.branch,
    issue_snapshot_path: issueSnapshotPath,
    prompt_path: promptPath,
    project: input.project,
    provider: input.provider,
    run: input.run,
    extra_instructions: input.extraInstructions !== undefined,
    workspace: input.workspace,
    workflow: {
      content_hash: input.renderedPrompt.workflowContentHash,
      graph_path: workflowGraphPath,
      path: input.workflowPath
    }
  };

  await Promise.all([
    writeFile(promptPath, input.renderedPrompt.prompt, "utf8"),
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    writeFile(
      issueSnapshotPath,
      `${JSON.stringify(input.issue, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      workflowGraphPath,
      `${JSON.stringify(input.expandedWorkflow, null, 2)}\n`,
      "utf8"
    )
  ]);

  return {
    issueSnapshotPath,
    metadataPath,
    promptPath,
    runEvidenceDirectory,
    workflowGraphPath
  };
}

function workflowGraphFileName(attemptNumber: number): string {
  return attemptEvidenceFileName("workflow-graph", attemptNumber, "json");
}

function attemptEvidenceFileName(
  stem: string,
  attemptNumber: number,
  extension: string
): string {
  return attemptNumber === 1
    ? `${stem}.${extension}`
    : `${stem}.attempt-${attemptNumber}.${extension}`;
}

function previousAttemptNotice(workspace: PromptWorkspace): string {
  if (!workspace.previous_attempt) {
    return "";
  }

  return [
    "## Previous-attempt workspace",
    "",
    "This workspace was reused from an earlier attempt for this issue; inspect the existing work before editing.",
    "Check git status, local commits, notes, logs, and partial changes so useful prior progress is preserved.",
    ""
  ].join("\n");
}

function resolveTemplateValue(
  expression: string,
  context: PromptContext,
  workflowPath: string
): unknown {
  const expressionError = templateExpressionError(expression, workflowPath);
  if (expressionError !== undefined) {
    throw new Error(expressionError);
  }

  const parts = expression.split(".");
  const topLevel = parts[0];

  if (topLevel === undefined || !isPromptObjectName(topLevel)) {
    throw new Error("unreachable validated template expression");
  }

  const field = parts[1];
  if (field === undefined) {
    return context[topLevel];
  }

  return context[topLevel][field as keyof (typeof context)[typeof topLevel]];
}

function stringifyTemplateValue(value: unknown, workflowPath: string): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  if (value === null || value === undefined) {
    throw new Error(
      `workflow template at ${workflowPath} resolved to an empty value`
    );
  }

  return JSON.stringify(value);
}

function isPromptObjectName(input: string): input is keyof PromptContext {
  return Object.hasOwn(allowedTemplateFields, input);
}

function templateExpressionError(
  expression: string,
  workflowPath: string
): string | undefined {
  const parts = expression.split(".");
  const topLevel = parts[0];

  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(expression)) {
    return `workflow template at ${workflowPath} has unsupported tag {{${expression}}}`;
  }

  if (topLevel === undefined || !isPromptObjectName(topLevel)) {
    return `workflow template at ${workflowPath} references unknown variable {{${expression}}}`;
  }

  const field = parts[1];
  if (field !== undefined && !allowedTemplateFields[topLevel].has(field)) {
    return `workflow template at ${workflowPath} references unknown variable {{${expression}}}`;
  }

  return undefined;
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

function contentHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function safePathSegment(input: string): string {
  const segment = input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment.length === 0 ? "run" : segment;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
