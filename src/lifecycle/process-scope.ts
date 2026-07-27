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
  probeTimeoutMs?: number;
  runManagerCheck?: () => Promise<void>;
};

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

// systemd-run --user needs a live, reachable user manager (the runtime dir
// systemd-logind creates on login is a prerequisite, not proof by itself —
// XDG_RUNTIME_DIR can be set with no manager actually listening, e.g. in some
// containers and minimal SSH sessions). `symphonika daemon` must keep working
// with neither present (non-systemd hosts, containers, CI) — see
// docs/adr/0064 — so this is a cheap probe, not a hard requirement.
//
// `systemctl --user list-units` genuinely round-trips over D-Bus to the
// manager, unlike `systemd-run --version` (which only reads embedded version
// metadata and would report available=true even when the manager isn't
// reachable, causing the real wrapped spawn to fail with a bus/session error
// instead of taking the unwrapped fallback). `is-system-running` was tried
// first and rejected: its exit status encodes overall session health
// ("degraded" — any unrelated failed unit — exits nonzero), not manager
// reachability, so one unrelated failed unit would permanently disable
// isolation for the daemon's whole lifetime (the probe result is cached).
// `list-units` only fails when the manager itself can't be reached.
//
// This result is cached by createProcessScope for the process lifetime
// (`cachedAvailable`), so the check itself must never hang: a bounded
// timeout is required, not just good practice — otherwise a slow/wedged
// manager at daemon startup (the orphan-scope sweep runs this before the
// HTTP server starts listening) would hang startDaemon() forever, exactly
// the class of wedge this whole change exists to eliminate.
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

  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const runManagerCheck =
    options.runManagerCheck ?? (() => defaultManagerCheck(probeTimeoutMs));
  try {
    await runManagerCheck();
    return true;
  } catch {
    return false;
  }
}

async function defaultManagerCheck(timeoutMs: number): Promise<void> {
  await execFile("systemctl", ["--user", "list-units", "--no-pager"], {
    timeout: timeoutMs
  });
}

export type ProcessCommand = {
  args: string[];
  executable: string;
};

export type ProcessScopeOptions = {
  confirmUnitInactive?: (
    unitName: string,
    timeoutMs: number
  ) => Promise<boolean>;
  isAvailable?: () => Promise<boolean>;
  memoryHigh?: string;
  memoryMax?: string;
  probeTimeoutMs?: number;
  runStop?: (unitName: string) => Promise<void>;
  slice?: string;
  stopTimeoutMs?: number;
};

export type ProcessScope = {
  // true: confirmed the scope is stopped (or there was never one to stop).
  // false: cleanup could not be confirmed and must be retried later.
  stopProviderScope: (run: ProviderRunIdentity) => Promise<boolean>;
  wrapForProviderScope: (
    run: ProviderRunIdentity,
    command: ProcessCommand
  ) => Promise<ProcessCommand>;
};

const DEFAULT_PROVIDERS_SLICE = "symphonika-providers.slice";
const DEFAULT_MEMORY_HIGH = "24G";
const DEFAULT_MEMORY_MAX = "32G";
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export function createProcessScope(
  options: ProcessScopeOptions = {}
): ProcessScope {
  const slice = options.slice ?? DEFAULT_PROVIDERS_SLICE;
  const memoryHigh = options.memoryHigh ?? DEFAULT_MEMORY_HIGH;
  const memoryMax = options.memoryMax ?? DEFAULT_MEMORY_MAX;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const runStop =
    options.runStop ?? ((unitName) => defaultRunStop(unitName, stopTimeoutMs));
  const confirmUnitInactive =
    options.confirmUnitInactive ?? defaultConfirmUnitInactive;
  let cachedAvailable: Promise<boolean> | undefined;

  const isAvailable = (): Promise<boolean> => {
    if (options.isAvailable !== undefined) {
      return options.isAvailable();
    }
    if (cachedAvailable === undefined) {
      cachedAvailable = probeSystemdRunAvailable(
        options.probeTimeoutMs === undefined
          ? {}
          : { probeTimeoutMs: options.probeTimeoutMs }
      );
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
        // Unavailable here proves nothing about the scope this call is
        // trying to clean up: isAvailable() is cached for THIS daemon
        // instance's lifetime, but a leaked scope being reaped by a startup
        // sweep was created by a PREVIOUS (now-dead) daemon instance with
        // its own, independent probe. A transient failure to reach the
        // manager right now is not confirmation that scope is gone.
        return false;
      }

      const unitName = scopeUnitName(run);
      try {
        await runStop(unitName);
        return true;
      } catch {
        // The stop call failing doesn't say why — the scope may already be
        // gone (the common case, where the wrapped process exited cleanly),
        // or the stop itself could have genuinely failed (manager
        // unreachable, timed out). Ask directly instead of guessing: only a
        // definitive "not active" confirms there's nothing left to retry.
        return await confirmUnitInactive(unitName, stopTimeoutMs);
      }
    }
  };
}

// Runs unconditionally from every runAttempt's finally block (see
// codex.ts/claude.ts), so a systemctl call that never returns — D-Bus/systemd
// unresponsive, cgroup teardown stuck behind an uninterruptible process —
// would otherwise block that Run's completion forever, reintroducing a hang
// on the run-lifecycle axis instead of the memory-cgroup axis this module
// exists to fix. execFile's timeout SIGTERMs the child and rejects the
// promise, which stopProviderScope's caller already treats as a no-op (the
// scope may simply already be gone).
async function defaultRunStop(
  unitName: string,
  timeoutMs: number
): Promise<void> {
  await execFile("systemctl", ["--user", "stop", unitName], {
    timeout: timeoutMs
  });
}

// `systemctl --user is-active --quiet <unit>` exits 0 only while the unit is
// still active, and exits 4 specifically for "inactive"/unknown to the
// manager (empirically verified against a real systemd --user session). That
// is the ONLY exit this reads as confirmation the scope is gone — every
// other nonzero exit is a manager/command failure, not an answer. Also
// empirically verified: a manager the client can't reach (dead bus, bad
// XDG_RUNTIME_DIR) exits 1 with "Failed to connect to bus", the same generic
// failure code any number of other problems could produce, so it must be
// classified as unconfirmed rather than assumed to mean the same thing as
// exit 4.
async function defaultConfirmUnitInactive(
  unitName: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await execFile("systemctl", ["--user", "is-active", "--quiet", unitName], {
      timeout: timeoutMs
    });
    return false;
  } catch (error) {
    return classifyUnitInactiveError(error);
  }
}

export function classifyUnitInactiveError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 4;
}
