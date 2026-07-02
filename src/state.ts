import path from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

import {
  defaultUserStateRoot,
  isDefaultUserConfigPath,
  resolveServiceConfigPath
} from "./config-paths.js";

export type StateRootResolution = {
  configPath: string;
  configDir: string;
  configExists: boolean;
  stateRoot: string;
};

export type ResolveStateRootOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

const serviceConfigSchema = z
  .object({
    state: z
      .object({
        root: z.string().min(1).optional()
      })
      .optional()
  })
  .passthrough();

export function resolveStateRoot(
  options: ResolveStateRootOptions = {}
): StateRootResolution {
  const resolvedConfig = resolveServiceConfigPath(options);
  const configPath = resolvedConfig.configPath;
  const configDir = resolvedConfig.configDir;
  const homeDir = options.homeDir ?? homedir();
  const configExists = resolvedConfig.configExists;
  const configuredStateRoot = configExists
    ? readConfiguredStateRoot(configPath)
    : undefined;
  const defaultStateRoot = isDefaultUserConfigPath(configPath, options)
    ? defaultUserStateRoot(options)
    : path.join(configDir, ".symphonika");

  return {
    configPath,
    configDir,
    configExists,
    stateRoot:
      configuredStateRoot === undefined
        ? defaultStateRoot
        : resolveConfiguredPath(configuredStateRoot, configDir, homeDir)
  };
}

function readConfiguredStateRoot(configPath: string): string | undefined {
  const config: unknown = parse(readFileSync(configPath, "utf8")) ?? {};
  const parsed = serviceConfigSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid service config: ${parsed.error.message}`);
  }

  return parsed.data.state?.root;
}

function resolveConfiguredPath(
  input: string,
  baseDir: string,
  homeDir: string
): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }

  return path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(baseDir, input);
}
