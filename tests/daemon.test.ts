import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLogLevel, startDaemon } from "../src/daemon.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-daemon-test-"));
  tempRoots.push(root);
  return root;
}

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

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
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
      const endpoint = JSON.parse(
        await readFile(endpointPath, "utf8")
      ) as unknown;

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

  it("preserves a blocked run's terminal verdict when cancel is attempted (issue #271)", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    const seedStore = openRunStore({ stateRoot });
    seedStore.createRun({
      id: "run-blocked",
      issue: sampleIssue({ number: 9 }),
      projectName: "alpha",
      providerCommand: "x",
      providerName: "codex"
    });
    seedStore.recordTerminalReason(
      "run-blocked",
      "no_workspace_changes",
      "deterministic"
    );
    seedStore.updateRunState("run-blocked", "blocked");
    seedStore.close();

    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      // Regression: src/daemon.ts wires createHttpApp with its own
      // cancelViaUi closure (a THIRD independent copy of the terminal-states
      // allowlist, distinct from pages.ts and http/app.ts's fallback). It
      // must also treat "blocked" as terminal, or cancelling a blocked run
      // wrongly proceeds and overwrites the verdict with "cancelled".
      const response = await fetch(
        `${daemon.url}/api/runs/run-blocked/cancel`,
        { method: "POST" }
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        kind: "already-terminal",
        state: "blocked"
      });

      const verifyStore = openRunStore({ stateRoot });
      expect(verifyStore.getRun("run-blocked")?.state).toBe("blocked");
      verifyStore.close();
    } finally {
      await daemon.stop();
    }
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
      { id: "leaked-preparing", issueNumber: 202, state: "preparing_workspace" }
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
      expect(summary?.byState).toEqual({ preparing_workspace: 1, running: 1 });
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
      { id: "leaked-preparing", issueNumber: 202, state: "preparing_workspace" }
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
        (line) =>
          line.msg === "symphonika startup: marked orphaned run as stale"
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
      expect(byRunId.get("leaked-preparing")).toMatchObject({
        previousState: "preparing_workspace",
        issueNumber: 202
      });
    } finally {
      await daemon.stop();
    }
  });

  // Regression: provider processes now run in symphonika-providers.slice, a
  // SIBLING of the daemon's own service cgroup (see docs/adr/0064) -- a
  // daemon crash/restart no longer tears down in-flight provider scopes with
  // it the way it did before that split. The startup orphan sweep must also
  // reap any lingering scope for a run that was actually running (i.e. had a
  // provider spawned) when the previous daemon instance died.
  it("stops the leftover provider scope for a running orphan, using its latest attempt", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "orphan-run",
      issue: sampleIssue({ number: 55 }),
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    store.createAttempt({
      attemptNumber: 1,
      branchName: "sym/symphonika/55-fixture",
      branchRef: "refs/heads/sym/symphonika/55-fixture",
      id: "orphan-run-attempt-1",
      issueSnapshotPath: "/tmp/snap.json",
      metadataPath: "/tmp/meta.json",
      normalizedLogPath: "/tmp/normalized.jsonl",
      promptPath: "/tmp/prompt.md",
      providerCommand: "codex fake",
      providerName: "codex",
      rawLogPath: "/tmp/raw.jsonl",
      runId: "orphan-run",
      state: "running",
      workflowGraphPath: "",
      workspacePath: stateRoot
    });
    // A retried attempt: the sweep must reap attempt 2 (the latest), not 1.
    store.createAttempt({
      attemptNumber: 2,
      branchName: "sym/symphonika/55-fixture",
      branchRef: "refs/heads/sym/symphonika/55-fixture",
      id: "orphan-run-attempt-2",
      issueSnapshotPath: "/tmp/snap.json",
      metadataPath: "/tmp/meta.json",
      normalizedLogPath: "/tmp/normalized.jsonl",
      promptPath: "/tmp/prompt.md",
      providerCommand: "codex fake",
      providerName: "codex",
      rawLogPath: "/tmp/raw.jsonl",
      runId: "orphan-run",
      state: "running",
      workflowGraphPath: "",
      workspacePath: stateRoot
    });
    store.updateRunState("orphan-run", "running");
    store.close();

    const stopCalls: Array<{ attempt: number; id: string }> = [];
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger: pino({ enabled: false }),
      port: 0,
      processScope: {
        stopProviderScope: (run) => {
          stopCalls.push(run);
          return Promise.resolve(true);
        },
        wrapForProviderScope: (_run, command) => Promise.resolve(command)
      }
    });

    try {
      expect(stopCalls).toEqual([{ attempt: 2, id: "orphan-run" }]);
    } finally {
      await daemon.stop();
    }
  });

  it("does not attempt to stop a scope for an orphan that never got a provider spawned", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    seedOrphans(stateRoot, [
      { id: "leaked-queued", issueNumber: 60, state: "queued" },
      { id: "leaked-preparing", issueNumber: 61, state: "preparing_workspace" }
    ]);

    const stopCalls: Array<{ attempt: number; id: string }> = [];
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger: pino({ enabled: false }),
      port: 0,
      processScope: {
        stopProviderScope: (run) => {
          stopCalls.push(run);
          return Promise.resolve(true);
        },
        wrapForProviderScope: (_run, command) => Promise.resolve(command)
      }
    });

    try {
      expect(stopCalls).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  // Routine Firings are a separate subsystem from regular dispatch Runs
  // (src/routines/dispatcher.ts), but share the same architectural gap: a
  // crashed daemon leaves its provider's scope alive in the sibling
  // symphonika-providers.slice. Routine firings never retry, so their
  // provider is always spawned as attempt 1 (see dispatcher.ts) -- no
  // listAttempts lookup is needed, unlike the regular-run sweep.
  it("stops the leftover provider scope for a leaked running routine firing", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    const store = openRunStore({ stateRoot });
    store.syncRoutines([
      {
        kind: "report",
        name: "nightly-report",
        prompt: "Write a nightly report.",
        provider: "codex",
        schedule: { cron: "0 0 * * *", tz: "UTC" },
        sourcePath: "/tmp/nightly-report.md",
        projectName: "symphonika"
      }
    ]);
    store.createRoutineFiring({
      id: "leaked-firing",
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "nightly-report"
    });
    store.updateRoutineFiringState("leaked-firing", "running");
    store.close();

    const stopCalls: Array<{ attempt: number; id: string }> = [];
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger: pino({ enabled: false }),
      port: 0,
      processScope: {
        stopProviderScope: (run) => {
          stopCalls.push(run);
          return Promise.resolve(true);
        },
        wrapForProviderScope: (_run, command) => Promise.resolve(command)
      }
    });

    try {
      expect(stopCalls).toEqual([{ attempt: 1, id: "leaked-firing" }]);
    } finally {
      await daemon.stop();
    }
  });

  it("does not attempt to stop a scope for a queued routine firing that never got a provider spawned", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    const store = openRunStore({ stateRoot });
    store.syncRoutines([
      {
        kind: "report",
        name: "nightly-report",
        prompt: "Write a nightly report.",
        provider: "codex",
        schedule: { cron: "0 0 * * *", tz: "UTC" },
        sourcePath: "/tmp/nightly-report.md",
        projectName: "symphonika"
      }
    ]);
    store.createRoutineFiring({
      id: "queued-firing",
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "nightly-report"
    });
    store.close();

    const stopCalls: Array<{ attempt: number; id: string }> = [];
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger: pino({ enabled: false }),
      port: 0,
      processScope: {
        stopProviderScope: (run) => {
          stopCalls.push(run);
          return Promise.resolve(true);
        },
        wrapForProviderScope: (_run, command) => Promise.resolve(command)
      }
    });

    try {
      expect(stopCalls).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  // Regression: previously the sweep terminalized every orphan to 'stale'
  // BEFORE attempting scope cleanup, so a transient cleanup failure (manager
  // unreachable, systemctl stop timed out) had no way to be retried on a
  // future restart -- see docs/adr/0064. A row whose cleanup could not be
  // confirmed must get a distinct terminal_reason and stay discoverable
  // through the store's own detection query.
  it("leaves an orphaned run's scope cleanup pending for retry when it cannot be confirmed", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "unconfirmed-run",
      issue: sampleIssue({ number: 70 }),
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    store.createAttempt({
      attemptNumber: 1,
      branchName: "sym/symphonika/70-fixture",
      branchRef: "refs/heads/sym/symphonika/70-fixture",
      id: "unconfirmed-run-attempt-1",
      issueSnapshotPath: "/tmp/snap.json",
      metadataPath: "/tmp/meta.json",
      normalizedLogPath: "/tmp/normalized.jsonl",
      promptPath: "/tmp/prompt.md",
      providerCommand: "codex fake",
      providerName: "codex",
      rawLogPath: "/tmp/raw.jsonl",
      runId: "unconfirmed-run",
      state: "running",
      workflowGraphPath: "",
      workspacePath: stateRoot
    });
    store.updateRunState("unconfirmed-run", "running");
    store.close();

    const { logger, lines } = createCapturingLogger();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger,
      port: 0,
      processScope: {
        stopProviderScope: () => Promise.resolve(false),
        wrapForProviderScope: (_run, command) => Promise.resolve(command)
      }
    });
    let stopped = false;
    try {
      const pendingLines = lines.filter(
        (line) =>
          line.msg ===
          "symphonika startup: orphaned run scope cleanup could not be confirmed"
      );
      expect(pendingLines).toHaveLength(1);
      expect(pendingLines[0]).toMatchObject({
        level: pino.levels.values.warn,
        runId: "unconfirmed-run",
        terminalReason: "leaked_active_run_cleanup_pending"
      });

      await daemon.stop();
      stopped = true;

      const verifyStore = openRunStore({ stateRoot });
      try {
        expect(verifyStore.getRun("unconfirmed-run")).toMatchObject({
          state: "stale",
          terminalReason: "leaked_active_run_cleanup_pending"
        });
        expect(
          verifyStore.findLeakedRuns().map((entry) => entry.runId)
        ).toEqual(["unconfirmed-run"]);
      } finally {
        verifyStore.close();
      }
    } finally {
      if (!stopped) {
        await daemon.stop();
      }
    }
  });

  it("leaves a leaked routine firing's scope cleanup pending for retry when it cannot be confirmed", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    const store = openRunStore({ stateRoot });
    store.syncRoutines([
      {
        kind: "report",
        name: "nightly-report",
        prompt: "Write a nightly report.",
        provider: "codex",
        schedule: { cron: "0 0 * * *", tz: "UTC" },
        sourcePath: "/tmp/nightly-report.md",
        projectName: "symphonika"
      }
    ]);
    store.createRoutineFiring({
      id: "unconfirmed-firing",
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "nightly-report"
    });
    store.updateRoutineFiringState("unconfirmed-firing", "running");
    store.close();

    const { logger, lines } = createCapturingLogger();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger,
      port: 0,
      processScope: {
        stopProviderScope: () => Promise.resolve(false),
        wrapForProviderScope: (_run, command) => Promise.resolve(command)
      }
    });
    let stopped = false;
    try {
      const pendingLines = lines.filter(
        (line) =>
          line.msg ===
          "symphonika startup: orphaned routine firing scope cleanup could not be confirmed"
      );
      expect(pendingLines).toHaveLength(1);
      expect(pendingLines[0]).toMatchObject({
        level: pino.levels.values.warn,
        firingId: "unconfirmed-firing",
        terminalReason: "leaked_routine_firing_cleanup_pending"
      });

      await daemon.stop();
      stopped = true;

      const verifyStore = openRunStore({ stateRoot });
      try {
        expect(verifyStore.listRoutineFirings()).toEqual([
          expect.objectContaining({
            id: "unconfirmed-firing",
            state: "failed",
            terminalReason: "leaked_routine_firing_cleanup_pending"
          })
        ]);
        expect(
          verifyStore.findLeakedRoutineFirings().map((entry) => entry.firingId)
        ).toEqual(["unconfirmed-firing"]);
      } finally {
        verifyStore.close();
      }
    } finally {
      if (!stopped) {
        await daemon.stop();
      }
    }
  });

  // The sweep must not serialize scope-stop calls behind one another --
  // otherwise N leaked runs each risking up to stopTimeoutMs delays the HTTP
  // server (serve()) from starting, reintroducing the dashboard-unavailable
  // symptom this whole change exists to fix (docs/adr/0064).
  it("stops leaked runs' provider scopes in parallel rather than serially", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    const store = openRunStore({ stateRoot });
    for (const n of [1, 2, 3]) {
      const runId = `concurrent-run-${n}`;
      store.createRun({
        id: runId,
        issue: sampleIssue({ number: 80 + n }),
        projectName: "symphonika",
        providerCommand: "codex fake",
        providerName: "codex"
      });
      store.createAttempt({
        attemptNumber: 1,
        branchName: `sym/symphonika/${80 + n}-fixture`,
        branchRef: `refs/heads/sym/symphonika/${80 + n}-fixture`,
        id: `${runId}-attempt-1`,
        issueSnapshotPath: "/tmp/snap.json",
        metadataPath: "/tmp/meta.json",
        normalizedLogPath: "/tmp/normalized.jsonl",
        promptPath: "/tmp/prompt.md",
        providerCommand: "codex fake",
        providerName: "codex",
        rawLogPath: "/tmp/raw.jsonl",
        runId,
        state: "running",
        workflowGraphPath: "",
        workspacePath: stateRoot
      });
      store.updateRunState(runId, "running");
    }
    store.close();

    let active = 0;
    let maxActive = 0;
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger: pino({ enabled: false }),
      port: 0,
      processScope: {
        stopProviderScope: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return true;
        },
        wrapForProviderScope: (_run, command) => Promise.resolve(command)
      }
    });

    try {
      expect(maxActive).toBeGreaterThan(1);
    } finally {
      await daemon.stop();
    }
  });

  // ADR 0047 guarantees valid waiting rows (current_state_id set) survive
  // daemon restart so the next tick can re-evaluate them; the startup sweep
  // must leave them alone.
  it("preserves valid waiting rows across daemon startup", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    seedOrphans(stateRoot, [
      {
        id: "wait-survivor",
        issueNumber: 303,
        state: "waiting",
        currentStateId: "pr_review"
      }
    ]);

    const { logger, lines } = createCapturingLogger();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger,
      port: 0
    });
    let stopped = false;
    try {
      const orphanLines = lines.filter(
        (line) =>
          line.msg === "symphonika startup: marked orphaned run as stale"
      );
      expect(orphanLines).toHaveLength(0);

      const cleanLines = lines.filter(
        (line) => line.msg === "symphonika startup: no orphaned runs found"
      );
      expect(cleanLines).toHaveLength(1);

      await daemon.stop();
      stopped = true;

      const survivorStore = openRunStore({ stateRoot });
      try {
        expect(survivorStore.getRun("wait-survivor")?.state).toBe("waiting");
      } finally {
        survivorStore.close();
      }
    } finally {
      if (!stopped) {
        await daemon.stop();
      }
    }
  });

  // A pre-fix crash inside the old non-atomic createWaitingRun could leave a
  // row at state='waiting' with current_state_id=NULL. listWaitingRuns hides
  // those rows, so reconcileWaitingRuns can never see them — they need a
  // surgical sweep on startup.
  it("sweeps waiting rows with NULL current_state_id (pre-atomicity orphans)", async () => {
    const cwd = await makeTempRoot();
    const stateRoot = path.join(cwd, ".symphonika");
    await mkdir(stateRoot, { recursive: true });
    seedOrphans(stateRoot, [
      // valid durable wait — must survive
      {
        id: "wait-valid",
        issueNumber: 401,
        state: "waiting",
        currentStateId: "pr_review"
      },
      // pre-atomicity crash artifact — must be swept
      { id: "wait-orphan", issueNumber: 402, state: "waiting" }
    ]);

    const { logger, lines } = createCapturingLogger();
    const daemon = await startDaemon({
      configPath: "symphonika.yml",
      cwd,
      logger,
      port: 0
    });
    let stopped = false;
    try {
      const orphanLines = lines.filter(
        (line) =>
          line.msg === "symphonika startup: marked orphaned run as stale"
      );
      expect(orphanLines).toHaveLength(1);
      expect(orphanLines[0]).toMatchObject({
        runId: "wait-orphan",
        previousState: "waiting",
        issueNumber: 402,
        terminalReason: "leaked_active_run"
      });

      await daemon.stop();
      stopped = true;

      const verifyStore = openRunStore({ stateRoot });
      try {
        expect(verifyStore.getRun("wait-valid")?.state).toBe("waiting");
        expect(verifyStore.getRun("wait-orphan")?.state).toBe("stale");
        expect(verifyStore.getRun("wait-orphan")?.terminalReason).toBe(
          "leaked_active_run"
        );
      } finally {
        verifyStore.close();
      }
    } finally {
      if (!stopped) {
        await daemon.stop();
      }
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
      resolveLogLevel({ PINO_LOG_LEVEL: "trace", LOG_LEVEL: "warn" })
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
  currentStateId?: string;
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
      if (seed.currentStateId !== undefined) {
        store.setRunCurrentState(seed.id, seed.currentStateId);
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
