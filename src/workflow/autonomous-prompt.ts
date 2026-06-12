import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { IssueSnapshot } from "../issue-polling.js";
import { isPathInside } from "../path-safety.js";
import type { ExpandedWorkflow } from "./types.js";

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

const tagPattern = /{{\s*([^{}]+?)\s*}}/g;

export const AUTONOMY_PREAMBLE = [
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

export function validatePromptTemplateExpressions(
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

function contentHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function safePathSegment(input: string): string {
  const segment = input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment.length === 0 ? "run" : segment;
}
