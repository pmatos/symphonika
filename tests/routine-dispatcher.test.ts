import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import type { RunControllerProvidersConfig } from "../src/lifecycle/run-controller.js";
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

  it.each(["providers config", "agent provider registry"] as const)(
    "skips a due routine when its provider is missing from the %s",
    async (missingFrom) => {
      const root = await makeTempRoot();
      const stateRoot = path.join(root, ".symphonika");
      const runStore = openRunStore({ stateRoot });
      const provider = {
        cancel: vi.fn().mockResolvedValue(undefined),
        name: "claude",
        runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
          await Promise.resolve();
          yield {
            normalized: { exitCode: 0, type: "process_exit" },
            raw: { code: 0, kind: "exit" }
          };
        }),
        validate: vi.fn().mockResolvedValue(undefined)
      } satisfies AgentProvider;
      const providersConfig =
        missingFrom === "providers config"
          ? { codex: { command: "codex fake" } }
          : {
              claude: { command: "claude fake" },
              codex: { command: "codex fake" }
            };

      try {
        const result = await dispatchDueRoutines({
          activeRuns: new ActiveRunRegistry(),
          agentProviders:
            missingFrom === "agent provider registry"
              ? {}
              : { claude: provider },
          configDir: root,
          globalConcurrency: { maxInFlight: undefined },
          now: new Date("2026-05-22T10:00:01.000Z"),
          prepareRoutineWorkspace: vi.fn(),
          projects: new Map([
            ["alpha", dueRoutineProjectFixture(root, "claude")]
          ]),
          providersConfig: providersConfig as RunControllerProvidersConfig,
          runStore,
          stateRoot
        });

        expect(result).toEqual({
          fired: [],
          skipped: [
            {
              projectName: "alpha",
              reason: "provider_not_registered: claude",
              routineName: "daily-report"
            }
          ]
        });
      } finally {
        runStore.close();
      }
    }
  );
});

function dueRoutineProjectFixture(root: string, provider: "codex" | "claude") {
  return {
    ...runStoreProjectFixture(),
    routines: [
      {
        kind: "report" as const,
        name: "daily-report",
        prompt: "Routine {{routine.name}} for {{project.name}}.",
        provider,
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: path.join(root, "daily-report.md")
      }
    ]
  };
}

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
