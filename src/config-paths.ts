import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type ConfigPathSource = "explicit" | "local" | "user";

export type ServiceConfigPathResolution = {
  configDir: string;
  configExists: boolean;
  configPath: string;
  source: ConfigPathSource;
};

export type ResolveServiceConfigPathOptions = {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

const DEFAULT_SERVICE_CONFIG_FILE = "symphonika.yml";
const XDG_CONFIG_SUBDIR = "symphonika";
const XDG_STATE_SUBDIR = "symphonika";

export function resolveServiceConfigPath(
  options: ResolveServiceConfigPathOptions = {}
): ServiceConfigPathResolution {
  const cwd = options.cwd ?? process.cwd();

  if (options.configPath !== undefined) {
    return resolution(path.resolve(cwd, options.configPath), "explicit");
  }

  const localConfigPath = path.resolve(cwd, DEFAULT_SERVICE_CONFIG_FILE);
  if (existsSync(localConfigPath)) {
    return resolution(localConfigPath, "local");
  }

  return resolution(defaultUserConfigPath(options), "user");
}

export function defaultUserConfigPath(
  options: Pick<ResolveServiceConfigPathOptions, "env" | "homeDir"> = {}
): string {
  return path.join(
    userConfigHome(options),
    XDG_CONFIG_SUBDIR,
    DEFAULT_SERVICE_CONFIG_FILE
  );
}

export function defaultUserStateRoot(
  options: Pick<ResolveServiceConfigPathOptions, "env" | "homeDir"> = {}
): string {
  return path.join(userStateHome(options), XDG_STATE_SUBDIR);
}

export function isDefaultUserConfigPath(
  configPath: string,
  options: Pick<ResolveServiceConfigPathOptions, "env" | "homeDir"> = {}
): boolean {
  return path.resolve(configPath) === defaultUserConfigPath(options);
}

export function missingUserConfigHint(configPath: string): string {
  return `no initialized Service Config found at ${configPath}; run \`symphonika init\` first`;
}

function resolution(
  configPath: string,
  source: ConfigPathSource
): ServiceConfigPathResolution {
  return {
    configDir: path.dirname(configPath),
    configExists: existsSync(configPath),
    configPath,
    source
  };
}

function userConfigHome(
  options: Pick<ResolveServiceConfigPathOptions, "env" | "homeDir">
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const configured = env.XDG_CONFIG_HOME?.trim();
  return configured === undefined || configured.length === 0
    ? path.join(homeDir, ".config")
    : path.resolve(configured);
}

function userStateHome(
  options: Pick<ResolveServiceConfigPathOptions, "env" | "homeDir">
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const configured = env.XDG_STATE_HOME?.trim();
  return configured === undefined || configured.length === 0
    ? path.join(homeDir, ".local", "state")
    : path.resolve(configured);
}
