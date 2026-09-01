import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import { RunController } from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { RuntimeConfigReloader } from "../src/reload.js";
import { openRunStore } from "../src/run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";

const tempRoots: string[] = [];
const abortSignalMatcher = expect.any(AbortSignal) as unknown as AbortSignal;

afterEach(async () => {
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
    const controller = new RunController({
      activeRuns,
      agentProviders: { codex: provider },
      configDir: root,
      createRunId: () => "run-queued-timeout",
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      onWatchdogTerminated: onTerminated,
      prepareIssueWorkspace: vi.fn().mockResolvedValue(preparedWorkspace(root)),
      projectsLoader: () => Promise.resolve(new Map([[project.name, project]])),
      providersLoader: () => Promise.resolve(reloader.providersConfig()),
      runStore,
      schedule: () => undefined,
      stateRoot: path.join(root, ".symphonika"),
      watchdogConfigLoader: () =>
        Promise.resolve({ enabled: true, maxRunMinutes: 1 })
    });

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
    const prepareIssueWorkspace = (
      input: PrepareIssueWorkspaceInput
    ): Promise<PreparedIssueWorkspace> => {
      preparationStarted = true;
      return new Promise((resolve, reject) => {
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
    };
    const onTerminated = vi.fn();
    const controller = new RunController({
      activeRuns,
      agentProviders: { codex: provider },
      configDir: root,
      createRunId: () => "run-preparation-timeout",
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      onWatchdogTerminated: onTerminated,
      prepareIssueWorkspace,
      projectsLoader: () => Promise.resolve(new Map([[project.name, project]])),
      providersLoader: () => Promise.resolve(reloader.providersConfig()),
      runStore,
      schedule: () => undefined,
      stateRoot: path.join(root, ".symphonika"),
      watchdogConfigLoader: () =>
        Promise.resolve({ enabled: true, maxRunMinutes: 1 })
    });

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
      await expect(dispatch).resolves.toEqual({
        dispatched: true,
        runId: "run-preparation-timeout"
      });
      expect(preparationAborted).toBe(true);
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
    const controller = new RunController({
      activeRuns,
      agentProviders: { codex: provider },
      configDir: root,
      env: { GITHUB_TOKEN: "secret-token" },
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
      },
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      onWatchdogTerminated: onTerminated,
      prepareIssueWorkspace: vi.fn().mockResolvedValue(preparedWorkspace(root)),
      projectsLoader: () => Promise.resolve(new Map([[project.name, project]])),
      providersLoader: () => Promise.resolve(reloader.providersConfig()),
      runStore,
      schedule: () => undefined,
      stateRoot: path.join(root, ".symphonika"),
      watchdogConfigLoader: () =>
        Promise.resolve({ enabled: true, maxRunMinutes: 1 })
    });

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
    const controller = new RunController({
      activeRuns,
      agentProviders: { codex: provider },
      configDir: root,
      createRunId: () => "run-running-label-timeout",
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue,
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      onWatchdogTerminated: onTerminated,
      prepareIssueWorkspace: vi.fn().mockResolvedValue(preparedWorkspace(root)),
      projectsLoader: () => Promise.resolve(new Map([[project.name, project]])),
      providersLoader: () => Promise.resolve(reloader.providersConfig()),
      runStore,
      schedule: () => undefined,
      stateRoot: path.join(root, ".symphonika"),
      watchdogConfigLoader: () =>
        Promise.resolve({ enabled: true, maxRunMinutes: 1 })
    });

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
});

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
