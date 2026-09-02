import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import { RunController } from "../src/lifecycle/run-controller.js";
import type {
  RunControllerOptions,
  RunControllerProjectConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { RuntimeConfigReloader } from "../src/reload.js";
import type { RunStore } from "../src/run-store.js";
import { openRunStore } from "../src/run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";
import { WorkspacePreparationCleanupError } from "../src/workspace.js";
import { abortSignalMatcher } from "./helpers/abort-signal.js";
import { createDeferred } from "./helpers/deferred.js";

const fsOverrides = vi.hoisted(() => ({
  mkdir: undefined as
    ((target: string) => Promise<"handled" | "passthrough">) | undefined,
  rm: undefined as
    ((target: string) => Promise<"handled" | "passthrough">) | undefined
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: async (...args: Parameters<typeof original.mkdir>) => {
      const override = fsOverrides.mkdir;
      if (
        override !== undefined &&
        (await override(String(args[0]))) === "handled"
      ) {
        return undefined;
      }
      const mkdirOriginal = original.mkdir as (
        ...parameters: Parameters<typeof original.mkdir>
      ) => ReturnType<typeof original.mkdir>;
      return await mkdirOriginal(...args);
    },
    rm: async (...args: Parameters<typeof original.rm>) => {
      const override = fsOverrides.rm;
      if (
        override !== undefined &&
        (await override(String(args[0]))) === "handled"
      ) {
        return undefined;
      }
      return await original.rm(...args);
    }
  };
});

const tempRoots: string[] = [];

afterEach(async () => {
  fsOverrides.mkdir = undefined;
  fsOverrides.rm = undefined;
  vi.useRealTimers();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Run slot deadline", () => {
  it("wins while a fresh slot-owned Run still reads queued", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00.000Z"));
    const activeRuns = new ActiveRunRegistry();
    const reserveSlot = activeRuns.reserveSlot.bind(activeRuns);
    vi.spyOn(activeRuns, "reserveSlot").mockImplementation((input) => {
      reserveSlot(input);
      // claimAndPersistRun arms the deadline immediately after reserving. Move
      // the clock at that seam so the CAS observes the durable `queued` row.
      vi.setSystemTime(new Date("2026-09-01T09:01:00.000Z"));
    });
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      { createRunId: () => "run-queued-timeout" }
    );

    try {
      await expect(controller.dispatchOneFresh(pollStatus())).resolves.toEqual({
        dispatched: true,
        runId: "run-queued-timeout"
      });

      expect(activeRuns.countInFlight()).toBe(0);
      expect(runStore.getRun("run-queued-timeout")).toMatchObject({
        failureClassification: "deterministic",
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(
        runStore.listPendingRunNotifications().map((run) => run.id)
      ).toContain("run-queued-timeout");
      expect(
        runStore
          .getRun("run-queued-timeout")
          ?.transitions.map((transition) => transition.state)
      ).toEqual(["queued", "stale", "preparing_workspace", "stale"]);
      expect(provider.validate).not.toHaveBeenCalled();
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();

      // The timeout CAS made notification evidence visible immediately. If a
      // sender completes before lifecycle finalization repairs a clobbered
      // state, reassertion must not enqueue the same digest a second time.
      expect(runStore.claimRunNotifications(["run-queued-timeout"])).toBe(true);
      runStore.completeRunNotifications({
        runIds: ["run-queued-timeout"],
        state: "sent"
      });
      runStore.updateRunState("run-queued-timeout", "running");
      expect(
        runStore.markRunWatchdogStale("run-queued-timeout", "no_progress")
      ).toBe(false);
      expect(
        runStore.reassertRunWatchdogStale("run-queued-timeout", "run_timeout")
      ).toBe(true);
      expect(runStore.listPendingRunNotifications()).toEqual([]);
      expect(runStore.claimRunNotifications(["run-queued-timeout"])).toBe(
        false
      );
    } finally {
      runStore.close();
    }
  });

  it("aborts workspace preparation and releases the slot at the Run deadline", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // The provider must never be reached by this test.
      runAttempt: successfulAttempt,
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const prepared = preparedWorkspace(root);
    let preparationStarted = false;
    let preparationAborted = false;
    let releasePreparation: () => void = () => undefined;
    let releaseAbortCleanup: () => void = () => undefined;
    const abortCleanup = new Promise<void>((resolve) => {
      releaseAbortCleanup = resolve;
    });
    const prepareIssueWorkspace = (
      input: PrepareIssueWorkspaceInput
    ): Promise<PreparedIssueWorkspace> => {
      preparationStarted = true;
      const result = new Promise<PreparedIssueWorkspace>((resolve, reject) => {
        releasePreparation = () => resolve(prepared);
        input.signal?.addEventListener(
          "abort",
          () => {
            preparationAborted = true;
            reject(new Error("workspace preparation aborted"));
          },
          { once: true }
        );
        if (input.signal?.aborted === true) {
          preparationAborted = true;
          reject(new Error("workspace preparation aborted"));
          return;
        }
      });
      return Object.assign(result, { abortCleanup });
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-preparation-timeout",
        prepareIssueWorkspace
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await flushPromises();
      expect(preparationStarted).toBe(true);
      expect(activeRuns.countInFlight()).toBe(1);
      expect(runStore.getRun("run-preparation-timeout")?.state).toBe(
        "preparing_workspace"
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      expect(runStore.getRun("run-preparation-timeout")?.state).toBe("stale");
      expect(preparationAborted).toBe(true);
      expect(activeRuns.countInFlight()).toBe(1);

      releaseAbortCleanup();
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-preparation-timeout"
      });
      expect(activeRuns.countInFlight()).toBe(0);
      expect(runStore.getRun("run-preparation-timeout")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(
        runStore.listPendingRunNotifications().map((run) => run.id)
      ).toContain("run-preparation-timeout");
      expect(provider.validate).not.toHaveBeenCalled();
      expect(provider.cancel).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
      expect(onTerminated).toHaveBeenCalledWith({
        issueNumber: 611,
        projectName: "symphonika",
        runId: "run-preparation-timeout"
      });
    } finally {
      releasePreparation();
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("logs an incomplete issue workspace cleanup without blocking slot release", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // The provider must never be reached by this test.
      runAttempt: successfulAttempt,
      validate: vi.fn().mockResolvedValue(undefined)
    };
    let preparationStarted = false;
    let releaseAbortCleanup: () => void = () => undefined;
    const abortCleanup = new Promise<void>((resolve) => {
      releaseAbortCleanup = resolve;
    });
    const prepareIssueWorkspace = (
      input: PrepareIssueWorkspaceInput
    ): Promise<PreparedIssueWorkspace> => {
      preparationStarted = true;
      const result = new Promise<PreparedIssueWorkspace>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            reject(
              new WorkspacePreparationCleanupError(
                "failed to clean aborted issue worktree",
                new Error("worktree remove --force failed")
              )
            );
          },
          { once: true }
        );
      });
      return Object.assign(result, { abortCleanup });
    };
    const { lines, logger } = createCapturingLogger();
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-cleanup-failure-logged",
        logger,
        prepareIssueWorkspace
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await flushPromises();
      expect(preparationStarted).toBe(true);
      expect(activeRuns.countInFlight()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      releaseAbortCleanup();
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-cleanup-failure-logged"
      });
      // Slot release is not blocked on the full (rejected) preparation
      // result, only on the abort-cleanup channel settling. See ADR 0093 /
      // issue #640 — awaiting the full result here would reintroduce it.
      expect(activeRuns.countInFlight()).toBe(0);
      expect(
        lines.some(
          (line) =>
            line.msg ===
              "issue workspace cleanup did not complete after Run Slot Deadline abort" &&
            line.runId === "run-cleanup-failure-logged"
        )
      ).toBe(true);
    } finally {
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("releases the slot when non-Git workspace I/O remains stalled after abort cleanup settles", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: successfulAttempt,
      validate: vi.fn().mockResolvedValue(undefined)
    };
    let preparationStarted = false;
    let releasePreparation: () => void = () => undefined;
    const prepareIssueWorkspace = () => {
      preparationStarted = true;
      const result = new Promise<PreparedIssueWorkspace>((resolve) => {
        releasePreparation = () => resolve(preparedWorkspace(root));
      });
      // The unresolved result models stat/mkdir/realpath/rename stuck in the
      // kernel. No Git process group or owned staging-path cleanup remains.
      return Object.assign(result, { abortCleanup: Promise.resolve() });
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-non-git-preparation-stall",
        prepareIssueWorkspace
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T14:00:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await flushPromises();
      expect(preparationStarted).toBe(true);
      expect(activeRuns.countInFlight()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      expect(activeRuns.countInFlight()).toBe(0);
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-non-git-preparation-stall"
      });
      expect(runStore.getRun("run-non-git-preparation-stall")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(provider.validate).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
    } finally {
      releasePreparation();
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  // Workspace preparation is abortable; the setup that follows it is not. If
  // the finally waited on all of startAttempt, a stalled filesystem would keep
  // the slot past max_run_minutes — the leak this deadline exists to close.
  it("releases the slot when setup stalls after preparation settles", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    // The workflow read happens after preparation and carries no signal. A
    // FIFO with no writer blocks it exactly the way a stalled filesystem does.
    const workflowPath = path.join(root, "WORKFLOW.md");
    await unlink(workflowPath);
    await promisify(execFile)("mkfifo", [workflowPath]);

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: successfulAttempt,
      validate: vi.fn().mockResolvedValue(undefined)
    };
    let preparationSettled = false;
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-setup-stall",
        prepareIssueWorkspace: () => {
          preparationSettled = true;
          return Promise.resolve(preparedWorkspace(root));
        }
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T14:00:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await flushPromises();
      expect(preparationSettled).toBe(true);
      expect(activeRuns.countInFlight()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      // The workflow read is still blocked on the FIFO, yet the slot is free.
      expect(activeRuns.countInFlight()).toBe(0);
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-setup-stall"
      });
      expect(runStore.getRun("run-setup-stall")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(provider.validate).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await unblockFifo(workflowPath);
      runStore.close();
    }
  });

  it("times out an expired retry reservation while its row still reads failed", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00.000Z"));
    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const issue = pollStatus().candidateIssues[0]?.issue;
    if (issue === undefined) {
      throw new Error("expected test issue");
    }
    runStore.createRun({
      id: "run-expired-retry",
      issue,
      projectName: project.name,
      providerCommand: "codex fake",
      providerName: "codex"
    });
    runStore.recordTerminalReason(
      "run-expired-retry",
      "process_exit_1",
      "transient"
    );
    runStore.updateRunState("run-expired-retry", "failed");

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        githubIssuesApi: {
          addLabelsToIssue,
          getIssue: vi.fn().mockResolvedValue({
            body: issue.body,
            created_at: issue.created_at,
            html_url: issue.url,
            id: issue.id,
            labels: ["agent-ready", "sym:claimed"],
            number: issue.number,
            state: "open",
            title: issue.title,
            updated_at: issue.updated_at
          }),
          listOpenIssues: vi.fn().mockResolvedValue([]),
          removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
        }
      }
    );

    // The Run-scoped deadline started at the original claim, not when this
    // newer attempt reserved another slot.
    vi.setSystemTime(new Date("2026-09-01T10:01:00.000Z"));
    try {
      await controller.executeRetry({
        attemptNumber: 2,
        issue,
        projectName: project.name,
        providerCommand: "codex fake",
        providerName: "codex",
        runId: "run-expired-retry"
      });

      expect(addLabelsToIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 611,
          labels: ["sym:claimed"],
          signal: abortSignalMatcher
        })
      );
      expect(activeRuns.countInFlight()).toBe(0);
      expect(runStore.getRun("run-expired-retry")).toMatchObject({
        failureClassification: "deterministic",
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(
        runStore.listPendingRunNotifications().map((run) => run.id)
      ).toContain("run-expired-retry");
      expect(provider.validate).not.toHaveBeenCalled();
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
      expect(
        runStore
          .getRun("run-expired-retry")
          ?.transitions.map((transition) => transition.state)
      ).toEqual(["queued", "failed", "stale", "preparing_workspace", "stale"]);
    } finally {
      runStore.close();
    }
  });

  it("aborts a hung sym:running write without starting the provider", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    let runningWriteStarted = false;
    let runningWriteAborted = false;
    let releaseRunningWrite: () => void = () => undefined;
    const addLabelsToIssue = vi.fn(
      (input: { labels: string[]; signal?: AbortSignal }): Promise<void> => {
        if (!input.labels.includes("sym:running")) {
          return Promise.resolve();
        }
        runningWriteStarted = true;
        return new Promise((resolve, reject) => {
          releaseRunningWrite = resolve;
          const abort = (): void => {
            runningWriteAborted = true;
            reject(new Error("running label write aborted"));
          };
          input.signal?.addEventListener("abort", abort, { once: true });
          if (input.signal?.aborted === true) {
            abort();
          }
        });
      }
    );
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-running-label-timeout",
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([]),
          removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
        }
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T11:00:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await vi.waitFor(() => {
        expect(runningWriteStarted).toBe(true);
      });
      expect(activeRuns.countInFlight()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-running-label-timeout"
      });
      expect(runningWriteAborted).toBe(true);
      expect(activeRuns.countInFlight()).toBe(0);
      expect(runStore.getRun("run-running-label-timeout")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(provider.cancel).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
    } finally {
      releaseRunningWrite();
      await vi.advanceTimersByTimeAsync(60_000);
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("releases the slot without launching a provider when the deadline expires during HEAD inspection", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const fifoPath = path.join(root, "head-inspection.fifo");
    const inspectionStartedPath = path.join(root, "head-inspection.started");
    await promisify(execFile)("mkfifo", [fifoPath]);
    const binPath = path.join(root, "bin");
    const gitPath = path.join(binPath, "git");
    await mkdir(binPath, { recursive: true });
    await writeFile(
      gitPath,
      [
        "#!/bin/sh",
        `touch '${inspectionStartedPath}'`,
        `read -r _line < '${fifoPath}'`,
        "printf '%s\\n' '0123456789abcdef0123456789abcdef01234567'"
      ].join("\n")
    );
    await chmod(gitPath, 0o755);

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      { createRunId: () => "run-head-inspection-timeout" }
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binPath}${path.delimiter}${originalPath ?? ""}`;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T11:30:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await vi.waitFor(() => {
        expect(existsSync(inspectionStartedPath)).toBe(true);
      });
      expect(activeRuns.countInFlight()).toBe(1);
      expect(provider.runAttempt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      expect(activeRuns.countInFlight()).toBe(0);
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-head-inspection-timeout"
      });
      expect(runStore.getRun("run-head-inspection-timeout")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(provider.cancel).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();

      // Abandoning the race alone would leave the blocked `git` process
      // running. A non-blocking write-open of the FIFO fails once no reader
      // remains, proving the deadline signal actually tore the process down.
      await vi.waitFor(async () => {
        await expect(
          open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK)
        ).rejects.toThrow();
      });
    } finally {
      process.env.PATH = originalPath;
      vi.useRealTimers();
      await unblockFifo(fifoPath);
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("releases the slot without launching a provider when the deadline expires during scratch creation", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      { createRunId: () => "run-scratch-timeout" }
    );

    const expectedScratchPath = path.join(
      root,
      ".symphonika",
      "scratch",
      "run-scratch-timeout-attempt-1"
    );
    let scratchCreationStarted = false;
    const scratchCreationStalled = createDeferred<void>();
    fsOverrides.mkdir = async (target) => {
      if (path.resolve(target) !== expectedScratchPath) {
        return "passthrough";
      }
      scratchCreationStarted = true;
      await scratchCreationStalled.promise;
      return "handled";
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T11:45:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await vi.waitFor(() => {
        expect(scratchCreationStarted).toBe(true);
      });
      expect(activeRuns.countInFlight()).toBe(1);
      expect(provider.runAttempt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      expect(activeRuns.countInFlight()).toBe(0);
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-scratch-timeout"
      });
      expect(runStore.getRun("run-scratch-timeout")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(provider.cancel).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
    } finally {
      scratchCreationStalled.resolve();
      fsOverrides.mkdir = undefined;
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("releases the slot without launching a provider when the deadline expires during capacity loading", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    let capacityLoadStarted = false;
    const capacityLoadStalled = createDeferred<{
      maxInFlight: number | undefined;
    }>();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-capacity-load-timeout",
        providerBuildCapacityLoader: () => {
          capacityLoadStarted = true;
          return capacityLoadStalled.promise;
        }
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await vi.waitFor(() => {
        expect(capacityLoadStarted).toBe(true);
      });
      expect(activeRuns.countInFlight()).toBe(1);
      expect(provider.runAttempt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      expect(activeRuns.countInFlight()).toBe(0);
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-capacity-load-timeout"
      });
      expect(runStore.getRun("run-capacity-load-timeout")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      // The regression this guards against: attachProvider must not run
      // before the capacity load settles, or a cancel landing in this
      // window would burn its one shot on a provider.cancel() that has no
      // process to cancel yet, and runAttempt would launch anyway once the
      // load resolves.
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(provider.cancel).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
    } finally {
      capacityLoadStalled.resolve({ maxInFlight: undefined });
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("does not wait for a stalled scratch removal when the deadline expires after scratch creation succeeds", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    let capacityLoadStarted = false;
    const capacityLoadStalled = createDeferred<{
      maxInFlight: number | undefined;
    }>();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-scratch-removal-timeout",
        providerBuildCapacityLoader: () => {
          capacityLoadStarted = true;
          return capacityLoadStalled.promise;
        }
      }
    );

    const expectedScratchPath = path.join(
      root,
      ".symphonika",
      "scratch",
      "run-scratch-removal-timeout-attempt-1"
    );
    let removalStarted = false;
    const removalStalled = createDeferred<void>();
    fsOverrides.rm = async (target) => {
      if (path.resolve(target) !== expectedScratchPath) {
        return "passthrough";
      }
      removalStarted = true;
      await removalStalled.promise;
      return "handled";
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:15:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await vi.waitFor(() => {
        expect(capacityLoadStarted).toBe(true);
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      // Scratch creation succeeded before the deadline fired during
      // capacity loading, so removeProviderScratch's rm() is now stalled --
      // but slot release must not wait on it (the regression this guards
      // against: an unbounded rm() on an unresponsive filesystem would
      // otherwise retain the slot past the deadline).
      expect(removalStarted).toBe(true);
      expect(activeRuns.countInFlight()).toBe(0);
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-scratch-removal-timeout"
      });
      expect(runStore.getRun("run-scratch-removal-timeout")).toMatchObject({
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(onTerminated).toHaveBeenCalledOnce();
    } finally {
      capacityLoadStalled.resolve({ maxInFlight: undefined });
      removalStalled.resolve();
      fsOverrides.rm = undefined;
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("rolls back an indeterminate claim when the bounded write times out", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    // GitHub may have applied the label already; the response never arrives.
    const addLabelsToIssue = vi.fn(() => new Promise<void>(() => undefined));
    const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-indeterminate-claim",
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([]),
          removeLabelsFromIssue
        }
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T15:00:00.000Z"));
    try {
      // The claim deadline rejects while timers advance, so the handler has to
      // be attached before then or the rejection surfaces as unhandled.
      const dispatch = controller
        .dispatchOneFresh(pollStatus())
        .catch((error: unknown) => error);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      await expect(dispatch).resolves.toMatchObject({
        name: "RunTimeoutError"
      });
      expect(removeLabelsFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 611,
          labels: ["sym:claimed"]
        })
      );
      // No Run row exists to explain the claim, so nothing may mark it failed.
      expect(addLabelsToIssue).toHaveBeenCalledOnce();
      expect(runStore.getRun("run-indeterminate-claim")).toBeUndefined();
      expect(activeRuns.countInFlight()).toBe(0);
    } finally {
      runStore.close();
    }
  });

  it("finalizes a Run row when a non-shutdown error follows creation", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
    const removeLabelsFromIssue = vi.fn().mockResolvedValue(undefined);
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-conflict",
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([]),
          removeLabelsFromIssue
        }
      }
    );

    // Simulates a non-shutdown failure between createRun and slot
    // reservation (e.g. a plain reserveSlot conflict, or the run store
    // throwing on a DB error) without consuming the project's dispatch cap,
    // which a pre-existing activeRuns entry for this project would do.
    vi.spyOn(activeRuns, "reserveSlot").mockImplementationOnce(() => {
      throw new Error("boom: non-shutdown failure after Run row created");
    });

    try {
      await expect(controller.dispatchOneFresh(pollStatus())).rejects.toThrow(
        "boom: non-shutdown failure after Run row created"
      );

      // The claim remains the durable ownership record, while the Run follows
      // the same exhausted-transient-failure path as a pre-provider attempt
      // failure instead of remaining queued without a slot or Watchdog reach.
      expect(removeLabelsFromIssue).not.toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:claimed"] })
      );
      expect(addLabelsToIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:failed"] })
      );
      expect(runStore.getRun("run-conflict")).toMatchObject({
        failureClassification: "transient",
        state: "failed",
        terminalReason: "boom: non-shutdown failure after Run row created"
      });
      expect(
        runStore.listPendingRunNotifications().map((run) => run.id)
      ).toContain("run-conflict");
      expect(activeRuns.countInFlight()).toBe(0);
      expect(provider.validate).not.toHaveBeenCalled();
      expect(provider.runAttempt).not.toHaveBeenCalled();
    } finally {
      runStore.close();
    }
  });

  it("schedules a retry when a post-creation claim failure is transient", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
    const schedule = vi.fn<RunControllerOptions["schedule"]>();
    const controller = makeRunController(
      {
        activeRuns,
        onTerminated: vi.fn(),
        project,
        provider,
        reloader,
        root,
        runStore
      },
      {
        createRunId: () => "run-retryable-conflict",
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([]),
          removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
        },
        lifecyclePolicy: {
          continuation: { cap: 0, delayMs: 0 },
          retry: { cap: 1, delaysMs: [25], maxBackoffMs: 25 }
        },
        schedule
      }
    );

    vi.spyOn(activeRuns, "reserveSlot").mockImplementationOnce(() => {
      throw new Error("temporary slot reservation failure");
    });

    try {
      await expect(controller.dispatchOneFresh(pollStatus())).rejects.toThrow(
        "temporary slot reservation failure"
      );

      expect(runStore.getRun("run-retryable-conflict")).toMatchObject({
        failureClassification: "transient",
        retryCount: 1,
        state: "failed",
        terminalReason: "temporary slot reservation failure"
      });
      expect(schedule).toHaveBeenCalledOnce();
      expect(schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          delayMs: 25,
          issueNumber: 611,
          kind: "retry",
          projectName: "symphonika",
          runId: "run-retryable-conflict"
        })
      );
      expect(
        runStore.listPendingRunNotifications().map((run) => run.id)
      ).not.toContain("run-retryable-conflict");
      expect(addLabelsToIssue).not.toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["sym:failed"] })
      );
      expect(activeRuns.countInFlight()).toBe(0);
    } finally {
      runStore.close();
    }
  });

  it("does not reconcile an existing row when createRun itself fails", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    runStore.createRun({
      evidenceIgnore: [],
      id: "existing-run",
      issue: pollStatus().candidateIssues[0]!.issue,
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const controller = makeRunController(
      {
        activeRuns,
        onTerminated: vi.fn(),
        project,
        provider,
        reloader,
        root,
        runStore
      },
      { createRunId: () => "existing-run" }
    );

    try {
      await expect(controller.dispatchOneFresh(pollStatus())).rejects.toThrow();

      expect(runStore.getRun("existing-run")).toMatchObject({
        failureClassification: null,
        state: "queued",
        terminalReason: null
      });
      expect(runStore.listPendingRunNotifications()).toEqual([]);
      expect(activeRuns.countInFlight()).toBe(0);
    } finally {
      runStore.close();
    }
  });

  it("still throws the original claim failure when post-create reconciliation itself throws", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const controller = makeRunController(
      {
        activeRuns,
        onTerminated: vi.fn(),
        project,
        provider,
        reloader,
        root,
        runStore
      },
      { createRunId: () => "run-reconcile-throws" }
    );

    vi.spyOn(activeRuns, "reserveSlot").mockImplementationOnce(() => {
      throw new Error("temporary slot reservation failure");
    });
    // Simulates reconcilePostCreateClaimFailure itself throwing (e.g. a
    // busy/corrupt sqlite write right after a successful claim): the
    // guard in claimAndPersistRun's catch block must still surface the
    // original claim error, not this secondary one.
    vi.spyOn(runStore, "recordTerminalReason").mockImplementationOnce(() => {
      throw new Error("boom: secondary reconciliation failure");
    });

    try {
      await expect(controller.dispatchOneFresh(pollStatus())).rejects.toThrow(
        "temporary slot reservation failure"
      );

      // Reconciliation failed before it reached updateRunState, so the row
      // is left queued rather than silently vanishing or reporting the
      // wrong terminal state.
      expect(runStore.getRun("run-reconcile-throws")).toMatchObject({
        state: "queued"
      });
    } finally {
      runStore.close();
    }
  });

  it("bounds the claim rollback so a hung removeLabelsFromIssue cannot stall dispatchMutex", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    // Neither the claim write nor its rollback ever confirms.
    const addLabelsToIssue = vi.fn(() => new Promise<void>(() => undefined));
    const removeLabelsFromIssue = vi.fn(
      () => new Promise<void>(() => undefined)
    );
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-stuck-rollback",
        githubIssuesApi: {
          addLabelsToIssue,
          listOpenIssues: vi.fn().mockResolvedValue([]),
          removeLabelsFromIssue
        }
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T15:00:00.000Z"));
    try {
      const dispatch = controller
        .dispatchOneFresh(pollStatus())
        .catch((error: unknown) => error);
      await flushPromises();
      // First minute: the claim write's own deadline expires.
      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();
      // Second minute: the rollback's own deadline expires. Without one,
      // this await never settles and dispatchMutex stays held forever --
      // the exact stall the P1 review flagged.
      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();

      await expect(dispatch).resolves.toMatchObject({
        name: "RunTimeoutError"
      });
      expect(removeLabelsFromIssue).toHaveBeenCalledOnce();

      // dispatchMutex was released: a second dispatch reaches its own claim
      // write instead of hanging behind the still-unsettled call above.
      const secondDispatch = controller
        .dispatchOneFresh(pollStatus())
        .catch((error: unknown) => error);
      await flushPromises();
      expect(addLabelsToIssue).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(120_000);
      await flushPromises();
      await expect(secondDispatch).resolves.toMatchObject({
        name: "RunTimeoutError"
      });
    } finally {
      runStore.close();
    }
  });

  it("cancels an attached provider when the deadline wins mid-attempt", async () => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    let attemptStarted = false;
    let releaseAttempt: () => void = () => undefined;
    const attemptStalled = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    // eslint-disable-next-line require-yield
    async function* stalledAttempt(): AsyncGenerator<ProviderEvent> {
      attemptStarted = true;
      await attemptStalled;
    }
    const provider: AgentProvider = {
      cancel: vi.fn().mockImplementation(() => {
        releaseAttempt();
        return Promise.resolve();
      }),
      name: "codex",
      runAttempt: vi.fn(stalledAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      { createRunId: () => "run-attached-timeout" }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const dispatch = controller.dispatchOneFresh(pollStatus());
    try {
      await vi.waitFor(() => {
        expect(attemptStarted).toBe(true);
      });
      // attachProvider has replaced the preparation handler by now, so the
      // deadline must reach the provider rather than the abort controller.
      expect(runStore.getRun("run-attached-timeout")?.state).toBe("running");

      await vi.advanceTimersByTimeAsync(60_000);
      await flushPromises();
      await dispatch;

      expect(provider.cancel).toHaveBeenCalledOnce();
      expect(activeRuns.countInFlight()).toBe(0);
      expect(runStore.getRun("run-attached-timeout")).toMatchObject({
        failureClassification: "deterministic",
        state: "stale",
        terminalReason: "run_timeout"
      });
      expect(onTerminated).toHaveBeenCalledOnce();
    } finally {
      releaseAttempt();
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it.each([
    { config: { enabled: false, maxRunMinutes: 1 }, label: "disabled policy" },
    { config: { enabled: true, maxRunMinutes: 0 }, label: "a zero cap" }
  ])("arms no timer under $label", async ({ config }) => {
    const root = await makeTempRoot();
    await writeProject(root);
    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected test project");
    }

    const activeRuns = new ActiveRunRegistry();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(successfulAttempt),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const onTerminated = vi.fn();
    const controller = makeRunController(
      { activeRuns, onTerminated, project, provider, reloader, root, runStore },
      {
        createRunId: () => "run-uncapped",
        watchdogConfigLoader: () => config
      }
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T13:00:00.000Z"));
    try {
      const dispatch = controller.dispatchOneFresh(pollStatus());
      // Far past any cap the policy would have applied had one been armed.
      await vi.advanceTimersByTimeAsync(600_000);
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-uncapped"
      });

      expect(provider.runAttempt).toHaveBeenCalledOnce();
      expect(runStore.getRun("run-uncapped")?.terminalReason).not.toBe(
        "run_timeout"
      );
      expect(onTerminated).not.toHaveBeenCalled();
      expect(activeRuns.countInFlight()).toBe(0);
    } finally {
      runStore.close();
    }
  });

  it("refuses the timeout CAS once cancellation is requested", async () => {
    const root = await makeTempRoot();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    try {
      runStore.createRun({
        evidenceIgnore: [],
        id: "run-cancelled",
        issue: pollStatus().candidateIssues[0]!.issue,
        projectName: "symphonika",
        providerCommand: "codex",
        providerName: "codex"
      });
      runStore.markCancelRequested("run-cancelled", "operator");

      expect(runStore.markSlotOwnedRunTimedOut("run-cancelled")).toBe(false);
      expect(runStore.getRun("run-cancelled")).toMatchObject({
        state: "queued",
        terminalReason: null
      });
      expect(
        runStore.reassertRunWatchdogStale("run-cancelled", "run_timeout")
      ).toBe(false);
      expect(runStore.listPendingRunNotifications()).toEqual([]);
    } finally {
      runStore.close();
    }
  });
});

function makeRunController(
  deps: {
    activeRuns: ActiveRunRegistry;
    onTerminated: NonNullable<RunControllerOptions["onWatchdogTerminated"]>;
    project: RunControllerProjectConfig;
    provider: AgentProvider;
    reloader: RuntimeConfigReloader;
    root: string;
    runStore: RunStore;
  },
  overrides: {
    createRunId?: RunControllerOptions["createRunId"];
    githubIssuesApi?: RunControllerOptions["githubIssuesApi"];
    lifecyclePolicy?: RunControllerOptions["lifecyclePolicy"];
    logger?: RunControllerOptions["logger"];
    prepareIssueWorkspace?: RunControllerOptions["prepareIssueWorkspace"];
    providerBuildCapacityLoader?: RunControllerOptions["providerBuildCapacityLoader"];
    schedule?: RunControllerOptions["schedule"];
    watchdogConfigLoader?: RunControllerOptions["watchdogConfigLoader"];
  } = {}
): RunController {
  return new RunController({
    activeRuns: deps.activeRuns,
    agentProviders: { codex: deps.provider },
    configDir: deps.root,
    emailConfigLoader: () => undefined,
    env: { GITHUB_TOKEN: "secret-token" },
    ...(overrides.createRunId === undefined
      ? {}
      : { createRunId: overrides.createRunId }),
    githubIssuesApi: overrides.githubIssuesApi ?? {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    },
    lifecyclePolicy: overrides.lifecyclePolicy ?? {
      continuation: { cap: 0, delayMs: 0 },
      retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
    },
    logger: overrides.logger ?? pino({ enabled: false }),
    onWatchdogTerminated: deps.onTerminated,
    prepareIssueWorkspace:
      overrides.prepareIssueWorkspace ??
      vi.fn().mockResolvedValue(preparedWorkspace(deps.root)),
    projectsLoader: () =>
      Promise.resolve(new Map([[deps.project.name, deps.project]])),
    ...(overrides.providerBuildCapacityLoader === undefined
      ? {}
      : { providerBuildCapacityLoader: overrides.providerBuildCapacityLoader }),
    providersLoader: () => Promise.resolve(deps.reloader.providersConfig()),
    runStore: deps.runStore,
    schedule: overrides.schedule ?? (() => undefined),
    stateRoot: path.join(deps.root, ".symphonika"),
    watchdogConfigLoader:
      overrides.watchdogConfigLoader ??
      (() => ({ enabled: true, maxRunMinutes: 1 }))
  });
}

async function unblockFifo(fifoPath: string): Promise<void> {
  // Hands the blocked reader an EOF so its libuv thread is released. Opening
  // non-blocking keeps cleanup from hanging if no reader ever arrived.
  try {
    const writer = await open(
      fifoPath,
      constants.O_WRONLY | constants.O_NONBLOCK
    );
    await writer.close();
  } catch {
    // No reader is waiting; nothing to release.
  }
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-run-deadline-"));
  tempRoots.push(root);
  return root;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function* successfulAttempt(): AsyncGenerator<ProviderEvent> {
  await Promise.resolve();
  yield {
    normalized: { exitCode: 0, type: "process_exit" },
    raw: { code: 0, kind: "exit" }
  };
}

function pollStatus() {
  return {
    candidateIssues: [
      {
        issue: {
          body: "Bound preparation",
          created_at: "2026-08-31T10:00:00Z",
          id: 611,
          labels: ["agent-ready"],
          number: 611,
          priority: 99,
          state: "open" as const,
          title: "Bound preparation",
          updated_at: "2026-08-31T10:00:00Z",
          url: "https://github.com/pmatos/symphonika/issues/611"
        },
        project: "symphonika",
        repository: { owner: "pmatos", repo: "symphonika" }
      }
    ],
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

function preparedWorkspace(root: string): PreparedIssueWorkspace {
  return {
    branchName: "sym/symphonika/611-bound-preparation",
    branchRef: "refs/heads/sym/symphonika/611-bound-preparation",
    cachePath: path.join(root, ".symphonika/workspaces/.cache/repo.git"),
    issueDirectoryName: "611-bound-preparation",
    reused: false,
    workspacePath: path.join(
      root,
      ".symphonika/workspaces/611-bound-preparation"
    )
  };
}

async function writeProject(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "providers:",
      "  codex:",
      '    command: "codex fake"',
      "  claude:",
      '    command: "claude fake"',
      "projects:",
      "  - name: symphonika",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      "      labels_none: []",
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on the issue.\n");
}

type CapturedLine = Record<string, unknown>;

function createCapturingLogger(): {
  lines: CapturedLine[];
  logger: pino.Logger;
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
