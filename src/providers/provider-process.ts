import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProcessCommand } from "../lifecycle/process-scope.js";

const GRACEFUL_EOF_MS = 250;
const FORCE_KILL_GRACE_MS = 1_000;
const shuttingDown = new WeakSet<ChildProcessWithoutNullStreams>();
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
const handleTerminate = () => {
  groupTerminating = true;
};
process.on("SIGTERM", handleTerminate);

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
    if (groupTerminating) {
      process.removeListener("SIGTERM", handleTerminate);
      process.kill(process.pid, "SIGTERM");
      return;
    }

    const exit = () => {
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(exitCode ?? 1);
    };

    if (guardian.exitCode !== null || guardian.signalCode !== null) {
      exit();
      return;
    }
    guardian.once("close", exit);
    if (!guardian.kill("SIGKILL")) {
      exit();
    }
  }, 25);
}

function fail(message) {
  if (settled) {
    return;
  }
  settled = true;
  provider?.kill("SIGKILL");
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
  if (message !== "ready" || groupTerminating || settled) {
    return;
  }
  provider = spawn(executable, args, { stdio: "inherit" });
  provider.once("error", (error) => {
    process.stderr.write(\`failed to spawn provider: \${error.message}\\n\`);
    finish(127, null);
  });
  provider.once("close", finish);
});
`;

export function spawnProviderProcess(
  command: ProcessCommand,
  workspacePath: string
): ChildProcessWithoutNullStreams {
  const executable =
    process.platform === "win32" ? command.executable : process.execPath;
  const args =
    process.platform === "win32"
      ? command.args
      : [
          "--input-type=module",
          "--eval",
          PROVIDER_SUPERVISOR_SOURCE,
          command.executable,
          ...command.args
        ];
  return spawn(executable, args, {
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
