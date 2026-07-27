import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ProviderRunIdentity = {
  attempt: number;
  id: string;
};

export function scopeUnitName(run: ProviderRunIdentity): string {
  return `symphonika-run-${run.id}-attempt-${run.attempt}.scope`;
}

export type ProbeSystemdRunAvailableOptions = {
  env?: NodeJS.ProcessEnv;
  runVersionCheck?: () => Promise<void>;
};

// systemd-run --user needs a live user session (the runtime dir systemd-logind
// creates on login), not just the binary on PATH. `symphonika daemon` must
// keep working with neither present (non-systemd hosts, containers, CI) — see
// docs/adr/0064 — so this is a cheap probe, not a hard requirement.
export async function probeSystemdRunAvailable(
  options: ProbeSystemdRunAvailableOptions = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (
    typeof env.XDG_RUNTIME_DIR !== "string" ||
    env.XDG_RUNTIME_DIR.length === 0
  ) {
    return false;
  }

  const runVersionCheck = options.runVersionCheck ?? defaultVersionCheck;
  try {
    await runVersionCheck();
    return true;
  } catch {
    return false;
  }
}

async function defaultVersionCheck(): Promise<void> {
  await execFile("systemd-run", ["--version"]);
}

export type ProcessCommand = {
  args: string[];
  executable: string;
};

export type ProcessScopeOptions = {
  isAvailable?: () => Promise<boolean>;
  memoryHigh?: string;
  memoryMax?: string;
  runStop?: (unitName: string) => Promise<void>;
  slice?: string;
};

export type ProcessScope = {
  stopProviderScope: (run: ProviderRunIdentity) => Promise<void>;
  wrapForProviderScope: (
    run: ProviderRunIdentity,
    command: ProcessCommand
  ) => Promise<ProcessCommand>;
};

const DEFAULT_PROVIDERS_SLICE = "symphonika-providers.slice";
const DEFAULT_MEMORY_HIGH = "24G";
const DEFAULT_MEMORY_MAX = "32G";

export function createProcessScope(
  options: ProcessScopeOptions = {}
): ProcessScope {
  const slice = options.slice ?? DEFAULT_PROVIDERS_SLICE;
  const memoryHigh = options.memoryHigh ?? DEFAULT_MEMORY_HIGH;
  const memoryMax = options.memoryMax ?? DEFAULT_MEMORY_MAX;
  const runStop = options.runStop ?? defaultRunStop;
  let cachedAvailable: Promise<boolean> | undefined;

  const isAvailable = (): Promise<boolean> => {
    if (options.isAvailable !== undefined) {
      return options.isAvailable();
    }
    if (cachedAvailable === undefined) {
      cachedAvailable = probeSystemdRunAvailable();
    }
    return cachedAvailable;
  };

  return {
    wrapForProviderScope: async (run, command) => {
      if (!(await isAvailable())) {
        return command;
      }

      return {
        args: [
          "--user",
          "--scope",
          `--slice=${slice}`,
          `--unit=${scopeUnitName(run)}`,
          "--collect",
          "-p",
          `MemoryHigh=${memoryHigh}`,
          "-p",
          `MemoryMax=${memoryMax}`,
          "--",
          command.executable,
          ...command.args
        ],
        executable: "systemd-run"
      };
    },
    stopProviderScope: async (run) => {
      if (!(await isAvailable())) {
        return;
      }

      try {
        await runStop(scopeUnitName(run));
      } catch {
        // The scope may already be gone — the common case, where the
        // wrapped process exited cleanly and left nothing behind. Either
        // way, there's nothing left to stop.
      }
    }
  };
}

async function defaultRunStop(unitName: string): Promise<void> {
  await execFile("systemctl", ["--user", "stop", unitName]);
}
