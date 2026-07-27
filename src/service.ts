import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ServiceInstallOptions = {
  configPath?: string;
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
  removedFiles: string[];
  unitDir: string;
};

export type ServiceUnitInput = {
  configPath?: string;
  execPath: string;
  path: string;
  scriptPath: string;
};

const SLICE_UNIT = [
  "[Unit]",
  "Description=Symphonika daemon slice (daemon + dashboard only)",
  "",
  "[Slice]",
  "# Small, protected budget for the daemon process itself. Spawned",
  "# providers and their build tools run in symphonika-providers.slice",
  "# instead, so a runaway tool there can no longer throttle the daemon's",
  "# own event loop or dashboard (see docs/adr/0064). Tune to match the",
  "# host you run on.",
  "MemoryHigh=4G",
  "MemoryMax=6G",
  ""
].join("\n");

const PROVIDERS_SLICE_UNIT = [
  "[Unit]",
  "Description=Symphonika providers slice (spawned providers and verifiers)",
  "",
  "[Slice]",
  "# Cap the whole tree of spawned providers and their build tools. Tune",
  "# to match the host you run on; these defaults assume a workstation",
  "# with >= 64 GB of RAM. A runaway tool (e.g. an ESBMC verification)",
  "# will be killed inside this slice instead of triggering a global OOM",
  "# that tears down terminals or other unrelated cgroups — and, since",
  "# this slice is a sibling of symphonika-daemon.slice rather than its",
  "# parent, it can no longer throttle the daemon itself (docs/adr/0064).",
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
  const daemonConfigOption =
    input.configPath === undefined ? "" : ` --config "$3"`;
  const configArgument =
    input.configPath === undefined ? "" : ` ${systemdArg(input.configPath)}`;

  return [
    "[Unit]",
    "Description=Symphonika orchestrator daemon",
    "After=graphical-session.target network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=notify",
    "WorkingDirectory=%h",
    "",
    "# A hung-but-alive daemon (e.g. a stuck event loop) never exits, so",
    "# Restart=on-failure alone can't catch it. WatchdogSec= requires a",
    "# periodic WATCHDOG=1 notify ping (see daemon.ts's tick loop); systemd",
    "# kills and restarts the unit if none arrives within the window.",
    "WatchdogSec=90",
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
    "# containing spaces survive. An explicitly selected config uses the",
    "# same positional-argument path.",
    `ExecStart=/bin/sh -c 't=$(gh auth token); [ -n "$t" ] || { echo "ERROR: gh auth token returned empty"; exit 1; }; export GITHUB_TOKEN="$t"; exec "$1" "$2" daemon${daemonConfigOption}' symphonika ${systemdArg(input.execPath)} ${systemdArg(input.scriptPath)}${configArgument}`,
    "",
    "# Keep the daemon in its own small, protected cgroup slice, separate",
    "# from symphonika-providers.slice (where spawned providers and their",
    "# build tools run). A memory blowup in a provider no longer throttles",
    "# the daemon's own event loop or dashboard — see docs/adr/0064.",
    "Slice=symphonika-daemon.slice",
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

export function renderProvidersSliceUnit(): string {
  return PROVIDERS_SLICE_UNIT;
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
      content: renderServiceUnit({
        ...(options.configPath === undefined
          ? {}
          : { configPath: options.configPath }),
        execPath,
        path: daemonPath,
        scriptPath
      }),
      path: path.join(unitDir, "symphonika.service")
    },
    {
      content: renderSliceUnit(),
      path: path.join(unitDir, "symphonika-daemon.slice")
    },
    {
      content: renderProvidersSliceUnit(),
      path: path.join(unitDir, "symphonika-providers.slice")
    }
  ];

  const errors: string[] = [];
  const removedFiles: string[] = [];
  const baseReport = (
    overrides: Partial<ServiceInstallReport> = {}
  ): ServiceInstallReport => ({
    errors,
    files,
    ok: false,
    printed: false,
    reloaded: false,
    reloadError: null,
    removedFiles,
    unitDir,
    ...overrides
  });

  if (options.print === true) {
    return baseReport({ ok: true, printed: true });
  }

  // When scriptPath was resolved from the running module (not injected), refuse
  // to write a unit whose ExecStart points at a nonexistent entrypoint. This
  // happens when `service install` is run from TS sources (`npm run dev` / tsx),
  // where the default resolves to a `src/cli.js` that is never built — fail fast
  // instead of installing a unit that dies at runtime with MODULE_NOT_FOUND.
  if (options.scriptPath === undefined && !(await fileExists(scriptPath))) {
    errors.push(
      `resolved CLI entrypoint ${scriptPath} does not exist; run \`symphonika service install\` from the built CLI (\`node dist/cli.js\` or the installed \`symphonika\` bin), not from TS sources (\`npm run dev\`)`
    );
    return baseReport();
  }

  const legacySlicePath = path.join(unitDir, "symphonika.slice");
  const legacySliceExists = await fileExists(legacySlicePath);

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
    // The pre-split README documented symphonika.slice as
    // operator-customizable, removed only by `--force`. Leaving it in place
    // while still writing the two new slices would recreate the hierarchy
    // bug removal fixes (`man systemd.slice`: dash-separated names always
    // nest under their unhyphenated parent), so a non-force install refuses
    // outright rather than either destroying a customized file or installing
    // a still-constrained split.
    if (legacySliceExists) {
      errors.push(
        `${legacySlicePath} is a legacy unit superseded by symphonika-daemon.slice/symphonika-providers.slice; pass --force to remove it and complete the upgrade`
      );
      return baseReport();
    }
  }

  await mkdir(unitDir, { recursive: true });
  for (const file of files) {
    await writeFile(file.path, file.content, "utf8");
  }

  // Superseded by symphonika-daemon.slice / symphonika-providers.slice. Per
  // `man systemd.slice`, dash-separated slice names encode hierarchy —
  // "foo-bar.slice is located within foo.slice" — so both new slices are
  // always children of an (implicit or explicit) symphonika.slice. A
  // leftover file from before this split would still cap the daemon and
  // providers jointly under its own MemoryHigh/MemoryMax, defeating the
  // whole point of the split (docs/adr/0064) for any upgrading operator.
  // Only reached with force === true or when no legacy file exists, since a
  // non-force install with one present already returned above.
  if (legacySliceExists) {
    await unlink(legacySlicePath);
    removedFiles.push(legacySlicePath);
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
export function userUnitDir(homeDir: string, env: NodeJS.ProcessEnv): string {
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
