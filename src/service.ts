import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ServiceInstallOptions = {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  force?: boolean;
  homeDir?: string;
  print?: boolean;
  reload?: boolean;
  runReload?: () => Promise<void>;
  scriptPath?: string;
};

type ServiceUnitFile = {
  content: string;
  path: string;
};

export type ServiceInstallReport = {
  errors: string[];
  files: ServiceUnitFile[];
  ok: boolean;
  printed: boolean;
  reloaded: boolean;
  reloadError: string | null;
  unitDir: string;
};

export type ServiceUnitInput = {
  execPath: string;
  path: string;
  scriptPath: string;
};

const SLICE_UNIT = [
  "[Unit]",
  "Description=Symphonika slice (daemon + spawned providers and verifiers)",
  "",
  "[Slice]",
  "# Cap the whole daemon tree. Tune to match the host you run on; these",
  "# defaults assume a workstation with >= 64 GB of RAM. A runaway tool",
  "# (e.g. an ESBMC verification) will be killed inside this slice",
  "# instead of triggering a global OOM that tears down terminals or",
  "# other unrelated cgroups.",
  "MemoryHigh=24G",
  "MemoryMax=32G",
  "TasksMax=4096",
  ""
].join("\n");

// Generate the daemon .service unit from the running process so the unit is
// install-agnostic. `process.execPath` (node) plus the resolved dist/cli.js
// sidestep the version-manager bin directory entirely, which is what the
// hardcoded ~/.npm-global path got wrong (see docs/adr/0055).
export function renderServiceUnit(input: ServiceUnitInput): string {
  return [
    "[Unit]",
    "Description=Symphonika orchestrator daemon",
    "After=graphical-session.target network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    "Restart=on-failure",
    "RestartSec=5s",
    "",
    "# PATH is captured from the environment that ran `symphonika service",
    "# install`, because systemd --user does not inherit your interactive",
    "# PATH. Spawned providers (claude, codex) and tools (gh, esbmc, cargo,",
    "# ...) must resolve here. The directory holding this node runtime is",
    "# prepended so `node` resolves regardless of version manager (nvm,",
    "# npm-global, pnpm, ...). Re-run `symphonika service install` after a",
    "# node upgrade to refresh a version-pinned path. The whole assignment is",
    "# quoted so a PATH entry containing a space is not split off and dropped.",
    `Environment=${systemdEnvAssignment("PATH", input.path)}`,
    "",
    "# Resolve GITHUB_TOKEN from `gh auth token` at each (re)start so this",
    "# survives token rotation. Fails closed if gh returns empty so the",
    "# daemon never starts without a token. `exec` replaces the shell so",
    "# the node process becomes the service's Main PID.",
    "#",
    "# ExecStart runs this node runtime against the resolved dist/cli.js, so",
    "# the unit matches the actual install (npm-global, nvm, pnpm, source",
    "# checkout) instead of a fixed bin path. The runtime and script are",
    "# passed as positional args and re-quoted inside the shell so paths",
    "# containing spaces survive.",
    `ExecStart=/bin/sh -c 't=$(gh auth token); [ -n "$t" ] || { echo "ERROR: gh auth token returned empty"; exit 1; }; export GITHUB_TOKEN="$t"; exec "$1" "$2" daemon' symphonika ${systemdArg(input.execPath)} ${systemdArg(input.scriptPath)}`,
    "",
    "# Keep the daemon and everything it spawns in its own cgroup slice.",
    "# A scope-wide OOM in a spawned tool (compiler, verifier, ...) no",
    "# longer tears down whichever terminal scope you happened to launch",
    "# the daemon from.",
    "Slice=symphonika.slice",
    "",
    "# Journald sees stdout/stderr. View with:",
    "#   journalctl --user -u symphonika -f",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export function renderSliceUnit(): string {
  return SLICE_UNIT;
}

// Bake an absolute PATH into the unit: the node runtime's directory first,
// then the invoking environment's PATH, dropping empty and relative entries
// (an empty entry means CWD, which must never leak into a service PATH).
export function buildDaemonPath(
  execPath: string,
  env: NodeJS.ProcessEnv
): string {
  const nodeDir = path.dirname(execPath);
  const current = typeof env.PATH === "string" ? env.PATH : "";
  const fromEnv = current
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
  const base =
    fromEnv.length > 0 ? fromEnv : ["/usr/local/bin", "/usr/bin", "/bin"];

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [nodeDir, ...base]) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(path.delimiter);
}

export async function runServiceInstall(
  options: ServiceInstallOptions = {}
): Promise<ServiceInstallReport> {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const scriptPath = options.scriptPath ?? defaultScriptPath();
  const homeDir = options.homeDir ?? homedir();
  const unitDir = userUnitDir(homeDir, env);
  const daemonPath = buildDaemonPath(execPath, env);

  const files: ServiceUnitFile[] = [
    {
      content: renderServiceUnit({ execPath, path: daemonPath, scriptPath }),
      path: path.join(unitDir, "symphonika.service")
    },
    {
      content: renderSliceUnit(),
      path: path.join(unitDir, "symphonika.slice")
    }
  ];

  const errors: string[] = [];
  const baseReport = (
    overrides: Partial<ServiceInstallReport> = {}
  ): ServiceInstallReport => ({
    errors,
    files,
    ok: false,
    printed: false,
    reloaded: false,
    reloadError: null,
    unitDir,
    ...overrides
  });

  if (options.print === true) {
    return baseReport({ ok: true, printed: true });
  }

  if (options.force !== true) {
    const existing: string[] = [];
    for (const file of files) {
      if (await fileExists(file.path)) {
        existing.push(file.path);
      }
    }
    if (existing.length > 0) {
      for (const filePath of existing) {
        errors.push(`${filePath} already exists; pass --force to overwrite it`);
      }
      return baseReport();
    }
  }

  await mkdir(unitDir, { recursive: true });
  for (const file of files) {
    await writeFile(file.path, file.content, "utf8");
  }

  if (options.reload === false) {
    return baseReport({ ok: true });
  }

  const runReload = options.runReload ?? defaultReload;
  try {
    await runReload();
    return baseReport({ ok: true, reloaded: true });
  } catch (error) {
    return baseReport({ ok: true, reloadError: errorMessage(error) });
  }
}

// systemd --user reads units from $XDG_CONFIG_HOME/systemd/user, falling back
// to ~/.config/systemd/user when XDG_CONFIG_HOME is unset. systemd only honors
// an absolute XDG_CONFIG_HOME, so a relative value is ignored here too.
function userUnitDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const xdg =
    typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const configHome =
    xdg.length > 0 && path.isAbsolute(xdg)
      ? xdg
      : path.join(homeDir, ".config");
  return path.join(configHome, "systemd", "user");
}

// Quote a path as a single systemd argument, escaping the characters special to
// systemd's command-line parser so the value reaches the shell verbatim.
function systemdArg(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "$$$$")
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

// Quote a `NAME=value` pair for an `Environment=` directive. systemd splits the
// value on whitespace unless the whole assignment is double-quoted, and expands
// `%` specifiers inside it — but, unlike a command line, does not expand `$`, so
// `$` is left untouched here (doubling it would leak a literal `$$`).
function systemdEnvAssignment(name: string, value: string): string {
  const escaped = `${name}=${value}`
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

function defaultScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

async function defaultReload(): Promise<void> {
  await execFile("systemctl", ["--user", "daemon-reload"]);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
