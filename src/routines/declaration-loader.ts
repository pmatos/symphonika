import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import type { AgentProviderName } from "../provider.js";
import { isIanaTimezone, normalizeRoutineCron } from "./schedule.js";
import type {
  RoutineDeclaration,
  RoutineKind,
  RoutineSchedule
} from "./types.js";

export type RoutineDeclarationLoadResult = {
  errors: string[];
  routine: RoutineDeclaration | null;
};

const providerNames = new Set(["codex", "claude"]);
const routineKinds = new Set(["git", "report"]);

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
    errors.push(`routine at ${routinePath} kind must be git or report`);
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
  const parsedSchedule = parseRoutineSchedule(schedule, routinePath, errors);

  const catchUpValue = stringField(frontMatter, "catch_up");
  if (
    Object.hasOwn(frontMatter, "catch_up") &&
    catchUpValue !== "fire_once_if_missed"
  ) {
    errors.push(
      `routine at ${routinePath} catch_up must be fire_once_if_missed`
    );
  }
  const allowOverlapValue = frontMatter.allow_overlap;
  if (
    Object.hasOwn(frontMatter, "allow_overlap") &&
    typeof allowOverlapValue !== "boolean"
  ) {
    errors.push(`routine at ${routinePath} allow_overlap must be a boolean`);
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
      allowOverlap:
        typeof allowOverlapValue === "boolean" ? allowOverlapValue : false,
      catchUp:
        catchUpValue === "fire_once_if_missed" ? "fire_once_if_missed" : "skip",
      kind: kind as RoutineKind,
      name: name!,
      prompt,
      provider,
      schedule: parsedSchedule!,
      sourcePath: routinePath
    }
  };
}

function parseRoutineSchedule(
  schedule: Record<string, unknown> | undefined,
  routinePath: string,
  errors: string[]
): RoutineSchedule | undefined {
  if (schedule === undefined) {
    errors.push(
      `routine at ${routinePath} schedule must define exactly one of schedule.at or schedule.cron`
    );
    return undefined;
  }

  const at = dateStringField(schedule, "at");
  const cron = stringField(schedule, "cron");
  if ((at === undefined) === (cron === undefined)) {
    errors.push(
      `routine at ${routinePath} schedule must define exactly one of schedule.at or schedule.cron`
    );
    return undefined;
  }

  if (at !== undefined) {
    if (Object.keys(schedule).some((key) => key !== "at")) {
      errors.push(
        `routine at ${routinePath} schedule.at cannot be combined with other schedule fields`
      );
      return undefined;
    }
    if (Number.isNaN(new Date(at).getTime())) {
      errors.push(
        `routine at ${routinePath} schedule.at must be a valid ISO 8601 date`
      );
      return undefined;
    }
    return { at };
  }

  if (Object.keys(schedule).some((key) => key !== "cron" && key !== "tz")) {
    errors.push(
      `routine at ${routinePath} schedule.cron supports only the optional schedule.tz field`
    );
    return undefined;
  }
  const configuredTimezone = stringField(schedule, "tz");
  if (Object.hasOwn(schedule, "tz") && configuredTimezone === undefined) {
    errors.push(
      `routine at ${routinePath} schedule.tz must be a non-empty IANA timezone`
    );
    return undefined;
  }
  const tz = configuredTimezone ?? "Etc/UTC";
  if (!isIanaTimezone(tz)) {
    errors.push(
      `routine at ${routinePath} schedule.tz "${tz}" is not a valid IANA timezone`
    );
    return undefined;
  }
  try {
    return { cron: normalizeRoutineCron(cron!), tz };
  } catch (error) {
    errors.push(
      `routine at ${routinePath} schedule.cron is invalid: ${errorMessage(error)}`
    );
    return undefined;
  }
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
