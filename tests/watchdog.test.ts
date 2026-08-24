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

const normalizedLogRemoval = vi.hoisted(() => ({
  filePath: null as string | null
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (filePath: string) => {
      const result = await actual.stat(filePath);
      if (filePath === normalizedLogRemoval.filePath) {
        normalizedLogRemoval.filePath = null;
        await actual.unlink(filePath);
      }
      return result;
    }
  };
});

import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  reconcileWatchdog,
  sampleWorkspace,
  sampleWorkspaceMtimeMax,
  watchdogProgressObserved
} from "../src/lifecycle/watchdog.js";
import {
  openRunStore,
  type RunStore,
  type WatchdogSample
} from "../src/run-store.js";

const tempRoots: string[] = [];
const logger = pino({ enabled: false });

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-watchdog-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  normalizedLogRemoval.filePath = null;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("watchdogProgressObserved", () => {
  const previous: WatchdogSample = {
    idleSince: null,
    lastMessageAt: null,
    lastToolCallAt: "2026-05-22T10:00:00.000Z",
    normalizedLogOffset: 10,
    normalizedLogPath: "run-a.normalized.jsonl",
    outputTokensTotal: 5,
    runId: "run-a",
    sampledAt: "2026-05-22T10:00:00.000Z",
    turnIdSetSize: 2,
    workspaceDigest: "digest-a",
    workspaceMtimeMax: 1_000
  };

  it("treats each advancing signal as progress on its own", () => {
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        lastMessageAt: null,
        lastToolCallAt: "2026-05-22T10:01:00.000Z"
      })
    ).toBe(true);
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        workspaceDigest: "digest-b"
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
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        lastMessageAt: "2026-05-22T10:01:00.000Z"
      })
    ).toBe(true);
  });

  it("ignores a restamped workspace and unchanged event counters", () => {
    // ADR 0086: mtime alone is not progress. A rebuild that restamps identical
    // output leaves the workspace digest unchanged and must not clear the idle
    // clock.
    expect(
      watchdogProgressObserved(previous, {
        ...previous,
        lastMessageAt: null,
        lastToolCallAt: previous.lastToolCallAt,
        outputTokensTotal: previous.outputTokensTotal,
        turnIdSetSize: previous.turnIdSetSize,
        workspaceDigest: previous.workspaceDigest,
        workspaceMtimeMax: previous.workspaceMtimeMax + 3_600_000
      })
    ).toBe(false);
  });

  it("treats an empty previous digest as a pre-upgrade row, not a change", () => {
    expect(
      watchdogProgressObserved(
        { ...previous, workspaceDigest: "" },
        {
          ...previous,
          lastMessageAt: null,
          lastToolCallAt: previous.lastToolCallAt,
          workspaceDigest: "digest-a"
        }
      )
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

    expect(await sampleWorkspaceMtimeMax(root, [], ["vendor/"])).toBe(
      includedTime.getTime()
    );
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

  it("drops files matching an mtime_ignore glob", async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "src.ts"), "included\n");
    await writeFile(path.join(root, "build.log"), "log\n");
    await writeFile(path.join(root, "dist", "out.log"), "log\n");

    const baseTime = new Date("2026-05-22T10:00:00.000Z");
    const newerTime = new Date("2026-05-22T12:00:00.000Z");
    await utimes(path.join(root, "src.ts"), baseTime, baseTime);
    await utimes(path.join(root, "build.log"), newerTime, newerTime);
    await utimes(path.join(root, "dist", "out.log"), newerTime, newerTime);
    await utimes(path.join(root, "dist"), baseTime, baseTime);
    await utimes(root, baseTime, baseTime);

    // Without the ignore set, a newer .log file wins.
    expect(await sampleWorkspaceMtimeMax(root)).toBe(newerTime.getTime());
    // The glob drops .log files at any depth, so src.ts's 10:00 wins.
    expect(await sampleWorkspaceMtimeMax(root, ["**/*.log"])).toBe(
      baseTime.getTime()
    );
  });

  it("does not descend into directories declared by evidence.ignore", async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, "vendor", "generated"), { recursive: true });
    const included = path.join(root, "src.ts");
    const ignoredDirectory = path.join(root, "vendor");
    const ignored = path.join(ignoredDirectory, "generated", "newer.ts");
    await writeFile(included, "included\n");
    await writeFile(ignored, "ignored\n");

    const baseTime = new Date("2026-05-22T10:00:00.000Z");
    const newerTime = new Date("2026-05-22T12:00:00.000Z");
    await utimes(included, baseTime, baseTime);
    await utimes(ignored, newerTime, newerTime);
    await utimes(ignoredDirectory, newerTime, newerTime);
    await utimes(root, baseTime, baseTime);

    expect(await sampleWorkspaceMtimeMax(root, [], ["vendor/"])).toBe(
      baseTime.getTime()
    );
  });
});

describe("sampleWorkspace", () => {
  it("excludes common build-output directories from the digest", async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, "src.ts"), "included\n");
    const before = await sampleWorkspace(root);

    // vow#1055's workspace wrote generated binaries into build/ and vow/build/
    // with an empty evidence.ignore, which is what kept the workspace signal
    // alive across a fourteen-hour crash loop.
    for (const directory of ["build", "dist", "out", ".venv", "__pycache__"]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "artifact.bin"), "output\n");
    }

    expect((await sampleWorkspace(root)).digest).toBe(before.digest);
  });

  it("keeps the digest stable when output is restamped but not rewritten", async () => {
    const root = await makeTempRoot();
    const artifact = path.join(root, "artifact.bin");
    await writeFile(artifact, "same bytes\n");
    const before = await sampleWorkspace(root);

    const later = new Date("2036-05-22T12:00:00.000Z");
    await utimes(artifact, later, later);
    const after = await sampleWorkspace(root);

    expect(after.digest).toBe(before.digest);
    expect(after.mtimeMax).toBe(later.getTime());
  });

  it("changes the digest when a file is added, resized, or removed", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "src.ts");
    await writeFile(source, "included\n");
    const before = await sampleWorkspace(root);

    await writeFile(source, "included\nand extended\n");
    const resized = await sampleWorkspace(root);
    expect(resized.digest).not.toBe(before.digest);

    await writeFile(path.join(root, "added.ts"), "added\n");
    const added = await sampleWorkspace(root);
    expect(added.digest).not.toBe(resized.digest);

    await rm(path.join(root, "added.ts"));
    expect((await sampleWorkspace(root)).digest).toBe(resized.digest);
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
          mtimeIgnore: [],
          graceMinutes: 30,
          outputTokenBudget: 0,
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
          mtimeIgnore: [],
          graceMinutes: 30,
          outputTokenBudget: 0,
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

  it("continues sampling when a normalized log disappears after stat", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const removedLogPath = path.join(root, "a.normalized.jsonl");
    const laterLogPath = path.join(root, "b.normalized.jsonl");
    await writeFile(
      removedLogPath,
      JSON.stringify({ type: "rate_limit_updated" }) + "\n"
    );
    await writeFile(laterLogPath, "");

    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-a-removed-log");
      seedRun(store, "run-b-later");
      for (const [runId, normalizedLogPath] of [
        ["run-a-removed-log", removedLogPath],
        ["run-b-later", laterLogPath]
      ] as const) {
        store.updateRunEvidence(runId, {
          branchName: `sym/symphonika/${runId}`,
          branchRef: `refs/heads/sym/symphonika/${runId}`,
          issueSnapshotPath: path.join(root, `${runId}-issue.json`),
          metadataPath: path.join(root, `${runId}-metadata.json`),
          normalizedLogPath,
          promptPath: path.join(root, `${runId}-prompt.md`),
          rawLogPath: path.join(root, `${runId}-raw.jsonl`),
          workflowGraphPath: path.join(root, `${runId}-workflow.json`),
          workspacePath
        });
        store.updateRunState(runId, "running");
      }
      const priorOffset = 1;
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:59:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: priorOffset,
        normalizedLogPath: removedLogPath,
        outputTokensTotal: 0,
        runId: "run-a-removed-log",
        sampledAt: "2026-05-22T09:59:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
      });
      normalizedLogRemoval.filePath = removedLogPath;

      await expect(
        reconcileWatchdog({
          activeRuns: new ActiveRunRegistry(),
          config: {
            enabled: true,
            graceMinutes: 30,
            mtimeIgnore: [],
            outputTokenBudget: 0,
            sampleIntervalSeconds: 60
          },
          logger,
          now: () => new Date("2026-05-22T10:00:00.000Z"),
          runStore: store
        })
      ).resolves.toEqual({ sampled: 2, terminated: 0 });

      expect(
        store.getWatchdogSample("run-a-removed-log")?.normalizedLogOffset
      ).toBe(priorOffset);
      expect(store.getWatchdogSample("run-b-later")).toBeDefined();
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
        issueSnapshotPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-idle",
          "issue.json"
        ),
        metadataPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-idle",
          "metadata.json"
        ),
        normalizedLogPath: path.join(root, "provider.normalized.jsonl"),
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-idle",
          "prompt.md"
        ),
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-idle",
          "raw.jsonl"
        ),
        workflowGraphPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-idle",
          "workflow.json"
        ),
        workspacePath
      });
      store.updateRunState("run-idle", "running");
      const workspaceMtimeMax = await sampleWorkspaceMtimeMax(workspacePath);
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:30:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: path.join(root, "provider.normalized.jsonl"),
        outputTokensTotal: 0,
        runId: "run-idle",
        sampledAt: "2026-05-22T09:30:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const onTerminated = vi.fn();
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
          mtimeIgnore: [],
          graceMinutes: 30,
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        onTerminated,
        runStore: store
      });

      expect(store.getRun("run-idle")).toMatchObject({
        failureClassification: "deterministic",
        state: "stale",
        terminalReason: "no_progress"
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(activeRuns.get("run-idle")?.cancelReason).toBe("no_progress");
      expect(onTerminated).toHaveBeenCalledWith({
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-idle"
      });
    } finally {
      store.close();
    }
  });

  it("starts independent stale-run cancellations without serializing their grace periods", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      await prepareIdleRun(store, root, workspacePath, "run-idle-a", 198);
      await prepareIdleRun(store, root, workspacePath, "run-idle-b", 199);
      let resolveA: (() => void) | undefined;
      let resolveB: (() => void) | undefined;
      const pendingA = new Promise<void>((resolve) => {
        resolveA = resolve;
      });
      const pendingB = new Promise<void>((resolve) => {
        resolveB = resolve;
      });
      const cancelA = vi.fn(() => pendingA);
      const cancelB = vi.fn(() => pendingB);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: cancelA,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-idle-a"
      });
      activeRuns.register({
        cancel: cancelB,
        issueNumber: 199,
        projectName: "symphonika",
        runId: "run-idle-b"
      });

      const reconciling = reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          mtimeIgnore: [],
          graceMinutes: 30,
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      try {
        await vi.waitFor(() => {
          expect(cancelA).toHaveBeenCalledOnce();
          expect(cancelB).toHaveBeenCalledOnce();
        });
      } finally {
        resolveA?.();
        resolveB?.();
        await reconciling;
      }
      await expect(reconciling).resolves.toEqual({
        sampled: 2,
        terminated: 2
      });
    } finally {
      store.close();
    }
  });

  it("uses the Project grace override when deciding whether an idle run is stale", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const normalizedLogPath = path.join(root, "provider.normalized.jsonl");
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-vow", "vow");
      store.updateRunEvidence("run-vow", {
        branchName: "sym/vow/200-watchdog",
        branchRef: "refs/heads/sym/vow/200-watchdog",
        issueSnapshotPath: path.join(root, "issue.json"),
        metadataPath: path.join(root, "metadata.json"),
        normalizedLogPath,
        promptPath: path.join(root, "prompt.md"),
        rawLogPath: path.join(root, "raw.jsonl"),
        workflowGraphPath: path.join(root, "workflow.json"),
        workspacePath
      });
      store.updateRunState("run-vow", "running");
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:00:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath,
        outputTokensTotal: 0,
        runId: "run-vow",
        sampledAt: "2026-05-22T09:00:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "vow",
        runId: "run-vow"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        projects: [{ name: "vow", watchdog: { graceMinutes: 180 } }],
        runStore: store
      });

      expect(store.getRun("run-vow")?.state).toBe("running");
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("prefers the current Project evidence ignore over the persisted Run value", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    const vendorPath = path.join(workspacePath, "vendor");
    await mkdir(vendorPath, { recursive: true });
    const generated = path.join(vendorPath, "generated.txt");
    await writeFile(generated, "generated\n");
    const rootTime = new Date("2026-05-22T09:00:00.000Z");
    const generatedTime = new Date("2026-05-22T09:50:00.000Z");
    await utimes(workspacePath, rootTime, rootTime);
    await utimes(generated, generatedTime, generatedTime);
    await utimes(vendorPath, generatedTime, generatedTime);
    const normalizedLogPath = path.join(root, "provider.normalized.jsonl");
    await writeFile(normalizedLogPath, "");

    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-current-policy", "symphonika", 198, ["vendor/"]);
      store.updateRunEvidence("run-current-policy", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(root, "issue.json"),
        metadataPath: path.join(root, "metadata.json"),
        normalizedLogPath,
        promptPath: path.join(root, "prompt.md"),
        rawLogPath: path.join(root, "raw.jsonl"),
        workflowGraphPath: path.join(root, "workflow.json"),
        workspacePath
      });
      store.updateRunState("run-current-policy", "running");
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:00:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath,
        outputTokensTotal: 0,
        runId: "run-current-policy",
        sampledAt: "2026-05-22T09:00:00.000Z",
        turnIdSetSize: 0,
        // A prior observation, so the fresh walk's digest is compared against
        // it rather than treated as a pre-upgrade row.
        workspaceDigest: "seed-digest",
        workspaceMtimeMax: rootTime.getTime()
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-current-policy"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        evidenceIgnoreForProject: () => [],
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      expect(store.getRun("run-current-policy")?.state).toBe("running");
      expect(
        store.getWatchdogSample("run-current-policy")?.idleSince
      ).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("starts normalized-log sampling at the stored offset", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const normalizedLogPath = path.join(root, "provider.normalized.jsonl");
    const oldToolCall =
      JSON.stringify({ toolName: "bash", type: "tool_call" }) + "\n";
    const newRateLimit =
      JSON.stringify({ rateLimits: {}, type: "rate_limit_updated" }) + "\n";
    await writeFile(normalizedLogPath, oldToolCall + newRateLimit);
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-forward");
      store.updateRunEvidence("run-forward", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-forward",
          "issue.json"
        ),
        metadataPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-forward",
          "metadata.json"
        ),
        normalizedLogPath,
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-forward",
          "prompt.md"
        ),
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-forward",
          "raw.jsonl"
        ),
        workflowGraphPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-forward",
          "workflow.json"
        ),
        workspacePath
      });
      store.updateRunState("run-forward", "running");
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:30:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: "2026-05-22T09:00:00.000Z",
        normalizedLogOffset: Buffer.byteLength(oldToolCall),
        normalizedLogPath,
        outputTokensTotal: 0,
        runId: "run-forward",
        sampledAt: "2026-05-22T09:30:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
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
          mtimeIgnore: [],
          graceMinutes: 30,
          outputTokenBudget: 0,
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
        issueSnapshotPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-restarted",
          "issue.json"
        ),
        metadataPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-restarted",
          "metadata.json"
        ),
        normalizedLogPath: path.join(root, "provider.normalized.jsonl"),
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-restarted",
          "prompt.md"
        ),
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-restarted",
          "raw.jsonl"
        ),
        workflowGraphPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-restarted",
          "workflow.json"
        ),
        workspacePath
      });
      first.updateRunState("run-restarted", "running");
      first.upsertWatchdogSample({
        idleSince: "2026-05-22T09:40:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath: path.join(root, "provider.normalized.jsonl"),
        outputTokensTotal: 0,
        runId: "run-restarted",
        sampledAt: "2026-05-22T09:40:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
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
          mtimeIgnore: [],
          graceMinutes: 30,
          outputTokenBudget: 0,
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

  it("resets the log offset when a retry switches the normalized log path", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const attempt1 = path.join(root, "provider.normalized.jsonl");
    const attempt2 = path.join(root, "provider.normalized.attempt-2.jsonl");
    await writeFile(
      attempt1,
      JSON.stringify({ turnId: "attempt-1", type: "usage_updated" }) + "\n"
    );
    // A longer file whose early bytes carry a tool_call: reusing the previous
    // attempt's offset would start mid-line and skip this event entirely.
    await writeFile(
      attempt2,
      JSON.stringify({
        toolName: "bash",
        turnId: "attempt-2",
        type: "tool_call"
      }) + "\n"
    );
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    const evidence = (normalizedLogPath: string) => ({
      branchName: "sym/symphonika/198-watchdog",
      branchRef: "refs/heads/sym/symphonika/198-watchdog",
      issueSnapshotPath: path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-retry",
        "issue.json"
      ),
      metadataPath: path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-retry",
        "metadata.json"
      ),
      normalizedLogPath,
      promptPath: path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-retry",
        "prompt.md"
      ),
      rawLogPath: path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-retry",
        "raw.jsonl"
      ),
      workflowGraphPath: path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-retry",
        "workflow.json"
      ),
      workspacePath
    });
    const config = {
      enabled: true,
      mtimeIgnore: [],
      graceMinutes: 30,
      outputTokenBudget: 0,
      sampleIntervalSeconds: 60
    };
    try {
      seedRun(store, "run-retry");
      store.updateRunEvidence("run-retry", evidence(attempt1));
      store.updateRunState("run-retry", "running");
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: vi.fn().mockResolvedValue(undefined),
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-retry"
      });

      await reconcileWatchdog({
        activeRuns,
        config,
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });
      const afterFirst = store.getWatchdogSample("run-retry");
      expect(afterFirst?.lastToolCallAt).toBeNull();
      expect(afterFirst?.normalizedLogOffset).toBeGreaterThan(0);
      expect(afterFirst?.turnIdSetSize).toBe(1);

      // The retry begins before it switches to a new log path for the same
      // Run. Attempt-local samples and turn IDs must not cross this boundary.
      store.updateRunState("run-retry", "failed");
      store.updateRunState("run-retry", "preparing_workspace");
      store.updateRunEvidence("run-retry", evidence(attempt2));
      store.updateRunState("run-retry", "running");

      await reconcileWatchdog({
        activeRuns,
        config,
        logger,
        now: () => new Date("2026-05-22T10:01:00.000Z"),
        runStore: store
      });
      const afterSecond = store.getWatchdogSample("run-retry");
      expect(afterSecond?.normalizedLogPath).toBe(attempt2);
      expect(afterSecond?.lastToolCallAt).toBe("2026-05-22T10:01:00.000Z");
      expect(afterSecond?.turnIdSetSize).toBe(1);
      expect(store.getRun("run-retry")?.state).toBe("running");
    } finally {
      store.close();
    }
  });

  it("discards an in-flight sample when the Run starts a new attempt", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const attempt1 = path.join(root, "provider.normalized.jsonl");
    const attempt2 = path.join(root, "provider.normalized.attempt-2.jsonl");
    const attempt1Event =
      JSON.stringify({ turnId: "attempt-1", type: "usage_updated" }) + "\n";
    await writeFile(attempt1, attempt1Event);
    await writeFile(
      attempt2,
      JSON.stringify({ turnId: "attempt-2", type: "usage_updated" }) + "\n"
    );
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    const evidence = (normalizedLogPath: string) => ({
      branchName: "sym/symphonika/198-watchdog",
      branchRef: "refs/heads/sym/symphonika/198-watchdog",
      issueSnapshotPath: path.join(root, "issue.json"),
      metadataPath: path.join(root, "metadata.json"),
      normalizedLogPath,
      promptPath: path.join(root, "prompt.md"),
      rawLogPath: path.join(root, "raw.jsonl"),
      workflowGraphPath: path.join(root, "workflow.json"),
      workspacePath
    });
    const config = {
      enabled: true,
      graceMinutes: 30,
      mtimeIgnore: [],
      outputTokenBudget: 0,
      sampleIntervalSeconds: 60
    };
    const cancel = vi.fn().mockResolvedValue(undefined);
    const activeRuns = new ActiveRunRegistry();
    activeRuns.register({
      cancel,
      issueNumber: 198,
      projectName: "symphonika",
      runId: "run-retry-race"
    });

    try {
      seedRun(store, "run-retry-race");
      store.updateRunEvidence("run-retry-race", evidence(attempt1));
      store.updateRunState("run-retry-race", "running");

      await reconcileWatchdog({
        activeRuns,
        config,
        logger,
        now: () => new Date("2026-05-22T09:00:00.000Z"),
        runStore: store
      });
      expect(store.getWatchdogSample("run-retry-race")).toMatchObject({
        idleSince: "2026-05-22T09:00:00.000Z",
        turnIdSetSize: 1
      });

      // The second tick captures attempt 1, then yields on Normalized Event
      // Log I/O. Starting attempt 2 before awaiting the tick deterministically
      // exercises the stale post-I/O write that used to undo the reset.
      await writeFile(attempt1, attempt1Event + attempt1Event);
      const inFlightAttempt1Sample = reconcileWatchdog({
        activeRuns,
        config,
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });
      store.updateRunState("run-retry-race", "failed");
      store.updateRunState("run-retry-race", "preparing_workspace");
      store.updateRunEvidence("run-retry-race", evidence(attempt2));
      store.updateRunState("run-retry-race", "running");

      await expect(inFlightAttempt1Sample).resolves.toEqual({
        sampled: 0,
        terminated: 0
      });
      expect(store.getRun("run-retry-race")?.state).toBe("running");
      expect(store.getWatchdogSample("run-retry-race")).toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();

      await reconcileWatchdog({
        activeRuns,
        config,
        logger,
        now: () => new Date("2026-05-22T10:01:00.000Z"),
        runStore: store
      });
      expect(store.getWatchdogSample("run-retry-race")).toMatchObject({
        normalizedLogPath: attempt2,
        turnIdSetSize: 1
      });
    } finally {
      store.close();
    }
  });

  it("restarts the output-token baseline when a retry switches the normalized log path", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const attempt1 = path.join(root, "provider.normalized.jsonl");
    const attempt2 = path.join(root, "provider.normalized.attempt-2.jsonl");
    // The retry's usage event reports fewer output tokens than attempt 1's
    // high-water mark; without a baseline reset, Math.max keeps the old total.
    await writeFile(
      attempt2,
      JSON.stringify({
        tokenUsage: { outputTokens: 800 },
        type: "usage_updated"
      }) + "\n"
    );
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-retry-tokens");
      store.updateRunEvidence("run-retry-tokens", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-tokens",
          "issue.json"
        ),
        metadataPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-tokens",
          "metadata.json"
        ),
        normalizedLogPath: attempt2,
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-tokens",
          "prompt.md"
        ),
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-tokens",
          "raw.jsonl"
        ),
        workflowGraphPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-tokens",
          "workflow.json"
        ),
        workspacePath
      });
      store.updateRunState("run-retry-tokens", "running");
      // Prior attempt's persisted sample: high token total, OLD log path.
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:59:30.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 9_999,
        normalizedLogPath: attempt1,
        outputTokensTotal: 5_000,
        runId: "run-retry-tokens",
        sampledAt: "2026-05-22T09:59:30.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
      });
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: vi.fn().mockResolvedValue(undefined),
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-retry-tokens"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      const after = store.getWatchdogSample("run-retry-tokens");
      expect(after?.normalizedLogPath).toBe(attempt2);
      // Reset to the new attempt's value, not Math.max(5000, 800).
      expect(after?.outputTokensTotal).toBe(800);
    } finally {
      store.close();
    }
  });

  it("resets the idle grace window when a retry switches the normalized log path", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const attempt1 = path.join(root, "provider.normalized.jsonl");
    const attempt2 = path.join(root, "provider.normalized.attempt-2.jsonl");
    await writeFile(attempt2, "");
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-retry-idle");
      store.updateRunEvidence("run-retry-idle", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-idle",
          "issue.json"
        ),
        metadataPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-idle",
          "metadata.json"
        ),
        normalizedLogPath: attempt2,
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-idle",
          "prompt.md"
        ),
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-idle",
          "raw.jsonl"
        ),
        workflowGraphPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-retry-idle",
          "workflow.json"
        ),
        workspacePath
      });
      store.updateRunState("run-retry-idle", "running");
      // Prior attempt was idle for over an hour under the OLD log path.
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:00:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 50,
        normalizedLogPath: attempt1,
        outputTokensTotal: 0,
        runId: "run-retry-idle",
        sampledAt: "2026-05-22T09:00:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-retry-idle"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      // The attempt change restarts the grace clock, so the run is NOT staled
      // even though the prior attempt's idle_since is over an hour old.
      expect(store.getRun("run-retry-idle")?.state).toBe("running");
      expect(store.getWatchdogSample("run-retry-idle")?.idleSince).toBe(
        "2026-05-22T10:00:00.000Z"
      );
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("keeps a run alive when only a streamed assistant message advances", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const normalizedLogPath = path.join(root, "provider.normalized.jsonl");
    await writeFile(
      normalizedLogPath,
      JSON.stringify({ text: "still thinking", type: "message" }) + "\n"
    );
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-streaming");
      store.updateRunEvidence("run-streaming", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-streaming",
          "issue.json"
        ),
        metadataPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-streaming",
          "metadata.json"
        ),
        normalizedLogPath,
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-streaming",
          "prompt.md"
        ),
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-streaming",
          "raw.jsonl"
        ),
        workflowGraphPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-streaming",
          "workflow.json"
        ),
        workspacePath
      });
      store.updateRunState("run-streaming", "running");
      // Idle for over an hour by every other signal; only a streamed message is new.
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:00:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath,
        outputTokensTotal: 0,
        runId: "run-streaming",
        sampledAt: "2026-05-22T09:00:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-streaming"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      // A streamed assistant message is genuine output (ADR 0054 signal 5), so
      // the run is kept alive despite the hour-old idle_since.
      expect(store.getRun("run-streaming")?.state).toBe("running");
      expect(store.getWatchdogSample("run-streaming")?.lastMessageAt).toBe(
        "2026-05-22T10:00:00.000Z"
      );
      expect(store.getWatchdogSample("run-streaming")?.idleSince).toBeNull();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("applies configured mtime_ignore globs during reconciliation", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const normalizedLogPath = path.join(root, "provider.normalized.jsonl");
    await writeFile(normalizedLogPath, "");
    const buildLog = path.join(workspacePath, "build.log");
    await writeFile(buildLog, "log\n");
    const rootTime = new Date("2026-05-22T09:00:00.000Z");
    const logTime = new Date("2026-05-22T09:50:00.000Z");
    await utimes(buildLog, logTime, logTime);
    await utimes(workspacePath, rootTime, rootTime);

    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      seedRun(store, "run-ignored-log");
      store.updateRunEvidence("run-ignored-log", {
        branchName: "sym/symphonika/198-watchdog",
        branchRef: "refs/heads/sym/symphonika/198-watchdog",
        issueSnapshotPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-ignored-log",
          "issue.json"
        ),
        metadataPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-ignored-log",
          "metadata.json"
        ),
        normalizedLogPath,
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-ignored-log",
          "prompt.md"
        ),
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-ignored-log",
          "raw.jsonl"
        ),
        workflowGraphPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-ignored-log",
          "workflow.json"
        ),
        workspacePath
      });
      store.updateRunState("run-ignored-log", "running");
      store.upsertWatchdogSample({
        idleSince: "2026-05-22T09:00:00.000Z",
        lastMessageAt: null,
        lastToolCallAt: null,
        normalizedLogOffset: 0,
        normalizedLogPath,
        outputTokensTotal: 0,
        runId: "run-ignored-log",
        sampledAt: "2026-05-22T09:00:00.000Z",
        turnIdSetSize: 0,
        workspaceDigest: "",
        workspaceMtimeMax: rootTime.getTime()
      });
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 198,
        projectName: "symphonika",
        runId: "run-ignored-log"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: ["build.log"],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      // The only workspace change is an ignored *.log file, so reconciliation
      // observes no progress and stales the run — proving config.mtimeIgnore is
      // actually threaded into the sampler.
      expect(store.getRun("run-ignored-log")).toMatchObject({
        state: "stale",
        terminalReason: "no_progress"
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it("stales a Run that crosses its output-token budget without converging", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      await prepareIdleRun(store, root, workspacePath, "run-budget", 548);
      // Real work, streamed continuously — every liveness signal is satisfied,
      // which is exactly why the vow#1055 crash loop survived fourteen hours.
      await writeFile(
        path.join(root, "run-budget.normalized.jsonl"),
        [
          JSON.stringify({ message: "still going", type: "message" }),
          JSON.stringify({
            tokenUsage: { total: { outputTokens: 150_001 } },
            type: "usage_updated"
          })
        ].join("\n") + "\n"
      );
      const cancel = vi.fn().mockResolvedValue(undefined);
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel,
        issueNumber: 548,
        projectName: "symphonika",
        runId: "run-budget"
      });

      const result = await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 150_000,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      expect(result.terminated).toBe(1);
      expect(store.getRun("run-budget")).toMatchObject({
        state: "stale",
        terminalReason: "no_convergence"
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it("leaves a Run alone below its budget and when the budget is disabled", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      await prepareIdleRun(store, root, workspacePath, "run-under", 548);
      await writeFile(
        path.join(root, "run-under.normalized.jsonl"),
        [
          JSON.stringify({ message: "working", type: "message" }),
          JSON.stringify({
            tokenUsage: { total: { outputTokens: 149_999 } },
            type: "usage_updated"
          })
        ].join("\n") + "\n"
      );
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: vi.fn().mockResolvedValue(undefined),
        issueNumber: 548,
        projectName: "symphonika",
        runId: "run-under"
      });
      const config = {
        enabled: true,
        graceMinutes: 30,
        mtimeIgnore: [],
        outputTokenBudget: 150_000,
        sampleIntervalSeconds: 60
      };

      await reconcileWatchdog({
        activeRuns,
        config,
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });
      expect(store.getRun("run-under")?.state).toBe("running");

      // One token over, but with the guard switched off.
      await writeFile(
        path.join(root, "run-under.normalized.jsonl"),
        JSON.stringify({
          tokenUsage: { total: { outputTokens: 400_000 } },
          type: "usage_updated"
        }) + "\n"
      );
      await reconcileWatchdog({
        activeRuns,
        config: { ...config, outputTokenBudget: 0 },
        logger,
        now: () => new Date("2026-05-22T10:01:00.000Z"),
        runStore: store
      });
      expect(store.getRun("run-under")?.state).toBe("running");
    } finally {
      store.close();
    }
  });

  it("applies a per-Project output-token budget override", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      await prepareIdleRun(store, root, workspacePath, "run-override", 548);
      await writeFile(
        path.join(root, "run-override.normalized.jsonl"),
        [
          JSON.stringify({ message: "working", type: "message" }),
          JSON.stringify({
            tokenUsage: { total: { outputTokens: 200_000 } },
            type: "usage_updated"
          })
        ].join("\n") + "\n"
      );
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: vi.fn().mockResolvedValue(undefined),
        issueNumber: 548,
        projectName: "symphonika",
        runId: "run-override"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 150_000,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        // A verification-heavy Project buys headroom above the daemon default.
        projects: [
          { name: "symphonika", watchdog: { outputTokenBudget: 500_000 } }
        ],
        runStore: store
      });

      expect(store.getRun("run-override")?.state).toBe("running");
    } finally {
      store.close();
    }
  });

  it("reads Codex's nested cumulative output-token total", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      await prepareIdleRun(store, root, workspacePath, "run-codex-tokens", 548);
      // Codex's thread/tokenUsage/updated payload nests a cumulative running
      // total under tokenUsage.total; a flat outputTokens key never appears.
      await writeFile(
        path.join(root, "run-codex-tokens.normalized.jsonl"),
        [
          JSON.stringify({
            tokenUsage: {
              last: { outputTokens: 628 },
              total: { outputTokens: 628 }
            },
            type: "usage_updated"
          }),
          JSON.stringify({
            tokenUsage: {
              last: { outputTokens: 629 },
              total: { outputTokens: 1_257 }
            },
            type: "usage_updated"
          })
        ].join("\n") + "\n"
      );
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: vi.fn().mockResolvedValue(undefined),
        issueNumber: 548,
        projectName: "symphonika",
        runId: "run-codex-tokens"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      expect(
        store.getWatchdogSample("run-codex-tokens")?.outputTokensTotal
      ).toBe(1_257);
    } finally {
      store.close();
    }
  });

  it("sums per-message output tokens reported at the top level", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      await prepareIdleRun(
        store,
        root,
        workspacePath,
        "run-claude-tokens",
        548
      );
      // Claude forwards the raw Anthropic per-message usage, so each event is
      // an increment rather than a running total.
      await writeFile(
        path.join(root, "run-claude-tokens.normalized.jsonl"),
        [
          JSON.stringify({
            tokenUsage: { output_tokens: 250 },
            type: "usage_updated"
          }),
          JSON.stringify({
            tokenUsage: { output_tokens: 100 },
            type: "usage_updated"
          })
        ].join("\n") + "\n"
      );
      const activeRuns = new ActiveRunRegistry();
      activeRuns.register({
        cancel: vi.fn().mockResolvedValue(undefined),
        issueNumber: 548,
        projectName: "symphonika",
        runId: "run-claude-tokens"
      });

      await reconcileWatchdog({
        activeRuns,
        config: {
          enabled: true,
          graceMinutes: 30,
          mtimeIgnore: [],
          outputTokenBudget: 0,
          sampleIntervalSeconds: 60
        },
        logger,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore: store
      });

      // 250 + 100, not Math.max(250, 100).
      expect(
        store.getWatchdogSample("run-claude-tokens")?.outputTokensTotal
      ).toBe(350);
    } finally {
      store.close();
    }
  });
});

function seedRun(
  store: RunStore,
  id: string,
  projectName = "symphonika",
  issueNumber = 198,
  evidenceIgnore: readonly string[] = []
): void {
  store.createRun({
    evidenceIgnore,
    id,
    issue: {
      body: "",
      created_at: "2026-05-22T09:00:00.000Z",
      id: issueNumber,
      labels: ["agent-ready"],
      number: issueNumber,
      priority: 1,
      state: "open",
      title: "watchdog",
      updated_at: "2026-05-22T09:00:00.000Z",
      url: `https://example.test/${issueNumber}`
    },
    projectName,
    providerCommand: "codex fake",
    providerName: "codex"
  });
}

async function prepareIdleRun(
  store: RunStore,
  root: string,
  workspacePath: string,
  runId: string,
  issueNumber: number
): Promise<void> {
  seedRun(store, runId, "symphonika", issueNumber);
  const normalizedLogPath = path.join(root, `${runId}.normalized.jsonl`);
  store.updateRunEvidence(runId, {
    branchName: `sym/symphonika/${issueNumber}-${runId}`,
    branchRef: `refs/heads/sym/symphonika/${issueNumber}-${runId}`,
    issueSnapshotPath: path.join(root, runId, "issue.json"),
    metadataPath: path.join(root, runId, "metadata.json"),
    normalizedLogPath,
    promptPath: path.join(root, runId, "prompt.md"),
    rawLogPath: path.join(root, runId, "raw.jsonl"),
    workflowGraphPath: path.join(root, runId, "workflow.json"),
    workspacePath
  });
  store.updateRunState(runId, "running");
  store.upsertWatchdogSample({
    idleSince: "2026-05-22T09:00:00.000Z",
    lastMessageAt: null,
    lastToolCallAt: null,
    normalizedLogOffset: 0,
    normalizedLogPath,
    outputTokensTotal: 0,
    runId,
    sampledAt: "2026-05-22T09:00:00.000Z",
    turnIdSetSize: 0,
    workspaceDigest: "",
    workspaceMtimeMax: await sampleWorkspaceMtimeMax(workspacePath)
  });
}
