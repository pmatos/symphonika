import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-routine-store-"));
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

describe("RunStore routines", () => {
  it("upserts routines and lists operator status fields", async () => {
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

      expect(store.listRoutines()).toEqual([
        {
          kind: "report",
          lastFiredAt: null,
          name: "daily-report",
          nextFireAt: "2026-05-22T10:00:00.000Z",
          projectName: "alpha",
          provider: null,
          scheduleAt: "2026-05-22T10:00:00.000Z",
          scheduleCron: null,
          scheduleTz: null,
          sourcePath: "/tmp/daily-report.md",
          state: "active"
        }
      ]);
    } finally {
      store.close();
    }
  });

  it("persists the next clock event for a recurring routine", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines(
        "alpha",
        [
          {
            kind: "report",
            name: "daily-report",
            prompt: "Report.",
            provider: null,
            schedule: {
              cron: "30 1 * * *",
              tz: "Europe/Lisbon"
            },
            sourcePath: "/tmp/daily-report.md"
          }
        ],
        { now: new Date("2026-03-27T02:00:00.000Z") }
      );

      expect(store.listRoutines()).toEqual([
        {
          kind: "report",
          lastFiredAt: null,
          name: "daily-report",
          nextFireAt: "2026-03-28T01:30:00.000Z",
          projectName: "alpha",
          provider: null,
          scheduleAt: null,
          scheduleCron: "30 1 * * *",
          scheduleTz: "Europe/Lisbon",
          sourcePath: "/tmp/daily-report.md",
          state: "active"
        }
      ]);
    } finally {
      store.close();
    }
  });

  it("removes routines that are no longer configured for the project", async () => {
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
        },
        {
          kind: "report",
          name: "weekly-report",
          prompt: "Report.",
          provider: null,
          schedule: { at: "2026-05-23T10:00:00.000Z" },
          sourcePath: "/tmp/weekly-report.md"
        }
      ]);

      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "weekly-report",
          prompt: "Updated report.",
          provider: null,
          schedule: { at: "2026-05-24T10:00:00.000Z" },
          sourcePath: "/tmp/weekly-report.md"
        }
      ]);

      expect(store.listRoutines().map((routine) => routine.name)).toEqual([
        "weekly-report"
      ]);
      store.syncRoutines("alpha", []);
      expect(store.listRoutines({ project: "alpha" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("prunes routines for removed projects while preserving firing evidence", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: "codex",
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

      store.pruneRoutinesForUnknownProjects(["beta"]);

      expect(store.listRoutines()).toEqual([]);
      expect(store.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-1",
          projectName: "alpha",
          routineName: "daily-report"
        })
      ]);
    } finally {
      store.close();
    }
  });

  it("records a firing and expires the one-shot routine", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: "codex",
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
      store.updateRoutineFiringState("fire-1", "preparing_workspace");
      store.updateRoutineFiringState("fire-1", "running");
      store.completeRoutineFiring({
        id: "fire-1",
        state: "succeeded",
        workspacePath: "/tmp/workspace"
      });
      store.markRoutineExpired({
        firedAt: "2026-05-22T10:00:02.000Z",
        name: "daily-report",
        projectName: "alpha"
      });

      expect(store.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-1",
          projectName: "alpha",
          provider: "codex",
          routineName: "daily-report",
          state: "succeeded",
          terminalReason: null,
          workspacePath: "/tmp/workspace"
        })
      ]);
      expect(
        store.listRoutineFiringTransitions("fire-1").map((entry) => entry.state)
      ).toEqual(["queued", "preparing_workspace", "running", "succeeded"]);
      expect(store.listRoutines()[0]).toEqual(
        expect.objectContaining({
          lastFiredAt: "2026-05-22T10:00:02.000Z",
          nextFireAt: null,
          state: "expired"
        })
      );
    } finally {
      store.close();
    }
  });

  it("claimRoutineFiring inserts the firing only when the claim wins", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: "codex",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);

      const first = store.claimRoutineFiring({
        firedAt: "2026-05-22T10:00:02.000Z",
        firingId: "fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      const second = store.claimRoutineFiring({
        firedAt: "2026-05-22T10:00:03.000Z",
        firingId: "fire-2",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(store.listRoutineFirings().map((firing) => firing.id)).toEqual([
        "fire-1"
      ]);
      expect(store.listRoutines()[0]).toEqual(
        expect.objectContaining({
          lastFiredAt: "2026-05-22T10:00:02.000Z",
          state: "expired"
        })
      );
    } finally {
      store.close();
    }
  });

  it("claims a recurring tick once and advances its next fire time", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const routine = {
        kind: "report" as const,
        name: "daily-report",
        prompt: "Report.",
        provider: "codex" as const,
        schedule: { cron: "30 1 * * *", tz: "Europe/Lisbon" },
        sourcePath: "/tmp/daily-report.md"
      };
      store.syncRoutines("alpha", [routine], {
        now: new Date("2026-03-27T02:00:00.000Z")
      });

      const first = store.claimRoutineFiring({
        firedAt: "2026-03-28T01:30:00.000Z",
        firingId: "fire-1",
        nextFireAt: "2026-03-29T01:30:00.000Z",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      const duplicate = store.claimRoutineFiring({
        firedAt: "2026-03-28T01:30:00.000Z",
        firingId: "fire-2",
        nextFireAt: "2026-03-29T01:30:00.000Z",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      store.completeRoutineFiring({ id: "fire-1", state: "failed" });

      expect(first).toBe(true);
      expect(duplicate).toBe(false);
      expect(store.listRoutineFirings().map((firing) => firing.id)).toEqual([
        "fire-1"
      ]);
      expect(store.listRoutines()[0]).toMatchObject({
        lastFiredAt: "2026-03-28T01:30:00.000Z",
        nextFireAt: "2026-03-29T01:30:00.000Z",
        state: "active"
      });
    } finally {
      store.close();
    }
  });

  it("recomputes recurring next fire time from now on daemon startup", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const routine = {
        kind: "report" as const,
        name: "daily-report",
        prompt: "Report.",
        provider: null,
        schedule: { cron: "30 1 * * *", tz: "Europe/Lisbon" },
        sourcePath: "/tmp/daily-report.md"
      };
      store.syncRoutines("alpha", [routine], {
        now: new Date("2026-03-27T02:00:00.000Z")
      });
      expect(store.listRoutines()[0]?.nextFireAt).toBe(
        "2026-03-28T01:30:00.000Z"
      );

      store.syncRoutines("alpha", [routine], {
        now: new Date("2026-03-29T02:00:00.000Z"),
        recomputeRecurring: true
      });

      expect(store.listRoutines()[0]?.nextFireAt).toBe(
        "2026-03-30T00:30:00.000Z"
      );
    } finally {
      store.close();
    }
  });

  it("markRoutineExpired claims active routines exactly once", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: "codex",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);

      const firstClaim = store.markRoutineExpired({
        firedAt: "2026-05-22T10:00:02.000Z",
        name: "daily-report",
        projectName: "alpha"
      });
      const secondClaim = store.markRoutineExpired({
        firedAt: "2026-05-22T10:00:03.000Z",
        name: "daily-report",
        projectName: "alpha"
      });

      expect(firstClaim).toBe(true);
      expect(secondClaim).toBe(false);
      expect(store.listRoutines()[0]?.lastFiredAt).toBe(
        "2026-05-22T10:00:02.000Z"
      );
    } finally {
      store.close();
    }
  });
});
