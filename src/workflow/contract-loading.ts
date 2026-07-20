import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

import type { WorkflowFormat } from "../config-schemas.js";
import { validatePromptTemplateExpressions } from "./autonomous-prompt.js";

export type WorkflowContract = {
  body: string;
  contentHash: string;
  evidence: WorkflowEvidence;
  errors: string[];
  path: string;
};

export type WorkflowEvidence = {
  ignore: string[];
};

export type ProjectWorkflowReference = {
  name: string;
  workflowFormat: WorkflowFormat;
  workflowPath: string;
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
    return [
      `workflow contract not found at ${workflowPath}: ${errorMessage(error)}`
    ];
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
      evidence: { ignore: [] },
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
      evidence: { ignore: [] },
      errors: [
        `workflow front matter at ${workflowPath} is missing a closing ---`
      ],
      path: workflowPath
    };
  }

  const frontMatterSource = lines.slice(1, closingLine).join("\n");
  const errors: string[] = [];
  const frontMatter = parseFrontMatter(frontMatterSource, workflowPath, errors);
  const evidence = parseWorkflowEvidence(frontMatter, workflowPath, errors);

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
    evidence,
    errors,
    path: workflowPath
  };
}

function parseWorkflowEvidence(
  frontMatter: Record<string, unknown> | undefined,
  workflowPath: string,
  errors: string[]
): WorkflowEvidence {
  const rawEvidence = frontMatter?.evidence;
  if (rawEvidence === undefined) {
    return { ignore: [] };
  }
  if (!isRecord(rawEvidence)) {
    errors.push(
      `workflow front matter at ${workflowPath} evidence must be a mapping`
    );
    return { ignore: [] };
  }
  if (rawEvidence.ignore === undefined) {
    return { ignore: [] };
  }
  if (!Array.isArray(rawEvidence.ignore)) {
    errors.push(
      `workflow front matter at ${workflowPath} evidence.ignore must be a list`
    );
    return { ignore: [] };
  }
  const ignore: string[] = [];
  for (const [index, entry] of rawEvidence.ignore.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push(
        `workflow front matter at ${workflowPath} evidence.ignore[${index}] must be a non-empty string`
      );
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.includes("..")) {
      errors.push(
        `workflow front matter at ${workflowPath} evidence.ignore[${index}] must not contain ..`
      );
      continue;
    }
    if (trimmed.startsWith("/")) {
      errors.push(
        `workflow front matter at ${workflowPath} evidence.ignore[${index}] must be workspace-relative`
      );
      continue;
    }
    ignore.push(trimmed);
  }
  return { ignore };
}

export function validateWorkflowTemplate(
  template: string,
  workflowPath: string
): string[] {
  return validatePromptTemplateExpressions(template, workflowPath);
}

export function projectWorkflowReferences(
  rawProjects: unknown[],
  configPath: string,
  errors: string[]
): ProjectWorkflowReference[] {
  const projects: ProjectWorkflowReference[] = [];
  for (const [index, rawProject] of rawProjects.entries()) {
    if (!isRecord(rawProject)) {
      errors.push(`projects.${index} in ${configPath} must be a mapping`);
      continue;
    }
    const name = stringProperty(rawProject, "name");
    if (name === undefined) {
      errors.push(
        `projects.${index}.name in ${configPath} must be a non-empty string`
      );
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
      errors.push(
        `${fieldLabel}.path in ${configPath} must be a non-empty path`
      );
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
  errors.push(
    `${fieldLabel} in ${configPath} must be a non-empty path or mapping`
  );
  return undefined;
}

export function selectProjectWorkflow(
  projects: ProjectWorkflowReference[],
  requestedProject: string | undefined,
  configPath: string,
  errors: string[]
): ProjectWorkflowReference | undefined {
  if (requestedProject !== undefined) {
    const selected = projects.find(
      (project) => project.name === requestedProject
    );
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
    errors.push(
      `service config ${configPath} does not contain a project workflow`
    );
  } else {
    errors.push(
      `service config ${configPath} has ${projects.length} projects; pass --project`
    );
  }
  return undefined;
}

function parseFrontMatter(
  source: string,
  workflowPath: string,
  errors: string[]
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parse(source) ?? {};
  } catch (error) {
    errors.push(
      `workflow front matter at ${workflowPath} could not be parsed: ${errorMessage(error)}`
    );
    return undefined;
  }
  if (!isRecord(parsed)) {
    errors.push(`workflow front matter at ${workflowPath} must be a mapping`);
    return undefined;
  }
  return parsed;
}

function contentHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringProperty(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
