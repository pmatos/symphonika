import { mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

import { resolveServiceConfigPath } from "./config-paths.js";
import type { AgentProviderName } from "./provider.js";
import { RoutineConfigEditor } from "./routines/config-editor.js";
import { parseRoutineDeclaration } from "./routines/declaration-loader.js";
import type { RoutineKind } from "./routines/types.js";

export type AddRoutineOptions = {
  at?: string;
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  kind: RoutineKind;
  name: string;
  project: string;
  provider?: AgentProviderName;
  schedule?: string;
  tz?: string;
};

export type AddRoutineReport = {
  configPath: string;
  errors: string[];
  filePath: string;
  ok: boolean;
  project: string;
  registeredPath: string;
  routineName: string;
};

export async function runAddRoutine(
  options: AddRoutineOptions
): Promise<AddRoutineReport> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveServiceConfigPath({
    ...(options.configPath === undefined
      ? {}
      : { configPath: options.configPath }),
    cwd,
    env: options.env ?? process.env
  }).configPath;
  const filePath = path.resolve(cwd, "routines", `${options.name}.md`);
  const registeredPath = registrationPath(configPath, filePath);
  const errors: string[] = [];
  const report = (ok: boolean): AddRoutineReport => ({
    configPath,
    errors,
    filePath,
    ok,
    project: options.project,
    registeredPath,
    routineName: options.name
  });

  if ((options.schedule === undefined) === (options.at === undefined)) {
    errors.push("exactly one of --schedule or --at must be supplied");
    return report(false);
  }
  if (options.tz !== undefined && options.schedule === undefined) {
    errors.push("--tz may only be supplied with --schedule");
    return report(false);
  }

  const source = routineSource(options);
  const validation = parseRoutineDeclaration(source, filePath);
  if (validation.routine === null) {
    errors.push(...validation.errors);
    return report(false);
  }

  const routinesDirectory = path.dirname(filePath);
  const createdDirectory = await mkdir(routinesDirectory, { recursive: true });
  try {
    await writeFile(filePath, source, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    errors.push(
      isAlreadyExistsError(error)
        ? `routine file already exists at ${filePath}`
        : `routine file could not be created at ${filePath}: ${errorMessage(error)}`
    );
    await removeCreatedDirectory(createdDirectory, routinesDirectory);
    return report(false);
  }

  try {
    await new RoutineConfigEditor(configPath).addRoutine({
      projectName: options.project,
      routinePath: registeredPath
    });
  } catch (error) {
    errors.push(errorMessage(error));
    await unlink(filePath).catch(() => undefined);
    await removeCreatedDirectory(createdDirectory, routinesDirectory);
    return report(false);
  }

  return report(true);
}

function routineSource(options: AddRoutineOptions): string {
  const schedule =
    options.at === undefined
      ? {
          cron: options.schedule,
          ...(options.tz === undefined ? {} : { tz: options.tz })
        }
      : { at: options.at };
  const frontMatter = {
    name: options.name,
    schedule,
    kind: options.kind,
    ...(options.provider === undefined ? {} : { provider: options.provider })
  };
  return [
    "---",
    stringify(frontMatter).trimEnd(),
    "---",
    "",
    "<!-- TODO: Describe what this routine should accomplish. -->",
    "<!-- TODO: Include expected outputs and repository-specific checks. -->",
    ""
  ].join("\n");
}

function registrationPath(configPath: string, filePath: string): string {
  const configDir = path.dirname(configPath);
  const relative = path.relative(configDir, filePath);
  if (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  ) {
    return `./${relative.split(path.sep).join("/")}`;
  }
  return filePath;
}

async function removeCreatedDirectory(
  createdDirectory: string | undefined,
  routinesDirectory: string
): Promise<void> {
  if (createdDirectory !== undefined) {
    await rmdir(routinesDirectory).catch(() => undefined);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
