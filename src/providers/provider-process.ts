import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProcessCommand } from "../lifecycle/process-scope.js";

const GRACEFUL_EOF_MS = 250;
const FORCE_KILL_GRACE_MS = 1_000;
type ProviderShutdownState = {
  acceptingCourtesies: boolean;
  courtesies: Array<() => void>;
  promise: Promise<void>;
};
type ProviderProcessGroupState = {
  reserved: boolean;
};
const providerProcessGroups = new WeakMap<
  ChildProcessWithoutNullStreams,
  ProviderProcessGroupState
>();
const shuttingDown = new WeakMap<
  ChildProcessWithoutNullStreams,
  ProviderShutdownState
>();
// POSIX permits the numeric group ID to be reused once its final member
// exits. The supervisor's guardian ignores the group SIGTERM so that the
// original identity remains reserved until the matching SIGKILL.
const PROVIDER_SUPERVISOR_SOURCE = `
import { spawn } from "node:child_process";

const [executable, ...args] = process.argv.slice(1);
if (executable === undefined) {
  process.exit(127);
}

let groupTerminating = false;
let provider;
let settled = false;
let shutdownRequested = false;
const handleTerminate = () => {
  groupTerminating = true;
};
process.on("SIGTERM", handleTerminate);
process.on("message", (message) => {
  if (message === "prepare-shutdown") {
    shutdownRequested = true;
    process.send?.("shutdown-ready");
  }
});

const guardian = spawn(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 60_000);"
  ],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] }
);

function finish(exitCode, signal) {
  if (settled) {
    return;
  }
  settled = true;

  setTimeout(() => {
    if (groupTerminating || shutdownRequested) {
      if (groupTerminating) {
        process.removeListener("SIGTERM", handleTerminate);
        process.kill(process.pid, "SIGTERM");
        return;
      }
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(exitCode ?? 1);
      return;
    }

    const exit = () => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(exitCode ?? 1);
    };

    const releaseGuardian = () => {
      if (guardian.exitCode !== null || guardian.signalCode !== null) {
        exit();
        return;
      }
      guardian.once("close", exit);
      if (!guardian.kill("SIGKILL")) {
        exit();
      }
    };
    if (process.send !== undefined && process.connected) {
      process.send("group-released", releaseGuardian);
      return;
    }
    releaseGuardian();
  }, 25);
}

function fail(message) {
  if (settled) {
    return;
  }
  settled = true;
  provider?.kill("SIGKILL");
  guardian.kill("SIGKILL");
  process.stderr.write(\`\${message}\\n\`);
  process.exit(127);
}

guardian.once("error", (error) => {
  fail(\`failed to spawn provider process-group guardian: \${error.message}\`);
});
guardian.once("close", (exitCode, signal) => {
  fail(
    \`provider process-group guardian exited unexpectedly (\${signal ?? exitCode ?? "unknown"})\`
  );
});
guardian.once("message", (message) => {
  if (
    message !== "ready" ||
    groupTerminating ||
    shutdownRequested ||
    settled
  ) {
    return;
  }
  if (process.send === undefined) {
    fail("provider supervisor IPC channel is unavailable");
    return;
  }
  process.send("group-ready", (error) => {
    if (error) {
      fail(\`failed to report provider process-group readiness: \${error.message}\`);
      return;
    }
    if (groupTerminating || shutdownRequested || settled) {
      return;
    }
    provider = spawn(executable, args, { stdio: "inherit" });
    provider.once("error", (spawnError) => {
      process.stderr.write(
        \`failed to spawn provider: \${spawnError.message}\\n\`
      );
      finish(127, null);
    });
    provider.once("close", finish);
  });
});
`;

export function spawnProviderProcess(
  command: ProcessCommand,
  workspacePath: string
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn(command.executable, command.args, {
      cwd: workspacePath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      PROVIDER_SUPERVISOR_SOURCE,
      command.executable,
      ...command.args
    ],
    {
      cwd: workspacePath,
      detached: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe", "ipc"]
    }
  ) as ChildProcessWithoutNullStreams;
  trackProviderProcessGroup(child);
  return child;
}

export function shutdownProviderProcess(
  child: ChildProcessWithoutNullStreams,
  beforeClose?: () => void
): Promise<void> {
  const existing = shuttingDown.get(child);
  if (existing !== undefined) {
    if (beforeClose !== undefined) {
      if (existing.acceptingCourtesies) {
        existing.courtesies.push(beforeClose);
      }
    }
    return existing.promise;
  }
  const state: ProviderShutdownState = {
    acceptingCourtesies: true,
    courtesies: beforeClose === undefined ? [] : [beforeClose],
    promise: Promise.resolve()
  };
  state.promise = beginProviderShutdown(child, state);
  shuttingDown.set(child, state);
  return state.promise;
}

async function beginProviderShutdown(
  child: ChildProcessWithoutNullStreams,
  state: ProviderShutdownState
): Promise<void> {
  if (!(await reserveProviderProcessGroup(child))) {
    state.acceptingCourtesies = false;
    state.courtesies.length = 0;
    return;
  }
  for (const courtesy of state.courtesies) {
    runShutdownCourtesy(courtesy);
  }
  state.acceptingCourtesies = false;
  state.courtesies.length = 0;

  if (!child.stdin.destroyed && child.stdin.writable) {
    child.stdin.end();
  }

  await shutdownDelay(GRACEFUL_EOF_MS);
  if (!signalProviderProcess(child, "SIGTERM")) {
    return;
  }

  await shutdownDelay(FORCE_KILL_GRACE_MS);
  signalProviderProcess(child, "SIGKILL");
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

function runShutdownCourtesy(courtesy: () => void): void {
  try {
    courtesy();
  } catch {
    // Provider-specific courtesy is best-effort; group shutdown must proceed.
  }
}

async function shutdownDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function reserveProviderProcessGroup(
  child: ChildProcessWithoutNullStreams
): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  if (!child.connected) {
    return isProviderProcessGroupReserved(child);
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (reserved: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
      child.off("exit", onExit);
      resolve(reserved);
    };
    const onMessage = (message: unknown): void => {
      if (message === "shutdown-ready") {
        settle(true);
      }
    };
    const onDisconnect = (): void => {
      settle(isProviderProcessGroupReserved(child));
    };
    const onExit = (): void => {
      settle(isProviderProcessGroupReserved(child));
    };

    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);
    child.once("exit", onExit);
    try {
      child.send("prepare-shutdown", (error) => {
        if (error !== null) {
          settle(isProviderProcessGroupReserved(child));
        }
      });
    } catch {
      settle(isProviderProcessGroupReserved(child));
    }
  });
}

function trackProviderProcessGroup(
  child: ChildProcessWithoutNullStreams
): void {
  const state: ProviderProcessGroupState = {
    reserved: false
  };
  providerProcessGroups.set(child, state);
  child.on("message", (message: unknown) => {
    if (message === "group-ready") {
      state.reserved = true;
    } else if (message === "group-released") {
      state.reserved = false;
    }
  });
}

function isProviderProcessGroupReserved(
  child: ChildProcessWithoutNullStreams
): boolean {
  return providerProcessGroups.get(child)?.reserved === true;
}

function signalProviderProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals
): boolean {
  const pid = child.pid;
  if (
    process.platform !== "win32" &&
    pid !== undefined &&
    Number.isSafeInteger(pid) &&
    pid > 0
  ) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) {
        return false;
      }
    }
  }

  try {
    child.kill(signal);
  } catch {
    // A spawn failure or concurrent exit can leave no direct child to signal.
  }
  return true;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
