import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import type { RunControllerProvidersConfig } from "../src/lifecycle/run-controller.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type { NotificationMessage } from "../src/notifications/types.js";
import {
  dispatchDueRoutines,
  fireRoutineNow
} from "../src/routines/dispatcher.js";
import type { TargetedRoutineDeclaration } from "../src/routines/types.js";
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
  it("manually fires a not-due Routine through the normal provider lifecycle", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const provider = quietProvider();
    const routine = {
      kind: "report" as const,
      name: "daily-report",
      prompt: "Routine {{routine.name}} for {{project.name}}.",
      provider: null,
      schedule: { at: "2026-05-23T10:00:00.000Z" },
      sourcePath: path.join(root, "daily-report.md"),
      projectName: "alpha"
    };
    runStore.syncRoutines([routine]);

    try {
      const result = fireRoutineNow({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "manual-fire",
        globalConcurrency: { maxInFlight: undefined },
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath
          }),
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              routines: [routine]
            }
          ]
        ]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        request: { routineName: "daily-report" },
        runStore,
        stateRoot
      });

      expect(result).toMatchObject({
        firingId: "manual-fire",
        kind: "accepted",
        projectName: "alpha",
        routineName: "daily-report"
      });
      if (result.kind !== "accepted") {
        throw new Error("manual firing was not accepted");
      }
      expect(activeRuns.countInFlight()).toBe(1);
      await result.completion;

      expect(provider.runAttempt).toHaveBeenCalledOnce();
      expect(runStore.getRoutineFiring("manual-fire")).toMatchObject({
        state: "succeeded",
        triggerSource: "manual",
        workspacePath
      });
      expect(runStore.listRoutines()[0]).toMatchObject({
        lastFiredAt: null,
        nextFireAt: "2026-05-23T10:00:00.000Z",
        state: "active"
      });
      expect(activeRuns.countInFlight()).toBe(0);
    } finally {
      runStore.close();
    }
  });

  it("refuses a manual firing when its Project concurrency cap is full", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const routine = {
      kind: "report" as const,
      name: "daily-report",
      prompt: "Report.",
      provider: null,
      schedule: { at: "2026-05-23T10:00:00.000Z" },
      sourcePath: path.join(root, "daily-report.md"),
      projectName: "alpha"
    };
    runStore.syncRoutines([routine]);
    activeRuns.reserveSlot({
      issueNumber: 42,
      projectName: "alpha",
      respectsIssueLabels: true,
      runId: "issue-run"
    });

    try {
      const result = fireRoutineNow({
        activeRuns,
        agentProviders: { codex: quietProvider() },
        configDir: root,
        globalConcurrency: { maxInFlight: undefined },
        prepareRoutineWorkspace: vi.fn(),
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              routines: [routine]
            }
          ]
        ]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        request: { routineName: "daily-report" },
        runStore,
        stateRoot
      });

      expect(result).toEqual({
        error:
          "concurrency cap reached: project alpha max_in_flight (1) reached",
        kind: "refused",
        reason: "concurrency_cap"
      });
      expect(runStore.listRoutineFirings()).toEqual([]);
      expect(runStore.listRoutines()[0]).toMatchObject({
        lastAttemptedAt: null,
        nextFireAt: "2026-05-23T10:00:00.000Z"
      });
    } finally {
      activeRuns.unregister("issue-run");
      runStore.close();
    }
  });

  it("allows --force to override an explicitly operator-disabled Routine", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const routine = {
      disabled: true,
      kind: "report" as const,
      name: "daily-report",
      prompt: "Report.",
      provider: null,
      schedule: { at: "2026-05-23T10:00:00.000Z" },
      sourcePath: path.join(root, "daily-report.md"),
      projectName: "alpha"
    };
    runStore.syncRoutines([routine]);

    try {
      const result = fireRoutineNow({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: quietProvider() },
        configDir: root,
        createFiringId: () => "forced-manual-fire",
        globalConcurrency: { maxInFlight: undefined },
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
              routines: [routine]
            }
          ]
        ]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        request: { force: true, routineName: "daily-report" },
        runStore,
        stateRoot
      });

      expect(result).toMatchObject({
        firingId: "forced-manual-fire",
        kind: "accepted"
      });
      if (result.kind !== "accepted") {
        throw new Error("forced manual firing was not accepted");
      }
      await result.completion;
      expect(runStore.getRoutineFiring("forced-manual-fire")).toMatchObject({
        state: "succeeded",
        triggerSource: "manual"
      });
      expect(runStore.listRoutines()[0]).toMatchObject({
        disabledReason: "operator",
        state: "disabled"
      });
    } finally {
      runStore.close();
    }
  });

  it("returns precise state refusals and does not let --force bypass non-operator stops", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const declaration = (projectName: string) => ({
      kind: "report" as const,
      name: "daily-report",
      prompt: "Report.",
      provider: null,
      schedule: { at: "2026-05-23T10:00:00.000Z" },
      sourcePath: path.join(root, `${projectName}-daily-report.md`),
      projectName
    });
    runStore.syncRoutines([
      declaration("removed"),
      declaration("expired"),
      declaration("inactive")
    ]);
    runStore.syncRoutines([declaration("expired"), declaration("inactive")], {
      projects: ["removed", "expired", "inactive"]
    });
    runStore.upsertInvalidRoutineStub({
      name: "daily-report",
      projectName: "invalid",
      sourcePath: path.join(root, "invalid-daily-report.md")
    });
    expect(
      runStore.claimRoutineFiring({
        firedAt: "2026-05-23T10:00:00.000Z",
        firingId: "previous-scheduled-fire",
        projectName: "expired",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report"
      })
    ).toBe(true);
    runStore.completeRoutineFiring({
      id: "previous-scheduled-fire",
      state: "succeeded"
    });
    runStore.markRoutinesInactiveForProject("inactive");
    const projects = new Map(
      ["removed", "expired", "inactive", "invalid"].map((projectName) => [
        projectName,
        {
          ...runStoreProjectFixture(),
          name: projectName,
          routines: [declaration(projectName)]
        }
      ])
    );

    try {
      const fire = (projectName: string) =>
        fireRoutineNow({
          activeRuns: new ActiveRunRegistry(),
          agentProviders: { codex: quietProvider() },
          configDir: root,
          globalConcurrency: { maxInFlight: undefined },
          prepareRoutineWorkspace: vi.fn(),
          projects,
          providersConfig: {
            claude: { command: "claude fake" },
            codex: { command: "codex fake" }
          },
          request: {
            force: true,
            projectName,
            routineName: "daily-report"
          },
          runStore,
          stateRoot
        });

      expect(fire("removed")).toEqual({
        error: "routine daily-report is disabled (removed_from_config)",
        kind: "refused",
        reason: "disabled"
      });
      expect(fire("invalid")).toEqual({
        error: "routine daily-report is invalid",
        kind: "refused",
        reason: "invalid"
      });
      expect(fire("expired")).toEqual({
        error: "routine daily-report is expired",
        kind: "refused",
        reason: "expired"
      });
      expect(fire("inactive")).toEqual({
        error: "routine daily-report is inactive",
        kind: "refused",
        reason: "inactive"
      });
      expect(runStore.listRoutineFirings()).toHaveLength(1);
    } finally {
      runStore.close();
    }
  });

  it("rejects an ambiguous Routine name with every Project candidate", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const declaration = (projectName: string) => ({
      kind: "report" as const,
      name: "daily-report",
      prompt: "Report.",
      provider: null,
      schedule: { at: "2026-05-23T10:00:00.000Z" },
      sourcePath: path.join(root, `${projectName}-daily-report.md`),
      projectName
    });
    runStore.syncRoutines([declaration("alpha"), declaration("beta")]);

    try {
      const result = fireRoutineNow({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: quietProvider() },
        configDir: root,
        globalConcurrency: { maxInFlight: undefined },
        prepareRoutineWorkspace: vi.fn(),
        projects: new Map(
          ["alpha", "beta"].map((projectName) => [
            projectName,
            {
              ...runStoreProjectFixture(),
              name: projectName,
              routines: [declaration(projectName)]
            }
          ])
        ),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        request: { routineName: "daily-report" },
        runStore,
        stateRoot
      });

      expect(result).toEqual({
        candidates: [
          { projectName: "alpha", routineName: "daily-report" },
          { projectName: "beta", routineName: "daily-report" }
        ],
        error:
          "routine daily-report is ambiguous; candidates: alpha/daily-report, beta/daily-report; provide --project",
        kind: "ambiguous"
      });
      expect(runStore.listRoutineFirings()).toEqual([]);
    } finally {
      runStore.close();
    }
  });

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
    const observedPullRequests = [
      {
        head: { ref: branchName, sha: "abc123" },
        html_url: "https://github.com/pmatos/alpha/pull/17",
        number: 17,
        state: "open",
        title: "Extract retry policy"
      },
      {
        head: { ref: branchName, sha: "def456" },
        html_url: "https://github.com/pmatos/alpha/pull/18",
        number: 18,
        state: "open",
        title: "Document retry policy"
      },
      {
        head: { ref: "another-branch", sha: "ignored" },
        number: 19,
        state: "open"
      }
    ];
    const listPullRequestsForBranch = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(observedPullRequests)
      .mockRejectedValue(new Error("unexpected third PR read"));
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
                  sourcePath: path.join(root, "dependency-update.md"),
                  projectName: "alpha"
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
      expect(listPullRequestsForBranch).toHaveBeenCalledTimes(2);
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          outcome: {
            action: "pr",
            source: "gh",
            status: "success",
            summary: "Observed via GitHub state diff.",
            title: "Extract retry policy",
            url: "https://github.com/pmatos/alpha/pull/17",
            verified: true
          },
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
                  sourcePath: path.join(root, "dependency-update.md"),
                  projectName: "alpha"
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
      expect(listPullRequestsForBranch).toHaveBeenCalledTimes(2);
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
              mode: "dispatch" as const,
              priority: { default: 99, labels: {} },
              routines: [
                {
                  kind: "report",
                  name: "daily-report",
                  prompt: "Routine {{routine.name}} for {{project.name}}.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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
          outcome: {
            action: "none",
            source: "symphonika",
            status: "no_action",
            summary: "No externally observable action was reported.",
            title: "",
            url: null,
            verified: false
          },
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
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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

  it("derives an issue-closed outcome from GitHub state when the claim is absent", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const listIssues = vi
      .fn()
      .mockResolvedValueOnce([
        {
          html_url: "https://github.com/pmatos/alpha/issues/17",
          number: 17,
          state: "open",
          title: "Superseded dependency issue"
        }
      ])
      .mockResolvedValueOnce([
        {
          html_url: "https://github.com/pmatos/alpha/issues/17",
          number: 17,
          state: "closed",
          title: "Superseded dependency issue"
        }
      ]);
    const provider = quietProvider();

    try {
      await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine: {
            ...minuteRoutine(root),
            schedule: { at: "2026-05-22T10:00:00.000Z" }
          },
          runStore
        }),
        createFiringId: () => "fire-issue-close",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listIssues,
          listOpenIssues: vi.fn().mockResolvedValue([])
        }
      });

      expect(listIssues).toHaveBeenCalledTimes(2);
      expect(listIssues).toHaveBeenCalledWith({
        owner: "pmatos",
        repo: "alpha",
        since: "2026-05-21T10:00:00.000Z",
        state: "all",
        token: "secret-token"
      });
      expect(runStore.getRoutineFiring("fire-issue-close")?.outcome).toEqual({
        action: "issue_closed",
        source: "gh",
        status: "success",
        summary: "Observed via GitHub state diff.",
        title: "Superseded dependency issue",
        url: "https://github.com/pmatos/alpha/issues/17",
        verified: true
      });
    } finally {
      runStore.close();
    }
  });

  it("logs and skips issue observation for a tracker-less Routine Host", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const logger = pino({ enabled: false });
    const logInfo = vi.spyOn(logger, "info");

    try {
      await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: quietProvider() },
        configDir: root,
        createFiringId: () => "fire-trackerless",
        globalConcurrency: { maxInFlight: undefined },
        githubIssuesApi: {
          listIssues: vi.fn().mockResolvedValue([]),
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        logger,
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
            "report-host",
            {
              agent: { provider: "codex" },
              disabled: false,
              mode: "routine_host",
              name: "report-host",
              routines: [
                {
                  kind: "report",
                  name: "daily-report",
                  prompt: "Report.",
                  projectName: "report-host",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md")
                }
              ],
              workspace: {
                git: {
                  base_branch: "main",
                  remote: "git@github.com:pmatos/alpha.git"
                },
                root: "./workspaces/report-host"
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

      expect(logInfo).toHaveBeenCalledWith(
        { project: "report-host", routine: "daily-report" },
        "symphonika routine issue observation skipped: tracker absent"
      );
      expect(runStore.getRoutineFiring("fire-trackerless")).toMatchObject({
        outcome: {
          action: "none",
          status: "no_action"
        },
        state: "succeeded"
      });
    } finally {
      runStore.close();
    }
  });

  it("keeps a successful firing terminal when email fails and persists only sanitized failure evidence", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const secret = "smtp-password-that-must-never-be-persisted";
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const claim = JSON.stringify({
      action: "none",
      status: "no_action",
      summary: "The report completed without an external action.",
      title: "Daily report",
      url: null
    });
    let logs = "";
    const logger = pino(
      { level: "trace" },
      new Writable({
        write(chunk: unknown, _encoding, callback) {
          logs += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
          callback();
        }
      })
    );
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: {
            message:
              "## Findings\n\n- **safe**\n- <script>alert('report')</script>",
            type: "message"
          },
          raw: { delta: "report output" }
        };
        yield {
          normalized: { message: claim, type: "message" },
          raw: { delta: claim }
        };
        yield {
          normalized: { result: claim, type: "turn_completed" },
          raw: { result: claim }
        };
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
        createFiringId: () => "fire-email-failed",
        env: { SMTP_TEST_PASSWORD: secret },
        globalConcurrency: { maxInFlight: undefined },
        logger,
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              return Promise.reject(
                new Error(`relay rejected credentials ${secret}`)
              );
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            smtpUsername: "server-token",
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
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
                  kind: "report",
                  name: "daily-report",
                  prompt: "Report.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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

      expect(delivered).toHaveLength(2);
      expect(delivered[0]?.text).toContain("## Findings");
      expect(delivered[0]?.text).toContain("⏭️  alpha — nothing to do");
      expect(delivered[0]?.text).not.toContain(claim);
      expect(delivered[0]?.html).toContain(
        "&lt;script&gt;alert(&#39;report&#39;)&lt;/script&gt;"
      );
      expect(JSON.stringify(delivered)).not.toContain(secret);
      expect(runStore.getRoutineFiring("fire-email-failed")).toMatchObject({
        notificationError: "relay rejected credentials [REDACTED]",
        notificationState: "failed",
        state: "succeeded",
        terminalReason: null
      });
      expect(logs).not.toContain(secret);
      const database = await readFile(path.join(stateRoot, "symphonika.db"));
      expect(database.includes(Buffer.from(secret))).toBe(false);
    } finally {
      runStore.close();
    }
  });

  it("releases the concurrency slot before notification delivery finishes", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const delivery = new Promise<void>(() => undefined);
    let recordSlotCount: ((count: number) => void) | undefined;
    const slotCountAtDeliveryStart = new Promise<number>((resolve) => {
      recordSlotCount = resolve;
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

    try {
      const dispatched = dispatchDueRoutines({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-slow-email",
        env: {},
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            async deliver() {
              recordSlotCount?.(activeRuns.countInFlightByProject("alpha"));
              await delivery;
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          }),
          timeoutMs: 5
        },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
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
                  kind: "report",
                  name: "daily-report",
                  prompt: "Report.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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

      // The slot must already be released by the time notification delivery
      // starts, so a stalled SMTP relay cannot suppress further dispatch for
      // this project (docs/adr/0067-smtp-notification-sink.md).
      expect(await slotCountAtDeliveryStart).toBe(0);
      await dispatched;
      expect(runStore.getRoutineFiring("fire-slow-email")).toMatchObject({
        notificationError: "notification delivery timed out after 5ms",
        notificationState: "failed",
        state: "succeeded"
      });
    } finally {
      runStore.close();
    }
  });

  it("resolves the email config at delivery time so a mid-firing reload applies", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const delivered: Array<{ to: string }> = [];
    let currentTo = "before-reload@example.com";
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        // Simulate a Service Config reload landing while this firing's
        // provider work is still in flight.
        currentTo = "after-reload@example.com";
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
        createFiringId: () => "fire-reload",
        env: {},
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: (config) => ({
            deliver() {
              delivered.push({ to: config.to });
              return Promise.resolve();
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: currentTo
          })
        },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
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
                  kind: "report",
                  name: "daily-report",
                  prompt: "Report.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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

      expect(delivered).toEqual([{ to: "after-reload@example.com" }]);
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
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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

  it("never launches the provider when an operator cancel lands during the pre-run GitHub snapshot", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const provider = quietProvider();
    const listIssues = vi.fn().mockImplementationOnce(async () => {
      // Simulates an operator cancel landing while the before-run GitHub
      // snapshot read is still in flight — after attachProvider, but before
      // the provider is actually launched.
      await activeRuns.requestCancel("fire-cancel-before-snapshot", "operator");
      return [];
    });

    try {
      await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine: {
            ...minuteRoutine(root),
            schedule: { at: "2026-05-22T10:00:00.000Z" }
          },
          runStore
        }),
        createFiringId: () => "fire-cancel-before-snapshot",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listIssues,
          listOpenIssues: vi.fn().mockResolvedValue([])
        }
      });

      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-cancel-before-snapshot",
          cancelReason: "operator",
          state: "cancelled"
        })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("reclassifies a succeeded kind: git firing as cancelled when an operator cancel lands during the after-run GitHub snapshot", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/01JCANCELAFTERSNAP";
    await createGitWorkspaceAhead({ branchName, workspacePath });
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
    const listPullRequestsForBranch = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        // Simulates an operator cancel landing while the after-run GitHub
        // snapshot read is still in flight — after the workspace was already
        // classified "succeeded" with commits ahead, but before that
        // classification is persisted.
        await activeRuns.requestCancel(
          "fire-cancel-after-snapshot",
          "operator"
        );
        return [];
      });
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
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-cancel-after-snapshot",
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
                  prompt: "Commit on {{branch.name}}.",
                  provider: null,
                  schedule: { at: "2026-05-22T10:00:00.000Z" },
                  sourcePath: path.join(root, "dependency-update.md"),
                  projectName: "alpha"
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

      expect(listPullRequestsForBranch).toHaveBeenCalledTimes(2);
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-cancel-after-snapshot",
          cancelReason: "operator",
          state: "cancelled",
          outcome: {
            action: "none",
            source: "symphonika",
            status: "error",
            summary: "cancelled",
            title: "",
            url: null,
            verified: false
          }
        })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("reclassifies a failed firing as cancelled when an operator cancel lands during the failure-path GitHub snapshot", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        throw new Error("provider process killed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const listIssues = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        // Simulates an operator cancel landing while the failure-path
        // after-snapshot GitHub read is still in flight — after `cancelled`
        // was already computed as false from the pre-await state.
        await activeRuns.requestCancel(
          "fire-cancel-during-failure-snapshot",
          "operator"
        );
        return [];
      });

    try {
      await dispatchDueRoutines({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine: {
            ...minuteRoutine(root),
            schedule: { at: "2026-05-22T10:00:00.000Z" }
          },
          runStore
        }),
        createFiringId: () => "fire-cancel-during-failure-snapshot",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listIssues,
          listOpenIssues: vi.fn().mockResolvedValue([])
        }
      });

      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-cancel-during-failure-snapshot",
          cancelReason: "operator",
          state: "cancelled",
          terminalReason: "cancelled"
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
    const project = {
      ...runStoreProjectFixture(),
      routines: [{ ...routine, projectName: "alpha" }]
    };
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
      runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
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
      runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
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
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
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
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
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
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
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
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
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
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
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
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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
              reason:
                missingFrom === "providers config"
                  ? "provider_command_missing: claude"
                  : "provider_not_registered: claude",
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
                  sourcePath: path.join(root, "daily-report.md"),
                  projectName: "alpha"
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
        sourcePath: path.join(root, "daily-report.md"),
        projectName: "alpha"
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
    mode: "dispatch" as const,
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
  routine: Omit<TargetedRoutineDeclaration, "projectName">;
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
      [
        "alpha",
        {
          ...runStoreProjectFixture(),
          routines: [{ ...input.routine, projectName: "alpha" }]
        }
      ]
    ]),
    providersConfig: {
      claude: { command: "claude fake" },
      codex: { command: "codex fake" }
    },
    runStore: input.runStore,
    stateRoot: path.join(input.root, ".symphonika")
  };
}
