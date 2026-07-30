import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProcessCommand } from "../lifecycle/process-scope.js";

const GRACEFUL_EOF_MS = 250;
const FORCE_KILL_GRACE_MS = 1_000;
const shuttingDown = new WeakSet<ChildProcessWithoutNullStreams>();

export function spawnProviderProcess(
  command: ProcessCommand,
  workspacePath: string
): ChildProcessWithoutNullStreams {
  return spawn(command.executable, command.args, {
    cwd: workspacePath,
    detached: true,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export function shutdownProviderProcess(
  child: ChildProcessWithoutNullStreams
): void {
  if (shuttingDown.has(child)) {
    return;
  }
  shuttingDown.add(child);

  if (!child.stdin.destroyed && child.stdin.writable) {
    child.stdin.end();
  }

  const terminateTimer = setTimeout(() => {
    if (!signalProviderProcess(child, "SIGTERM")) {
      return;
    }

    const killTimer = setTimeout(() => {
      signalProviderProcess(child, "SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, FORCE_KILL_GRACE_MS);
    killTimer.unref();
  }, GRACEFUL_EOF_MS);
  terminateTimer.unref();
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
