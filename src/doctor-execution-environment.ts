import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";

import type { AgentProviderName } from "./provider.js";
import { renderProviderCommandTemplate } from "./provider-command-template.js";
import {
  parseProviderCommand,
  type ProviderLabel
} from "./providers/command-parse.js";
import { userUnitDir } from "./service.js";

const execFile = promisify(execFileCallback);

export type DoctorProviderBinaryReport = {
  executable: string | null;
  provider: AgentProviderName;
  resolvedPath: string | null;
  status: "invalid_command" | "resolved" | "unresolved";
};

export type DoctorCodexProfileReport = {
  checks: Array<{
    actual: string | null;
    expected: string;
    key: "approval_policy" | "sandbox_mode";
    status: "match" | "mismatch" | "missing";
  }>;
  error?: string;
  path: string;
  status: "invalid" | "not_required" | "valid";
};

export type DoctorGhAuthReport = {
  executablePath: string | null;
  status:
    "authenticated" | "not_installed" | "skipped_offline" | "unauthenticated";
};

export type DoctorInstalledUnitReport = {
  binaries: Array<{
    executable: string;
    provider?: AgentProviderName;
    resolvedPath: string | null;
  }>;
  environmentPath: string | null;
  servicePath: string;
  status: "checked" | "not_installed" | "path_missing";
};

export type DoctorExecutionEnvironmentReport = {
  codexProfile: DoctorCodexProfileReport;
  gh: DoctorGhAuthReport;
  installedUnit: DoctorInstalledUnitReport;
  providerBinaries: DoctorProviderBinaryReport[];
};

type SelectedProject = {
  agent: { provider: AgentProviderName };
};

type ProviderCommands = {
  [name in AgentProviderName]?: { command: string } | undefined;
};

type EnvironmentCheckResult = {
  environment: DoctorExecutionEnvironmentReport;
  errors: string[];
  warnings: string[];
};

export async function inspectDoctorHostEnvironment(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  offline: boolean;
}): Promise<EnvironmentCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const servicePath = path.join(
    userUnitDir(input.homeDir, input.env),
    "symphonika.service"
  );
  const [gh, installedUnit] = await Promise.all([
    checkGhAuth(input.cwd, input.env, input.offline, errors),
    inspectInstalledUnitPath(
      servicePath,
      input.homeDir,
      input.env.PATHEXT,
      warnings
    )
  ]);

  return {
    environment: {
      codexProfile: {
        checks: [],
        path: path.join(input.homeDir, ".codex", "config.toml"),
        status: "not_required"
      },
      gh,
      installedUnit,
      providerBinaries: []
    },
    errors,
    warnings
  };
}

export async function inspectConfiguredDoctorEnvironment(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  environment: DoctorExecutionEnvironmentReport;
  homeDir: string;
  projects: SelectedProject[];
  providers: ProviderCommands;
}): Promise<EnvironmentCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const providerBinaries = await checkProviderBinaries(
    input.projects,
    input.providers,
    input.cwd,
    input.env,
    errors
  );
  const installedUnit = await withInstalledProviderBinaryChecks(
    input.environment.installedUnit,
    providerBinaries,
    input.homeDir,
    input.env.PATHEXT,
    warnings
  );
  const codexProfile = input.projects.some(
    (project) => project.agent.provider === "codex"
  )
    ? await checkCodexProfile(input.environment.codexProfile.path, errors)
    : input.environment.codexProfile;

  return {
    environment: {
      ...input.environment,
      codexProfile,
      installedUnit,
      providerBinaries
    },
    errors,
    warnings
  };
}

async function checkGhAuth(
  cwd: string,
  env: NodeJS.ProcessEnv,
  offline: boolean,
  errors: string[]
): Promise<DoctorGhAuthReport> {
  const executablePath = await resolveExecutable(
    "gh",
    cwd,
    env.PATH,
    env.PATHEXT
  );
  if (executablePath === undefined) {
    errors.push("gh is not installed or is not resolvable on PATH");
    return { executablePath: null, status: "not_installed" };
  }
  if (offline) {
    return { executablePath, status: "skipped_offline" };
  }

  try {
    await execFile(executablePath, ["auth", "status"], {
      cwd,
      env,
      timeout: 10_000
    });
    return { executablePath, status: "authenticated" };
  } catch {
    errors.push("gh is installed but not authenticated; run `gh auth login`");
    return { executablePath, status: "unauthenticated" };
  }
}

async function inspectInstalledUnitPath(
  servicePath: string,
  homeDir: string,
  pathExt: string | undefined,
  warnings: string[]
): Promise<DoctorInstalledUnitReport> {
  const serviceContent = await readFileIfExists(servicePath);
  if (serviceContent === undefined) {
    return {
      binaries: [],
      environmentPath: null,
      servicePath,
      status: "not_installed"
    };
  }

  const environmentPath = systemdEnvironmentPath(serviceContent, homeDir);
  if (environmentPath === undefined) {
    warnings.push(
      `${servicePath} is installed but has no Environment=PATH= directive`
    );
  }
  const ghPath = await resolveExecutable(
    "gh",
    homeDir,
    environmentPath ?? "",
    pathExt
  );
  if (ghPath === undefined) {
    warnings.push(`${servicePath} PATH does not resolve gh executable gh`);
  }

  return {
    binaries: [
      { executable: "gh", resolvedPath: ghPath === undefined ? null : ghPath }
    ],
    environmentPath: environmentPath ?? null,
    servicePath,
    status: environmentPath === undefined ? "path_missing" : "checked"
  };
}

async function withInstalledProviderBinaryChecks(
  installedUnit: DoctorInstalledUnitReport,
  providers: DoctorProviderBinaryReport[],
  homeDir: string,
  pathExt: string | undefined,
  warnings: string[]
): Promise<DoctorInstalledUnitReport> {
  if (installedUnit.status === "not_installed") {
    return installedUnit;
  }
  const providerReports: DoctorInstalledUnitReport["binaries"] = [];
  for (const provider of providers) {
    if (provider.executable === null) {
      continue;
    }
    const resolvedPath = await resolveExecutable(
      provider.executable,
      homeDir,
      installedUnit.environmentPath ?? "",
      pathExt
    );
    providerReports.push({
      executable: provider.executable,
      provider: provider.provider,
      resolvedPath: resolvedPath ?? null
    });
    if (resolvedPath === undefined) {
      warnings.push(
        `${installedUnit.servicePath} PATH does not resolve provider ${provider.provider} executable ${provider.executable}`
      );
    }
  }
  return {
    ...installedUnit,
    binaries: [...providerReports, ...installedUnit.binaries]
  };
}

function systemdEnvironmentPath(
  serviceContent: string,
  homeDir: string
): string | undefined {
  let environmentPath: string | undefined;
  for (const line of serviceContent.split(/\r?\n/)) {
    const match = /^[ \t]*Environment[ \t]*=[ \t]*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const rawValue = match[1] ?? "";
    if (rawValue.trim().length === 0) {
      environmentPath = undefined;
      continue;
    }
    for (const assignment of splitSystemdWords(rawValue)) {
      if (assignment.startsWith("PATH=")) {
        environmentPath = assignment
          .slice("PATH=".length)
          .replace(/%%|%h/g, (specifier) =>
            specifier === "%%" ? "%" : homeDir
          );
      }
    }
  }
  return environmentPath;
}

function splitSystemdWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaping) {
    current += "\\";
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

async function checkProviderBinaries(
  projects: SelectedProject[],
  providers: ProviderCommands,
  cwd: string,
  env: NodeJS.ProcessEnv,
  errors: string[]
): Promise<DoctorProviderBinaryReport[]> {
  const selectedProviders = [
    ...new Set(projects.map((project) => project.agent.provider))
  ];
  const reports: DoctorProviderBinaryReport[] = [];

  for (const providerName of selectedProviders) {
    const provider = providers[providerName];
    if (provider === undefined) {
      continue;
    }
    let executable: string;
    try {
      const rendered = renderProviderCommandTemplate(
        provider.command,
        {}
      ).rendered;
      executable = parseProviderCommand(
        rendered,
        providerLabel(providerName)
      ).executable;
    } catch (error) {
      reports.push({
        executable: null,
        provider: providerName,
        resolvedPath: null,
        status: "invalid_command"
      });
      errors.push(
        `provider ${providerName} command could not be resolved: ${errorMessage(error)}`
      );
      continue;
    }

    const resolvedPath = await resolveExecutable(
      executable,
      cwd,
      env.PATH,
      env.PATHEXT
    );
    reports.push({
      executable,
      provider: providerName,
      resolvedPath: resolvedPath ?? null,
      status: resolvedPath === undefined ? "unresolved" : "resolved"
    });
    if (resolvedPath === undefined) {
      errors.push(
        `provider ${providerName} executable ${executable} is not resolvable on PATH`
      );
    }
  }

  return reports;
}

const CODEX_PROFILE_REQUIREMENTS = [
  ["sandbox_mode", "danger-full-access"],
  ["approval_policy", "never"]
] as const;

async function checkCodexProfile(
  configPath: string,
  errors: string[]
): Promise<DoctorCodexProfileReport> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    const checks = missingCodexProfileChecks(errors);
    return {
      checks,
      error: `could not read ${configPath}: ${errorMessage(error)}`,
      path: configPath,
      status: "invalid"
    };
  }

  let document: unknown;
  try {
    document = parseToml(content);
  } catch (error) {
    const message = `Codex config at ${configPath} could not be parsed: ${errorMessage(error)}`;
    errors.push(message);
    return {
      checks: [],
      error: message,
      path: configPath,
      status: "invalid"
    };
  }

  const profile = nestedRecord(document, ["profiles", "symphonika"]);
  const checks: DoctorCodexProfileReport["checks"] = [];
  for (const [key, expected] of CODEX_PROFILE_REQUIREMENTS) {
    const rawActual = profile?.[key];
    const actual = codexProfileValue(rawActual);
    const status =
      rawActual === undefined
        ? "missing"
        : rawActual === expected
          ? "match"
          : "mismatch";
    checks.push({ actual, expected, key, status });
    if (status === "missing") {
      errors.push(
        `Codex profile profiles.symphonika.${key} is missing; expected "${expected}"`
      );
    } else if (status === "mismatch") {
      errors.push(
        `Codex profile profiles.symphonika.${key} is ${JSON.stringify(actual)}; expected "${expected}"`
      );
    }
  }

  return {
    checks,
    path: configPath,
    status: checks.every((check) => check.status === "match")
      ? "valid"
      : "invalid"
  };
}

function codexProfileValue(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? `<${typeof value}>`;
}

function missingCodexProfileChecks(
  errors: string[]
): DoctorCodexProfileReport["checks"] {
  return CODEX_PROFILE_REQUIREMENTS.map(([key, expected]) => {
    errors.push(
      `Codex profile profiles.symphonika.${key} is missing; expected "${expected}"`
    );
    return { actual: null, expected, key, status: "missing" as const };
  });
}

function nestedRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current !== null && typeof current === "object"
    ? (current as Record<string, unknown>)
    : undefined;
}

function providerLabel(providerName: AgentProviderName): ProviderLabel {
  switch (providerName) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "omp":
      return "Oh My Pi";
  }
}

async function resolveExecutable(
  executable: string,
  cwd: string,
  environmentPath: string | undefined,
  pathExt: string | undefined
): Promise<string | undefined> {
  const hasPathSeparator =
    executable.includes(path.sep) ||
    (path.sep === "\\" && executable.includes("/"));
  const candidates = hasPathSeparator
    ? [path.isAbsolute(executable) ? executable : path.resolve(cwd, executable)]
    : (environmentPath ?? "")
        .split(path.delimiter)
        .map((entry) =>
          path.join(entry.length === 0 ? cwd : entry, executable)
        );
  const extensions =
    process.platform === "win32" && path.extname(executable).length === 0
      ? (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const candidate of candidates) {
    for (const extension of extensions) {
      const resolved = `${candidate}${extension}`;
      try {
        await access(resolved, constants.X_OK);
        return resolved;
      } catch {
        // Continue searching the same way child-process PATH resolution does.
      }
    }
  }
  return undefined;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
