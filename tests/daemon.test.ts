import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLogLevel, startDaemon } from "../src/daemon.js";
import { openRunStore, RunStore } from "../src/run-store.js";

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
      configPath: "symphonika.yml",
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
        configPath: "symphonika.yml",
        cwd,
        logger: pino({ enabled: false }),
        port
      })
    ).rejects.toThrow();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("closes the run store when endpoint descriptor removal fails during stop", async () => {
    const cwd = await makeTempRoot();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger: pino({ enabled: false }),
      port: 0
    });
    const closeRunStore = vi.spyOn(RunStore.prototype, "close");
    const endpointPath = path.join(cwd, ".symphonika", "daemon.json");

    try {
      await rm(endpointPath, { force: true });
      await mkdir(endpointPath);

      await expect(daemon.stop()).rejects.toThrow();
      expect(closeRunStore).toHaveBeenCalledTimes(1);
    } finally {
      closeRunStore.mockRestore();
    }
  });
});

describe("startDaemon orphan sweep logging", () => {
  it("emits an info line confirming a clean run store at startup", async () => {
    const cwd = await makeTempRoot();

    const { logger, lines } = createCapturingLogger();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger,
      port: 0
    });
    try {
      const cleanLines = lines.filter(
        (line) => line.msg === "symphonika startup: no orphaned runs found"
      );

      expect(cleanLines).toHaveLength(1);
      expect(cleanLines[0]?.level).toBe(pino.levels.values.info);
      expect(cleanLines[0]?.count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it("emits an info summary line aggregating count and byState", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    seedOrphans(stateRoot, [
      { id: "leaked-running", issueNumber: 101, state: "running" },
      { id: "leaked-waiting", issueNumber: 202, state: "waiting" }
    ]);

    const { logger, lines } = createCapturingLogger();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger,
      port: 0
    });
    try {
      const summaries = lines.filter(
        (line) => line.msg === "symphonika startup: orphan sweep complete"
      );

      expect(summaries).toHaveLength(1);
      const [summary] = summaries;
      expect(summary?.level).toBe(pino.levels.values.info);
      expect(summary?.count).toBe(2);
      expect(summary?.byState).toEqual({ running: 1, waiting: 1 });
    } finally {
      await daemon.stop();
    }
  });

  it("emits one warn line per orphaned non-terminal run", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    seedOrphans(stateRoot, [
      { id: "leaked-running", issueNumber: 101, state: "running" },
      { id: "leaked-waiting", issueNumber: 202, state: "waiting" }
    ]);

    const { logger, lines } = createCapturingLogger();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger,
      port: 0
    });
    try {
      const orphanLines = lines.filter(
        (line) => line.msg === "symphonika startup: marked orphaned run as stale"
      );

      expect(orphanLines).toHaveLength(2);
      for (const line of orphanLines) {
        expect(line.level).toBe(pino.levels.values.warn);
        expect(line.terminalReason).toBe("leaked_active_run");
        expect(line.project).toBe("symphonika");
      }

      const byRunId = new Map(
        orphanLines.map((line) => [line.runId as string, line])
      );
      expect(byRunId.get("leaked-running")).toMatchObject({
        previousState: "running",
        issueNumber: 101
      });
      expect(byRunId.get("leaked-waiting")).toMatchObject({
        previousState: "waiting",
        issueNumber: 202
      });
    } finally {
      await daemon.stop();
    }
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

type CapturedLine = Record<string, unknown>;

function createCapturingLogger(): {
  logger: pino.Logger;
  lines: CapturedLine[];
} {
  const lines: CapturedLine[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback): void {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        for (const part of text.split("\n")) {
          if (part.length > 0) {
            lines.push(JSON.parse(part) as CapturedLine);
          }
        }
      }
      callback();
    }
  });
  return { lines, logger: pino({ level: "debug" }, stream) };
}

type OrphanSeed = {
  id: string;
  issueNumber: number;
  state: "queued" | "preparing_workspace" | "running" | "waiting";
};

function seedOrphans(stateRoot: string, seeds: OrphanSeed[]): void {
  const store = openRunStore({ stateRoot });
  try {
    for (const seed of seeds) {
      store.createRun({
        id: seed.id,
        issue: {
          body: "",
          created_at: "2025-01-01T00:00:00Z",
          id: seed.issueNumber + 1_000_000,
          labels: ["agent-ready"],
          number: seed.issueNumber,
          priority: 1,
          state: "open",
          title: `fixture-${seed.id}`,
          updated_at: "2025-01-01T00:00:00Z",
          url: `https://example/${seed.issueNumber}`
        },
        projectName: "symphonika",
        providerCommand: "fake",
        providerName: "codex"
      });
      if (seed.state !== "queued") {
        store.updateRunState(seed.id, seed.state);
      }
    }
  } finally {
    store.close();
  }
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
