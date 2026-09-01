import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RawGitHubIssue,
  RawGitHubPullRequest
} from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import { reconcileWatchdog } from "../src/lifecycle/watchdog.js";
import type {
  RunControllerProjectConfig,
  RunControllerProvidersConfig
} from "../src/lifecycle/run-controller.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type { NotificationMessage } from "../src/notifications/types.js";
import { NotificationDeliveryTracker } from "../src/notifications/delivery-tracker.js";
import {
  dispatchDueRoutines,
  fireRoutineNow,
  type DispatchDueRoutinesInput
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

const ROUTINE_OVERRIDE_COMMAND_TEMPLATE =
  "claude fake{{#model}} --model {{model}}{{/model}}{{#effort}} --effort {{effort}}{{/effort}}{{#permission_mode}} --permission-mode {{permission_mode}}{{/permission_mode}}";

const ROUTINE_EXECUTION_OVERRIDES = {
  effort: "xhigh",
  model: "{{effort}}",
  permissionMode: "bypass"
} as const;

async function dispatchDueRoutinesAndDrain(
  input: Omit<DispatchDueRoutinesInput, "notification"> & {
    notification?: Omit<
      NonNullable<DispatchDueRoutinesInput["notification"]>,
      "deliveries"
    >;
  }
) {
  const { notification, ...dispatchInput } = input;
  const deliveries = new NotificationDeliveryTracker();
  const result = await dispatchDueRoutines({
    ...dispatchInput,
    ...(notification === undefined
      ? {}
      : { notification: { ...notification, deliveries } })
  });
  await deliveries.settled();
  return result;
}

describe("RoutineFiringDispatcher", () => {
  it("manually fires a not-due Routine through the normal provider lifecycle", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const preparedWorkspace = {
      branchName: "main",
      branchRef: "refs/remotes/origin/main",
      cachePath: path.join(root, ".cache", "repo.git"),
      reused: false,
      workspacePath
    };
    let finishPreparation!: (value: PreparedRoutineWorkspace) => void;
    const preparation = new Promise<PreparedRoutineWorkspace>((resolve) => {
      finishPreparation = resolve;
    });
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
        prepareRoutineWorkspace: () => preparation,
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
      expect(runStore.getRoutineFiring("manual-fire")).toMatchObject({
        branchName: "main",
        branchRef: "refs/remotes/origin/main",
        state: "preparing_workspace",
        workspacePath: path.join(
          root,
          ".symphonika",
          "workspaces",
          "alpha",
          "routines",
          "daily-report",
          "manual-fire"
        )
      });
      finishPreparation(preparedWorkspace);
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
      const indexRecord = Buffer.alloc(16);
      indexRecord.writeBigUInt64BE(1n, 8);
      expect(
        await readFile(
          path.join(
            stateRoot,
            "logs",
            "routines",
            "manual-fire",
            "provider.normalized.jsonl.idx"
          )
        )
      ).toEqual(indexRecord);
      expect(activeRuns.countInFlight()).toBe(0);
    } finally {
      finishPreparation(preparedWorkspace);
      runStore.close();
    }
  });

  it("sends an SMTP notification for a manually-fired routine", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const provider = quietProvider();
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
    const delivered: NotificationMessage[] = [];
    const notificationDeliveries = new NotificationDeliveryTracker();

    try {
      const result = fireRoutineNow({
        activeRuns,
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "manual-fire-notify",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              return Promise.resolve();
            }
          }),
          deliveries: notificationDeliveries,
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          })
        },
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

      if (result.kind !== "accepted") {
        throw new Error("manual firing was not accepted");
      }
      await result.completion;
      await notificationDeliveries.settled();

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.subject).toContain("daily-report");
      expect(runStore.getRoutineFiring("manual-fire-notify")).toMatchObject({
        notificationState: "sent",
        state: "succeeded"
      });
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
        routineName: "daily-report",
        scheduledAt: "2026-05-23T10:00:00.000Z"
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

  it.each(["valid declaration", "recoverable invalid name"] as const)(
    "reclassifies a target restored through its %s while its Project remains disabled",
    async (restorationKind) => {
      const root = await makeTempRoot();
      const stateRoot = path.join(root, ".symphonika");
      const runStore = openRunStore({ stateRoot });
      const routine = {
        kind: "report" as const,
        name: "daily-report",
        prompt: "Report.",
        provider: null,
        schedule: { at: "2026-05-23T10:00:00.000Z" },
        sourcePath: path.join(root, "daily-report.md"),
        projectName: "alpha"
      };
      runStore.syncRoutines([routine], { projects: ["alpha"] });
      runStore.syncRoutines([], { projects: ["alpha"] });

      try {
        await dispatchDueRoutines({
          activeRuns: new ActiveRunRegistry(),
          agentProviders: { codex: quietProvider() },
          configDir: root,
          globalConcurrency: { maxInFlight: undefined },
          now: new Date("2026-05-22T10:00:01.000Z"),
          projects: new Map([
            [
              "alpha",
              {
                ...runStoreProjectFixture(),
                disabled: true,
                ...(restorationKind === "valid declaration"
                  ? { routines: [routine] }
                  : { invalidRoutineNames: [routine.name] })
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

        expect(runStore.listRoutines()).toEqual([]);
        expect(runStore.listRoutines({ includeInactive: true })).toContainEqual(
          expect.objectContaining({
            disabledReason: null,
            name: "daily-report",
            state: "inactive"
          })
        );
      } finally {
        runStore.close();
      }
    }
  );

  it("passes effective execution overrides without re-rendering resolved values", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const providerInputs: ProviderRunInput[] = [];
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "claude",
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
    const project = dueRoutineProjectFixture(root, "claude");
    project.routines = [
      {
        ...project.routines![0]!,
        ...ROUTINE_EXECUTION_OVERRIDES,
        timeoutMinutes: 60
      }
    ];

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { claude: provider },
        configDir: root,
        createFiringId: () => "fire-overrides",
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([["alpha", project]]),
        providersConfig: {
          claude: { command: ROUTINE_OVERRIDE_COMMAND_TEMPLATE },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(providerInputs).toHaveLength(1);
      expect(
        (
          providerInputs[0] as ProviderRunInput & {
            routine?: Record<string, unknown>;
          }
        ).routine
      ).toEqual(ROUTINE_EXECUTION_OVERRIDES);
      // Both provider entrypoints receive the same raw template and values so
      // each adapter renders once. In particular, the model's literal
      // {{effort}} bytes must not be parsed as a second template.
      expect(providerInputs[0]!.provider.command).toBe(
        ROUTINE_OVERRIDE_COMMAND_TEMPLATE
      );
      expect(provider.validate).toHaveBeenCalledWith(
        ROUTINE_OVERRIDE_COMMAND_TEMPLATE,
        ROUTINE_EXECUTION_OVERRIDES
      );
    } finally {
      runStore.close();
    }
  });

  it("rejects a routine command whose resolved overrides fail provider validation", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = {
      ...quietProvider(),
      name: "claude",
      // Rejecting only the raw template paired with the resolved overrides is
      // what makes this a regression test: an unconditional rejection would
      // pass even if the dispatcher dropped the values.
      validate: vi.fn(
        (command: string, values?: ProviderRunInput["routine"]) =>
          command === ROUTINE_OVERRIDE_COMMAND_TEMPLATE &&
          values?.effort === ROUTINE_EXECUTION_OVERRIDES.effort &&
          values.model === ROUTINE_EXECUTION_OVERRIDES.model &&
          values.permissionMode === ROUTINE_EXECUTION_OVERRIDES.permissionMode
            ? Promise.reject(new Error("unsupported routine command"))
            : Promise.resolve()
      )
    } satisfies AgentProvider;
    const project = dueRoutineProjectFixture(root, "claude");
    project.routines = [
      {
        ...project.routines![0]!,
        ...ROUTINE_EXECUTION_OVERRIDES
      }
    ];

    try {
      await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { claude: provider },
        configDir: root,
        createFiringId: () => "fire-invalid-overrides",
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([["alpha", project]]),
        providersConfig: {
          claude: { command: ROUTINE_OVERRIDE_COMMAND_TEMPLATE },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(runStore.getRoutineFiring("fire-invalid-overrides")).toMatchObject(
        {
          state: "failed",
          terminalReason: "unsupported routine command"
        }
      );
      expect(provider.runAttempt).not.toHaveBeenCalled();
    } finally {
      runStore.close();
    }
  });

  it("terminates a firing at its wall-clock deadline and records firing_timeout", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    let releaseProvider!: () => void;
    let providerCancelled = false;
    const providerWait = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const fallback = setTimeout(releaseProvider, 500);
    const provider = {
      cancel: vi.fn((runId: string) => {
        expect(runId).toBe("fire-timeout");
        providerCancelled = true;
        releaseProvider();
        return Promise.resolve();
      }),
      name: "claude",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await providerWait;
        yield {
          normalized: {
            cancelled: providerCancelled,
            exitCode: providerCancelled ? null : 0,
            signal: providerCancelled ? "SIGTERM" : null,
            type: "process_exit"
          },
          raw: { kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const project = dueRoutineProjectFixture(root, "claude");
    project.routines = [
      {
        ...project.routines![0]!,
        timeoutMinutes: 0.001
      }
    ];

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { claude: provider },
        configDir: root,
        createFiringId: () => "fire-timeout",
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([["alpha", project]]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(provider.cancel).toHaveBeenCalledOnce();
      expect(runStore.getRoutineFiring("fire-timeout")).toMatchObject({
        state: "failed",
        terminalReason: "firing_timeout"
      });
    } finally {
      clearTimeout(fallback);
      releaseProvider();
      runStore.close();
    }
  });

  it("keeps firing_timeout when the Watchdog latches no_progress on the same firing concurrently", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    let releaseProvider!: () => void;
    let providerCancelled = false;
    const providerWait = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const fallback = setTimeout(releaseProvider, 500);
    const provider = {
      // A real Watchdog pass would also call activeRuns.requestCancel, which
      // re-invokes this same closure through the active-run registry — that
      // would recurse here, so only the durable half of the race (the latch
      // write) is simulated. It's the half completeRoutineFiring actually
      // reads, and is enough to prove the deadline verdict still wins the
      // terminal reason even though cancel_reason ends up "no_progress" too
      // (ADR 0067 vs. ADR 0091).
      cancel: vi.fn((runId: string) => {
        expect(runId).toBe("fire-timeout-latched");
        providerCancelled = true;
        expect(
          runStore.markRoutineFiringWatchdogNoProgress("fire-timeout-latched")
        ).toBe(true);
        releaseProvider();
        return Promise.resolve();
      }),
      name: "claude",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await providerWait;
        yield {
          normalized: {
            cancelled: providerCancelled,
            exitCode: providerCancelled ? null : 0,
            signal: providerCancelled ? "SIGTERM" : null,
            type: "process_exit"
          },
          raw: { kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const project = dueRoutineProjectFixture(root, "claude");
    project.routines = [
      {
        ...project.routines![0]!,
        timeoutMinutes: 0.001
      }
    ];

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { claude: provider },
        configDir: root,
        createFiringId: () => "fire-timeout-latched",
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([["alpha", project]]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(provider.cancel).toHaveBeenCalledOnce();
      expect(runStore.getRoutineFiring("fire-timeout-latched")).toMatchObject({
        cancelReason: "no_progress",
        cancelRequested: true,
        state: "failed",
        terminalReason: "firing_timeout"
      });
    } finally {
      clearTimeout(fallback);
      releaseProvider();
      runStore.close();
    }
  });

  it("hands the provider a stderr evidence path and quotes its tail in the terminal reason", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    let handedStderrLogPath: string | undefined;
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        handedStderrLogPath = input.stderrLogPath;
        // Stands in for the real adapter's tee: the dispatcher only supplies
        // the path, the provider is what puts bytes at it.
        await writeFile(
          input.stderrLogPath!,
          "codex: upstream connect error\n",
          "utf8"
        );
        yield {
          normalized: { exitCode: 1, type: "process_exit" },
          raw: { kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const project = dueRoutineProjectFixture(root, "codex");

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-stderr",
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([["alpha", project]]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(handedStderrLogPath).toBe(
        path.join(
          stateRoot,
          "logs",
          "routines",
          "fire-stderr",
          "provider.stderr.log"
        )
      );
      expect(runStore.getRoutineFiring("fire-stderr")).toMatchObject({
        state: "failed",
        terminalReason: "process_exit_1 (stderr: codex: upstream connect error)"
      });
    } finally {
      runStore.close();
    }
  });

  it("aborts and settles workspace preparation before completing a timed-out firing", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const logger = pino({ enabled: false });
    const logWarn = vi.spyOn(logger, "warn");
    const project = dueRoutineProjectFixture(root, "codex");
    project.routines = [
      {
        ...project.routines![0]!,
        timeoutMinutes: 0.001
      }
    ];
    let preparationSettled = false;
    const prepareRoutineWorkspace = vi.fn(
      (input: PrepareRoutineWorkspaceInput): Promise<never> =>
        new Promise((_resolve, reject) => {
          const signal = input.signal;
          signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                preparationSettled = true;
                reject(
                  Object.assign(
                    new Error(
                      "failed to clean repository cache staging directory"
                    ),
                    { name: "WorkspacePreparationCleanupError" }
                  )
                );
              }, 10);
            },
            { once: true }
          );
        })
    );

    try {
      await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-workspace-timeout",
        globalConcurrency: { maxInFlight: undefined },
        logger,
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace,
        projects: new Map([["alpha", project]]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(prepareRoutineWorkspace).toHaveBeenCalledOnce();
      expect(preparationSettled).toBe(true);
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: "failed to clean repository cache staging directory",
          firing: "fire-workspace-timeout"
        }),
        "symphonika timed-out routine workspace cleanup failed"
      );
      expect(runStore.getRoutineFiring("fire-workspace-timeout")).toMatchObject(
        {
          state: "failed",
          terminalReason: "firing_timeout"
        }
      );
    } finally {
      runStore.close();
    }
  });

  it("terminates a firing at its wall-clock deadline when the pre-run GitHub snapshot read hangs", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const listIssues = vi.fn(
      () =>
        new Promise<never>(() => {
          // Never resolves: the deadline race, not this call, must end the
          // firing.
        })
    );
    const project = dueRoutineProjectFixture(root, "codex");
    project.routines = [
      {
        ...project.routines![0]!,
        timeoutMinutes: 0.001
      }
    ];

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-snapshot-timeout",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listIssues,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: () =>
          Promise.resolve({
            branchName: "main",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", "repo.git"),
            reused: false,
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([["alpha", project]]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(runStore.getRoutineFiring("fire-snapshot-timeout")).toMatchObject({
        state: "failed",
        terminalReason: "firing_timeout"
      });
    } finally {
      runStore.close();
    }
  });

  it("fires every target from one clock event with a shared fan-out id and one grouped notification", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const firingIds = ["fire-alpha", "fire-beta"];
    const delivered: NotificationMessage[] = [];
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
    const declaration = {
      kind: "report" as const,
      name: "refactor-audit",
      prompt: "Audit {{project.name}}.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: path.join(root, "refactor-audit.md")
    };

    try {
      const result = await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-1",
        createFiringId: () => firingIds.shift()!,
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: ({ project }) =>
          Promise.resolve({
            branchName: "",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", `${project.name}.git`),
            reused: false,
            workspacePath: path.join(root, "workspaces", project.name)
          }),
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              name: "alpha",
              routines: [{ ...declaration, projectName: "alpha" }]
            }
          ],
          [
            "beta",
            {
              ...runStoreProjectFixture(),
              name: "beta",
              routines: [{ ...declaration, projectName: "beta" }]
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

      expect(result.fired).toEqual(["fire-alpha", "fire-beta"]);
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          fanoutId: "fanout-1",
          id: "fire-beta",
          projectName: "beta",
          state: "succeeded"
        }),
        expect.objectContaining({
          fanoutId: "fanout-1",
          id: "fire-alpha",
          projectName: "alpha",
          state: "succeeded"
        })
      ]);
      // Each firing's own per-firing notification is delivered in addition
      // to the one grouped fan-out summary — under on: "always" both send
      // (see ADR 0072); the default "changes" policy is what usually keeps
      // this from doubling up in practice for a quiet report firing.
      expect(delivered).toHaveLength(3);
      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(runStore.getRoutineFanout("fanout-1")).toMatchObject({
        notificationState: "sent",
        routineName: "refactor-audit",
        targets: [
          expect.objectContaining({ projectName: "alpha" }),
          expect.objectContaining({ projectName: "beta" })
        ]
      });
      expect(fanoutMessages[0]?.subject).toBe(
        "[ptt] refactor-audit — 0 PR, 0 issue, 0 failed"
      );
      expect(fanoutMessages[0]?.text).toContain("- alpha: succeeded");
      expect(fanoutMessages[0]?.text).toContain("- beta: succeeded");
    } finally {
      runStore.close();
    }
  });

  it("keeps an in-flight summary immutable and catch-up-skips a target configured after fan-out creation", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const declaration = {
      kind: "report" as const,
      name: "refactor-audit",
      prompt: "Audit {{project.name}}.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: path.join(root, "refactor-audit.md")
    };
    const notification = {
      createSink: () => ({
        deliver(message: NotificationMessage) {
          delivered.push(message);
          // Simulate a re-entrant reload (ADR 0052) adding a Project to this
          // Routine while this notification is already in flight. The
          // original clock event's expected membership is immutable, so beta
          // must not join this fan-out. Keyed on the fan-out summary's
          // subject (not just "the first delivery") since this routine's own
          // per-firing notification is now also delivered through this sink.
          if (message.subject.startsWith("[ptt]")) {
            runStore.syncRoutines([
              { ...declaration, projectName: "alpha" },
              { ...declaration, projectName: "beta" }
            ]);
            runStore.ensureRoutineFanout({
              id: "fanout-1-ignored-because-already-exists",
              projectNames: ["alpha", "beta"],
              routineName: "refactor-audit",
              scheduledAt: "2026-05-22T10:00:00.000Z"
            });
            expect(
              runStore.hasRoutineFanoutTarget({
                id: "fanout-1",
                projectName: "beta"
              })
            ).toBe(false);
          }
          return Promise.resolve();
        }
      }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always" as const,
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls" as const,
        to: "operator@example.com"
      })
    };
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
      const result = await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-1",
        createFiringId: () => "fire-alpha",
        globalConcurrency: { maxInFlight: undefined },
        notification,
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: ({ project }) =>
          Promise.resolve({
            branchName: "",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", `${project.name}.git`),
            reused: false,
            workspacePath: path.join(root, "workspaces", project.name)
          }),
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              name: "alpha",
              routines: [{ ...declaration, projectName: "alpha" }]
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

      expect(result.fired).toEqual(["fire-alpha"]);
      expect(
        delivered.filter((message) => message.subject.startsWith("[ptt]"))
      ).toHaveLength(1);

      // beta was configured after this clock event began, so the alpha-only
      // fan-out is delivered exactly once and remains immutable.
      expect(runStore.getRoutineFanout("fanout-1")).toMatchObject({
        notificationState: "sent",
        targets: [
          expect.objectContaining({
            disposition: "firing",
            projectName: "alpha"
          })
        ]
      });

      // On the next tick the newly configured, already-overdue one-shot is
      // consumed as an ungrouped catch-up skip rather than firing into the
      // completed event or remaining due forever.
      const lateTick = await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-1-unused",
        createFiringId: () => "fire-beta-must-not-run",
        globalConcurrency: { maxInFlight: undefined },
        notification,
        now: new Date("2026-05-22T10:05:00.000Z"),
        prepareRoutineWorkspace: ({ project }) =>
          Promise.resolve({
            branchName: "",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", `${project.name}.git`),
            reused: false,
            workspacePath: path.join(root, "workspaces", project.name)
          }),
        projects: new Map([
          [
            "alpha",
            {
              ...runStoreProjectFixture(),
              name: "alpha",
              routines: [{ ...declaration, projectName: "alpha" }]
            }
          ],
          [
            "beta",
            {
              ...runStoreProjectFixture(),
              name: "beta",
              routines: [{ ...declaration, projectName: "beta" }]
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

      expect(lateTick.fired).toEqual([]);
      expect(lateTick.skipped).toContainEqual({
        projectName: "beta",
        reason: "catch_up_window",
        routineName: "refactor-audit"
      });
      expect(
        delivered.filter((message) => message.subject.startsWith("[ptt]"))
      ).toHaveLength(1);
      expect(runStore.listRoutines({ project: "beta" })[0]).toMatchObject({
        lastSkipReason: "catch_up_window",
        state: "expired"
      });
    } finally {
      runStore.close();
    }
  });

  it("defers a capped fan-out target and completes the group once capacity frees", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const notification = {
      createSink: () => ({
        deliver(message: NotificationMessage) {
          delivered.push(message);
          return Promise.resolve();
        }
      }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always" as const,
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls" as const,
        to: "operator@example.com"
      })
    };
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
    const declaration = {
      kind: "report" as const,
      name: "refactor-audit",
      prompt: "Audit.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: path.join(root, "refactor-audit.md")
    };

    const dispatchInput = {
      activeRuns: new ActiveRunRegistry(),
      agentProviders: { codex: provider },
      configDir: root,
      createFanoutId: () => "fanout-cap",
      globalConcurrency: { maxInFlight: 1 },
      notification,
      prepareRoutineWorkspace: ({ project }: { project: { name: string } }) =>
        Promise.resolve({
          branchName: "",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", `${project.name}.git`),
          reused: false,
          workspacePath: path.join(root, "workspaces", project.name)
        }),
      projects: new Map([
        [
          "alpha",
          {
            ...runStoreProjectFixture(),
            name: "alpha",
            routines: [{ ...declaration, projectName: "alpha" }]
          }
        ],
        [
          "beta",
          {
            ...runStoreProjectFixture(),
            name: "beta",
            routines: [{ ...declaration, projectName: "beta" }]
          }
        ]
      ]),
      providersConfig: {
        claude: { command: "claude fake" },
        codex: { command: "codex fake" }
      },
      runStore,
      stateRoot
    };

    try {
      const result = await dispatchDueRoutinesAndDrain({
        ...dispatchInput,
        createFiringId: () => "fire-alpha",
        now: new Date("2026-05-22T10:00:01.000Z")
      });

      expect(result.fired).toEqual(["fire-alpha"]);
      expect(result.deferred).toContainEqual({
        projectName: "beta",
        reason: "concurrency_cap",
        routineName: "refactor-audit"
      });
      expect(result.skipped).toEqual([]);
      // The group is not finished while a leg is still waiting for a slot,
      // so no summary has been sent yet (ADR 0093).
      expect(
        delivered.filter((message) => message.subject.startsWith("[ptt]"))
      ).toHaveLength(0);
      expect(
        runStore.getRoutineFanout("fanout-cap")?.targets.map((target) => ({
          deferredReason: target.deferredReason,
          disposition: target.disposition,
          projectName: target.projectName,
          skipReason: target.skipReason
        }))
      ).toEqual([
        {
          deferredReason: null,
          disposition: "firing",
          projectName: "alpha",
          skipReason: null
        },
        {
          deferredReason: "concurrency_cap",
          disposition: "pending",
          projectName: "beta",
          skipReason: null
        }
      ]);
      expect(runStore.listRoutines({ project: "beta" })[0]).toMatchObject({
        deferral: { attempts: 1, reason: "concurrency_cap" },
        lastSkipReason: null,
        state: "active"
      });

      const retry = await dispatchDueRoutinesAndDrain({
        ...dispatchInput,
        createFiringId: () => "fire-beta",
        now: new Date("2026-05-22T10:00:31.000Z")
      });

      expect(retry.fired).toEqual(["fire-beta"]);
      expect(retry.deferred).toEqual([]);
      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(fanoutMessages[0]?.subject).toContain("0 failed");
      expect(
        runStore.getRoutineFanout("fanout-cap")?.targets.map((target) => ({
          disposition: target.disposition,
          projectName: target.projectName
        }))
      ).toEqual([
        { disposition: "firing", projectName: "alpha" },
        { disposition: "firing", projectName: "beta" }
      ]);
      expect(runStore.listRoutines({ project: "beta" })[0]).toMatchObject({
        deferral: null,
        state: "expired"
      });
    } finally {
      runStore.close();
    }
  });

  it("records a capped fan-out target as a failed run once its clock event lapses", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const notification = {
      createSink: () => ({
        deliver(message: NotificationMessage) {
          delivered.push(message);
          return Promise.resolve();
        }
      }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always" as const,
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls" as const,
        to: "operator@example.com"
      })
    };
    const activeRuns = new ActiveRunRegistry();
    activeRuns.reserveSlot({
      issueNumber: 42,
      projectName: "alpha",
      respectsIssueLabels: true,
      runId: "issue-run"
    });
    const provider = quietProvider();
    const routine = minuteRoutine(root);
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });

    try {
      const deferredResult = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        createFanoutId: () => "fanout-missed",
        notification
      });

      expect(deferredResult.deferred).toHaveLength(1);
      expect(delivered).toHaveLength(0);

      // The next clock event supersedes the parked one, so the wait ends as
      // a run that never happened rather than as a silent skip.
      const missedResult = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        createFanoutId: () => "fanout-missed",
        notification,
        now: new Date("2026-05-22T10:01:00.000Z")
      });

      expect(missedResult.fired).toEqual([]);
      expect(missedResult.missed).toEqual([
        {
          projectName: "alpha",
          reason: "concurrency_cap",
          routineName: "minute-report"
        }
      ]);
      expect(runStore.listRoutineFirings()).toEqual([]);
      const fanout = runStore.getRoutineFanout("fanout-missed");
      expect(fanout?.failureCount).toBe(1);
      expect(fanout?.targets[0]).toMatchObject({
        deferredAttempts: 1,
        disposition: "missed",
        skipReason: "concurrency_cap"
      });
      const message = delivered.find((entry) =>
        entry.subject.startsWith("[ptt]")
      );
      expect(message?.subject).toContain("1 failed");
      expect(message?.text).toContain(
        "- alpha: did not run (concurrency_cap) after 1 admission attempt"
      );
      expect(
        runStore.listRoutines({ now: new Date("2026-05-22T10:01:00.000Z") })[0]
      ).toMatchObject({
        deferral: null,
        lastSkipReason: "concurrency_cap",
        // The event that ended the wait had no admission attempt of its own,
        // so the clock lands on it rather than jumping past it — one lost
        // run must not silently cost two (ADR 0093).
        nextFireAt: "2026-05-22T10:01:00.000Z",
        skipCounts24h: { concurrency_cap: 1 }
      });

      activeRuns.unregister("issue-run");
      const successor = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        notification,
        now: new Date("2026-05-22T10:01:30.000Z")
      });

      expect(successor.fired).toEqual(["new-fire"]);
    } finally {
      activeRuns.unregister("issue-run");
      runStore.close();
    }
  });

  it("summarizes a provider-held target without losing its later retry", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    let runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const notification = {
      createSink: () => ({
        deliver(message: NotificationMessage) {
          delivered.push(message);
          return Promise.resolve();
        }
      }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always" as const,
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls" as const,
        to: "operator@example.com"
      })
    };
    const codexProvider = {
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
    const ompProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "omp",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const declaration = {
      kind: "report" as const,
      name: "refactor-audit",
      prompt: "Audit.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: path.join(root, "refactor-audit.md")
    };
    const firingIds = ["fire-alpha", "fire-beta"];
    const projects = new Map([
      [
        "alpha",
        {
          ...runStoreProjectFixture(),
          name: "alpha",
          routines: [{ ...declaration, projectName: "alpha" }]
        }
      ],
      [
        "beta",
        {
          ...runStoreProjectFixture(),
          name: "beta",
          routines: [
            { ...declaration, projectName: "beta", provider: "omp" as const }
          ]
        }
      ]
    ]);

    try {
      // Tick 1: "omp" is not registered yet. Alpha succeeds; beta remains
      // due and retryable, but its durable hold no longer prevents the
      // operator from receiving the otherwise-complete grouped summary.
      const tickOne = await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: codexProvider },
        configDir: root,
        createFanoutId: () => "fanout-provider-gap",
        createFiringId: () => firingIds.shift()!,
        globalConcurrency: { maxInFlight: undefined },
        notification,
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace: ({ project }) =>
          Promise.resolve({
            branchName: "",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", `${project.name}.git`),
            reused: false,
            workspacePath: path.join(root, "workspaces", project.name)
          }),
        projects,
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(tickOne.fired).toEqual(["fire-alpha"]);
      expect(tickOne.skipped).toContainEqual({
        projectName: "beta",
        reason: "provider_not_registered: omp",
        routineName: "refactor-audit"
      });
      const firstFanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(firstFanoutMessages).toHaveLength(1);
      expect(firstFanoutMessages[0]?.subject).toBe(
        "[ptt] refactor-audit — 0 PR, 0 issue, 1 failed"
      );
      expect(firstFanoutMessages[0]?.text).toContain("- alpha: succeeded");
      expect(firstFanoutMessages[0]?.text).toContain(
        "- beta: held (provider_not_registered: omp)"
      );
      expect(runStore.getRoutineFanout("fanout-provider-gap")?.targets).toEqual(
        [
          expect.objectContaining({
            disposition: "firing",
            projectName: "alpha"
          }),
          expect.objectContaining({
            disposition: "held",
            holdReason: "provider_not_registered: omp",
            projectName: "beta"
          })
        ]
      );
      // Untouched: still active and due, so it retries on the next tick.
      expect(runStore.listRoutines({ project: "beta" })[0]).toMatchObject({
        lastSkipReason: null,
        state: "active"
      });

      // The hold and its claimability are durable daemon-restart state.
      runStore.close();
      runStore = openRunStore({ stateRoot });

      // Tick 2: the operator registers "omp". The same fan-out (matched on
      // routine name + scheduled_at) is reused and beta is finally claimed.
      // The one-shot grouped summary is not amended after delivery.
      const tickTwo = await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: codexProvider, omp: ompProvider },
        configDir: root,
        createFanoutId: () => "fanout-provider-gap-unused",
        createFiringId: () => firingIds.shift()!,
        globalConcurrency: { maxInFlight: undefined },
        notification,
        now: new Date("2026-05-22T10:05:00.000Z"),
        prepareRoutineWorkspace: ({ project }) =>
          Promise.resolve({
            branchName: "",
            branchRef: "refs/remotes/origin/main",
            cachePath: path.join(root, ".cache", `${project.name}.git`),
            reused: false,
            workspacePath: path.join(root, "workspaces", project.name)
          }),
        projects,
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" },
          omp: { command: "omp fake" }
        },
        runStore,
        stateRoot
      });

      expect(tickTwo.fired).toEqual(["fire-beta"]);
      expect(runStore.getRoutineFiring("fire-beta")).toMatchObject({
        scheduledAt: "2026-05-22T10:00:00.000Z",
        state: "succeeded"
      });
      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(
        runStore
          .getRoutineFanout("fanout-provider-gap")
          ?.targets.map((target) => ({
            disposition: target.disposition,
            projectName: target.projectName
          }))
      ).toEqual([
        { disposition: "firing", projectName: "alpha" },
        { disposition: "firing", projectName: "beta" }
      ]);
      expect(fanoutMessages[0]?.text).toContain("- alpha: succeeded");
      expect(fanoutMessages[0]?.text).toContain(
        "- beta: held (provider_not_registered: omp)"
      );
    } finally {
      runStore.close();
    }
  });

  it("persists a dispatched firing's execution-time kind across a later declaration edit", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/01JABCDEFG";
    await createGitWorkspaceAtBase({ branchName, workspacePath });
    const runStore = openRunStore({ stateRoot });
    const declaration = {
      kind: "git" as const,
      name: "dependency-update",
      projectName: "alpha",
      prompt: "Update dependencies.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: path.join(root, "dependency-update.md")
    };

    try {
      await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: quietProvider() },
        configDir: root,
        createFiringId: () => "fire-kind-snapshot",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listOpenIssues: vi.fn().mockResolvedValue([]),
          listPullRequestsForBranch: vi.fn().mockResolvedValue([])
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
          ["alpha", { ...runStoreProjectFixture(), routines: [declaration] }]
        ]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(runStore.getRoutineFiring("fire-kind-snapshot")).toEqual(
        expect.objectContaining({
          branchRef: `refs/heads/${branchName}`,
          kind: "git"
        })
      );

      runStore.syncRoutines([
        { ...declaration, kind: "report", provider: "codex" }
      ]);

      expect(runStore.getRoutineFiring("fire-kind-snapshot")?.kind).toBe("git");
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
      await dispatchDueRoutinesAndDrain({
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
          commitsAhead: true,
          id: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          branchName,
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
          scheduledAt: "2026-05-22T10:00:00.000Z",
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

  it("observes a pull request that was opened and closed within the same firing", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/01JCLOSEDPR";
    await createGitWorkspaceAhead({ branchName, workspacePath });
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
    const listPullRequestsForBranch = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          head: { ref: branchName, sha: "abc123" },
          html_url: "https://github.com/pmatos/alpha/pull/17",
          number: 17,
          state: "closed",
          title: "Extract retry policy"
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-closed-pr-observed",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listOpenIssues: vi.fn().mockResolvedValue([]),
          listPullRequestsForBranch
        },
        globalConcurrency: { maxInFlight: undefined },
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

      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-closed-pr-observed",
          outcome: {
            action: "pr",
            source: "gh",
            status: "success",
            summary: "Observed via GitHub state diff.",
            title: "Extract retry policy",
            url: "https://github.com/pmatos/alpha/pull/17",
            verified: true
          },
          // The closed PR is observed for the outcome diff above, but a
          // closed PR is still correctly excluded from the separate
          // Routine Pull Request follow-up association.
          pullRequests: [],
          state: "succeeded"
        })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("keeps a succeeded git firing non-terminal until PR discovery finishes, so the fan-out summary is not sent early", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/01JDISCOVERYRACE";
    await createGitWorkspaceAhead({ branchName, workspacePath });
    const runStore = openRunStore({ stateRoot });

    let releasePullRequests: (
      pullRequests: RawGitHubPullRequest[]
    ) => void = () => {};
    const discoveryGate = new Promise<RawGitHubPullRequest[]>((resolve) => {
      releasePullRequests = resolve;
    });
    const listPullRequestsForBranch = vi.fn(() => discoveryGate);

    const delivered: NotificationMessage[] = [];
    const notificationDeliveries = new NotificationDeliveryTracker();
    const notification = {
      createSink: () => ({
        deliver(message: NotificationMessage) {
          delivered.push(message);
          return Promise.resolve();
        }
      }),
      deliveries: notificationDeliveries,
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always" as const,
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls" as const,
        to: "operator@example.com"
      })
    };
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
          branchName,
          branchRef: `refs/heads/${branchName}`,
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    );

    try {
      const dispatchPromise = dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-race",
        createFiringId: () => "fire-race",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listOpenIssues: vi.fn().mockResolvedValue([]),
          listPullRequestsForBranch
        },
        globalConcurrency: { maxInFlight: undefined },
        logger: pino({ enabled: false }),
        notification,
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

      // The provider has finished and PR discovery has started, but is
      // blocked on discoveryGate: the firing must not be terminal yet, and
      // the fan-out (whose only target is this firing) must not be ready.
      await vi.waitFor(() => {
        expect(listPullRequestsForBranch).toHaveBeenCalled();
      });
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({ id: "fire-race", state: "running" })
      ]);
      expect(runStore.listReadyRoutineFanouts()).toEqual([]);
      expect(delivered).toHaveLength(0);

      releasePullRequests([
        { head: { ref: branchName, sha: "abc123" }, number: 42, state: "open" }
      ]);
      await dispatchPromise;
      await notificationDeliveries.settled();

      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-race",
          pullRequests: [expect.objectContaining({ prNumber: 42 })],
          state: "succeeded"
        })
      ]);
      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(fanoutMessages[0]?.subject).toBe(
        "[ptt] dependency-update — 1 PR, 0 issue, 0 failed"
      );
    } finally {
      runStore.close();
    }
  });

  it("leaves the fan-out summary pending when no notification wiring is provided", async () => {
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-no-wiring",
        createFiringId: () => "fire-no-wiring",
        globalConcurrency: { maxInFlight: undefined },
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

      // No wiring at all means "not configured yet", not a policy decision:
      // the fan-out must stay pending so a later reload/restart can still
      // pick it up (ADR 0069/0072), never "skipped".
      expect(runStore.getRoutineFanout("fanout-no-wiring")).toMatchObject({
        notificationState: "pending"
      });
      expect(runStore.listReadyRoutineFanouts()).toEqual([
        expect.objectContaining({ id: "fanout-no-wiring" })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("leaves the fan-out summary pending when no email: block is configured", async () => {
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-no-config",
        createFiringId: () => "fire-no-config",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({ deliver: () => Promise.resolve() }),
          resolveConfig: () => undefined
        },
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

      expect(runStore.getRoutineFanout("fanout-no-config")).toMatchObject({
        notificationState: "pending"
      });
      expect(runStore.listReadyRoutineFanouts()).toEqual([
        expect.objectContaining({ id: "fanout-no-config" })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("records a policy-skipped fan-out when email.sources.routine_fanouts is disabled", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-source-muted",
        createFiringId: () => "fire-source-muted",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            sources: {
              daemonHealth: true,
              issueRuns: true,
              routineFanouts: false,
              routineFirings: true
            },
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

      expect(
        delivered.filter((message) => message.subject.startsWith("[ptt]"))
      ).toHaveLength(0);
      expect(runStore.getRoutineFanout("fanout-source-muted")).toMatchObject({
        notificationState: "skipped"
      });
      // A policy-suppressed group is terminal, not retried forever.
      expect(runStore.listReadyRoutineFanouts()).toEqual([]);
    } finally {
      runStore.close();
    }
  });

  it("records a policy-skipped fan-out when the routine declaration sets notify: false", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-notify-false",
        createFiringId: () => "fire-notify-false",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
                  notify: false,
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

      // notify: false is uniform across every target of a fan-out (it lives
      // on the shared RoutineDeclaration), so it mutes both the per-firing
      // and the grouped notification — the sink is never touched at all.
      expect(delivered).toHaveLength(0);
      expect(runStore.getRoutineFanout("fanout-notify-false")).toMatchObject({
        notificationState: "skipped"
      });
      expect(runStore.listReadyRoutineFanouts()).toEqual([]);
    } finally {
      runStore.close();
    }
  });

  it("resolves notifyEnabled from the fan-out's own target, not an unrelated stale routine sharing its name", async () => {
    // Routine names are unique only per (project_name, name): a routine
    // removed from config is soft-disabled (or, via project-cascade,
    // inactivated), never deleted, so its row can persist with a stale
    // notify value while an unrelated later declaration reuses the same
    // name elsewhere. "aaa-stale" sorts before "zzz-active" so an unscoped
    // name-only lookup would incorrectly resolve notify from the stale row.
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const declaration = {
      kind: "report" as const,
      name: "shared-name",
      prompt: "Report.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: "/tmp/shared-name.md"
    };
    // Seed a stale, unrelated routine of the same name in a different,
    // alphabetically-earlier project, with notify explicitly disabled, then
    // never mention that project again — dispatchDueRoutines's own
    // pruneRoutinesForUnknownProjects call (driven by the `projects` map
    // below, which omits it) inactivates it without deleting the row.
    runStore.syncRoutines([
      { ...declaration, notify: false, projectName: "aaa-stale" }
    ]);
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-name-reuse",
        createFiringId: () => "fire-name-reuse",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            workspacePath: path.join(root, "workspace")
          }),
        projects: new Map([
          [
            "zzz-active",
            {
              ...runStoreProjectFixture(),
              name: "zzz-active",
              routines: [{ ...declaration, projectName: "zzz-active" }]
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

      // Sanity check the reproduction setup: the stale row is inactivated
      // but still present and still carries its old notify: false.
      expect(
        runStore.listRoutines({ includeInactive: true, project: "aaa-stale" })
      ).toContainEqual(
        expect.objectContaining({
          name: "shared-name",
          notify: false,
          state: "inactive"
        })
      );
      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(runStore.getRoutineFanout("fanout-name-reuse")).toMatchObject({
        notificationState: "sent"
      });
    } finally {
      runStore.close();
    }
  });

  it("skips the fan-out summary under on: failures when the group has no failures", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-no-failures",
        createFiringId: () => "fire-no-failures",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              return Promise.resolve();
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "failures",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
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

      expect(
        delivered.filter((message) => message.subject.startsWith("[ptt]"))
      ).toHaveLength(0);
      expect(runStore.getRoutineFanout("fanout-no-failures")).toMatchObject({
        notificationState: "skipped"
      });
    } finally {
      runStore.close();
    }
  });

  it("sends the fan-out summary under on: failures when a target failed", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { message: "crashing", type: "message" },
          raw: { delta: "crashing" }
        };
        throw new Error("provider crashed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-with-failure",
        createFiringId: () => "fire-with-failure",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              return Promise.resolve();
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "failures",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
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

      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(fanoutMessages[0]?.subject).toBe(
        "[ptt] daily-report — 0 PR, 0 issue, 1 failed"
      );
      expect(runStore.getRoutineFanout("fanout-with-failure")).toMatchObject({
        notificationState: "sent"
      });
    } finally {
      runStore.close();
    }
  });

  it("skips the fan-out summary under the default changes policy when nothing changed", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-no-changes",
        createFiringId: () => "fire-no-changes",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              return Promise.resolve();
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "changes",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
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

      // No failures, no PRs, no issues: the group has nothing to report.
      expect(
        delivered.filter((message) => message.subject.startsWith("[ptt]"))
      ).toHaveLength(0);
      expect(runStore.getRoutineFanout("fanout-no-changes")).toMatchObject({
        notificationState: "skipped"
      });
    } finally {
      runStore.close();
    }
  });

  it("sends the fan-out summary under the default changes policy when a pull request was discovered", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/01JCHANGESPOLICY";
    await createGitWorkspaceAhead({ branchName, workspacePath });
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
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
      .mockResolvedValueOnce([
        { head: { ref: branchName, sha: "abc123" }, number: 7, state: "open" }
      ]);

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-changes-pr",
        createFiringId: () => "fire-changes-pr",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listOpenIssues: vi.fn().mockResolvedValue([]),
          listPullRequestsForBranch
        },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              return Promise.resolve();
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "changes",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          })
        },
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

      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(fanoutMessages[0]?.subject).toBe(
        "[ptt] dependency-update — 1 PR, 0 issue, 0 failed"
      );
      expect(runStore.getRoutineFanout("fanout-changes-pr")).toMatchObject({
        notificationState: "sent"
      });
    } finally {
      runStore.close();
    }
  });

  it("sends the fan-out summary under the default changes policy when a target's outcome is an issue action", async () => {
    // fanout.issueCount is permanently 0 (ADR 0069's deferred structured-
    // outcome slice — see getRoutineFanout in run-store.ts), so this proves
    // "changes" detects an issue-only change via each target's own
    // RoutineOutcome.action instead of relying on that counter.
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
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
      await dispatchDueRoutinesAndDrain({
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
        createFanoutId: () => "fanout-issue-outcome",
        createFiringId: () => "fire-issue-outcome",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listIssues,
          listOpenIssues: vi.fn().mockResolvedValue([])
        },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              return Promise.resolve();
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "changes",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          })
        }
      });

      expect(runStore.getRoutineFiring("fire-issue-outcome")?.outcome).toEqual(
        expect.objectContaining({ action: "issue_closed" })
      );
      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(runStore.getRoutineFanout("fanout-issue-outcome")).toMatchObject({
        notificationState: "sent"
      });
    } finally {
      runStore.close();
    }
  });

  it("never leaks the SMTP password into a rendered fan-out summary", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const secret = "smtp-password-that-must-never-leak-into-a-fanout";
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { message: "crashing", type: "message" },
          raw: { delta: "crashing" }
        };
        throw new Error(`provider crashed while holding ${secret}`);
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-redact",
        createFiringId: () => "fire-redact-fanout",
        env: { SMTP_TEST_PASSWORD: secret },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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

      const fanoutMessages = delivered.filter((message) =>
        message.subject.startsWith("[ptt]")
      );
      expect(fanoutMessages).toHaveLength(1);
      expect(fanoutMessages[0]?.text).toContain("[REDACTED]");
      expect(fanoutMessages[0]?.text).not.toContain(secret);
      expect(fanoutMessages[0]?.html).not.toContain(secret);
      expect(JSON.stringify(fanoutMessages)).not.toContain(secret);
    } finally {
      runStore.close();
    }
  });

  it("redacts a historical unredacted terminal reason before rendering a fan-out summary", async () => {
    // Simulates a firing row written before terminal-reason redaction
    // existed (or through a path that lacked redactSecrets), by persisting
    // it directly through the store rather than through the dispatcher's own
    // (already-redacting) completion path. This PR is the first one to ever
    // actually deliver a rendered fan-out, so delivery must defensively
    // re-redact rather than trust the persisted value.
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    const secret = "smtp-password-that-predates-terminal-reason-hardening";
    const delivered: NotificationMessage[] = [];
    const declaration = {
      kind: "report" as const,
      name: "legacy-routine",
      prompt: "Report.",
      provider: "codex" as const,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: "/tmp/legacy-routine.md"
    };

    try {
      runStore.syncRoutines([{ ...declaration, projectName: "alpha" }]);
      runStore.ensureRoutineFanout({
        id: "fanout-legacy",
        projectNames: ["alpha"],
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.claimRoutineFiring({
        fanoutId: "fanout-legacy",
        firedAt: "2026-05-22T10:00:01.000Z",
        firingId: "fire-legacy",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.completeRoutineFiring({
        id: "fire-legacy",
        state: "failed",
        terminalReason: `provider crashed while holding ${secret}`
      });

      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: {},
        configDir: "/tmp",
        env: { SMTP_TEST_PASSWORD: secret },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            smtpUsername: "server-token",
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:05:00.000Z"),
        projects: new Map(),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.text).toContain("[REDACTED]");
      expect(delivered[0]?.text).not.toContain(secret);
      expect(delivered[0]?.html).not.toContain(secret);
    } finally {
      runStore.close();
    }
  });

  it("redacts a delivery error containing the SMTP password before persisting or logging a fan-out failure", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const secret = "smtp-password-that-must-never-leak-in-a-delivery-error";
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-error-redact",
        createFiringId: () => "fire-error-redact",
        env: { SMTP_TEST_PASSWORD: secret },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver() {
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

      const fanout = runStore.getRoutineFanout("fanout-error-redact");
      expect(fanout?.notificationError).not.toContain(secret);
      expect(fanout?.notificationError).toContain("[REDACTED]");
    } finally {
      runStore.close();
    }
  });

  it("redacts every fan-out this tick using the config resolved before the delivery loop, not a mid-tick reload", async () => {
    // deliverRoutineFanoutNotification awaits real delivery, so a Service
    // Config reload (ADR 0052) can land between two ready fan-outs in the
    // same tick's loop. Redaction secrets must come from the SAME
    // once-resolved config that `sink` actually delivers through for the
    // rest of this tick, not be re-resolved per fan-out.
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    const oldSecret = "smtp-password-active-before-reload";
    const newSecret = "smtp-password-active-after-reload";
    const delivered: NotificationMessage[] = [];
    let reloaded = false;
    const declaration = {
      kind: "report" as const,
      prompt: "Report.",
      provider: "codex" as const,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: "/tmp/legacy-routine.md"
    };
    const legacyFanouts = [
      {
        fanoutId: "fanout-a",
        firingId: "fire-a",
        projectName: "alpha",
        routineName: "legacy-a"
      },
      {
        fanoutId: "fanout-b",
        firingId: "fire-b",
        projectName: "beta",
        routineName: "legacy-b"
      }
    ];

    try {
      runStore.syncRoutines(
        legacyFanouts.map(({ projectName, routineName }) => ({
          ...declaration,
          name: routineName,
          projectName
        }))
      );
      for (const {
        fanoutId,
        firingId,
        projectName,
        routineName
      } of legacyFanouts) {
        runStore.ensureRoutineFanout({
          id: fanoutId,
          projectNames: [projectName],
          routineName,
          scheduledAt: "2026-05-22T10:00:00.000Z"
        });
        runStore.claimRoutineFiring({
          fanoutId,
          firedAt: "2026-05-22T10:00:01.000Z",
          firingId,
          projectName,
          providerCommand: "codex fake",
          providerName: "codex",
          routineName,
          scheduledAt: "2026-05-22T10:00:00.000Z"
        });
        runStore.completeRoutineFiring({
          id: firingId,
          state: "failed",
          terminalReason: `provider crashed while holding ${oldSecret}`
        });
      }

      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: {},
        configDir: "/tmp",
        env: { SMTP_NEW: newSecret, SMTP_OLD: oldSecret },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
              // Simulate a reload landing after the first fan-out's
              // delivery, mid-tick, before the second is processed.
              reloaded = true;
              return Promise.resolve();
            }
          }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: reloaded ? "SMTP_NEW" : "SMTP_OLD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            smtpUsername: "server-token",
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:05:00.000Z"),
        projects: new Map(),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(delivered).toHaveLength(2);
      for (const message of delivered) {
        expect(message.text).toContain("[REDACTED]");
        expect(message.text).not.toContain(oldSecret);
      }
    } finally {
      runStore.close();
    }
  });

  it("returns from dispatch before a ready fan-out notification finishes", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    const notificationDeliveries = new NotificationDeliveryTracker();
    let finishDelivery: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });

    try {
      runStore.syncRoutines([
        {
          kind: "report",
          name: "daily-report",
          prompt: "Report.",
          projectName: "alpha",
          provider: "codex",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/daily-report.md"
        }
      ]);
      runStore.ensureRoutineFanout({
        id: "fanout-slow-email",
        projectNames: ["alpha"],
        routineName: "daily-report",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.claimRoutineFiring({
        fanoutId: "fanout-slow-email",
        firedAt: "2026-05-22T10:00:01.000Z",
        firingId: "fire-fanout-slow-email",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "daily-report",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.completeRoutineFiring({
        id: "fire-fanout-slow-email",
        state: "succeeded"
      });

      const dispatched = dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: {},
        configDir: "/tmp",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            async deliver() {
              markDeliveryStarted?.();
              await delivery;
            }
          }),
          deliveries: notificationDeliveries,
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            sources: {
              daemonHealth: true,
              issueRuns: true,
              routineFanouts: true,
              routineFirings: false
            },
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          }),
          timeoutMs: 5_000
        },
        now: new Date("2026-05-22T10:05:00.000Z"),
        projects: new Map(),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      await deliveryStarted;
      let dispatchSettled = false;
      void dispatched.then(() => {
        dispatchSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const returnedBeforeDeliveryFinished = dispatchSettled;
      finishDelivery?.();
      await dispatched;
      expect(returnedBeforeDeliveryFinished).toBe(true);
      await notificationDeliveries.settled();
      expect(runStore.getRoutineFanout("fanout-slow-email")).toMatchObject({
        notificationError: null,
        notificationState: "sent"
      });
    } finally {
      finishDelivery?.();
      runStore.close();
    }
  });

  it("keeps a fan-out pending for retry when the notification sink factory throws", async () => {
    // Sink construction is best-effort (SPEC.md §5.5) and must never fail a
    // daemon tick, which would otherwise also abort issue dispatch scheduled
    // in the same tick and recur identically every subsequent tick.
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    const declaration = {
      kind: "report" as const,
      name: "legacy-routine",
      prompt: "Report.",
      provider: "codex" as const,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: "/tmp/legacy-routine.md"
    };

    try {
      runStore.syncRoutines([{ ...declaration, projectName: "alpha" }]);
      runStore.ensureRoutineFanout({
        id: "fanout-sink-throws",
        projectNames: ["alpha"],
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.claimRoutineFiring({
        fanoutId: "fanout-sink-throws",
        firedAt: "2026-05-22T10:00:01.000Z",
        firingId: "fire-sink-throws",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.completeRoutineFiring({
        id: "fire-sink-throws",
        state: "succeeded"
      });

      // If sink construction were not contained, this call itself would
      // reject and fail the test.
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: {},
        configDir: "/tmp",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => {
            throw new Error("custom sink factory misconfigured");
          },
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:05:00.000Z"),
        projects: new Map(),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(runStore.getRoutineFanout("fanout-sink-throws")).toMatchObject({
        notificationState: "pending"
      });
      expect(runStore.listReadyRoutineFanouts()).toEqual([
        expect.objectContaining({ id: "fanout-sink-throws" })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("redacts the SMTP password from a sink-factory construction error before logging it", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    const secret = "smtp-password-that-must-never-leak-from-a-sink-factory";
    const logger = pino({ enabled: false });
    const logWarn = vi.spyOn(logger, "warn");
    const declaration = {
      kind: "report" as const,
      name: "legacy-routine",
      prompt: "Report.",
      provider: "codex" as const,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: "/tmp/legacy-routine.md"
    };

    try {
      runStore.syncRoutines([{ ...declaration, projectName: "alpha" }]);
      runStore.ensureRoutineFanout({
        id: "fanout-sink-throws-secret",
        projectNames: ["alpha"],
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.claimRoutineFiring({
        fanoutId: "fanout-sink-throws-secret",
        firedAt: "2026-05-22T10:00:01.000Z",
        firingId: "fire-sink-throws-secret",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.completeRoutineFiring({
        id: "fire-sink-throws-secret",
        state: "succeeded"
      });

      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: {},
        configDir: "/tmp",
        env: { SMTP_TEST_PASSWORD: secret },
        globalConcurrency: { maxInFlight: undefined },
        logger,
        notification: {
          createSink: () => {
            throw new Error(`custom sink factory misconfigured: ${secret}`);
          },
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
        now: new Date("2026-05-22T10:05:00.000Z"),
        projects: new Map(),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      expect(logWarn).toHaveBeenCalledTimes(1);
      const [logPayload] = logWarn.mock.calls[0]!;
      expect(JSON.stringify(logPayload)).not.toContain(secret);
      expect(JSON.stringify(logPayload)).toContain("[REDACTED]");
    } finally {
      runStore.close();
    }
  });

  it("keeps the tick alive when persisting a fan-out delivery outcome throws", async () => {
    // Simulates a disk-full/SQLite I/O error on the evidence write itself,
    // after the sink has already delivered the summary successfully.
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    const declaration = {
      kind: "report" as const,
      name: "legacy-routine",
      prompt: "Report.",
      provider: "codex" as const,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: "/tmp/legacy-routine.md"
    };

    try {
      runStore.syncRoutines([{ ...declaration, projectName: "alpha" }]);
      runStore.ensureRoutineFanout({
        id: "fanout-evidence-throws",
        projectNames: ["alpha"],
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.claimRoutineFiring({
        fanoutId: "fanout-evidence-throws",
        firedAt: "2026-05-22T10:00:01.000Z",
        firingId: "fire-evidence-throws",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "legacy-routine",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      });
      runStore.completeRoutineFiring({
        id: "fire-evidence-throws",
        state: "succeeded"
      });
      vi.spyOn(
        runStore,
        "completeRoutineFanoutNotification"
      ).mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      // If evidence-write failures were not contained, this call itself
      // would reject and fail the test.
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: {},
        configDir: "/tmp",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({ deliver: () => Promise.resolve() }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:05:00.000Z"),
        projects: new Map(),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      // The row stays at 'sending' — releaseInterruptedRoutineFanoutNotifications
      // is what recovers it, on the next daemon restart.
      expect(runStore.getRoutineFanout("fanout-evidence-throws")).toMatchObject(
        { notificationState: "sending" }
      );
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
      await dispatchDueRoutinesAndDrain({
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

  it("protects commits ahead when a kind: git provider fails", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await createGitWorkspaceAhead({
      branchName: "sym/alpha/routine/dependency-update/fire-failed",
      workspacePath
    });
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        throw new Error("provider process failed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;

    try {
      await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine: {
            kind: "git",
            name: "dependency-update",
            prompt: "Update dependencies.",
            provider: null,
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: path.join(root, "dependency-update.md")
          },
          runStore
        }),
        createFiringId: () => "fire-failed"
      });

      expect(runStore.getRoutineFiring("fire-failed")).toMatchObject({
        commitsAhead: true,
        state: "failed",
        terminalReason: "provider process failed"
      });
    } finally {
      runStore.close();
    }
  });

  it("retains a failed kind: git workspace when commits-ahead inspection fails", async () => {
    const root = await makeTempRoot();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        throw new Error("provider process failed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const inspectWorkspaceCommitsAhead = vi
      .fn()
      .mockRejectedValue(new Error("git rev-list failed"));

    try {
      await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine: {
            kind: "git",
            name: "dependency-update",
            prompt: "Update dependencies.",
            provider: null,
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: path.join(root, "dependency-update.md")
          },
          runStore
        }),
        createFiringId: () => "fire-inspection-failed",
        inspectWorkspaceCommitsAhead
      });

      expect(inspectWorkspaceCommitsAhead).toHaveBeenCalledWith({
        baseBranch: "main",
        workspacePath: path.join(root, "workspace")
      });
      expect(runStore.getRoutineFiring("fire-inspection-failed")).toMatchObject(
        {
          commitsAhead: true,
          state: "failed",
          terminalReason: "provider process failed"
        }
      );
    } finally {
      runStore.close();
    }
  });

  it("reclassifies a provider failure when cancellation lands during commit inspection", async () => {
    const root = await makeTempRoot();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const activeRuns = new ActiveRunRegistry();
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 1, type: "process_exit" },
          raw: { code: 1, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const inspectWorkspaceCommitsAhead = vi.fn(async () => {
      await activeRuns.requestCancel(
        "fire-cancel-during-classified-inspection",
        "operator"
      );
      return true;
    });

    try {
      await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine: {
            kind: "git",
            name: "dependency-update",
            prompt: "Update dependencies.",
            provider: null,
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: path.join(root, "dependency-update.md")
          },
          runStore
        }),
        createFiringId: () => "fire-cancel-during-classified-inspection",
        inspectWorkspaceCommitsAhead
      });

      expect(inspectWorkspaceCommitsAhead).toHaveBeenCalledOnce();
      expect(
        runStore.getRoutineFiring("fire-cancel-during-classified-inspection")
      ).toMatchObject({
        cancelReason: "operator",
        commitsAhead: true,
        state: "cancelled",
        terminalReason: "cancelled"
      });
    } finally {
      runStore.close();
    }
  });

  it("reclassifies a thrown failure when cancellation lands during commit inspection", async () => {
    const root = await makeTempRoot();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
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
        throw new Error("provider process failed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const inspectWorkspaceCommitsAhead = vi.fn(async () => {
      await activeRuns.requestCancel(
        "fire-cancel-during-thrown-inspection",
        "operator"
      );
      return true;
    });

    try {
      await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine: {
            kind: "git",
            name: "dependency-update",
            prompt: "Update dependencies.",
            provider: null,
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: path.join(root, "dependency-update.md")
          },
          runStore
        }),
        createFiringId: () => "fire-cancel-during-thrown-inspection",
        inspectWorkspaceCommitsAhead
      });

      expect(inspectWorkspaceCommitsAhead).toHaveBeenCalledOnce();
      expect(
        runStore.getRoutineFiring("fire-cancel-during-thrown-inspection")
      ).toMatchObject({
        cancelReason: "operator",
        commitsAhead: true,
        state: "cancelled",
        terminalReason: "cancelled"
      });
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
      const result = await dispatchDueRoutinesAndDrain({
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
      expect(provider.validate).toHaveBeenCalledWith("codex fake", {});
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

      const second = await dispatchDueRoutinesAndDrain({
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
      await dispatchDueRoutinesAndDrain({
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
      await dispatchDueRoutinesAndDrain({
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
      await dispatchDueRoutinesAndDrain({
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
            // This test is about firing-level redaction/failure handling,
            // not the grouped fan-out summary that the same clock event also
            // durably creates (ADR 0069) — mute it so it doesn't add its own
            // delivery attempts to `delivered`.
            sources: {
              daemonHealth: true,
              issueRuns: true,
              routineFanouts: false,
              routineFirings: true
            },
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

  it("redacts the SMTP password from persisted provider evidence and a provider-derived terminal reason", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const secret = "smtp-password-that-must-never-leak";
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    let handedStderrRedactSecrets: readonly string[] | undefined;
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // A full-permission provider process can inherit the daemon's env and
      // echo it back — this simulates that leak path to prove evidence and
      // the terminal reason both come out redacted regardless of source.
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        handedStderrRedactSecrets = input.stderrRedactSecrets;
        await Promise.resolve();
        yield {
          normalized: {
            message: `inherited env leaked password ${secret} and token tracker-token-value`,
            type: "message"
          },
          raw: {
            delta: `inherited env leaked password ${secret} and token tracker-token-value`
          }
        };
        throw new Error(
          `provider crashed while holding ${secret} and tracker-token-value`
        );
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-redact-evidence",
        env: {
          GITHUB_TOKEN: "tracker-token-value",
          SMTP_TEST_PASSWORD: secret
        },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            smtpUsername: "server-token",
            // Scoped to firing-level redaction, not the grouped fan-out
            // summary the same clock event also durably creates (ADR 0069).
            sources: {
              daemonHealth: true,
              issueRuns: true,
              routineFanouts: false,
              routineFirings: true
            },
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

      const firing = runStore.getRoutineFiring("fire-redact-evidence");
      expect(firing?.state).toBe("failed");
      expect(firing?.terminalReason).toBe(
        "provider crashed while holding [REDACTED] and [REDACTED]"
      );
      expect(firing?.terminalReason).not.toContain(secret);

      const rawLog = await readFile(
        path.join(
          stateRoot,
          "logs",
          "routines",
          "fire-redact-evidence",
          "provider.raw.jsonl"
        ),
        "utf8"
      );
      const normalizedLog = await readFile(
        path.join(
          stateRoot,
          "logs",
          "routines",
          "fire-redact-evidence",
          "provider.normalized.jsonl"
        ),
        "utf8"
      );
      expect(rawLog).toContain("[REDACTED]");
      expect(rawLog).not.toContain(secret);
      expect(normalizedLog).toContain("[REDACTED]");
      expect(normalizedLog).not.toContain(secret);
      // provider.stderr.log lands in this same directory and is served by the
      // same artifact route, so the tee gets the same secret list the JSONL
      // evidence writer uses. (What the tee then does with it — including
      // secrets split across chunk boundaries — is covered by
      // tests/provider-stderr.test.ts.)
      expect(handedStderrRedactSecrets).toContain(secret);
      // The project's tracker token rides along too: providers inherit this
      // process's env, so an agent echoing it would otherwise write it into
      // the same artifact (SPEC.md §6).
      expect(handedStderrRedactSecrets).toContain("tracker-token-value");
      // ... and it is scrubbed from the JSONL evidence and the terminal reason
      // on the same terms as the SMTP password, not only from the tee.
      expect(rawLog).not.toContain("tracker-token-value");
      expect(normalizedLog).not.toContain("tracker-token-value");
      expect(firing?.terminalReason).not.toContain("tracker-token-value");

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.text).not.toContain(secret);
      expect(delivered[0]?.html).not.toContain(secret);
      // The email is the one channel that leaves the machine, so it is the
      // last place a leaked credential can still be caught — the tracker token
      // has to be scrubbed here too, not only from the on-disk evidence.
      expect(delivered[0]?.text).not.toContain("tracker-token-value");
      expect(delivered[0]?.html).not.toContain("tracker-token-value");

      const database = await readFile(path.join(stateRoot, "symphonika.db"));
      expect(database.includes(Buffer.from(secret))).toBe(false);
    } finally {
      runStore.close();
    }
  });

  it("redacts the SMTP password from a provider's structured outcome claim before persistence and notification", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const secret = "smtp-password-that-must-never-leak-in-a-claim";
    const runStore = openRunStore({ stateRoot });
    const delivered: NotificationMessage[] = [];
    const claim = JSON.stringify({
      action: "none",
      status: "no_action",
      summary: `leaked env value ${secret} in summary`,
      title: `leaked env value ${secret} in title`,
      url: `https://example.com/${secret}`
    });
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
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
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-redact-claim",
        env: { SMTP_TEST_PASSWORD: secret },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            smtpUsername: "server-token",
            // Scoped to firing-level redaction, not the grouped fan-out
            // summary the same clock event also durably creates (ADR 0069).
            sources: {
              daemonHealth: true,
              issueRuns: true,
              routineFanouts: false,
              routineFirings: true
            },
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

      const firing = runStore.getRoutineFiring("fire-redact-claim");
      expect(firing?.state).toBe("succeeded");
      expect(firing?.outcome?.title).not.toContain(secret);
      expect(firing?.outcome?.summary).not.toContain(secret);
      expect(firing?.outcome?.url).not.toContain(secret);
      expect(firing?.outcome?.title).toContain("[REDACTED]");
      expect(firing?.outcome?.summary).toContain("[REDACTED]");
      expect(firing?.outcome?.url).toContain("[REDACTED]");

      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.text).not.toContain(secret);
      expect(delivered[0]?.html).not.toContain(secret);

      const database = await readFile(path.join(stateRoot, "symphonika.db"));
      expect(database.includes(Buffer.from(secret))).toBe(false);
    } finally {
      runStore.close();
    }
  });

  it("redacts a JSON-escaped SMTP password from persisted provider evidence", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    // Contains a quote and a backslash, both of which JSON.stringify escapes
    // — a naive redact-after-serialize implementation would miss this.
    const secret = 'smtp-"password"-with-a-\\backslash-that-must-never-leak';
    const runStore = openRunStore({ stateRoot });
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: {
            message: `inherited env leaked password ${secret}`,
            type: "message"
          },
          raw: { delta: `inherited env leaked password ${secret}` }
        };
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-redact-json-escaped",
        env: { SMTP_TEST_PASSWORD: secret },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({ deliver: () => Promise.resolve() }),
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

      const rawLog = await readFile(
        path.join(
          stateRoot,
          "logs",
          "routines",
          "fire-redact-json-escaped",
          "provider.raw.jsonl"
        ),
        "utf8"
      );
      const normalizedLog = await readFile(
        path.join(
          stateRoot,
          "logs",
          "routines",
          "fire-redact-json-escaped",
          "provider.normalized.jsonl"
        ),
        "utf8"
      );
      // A JSON.stringify-escaped copy of the secret must not survive either:
      // check both the raw secret and its escaped form are absent.
      const escapedSecret = JSON.stringify(secret).slice(1, -1);
      expect(rawLog).toContain("[REDACTED]");
      expect(rawLog).not.toContain(secret);
      expect(rawLog).not.toContain(escapedSecret);
      expect(normalizedLog).toContain("[REDACTED]");
      expect(normalizedLog).not.toContain(secret);
      expect(normalizedLog).not.toContain(escapedSecret);
    } finally {
      runStore.close();
    }
  });

  it("refreshes redaction secrets from a mid-firing Service Config reload instead of a dispatch-time snapshot", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const oldSecret = "smtp-password-active-at-dispatch-time";
    const newSecret = "smtp-password-active-after-reload";
    const runStore = openRunStore({ stateRoot });
    // Simulates a Service Config reload landing mid-firing: resolveConfig()
    // starts by pointing at the old password env var, then a later call
    // (once the provider is already running) switches to the new one.
    let reloaded = false;
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        reloaded = true;
        yield {
          normalized: {
            message: `inherited env leaked password ${newSecret}`,
            type: "message"
          },
          raw: { delta: `inherited env leaked password ${newSecret}` }
        };
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;

    try {
      await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "fire-redact-reload",
        env: {
          SMTP_TEST_PASSWORD_NEW: newSecret,
          SMTP_TEST_PASSWORD_OLD: oldSecret
        },
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({ deliver: () => Promise.resolve() }),
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: reloaded
              ? "SMTP_TEST_PASSWORD_NEW"
              : "SMTP_TEST_PASSWORD_OLD",
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

      const rawLog = await readFile(
        path.join(
          stateRoot,
          "logs",
          "routines",
          "fire-redact-reload",
          "provider.raw.jsonl"
        ),
        "utf8"
      );
      // The event was emitted after the simulated reload, using the new
      // password env var — a dispatch-time-only redaction snapshot (taken
      // before the provider ran, while resolveConfig() still pointed at the
      // old var) would miss it.
      expect(rawLog).toContain("[REDACTED]");
      expect(rawLog).not.toContain(newSecret);
    } finally {
      runStore.close();
    }
  });

  it("returns from dispatch and releases the concurrency slot before notification delivery finishes", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const notificationDeliveries = new NotificationDeliveryTracker();
    let finishDelivery: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
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
              throw new Error("relay unavailable");
            }
          }),
          deliveries: notificationDeliveries,
          resolveConfig: () => ({
            from: "symphonika@example.com",
            on: "always",
            sources: {
              daemonHealth: true,
              issueRuns: true,
              routineFanouts: false,
              routineFirings: true
            },
            smtpHost: "smtp.example.com",
            smtpPasswordEnv: "SMTP_TEST_PASSWORD",
            smtpPort: 587,
            smtpSecurity: "starttls",
            to: "operator@example.com"
          }),
          timeoutMs: 5_000
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
      let dispatchSettled = false;
      void dispatched.then(() => {
        dispatchSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const returnedBeforeDeliveryFinished = dispatchSettled;
      finishDelivery?.();
      await dispatched;
      expect(returnedBeforeDeliveryFinished).toBe(true);
      await notificationDeliveries.settled();
      expect(runStore.getRoutineFiring("fire-slow-email")).toMatchObject({
        notificationError: "relay unavailable",
        notificationState: "failed",
        state: "succeeded"
      });
    } finally {
      finishDelivery?.();
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
      await dispatchDueRoutinesAndDrain({
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
            // Scoped to firing-level config resolution timing, not the
            // grouped fan-out summary the same clock event also durably
            // creates (ADR 0069).
            sources: {
              daemonHealth: true,
              issueRuns: true,
              routineFanouts: false,
              routineFirings: true
            },
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
      await dispatchDueRoutinesAndDrain({
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
      await dispatchDueRoutinesAndDrain({
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
      await dispatchDueRoutinesAndDrain({
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
      await dispatchDueRoutinesAndDrain({
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
      await dispatchDueRoutinesAndDrain({
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
          commitsAhead: true,
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

  it("does not record a pull request discovered after settlement already abandoned it", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    const branchName = "sym/alpha/routine/dependency-update/01JABANDONEDPR";
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
    let releaseLateDiscovery: (
      pullRequests: RawGitHubPullRequest[]
    ) => void = () => {};
    const lateDiscoveryGate = new Promise<RawGitHubPullRequest[]>((resolve) => {
      releaseLateDiscovery = resolve;
    });
    // Simulates an operator cancel landing while PR discovery (not the
    // before/after snapshot) is still awaiting GitHub: the settlement window
    // abandons this await rather than stopping it, so the underlying call
    // keeps running and can only resolve later, via releaseLateDiscovery.
    // Call 1 is the before-run snapshot, call 2 is the after-run snapshot
    // (made to fail so `pullRequestsAvailable` is false and the dispatcher
    // falls through to `discoverRoutinePullRequests`), call 3 is that
    // discovery call itself.
    const listPullRequestsForBranch = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("after-run PR snapshot unavailable"))
      .mockImplementationOnce(async () => {
        await activeRuns.requestCancel("fire-abandoned-discovery", "operator");
        return lateDiscoveryGate;
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
      const dispatchPromise = dispatchDueRoutines({
        activeRuns,
        agentProviders: { codex: provider },
        cancellationSettleMs: 25,
        configDir: root,
        createFanoutId: () => "fanout-abandoned-discovery",
        createFiringId: () => "fire-abandoned-discovery",
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

      await dispatchPromise;

      expect(runStore.getRoutineFiring("fire-abandoned-discovery")).toEqual(
        expect.objectContaining({
          cancelReason: "operator",
          pullRequests: [],
          state: "cancelled"
        })
      );

      // The abandoned discovery finally resolves after the firing already
      // went terminal. It must not write a PR onto a firing whose outcome
      // was already recorded and reported.
      releaseLateDiscovery([
        { head: { ref: branchName, sha: "late123" }, number: 99, state: "open" }
      ]);
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        runStore.getRoutineFiring("fire-abandoned-discovery")?.pullRequests
      ).toEqual([]);
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
      await dispatchDueRoutinesAndDrain({
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

  it("reclassifies a failed firing as firing_timeout when the deadline expires during the failure-path GitHub snapshot", async () => {
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
      // Never resolves: only the firing's own wall-clock deadline can end
      // this read, distinguishing a genuine timeout from the earlier
      // provider error that put us in the catch block.
      .mockImplementationOnce(() => new Promise<never>(() => {}));

    try {
      await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine: {
            ...minuteRoutine(root),
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            timeoutMinutes: 0.001
          },
          runStore
        }),
        createFiringId: () => "fire-timeout-during-failure-snapshot",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          listIssues,
          listOpenIssues: vi.fn().mockResolvedValue([])
        }
      });

      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "fire-timeout-during-failure-snapshot",
          state: "failed",
          terminalReason: "firing_timeout"
        })
      ]);
    } finally {
      runStore.close();
    }
  });

  it("reclassifies a failed firing as firing_timeout when the deadline expires during the failure-path commits-ahead inspection", async () => {
    const root = await makeTempRoot();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        throw new Error("provider process failed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const inspectWorkspaceCommitsAhead = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 200);
        })
    );

    try {
      await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine: {
            kind: "git",
            name: "dependency-update",
            prompt: "Update dependencies.",
            provider: null,
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: path.join(root, "dependency-update.md"),
            timeoutMinutes: 0.001
          },
          runStore
        }),
        createFiringId: () => "fire-timeout-during-failure-inspection",
        inspectWorkspaceCommitsAhead
      });

      expect(
        runStore.getRoutineFiring("fire-timeout-during-failure-inspection")
      ).toMatchObject({
        commitsAhead: true,
        state: "failed",
        terminalReason: "firing_timeout"
      });
    } finally {
      runStore.close();
    }
  });

  it("retains commits_ahead conservatively when a cancellation settlement abandons the failure-path inspection", async () => {
    const root = await makeTempRoot();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
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
        throw new Error("provider process failed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    // Simulates an operator cancel landing while the failure-path
    // commits-ahead inspection is still running: the settlement window
    // abandons the await rather than stopping the Git subprocess, so the
    // real answer is unknown and must not be recorded as a verified zero.
    const inspectWorkspaceCommitsAhead = vi.fn(async () => {
      await activeRuns.requestCancel(
        "fire-abandoned-commits-ahead",
        "operator"
      );
      return new Promise<boolean>(() => {});
    });

    try {
      await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine: {
            kind: "git",
            name: "dependency-update",
            prompt: "Update dependencies.",
            provider: null,
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: path.join(root, "dependency-update.md")
          },
          runStore
        }),
        cancellationSettleMs: 25,
        createFiringId: () => "fire-abandoned-commits-ahead",
        inspectWorkspaceCommitsAhead
      });

      expect(
        runStore.getRoutineFiring("fire-abandoned-commits-ahead")
      ).toMatchObject({
        cancelReason: "operator",
        commitsAhead: true,
        state: "cancelled"
      });
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

      const first = await dispatchDueRoutinesAndDrain({
        ...baseInput,
        now: new Date("2026-05-22T10:00:00.000Z")
      });
      const second = await dispatchDueRoutinesAndDrain({
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
          routineName: "minute-report",
          scheduledAt: "2026-05-22T10:00:00.000Z"
        })
      ).toBe(true);
      runStore.completeRoutineFiring({
        id: "previous-fire",
        state: "succeeded"
      });

      try {
        const result = await dispatchDueRoutinesAndDrain({
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
        routineName: "minute-report",
        scheduledAt: "2026-05-22T10:00:00.000Z"
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
      const second = await dispatchDueRoutinesAndDrain({
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

  it("groups catch-up window skips from one missed clock event after restart", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const routine = minuteRoutine(root);
    const delivered: NotificationMessage[] = [];
    const declarations = ["alpha", "beta"].map((projectName) => ({
      ...routine,
      projectName
    }));
    runStore.syncRoutines(declarations, {
      now: new Date("2026-05-22T10:00:30.000Z")
    });

    try {
      const result = await dispatchDueRoutinesAndDrain({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-restart-skip",
        globalConcurrency: { maxInFlight: undefined },
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:01:30.000Z"),
        prepareRoutineWorkspace: vi.fn(),
        projects: new Map(
          declarations.map((declaration) => [
            declaration.projectName,
            {
              ...runStoreProjectFixture(),
              name: declaration.projectName,
              routines: [declaration]
            }
          ])
        ),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        recomputeSchedulesFromNow: true,
        runStore,
        stateRoot
      });

      expect(result).toEqual({
        deferred: [],
        fired: [],
        missed: [],
        skipped: [
          {
            projectName: "alpha",
            reason: "catch_up_window",
            routineName: "minute-report"
          },
          {
            projectName: "beta",
            reason: "catch_up_window",
            routineName: "minute-report"
          }
        ]
      });
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        subject: "[ptt] minute-report — 0 PR, 0 issue, 0 failed"
      });
      expect(delivered[0]?.text).toContain(
        "- alpha: skipped (catch_up_window)"
      );
      expect(delivered[0]?.text).toContain("- beta: skipped (catch_up_window)");
      expect(runStore.getRoutineFanout("fanout-restart-skip")).toMatchObject({
        notificationState: "sent",
        routineName: "minute-report",
        scheduledAt: "2026-05-22T10:01:00.000Z",
        targets: [
          {
            disposition: "skipped",
            projectName: "alpha",
            skipReason: "catch_up_window"
          },
          {
            disposition: "skipped",
            projectName: "beta",
            skipReason: "catch_up_window"
          }
        ]
      });
    } finally {
      runStore.close();
    }
  });

  it("does not create a restart fan-out for a newly disabled routine", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const routine = minuteRoutine(root);
    const delivered: NotificationMessage[] = [];
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T10:00:30.000Z")
    });

    try {
      const result = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine: { ...routine, disabled: true },
          runStore
        }),
        createFanoutId: () => "fanout-disabled-restart",
        notification: {
          createSink: () => ({
            deliver(message: NotificationMessage) {
              delivered.push(message);
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
            to: "operator@example.com"
          })
        },
        now: new Date("2026-05-22T10:01:30.000Z"),
        recomputeSchedulesFromNow: true
      });

      expect(result).toEqual({
        deferred: [],
        fired: [],
        missed: [],
        skipped: []
      });
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(delivered).toEqual([]);
      expect(
        runStore.getRoutineFanout("fanout-disabled-restart")
      ).toBeUndefined();
      expect(
        runStore.getRoutine({ name: "minute-report", projectName: "alpha" })
      ).toMatchObject({
        lastSkipReason: null,
        state: "disabled"
      });
    } finally {
      runStore.close();
    }
  });

  it("records an ungrouped catch-up window skip when a restart target misses an already-durable fan-out", async () => {
    // A Routine Fan-out for this exact (routine, scheduled_at) can already
    // be durable from an earlier restart with narrower membership than what
    // this recompute pass just found — ensureRoutineFanout never extends an
    // existing row's targets (see the comment above its call site). This
    // simulates that by seeding the fan-out directly with only "alpha" as a
    // target before dispatch discovers both "alpha" and "beta" due at the
    // same missed clock event.
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const provider = quietProvider();
    const routine = minuteRoutine(root);
    const declarations = ["alpha", "beta"].map((projectName) => ({
      ...routine,
      projectName
    }));
    runStore.syncRoutines(declarations, {
      now: new Date("2026-05-22T10:00:30.000Z")
    });
    runStore.ensureRoutineFanout({
      id: "pre-existing-fanout",
      projectNames: ["alpha"],
      routineName: "minute-report",
      scheduledAt: "2026-05-22T10:01:00.000Z"
    });

    try {
      const result = await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFanoutId: () => "fanout-should-not-be-created",
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:01:30.000Z"),
        prepareRoutineWorkspace: vi.fn(),
        projects: new Map(
          declarations.map((declaration) => [
            declaration.projectName,
            {
              ...runStoreProjectFixture(),
              name: declaration.projectName,
              routines: [declaration]
            }
          ])
        ),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        recomputeSchedulesFromNow: true,
        runStore,
        stateRoot
      });

      expect(result.fired).toEqual([]);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          {
            projectName: "alpha",
            reason: "catch_up_window",
            routineName: "minute-report"
          },
          {
            projectName: "beta",
            reason: "catch_up_window",
            routineName: "minute-report"
          }
        ])
      );
      expect(runStore.getRoutineFanout("pre-existing-fanout")).toMatchObject({
        targets: [
          {
            disposition: "skipped",
            projectName: "alpha",
            skipReason: "catch_up_window"
          }
        ]
      });
    } finally {
      runStore.close();
    }
  });

  it.each(["sent", "skipped"] as const)(
    "keeps a %s fan-out snapshot unchanged when restart catch-up consumes a held target",
    async (notificationState) => {
      const root = await makeTempRoot();
      const stateRoot = path.join(root, ".symphonika");
      const runStore = openRunStore({ stateRoot });
      const provider = quietProvider();
      const routine = minuteRoutine(root);
      runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
        now: new Date("2026-05-22T10:00:30.000Z")
      });
      runStore.ensureRoutineFanout({
        id: "delivered-held-fanout",
        projectNames: ["alpha"],
        routineName: "minute-report",
        scheduledAt: "2026-05-22T10:01:00.000Z"
      });
      expect(
        runStore.holdRoutineFanoutTarget({
          fanoutId: "delivered-held-fanout",
          projectName: "alpha",
          reason: "provider_not_registered: codex"
        })
      ).toBe(true);
      expect(
        runStore.claimRoutineFanoutNotification("delivered-held-fanout")
      ).toBe(true);
      runStore.completeRoutineFanoutNotification({
        id: "delivered-held-fanout",
        state: notificationState
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
          createFanoutId: () => "fanout-must-not-be-created",
          now: new Date("2026-05-22T10:01:30.000Z"),
          recomputeSchedulesFromNow: true
        });

        expect(result).toEqual({
          deferred: [],
          fired: [],
          missed: [],
          skipped: [
            {
              projectName: "alpha",
              reason: "catch_up_window",
              routineName: "minute-report"
            }
          ]
        });
        expect(
          runStore.getRoutineFanout("delivered-held-fanout")
        ).toMatchObject({
          notificationState,
          targets: [
            {
              disposition: "held",
              holdReason: "provider_not_registered: codex",
              projectName: "alpha",
              skipReason: null
            }
          ]
        });
        expect(runStore.listRoutines({ project: "alpha" })[0]).toMatchObject({
          lastSkipReason: "catch_up_window",
          nextFireAt: "2026-05-22T10:02:00.000Z"
        });
      } finally {
        runStore.close();
      }
    }
  );

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
        routineName: "minute-report",
        scheduledAt: "2026-05-22T10:00:00.000Z"
      })
    ).toBe(true);
    runStore.completeRoutineFiring({
      id: "previous-fire",
      state: "succeeded"
    });

    try {
      const result = await dispatchDueRoutinesAndDrain({
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

  it("holds a recurring clock event until its provider adapter is registered", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const runStore = openRunStore({ stateRoot });
    const codexProvider = quietProvider();
    const claudeProvider = {
      ...quietProvider(),
      name: "claude"
    } satisfies AgentProvider;
    const routine = {
      ...minuteRoutine(root),
      provider: "claude" as const
    };
    const logger = pino({ enabled: false });
    const logWarn = vi.spyOn(logger, "warn");
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });
    const dispatchInput = recurringDispatchInput({
      activeRuns: new ActiveRunRegistry(),
      provider: codexProvider,
      root,
      routine,
      runStore
    });

    try {
      const held = await dispatchDueRoutinesAndDrain({
        ...dispatchInput,
        logger
      });

      expect(held).toEqual({
        deferred: [],
        fired: [],
        missed: [],
        skipped: [
          {
            projectName: "alpha",
            reason: "provider_not_registered: claude",
            routineName: "minute-report"
          }
        ]
      });
      expect(runStore.listRoutineFirings()).toEqual([]);
      expect(runStore.listRoutines()[0]).toMatchObject({
        lastAttemptedAt: null,
        lastSkipAt: null,
        lastSkipReason: null,
        nextFireAt: "2026-05-22T10:00:00.000Z",
        state: "active"
      });
      expect(logWarn).toHaveBeenCalledWith(
        {
          project: "alpha",
          provider: "claude",
          routine: "minute-report",
          scheduled_at: "2026-05-22T10:00:00.000Z"
        },
        "routine dispatch held: provider adapter not registered"
      );

      const resumed = await dispatchDueRoutinesAndDrain({
        ...dispatchInput,
        agentProviders: {
          claude: claudeProvider,
          codex: codexProvider
        },
        now: new Date("2026-05-22T10:00:30.000Z")
      });

      expect(resumed).toEqual({
        deferred: [],
        fired: ["new-fire"],
        missed: [],
        skipped: []
      });
      expect(runStore.getRoutineFiring("new-fire")).toMatchObject({
        scheduledAt: "2026-05-22T10:00:00.000Z",
        state: "succeeded"
      });
      expect(runStore.listRoutines()[0]).toMatchObject({
        lastFiredAt: "2026-05-22T10:00:30.000Z",
        nextFireAt: "2026-05-22T10:01:00.000Z"
      });
    } finally {
      runStore.close();
    }
  });

  it("defers a recurring tick at the concurrency cap and fires it once a slot frees", async () => {
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
      const result = await dispatchDueRoutinesAndDrain({
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
      expect(result.skipped).toEqual([]);
      expect(result.deferred).toEqual([
        {
          projectName: "alpha",
          reason: "concurrency_cap",
          routineName: "minute-report"
        }
      ]);
      expect(runStore.listRoutineFirings()).toEqual([]);
      // The clock event is parked, not consumed: the next tick re-evaluates
      // the same event instead of waiting a whole period (ADR 0093).
      expect(runStore.listRoutines()[0]?.nextFireAt).toBe(
        "2026-05-22T10:00:00.000Z"
      );
      expect(
        runStore.listRoutines({ now: new Date("2026-05-22T10:00:00.000Z") })[0]
      ).toMatchObject({
        deferral: {
          attempts: 1,
          reason: "concurrency_cap",
          since: "2026-05-22T10:00:00.000Z"
        },
        lastAttemptedAt: "2026-05-22T10:00:00.000Z",
        lastSkipAt: null,
        lastSkipReason: null,
        skipCounts24h: { concurrency_cap: 0 }
      });
      expect(logInfo).toHaveBeenCalledWith(
        {
          deferred_until: "2026-05-22T10:01:00.000Z",
          project: "alpha",
          reason: "concurrency_cap",
          routine: "minute-report",
          scheduled_at: "2026-05-22T10:00:00.000Z"
        },
        "routine.deferred"
      );

      activeRuns.unregister("issue-run");
      const retry = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        logger,
        now: new Date("2026-05-22T10:00:30.000Z")
      });

      expect(retry.fired).toEqual(["new-fire"]);
      expect(retry.deferred).toEqual([]);
      expect(
        runStore.listRoutines({ now: new Date("2026-05-22T10:00:30.000Z") })[0]
      ).toMatchObject({
        deferral: null,
        skipCounts24h: { concurrency_cap: 0 }
      });
    } finally {
      activeRuns.unregister("issue-run");
      runStore.close();
    }
  });

  it("reports a miss with no firing when the deadline is reached with capacity free", async () => {
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
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });

    try {
      await dispatchDueRoutinesAndDrain(
        recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        })
      );

      // The slot frees before the deadline, so this tick has capacity — the
      // parked event is still past its own clock and settles as missed.
      activeRuns.unregister("issue-run");
      const atDeadline = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        now: new Date("2026-05-22T10:01:00.000Z")
      });

      // This exact shape — a miss with nothing fired — is what daemon.ts
      // keys on to end the tick instead of letting an issue Run claim the
      // slot the now-due successor is owed (ADR 0093).
      expect(atDeadline.fired).toEqual([]);
      expect(atDeadline.missed).toHaveLength(1);
      expect(runStore.listRoutines()[0]?.nextFireAt).toBe(
        "2026-05-22T10:01:00.000Z"
      );

      const successor = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        now: new Date("2026-05-22T10:01:30.000Z")
      });

      expect(successor.fired).toEqual(["new-fire"]);
    } finally {
      activeRuns.unregister("issue-run");
      runStore.close();
    }
  });

  it("keeps a parked clock event through a restart schedule recompute", async () => {
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
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });

    try {
      const deferredResult = await dispatchDueRoutinesAndDrain(
        recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        })
      );

      expect(deferredResult.deferred).toHaveLength(1);

      // Restart catch-up settles events the daemon slept through. A parked
      // deferral is not one of those: the daemon is still retrying it, so
      // recomputing it away would drop the run silently (ADR 0093).
      activeRuns.unregister("issue-run");
      const afterRestart = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        now: new Date("2026-05-22T10:00:30.000Z"),
        recomputeSchedulesFromNow: true
      });

      expect(afterRestart.fired).toEqual(["new-fire"]);
      expect(afterRestart.skipped).toEqual([]);
    } finally {
      activeRuns.unregister("issue-run");
      runStore.close();
    }
  });

  it("records a one-shot Routine as missed once its deferral horizon passes", async () => {
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
    const routine = {
      kind: "report" as const,
      name: "one-shot",
      prompt: "Report.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: path.join(root, "one-shot.md")
    };
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });

    try {
      const deferredResult = await dispatchDueRoutinesAndDrain(
        recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        })
      );

      expect(deferredResult.deferred).toHaveLength(1);
      expect(runStore.listRoutines()[0]).toMatchObject({ state: "active" });

      const missedResult = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns,
          provider,
          root,
          routine,
          runStore
        }),
        now: new Date("2026-05-23T10:00:00.000Z")
      });

      expect(missedResult.fired).toEqual([]);
      expect(missedResult.missed).toEqual([
        {
          projectName: "alpha",
          reason: "concurrency_cap",
          routineName: "one-shot"
        }
      ]);
      expect(
        runStore.listRoutines({ now: new Date("2026-05-23T10:00:00.000Z") })[0]
      ).toMatchObject({
        deferral: null,
        lastSkipReason: "concurrency_cap",
        state: "expired"
      });
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
      const result = await dispatchDueRoutinesAndDrain({
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
      const beforeNextClock = await dispatchDueRoutinesAndDrain({
        ...recurringDispatchInput({
          activeRuns: new ActiveRunRegistry(),
          provider,
          root,
          routine,
          runStore
        }),
        now: new Date("2026-05-22T10:00:30.000Z")
      });
      const nextClock = await dispatchDueRoutinesAndDrain({
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

  it("terminates a wedged recurring firing and releases its overlap and capacity slots", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const onRoutineTerminated = vi.fn();
    const routine = minuteRoutine(root);
    const firingIds = ["wedged-fire", "replacement-fire"];
    let releaseWedgedProvider: (() => void) | undefined;
    const wedgedProvider = new Promise<void>((resolve) => {
      releaseWedgedProvider = resolve;
    });
    let attempt = 0;
    const provider = {
      cancel: vi.fn(() => {
        releaseWedgedProvider?.();
        return Promise.resolve();
      }),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        if (attempt++ === 0) {
          await wedgedProvider;
        }
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });
    const baseInput = {
      ...recurringDispatchInput({
        activeRuns,
        provider,
        root,
        routine,
        runStore
      }),
      createFiringId: () => firingIds.shift() ?? "unexpected-fire",
      prepareRoutineWorkspace: () =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    };
    const firstDispatch = dispatchDueRoutines(baseInput);

    try {
      await vi.waitFor(() => {
        expect(runStore.getRoutineFiring("wedged-fire")?.state).toBe("running");
      });
      expect(activeRuns.countInFlight()).toBe(1);

      const watchdogConfig = {
        enabled: true,
        graceMinutes: 1,
        maxRunMinutes: 0,
        mtimeIgnore: [],
        mtimeInclude: [],
        outputTokenBudget: 0,
        sampleIntervalSeconds: 60
      };
      const baseline = await reconcileWatchdog({
        activeRuns,
        config: watchdogConfig,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore
      });
      const termination = await reconcileWatchdog({
        activeRuns,
        config: watchdogConfig,
        now: () => new Date("2026-05-22T10:01:00.000Z"),
        onRoutineTerminated,
        runStore
      });

      expect(baseline).toEqual({ sampled: 1, terminated: 0 });
      expect(termination).toEqual({ sampled: 1, terminated: 1 });
      await firstDispatch;
      expect(provider.cancel).toHaveBeenCalledWith("wedged-fire");
      expect(onRoutineTerminated).toHaveBeenCalledWith({
        firingId: "wedged-fire",
        projectName: "alpha",
        routineName: "minute-report"
      });
      expect(runStore.getRoutineFiring("wedged-fire")).toMatchObject({
        cancelReason: "no_progress",
        cancelRequested: true,
        state: "failed",
        terminalReason: "no_progress"
      });
      expect(activeRuns.countInFlight()).toBe(0);

      const replacement = await dispatchDueRoutines({
        ...baseInput,
        now: new Date("2026-05-22T10:01:00.000Z")
      });
      expect(replacement.fired).toEqual(["replacement-fire"]);
      expect(provider.runAttempt).toHaveBeenCalledTimes(2);
    } finally {
      releaseWedgedProvider?.();
      await firstDispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("does not decorate a no_progress terminal reason with a stderr tail even when the durable latch is missing", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const routine = minuteRoutine(root);
    let releaseWedgedProvider: (() => void) | undefined;
    const wedgedProvider = new Promise<void>((resolve) => {
      releaseWedgedProvider = resolve;
    });
    const provider = {
      cancel: vi.fn(() => {
        releaseWedgedProvider?.();
        return Promise.resolve();
      }),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        // Stands in for the real adapter's tee: some providers write partial
        // diagnostics to stderr well before actually wedging.
        await writeFile(
          input.stderrLogPath!,
          "codex: connection reset\n",
          "utf8"
        );
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        await wedgedProvider;
        // The provider dies with an error once cancelled, landing this
        // firing in the catch path rather than the try path's own
        // no-progress classification (which never decorates with stderr).
        throw new Error("provider process killed");
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });
    const dispatch = dispatchDueRoutines({
      ...recurringDispatchInput({
        activeRuns,
        provider,
        root,
        routine,
        runStore
      }),
      createFiringId: () => "wedged-stderr-fire",
      prepareRoutineWorkspace: () =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    });

    try {
      await vi.waitFor(() => {
        expect(runStore.getRoutineFiring("wedged-stderr-fire")?.state).toBe(
          "running"
        );
      });

      // Requests the cancellation directly on the in-memory registry,
      // bypassing markRoutineFiringWatchdogNoProgress's durable latch — the
      // same as if the latch write and the in-memory cancel raced apart.
      // completeRoutineFiring's own latch-reread fence therefore cannot
      // correct a decorated reason here: only the dispatcher's own
      // catch-path logic can keep this exact, so this isolates that fix.
      await activeRuns.requestCancel("wedged-stderr-fire", "no_progress");

      await dispatch;
      expect(runStore.getRoutineFiring("wedged-stderr-fire")).toMatchObject({
        cancelReason: "no_progress",
        // Deliberately false: this test bypasses the durable watchdog latch
        // (no markRoutineFiringWatchdogNoProgress call) so completeRoutineFiring's
        // own latch-reread fence cannot fire, isolating the dispatcher's own fix.
        cancelRequested: false,
        state: "failed",
        terminalReason: "no_progress"
      });
    } finally {
      releaseWedgedProvider?.();
      await dispatch.catch(() => undefined);
      runStore.close();
    }
  });

  it("settles a firing whose Watchdog cancel lands while a GitHub snapshot hangs", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const runStore = openRunStore({ stateRoot });
    const activeRuns = new ActiveRunRegistry();
    const routine = minuteRoutine(root);
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
    // The before-snapshot read is awaited after the row is already `running`
    // but before runAttempt starts, so provider.cancel() cannot settle it.
    const listIssues = vi.fn(() => new Promise<RawGitHubIssue[]>(() => {}));
    runStore.syncRoutines([{ ...routine, projectName: "alpha" }], {
      now: new Date("2026-05-22T09:59:30.000Z")
    });
    const dispatch = dispatchDueRoutines({
      ...recurringDispatchInput({
        activeRuns,
        provider,
        root,
        routine,
        runStore
      }),
      cancellationSettleMs: 25,
      createFiringId: () => "wedged-snapshot-fire",
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        listIssues,
        listOpenIssues: vi.fn().mockResolvedValue([]),
        listPullRequestsForBranch: vi.fn().mockResolvedValue([])
      },
      prepareRoutineWorkspace: () =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    });

    try {
      await vi.waitFor(() => {
        expect(listIssues).toHaveBeenCalled();
      });
      expect(runStore.getRoutineFiring("wedged-snapshot-fire")?.state).toBe(
        "running"
      );
      expect(activeRuns.countInFlight()).toBe(1);

      const watchdogConfig = {
        enabled: true,
        graceMinutes: 1,
        maxRunMinutes: 0,
        mtimeIgnore: [],
        mtimeInclude: [],
        outputTokenBudget: 0,
        sampleIntervalSeconds: 60
      };
      await reconcileWatchdog({
        activeRuns,
        config: watchdogConfig,
        now: () => new Date("2026-05-22T10:00:00.000Z"),
        runStore
      });
      expect(
        await reconcileWatchdog({
          activeRuns,
          config: watchdogConfig,
          now: () => new Date("2026-05-22T10:01:00.000Z"),
          runStore
        })
      ).toEqual({ sampled: 1, terminated: 1 });

      await dispatch;
      expect(provider.runAttempt).not.toHaveBeenCalled();
      expect(runStore.getRoutineFiring("wedged-snapshot-fire")).toMatchObject({
        cancelReason: "no_progress",
        cancelRequested: true,
        state: "failed",
        terminalReason: "no_progress"
      });
      expect(activeRuns.countInFlight()).toBe(0);
    } finally {
      await dispatch.catch(() => undefined);
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
      await dispatchDueRoutinesAndDrain({
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
    "holds a due routine when its provider is missing from the %s",
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
        const result = await dispatchDueRoutinesAndDrain({
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
          deferred: [],
          fired: [],
          missed: [],
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
        expect(runStore.listReadyRoutineFanouts()[0]).toMatchObject({
          failureCount: 1,
          targets: [
            expect.objectContaining({
              disposition: "held",
              holdReason:
                missingFrom === "providers config"
                  ? "provider_command_missing: claude"
                  : "provider_not_registered: claude",
              projectName: "alpha"
            })
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
      const result = await dispatchDueRoutinesAndDrain({
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

function dueRoutineProjectFixture(
  root: string,
  provider: "codex" | "claude"
): RunControllerProjectConfig {
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
