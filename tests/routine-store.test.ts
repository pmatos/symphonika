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
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
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
      expect(store.listRoutineFiringTransitions("fire-1").map((entry) => entry.state)).toEqual([
        "queued",
        "preparing_workspace",
        "running",
        "succeeded"
      ]);
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
});
