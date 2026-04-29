import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { startDaemon } from "../src/daemon.js";

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

    try {
      const response = await fetch(`${daemon.url}/health`);
      const body: unknown = await response.json();

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
    } finally {
      await daemon.stop();
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
