import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import type { ChangeEvent } from "../src/run-store.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-run-store-change-events-")
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

function sampleIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "",
    id: 1,
    labels: [],
    number: 1,
    priority: 99,
    state: "open",
    title: "issue",
    updated_at: "",
    url: "",
    ...overrides
  };
}

describe("RunStore — change notification path (#305, ADR 0074)", () => {
  it("publishes a run-transition event on create and on every state update", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      const events: ChangeEvent[] = [];
      runStore.subscribeToChanges((event) => events.push(event));

      runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      runStore.updateRunState("run-a", "running");

      expect(events).toEqual([
        {
          kind: "run-transition",
          runId: "run-a",
          sequence: 1,
          state: "queued"
        },
        {
          kind: "run-transition",
          runId: "run-a",
          sequence: 2,
          state: "running"
        }
      ]);
    } finally {
      runStore.close();
    }
  });

  it("publishes a firing-transition event on create and completion", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: "codex",
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);

      const events: ChangeEvent[] = [];
      runStore.subscribeToChanges((event) => events.push(event));

      runStore.createRoutineFiring({
        id: "fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });
      runStore.completeRoutineFiring({ id: "fire-1", state: "succeeded" });

      expect(events).toEqual([
        {
          firingId: "fire-1",
          kind: "firing-transition",
          sequence: 1,
          state: "queued"
        },
        {
          firingId: "fire-1",
          kind: "firing-transition",
          sequence: 2,
          state: "succeeded"
        }
      ]);
    } finally {
      runStore.close();
    }
  });

  it("does not publish a firing transition when a duplicate claim rolls back", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: "codex",
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);

      const events: ChangeEvent[] = [];
      runStore.subscribeToChanges((event) => events.push(event));

      const firstClaim = runStore.claimRoutineFiring({
        firedAt: "2026-05-22T10:00:02.000Z",
        firingId: "fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      const duplicateClaim = runStore.claimRoutineFiring({
        firedAt: "2026-05-22T10:00:03.000Z",
        firingId: "fire-2",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });

      expect(firstClaim).toBe(true);
      expect(duplicateClaim).toBe(false);
      expect(runStore.listRoutineFirings().map((firing) => firing.id)).toEqual([
        "fire-1"
      ]);
      expect(events).toEqual([
        {
          firingId: "fire-1",
          kind: "firing-transition",
          sequence: 1,
          state: "queued"
        }
      ]);
    } finally {
      runStore.close();
    }
  });

  it("does not publish a firing transition when a manual claim rolls back", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      const events: ChangeEvent[] = [];
      runStore.subscribeToChanges((event) => events.push(event));

      const claimed = runStore.claimManualRoutineFiring({
        firingId: "manual-fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "no-such-routine"
      });

      expect(claimed).toBe(false);
      expect(runStore.listRoutineFirings()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      runStore.close();
    }
  });

  it("publishes a project-poll event carrying only the poll outcome, not issue detail", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      const events: ChangeEvent[] = [];
      runStore.subscribeToChanges((event) => events.push(event));

      runStore.recordProjectPollOutcome({
        candidateIssues: 3,
        error: null,
        fetchedIssues: 10,
        filteredIssues: 3,
        ok: true,
        projectName: "alpha"
      });

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.kind).toBe("project-poll");
      expect(event).toMatchObject({
        kind: "project-poll",
        ok: true,
        projectName: "alpha"
      });
    } finally {
      runStore.close();
    }
  });

  it("publishes a reload-outcome event via publishReloadOutcome", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      const events: ChangeEvent[] = [];
      runStore.subscribeToChanges((event) => events.push(event));

      runStore.publishReloadOutcome({ errors: ["bad workflow"], ok: false });

      expect(events).toEqual([
        { errors: ["bad workflow"], kind: "reload-outcome", ok: false }
      ]);
    } finally {
      runStore.close();
    }
  });

  it("stops delivering to a listener once unsubscribed, without affecting other listeners", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      const kept: ChangeEvent[] = [];
      const removed: ChangeEvent[] = [];
      runStore.subscribeToChanges((event) => kept.push(event));
      const unsubscribeRemoved = runStore.subscribeToChanges((event) =>
        removed.push(event)
      );

      runStore.publishReloadOutcome({ errors: [], ok: true });
      unsubscribeRemoved();
      runStore.publishReloadOutcome({ errors: [], ok: true });

      expect(kept).toHaveLength(2);
      expect(removed).toHaveLength(1);
    } finally {
      runStore.close();
    }
  });

  it("isolates a throwing listener so other subscribers and the write itself still succeed", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      const received: ChangeEvent[] = [];
      runStore.subscribeToChanges(() => {
        throw new Error("broken subscriber");
      });
      runStore.subscribeToChanges((event) => received.push(event));

      expect(() =>
        runStore.createRun({
          id: "run-a",
          issue: sampleIssue({ number: 1 }),
          projectName: "alpha",
          providerCommand: "x",
          providerName: "codex"
        })
      ).not.toThrow();

      expect(received).toHaveLength(1);
      expect(runStore.getRun("run-a")).toBeDefined();
    } finally {
      runStore.close();
    }
  });

  it("reports the live listener count via changeListenerCount", async () => {
    const runStore = openRunStore({ stateRoot: await makeTempRoot() });
    try {
      expect(runStore.changeListenerCount).toBe(0);
      const unsubscribe = runStore.subscribeToChanges(() => {});
      expect(runStore.changeListenerCount).toBe(1);
      unsubscribe();
      expect(runStore.changeListenerCount).toBe(0);
    } finally {
      runStore.close();
    }
  });
});
