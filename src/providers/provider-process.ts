import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProcessCommand } from "../lifecycle/process-scope.js";

const GRACEFUL_EOF_MS = 250;
const FORCE_KILL_GRACE_MS = 1_000;
const SHUTDOWN_PREPARATION_TIMEOUT_MS = 250;
type ProviderShutdownIntent = "cancellation" | "completion";
type ProviderProcessExit = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};
type ProviderShutdownState = {
  acceptingCourtesies: boolean;
  cancellationRequested: boolean;
  courtesies: Array<() => void>;
  promise: Promise<void>;
};
type ProviderProcessGroupState = {
  preserveProviderExit: boolean;
  providerExit?: ProviderProcessExit;
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
    if (settled) {
      process.send?.("shutdown-unavailable");
      return;
    }
    shutdownRequested = true;
    if (process.send !== undefined && process.connected) {
      process.send("shutdown-ready", stopBeforeProviderLaunch);
      return;
    }
    stopBeforeProviderLaunch();
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

function stopBeforeProviderLaunch() {
  if (provider !== undefined || settled) {
    return;
  }
  settled = true;
  const exit = () => {
    process.exit(0);
  };
  if (guardian.exitCode !== null || guardian.signalCode !== null) {
    exit();
    return;
  }
  guardian.once("close", exit);
  if (!guardian.kill("SIGKILL")) {
    exit();
  }
}

function finish(exitCode, signal) {
  if (settled) {
    return;
  }
  settled = true;
  process.send?.({
    exitCode,
    signal,
    type: "provider-exited"
  });

  setTimeout(() => {
    const exit = () => {
      if (signal !== null) {
        process.removeListener("SIGTERM", handleTerminate);
        process.kill(process.pid, signal);
        return;
      }
      process.exit(exitCode ?? 1);
    };

    if (groupTerminating || shutdownRequested) {
      if (groupTerminating) {
        process.removeListener("SIGTERM", handleTerminate);
        process.kill(process.pid, "SIGTERM");
        return;
      }
      exit();
      return;
    }

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
  process.stderr.write(\`\${message}\\n\`);
  try {
    process.kill(-process.pid, "SIGKILL");
    return;
  } catch {
    provider?.kill("SIGKILL");
    guardian.kill("SIGKILL");
  }
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
  workspacePath: string,
  env: NodeJS.ProcessEnv = process.env
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn(command.executable, command.args, {
      cwd: workspacePath,
      env,
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
      env,
      stdio: ["pipe", "pipe", "pipe", "ipc"]
    }
  ) as ChildProcessWithoutNullStreams;
  trackProviderProcessGroup(child);
  return child;
}

export function shutdownProviderProcess(
  child: ChildProcessWithoutNullStreams,
  beforeClose?: () => void,
  intent: ProviderShutdownIntent = "completion"
): Promise<void> {
  const existing = shuttingDown.get(child);
  if (existing !== undefined) {
    if (intent === "cancellation") {
      existing.cancellationRequested = true;
    }
    if (beforeClose !== undefined) {
      if (existing.acceptingCourtesies) {
        existing.courtesies.push(beforeClose);
      }
    }
    return existing.promise;
  }
  const state: ProviderShutdownState = {
    acceptingCourtesies: true,
    cancellationRequested: intent === "cancellation",
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

  const gracefulStartedAt = Date.now();
  const exitedBeforeTerm = await waitForProviderExit(child, GRACEFUL_EOF_MS);
  if (exitedBeforeTerm && !state.cancellationRequested) {
    forceKillProviderProcess(child, true);
    return;
  }
  if (state.cancellationRequested) {
    await remainingShutdownDelay(gracefulStartedAt, GRACEFUL_EOF_MS);
  }
  if (!signalProviderProcess(child, "SIGTERM")) {
    return;
  }

  const forceGraceStartedAt = Date.now();
  if (!state.cancellationRequested) {
    const exitedAfterTerm = await waitForProviderExit(
      child,
      FORCE_KILL_GRACE_MS
    );
    if (exitedAfterTerm && !state.cancellationRequested) {
      forceKillProviderProcess(child, true);
      return;
    }
  }
  if (state.cancellationRequested) {
    await remainingShutdownDelay(forceGraceStartedAt, FORCE_KILL_GRACE_MS);
  }
  forceKillProviderProcess(child);
}

function forceKillProviderProcess(
  child: ChildProcessWithoutNullStreams,
  preserveProviderExit = false
): void {
  if (preserveProviderExit) {
    const group = providerProcessGroups.get(child);
    if (group?.providerExit !== undefined) {
      group.preserveProviderExit = true;
    }
  }
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

async function remainingShutdownDelay(
  startedAt: number,
  duration: number
): Promise<void> {
  const remaining = duration - (Date.now() - startedAt);
  if (remaining > 0) {
    await shutdownDelay(remaining);
  }
}

async function waitForProviderExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (providerHasExited(child)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onMessage = (message: unknown): void => {
      if (providerExitFromMessage(message) !== undefined) {
        settle(true);
      }
    };
    const onExit = (): void => {
      settle(providerHasExited(child));
    };
    const timer = setTimeout(() => {
      settle(providerHasExited(child));
    }, timeoutMs);

    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function providerHasExited(child: ChildProcessWithoutNullStreams): boolean {
  if (process.platform === "win32") {
    return child.exitCode !== null || child.signalCode !== null;
  }
  return providerProcessGroups.get(child)?.providerExit !== undefined;
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
      clearTimeout(preparationTimer);
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
      child.off("exit", onExit);
      resolve(reserved);
    };
    const onMessage = (message: unknown): void => {
      if (message === "shutdown-ready") {
        if (isProviderProcessGroupReserved(child)) {
          settle(true);
        }
      } else if (message === "shutdown-unavailable") {
        settle(false);
      }
    };
    const onDisconnect = (): void => {
      settle(isProviderProcessGroupReserved(child));
    };
    const onExit = (): void => {
      settle(isProviderProcessGroupReserved(child));
    };
    const preparationTimer = setTimeout(() => {
      if (isProviderProcessGroupReserved(child)) {
        settle(true);
      }
    }, SHUTDOWN_PREPARATION_TIMEOUT_MS);

    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);
    child.once("exit", onExit);
    try {
      child.send("prepare-shutdown", (error) => {
        if (error !== null) {
          if (isProviderProcessGroupReserved(child)) {
            settle(true);
          }
        }
      });
    } catch {
      if (isProviderProcessGroupReserved(child)) {
        settle(true);
      }
    }
  });
}

function trackProviderProcessGroup(
  child: ChildProcessWithoutNullStreams
): void {
  const state: ProviderProcessGroupState = {
    preserveProviderExit: false,
    reserved: false
  };
  providerProcessGroups.set(child, state);
  child.on("message", (message: unknown) => {
    if (message === "group-ready") {
      state.reserved = true;
    } else if (message === "group-released") {
      state.reserved = false;
    } else {
      const providerExit = providerExitFromMessage(message);
      if (providerExit !== undefined) {
        state.providerExit = providerExit;
      }
    }
  });
}

export function providerProcessExitResult(
  child: ChildProcessWithoutNullStreams,
  exitCode: number | null,
  signal: NodeJS.Signals | null
): ProviderProcessExit {
  const state = providerProcessGroups.get(child);
  if (
    state?.preserveProviderExit === true &&
    state.providerExit !== undefined
  ) {
    return state.providerExit;
  }
  return { exitCode, signal };
}

function providerExitFromMessage(
  message: unknown
): ProviderProcessExit | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "provider-exited" ||
    !("exitCode" in message) ||
    !("signal" in message)
  ) {
    return undefined;
  }
  const exitCode = message.exitCode;
  const signal = message.signal;
  if (
    (typeof exitCode !== "number" && exitCode !== null) ||
    (typeof signal !== "string" && signal !== null)
  ) {
    return undefined;
  }
  return {
    exitCode,
    signal: signal as NodeJS.Signals | null
  };
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
