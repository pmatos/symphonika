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
import {
  createGitWorkspaceAhead,
  createGitWorkspaceAtBase
} from "./helpers/git-workspace.js";

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
  it("succeeds a kind: git firing with commits ahead and discovers every open PR", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/01JABCDEFG";
    await createGitWorkspaceAhead({ branchName, workspacePath });
    const runStore = openRunStore({ stateRoot });
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
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const listPullRequestsForBranch = vi.fn().mockResolvedValue([
      {
        head: { ref: branchName, sha: "abc123" },
        number: 17,
        state: "open"
      },
      {
        head: { ref: branchName, sha: "def456" },
        number: 18,
        state: "open"
      },
      {
        head: { ref: "another-branch", sha: "ignored" },
        number: 19,
        state: "open"
      }
    ]);
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.resolve({
          branchName,
          branchRef: `refs/heads/${branchName}`,
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    );

    try {
      await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "01JABCDEFGHJKMNPQRSTVWXYZ12",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listOpenIssues: vi.fn().mockResolvedValue([]),
          listPullRequestsForBranch
        },
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace,
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              routines: [
                {
                  kind: "git",
                  name: "dependency-update",
                  prompt: "Commit on {{branch.name}} ({{branch.ref}}).",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "dependency-update.md")
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

      expect(prepareRoutineWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "git" })
      );
      expect(providerInputs).toEqual([
        expect.objectContaining({ branchName, workspacePath })
      ]);
      expect(providerInputs[0]?.prompt).toContain(
        `Commit on ${branchName} (refs/heads/${branchName}).`
      );
      expect(listPullRequestsForBranch).toHaveBeenCalledWith({
        branch: branchName,
        owner: "pmatos",
        repo: "alpha",
        token: "secret-token"
      });
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          pullRequests: [
            expect.objectContaining({ prNumber: 17 }),
            expect.objectContaining({ prNumber: 18 })
          ],
          state: "succeeded",
          terminalReason: null
        })
      ]);
      expect(runStore.listOpenTrackedPullRequests()).toEqual([]);
      expect(runStore.hasPullRequestFollowupWork()).toBe(false);
    } finally {
      runStore.close();
    }
  });

  it("fails a kind: git firing with no commits ahead of base", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/fire-zero";
    await createGitWorkspaceAtBase({ branchName, workspacePath });
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
    const listPullRequestsForBranch = vi.fn().mockResolvedValue([]);

    try {
      await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-zero",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listOpenIssues: vi.fn().mockResolvedValue([]),
          listPullRequestsForBranch
        },
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName,
            branchRef: `refs/heads/${branchName}`,
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath
          }),
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              routines: [
                {
                  kind: "git",
                  name: "dependency-update",
                  prompt: "Update dependencies.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "dependency-update.md")
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
          id: "fire-zero",
          pullRequests: [],
          state: "failed",
          terminalReason: "no_workspace_changes"
        })
      ]);
      expect(listPullRequestsForBranch).not.toHaveBeenCalled();
    } finally {
      runStore.close();
    }
  });

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

  it("marks a firing cancelled when an operator cancel lands before the provider exits cleanly", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        // Simulates an operator cancel landing on the shared registry while
        // the provider process is mid-run; the process then exits cleanly
        // regardless (e.g. it already finished its work before the SIGTERM
        // was observed).
        await activeRuns.requestCancel("fire-cancel", "operator");
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    );

    try {
      await dispatchDueRoutines({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-cancel",
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
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
                  prompt: "Report.",
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
          id: "fire-cancel",
          cancelReason: "operator",
          state: "cancelled"
        })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("marks a firing cancelled when an operator cancel lands before the provider throws", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        await activeRuns.requestCancel("fire-cancel-throw", "operator");
        throw new Error("provider process killed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    );

    try {
      await dispatchDueRoutines({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-cancel-throw",
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
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
                  prompt: "Report.",
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
          id: "fire-cancel-throw",
          cancelReason: "operator",
          state: "cancelled"
        })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("never launches the provider when an operator cancel lands during workspace preparation", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
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
    const prepareRoutineWorkspace = vi.fn(
      async (): Promise<PreparedRoutineWorkspace> => {
        // Simulates an operator cancel landing while workspace prep (e.g. a
        // slow git clone) is still in flight, before the provider has been
        // attached — reserveSlot's noop cancel handler is all that exists at
        // this point.
        await activeRuns.requestCancel("fire-cancel-prepare", "operator");
        return {
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        };
      }
    );

    try {
      await dispatchDueRoutines({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-cancel-prepare",
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
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
                  prompt: "Report.",
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

      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-cancel-prepare",
          cancelReason: "operator",
          state: "cancelled"
        })
      ]);
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

  it.each([
    {
      expectedFires: [],
      expectedNextFireAt: "2026-05-22T10:01:00.000Z",
      gap: "shorter than the interval",
      now: "2026-05-22T10:00:30.000Z"
    },
    {
      expectedFires: ["catch-up-fire"],
      expectedNextFireAt: "2026-05-22T10:02:00.000Z",
      gap: "long enough to miss one interval",
      now: "2026-05-22T10:01:30.000Z"
    }
  ])(
    "handles a restart gap $gap",
    async ({ expectedFires, expectedNextFireAt, now }) => {
      const root = await makeTempRoot();
      const stateRoot = path.join(root, ".symphonika");
      const runStore = openRunStore({ stateRoot });
      const provider = quietProvider();
      const routine = {
        ...minuteRoutine(root),
        catchUp: "fire_once_if_missed" as const
      };
      runStore.syncRoutines("alpha", [routine], {
        now: new Date("2026-05-22T09:59:30.000Z")
      });
      expect(
        runStore.claimRoutineFiring({
          firedAt: "2026-05-22T10:00:00.000Z",
          firingId: "previous-fire",
          nextFireAt: "2026-05-22T10:01:00.000Z",
          projectName: "alpha",
          providerCommand: "codex fake",
          providerName: "codex",
          routineName: "minute-report"
        })
      ).toBe(true);
      runStore.completeRoutineFiring({
        id: "previous-fire",
        state: "succeeded"
      });

      try {
        const result = await dispatchDueRoutines({
          ...recurringDispatchInput({
            activeRuns: new ActiveRunRegistry(),
            provider,
            root,
            routine,
            runStore
          }),
          createFiringId: () => "catch-up-fire",
          now: new Date(now),
          recomputeSchedulesFromNow: true
        });

        expect(result.fired).toEqual(expectedFires);
        expect(provider.runAttempt).toHaveBeenCalledTimes(expectedFires.length);
        expect(runStore.listRoutines()[0]?.nextFireAt).toBe(expectedNextFireAt);
      } finally {
        runStore.close();
      }
    }
  );

  it("fires one catch-up after restart when multiple recurring ticks were missed", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const routine = {
      ...minuteRoutine(root),
      catchUp: "fire_once_if_missed" as const
    };
    runStore.syncRoutines("alpha", [routine], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });
    expect(
      runStore.claimRoutineFiring({
        firedAt: "2026-05-22T10:00:00.000Z",
        firingId: "previous-fire",
        nextFireAt: "2026-05-22T10:01:00.000Z",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "minute-report"
      })
    ).toBe(true);
    runStore.completeRoutineFiring({
      id: "previous-fire",
      state: "succeeded"
    });

    try {
      const input = {
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine,
          runStore
        }),
        createFiringId: () => "catch-up-fire",
        now: new Date("2026-05-22T10:03:30.000Z"),
        recomputeSchedulesFromNow: true
      };

      const first = await dispatchDueRoutines(input);
      const second = await dispatchDueRoutines({
        ...input,
        createFiringId: () => "unexpected-fire",
        recomputeSchedulesFromNow: false
      });

      expect(first.fired).toEqual(["catch-up-fire"]);
      expect(second.fired).toEqual([]);
      expect(provider.runAttempt).toHaveBeenCalledTimes(1);
      expect(runStore.listRoutineFirings().map((firing) => firing.id)).toEqual([
        "catch-up-fire",
        "previous-fire"
      ]);
      expect(runStore.listRoutines()[0]).toMatchObject({
        lastFiredAt: "2026-05-22T10:03:30.000Z",
        nextFireAt: "2026-05-22T10:04:00.000Z"
      });
    } finally {
      runStore.close();
    }
  });

  it("records a catch-up window skip on restart when catch-up is omitted", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const routine = minuteRoutine(root);
    const logger = pino({ enabled: false });
    const logInfo = vi.spyOn(logger, "info");
    runStore.syncRoutines("alpha", [routine], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });
    expect(
      runStore.claimRoutineFiring({
        firedAt: "2026-05-22T10:00:00.000Z",
        firingId: "previous-fire",
        nextFireAt: "2026-05-22T10:01:00.000Z",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "minute-report"
      })
    ).toBe(true);
    runStore.completeRoutineFiring({
      id: "previous-fire",
      state: "succeeded"
    });

    try {
      const result = await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine,
          runStore
        }),
        logger,
        now: new Date("2026-05-22T10:01:30.000Z"),
        recomputeSchedulesFromNow: true
      });

      expect(result.fired).toEqual([]);
      expect(result.skipped).toEqual([
        {
          projectName: "alpha",
          reason: "catch_up_window",
          routineName: "minute-report"
        }
      ]);
      expect(runStore.listRoutineFirings().map((firing) => firing.id)).toEqual([
        "previous-fire"
      ]);
      expect(
        runStore.listRoutines({ now: new Date("2026-05-22T10:01:30.000Z") })[0]
      ).toMatchObject({
        lastAttemptedAt: "2026-05-22T10:01:30.000Z",
        lastSkipAt: "2026-05-22T10:01:30.000Z",
        lastSkipReason: "catch_up_window",
        nextFireAt: "2026-05-22T10:02:00.000Z",
        skipCounts24h: { catch_up_window: 1 }
      });
      expect(logInfo).toHaveBeenCalledWith(
        {
          reason: "catch_up_window",
          routine: "minute-report",
          scheduled_at: "2026-05-22T10:01:00.000Z"
        },
        "routine.skipped"
      );
      expect(provider.runAttempt).not.toHaveBeenCalled();
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
    const logger = pino({ enabled: false });
    const logInfo = vi.spyOn(logger, "info");
    runStore.syncRoutines("alpha", [routine], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });

    try {
      const result = await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        logger
      });

      expect(result.fired).toEqual([]);
      expect(result.skipped).toEqual([
        {
          projectName: "alpha",
          reason: "concurrency_cap",
          routineName: "minute-report"
        }
      ]);
      expect(runStore.listRoutineFirings()).toEqual([]);
      expect(runStore.listRoutines()[0]?.nextFireAt).toBe(
        "2026-05-22T10:01:00.000Z"
      );
      expect(
        runStore.listRoutines({ now: new Date("2026-05-22T10:00:00.000Z") })[0]
      ).toMatchObject({
        lastAttemptedAt: "2026-05-22T10:00:00.000Z",
        lastSkipAt: "2026-05-22T10:00:00.000Z",
        lastSkipReason: "concurrency_cap",
        skipCounts24h: { concurrency_cap: 1 }
      });
      expect(logInfo).toHaveBeenCalledWith(
        {
          reason: "concurrency_cap",
          routine: "minute-report",
          scheduled_at: "2026-05-22T10:00:00.000Z"
        },
        "routine.skipped"
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
    const logger = pino({ enabled: false });
    const logInfo = vi.spyOn(logger, "info");
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
      const result = await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine,
          runStore
        }),
        logger
      });

      expect(result.fired).toEqual([]);
      expect(result.skipped).toEqual([
        {
          projectName: "alpha",
          reason: "overlap",
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
      expect(
        runStore.listRoutines({ now: new Date("2026-05-22T10:00:00.000Z") })[0]
      ).toMatchObject({
        lastAttemptedAt: "2026-05-22T10:00:00.000Z",
        lastSkipAt: "2026-05-22T10:00:00.000Z",
        lastSkipReason: "overlap",
        skipCounts24h: { overlap: 1 }
      });
      expect(logInfo).toHaveBeenCalledWith(
        {
          reason: "overlap",
          routine: "minute-report",
          scheduled_at: "2026-05-22T10:00:00.000Z"
        },
        "routine.skipped"
      );
      runStore.completeRoutineFiring({
        id: "previous-fire",
        state: "succeeded"
      });
      const beforeNextClock = await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine,
          runStore
        }),
        now: new Date("2026-05-22T10:00:30.000Z")
      });
      const nextClock = await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine,
          runStore
        }),
        now: new Date("2026-05-22T10:01:00.000Z")
      });
      expect(beforeNextClock.fired).toEqual([]);
      expect(nextClock.fired).toEqual(["new-fire"]);
    } finally {
      runStore.close();
    }
  });

  it("fires an overlapping recurring tick when overlap is allowed", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const routine = { ...minuteRoutine(root), allowOverlap: true };
    const activeRuns = new ActiveRunRegistry();
    activeRuns.reserveSlot({
      issueNumber: -1,
      projectName: "alpha",
      respectsIssueLabels: false,
      runId: "previous-fire"
    });
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
      const dispatchInput = recurringDispatchInput({
        activeRuns,
        provider,
        root,
        routine,
        runStore
      });
      const project = dispatchInput.projects.get("alpha")!;
      dispatchInput.projects = new Map([
        ["alpha", { ...project, max_in_flight: 2 }]
      ]);
      const result = await dispatchDueRoutines(dispatchInput);

      expect(result.fired).toEqual(["new-fire"]);
      expect(result.skipped).toEqual([]);
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({ id: "new-fire", state: "succeeded" }),
        expect.objectContaining({ id: "previous-fire", state: "queued" })
      ]);
      expect(provider.runAttempt).toHaveBeenCalledTimes(1);
    } finally {
      activeRuns.unregister("previous-fire");
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

  it("skips an invalid routine stub without blocking a sibling routine's dispatch", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    runStore.upsertInvalidRoutineStub({
      name: "broken-routine",
      projectName: "alpha",
      sourcePath: path.join(root, "broken-routine.md")
    });
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
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.resolve({
          branchName: "main",
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
        createFiringId: () => "fire-sibling",
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace,
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              invalidRoutineNames: ["broken-routine"],
              routines: [
                {
                  kind: "report",
                  name: "daily-report",
                  prompt: "Report.",
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

      expect(result.fired).toEqual(["fire-sibling"]);
      expect(
        runStore.listRoutines().find((r) => r.name === "broken-routine")?.state
      ).toBe("invalid");
    } finally {
      runStore.close();
    }
  });
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
