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
  it("records every pull request discovered for a successful firing", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "git",
          name: "dependency-update",
          prompt: "Update dependencies.",
          provider: "codex",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/dependency-update.md"
        }
      ]);
      store.createRoutineFiring({
        id: "fire-git-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "dependency-update"
      });

      store.recordRoutinePullRequest({
        firingId: "fire-git-1",
        headSha: "abc123",
        prNumber: 17,
        projectName: "alpha",
        routineName: "dependency-update"
      });
      store.recordRoutinePullRequest({
        firingId: "fire-git-1",
        headSha: "def456",
        prNumber: 18,
        projectName: "alpha",
        routineName: "dependency-update"
      });

      expect(
        store.listRoutineFirings({ routineName: "dependency-update" })
      ).toEqual([
        expect.objectContaining({
          id: "fire-git-1",
          pullRequests: [
            {
              firingId: "fire-git-1",
              headSha: "abc123",
              prNumber: 17,
              projectName: "alpha",
              routineName: "dependency-update"
            },
            {
              firingId: "fire-git-1",
              headSha: "def456",
              prNumber: 18,
              projectName: "alpha",
              routineName: "dependency-update"
            }
          ]
        })
      ]);
      expect(store.listRoutines()).toEqual([
        expect.objectContaining({ pullRequestNumbers: [17, 18] })
      ]);
    } finally {
      store.close();
    }
  });

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
          allowOverlap: false,
          catchUp: "skip",
          disabledReason: null,
          kind: "report",
          lastAttemptedAt: null,
          lastFiredAt: null,
          lastSkipAt: null,
          lastSkipReason: null,
          name: "daily-report",
          nextFireAt: "2026-05-22T10:00:00.000Z",
          projectName: "alpha",
          provider: null,
          pullRequestNumbers: [],
          scheduleAt: "2026-05-22T10:00:00.000Z",
          scheduleCron: null,
          scheduleTz: null,
          skipCounts24h: {
            catch_up_window: 0,
            concurrency_cap: 0,
            overlap: 0
          },
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
          allowOverlap: false,
          catchUp: "skip",
          disabledReason: null,
          kind: "report",
          lastAttemptedAt: null,
          lastFiredAt: null,
          lastSkipAt: null,
          lastSkipReason: null,
          name: "daily-report",
          nextFireAt: "2026-03-28T01:30:00.000Z",
          projectName: "alpha",
          provider: null,
          pullRequestNumbers: [],
          scheduleAt: null,
          scheduleCron: "30 1 * * *",
          scheduleTz: "Europe/Lisbon",
          skipCounts24h: {
            catch_up_window: 0,
            concurrency_cap: 0,
            overlap: 0
          },
          sourcePath: "/tmp/daily-report.md",
          state: "active"
        }
      ]);
    } finally {
      store.close();
    }
  });

  it("records a skipped clock attempt and exposes rolling 24-hour counts", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines(
        "alpha",
        [
          {
            allowOverlap: true,
            catchUp: "fire_once_if_missed",
            kind: "report",
            name: "minute-report",
            prompt: "Report.",
            provider: null,
            schedule: { cron: "* * * * *", tz: "Etc/UTC" },
            sourcePath: "/tmp/minute-report.md"
          }
        ],
        { now: new Date("2026-05-23T09:59:30.000Z") }
      );

      const skipped = store.skipRoutineFiring({
        attemptedAt: "2026-05-23T10:00:00.000Z",
        name: "minute-report",
        nextFireAt: "2026-05-23T10:01:00.000Z",
        projectName: "alpha",
        reason: "overlap"
      });

      expect(skipped).toBe(true);
      expect(store.listRoutineFirings()).toEqual([]);
      expect(
        store.listRoutines({ now: new Date("2026-05-23T10:00:00.000Z") })[0]
      ).toMatchObject({
        allowOverlap: true,
        catchUp: "fire_once_if_missed",
        lastAttemptedAt: "2026-05-23T10:00:00.000Z",
        lastSkipAt: "2026-05-23T10:00:00.000Z",
        lastSkipReason: "overlap",
        nextFireAt: "2026-05-23T10:01:00.000Z",
        skipCounts24h: {
          catch_up_window: 0,
          concurrency_cap: 0,
          overlap: 1
        }
      });
      expect(
        store.listRoutines({ now: new Date("2026-05-24T10:00:00.001Z") })[0]
          ?.skipCounts24h.overlap
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  it("keeps a one-shot routine active and due after an overlap or concurrency-cap skip", async () => {
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

      const overlapSkipped = store.skipRoutineFiring({
        attemptedAt: "2026-05-22T10:00:00.000Z",
        name: "daily-report",
        projectName: "alpha",
        reason: "overlap"
      });
      expect(overlapSkipped).toBe(true);
      expect(
        store.listRoutines({ now: new Date("2026-05-22T10:00:01.000Z") })[0]
      ).toEqual(
        expect.objectContaining({
          lastSkipReason: "overlap",
          nextFireAt: "2026-05-22T10:00:00.000Z",
          state: "active"
        })
      );

      const capSkipped = store.skipRoutineFiring({
        attemptedAt: "2026-05-22T10:00:01.000Z",
        name: "daily-report",
        projectName: "alpha",
        reason: "concurrency_cap"
      });
      expect(capSkipped).toBe(true);
      expect(
        store.listRoutines({ now: new Date("2026-05-22T10:00:02.000Z") })[0]
      ).toEqual(
        expect.objectContaining({
          lastSkipReason: "concurrency_cap",
          nextFireAt: "2026-05-22T10:00:00.000Z",
          skipCounts24h: {
            catch_up_window: 0,
            concurrency_cap: 1,
            overlap: 1
          },
          state: "active"
        })
      );

      store.createRoutineFiring({
        id: "fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      expect(store.listRoutineFirings()).toEqual([
        expect.objectContaining({ id: "fire-1", routineName: "daily-report" })
      ]);
    } finally {
      store.close();
    }
  });

  it("soft-disables routines that are no longer configured for the project", async () => {
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

      // Unlike Project-cascade 'inactive' rows, a routine disabled because its
      // path was removed from config stays visible by default, with its
      // reason attached (ADR-0021 precedent applies to Projects, not this).
      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({
          name: "daily-report",
          state: "disabled",
          disabledReason: "removed_from_config"
        })
      );
      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({ name: "weekly-report", state: "active" })
      );

      store.syncRoutines("alpha", []);

      expect(
        store.listRoutines({ project: "alpha" }).map((routine) => routine.name)
      ).toEqual(expect.arrayContaining(["daily-report", "weekly-report"]));
      expect(store.listRoutines({ project: "alpha" })).toContainEqual(
        expect.objectContaining({
          name: "weekly-report",
          state: "disabled",
          disabledReason: "removed_from_config"
        })
      );
    } finally {
      store.close();
    }
  });

  it("marks a routine disabled with reason operator when its declaration sets disabled: true", async () => {
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

      expect(store.listRoutines()[0]).toMatchObject({
        state: "disabled",
        disabledReason: "operator"
      });
    } finally {
      store.close();
    }
  });

  it("keeps a routine disabled even when its schedule changes in the same edit", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: null,
          schedule: { cron: "30 1 * * *", tz: "Etc/UTC" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);
      expect(store.listRoutines()[0]).toMatchObject({ state: "active" });

      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          provider: null,
          schedule: { cron: "0 2 * * *", tz: "Etc/UTC" },
          sourcePath: "/tmp/daily-report.md",
          disabled: true
        }
      ]);

      expect(store.listRoutines({ includeInactive: true })[0]).toMatchObject({
        state: "disabled",
        disabledReason: "operator"
      });
    } finally {
      store.close();
    }
  });

  it("restores a disabled recurring routine with next_fire_at recomputed strictly in the future", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const routine = {
        kind: "report" as const,
        name: "daily-report",
        prompt: "Report.",
        provider: null,
        schedule: { cron: "30 1 * * *", tz: "Europe/Lisbon" },
        sourcePath: "/tmp/daily-report.md",
        disabled: true
      };
      store.syncRoutines("alpha", [routine], {
        now: new Date("2026-03-27T02:00:00.000Z")
      });
      expect(store.listRoutines({ includeInactive: true })[0]).toMatchObject({
        state: "disabled",
        disabledReason: "operator"
      });

      store.syncRoutines("alpha", [{ ...routine, disabled: false }], {
        now: new Date("2026-03-29T02:00:00.000Z")
      });

      expect(store.listRoutines()[0]).toMatchObject({
        state: "active",
        disabledReason: null,
        nextFireAt: "2026-03-30T00:30:00.000Z"
      });
    } finally {
      store.close();
    }
  });

  it("restores a one-shot routine whose at time elapsed while disabled as expired, not active", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const routine = {
        kind: "report" as const,
        name: "one-shot-report",
        prompt: "Report.",
        provider: null,
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: "/tmp/one-shot-report.md",
        disabled: true
      };
      store.syncRoutines("alpha", [routine], {
        now: new Date("2026-05-20T00:00:00.000Z")
      });
      expect(store.listRoutines({ includeInactive: true })[0]).toMatchObject({
        state: "disabled",
        disabledReason: "operator"
      });

      store.syncRoutines("alpha", [{ ...routine, disabled: false }], {
        now: new Date("2026-05-23T00:00:00.000Z")
      });

      expect(store.listRoutines()[0]).toMatchObject({
        state: "expired",
        disabledReason: null
      });
    } finally {
      store.close();
    }
  });

  it("restores a one-shot routine whose at time elapsed while its Project was disabled as expired, not active", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const routine = {
        kind: "report" as const,
        name: "one-shot-report",
        prompt: "Report.",
        provider: null,
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: "/tmp/one-shot-report.md"
      };
      store.syncRoutines("alpha", [routine], {
        now: new Date("2026-05-20T00:00:00.000Z")
      });

      // The Project (not the routine itself) is disabled -- the
      // Project-cascade path, distinct from the routine's own
      // disabled: true front matter.
      store.markRoutinesInactiveForProject("alpha");
      expect(store.listRoutines({ includeInactive: true })[0]).toMatchObject({
        state: "inactive"
      });

      // Project is re-enabled after the one-shot's `at` has elapsed; it
      // never fired while inactive. syncRoutines runs again on the next
      // reload with the same declaration.
      store.syncRoutines("alpha", [routine], {
        now: new Date("2026-05-23T00:00:00.000Z")
      });

      expect(store.listRoutines()[0]).toMatchObject({
        state: "expired",
        disabledReason: null
      });
    } finally {
      store.close();
    }
  });

  it("does not disable a protected routine name that is absent from the declared list", async () => {
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

      store.syncRoutines("alpha", [], {
        protectedNames: ["daily-report"]
      });

      expect(store.listRoutines()[0]).toMatchObject({
        name: "daily-report",
        state: "active"
      });
    } finally {
      store.close();
    }
  });

  it("overwrites a stale operator disabled_reason when a front-matter-disabled routine is then removed from config", async () => {
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
      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({
          name: "daily-report",
          state: "disabled",
          disabledReason: "operator"
        })
      );

      // daily-report's path is now removed from symphonika.yml entirely,
      // while weekly-report stays declared.
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "weekly-report",
          prompt: "Report.",
          provider: null,
          schedule: { at: "2026-05-23T10:00:00.000Z" },
          sourcePath: "/tmp/weekly-report.md"
        }
      ]);

      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({
          name: "daily-report",
          state: "disabled",
          disabledReason: "removed_from_config"
        })
      );
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

  it("clears a stale disabled_reason when markRoutinesInactiveForProject cascades a Project disable", async () => {
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
      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({
          state: "disabled",
          disabledReason: "operator"
        })
      );

      store.markRoutinesInactiveForProject("alpha");

      expect(store.listRoutines({ includeInactive: true })).toContainEqual(
        expect.objectContaining({ state: "inactive", disabledReason: null })
      );
    } finally {
      store.close();
    }
  });

  it("clears a stale disabled_reason when pruneRoutinesForUnknownProjects cascades a Project removal", async () => {
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
      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({
          state: "disabled",
          disabledReason: "operator"
        })
      );

      store.pruneRoutinesForUnknownProjects(["beta"]);

      expect(store.listRoutines({ includeInactive: true })).toContainEqual(
        expect.objectContaining({ state: "inactive", disabledReason: null })
      );
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

  it("reconciles leaked routine firings so the overlap gate is freed", async () => {
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
            provider: "codex",
            schedule: { cron: "30 1 * * *", tz: "Europe/Lisbon" },
            sourcePath: "/tmp/daily-report.md"
          }
        ],
        { now: new Date("2026-03-27T02:00:00.000Z") }
      );
      store.createRoutineFiring({
        id: "leaked-fire",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      store.updateRoutineFiringState("leaked-fire", "running");
      expect(
        store.hasActiveRoutineFiring({
          name: "daily-report",
          projectName: "alpha"
        })
      ).toBe(true);

      const swept = store.reconcileLeakedRoutineFirings();

      expect(swept).toEqual([
        {
          firingId: "leaked-fire",
          previousState: "running",
          projectName: "alpha",
          routineName: "daily-report"
        }
      ]);
      expect(
        store.hasActiveRoutineFiring({
          name: "daily-report",
          projectName: "alpha"
        })
      ).toBe(false);
      expect(store.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "leaked-fire",
          state: "failed",
          terminalReason: "leaked_routine_firing"
        })
      ]);
      expect(
        store
          .listRoutineFiringTransitions("leaked-fire")
          .map((entry) => entry.state)
      ).toEqual(["queued", "running", "failed"]);
    } finally {
      store.close();
    }
  });

  it("reconcileLeakedRoutineFirings leaves terminal firings untouched", async () => {
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
        id: "done-fire",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });
      store.completeRoutineFiring({ id: "done-fire", state: "succeeded" });

      expect(store.reconcileLeakedRoutineFirings()).toEqual([]);
      expect(store.listRoutineFirings()).toEqual([
        expect.objectContaining({ id: "done-fire", state: "succeeded" })
      ]);
    } finally {
      store.close();
    }
  });

  it("getRoutineFiring returns a single firing by id and undefined for an unknown id", async () => {
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
        id: "fire-lookup",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });

      expect(store.getRoutineFiring("fire-lookup")).toMatchObject({
        id: "fire-lookup",
        projectName: "alpha",
        routineName: "daily-report",
        state: "queued",
        cancelRequested: false,
        cancelReason: null
      });
      expect(store.getRoutineFiring("does-not-exist")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("markRoutineFiringCancelRequested marks a firing as cancel-requested", async () => {
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
        id: "fire-cancel",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });

      store.markRoutineFiringCancelRequested("fire-cancel", "operator");

      expect(store.getRoutineFiring("fire-cancel")).toMatchObject({
        cancelRequested: true,
        cancelReason: "operator"
      });
    } finally {
      store.close();
    }
  });

  it("completeRoutineFiring records the cancel reason for a cancelled firing", async () => {
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
        id: "fire-completed-cancel",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      });

      store.completeRoutineFiring({
        id: "fire-completed-cancel",
        state: "cancelled",
        cancelReason: "operator"
      });

      expect(store.getRoutineFiring("fire-completed-cancel")).toMatchObject({
        state: "cancelled",
        cancelReason: "operator"
      });
    } finally {
      store.close();
    }
  });

  it("upsertInvalidRoutineStub creates an invalid row once and does not overwrite an existing row", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.upsertInvalidRoutineStub({
        name: "broken-routine",
        projectName: "alpha",
        sourcePath: "/tmp/broken-routine.md"
      });

      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({
          name: "broken-routine",
          projectName: "alpha",
          state: "invalid"
        })
      );

      // A subsequent stub call for an already-active routine of the same
      // name must never clobber real, valid configuration.
      store.syncRoutines("alpha", [
        {
          kind: "report",
          name: "broken-routine",
          prompt: "Now valid.",
          provider: null,
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/broken-routine.md"
        }
      ]);
      store.upsertInvalidRoutineStub({
        name: "broken-routine",
        projectName: "alpha",
        sourcePath: "/tmp/broken-routine.md"
      });

      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({ name: "broken-routine", state: "active" })
      );
    } finally {
      store.close();
    }
  });

  it("restores a dormant invalid stub to state=invalid when its still-broken declaration reappears", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.upsertInvalidRoutineStub({
        name: "broken-routine",
        projectName: "alpha",
        sourcePath: "/tmp/broken-routine.md"
      });
      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({ name: "broken-routine", state: "invalid" })
      );

      // The routine's Project is disabled, cascading the still-invalid stub
      // to 'inactive' -- simulating the operator disabling the Project
      // while the broken declaration is present.
      store.markRoutinesInactiveForProject("alpha");
      expect(store.listRoutines({ includeInactive: true })).toContainEqual(
        expect.objectContaining({ name: "broken-routine", state: "inactive" })
      );

      // Project is re-enabled; the declaration is still broken, so the
      // reload pipeline calls upsertInvalidRoutineStub again with the same
      // identity. The dormant stub must be reclaimed back to 'invalid'
      // rather than staying stuck at 'inactive'.
      store.upsertInvalidRoutineStub({
        name: "broken-routine",
        projectName: "alpha",
        sourcePath: "/tmp/broken-routine.md"
      });

      expect(store.listRoutines()).toContainEqual(
        expect.objectContaining({
          name: "broken-routine",
          state: "invalid",
          disabledReason: null
        })
      );
    } finally {
      store.close();
    }
  });
});
