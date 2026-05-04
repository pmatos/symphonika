import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { resolveLogLevel, startDaemon } from "../src/daemon.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-daemon-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("startDaemon", () => {
  it("starts a non-dispatching local HTTP daemon", async () => {
    const cwd = await makeTempRoot();
    const daemon = await startDaemon({
      cwd,
      logger: pino({ enabled: false }),
      port: 0
    });
    const endpointPath = path.join(cwd, ".symphonika", "daemon.json");

    try {
      const response = await fetch(`${daemon.url}/health`);
      const body: unknown = await response.json();
      const endpoint = JSON.parse(await readFile(endpointPath, "utf8")) as unknown;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        service: "symphonika",
        stateRoot: path.join(cwd, ".symphonika")
      });
      expect(isRecord(body)).toBe(true);
      if (isRecord(body)) {
        expect(typeof body.uptimeMs).toBe("number");
      }
      expect(endpoint).toMatchObject({
        stateRoot: path.join(cwd, ".symphonika"),
        url: daemon.url
      });
    } finally {
      await daemon.stop();
    }
    await expect(readFile(endpointPath, "utf8")).rejects.toThrow();
  });

  it("cleans up the HTTP listener when endpoint descriptor writing fails", async () => {
    const cwd = await makeTempRoot();
    const port = await getFreePort();
    await mkdir(path.join(cwd, ".symphonika", "daemon.json"), {
      recursive: true
    });

    await expect(
      startDaemon({
        cwd,
        logger: pino({ enabled: false }),
        port
      })
    ).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});

describe("resolveLogLevel", () => {
  it("defaults to info when no env var is set", () => {
    expect(resolveLogLevel({})).toBe("info");
  });

  it("honours PINO_LOG_LEVEL", () => {
    expect(resolveLogLevel({ PINO_LOG_LEVEL: "debug" })).toBe("debug");
  });

  it("honours LOG_LEVEL as an alias", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "warn" })).toBe("warn");
  });

  it("prefers PINO_LOG_LEVEL over LOG_LEVEL when both are set", () => {
    expect(
      resolveLogLevel({ PINO_LOG_LEVEL: "trace", LOG_LEVEL: "warn" }),
    ).toBe("trace");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("free port lookup failed")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}
