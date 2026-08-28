import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-http-test-"));
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

describe("HTTP app", () => {
  it("returns daemon health details", async () => {
    const app = createHttpApp({
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 1_000,
      version: "0.1.0",
      now: () => 1_250
    });

    const response = await app.request("/health");
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      service: "symphonika",
      version: "0.1.0",
      stateRoot: "/tmp/symphonika-state",
      uptimeMs: 250
    });
  });

  it("surfaces filteredIssues carrying sym:stale in a dedicated staleIssues array", async () => {
    const baseIssue = {
      body: "",
      created_at: "2025-01-01T00:00:00Z",
      id: 1,
      number: 1,
      priority: 0,
      state: "open",
      title: "stale fixture",
      updated_at: "2025-01-01T00:00:00Z",
      url: "https://example/1"
    };
    const stale = {
      issue: {
        ...baseIssue,
        labels: ["agent-ready", "sym:claimed", "sym:stale"],
        number: 9
      },
      project: "p",
      reasons: ["has operational label sym:stale"],
      repository: { owner: "pmatos", repo: "symphonika" }
    };
    const claimed = {
      issue: {
        ...baseIssue,
        labels: ["agent-ready", "sym:claimed"],
        number: 10
      },
      project: "p",
      reasons: ["has operational label sym:claimed"],
      repository: { owner: "pmatos", repo: "symphonika" }
    };

    const app = createHttpApp({
      issuePollStatus: {
        candidateIssues: [],
        errors: [],
        filteredIssues: [stale, claimed],
        projects: []
      },
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 1_000,
      version: "0.1.0",
      now: () => 1_001
    });

    const response = await app.request("/api/status");
    const body = (await response.json()) as { staleIssues: (typeof claimed)[] };
    expect(body.staleIssues).toEqual([stale]);
  });

  it("reports an idle non-dispatching status", async () => {
    const app = createHttpApp({
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 2_000,
      version: "0.1.0",
      now: () => 2_100
    });

    const response = await app.request("/api/status");
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      active: [],
      candidateIssues: [],
      dispatching: false,
      inFlight: 0,
      filteredIssues: [],
      issuePolling: {
        errors: [],
        projects: []
      },
      projectStates: [],
      reload: {
        errors: [],
        lastAttemptedAt: null,
        lastLoadedAt: null,
        ok: true,
        routineErrors: [],
        usingLastKnownGood: false
      },
      lastTickAt: null,
      routines: [],
      runs: [],
      scheduled: [],
      service: "symphonika",
      staleIssues: [],
      state: "idle",
      stateRoot: "/tmp/symphonika-state",
      tickAgeMs: null,
      uptimeMs: 100
    });
  });

  it("reports how long ago the daemon's last successful tick was", async () => {
    const app = createHttpApp({
      getLastTickAt: () => 1_000,
      now: () => 1_450,
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 1_000,
      version: "0.1.0"
    });

    const response = await app.request("/api/status");
    const body = (await response.json()) as {
      lastTickAt: number | null;
      tickAgeMs: number | null;
    };

    expect(body.lastTickAt).toBe(1_000);
    expect(body.tickAgeMs).toBe(450);
  });

  it("reports null tick liveness before the daemon has completed a first tick", async () => {
    const app = createHttpApp({
      now: () => 1_450,
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 1_000,
      version: "0.1.0"
    });

    const response = await app.request("/api/status");
    const body = (await response.json()) as {
      lastTickAt: number | null;
      tickAgeMs: number | null;
    };

    expect(body.lastTickAt).toBeNull();
    expect(body.tickAgeMs).toBeNull();
  });

  it("exposes durable project cursor state in status", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      runStore.syncProjectStates([{ name: "alpha", weight: 2 }]);
      runStore.recordProjectPollOutcome({
        candidateIssues: 1,
        fetchedIssues: 3,
        filteredIssues: 2,
        ok: true,
        projectName: "alpha"
      });

      const app = createHttpApp({
        runStore,
        stateRoot,
        startedAtMs: 2_000,
        version: "0.1.0",
        now: () => 2_100
      });

      const response = await app.request("/api/status");
      const body = (await response.json()) as {
        projectStates?: Array<Record<string, unknown>>;
      };

      expect(response.status).toBe(200);
      expect(body.projectStates).toEqual([
        expect.objectContaining({
          lastCandidateIssues: 1,
          lastFetchedIssues: 3,
          lastFilteredIssues: 2,
          lastPollOk: true,
          projectName: "alpha",
          validationState: "valid",
          weight: 2
        })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("exposes watchdog idle timing on active runs in status", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      runStore.createRun({
        id: "idle-run",
        issue: {
          body: "",
          created_at: "",
          id: 202,
          labels: [],
          number: 202,
          priority: 99,
          state: "open",
          title: "Watchdog surface",
          updated_at: "",
          url: ""
        },
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("idle-run", "running");
      runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T11:45:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: "",
        outputTokensTotal: 0,
        runId: "idle-run",
        sampledAt: "2026-05-22T11:59:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: 0
      });

      const app = createHttpApp({
        getActiveRuns: () => [
          {
            cancelReason: null,
            cancelRequested: false,
            issueNumber: 202,
            projectName: "alpha",
            runId: "idle-run"
          }
        ],
        now: () => Date.parse("2026-05-22T12:00:00.000Z"),
        runStore,
        stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/api/status");
      const body = (await response.json()) as {
        active: Array<{ watchdog?: unknown }>;
      };

      expect(body.active[0]?.watchdog).toEqual({
        enabled: true,
        graceRemainingMs: 900_000,
        idleSince: "2026-05-22T11:45:00.000Z"
      });
    } finally {
      runStore.close();
    }
  });

  it("reports only enabled false for active runs when the watchdog is disabled", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      runStore.createRun({
        id: "disabled-run",
        issue: {
          body: "",
          created_at: "",
          id: 202,
          labels: [],
          number: 202,
          priority: 99,
          state: "open",
          title: "Watchdog surface",
          updated_at: "",
          url: ""
        },
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("disabled-run", "running");
      runStore.upsertWatchdogSample({
        idleSince: "2026-05-22T11:45:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: "",
        outputTokensTotal: 0,
        runId: "disabled-run",
        sampledAt: "2026-05-22T11:59:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: 0
      });

      const app = createHttpApp({
        getActiveRuns: () => [
          {
            cancelReason: null,
            cancelRequested: false,
            issueNumber: 202,
            projectName: "alpha",
            runId: "disabled-run"
          }
        ],
        getWatchdogConfig: () => ({
          enabled: false,
          graceMinutes: 30,
          outputTokenBudget: 0
        }),
        runStore,
        stateRoot,
        version: "0.1.0"
      });
      const response = await app.request("/api/status");
      const body = (await response.json()) as {
        active: Array<{ watchdog?: unknown }>;
      };

      expect(body.active[0]?.watchdog).toEqual({ enabled: false });
    } finally {
      runStore.close();
    }
  });

  it("POST /api/poll-now invokes the daemon trigger and returns a poll summary", async () => {
    let calls = 0;
    const app = createHttpApp({
      pollNow: () => {
        calls += 1;
        return Promise.resolve({
          candidateIssues: 2,
          dispatching: false,
          errors: 0,
          filteredIssues: 1,
          issuePolling: {
            errors: [],
            projects: [
              {
                candidateIssues: 2,
                fetchedIssues: 3,
                filteredIssues: 1,
                name: "alpha",
                ok: true,
                repository: { owner: "pmatos", repo: "symphonika" }
              }
            ]
          },
          kind: "queued",
          state: "idle"
        });
      },
      stateRoot: "/tmp/symphonika-state",
      version: "0.1.0"
    });

    const response = await app.request("/api/poll-now", { method: "POST" });
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(body).toEqual({
      candidateIssues: 2,
      dispatching: false,
      errors: 0,
      filteredIssues: 1,
      issuePolling: {
        errors: [],
        projects: [
          {
            candidateIssues: 2,
            fetchedIssues: 3,
            filteredIssues: 1,
            name: "alpha",
            ok: true,
            repository: { owner: "pmatos", repo: "symphonika" }
          }
        ]
      },
      kind: "queued",
      state: "idle"
    });
  });

  it("POST /api/update-now forces one update cycle and returns its outcome", async () => {
    const requests: { checkOnly: boolean }[] = [];
    const app = createHttpApp({
      stateRoot: "/tmp/symphonika-state",
      updateNow: (input) => {
        requests.push(input);
        return Promise.resolve({
          fromVersion: "0.1.7",
          kind: "updated",
          restart: "requested",
          toVersion: "0.1.8"
        });
      },
      version: "0.1.7"
    });

    const response = await app.request("/api/update-now", { method: "POST" });

    expect(response.status).toBe(200);
    expect(requests).toEqual([{ checkOnly: false }]);
    expect(await response.json()).toEqual({
      fromVersion: "0.1.7",
      kind: "updated",
      restart: "requested",
      toVersion: "0.1.8"
    });
  });

  it("POST /api/update-now?check=true asks for a dry run", async () => {
    const requests: { checkOnly: boolean }[] = [];
    const app = createHttpApp({
      stateRoot: "/tmp/symphonika-state",
      updateNow: (input) => {
        requests.push(input);
        return Promise.resolve({
          currentVersion: "0.1.7",
          kind: "available",
          latestVersion: "0.1.8",
          selfUpdateEnabled: true
        });
      },
      version: "0.1.7"
    });

    const response = await app.request("/api/update-now?check=true", {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(requests).toEqual([{ checkOnly: true }]);
  });

  it("POST /api/update-now reports 503 when no update trigger is wired", async () => {
    const app = createHttpApp({
      stateRoot: "/tmp/symphonika-state",
      version: "0.1.7"
    });

    const response = await app.request("/api/update-now", { method: "POST" });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "update trigger unavailable",
      kind: "unavailable"
    });
  });

  it("POST /api/routines/:id/fire routes a manual firing request through the daemon", async () => {
    const requests: unknown[] = [];
    const app = createHttpApp({
      fireRoutine: (request) => {
        requests.push(request);
        return {
          firingId: "manual-fire-1",
          kind: "accepted",
          projectName: "alpha",
          routineName: "daily-report",
          state: "queued"
        };
      },
      stateRoot: "/tmp/symphonika-state",
      version: "0.1.0"
    });

    const response = await app.request(
      "/api/routines/daily-report/fire?project=alpha&force=true",
      { method: "POST" }
    );

    expect(response.status).toBe(202);
    expect(requests).toEqual([
      {
        force: true,
        projectName: "alpha",
        routineName: "daily-report"
      }
    ]);
    expect(await response.json()).toEqual({
      firingId: "manual-fire-1",
      kind: "accepted",
      projectName: "alpha",
      routineName: "daily-report",
      state: "queued"
    });
  });
});
