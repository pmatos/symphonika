import path from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export type StateRootResolution = {
  configPath: string;
  configDir: string;
  configExists: boolean;
  stateRoot: string;
};

export type ResolveStateRootOptions = {
  configPath?: string;
  cwd?: string;
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
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath ?? "symphonika.yml");
  const configDir = path.dirname(configPath);
  const homeDir = options.homeDir ?? homedir();
  const configExists = existsSync(configPath);
  const configuredStateRoot = configExists
    ? readConfiguredStateRoot(configPath)
    : undefined;

  return {
    configPath,
    configDir,
    configExists,
    stateRoot:
      configuredStateRoot === undefined
        ? path.join(configDir, ".symphonika")
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

  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(baseDir, input);
}
