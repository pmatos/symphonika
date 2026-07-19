import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import { createHttpApp } from "../src/http/app.js";
import { openRunStore } from "../src/run-store.js";
import { renderStatusDashboard } from "../src/status-dashboard.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-surfaces-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("routine operator surfaces", () => {
  it("GET /api/routines returns routine status rows", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      seedRoutine(store);
      const app = createHttpApp({
        runStore: store,
        stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/api/routines");
      const body = (await response.json()) as { routines: unknown[] };

      expect(response.status).toBe(200);
      expect(body.routines).toEqual([
        expect.objectContaining({
          lastFiredAt: null,
          name: "daily-report",
          nextFireAt: "2026-05-22T10:00:00.000Z",
          projectName: "alpha",
          pullRequestNumbers: [42],
          state: "active"
        })
      ]);

      const firingsResponse = await app.request(
        "/api/routines/daily-report/firings?project=alpha"
      );
      const firingsBody = (await firingsResponse.json()) as {
        firings: unknown[];
      };
      expect(firingsResponse.status).toBe(200);
      expect(firingsBody.firings).toEqual([
        expect.objectContaining({
          id: "fire-1",
          pullRequests: [expect.objectContaining({ prNumber: 42 })]
        })
      ]);
    } finally {
      store.close();
    }
  });

  it("renders routines on the local dashboard page", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      seedRoutine(store);
      const app = createHttpApp({
        runStore: store,
        stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("Routines");
      expect(body).toContain("daily-report");
      expect(body).toContain("next_fire_at");
      expect(body).toContain("#42");
    } finally {
      store.close();
    }
  });

  it("renders linked PR numbers on the terminal status dashboard", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      seedRoutine(store);

      const dashboard = renderStatusDashboard({
        daemon: "running",
        issueCounts: {
          candidate: 0,
          failed: 0,
          filtered: 0,
          running: 0,
          stale: 0
        },
        lastPollOutcome: "ok",
        latestEvents: new Map(),
        projects: [],
        reload: "ok",
        routines: store.listRoutines(),
        runs: [],
        stateRoot
      });

      expect(dashboard).toContain("daily-report");
      expect(dashboard).toContain("#42");
    } finally {
      store.close();
    }
  });

  it("symphonika routines lists routines per project", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    seedRoutine(store);
    store.close();
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      openRunStore: () => openRunStore({ stateRoot }),
      registerSignalHandlers: false
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });
    program.exitOverride();

    await program.parseAsync([
      "node",
      "symphonika",
      "routines",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain(
      "project  routine  state  next_fire_at  last_fired_at  pull_requests"
    );
    expect(output.stdout).toContain(
      "alpha  daily-report  active  2026-05-22T10:00:00.000Z  -  #42"
    );
  });
});

function seedRoutine(store: ReturnType<typeof openRunStore>): void {
  store.syncRoutines("alpha", [
    {
      kind: "git",
      name: "daily-report",
      prompt: "Report.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: "/tmp/daily-report.md"
    }
  ]);
  store.createRoutineFiring({
    id: "fire-1",
    projectName: "alpha",
    providerCommand: "codex fake",
    providerName: "codex",
    routineName: "daily-report"
  });
  store.completeRoutineFiring({
    id: "fire-1",
    state: "succeeded",
    workspacePath: "/tmp/workspace"
  });
  store.recordRoutinePullRequest({
    firingId: "fire-1",
    headSha: "abc123",
    prNumber: 42,
    projectName: "alpha",
    routineName: "daily-report"
  });
}
