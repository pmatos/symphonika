import {
  lutimes,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  reconcileWatchdog,
  sampleWorkspaceMtimeMax,
  watchdogProgressObserved
} from "../src/lifecycle/watchdog.js";
import { openRunStore, type RunStore, type WatchdogSample } from "../src/run-store.js";

const tempRoots: string[] = [];
const logger = pino({ enabled: false });

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-watchdog-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("watchdogProgressObserved", () => {
  const previous: WatchdogSample = {
    idleSince: null,
    lastToolCallAt: "2026-05-22T10:00:00.000Z",
    normalizedLogOffset: 10,
    outputTokensTotal: 5,
    runId: "run-a",
    sampledAt: "2026-05-22T10:00:00.000Z",
    turnIdSetSize: 2,
    workspaceMtimeMax: 1_000
  };

  it("treats each advancing signal as progress on its own", () => {
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        lastToolCallAt: "2026-05-22T10:01:00.000Z"
      })
    ).toBe(true);
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        workspaceMtimeMax: previous.workspaceMtimeMax + 1_000
      })
    ).toBe(true);
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        turnIdSetSize: previous.turnIdSetSize + 1
      })
    ).toBe(true);
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        outputTokensTotal: previous.outputTokensTotal + 1
      })
    ).toBe(true);
  });

  it("ignores sub-second workspace mtime drift and unchanged event counters", () => {
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        lastToolCallAt: previous.lastToolCallAt,
        outputTokensTotal: previous.outputTokensTotal,
        turnIdSetSize: previous.turnIdSetSize,
        workspaceMtimeMax: previous.workspaceMtimeMax + 999
      })
    ).toBe(false);
  });
});

describe("sampleWorkspaceMtimeMax", () => {
  it("does not descend into default excluded workspace directories", async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, ".git", "objects"), { recursive: true });
    await mkdir(path.join(root, "target", "debug"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    const included = path.join(root, "src.ts");
    const excluded = path.join(root, "target", "debug", "newer.txt");
    await writeFile(included, "included\n");
    await writeFile(excluded, "excluded\n");

    const includedTime = new Date("2026-05-22T10:00:00.000Z");
    const excludedTime = new Date("2026-05-22T11:00:00.000Z");
    await utimes(included, includedTime, includedTime);
    await utimes(excluded, excludedTime, excludedTime);
    await utimes(root, includedTime, includedTime);

    expect(await sampleWorkspaceMtimeMax(root)).toBe(includedTime.getTime());
  });

  it("does not follow symlinked directories out of the workspace", async () => {
    const root = await makeTempRoot();
    const external = await makeTempRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    const included = path.join(workspace, "src.ts");
    await writeFile(included, "included\n");
    const externalFile = path.join(external, "newer.txt");
    await writeFile(externalFile, "external\n");

    const baseTime = new Date("2026-05-22T10:00:00.000Z");
    const externalTime = new Date("2026-05-22T11:00:00.000Z");
    await utimes(included, baseTime, baseTime);
    await utimes(externalFile, externalTime, externalTime);

    // A symlink named like an excluded dir and a plain symlink both point at an
    // external tree whose file is newer. Neither may be descended into, and the
    // external file's 11:00 mtime must not win — only the links' own (10:00)
    // mtimes count.
    const linkedExcluded = path.join(workspace, "node_modules");
    await symlink(external, linkedExcluded, "dir");
    const linkedPlain = path.join(workspace, "linked");
    await symlink(external, linkedPlain, "dir");
    await lutimes(linkedExcluded, baseTime, baseTime);
    await lutimes(linkedPlain, baseTime, baseTime);
    await utimes(workspace, baseTime, baseTime);

    expect(await sampleWorkspaceMtimeMax(workspace)).toBe(baseTime.getTime());
  });
});

describe("reconcileWatchdog", () => {
  it("does nothing when disabled", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-disabled");
      await reconcileWatchdog({
        activeRuns: new ActiveRunRegistry(),
        config: {
          enabled: false,
          graceMinutes: 30,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      expect(store.getWatchdogSample("run-disabled")).toBeUndefined();
      expect(store.getRun("run-disabled")?.state).toBe("queued");
    } finally {
      store.close();
    }
  });

  it("does not sample waiting rows", async () => {
    const root = await makeTempRoot();
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-waiting");
      store.updateRunState("run-waiting", "waiting");
      store.setRunCurrentState("run-waiting", "pr_review");

      await reconcileWatchdog({
        activeRuns: new ActiveRunRegistry(),
        config: {
          enabled: true,
          graceMinutes: 30,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      expect(store.getWatchdogSample("run-waiting")).toBeUndefined();
      expect(store.getRun("run-waiting")?.state).toBe("waiting");
    } finally {
      store.close();
    }
  });

  it("marks a still-idle active run stale with no_progress and cancels it", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-idle");
      store.updateRunEvidence("run-idle", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(root, ".symphonika", "logs", "runs", "run-idle", "issue.json"),
        metadataPath: path.join(root, ".symphonika", "logs", "runs", "run-idle", "metadata.json"),
        normalizedLogPath: path.join(root, "provider.normalized.jsonl"),
        promptPath: path.join(root, ".symphonika", "logs", "runs", "run-idle", "prompt.md"),
        rawLogPath: path.join(root, ".symphonika", "logs", "runs", "run-idle", "raw.jsonl"),
        workflowGraphPath: path.join(root, ".symphonika", "logs", "runs", "run-idle", "workflow.json"),
        workspacePath
      });
      store.updateRunState("run-idle", "running");
      const workspaceMtimeMax = await sampleWorkspaceMtimeMax(workspacePath);
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:30:00.000Z",
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        outputTokensTotal: 0,
        runId: "run-idle",
        sampledAt: "2026-05-22T09:30:00.000Z",
        turnIdSetSize: 0,
        workspaceMtimeMax
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-idle"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      expect(store.getRun("run-idle")).toMatchObject({
        failureClassification: "deterministic",
        state: "stale",
        terminalReason: "no_progress"
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(activeRuns.get("run-idle")?.cancelReason).toBe("no_progress");
    } finally {
      store.close();
    }
  });

  it("starts normalized-log sampling at the stored offset", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const normalizedLogPath = path.join(root, "provider.normalized.jsonl");
    const oldToolCall = JSON.stringify({ toolName: "bash", type: "tool_call" }) + "\n";
    const newRateLimit = JSON.stringify({ rateLimits: {}, type: "rate_limit_updated" }) + "\n";
    await writeFile(normalizedLogPath, oldToolCall + newRateLimit);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-forward");
      store.updateRunEvidence("run-forward", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(root, ".symphonika", "logs", "runs", "run-forward", "issue.json"),
        metadataPath: path.join(root, ".symphonika", "logs", "runs", "run-forward", "metadata.json"),
        normalizedLogPath,
        promptPath: path.join(root, ".symphonika", "logs", "runs", "run-forward", "prompt.md"),
        rawLogPath: path.join(root, ".symphonika", "logs", "runs", "run-forward", "raw.jsonl"),
        workflowGraphPath: path.join(root, ".symphonika", "logs", "runs", "run-forward", "workflow.json"),
        workspacePath
      });
      store.updateRunState("run-forward", "running");
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:30:00.000Z",
        lastToolCallAt: "2026-05-22T09:00:00.000Z",
        normalizedLogOffset: Buffer.byteLength(oldToolCall),
        outputTokensTotal: 0,
        runId: "run-forward",
        sampledAt: "2026-05-22T09:30:00.000Z",
        turnIdSetSize: 0,
        workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-forward"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      expect(store.getRun("run-forward")).toMatchObject({
        state: "stale",
        terminalReason: "no_progress"
      });
      expect(store.getWatchdogSample("run-forward")?.normalizedLogOffset).toBe(
        Buffer.byteLength(oldToolCall + newRateLimit)
      );
    } finally {
      store.close();
    }
  });

  it("continues the idle grace window from a persisted sample after store reopen", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const stateRoot = path.join(root, ".symphonika");
    const first = openRunStore({ stateRoot });
    try {
      seedRun(first, "run-restarted");
      first.updateRunEvidence("run-restarted", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(root, ".symphonika", "logs", "runs", "run-restarted", "issue.json"),
        metadataPath: path.join(root, ".symphonika", "logs", "runs", "run-restarted", "metadata.json"),
        normalizedLogPath: path.join(root, "provider.normalized.jsonl"),
        promptPath: path.join(root, ".symphonika", "logs", "runs", "run-restarted", "prompt.md"),
        rawLogPath: path.join(root, ".symphonika", "logs", "runs", "run-restarted", "raw.jsonl"),
        workflowGraphPath: path.join(root, ".symphonika", "logs", "runs", "run-restarted", "workflow.json"),
        workspacePath
      });
      first.updateRunState("run-restarted", "running");
      first.upsertWatchdogSample({
        idleSince: "2026-05-22T09:40:00.000Z",
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        outputTokensTotal: 0,
        runId: "run-restarted",
        sampledAt: "2026-05-22T09:40:00.000Z",
        turnIdSetSize: 0,
        workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
      });
    } finally {
      first.close();
    }

    const reopened = openRunStore({ stateRoot });
    try {
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-restarted"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:10:00.000Z"),
        runStore: reopened
      });

      expect(reopened.getRun("run-restarted")).toMatchObject({
        state: "stale",
        terminalReason: "no_progress"
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      reopened.close();
    }
  });
});

function seedRun(store: RunStore, id: string): void {
  store.createRun({
    id,
    issue: {
      body: "",
      created_at: "2026-05-22T09:00:00.000Z",
      id: 198,
      labels: ["agent-ready"],
      number: 198,
      priority: 1,
      state: "open",
      title: "watchdog",
      updated_at: "2026-05-22T09:00:00.000Z",
      url: "https://example.test/198"
    },
    projectName: "symphonika",
    providerCommand: "codex fake",
    providerName: "codex"
  });
}
