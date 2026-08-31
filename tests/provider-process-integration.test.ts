import { once } from "node:events";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProcessScope } from "../src/lifecycle/process-scope.js";
import {
  shutdownProviderProcess,
  spawnProviderProcess
} from "../src/providers/provider-process.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("provider process lifecycle", () => {
  it.skipIf(process.platform !== "linux")(
    "makes a systemd-wrapped provider tree preferable to its supervisor and guardian as OOM victims",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const fakeSystemdRunPath = path.join(root, "systemd-run");
      const providerPath = path.join(root, "provider.mjs");
      const providerPidPath = path.join(root, "provider.pid");
      const providerScorePath = path.join(root, "provider.score");
      const childPath = path.join(root, "provider-child.mjs");
      const childScorePath = path.join(root, "provider-child.score");
      await writeFile(
        fakeSystemdRunPath,
        [
          "#!/bin/sh",
          'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
          '[ "$#" -gt 0 ] || exit 64',
          "shift",
          'exec "$@"',
          ""
        ].join("\n"),
        "utf8"
      );
      await chmod(fakeSystemdRunPath, 0o755);
      await writeFile(
        childPath,
        [
          "import { readFile, writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(childScorePath)}, (await readFile("/proc/self/oom_score_adj", "utf8")).trim(), "utf8");`,
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        providerPath,
        [
          "import { spawn } from 'node:child_process';",
          "import { readFile, writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(providerPidPath)}, String(process.pid), "utf8");`,
          `await writeFile(${JSON.stringify(providerScorePath)}, (await readFile("/proc/self/oom_score_adj", "utf8")).trim(), "utf8");`,
          `spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: "ignore" });`,
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );

      const scope = createProcessScope({
        isAvailable: () => Promise.resolve(true)
      });
      const wrapped = await scope.wrapForProviderScope(
        { attempt: 1, id: "oom-score" },
        { args: [providerPath], executable: process.execPath }
      );
      const inheritedScore = (
        await readFile("/proc/self/oom_score_adj", "utf8")
      ).trim();
      const expectedProviderScore = String(
        Math.max(500, Number(inheritedScore))
      );
      const child = spawnProviderProcess(wrapped, root, {
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`
      });
      const supervisorPid = child.pid;
      expect(supervisorPid).toBeDefined();
      const closed = once(child, "close");

      try {
        const providerPid = Number(await waitForFileContent(providerPidPath));
        expect(await waitForFileContent(providerScorePath)).toBe(
          expectedProviderScore
        );
        expect(await waitForFileContent(childScorePath)).toBe(
          expectedProviderScore
        );

        const directChildren = (
          await readFile(
            `/proc/${supervisorPid!}/task/${supervisorPid!}/children`,
            "utf8"
          )
        )
          .trim()
          .split(/\s+/)
          .map(Number);
        const guardianPid = directChildren.find((pid) => pid !== providerPid);
        expect(guardianPid).toBeDefined();
        expect(
          (
            await readFile(`/proc/${supervisorPid!}/oom_score_adj`, "utf8")
          ).trim()
        ).toBe(inheritedScore);
        expect(
          (await readFile(`/proc/${guardianPid!}/oom_score_adj`, "utf8")).trim()
        ).toBe(inheritedScore);
      } finally {
        await shutdownProviderProcess(child);
        await closed;
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not launch the provider after shutdown preparation",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const markerPath = path.join(root, "provider-started");
      const providerPath = path.join(root, "provider.mjs");
      await writeFile(
        providerPath,
        [
          "import { writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(markerPath)}, "started", "utf8");`,
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );

      const child = spawnProviderProcess(
        { args: [providerPath], executable: process.execPath },
        root
      );
      const closed = once(child, "close");
      await shutdownProviderProcess(child);
      await closed;

      await expect(access(markerPath)).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );

  it.skipIf(process.platform === "win32")(
    "terminates the reserved group after the supervisor disconnects",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const pidPath = path.join(root, "provider.pid");
      const providerPath = path.join(root, "provider.mjs");
      await writeFile(
        providerPath,
        [
          "import { writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(pidPath)}, String(process.pid), "utf8");`,
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );

      const child = spawnProviderProcess(
        { args: [providerPath], executable: process.execPath },
        root
      );
      const supervisorPid = child.pid;
      expect(supervisorPid).toBeDefined();
      const providerPid = Number(await waitForFileContent(pidPath));

      try {
        const exited = once(child, "exit");
        process.kill(supervisorPid!, "SIGKILL");
        await exited;
        await shutdownProviderProcess(child);

        expect(await processIsRunning(providerPid)).toBe(false);
      } finally {
        try {
          process.kill(-supervisorPid!, "SIGKILL");
        } catch {
          // The shutdown escalation already removed the process group.
        }
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "rejects shutdown reservation after ordinary group release begins",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const providerPath = path.join(root, "provider.mjs");
      await writeFile(providerPath, "process.exit(0);\n", "utf8");

      const child = spawnProviderProcess(
        { args: [providerPath], executable: process.execPath },
        root
      );
      const supervisorPid = child.pid;
      expect(supervisorPid).toBeDefined();
      const realKill = process.kill.bind(process);
      const signalSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((targetPid, signal) => {
          if (targetPid === -supervisorPid!) {
            return true;
          }
          return realKill(targetPid, signal);
        });
      let releaseShutdown: Promise<void> | undefined;
      const releaseSeen = new Promise<void>((resolve) => {
        child.on("message", (message: unknown) => {
          if (message === "group-released" && releaseShutdown === undefined) {
            releaseShutdown = shutdownProviderProcess(child);
            resolve();
          }
        });
      });
      const closed = once(child, "close");

      try {
        await releaseSeen;
        await releaseShutdown;
        await closed;

        expect(
          signalSpy.mock.calls.filter(
            ([targetPid]) => targetPid === -supervisorPid!
          )
        ).toEqual([]);
      } finally {
        signalSpy.mockRestore();
      }
    }
  );

  it.skipIf(process.platform !== "linux")(
    "terminates the whole group when the guardian fails",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const providerPidPath = path.join(root, "provider.pid");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      const grandchildPath = path.join(root, "grandchild.mjs");
      const providerPath = path.join(root, "provider.mjs");
      await writeFile(
        grandchildPath,
        [
          "import { writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(grandchildPidPath)}, String(process.pid), "utf8");`,
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        providerPath,
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(providerPidPath)}, String(process.pid), "utf8");`,
          `spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: "ignore" });`,
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );

      const child = spawnProviderProcess(
        { args: [providerPath], executable: process.execPath },
        root
      );
      const supervisorPid = child.pid;
      let grandchildPid: number | undefined;

      try {
        expect(supervisorPid).toBeDefined();
        const providerPid = Number(await waitForFileContent(providerPidPath));
        grandchildPid = Number(await waitForFileContent(grandchildPidPath));
        const directChildren = (
          await readFile(
            `/proc/${supervisorPid!}/task/${supervisorPid!}/children`,
            "utf8"
          )
        )
          .trim()
          .split(/\s+/)
          .map(Number);
        const guardianPid = directChildren.find((pid) => pid !== providerPid);
        expect(guardianPid).toBeDefined();

        const closed = once(child, "close");
        process.kill(guardianPid!, "SIGKILL");
        await closed;
        await waitForProcessStopped(grandchildPid);
      } finally {
        if (supervisorPid !== undefined) {
          try {
            process.kill(-supervisorPid, "SIGKILL");
          } catch {
            // Guardian failure handling already removed the process group.
          }
        }
        if (grandchildPid !== undefined) {
          await waitForProcessStopped(grandchildPid).catch(() => {
            // Best-effort cleanup after an assertion failure.
          });
        }
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "bounds shutdown preparation when the supervisor is stopped",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const providerPidPath = path.join(root, "provider.pid");
      const providerPath = path.join(root, "provider.mjs");
      await writeFile(
        providerPath,
        [
          "import { writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(providerPidPath)}, String(process.pid), "utf8");`,
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );

      const child = spawnProviderProcess(
        { args: [providerPath], executable: process.execPath },
        root
      );
      const supervisorPid = child.pid;
      expect(supervisorPid).toBeDefined();
      const providerPid = Number(await waitForFileContent(providerPidPath));
      process.kill(supervisorPid!, "SIGSTOP");
      const shutdown = shutdownProviderProcess(child);
      let timeout: NodeJS.Timeout | undefined;

      try {
        const outcome = await Promise.race([
          shutdown.then(() => "resolved" as const),
          new Promise<"timed-out">((resolve) => {
            timeout = setTimeout(() => {
              resolve("timed-out");
            }, 2_500);
          })
        ]);
        expect(outcome).toBe("resolved");
        await waitForProcessStopped(providerPid);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        try {
          process.kill(-supervisorPid!, "SIGKILL");
        } catch {
          // Bounded shutdown already removed the process group.
        }
        await shutdown;
        await waitForProcessStopped(providerPid).catch(() => {
          // Best-effort cleanup after an assertion failure.
        });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "mirrors a provider SIGTERM after ordinary group release",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const providerPath = path.join(root, "provider.mjs");
      await writeFile(
        providerPath,
        [
          'setTimeout(() => process.kill(process.pid, "SIGTERM"), 25);',
          "setInterval(() => {}, 60_000);",
          ""
        ].join("\n"),
        "utf8"
      );

      const child = spawnProviderProcess(
        { args: [providerPath], executable: process.execPath },
        root
      );
      const supervisorPid = child.pid;
      expect(supervisorPid).toBeDefined();
      const closed = once(child, "close") as Promise<
        [number | null, NodeJS.Signals | null]
      >;

      try {
        const result = await Promise.race([
          closed,
          new Promise<undefined>((resolve) => {
            setTimeout(resolve, 750);
          })
        ]);
        expect(result).toEqual([null, "SIGTERM"]);
      } finally {
        try {
          process.kill(-supervisorPid!, "SIGKILL");
        } catch {
          // Ordinary group release already removed the process group.
        }
        await closed;
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "completes ordinary cleanup promptly after the provider exits on EOF",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "symphonika-provider-process-test-")
      );
      tempRoots.push(root);
      const providerPidPath = path.join(root, "provider.pid");
      const providerPath = path.join(root, "provider.mjs");
      await writeFile(
        providerPath,
        [
          "import { writeFile } from 'node:fs/promises';",
          `await writeFile(${JSON.stringify(providerPidPath)}, String(process.pid), "utf8");`,
          "process.stdin.resume();",
          'process.stdin.on("end", () => process.exit(0));',
          ""
        ].join("\n"),
        "utf8"
      );

      const child = spawnProviderProcess(
        { args: [providerPath], executable: process.execPath },
        root
      );
      const supervisorPid = child.pid;
      expect(supervisorPid).toBeDefined();
      await waitForFileContent(providerPidPath);
      const startedAt = Date.now();

      try {
        await shutdownProviderProcess(child);
        expect(Date.now() - startedAt).toBeLessThan(750);
      } finally {
        try {
          process.kill(-supervisorPid!, "SIGKILL");
        } catch {
          // Ordinary cleanup already removed the process group.
        }
      }
    }
  );
});

async function waitForFileContent(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const content = await readFile(filePath, "utf8");
      if (content !== "") {
        return content;
      }
    } catch {
      // The provider has not written its startup marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }

  if (process.platform !== "linux") {
    return true;
  }

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd < 0 || stat.slice(commandEnd + 2, commandEnd + 3) !== "Z";
  } catch (error) {
    return !hasErrorCode(error, "ENOENT");
  }
}

async function waitForProcessStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await processIsRunning(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for process ${pid} to stop`);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
