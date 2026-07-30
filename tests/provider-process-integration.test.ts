import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
