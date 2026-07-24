import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import { createHttpApp } from "../src/http/app.js";
import { nextRecurringFireAt } from "../src/routines/schedule.js";
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
  it("shows skip metadata and 24-hour counts on every routine status surface", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    const now = new Date();
    const schedule = { cron: "* * * * *", tz: "Etc/UTC" };
    store.syncRoutines(
      "alpha",
      [
        {
          kind: "report",
          name: "minute-report",
          prompt: "Report.",
          provider: null,
          schedule,
          sourcePath: "/tmp/minute-report.md"
        }
      ],
      { now: new Date(now.getTime() - 2 * 60_000) }
    );
    expect(
      store.skipRoutineFiring({
        attemptedAt: now.toISOString(),
        name: "minute-report",
        nextFireAt: nextRecurringFireAt(schedule, now),
        projectName: "alpha",
        reason: "overlap"
      })
    ).toBe(true);

    try {
      const app = createHttpApp({
        runStore: store,
        stateRoot,
        version: "0.1.0"
      });
      const apiResponse = await app.request("/api/routines");
      const apiBody = (await apiResponse.json()) as {
        routines: Array<Record<string, unknown>>;
      };
      expect(apiBody.routines[0]).toMatchObject({
        lastAttemptedAt: now.toISOString(),
        lastSkipAt: now.toISOString(),
        lastSkipReason: "overlap",
        skipCounts24h: {
          catch_up_window: 0,
          concurrency_cap: 0,
          overlap: 1
        }
      });

      const pageResponse = await app.request("/");
      const page = await pageResponse.text();
      expect(page).toContain("last_attempted_at");
      expect(page).toContain("overlap=1");

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
      expect(dashboard).toContain("overlap=1");

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
      expect(output.stdout).toContain("last_attempted_at");
      expect(output.stdout).toContain("last_skip_reason");
      expect(output.stdout).toContain("overlap=1");
    } finally {
      store.close();
    }
  });

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

  it("POST /api/runs/:id/cancel cancels a routine firing via the store-only fallback", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);
      store.createRoutineFiring({
        id: "fire-live",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      store.updateRoutineFiringState("fire-live", "running");

      // No cancelRun option — exercises the runStore-only fallback path.
      const app = createHttpApp({
        runStore: store,
        stateRoot,
        version: "0.1.0"
      });

      const ok = await app.request("/api/runs/fire-live/cancel", {
        method: "POST"
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ kind: "cancelled" });
      expect(store.getRoutineFiring("fire-live")).toMatchObject({
        cancelReason: "operator",
        state: "cancelled"
      });

      const alreadyTerminal = await app.request(
        "/api/runs/fire-live/cancel",
        { method: "POST" }
      );
      expect(alreadyTerminal.status).toBe(409);
      expect(await alreadyTerminal.json()).toMatchObject({
        kind: "already-terminal",
        state: "cancelled"
      });
    } finally {
      store.close();
    }
  });

  it("reaches an inactive routine's firings only with include_inactive", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      seedRoutine(store);
      store.markRoutinesInactiveForProject("alpha");
      const app = createHttpApp({
        runStore: store,
        stateRoot,
        version: "0.1.0"
      });

      const hiddenResponse = await app.request(
        "/api/routines/daily-report/firings?project=alpha"
      );
      expect(hiddenResponse.status).toBe(404);

      const includedResponse = await app.request(
        "/api/routines/daily-report/firings?project=alpha&include_inactive=true"
      );
      const includedBody = (await includedResponse.json()) as {
        firings: unknown[];
      };
      expect(includedResponse.status).toBe(200);
      expect(includedBody.firings).toEqual([
        expect.objectContaining({ id: "fire-1" })
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

  it("renders a disabled routine's disable reason on the local dashboard page", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md",
          disabled: true
        }
      ]);
      const app = createHttpApp({
        runStore: store,
        stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("Disabled reason");
      expect(body).toContain("operator");
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

  it("renders a disabled routine's disable reason on the terminal status dashboard", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md",
          disabled: true
        }
      ]);

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

      expect(dashboard).toContain("DISABLED_REASON");
      expect(dashboard).toContain("operator");
    } finally {
      store.close();
    }
  });

  it("renders inactive routines on the dashboard only when requested", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      seedRoutine(store);
      store.markRoutinesInactiveForProject("alpha");
      const app = createHttpApp({
        runStore: store,
        stateRoot,
        version: "0.1.0"
      });

      const defaultResponse = await app.request("/");
      const defaultBody = await defaultResponse.text();
      const inactiveResponse = await app.request("/?include_inactive=true");
      const inactiveBody = await inactiveResponse.text();

      expect(defaultBody).not.toContain("daily-report");
      expect(inactiveBody).toContain("daily-report");
      expect(inactiveBody).toContain("inactive");
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
      "project  routine  state  disabled_reason  next_fire_at  last_fired_at  last_attempted_at  last_skip_reason  last_skip_at  skips_24h  pull_requests"
    );
    expect(output.stdout).toContain(
      "alpha  daily-report  active  -  2026-05-22T10:00:00.000Z  -  -  -  -  overlap=0,concurrency_cap=0,catch_up_window=0  #42"
    );
  });

  it("symphonika routines renders the disable reason next to a disabled routine's state", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    store.syncRoutines("alpha", [
      {
        kind: "report",
        name: "daily-report",
        prompt: "Report.",
        provider: null,
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: "/tmp/daily-report.md",
        disabled: true
      }
    ]);
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
      "alpha  daily-report  disabled  operator  "
    );
  });

  it("symphonika routines can include inactive routines", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    seedRoutine(store);
    store.markRoutinesInactiveForProject("alpha");
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
      "--include-inactive",
      "--config",
      path.join(stateRoot, "symphonika.yml")
    ]);

    expect(output.stdout).toContain("alpha  daily-report  inactive  -  -");
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
