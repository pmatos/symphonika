import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import { dispatchDueRoutines } from "../src/routines/dispatcher.js";
import type {
  PreparedRoutineWorkspace,
  PrepareRoutineWorkspaceInput
} from "../src/routines/workspace.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-dispatch-")
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

describe("RoutineFiringDispatcher", () => {
  it("fires a due one-shot report routine exactly once", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "alpha",
      "routines",
      "daily-report",
      "fire-1"
    );
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const providerInputs: ProviderRunInput[] = [];
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        providerInputs.push(input);
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const prepareRoutineWorkspace = vi.fn(
      (
        input: PrepareRoutineWorkspaceInput
      ): Promise<PreparedRoutineWorkspace> =>
        Promise.resolve({
          branchName: input.project.workspace.git.base_branch,
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    );

    try {
      const result = await dispatchDueRoutines({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-1",
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace,
        projects: new Map([
          [
            "alpha",
            {
              agent: { provider: "codex" },
              disabled: false,
              issue_filters: {
                labels_all: ["agent-ready"],
                labels_none: ["blocked"],
                states: ["open"]
              },
              name: "alpha",
              priority: { default: 99, labels: {} },
              routines: [
                {
                  kind: "report",
                  name: "daily-report",
                  prompt: "Routine {{routine.name}} for {{project.name}}.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md")
                }
              ],
              tracker: {
                kind: "github",
                owner: "pmatos",
                repo: "alpha",
                token: "$GITHUB_TOKEN"
              },
              workspace: {
                git: {
                  base_branch: "main",
                  remote: "git@github.com:pmatos/alpha.git"
                },
                root: "./.symphonika/workspaces/alpha"
              },
              workflow: {
                format: "markdown",
                path: "./WORKFLOW.md"
              }
            }
          ]
        ]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(result.fired).toEqual(["fire-1"]);
      const prepareInput = prepareRoutineWorkspace.mock.calls[0]?.[0];
      expect(prepareInput?.firingId).toBe("fire-1");
      expect(prepareInput?.project.name).toBe("alpha");
      expect(prepareInput?.routineName).toBe("daily-report");
      expect(provider.validate).toHaveBeenCalledWith("codex fake");
      expect(providerInputs).toHaveLength(1);
      const providerInput = providerInputs[0];
      expect(providerInput?.prompt).toContain(
        "Routine daily-report for alpha."
      );
      expect(providerInput).toMatchObject({
        branchName: "main",
        provider: { command: "codex fake", name: "codex" },
        run: { attempt: 1, id: "fire-1" },
        workspacePath
      });
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-1",
          provider: "codex",
          routineName: "daily-report",
          state: "succeeded",
          workspacePath
        })
      ]);
      expect(
        runStore
          .listRoutineFiringTransitions("fire-1")
          .map((entry) => entry.state)
      ).toEqual(["queued", "preparing_workspace", "running", "succeeded"]);
      const routineStatus = runStore.listRoutines()[0];
      expect(routineStatus?.lastFiredAt).toEqual(expect.any(String));
      expect(routineStatus).toMatchObject({
        nextFireAt: null,
        state: "expired"
      });

      const second = await dispatchDueRoutines({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-2",
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:02.000Z"),
        prepareRoutineWorkspace,
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              routines: [
                {
                  kind: "report",
                  name: "daily-report",
                  prompt: "Routine {{routine.name}} for {{project.name}}.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md")
                }
              ]
            }
          ]
        ]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(second.fired).toEqual([]);
      expect(providerInputs).toHaveLength(1);
    } finally {
      runStore.close();
    }
  });

  it("fires every recurring tick and advances next_fire_at after success or failure", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const firingIds = ["fire-1", "fire-2"];
    let attempt = 0;
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        const exitCode = attempt++ === 0 ? 0 : 1;
        yield {
          normalized: { exitCode, type: "process_exit" },
          raw: { code: exitCode, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const routine = {
      kind: "report" as const,
      name: "minute-report",
      prompt: "Routine {{routine.name}}.",
      provider: null,
      schedule: { cron: "* * * * *", tz: "Etc/UTC" },
      sourcePath: path.join(root, "minute-report.md")
    };
    const project = { ...runStoreProjectFixture(), routines: [routine] };
    const baseInput = {
      activeRuns,
      agentProviders: { codex: provider },
      configDir: root,
      createFiringId: () => firingIds.shift() ?? "unexpected-fire",
      globalConcurrency: { maxInFlight: undefined },
      logger: pino({ enabled: false }),
      prepareRoutineWorkspace: (input: PrepareRoutineWorkspaceInput) =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath: path.join(root, input.firingId)
        }),
      projects: new Map([["alpha", project]]),
      providersConfig: {
        claude: { command: "claude fake" },
        codex: { command: "codex fake" }
      },
      runStore,
      stateRoot
    };

    try {
      runStore.syncRoutines("alpha", [routine], {
        now: new Date("2026-05-22T09:59:30.000Z")
      });

      const first = await dispatchDueRoutines({
        ...baseInput,
        now: new Date("2026-05-22T10:00:00.000Z")
      });
      const second = await dispatchDueRoutines({
        ...baseInput,
        now: new Date("2026-05-22T10:01:00.000Z")
      });

      expect(first.fired).toEqual(["fire-1"]);
      expect(second.fired).toEqual(["fire-2"]);
      expect(
        runStore
          .listRoutineFirings()
          .map((firing) => ({ id: firing.id, state: firing.state }))
          .sort((left, right) => left.id.localeCompare(right.id))
      ).toEqual([
        { id: "fire-1", state: "succeeded" },
        { id: "fire-2", state: "failed" }
      ]);
      expect(runStore.listRoutines()[0]).toMatchObject({
        lastFiredAt: "2026-05-22T10:01:00.000Z",
        nextFireAt: "2026-05-22T10:02:00.000Z",
        state: "active"
      });
    } finally {
      runStore.close();
    }
  });

  it("skips a recurring tick at the concurrency cap and advances its schedule", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    activeRuns.reserveSlot({
      issueNumber: 42,
      projectName: "alpha",
      respectsIssueLabels: true,
      runId: "issue-run"
    });
    const provider = quietProvider();
    const routine = minuteRoutine(root);
    runStore.syncRoutines("alpha", [routine], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });

    try {
      const result = await dispatchDueRoutines(
        recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        })
      );

      expect(result.fired).toEqual([]);
      expect(result.skipped).toEqual([
        {
          projectName: "alpha",
          reason: "project alpha max_in_flight (1) reached",
          routineName: "minute-report"
        }
      ]);
      expect(runStore.listRoutineFirings()).toEqual([]);
      expect(runStore.listRoutines()[0]?.nextFireAt).toBe(
        "2026-05-22T10:01:00.000Z"
      );
    } finally {
      activeRuns.unregister("issue-run");
      runStore.close();
    }
  });

  it("skips an overlapping recurring tick without creating a firing row", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const routine = minuteRoutine(root);
    runStore.syncRoutines("alpha", [routine], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });
    runStore.createRoutineFiring({
      id: "previous-fire",
      projectName: "alpha",
      providerCommand: "codex fake",
      providerName: "codex",
      routineName: "minute-report"
    });

    try {
      const result = await dispatchDueRoutines(
        recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine,
          runStore
        })
      );

      expect(result.fired).toEqual([]);
      expect(result.skipped).toEqual([
        {
          projectName: "alpha",
          reason: "routine overlap",
          routineName: "minute-report"
        }
      ]);
      expect(runStore.listRoutineFirings().map((firing) => firing.id)).toEqual([
        "previous-fire"
      ]);
      expect(runStore.listRoutines()[0]?.nextFireAt).toBe(
        "2026-05-22T10:01:00.000Z"
      );
      expect(provider.runAttempt).not.toHaveBeenCalled();
    } finally {
      runStore.close();
    }
  });

  it("marks a firing failed with prompt_render_error for issue/run/branch references", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;

    try {
      await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-render-error",
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              routines: [
                {
                  kind: "report",
                  name: "daily-report",
                  prompt: "Bad {{issue.title}} {{run.id}} {{branch.name}}.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md")
                }
              ]
            }
          ]
        ]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-render-error",
          state: "failed",
          terminalReason: "prompt_render_error"
        })
      ]);
      expect(provider.runAttempt).not.toHaveBeenCalled();
    } finally {
      runStore.close();
    }
  });
});

function runStoreProjectFixture() {
  return {
    agent: { provider: "codex" as const },
    disabled: false,
    issue_filters: {
      labels_all: ["agent-ready"],
      labels_none: ["blocked"],
      states: ["open" as const]
    },
    name: "alpha",
    priority: { default: 99, labels: {} },
    tracker: {
      kind: "github" as const,
      owner: "pmatos",
      repo: "alpha",
      token: "$GITHUB_TOKEN"
    },
    workspace: {
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/alpha.git"
      },
      root: "./.symphonika/workspaces/alpha"
    },
    workflow: {
      format: "markdown" as const,
      path: "./WORKFLOW.md"
    }
  };
}

function minuteRoutine(root: string) {
  return {
    kind: "report" as const,
    name: "minute-report",
    prompt: "Report.",
    provider: null,
    schedule: { cron: "* * * * *", tz: "Etc/UTC" },
    sourcePath: path.join(root, "minute-report.md")
  };
}

function quietProvider(): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

function recurringDispatchInput(input: {
  activeRuns: ActiveRunRegistry;
  provider: AgentProvider;
  root: string;
  routine: ReturnType<typeof minuteRoutine>;
  runStore: ReturnType<typeof openRunStore>;
}) {
  return {
    activeRuns: input.activeRuns,
    agentProviders: { codex: input.provider },
    configDir: input.root,
    createFiringId: () => "new-fire",
    globalConcurrency: { maxInFlight: undefined },
    logger: pino({ enabled: false }),
    now: new Date("2026-05-22T10:00:00.000Z"),
    prepareRoutineWorkspace: () =>
      Promise.resolve({
        branchName: "main",
        branchRef: "refs/remotes/origin/main",
        cachePath: path.join(input.root, ".cache", "repo.git"),
        reused: false,
        workspacePath: path.join(input.root, "workspace")
      }),
    projects: new Map([
      ["alpha", { ...runStoreProjectFixture(), routines: [input.routine] }]
    ]),
    providersConfig: {
      claude: { command: "claude fake" },
      codex: { command: "codex fake" }
    },
    runStore: input.runStore,
    stateRoot: path.join(input.root, ".symphonika")
  };
}
