import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import type { AgentProviderName } from "../provider.js";
import type { RoutineDeclaration, RoutineKind } from "./types.js";

export type RoutineDeclarationLoadResult = {
  errors: string[];
  routine: RoutineDeclaration | null;
};

const providerNames = new Set(["codex", "claude"]);
const routineKinds = new Set(["report"]);

export async function loadRoutineDeclaration(
  routinePath: string
): Promise<RoutineDeclarationLoadResult> {
  const absolutePath = path.resolve(routinePath);
  let contents: string;
  try {
    contents = await readFile(absolutePath, "utf8");
  } catch (error) {
    return {
      errors: [
        `routine declaration not found at ${absolutePath}: ${errorMessage(error)}`
      ],
      routine: null
    };
  }

  return parseRoutineDeclaration(contents, absolutePath);
}

export function parseRoutineDeclaration(
  contents: string,
  routinePath: string
): RoutineDeclarationLoadResult {
  const lines = contents.split(/\r?\n/);
  const errors: string[] = [];

  if (lines[0]?.trim() !== "---") {
    return {
      errors: [`routine at ${routinePath} must start with YAML front matter`],
      routine: null
    };
  }

  const closingLine = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---"
  );
  if (closingLine === -1) {
    return {
      errors: [
        `routine front matter at ${routinePath} is missing a closing ---`
      ],
      routine: null
    };
  }

  const frontMatter = parseFrontMatter(
    lines.slice(1, closingLine).join("\n"),
    routinePath,
    errors
  );
  const prompt = lines.slice(closingLine + 1).join("\n");

  if (frontMatter === null) {
    return { errors, routine: null };
  }

  const name = stringField(frontMatter, "name");
  if (name === undefined) {
    errors.push(`routine at ${routinePath} name is required`);
  } else if (!isPathSafeRoutineName(name)) {
    errors.push(`routine at ${routinePath} name "${name}" is not path-safe`);
  }

  const kind = stringField(frontMatter, "kind");
  if (kind === undefined) {
    errors.push(`routine at ${routinePath} kind is required`);
  } else if (!routineKinds.has(kind)) {
    errors.push(`routine at ${routinePath} kind must be report`);
  }

  const providerValue = stringField(frontMatter, "provider");
  let provider: AgentProviderName | null = null;
  if (providerValue !== undefined) {
    if (!providerNames.has(providerValue)) {
      errors.push(`routine at ${routinePath} provider must be codex or claude`);
    } else {
      provider = providerValue as AgentProviderName;
    }
  }

  const schedule = recordField(frontMatter, "schedule");
  const at =
    schedule === undefined ? undefined : dateStringField(schedule, "at");
  if (schedule === undefined || at === undefined) {
    errors.push(`routine at ${routinePath} schedule.at is required`);
  } else if (Number.isNaN(new Date(at).getTime())) {
    errors.push(
      `routine at ${routinePath} schedule.at must be a valid ISO 8601 date`
    );
  }
  if (schedule !== undefined) {
    const scheduleKeys = Object.keys(schedule);
    if (scheduleKeys.length !== 1 || scheduleKeys[0] !== "at") {
      errors.push(
        `routine at ${routinePath} schedule must define only one schedule field; supported in this slice: at`
      );
    }
  }

  if (prompt.trim().length === 0) {
    errors.push(`routine at ${routinePath} prompt body must not be empty`);
  }

  if (errors.length > 0) {
    return { errors, routine: null };
  }

  return {
    errors: [],
    routine: {
      kind: kind as RoutineKind,
      name: name!,
      prompt,
      provider,
      schedule: { at: at! },
      sourcePath: routinePath
    }
  };
}

function parseFrontMatter(
  source: string,
  routinePath: string,
  errors: string[]
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = parse(source) ?? {};
  } catch (error) {
    errors.push(
      `routine front matter at ${routinePath} could not be parsed: ${errorMessage(error)}`
    );
    return null;
  }
  if (!isRecord(parsed)) {
    errors.push(`routine front matter at ${routinePath} must be a mapping`);
    return null;
  }
  return parsed;
}

function isPathSafeRoutineName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}

function recordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function dateStringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
