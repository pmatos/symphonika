import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";

import type { AgentProviderName } from "./provider.js";
import { renderProviderCommandTemplate } from "./provider-command-template.js";
import { extractProfileName } from "./providers/codex.js";
import {
  parseProviderCommand,
  type ProviderLabel
} from "./providers/command-parse.js";

const execFile = promisify(execFileCallback);

type DoctorProviderBinaryReport = {
  executable: string | null;
  provider: AgentProviderName;
  resolvedPath: string | null;
  status: "invalid_command" | "resolved" | "unresolved";
};

type DoctorCodexProfileReport = {
  checks: Array<{
    actual: string | null;
    expected: string;
    key:
      | "approval_policy"
      | "model_reasoning_summary"
      | "model_verbosity"
      | "sandbox_mode";
    status: "match" | "mismatch" | "missing";
  }>;
  error?: string;
  path: string;
  status: "invalid" | "not_required" | "valid";
};

type DoctorGhAuthReport = {
  executablePath: string | null;
  reason?: string;
  status:
    | "authenticated"
    | "not_installed"
    | "probe_failed"
    | "skipped_offline"
    | "unauthenticated";
};

type DoctorInstalledUnitReport = {
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
  // The installed unit is read once by the caller and shared with the
  // structural drift check, which inspects the same file.
  serviceContent: string | undefined;
  servicePath: string;
}): Promise<EnvironmentCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const [gh, installedUnit] = await Promise.all([
    checkGhAuth(input.cwd, input.env, input.offline, errors),
    inspectInstalledUnitPath(
      input.servicePath,
      input.serviceContent,
      input.homeDir,
      input.env.PATHEXT,
      warnings
    )
  ]);

  return {
    environment: {
      codexProfile: {
        checks: [],
        path: codexConfigPath(input.homeDir, input.env),
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
    ? await checkCodexProfile(
        input.environment.codexProfile.path,
        codexProfileName(input.providers.codex?.command),
        errors
      )
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
    await execFile(
      executablePath,
      ["auth", "status", "--active", "--hostname", "github.com"],
      {
        cwd,
        env,
        timeout: 10_000
      }
    );
    return { executablePath, status: "authenticated" };
  } catch (error) {
    const reason = probeFailureDetail(error);
    if (!isGhAuthenticationFailure(error)) {
      errors.push(`gh authentication probe failed: ${reason}`);
      return { executablePath, reason, status: "probe_failed" };
    }
    errors.push(
      `gh is installed but not authenticated; run \`gh auth login\` (gh auth status failed: ${reason})`
    );
    return { executablePath, status: "unauthenticated" };
  }
}

function isGhAuthenticationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 1 &&
    (error as { killed?: unknown }).killed !== true &&
    ((error as { signal?: unknown }).signal === null ||
      (error as { signal?: unknown }).signal === undefined)
  );
}

// A failed probe is not necessarily a logged-out CLI: it is also how a
// timeout, a network failure, or a crashed gh surfaces. Keep the first line
// of whatever gh (or the spawn) reported so the operator can tell which.
function probeFailureDetail(error: unknown): string {
  const stderr =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr
      : "";
  const lines = [stderr, errorMessage(error)].flatMap((text) =>
    text.split(/\r?\n/).map((line) => line.trim())
  );
  return lines.find((line) => line.length > 0) ?? "no output";
}

async function inspectInstalledUnitPath(
  servicePath: string,
  serviceContent: string | undefined,
  homeDir: string,
  pathExt: string | undefined,
  warnings: string[]
): Promise<DoctorInstalledUnitReport> {
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
    return {
      binaries: [],
      environmentPath: null,
      servicePath,
      status: "path_missing"
    };
  }
  return {
    binaries: [
      await resolveUnitBinary({
        environmentPath,
        executable: "gh",
        homeDir,
        label: "gh",
        pathExt,
        servicePath,
        warnings
      })
    ],
    environmentPath,
    servicePath,
    status: "checked"
  };
}

// The unit's Environment=PATH is frozen at install time, so a binary the
// operator can run today may still be unreachable from the installed service.
async function resolveUnitBinary(input: {
  environmentPath: string;
  executable: string;
  homeDir: string;
  label: string;
  pathExt: string | undefined;
  servicePath: string;
  warnings: string[];
}): Promise<{ executable: string; resolvedPath: string | null }> {
  const resolvedPath = await resolveExecutable(
    input.executable,
    input.homeDir,
    input.environmentPath,
    input.pathExt
  );
  if (resolvedPath === undefined) {
    input.warnings.push(
      `${input.servicePath} PATH does not resolve ${input.label} executable ${input.executable}`
    );
  }
  return { executable: input.executable, resolvedPath: resolvedPath ?? null };
}

async function withInstalledProviderBinaryChecks(
  installedUnit: DoctorInstalledUnitReport,
  providers: DoctorProviderBinaryReport[],
  homeDir: string,
  pathExt: string | undefined,
  warnings: string[]
): Promise<DoctorInstalledUnitReport> {
  const { environmentPath } = installedUnit;
  if (installedUnit.status !== "checked" || environmentPath === null) {
    return installedUnit;
  }
  const providerReports: DoctorInstalledUnitReport["binaries"] = [];
  for (const provider of providers) {
    if (provider.executable === null) {
      continue;
    }
    if (isWorkspaceRelativeExecutable(provider.executable)) {
      providerReports.push({
        executable: provider.executable,
        provider: provider.provider,
        resolvedPath: null
      });
      continue;
    }
    providerReports.push({
      ...(await resolveUnitBinary({
        environmentPath,
        executable: provider.executable,
        homeDir,
        label: `provider ${provider.provider}`,
        pathExt,
        servicePath: installedUnit.servicePath,
        warnings
      })),
      provider: provider.provider
    });
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
      executable = parseConfiguredCommand(
        provider.command,
        providerName
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

    if (isWorkspaceRelativeExecutable(executable)) {
      reports.push({
        executable,
        provider: providerName,
        resolvedPath: null,
        status: "unresolved"
      });
      errors.push(
        `provider ${providerName} executable ${executable} is relative to the future Workspace; use an absolute path or a command resolvable on PATH`
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

const DEFAULT_CODEX_PROFILE = "symphonika";

const CODEX_PROFILE_REQUIREMENTS = [
  ["sandbox_mode", "danger-full-access"],
  ["approval_policy", "never"],
  ["model_reasoning_summary", "detailed"],
  ["model_verbosity", "medium"]
] as const;

async function checkCodexProfile(
  configPath: string,
  profileName: string,
  errors: string[]
): Promise<DoctorCodexProfileReport> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    const detail = `could not read ${configPath}: ${errorMessage(error)}`;
    const checks = codexProfileChecks(undefined, profileName, errors);
    // An absent file already reads as "all required keys missing". Any other read
    // failure (permissions, a directory, an I/O error) would otherwise be
    // reported as missing keys in a file the operator cannot even open.
    if (!isNotFoundError(error)) {
      errors.push(detail);
    }
    return {
      checks,
      error: detail,
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

  const checks = codexProfileChecks(
    nestedRecord(document, ["profiles", profileName]),
    profileName,
    errors
  );

  return {
    checks,
    path: configPath,
    status: checks.every((check) => check.status === "match")
      ? "valid"
      : "invalid"
  };
}

// An unreadable config is reported the same way as a config whose profile
// stanza is absent, so an undefined profile must produce the same checks and
// the same messages as one missing every required key.
function codexProfileChecks(
  profile: Record<string, unknown> | undefined,
  profileName: string,
  errors: string[]
): DoctorCodexProfileReport["checks"] {
  return CODEX_PROFILE_REQUIREMENTS.map(([key, expected]) => {
    const rawActual = profile?.[key];
    const actual = codexProfileValue(rawActual);
    const status =
      rawActual === undefined
        ? "missing"
        : rawActual === expected
          ? "match"
          : "mismatch";
    if (status === "missing") {
      errors.push(
        `Codex profile profiles.${profileName}.${key} is missing; expected "${expected}"`
      );
    } else if (status === "mismatch") {
      errors.push(
        `Codex profile profiles.${profileName}.${key} is ${JSON.stringify(actual)}; expected "${expected}"`
      );
    }
    return { actual, expected, key, status };
  });
}

function codexProfileValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return value === undefined ? null : (JSON.stringify(value) ?? null);
}

// Codex reads its config from $CODEX_HOME when that names an absolute
// directory, falling back to ~/.codex. ADR 0042 documents CODEX_HOME as the
// supported way to fence Symphonika off from an operator's own Codex state,
// so a fixed ~/.codex path would report the shipped profile as missing on
// exactly the installs that follow that advice.
function codexConfigPath(homeDir: string, env: NodeJS.ProcessEnv): string {
  const codexHome =
    typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  const codexDir =
    codexHome.length > 0 && path.isAbsolute(codexHome)
      ? codexHome
      : path.join(homeDir, ".codex");
  return path.join(codexDir, "config.toml");
}

// The profile the configured command actually selects (`-p` / `--profile`),
// not a fixed name: `codex -p acme app-server` must be checked against
// profiles.acme, and checking profiles.symphonika instead fails a working
// install with two bogus missing-key errors. Falls back to the profile the
// shipped default command names when the operator's command names none.
function codexProfileName(command: string | undefined): string {
  if (command === undefined) {
    return DEFAULT_CODEX_PROFILE;
  }
  try {
    const { args } = parseConfiguredCommand(command, "codex");
    return extractProfileName(args) ?? DEFAULT_CODEX_PROFILE;
  } catch {
    // An unparseable command is already reported by checkProviderBinaries.
    return DEFAULT_CODEX_PROFILE;
  }
}

// Doctor must read the configured command exactly the way the adapters do
// before spawning it, so render and parse stay paired in one place.
function parseConfiguredCommand(
  command: string,
  providerName: AgentProviderName
): { args: string[]; executable: string } {
  const rendered = renderProviderCommandTemplate(command, {}).rendered;
  return parseProviderCommand(rendered, providerLabel(providerName));
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
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
  const hasPathSeparator = executableHasPathSeparator(executable);
  if (hasPathSeparator && !path.isAbsolute(executable)) {
    return undefined;
  }
  const searchPath =
    environmentPath === undefined
      ? process.platform === "win32"
        ? (process.env.PATH ?? "")
        : "/usr/bin:/bin"
      : environmentPath;
  const candidates = hasPathSeparator
    ? [executable]
    : searchPath
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
        if ((await stat(resolved)).isFile()) {
          return resolved;
        }
      } catch {
        // Continue searching the same way child-process PATH resolution does.
      }
    }
  }
  return undefined;
}

function isWorkspaceRelativeExecutable(executable: string): boolean {
  return executableHasPathSeparator(executable) && !path.isAbsolute(executable);
}

function executableHasPathSeparator(executable: string): boolean {
  return (
    executable.includes(path.sep) ||
    (path.sep === "\\" && executable.includes("/"))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
