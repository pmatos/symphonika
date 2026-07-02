import { createHash } from "node:crypto";

import {
  AUTONOMY_PREAMBLE,
  AUTONOMY_PREAMBLE_VERSION
} from "../workflow/autonomous-prompt.js";
import type { RoutineKind } from "./types.js";

export type RoutinePromptInput = {
  firing: {
    id: string;
  };
  project: {
    name: string;
  };
  provider: {
    command: string;
    name: "codex" | "claude";
  };
  routine: {
    kind: RoutineKind;
    name: string;
    schedule_at: string;
    source_path: string;
  };
  template: string;
  templatePath: string;
  workspace: {
    path: string;
    root: string;
  };
};

export type RenderedRoutinePrompt = {
  preambleVersion: string;
  prompt: string;
  templateContentHash: string;
};

type RoutinePromptContext = Pick<
  RoutinePromptInput,
  "firing" | "project" | "provider" | "routine" | "workspace"
>;

const allowedTemplateFields: Record<
  keyof RoutinePromptContext,
  ReadonlySet<string>
> = {
  firing: new Set(["id"]),
  project: new Set(["name"]),
  provider: new Set(["command", "name"]),
  routine: new Set(["kind", "name", "schedule_at", "source_path"]),
  workspace: new Set(["path", "root"])
};

const tagPattern = /{{\s*([^{}]+?)\s*}}/g;

export class RoutinePromptRenderError extends Error {
  readonly terminalReason = "prompt_render_error";

  constructor(message: string) {
    super(`prompt_render_error: ${message}`);
    this.name = "RoutinePromptRenderError";
  }
}

export function renderRoutinePrompt(
  input: RoutinePromptInput
): RenderedRoutinePrompt {
  const context: RoutinePromptContext = {
    firing: input.firing,
    project: input.project,
    provider: input.provider,
    routine: input.routine,
    workspace: input.workspace
  };
  const rendered = input.template.replace(tagPattern, (_tag, expression) =>
    stringifyTemplateValue(
      resolveTemplateValue(
        String(expression).trim(),
        context,
        input.templatePath
      ),
      input.templatePath
    )
  );

  return {
    preambleVersion: AUTONOMY_PREAMBLE_VERSION,
    prompt: [AUTONOMY_PREAMBLE, rendered].join("\n"),
    templateContentHash: contentHash(input.template)
  };
}

function resolveTemplateValue(
  expression: string,
  context: RoutinePromptContext,
  templatePath: string
): unknown {
  const error = templateExpressionError(expression, templatePath);
  if (error !== undefined) {
    throw new RoutinePromptRenderError(error);
  }

  const [topLevel, field] = expression.split(".");
  if (topLevel === undefined || !isRoutinePromptObjectName(topLevel)) {
    throw new RoutinePromptRenderError(
      `routine template at ${templatePath} references unknown variable {{${expression}}}`
    );
  }

  if (field === undefined) {
    return context[topLevel];
  }

  return context[topLevel][field as keyof (typeof context)[typeof topLevel]];
}

function stringifyTemplateValue(value: unknown, templatePath: string): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  if (value === null || value === undefined) {
    throw new RoutinePromptRenderError(
      `routine template at ${templatePath} resolved to an empty value`
    );
  }

  return JSON.stringify(value);
}

function templateExpressionError(
  expression: string,
  templatePath: string
): string | undefined {
  const parts = expression.split(".");
  const topLevel = parts[0];

  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(expression)) {
    return `routine template at ${templatePath} has unsupported tag {{${expression}}}`;
  }

  if (topLevel === undefined || !isRoutinePromptObjectName(topLevel)) {
    return `routine template at ${templatePath} references unknown variable {{${expression}}}`;
  }

  const field = parts[1];
  if (field !== undefined && !allowedTemplateFields[topLevel].has(field)) {
    return `routine template at ${templatePath} references unknown variable {{${expression}}}`;
  }

  return undefined;
}

function isRoutinePromptObjectName(
  input: string
): input is keyof RoutinePromptContext {
  return Object.hasOwn(allowedTemplateFields, input);
}

function contentHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}
