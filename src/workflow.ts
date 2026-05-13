import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
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

const completionPredicateKeys = new Set([
  "artifact_exists",
  "branch_ahead_of_base",
  "branch_pushed",
  "checks",
  "mergeable",
  "pr_merged",
  "pr_open",
  "provider_success",
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

export function expandWorkflowDefinition(
  contents: string,
  workflowPath: string,
  format: WorkflowFormat = "auto"
): ExpandedWorkflowLoadResult {
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
      contentHash(contents),
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

function expandRawStateMachineWorkflow(
  rawWorkflow: Record<string, unknown>,
  workflowPath: string,
  workflowContentHash: string,
  errors: string[]
): ExpandedWorkflowLoadResult {
  const name = stringProperty(rawWorkflow, "name");
  if (name === undefined) {
    errors.push(`workflow definition at ${workflowPath} must define workflow.name`);
  }

  const initial = stringProperty(rawWorkflow, "initial");
  if (initial === undefined) {
    errors.push(`workflow definition at ${workflowPath} must define workflow.initial`);
  }

  const rawStates = recordProperty(rawWorkflow, "states");
  if (rawStates === undefined) {
    errors.push(`workflow definition at ${workflowPath} must define workflow.states`);
  }

  const states: ExpandedWorkflowState[] = [];
  if (rawStates !== undefined) {
    for (const [stateId, rawState] of Object.entries(rawStates)) {
      states.push(parseWorkflowState(stateId, rawState, workflowPath, errors));
    }
  }

  const stateIds = new Set(states.map((state) => state.id));
  if (initial !== undefined && !stateIds.has(initial)) {
    errors.push(
      `workflow definition at ${workflowPath} initial state ${initial} is not declared`
    );
  }
  for (const state of states) {
    for (const transition of state.transitions) {
      if (!stateIds.has(transition.to)) {
        errors.push(
          `workflow state ${state.id} at ${workflowPath} transitions to unknown state ${transition.to}`
        );
      }
    }
  }

  return {
    errors,
    workflow: {
      contentHash: workflowContentHash,
      initial: initial ?? "",
      name: name ?? path.basename(workflowPath, path.extname(workflowPath)),
      source: {
        kind: "raw_fsm",
        path: workflowPath
      },
      states,
      templateFiles: []
    }
  };
}

function parseWorkflowState(
  stateId: string,
  rawState: unknown,
  workflowPath: string,
  errors: string[]
): ExpandedWorkflowState {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(stateId)) {
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
    if (provider !== "codex" && provider !== "claude") {
      errors.push(
        `workflow state ${stateId} at ${workflowPath} agent action must define provider codex or claude`
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

  const promptPath = path.join(runEvidenceDirectory, "prompt.md");
  const metadataPath = path.join(runEvidenceDirectory, "prompt-metadata.json");
  const issueSnapshotPath = path.join(runEvidenceDirectory, "issue-snapshot.json");
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
  return attemptNumber === 1
    ? "workflow-graph.json"
    : `workflow-graph.attempt-${attemptNumber}.json`;
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
