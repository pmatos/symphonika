import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
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
  renderedPrompt: RenderedAutonomousPrompt;
  stateRoot: string;
};

export type RunEvidencePaths = {
  issueSnapshotPath: string;
  metadataPath: string;
  promptPath: string;
  runEvidenceDirectory: string;
};

export type WorkflowContract = {
  body: string;
  contentHash: string;
  errors: string[];
  path: string;
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
  const metadata = {
    autonomy_preamble_version: input.renderedPrompt.preambleVersion,
    branch: input.branch,
    issue_snapshot_path: issueSnapshotPath,
    prompt_path: promptPath,
    project: input.project,
    provider: input.provider,
    run: input.run,
    workspace: input.workspace,
    workflow: {
      content_hash: input.renderedPrompt.workflowContentHash,
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
    )
  ]);

  return {
    issueSnapshotPath,
    metadataPath,
    promptPath,
    runEvidenceDirectory
  };
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
