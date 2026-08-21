import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeConfigReloader } from "../src/reload.js";
import { openRunStore } from "../src/run-store.js";
import {
  REQUIRED_OPERATIONAL_LABELS,
  runDoctor,
  runInitProject,
  type GitHubApi
} from "../src/doctor.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import { dispatchDueRoutines } from "../src/routines/dispatcher.js";
import type { PreparedRoutineWorkspace } from "../src/routines/workspace.js";
import type {
  AgentProvider,
  AgentProviderRegistry,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type { RunControllerProjectConfig } from "../src/lifecycle/run-controller.js";
import type { TargetedRoutineDeclaration } from "../src/routines/types.js";
import {
  doctorTestEnv,
  prepareDoctorTestEnvironment
} from "./helpers/doctor-environment.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-rh-test-"));
  tempRoots.push(root);
  await prepareDoctorTestEnvironment(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function fakeAgentProviders(): AgentProviderRegistry {
  return {
    codex: {
      cancel: () => Promise.resolve(),
      name: "codex",
      runAttempt: async function* () {
        await Promise.resolve();
        yield* [];
      },
      validate: () => Promise.resolve()
    }
  };
}

async function createGitRepo(root: string, remote: string): Promise<void> {
  const exec = promisify(execFileCallback);
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "--initial-branch", "main"], { cwd: root });
  await exec("git", ["remote", "add", "origin", remote], { cwd: root });
}

// A Routine Host declaration: name + workspace + agent + mode, optional
// tracker, no tracker/filters/priority/workflow.
function hostProjectLines(
  name: string,
  options: { disabled?: boolean; tracker?: boolean } = {}
): string[] {
  return [
    `  - name: ${name}`,
    "    mode: routine_host",
    ...(options.disabled ? ["    disabled: true"] : []),
    "    workspace:",
    "      root: ./.symphonika/workspaces/" + name,
    "      git:",
    `        remote: git@github.com:pmatos/${name}.git`,
    "        base_branch: main",
    "    agent:",
    "      provider: codex",
    ...(options.tracker
      ? [
          "    tracker:",
          "      kind: github",
          "      owner: pmatos",
          `      repo: ${name}`,
          '      token: "$GITHUB_TOKEN"'
        ]
      : [])
  ];
}

async function writeHostOnlyConfig(
  root: string,
  hosts: Array<{ name: string; tracker?: boolean }>
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"',
      "  claude:",
      '    command: "claude -p"',
      "projects:",
      ...hosts.flatMap((h) =>
        hostProjectLines(h.name, { tracker: h.tracker === true })
      )
    ].join("\n")
  );
}

describe("Routine Host reload (ADR 0062)", () => {
  it("loads a minimal Routine Host (name + workspace + agent + mode) and reloads", async () => {
    const root = await makeTempRoot();
    await writeHostOnlyConfig(root, [{ name: "new-composer-host" }]);

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    expect(reloader.getStatus().errors).toEqual([]);
    const snapshot = reloader.getSnapshot();
    expect(snapshot?.projects.map((p) => p.name)).toEqual([
      "new-composer-host"
    ]);
    expect(snapshot?.projects[0]?.mode).toBe("routine_host");
    expect(snapshot?.projects[0]?.workflow).toBeUndefined();
    // A host never enters the polling list.
    expect(snapshot?.polling.projects).toEqual([]);

    // Reload again — acceptance: "loads, reloads".
    await reloader.reload();
    expect(reloader.getStatus().errors).toEqual([]);
    expect(reloader.getSnapshot()?.projects.map((p) => p.name)).toEqual([
      "new-composer-host"
    ]);
  });

  it("is never polled for issues: no polling entry even when present in the runtime map", async () => {
    const root = await makeTempRoot();
    await writeHostOnlyConfig(root, [{ name: "refactor-host" }]);

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const snapshot = reloader.getSnapshot();
    expect(snapshot?.polling.projects.length).toBe(0);
    expect(snapshot?.projects.map((p) => p.mode)).toEqual(["routine_host"]);
  });

  it("coexists: 7 Routine Hosts plus a Dispatch Project in one symphonika.yml", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work on it.\n");
    const hostNames = [
      "s11",
      "rightkey",
      "petovita",
      "jsse",
      "vow",
      "forseti",
      "pewpew"
    ];
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: symphonika",
        "    mode: dispatch",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/symphonika",
        "      git:",
        "        remote: git@github.com:pmatos/symphonika.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        ...hostNames.flatMap((name) => hostProjectLines(name))
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    expect(reloader.getStatus().errors).toEqual([]);
    const snapshot = reloader.getSnapshot();
    expect(snapshot?.projects.length).toBe(8);
    expect(snapshot?.polling.projects.length).toBe(1);
    expect(snapshot?.polling.projects[0]?.name).toBe("symphonika");
    const hosts =
      snapshot?.projects.filter((p) => p.mode === "routine_host") ?? [];
    expect(hosts.length).toBe(7);
  });

  it("rejects a Project with no tracker and no mode as a validation error", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: forgot-tracker",
        "    workspace:",
        "      root: ./.symphonika/workspaces/forgot-tracker",
        "      git:",
        "        remote: git@github.com:pmatos/forgot-tracker.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex"
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    // Default mode is dispatch, which requires tracker — so this must error,
    // not silently become a non-dispatching Project.
    expect(reloader.getStatus().errors.length).toBeGreaterThan(0);
    // The project must not be loaded as a silent non-dispatching Project.
    expect(reloader.getSnapshot()?.projects ?? []).toEqual([]);
  });

  it("rejects a kind: git routine targeting a tracker-less Routine Host at declaration time", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "refactor-audit.md"),
      [
        "---",
        "name: refactor-audit",
        "kind: git",
        "schedule:",
        '  cron: "0 1 * * 1-5"',
        "  tz: Etc/UTC",
        "---",
        "Run an audit."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        ...hostProjectLines("audit-host"), // no tracker
        "routines:",
        "  - projects: [audit-host]",
        "    path: ./refactor-audit.md"
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    expect(
      reloader
        .getStatus()
        .errors.some((e) => e.includes("kind: git routine requires a tracker"))
    ).toBe(true);
    // The rejected routine must not be attached to the host.
    const host = reloader
      .getSnapshot()
      ?.projects.find((p) => p.name === "audit-host");
    expect(host?.routines ?? []).toEqual([]);
  });

  it("soft-disables a persisted kind: git routine rejected by a tracker-less host and restores it when the tracker returns", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "refactor-audit.md"),
      [
        "---",
        "name: refactor-audit",
        "kind: git",
        "schedule:",
        '  cron: "0 1 * * *"',
        "  tz: Etc/UTC",
        "---",
        "Run an audit."
      ].join("\n")
    );
    const writeConfig = (tracker: boolean): Promise<void> =>
      writeFile(
        configPath,
        [
          "state:",
          "  root: ./.symphonika",
          "providers:",
          "  codex:",
          '    command: "codex -p symphonika"',
          "  claude:",
          '    command: "claude -p"',
          "projects:",
          ...hostProjectLines("audit-host", { tracker }),
          "routines:",
          "  - projects: [audit-host]",
          "    path: ./refactor-audit.md"
        ].join("\n")
      );

    await writeConfig(true);
    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const runStore = openRunStore({ stateRoot });
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.reject(
          new Error("rejected routine must not prepare a workspace")
        )
    );
    const dispatch = (now: Date) =>
      dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: fakeAgentProviders(),
        configDir: root,
        globalConcurrency: { maxInFlight: undefined },
        now,
        prepareRoutineWorkspace,
        projects: reloader.projectsByName(),
        providersConfig: reloader.providersConfig(),
        runStore,
        stateRoot
      });

    try {
      await dispatch(new Date("2026-07-27T00:00:00.000Z"));
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          name: "refactor-audit",
          state: "active"
        })
      );

      await writeConfig(false);
      await reloader.reload();
      const rejected = await dispatch(new Date("2026-07-27T02:00:00.000Z"));

      expect(rejected.fired).toEqual([]);
      expect(prepareRoutineWorkspace).not.toHaveBeenCalled();
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: "rejected_tracker_less_host",
          name: "refactor-audit",
          state: "disabled"
        })
      );

      await writeConfig(true);
      await reloader.reload();
      await dispatch(new Date("2026-07-27T02:00:00.000Z"));
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: null,
          name: "refactor-audit",
          state: "active"
        })
      );
    } finally {
      runStore.close();
    }
  });

  it("expires a first-seen one-shot kind: git routine rejected on a tracker-less host when the tracker returns after its at elapsed", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "audit-fix.md"),
      [
        "---",
        "name: audit-fix",
        "kind: git",
        "schedule:",
        '  at: "2026-07-27T01:00:00.000Z"',
        "---",
        "Fix the audit."
      ].join("\n")
    );
    const writeConfig = (tracker: boolean): Promise<void> =>
      writeFile(
        configPath,
        [
          "state:",
          "  root: ./.symphonika",
          "providers:",
          "  codex:",
          '    command: "codex -p symphonika"',
          "  claude:",
          '    command: "claude -p"',
          "projects:",
          ...hostProjectLines("audit-host", { tracker }),
          "routines:",
          "  - projects: [audit-host]",
          "    path: ./audit-fix.md"
        ].join("\n")
      );

    await writeConfig(false);
    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    expect(
      reloader
        .getStatus()
        .errors.some((e) => e.includes("kind: git routine requires a tracker"))
    ).toBe(true);
    const runStore = openRunStore({ stateRoot });
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.reject(
          new Error("expired one-shot must not prepare a workspace")
        )
    );
    const dispatch = (now: Date) =>
      dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: fakeAgentProviders(),
        configDir: root,
        globalConcurrency: { maxInFlight: undefined },
        now,
        prepareRoutineWorkspace,
        projects: reloader.projectsByName(),
        providersConfig: reloader.providersConfig(),
        runStore,
        stateRoot
      });

    try {
      // First-seen rejection with no prior persisted row: the rejection
      // evidence must still be recorded so a later restore can apply the
      // one-shot restore rules instead of treating it as a new declaration.
      const rejected = await dispatch(new Date("2026-07-27T00:30:00.000Z"));
      expect(rejected.fired).toEqual([]);
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: "rejected_tracker_less_host",
          name: "audit-fix",
          state: "disabled"
        })
      );

      // The tracker returns after the one-shot's `at` elapsed: the restore
      // must expire it, never fire the overdue full-permission routine.
      await writeConfig(true);
      await reloader.reload();
      const restored = await dispatch(new Date("2026-07-27T02:00:00.000Z"));

      expect(restored.fired).toEqual([]);
      expect(prepareRoutineWorkspace).not.toHaveBeenCalled();
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: null,
          lastFiredAt: null,
          name: "audit-fix",
          state: "expired"
        })
      );
    } finally {
      runStore.close();
    }
  });

  it("activates a first-seen one-shot kind: git routine rejected on a tracker-less host when the tracker returns before its at", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "audit-fix.md"),
      [
        "---",
        "name: audit-fix",
        "kind: git",
        "schedule:",
        '  at: "2026-07-27T01:00:00.000Z"',
        "---",
        "Fix the audit."
      ].join("\n")
    );
    const writeConfig = (tracker: boolean): Promise<void> =>
      writeFile(
        configPath,
        [
          "state:",
          "  root: ./.symphonika",
          "providers:",
          "  codex:",
          '    command: "codex -p symphonika"',
          "  claude:",
          '    command: "claude -p"',
          "projects:",
          ...hostProjectLines("audit-host", { tracker }),
          "routines:",
          "  - projects: [audit-host]",
          "    path: ./audit-fix.md"
        ].join("\n")
      );

    await writeConfig(false);
    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const runStore = openRunStore({ stateRoot });
    const dispatch = (now: Date) =>
      dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: fakeAgentProviders(),
        configDir: root,
        globalConcurrency: { maxInFlight: undefined },
        now,
        prepareRoutineWorkspace: vi.fn(),
        projects: reloader.projectsByName(),
        providersConfig: reloader.providersConfig(),
        runStore,
        stateRoot
      });

    try {
      await dispatch(new Date("2026-07-27T00:30:00.000Z"));
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: "rejected_tracker_less_host",
          name: "audit-fix",
          state: "disabled"
        })
      );

      // The tracker returns before the one-shot's `at`: the restore
      // reactivates it with the declared fire time still ahead.
      await writeConfig(true);
      await reloader.reload();
      const restored = await dispatch(new Date("2026-07-27T00:45:00.000Z"));

      expect(restored.fired).toEqual([]);
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: null,
          name: "audit-fix",
          nextFireAt: "2026-07-27T01:00:00.000Z",
          state: "active"
        })
      );
    } finally {
      runStore.close();
    }
  });

  it("expires a first-seen one-shot kind: git routine whose at was edited while rejected and still elapsed when the tracker returns", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(root, { recursive: true });
    const writeRoutine = (at: string): Promise<void> =>
      writeFile(
        path.join(root, "audit-fix.md"),
        [
          "---",
          "name: audit-fix",
          "kind: git",
          "schedule:",
          `  at: "${at}"`,
          "---",
          "Fix the audit."
        ].join("\n")
      );
    const writeConfig = (tracker: boolean): Promise<void> =>
      writeFile(
        configPath,
        [
          "state:",
          "  root: ./.symphonika",
          "providers:",
          "  codex:",
          '    command: "codex -p symphonika"',
          "  claude:",
          '    command: "claude -p"',
          "projects:",
          ...hostProjectLines("audit-host", { tracker }),
          "routines:",
          "  - projects: [audit-host]",
          "    path: ./audit-fix.md"
        ].join("\n")
      );

    await writeRoutine("2026-07-27T01:00:00.000Z");
    await writeConfig(false);
    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const runStore = openRunStore({ stateRoot });
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.reject(
          new Error("expired one-shot must not prepare a workspace")
        )
    );
    const dispatch = (now: Date) =>
      dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: fakeAgentProviders(),
        configDir: root,
        globalConcurrency: { maxInFlight: undefined },
        now,
        prepareRoutineWorkspace,
        projects: reloader.projectsByName(),
        providersConfig: reloader.providersConfig(),
        runStore,
        stateRoot
      });

    try {
      await dispatch(new Date("2026-07-27T00:30:00.000Z"));
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: "rejected_tracker_less_host",
          name: "audit-fix",
          state: "disabled"
        })
      );

      // The operator edits `at` while the host is still tracker-less; the new
      // time also elapses before the tracker returns. The schedule change must
      // not reactivate the restore into an immediate retroactive firing.
      await writeRoutine("2026-07-27T01:30:00.000Z");
      await reloader.reload();
      await dispatch(new Date("2026-07-27T01:00:00.000Z"));

      await writeConfig(true);
      await reloader.reload();
      const restored = await dispatch(new Date("2026-07-27T02:00:00.000Z"));

      expect(restored.fired).toEqual([]);
      expect(prepareRoutineWorkspace).not.toHaveBeenCalled();
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: null,
          lastFiredAt: null,
          name: "audit-fix",
          scheduleAt: "2026-07-27T01:30:00.000Z",
          state: "expired"
        })
      );
    } finally {
      runStore.close();
    }
  });

  it("expires an elapsed first-seen rejection when a disabled host and its tracker are restored together", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(root, { recursive: true });
    const writeRoutine = (at: string): Promise<void> =>
      writeFile(
        path.join(root, "audit-fix.md"),
        [
          "---",
          "name: audit-fix",
          "kind: git",
          "schedule:",
          `  at: "${at}"`,
          "---",
          "Fix the audit."
        ].join("\n")
      );
    const writeConfig = (options: {
      disabled: boolean;
      tracker: boolean;
    }): Promise<void> =>
      writeFile(
        configPath,
        [
          "state:",
          "  root: ./.symphonika",
          "providers:",
          "  codex:",
          '    command: "codex -p symphonika"',
          "  claude:",
          '    command: "claude -p"',
          "projects:",
          ...hostProjectLines("audit-host", options),
          "routines:",
          "  - projects: [audit-host]",
          "    path: ./audit-fix.md"
        ].join("\n")
      );

    await writeRoutine("2026-07-27T01:00:00.000Z");
    await writeConfig({ disabled: true, tracker: false });
    const reloader = new RuntimeConfigReloader({ configPath });
    await reloader.reload();
    const runStore = openRunStore({ stateRoot });
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.reject(
          new Error("expired one-shot must not prepare a workspace")
        )
    );
    const dispatch = (now: Date) =>
      dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: fakeAgentProviders(),
        configDir: root,
        globalConcurrency: { maxInFlight: undefined },
        now,
        prepareRoutineWorkspace,
        projects: reloader.projectsByName(),
        providersConfig: reloader.providersConfig(),
        runStore,
        stateRoot
      });

    try {
      // Project inactivity dominates the routine-level rejection state, but
      // the first-seen declaration still needs a durable row for restoration.
      await dispatch(new Date("2026-07-27T00:30:00.000Z"));
      expect(runStore.listRoutines({ includeInactive: true })).toContainEqual(
        expect.objectContaining({
          disabledReason: null,
          name: "audit-fix",
          scheduleAt: "2026-07-27T01:00:00.000Z",
          state: "inactive"
        })
      );

      // Editing `at` while the host stays disabled must not turn a past
      // schedule into an immediately fireable declaration when the Project
      // and tracker are restored in the same reload.
      await writeRoutine("2026-07-27T01:30:00.000Z");
      await reloader.reload();
      await dispatch(new Date("2026-07-27T01:00:00.000Z"));
      await writeConfig({ disabled: false, tracker: true });
      await reloader.reload();
      const restored = await dispatch(new Date("2026-07-27T02:00:00.000Z"));

      expect(restored.fired).toEqual([]);
      expect(prepareRoutineWorkspace).not.toHaveBeenCalled();
      expect(runStore.listRoutines()).toContainEqual(
        expect.objectContaining({
          disabledReason: null,
          lastFiredAt: null,
          name: "audit-fix",
          scheduleAt: "2026-07-27T01:30:00.000Z",
          state: "expired"
        })
      );
    } finally {
      runStore.close();
    }
  });

  it("rejects the removed per-project routines: key with a migration error", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work on it.\n");
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "kind: report",
        "schedule:",
        "  cron: 0 2 * * *",
        "  tz: Etc/UTC",
        "---",
        "Report."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: symphonika",
        "    mode: dispatch",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/symphonika",
        "      git:",
        "        remote: git@github.com:pmatos/symphonika.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        "    routines:", // legacy per-project key — must be rejected
        "      - ./daily-report.md"
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    expect(
      reloader
        .getStatus()
        .errors.some((e) => e.includes("per-project `routines:` was removed"))
    ).toBe(true);
  });

  it("rejects dispatch-only fields (issue_filters, priority, workflow) on a Routine Host", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: stale-host",
        "    mode: routine_host",
        "    workspace:",
        "      root: ./.symphonika/workspaces/stale-host",
        "      git:",
        "        remote: git@github.com:pmatos/stale-host.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    issue_filters:", // dispatch-only — must be rejected on a host
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workflow: ./WORKFLOW.md"
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const errors = reloader.getStatus().errors;
    expect(errors.some((e) => e.includes("issue_filters"))).toBe(true);
    expect(errors.some((e) => e.includes("priority"))).toBe(true);
    expect(errors.some((e) => e.includes("workflow"))).toBe(true);
  });

  it("reserves a brand-new invalid declaration's recovered name against a later valid same-named routine", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "broken-routine.md"),
      [
        "---",
        "name: shared-name",
        "kind: bogus-kind", // invalid kind — stays invalid, but name is path-safe
        "schedule:",
        "  cron: 0 1 * * *",
        "  tz: Etc/UTC",
        "---",
        "Body."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "valid-routine.md"),
      [
        "---",
        "name: shared-name",
        "kind: report",
        "schedule:",
        "  cron: 0 2 * * *",
        "  tz: Etc/UTC",
        "---",
        "Report."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        ...hostProjectLines("host-a"),
        ...hostProjectLines("host-b"),
        "routines:",
        "  - projects: [host-a]",
        "    path: ./broken-routine.md",
        "  - projects: [host-b]",
        "    path: ./valid-routine.md"
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const errors = reloader.getStatus().errors;
    expect(
      errors.some((e) => e.includes('duplicate routine name "shared-name"'))
    ).toBe(true);
    // The later, otherwise-valid declaration must not be attached/fire while
    // its name collides with the earlier broken declaration.
    const hostB = reloader
      .getSnapshot()
      ?.projects.find((p) => p.name === "host-b");
    expect(hostB?.routines ?? []).toEqual([]);
  });

  it("rejects a routine targeting a duplicated Project name instead of silently attaching it to a shadowed duplicate", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "kind: report",
        "schedule:",
        "  cron: 0 3 * * *",
        "  tz: Etc/UTC",
        "---",
        "Report."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        ...hostProjectLines("shared-host"),
        ...hostProjectLines("shared-host"),
        "routines:",
        "  - projects: [shared-host]",
        "    path: ./daily-report.md"
      ].join("\n")
    );

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const status = reloader.getStatus();
    expect(status.ok).toBe(false);
    expect(
      status.errors.some((e) =>
        e.includes('"shared-host" is declared more than once')
      )
    ).toBe(true);
    const duplicates = reloader
      .getSnapshot()
      ?.projects.filter((p) => p.name === "shared-host");
    expect(duplicates?.length).toBe(2);
    for (const project of duplicates ?? []) {
      expect(project.routines ?? []).toEqual([]);
    }
  });
});

describe("Routine Host doctor (ADR 0062)", () => {
  function githubApiWithLabels(labels: string[]): GitHubApi {
    return {
      createLabel: vi.fn().mockResolvedValue(undefined),
      listLabels: vi.fn().mockResolvedValue(labels),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };
  }

  it("reports a Routine Host valid without sym:* labels existing in the repo", async () => {
    const root = await makeTempRoot();
    await writeHostOnlyConfig(root, [{ name: "new-composer-host" }]);
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      githubApi: githubApiWithLabels([]), // no labels at all
      homeDir: root,
      offline: true
    });

    expect(report.ok).toBe(true);
    expect(report.projects.length).toBe(1);
    expect(report.projects[0]?.mode).toBe("routine_host");
    expect(report.projects[0]?.validForHosting).toBe(true);
    expect(report.projects[0]?.validForDispatch).toBe(false);
    expect(report.projects[0]?.missingOperationalLabels).toEqual([]);
  });

  it("rejects dispatch-only fields (issue_filters, priority, workflow) on a Routine Host", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: stale-host",
        "    mode: routine_host",
        "    workspace:",
        "      root: ./.symphonika/workspaces/stale-host",
        "      git:",
        "        remote: git@github.com:pmatos/stale-host.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    priority:", // dispatch-only — must be rejected on a host
        "      labels: {}",
        "      default: 99"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      githubApi: githubApiWithLabels([]),
      homeDir: root,
      offline: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("priority"))).toBe(true);
  });

  it("rejects an invalid max_in_flight on a Routine Host instead of passing it through", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: capped-host",
        "    mode: routine_host",
        "    max_in_flight: 0", // invalid — must be a positive integer
        "    workspace:",
        "      root: ./.symphonika/workspaces/capped-host",
        "      git:",
        "        remote: git@github.com:pmatos/capped-host.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      githubApi: githubApiWithLabels([]),
      homeDir: root,
      offline: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("max_in_flight"))).toBe(true);
  });

  it("reserves a brand-new invalid declaration's recovered name in validateServiceRoutines too", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "broken-routine.md"),
      [
        "---",
        "name: shared-name",
        "kind: bogus-kind",
        "schedule:",
        "  cron: 0 1 * * *",
        "  tz: Etc/UTC",
        "---",
        "Body."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "valid-routine.md"),
      [
        "---",
        "name: shared-name",
        "kind: report",
        "schedule:",
        "  cron: 0 2 * * *",
        "  tz: Etc/UTC",
        "---",
        "Report."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        ...hostProjectLines("host-a"),
        ...hostProjectLines("host-b"),
        "routines:",
        "  - projects: [host-a]",
        "    path: ./broken-routine.md",
        "  - projects: [host-b]",
        "    path: ./valid-routine.md"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      githubApi: githubApiWithLabels([]),
      homeDir: root,
      offline: true
    });

    expect(report.ok).toBe(false);
    expect(
      report.errors.some((e) =>
        e.includes('duplicate routine name "shared-name"')
      )
    ).toBe(true);
  });

  it("validates a routine's target project even when its own declaration fails to load", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "broken-routine.md"),
      [
        "---",
        "name: broken-routine",
        "kind: bogus-kind",
        "schedule:",
        "  cron: 0 1 * * *",
        "  tz: Etc/UTC",
        "---",
        "Body."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        ...hostProjectLines("host-a"),
        "routines:",
        "  - projects: [nonexistent-project]",
        "    path: ./broken-routine.md"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      githubApi: githubApiWithLabels([]),
      homeDir: root,
      offline: true
    });

    expect(report.ok).toBe(false);
    expect(
      report.errors.some(
        (e) =>
          e.includes('routines entry targets project "nonexistent-project"') &&
          e.includes("no project with that name is declared")
      )
    ).toBe(true);
    expect(report.errors.some((e) => e.includes("kind"))).toBe(true);
  });

  it("rejects a routine targeting a duplicated Project name instead of resolving it to an arbitrary duplicate", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "kind: report",
        "schedule:",
        "  cron: 0 3 * * *",
        "  tz: Etc/UTC",
        "---",
        "Report."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        ...hostProjectLines("shared-host"),
        ...hostProjectLines("shared-host"),
        "routines:",
        "  - projects: [shared-host]",
        "    path: ./daily-report.md"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      githubApi: githubApiWithLabels([]),
      homeDir: root,
      offline: true
    });

    expect(report.ok).toBe(false);
    expect(
      report.errors.some((e) =>
        e.includes('"shared-host" is declared more than once')
      )
    ).toBe(true);
  });

  it("is green with 7 Routine Hosts plus a Dispatch Project (sym:* labels exist only for dispatch)", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work on it.\n");
    const hostNames = [
      "s11",
      "rightkey",
      "petovita",
      "jsse",
      "vow",
      "forseti",
      "pewpew"
    ];
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        "  - name: symphonika",
        "    mode: dispatch",
        "    tracker:",
        "      kind: github",
        "      owner: pmatos",
        "      repo: symphonika",
        '      token: "$GITHUB_TOKEN"',
        "    issue_filters:",
        '      states: ["open"]',
        '      labels_all: ["agent-ready"]',
        '      labels_none: ["blocked"]',
        "    priority:",
        "      labels: {}",
        "      default: 99",
        "    workspace:",
        "      root: ./.symphonika/workspaces/symphonika",
        "      git:",
        "        remote: git@github.com:pmatos/symphonika.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex",
        "    workflow: ./WORKFLOW.md",
        ...hostNames.flatMap((name) => hostProjectLines(name))
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      // The dispatch repo has all required labels; the hosts have no tracker,
      // so no repo access / label checks run for them.
      githubApi: {
        createLabel: vi.fn().mockResolvedValue(undefined),
        listLabels: vi
          .fn()
          .mockResolvedValue(["agent-ready", ...REQUIRED_OPERATIONAL_LABELS]),
        validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
      },
      homeDir: root,
      offline: true
    });

    expect(report.ok).toBe(true);
    expect(report.projects.length).toBe(8);
    const hosts = report.projects.filter((p) => p.mode === "routine_host");
    expect(hosts.length).toBe(7);
    expect(hosts.every((h) => h.validForHosting)).toBe(true);
    const dispatch = report.projects.find((p) => p.mode === "dispatch");
    expect(dispatch?.validForDispatch).toBe(true);
  });

  it("flips a host's validForHosting to false for kind: git without tracker", async () => {
    const root = await makeTempRoot();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "refactor-audit.md"),
      [
        "---",
        "name: refactor-audit",
        "kind: git",
        "schedule:",
        '  cron: "0 1 * * 1-5"',
        "  tz: Etc/UTC",
        "---",
        "Run an audit."
      ].join("\n")
    );
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"',
        "  claude:",
        '    command: "claude -p"',
        "projects:",
        ...hostProjectLines("audit-host"), // no tracker
        "routines:",
        "  - projects: [audit-host]",
        "    path: ./refactor-audit.md"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: doctorTestEnv(root, { GITHUB_TOKEN: "test-token" }),
      githubApi: githubApiWithLabels([]),
      homeDir: root,
      offline: true
    });

    // The declaration error is reported...
    expect(report.ok).toBe(false);
    expect(
      report.errors.some((e) =>
        e.includes("kind: git routine requires a tracker")
      )
    ).toBe(true);
    // ...AND the host is marked not valid for hosting (not self-contradictory).
    const host = report.projects.find((p) => p.name === "audit-host");
    expect(host?.validForHosting).toBe(false);
  });
});

describe("init-project --mode routine-host (ADR 0062)", () => {
  it("scaffolds a Routine Host without prompting for issue filters, priority, or labels", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "host-repo");
    await createGitRepo(repositoryRoot, "git@github.com:pmatos/host.git");
    // Minimal user config with empty projects.
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"',
        "  claude:",
        '    command: "claude -p"',
        "projects: []"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    // Use --yes so no prompts fire. In routine-host mode, the only prompts
    // would be project name / provider / base branch / workspace root.
    const report = await runInitProject({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: repositoryRoot,
      env: process.env,
      mode: "routine_host",
      yes: true,
      githubApi: {
        createLabel: vi.fn().mockResolvedValue(undefined),
        listLabels: vi.fn().mockResolvedValue([]),
        validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
      }
    });

    expect(report.ok).toBe(true);
    expect(report.projects.length).toBe(1);
    // No operational or eligibility labels created for a host.
    expect(report.projects[0]?.createdOperationalLabels).toEqual([]);
    expect(report.projects[0]?.createdEligibilityLabels).toEqual([]);
    // No workflow contract created for a host.
    expect(report.createdWorkflowPath).toBeNull();
    // The config now contains a routine_host project.
    const written = await readFile(path.join(root, "symphonika.yml"), "utf8");
    expect(written).toContain("mode: routine_host");
    expect(written).not.toContain("issue_filters");
    expect(written).not.toContain("priority:");
  });
  it("prompts for workspace root but not issue filters, priority, or labels in host mode", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "host-repo");
    await createGitRepo(repositoryRoot, "git@github.com:pmatos/host.git");
    await writeFile(
      path.join(root, "symphonika.yml"),
      [
        "state:",
        "  root: ./.symphonika",
        "providers:",
        "  codex:",
        '    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"',
        "  claude:",
        '    command: "claude -p"',
        "projects: []"
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-token";

    const promptedKeys: string[] = [];
    const report = await runInitProject({
      agentProviders: fakeAgentProviders(),
      configPath: path.join(root, "symphonika.yml"),
      cwd: repositoryRoot,
      env: process.env,
      mode: "routine_host",
      prompt: (input) => {
        promptedKeys.push(input.key);
        return Promise.resolve(input.defaultValue);
      },
      githubApi: {
        createLabel: vi.fn().mockResolvedValue(undefined),
        listLabels: vi.fn().mockResolvedValue([]),
        validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
      }
    });

    expect(report.ok).toBe(true);
    // Host mode prompts for name, provider, base branch, workspace root — and
    // nothing else. Issue filters, priority labels, workflow path, and label
    // confirmations must be absent.
    expect(promptedKeys).toEqual([
      "projectName",
      "provider",
      "baseBranch",
      "workspaceRoot"
    ]);
    expect(promptedKeys).not.toContain("requiredLabels");
    expect(promptedKeys).not.toContain("excludedLabels");
    expect(promptedKeys).not.toContain("priorityLabels");
    expect(promptedKeys).not.toContain("workflowPath");
    expect(promptedKeys).not.toContain("confirmOperationalLabels");
    expect(promptedKeys).not.toContain("confirmEligibilityLabels");
  });
});

describe("syncRoutines removal-detection (ADR 0063)", () => {
  it("soft-disables only the removed target row from a fanned-out Routine", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const store = openRunStore({ stateRoot });
    const routine = {
      kind: "report" as const,
      name: "refactor-audit",
      prompt: "Audit.",
      provider: null,
      schedule: { cron: "0 2 * * *", tz: "Etc/UTC" },
      sourcePath: "/tmp/refactor-audit.md"
    };
    try {
      store.syncRoutines(
        [
          { ...routine, projectName: "alpha" },
          { ...routine, projectName: "beta" }
        ],
        { now: new Date("2026-05-20T00:00:00.000Z") }
      );

      store.syncRoutines([{ ...routine, projectName: "alpha" }], {
        now: new Date("2026-05-21T00:00:00.000Z"),
        projects: ["alpha", "beta"]
      });

      expect(store.listRoutines({ project: "alpha" })[0]).toMatchObject({
        disabledReason: null,
        name: "refactor-audit",
        state: "active"
      });
      expect(store.listRoutines({ project: "beta" })[0]).toMatchObject({
        disabledReason: "removed_from_config",
        name: "refactor-audit",
        state: "disabled"
      });
    } finally {
      store.close();
    }
  });

  it("soft-disables the last routine when a project's routines go to zero", async () => {
    // Regression: syncRoutines([]) with no `projects` would never enter the
    // per-project loop, leaving a removed routine's row active. The `projects`
    // option seeds the loop so removal-detection runs for empty projects too.
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const store = openRunStore({ stateRoot });
    try {
      // Seed one routine targeting alpha.
      store.syncRoutines(
        [
          {
            kind: "report" as const,
            name: "daily-report",
            projectName: "alpha",
            prompt: "Report.",
            provider: null,
            schedule: { cron: "0 2 * * *", tz: "Etc/UTC" },
            sourcePath: "/tmp/daily-report.md"
          }
        ],
        { now: new Date("2026-05-20T00:00:00.000Z") }
      );
      expect(store.listRoutines({ project: "alpha" })[0]?.state).toBe("active");

      // Remove the last routine — alpha has zero routines now but must still
      // run removal-detection because `projects: ["alpha"]` seeds the loop.
      store.syncRoutines([], {
        now: new Date("2026-05-21T00:00:00.000Z"),
        projects: ["alpha"]
      });
      const after = store.listRoutines({ project: "alpha" })[0];
      expect(after?.state).toBe("disabled");
      expect(after?.disabledReason).toBe("removed_from_config");
    } finally {
      store.close();
    }
  });

  it("does not touch another project's routines when one project empties", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const store = openRunStore({ stateRoot });
    try {
      store.syncRoutines(
        [
          {
            kind: "report" as const,
            name: "alpha-report",
            projectName: "alpha",
            prompt: "Report.",
            provider: null,
            schedule: { cron: "0 2 * * *", tz: "Etc/UTC" },
            sourcePath: "/tmp/alpha-report.md"
          },
          {
            kind: "report" as const,
            name: "beta-report",
            projectName: "beta",
            prompt: "Report.",
            provider: null,
            schedule: { cron: "0 3 * * *", tz: "Etc/UTC" },
            sourcePath: "/tmp/beta-report.md"
          }
        ],
        { now: new Date("2026-05-20T00:00:00.000Z") }
      );

      // Empty alpha only; beta's routine must stay active.
      store.syncRoutines(
        [
          {
            kind: "report" as const,
            name: "beta-report",
            projectName: "beta",
            prompt: "Report.",
            provider: null,
            schedule: { cron: "0 3 * * *", tz: "Etc/UTC" },
            sourcePath: "/tmp/beta-report.md"
          }
        ],
        {
          now: new Date("2026-05-21T00:00:00.000Z"),
          projects: ["alpha", "beta"]
        }
      );
      expect(store.listRoutines({ project: "alpha" })[0]?.state).toBe(
        "disabled"
      );
      expect(store.listRoutines({ project: "beta" })[0]?.state).toBe("active");
    } finally {
      store.close();
    }
  });
});

describe("dispatchDueRoutines targets a Routine Host (ADR 0062/0063)", () => {
  it("fires a service-level kind: report routine targeting a Routine Host by name", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const workspacePath = path.join(root, "host-workspace");
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

    // A Routine Host: name + workspace + agent + mode. No tracker (a report
    // routine needs none), no issue_filters/priority/workflow.
    const hostProject: RunControllerProjectConfig = {
      agent: { provider: "codex" },
      mode: "routine_host",
      name: "new-composer-host",
      routines: [],
      workspace: {
        git: {
          base_branch: "main",
          remote: "git@github.com:pmatos/music-timeline.git"
        },
        root: "./.symphonika/workspaces/new-composer-host"
      }
    };
    const routine: TargetedRoutineDeclaration = {
      kind: "report",
      name: "new-composer",
      projectName: "new-composer-host",
      prompt: "Compose a daily report for {{project.name}}.",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: path.join(root, "new-composer.md")
    };
    hostProject.routines = [routine];

    try {
      const result = await dispatchDueRoutines({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: provider },
        configDir: root,
        createFiringId: () => "01JABCDEFGHJKMNPQRSTVWXYZ12",
        env: { GITHUB_TOKEN: "secret-token" },
        globalConcurrency: { maxInFlight: undefined },
        now: new Date("2026-05-22T10:00:01.000Z"),
        prepareRoutineWorkspace,
        projects: new Map([["new-composer-host", hostProject]]),
        providersConfig: {
          claude: { command: "claude fake" },
          codex: { command: "codex fake" }
        },
        runStore,
        stateRoot
      });

      // The service-level routine targeted the host and fired.
      expect(result.fired).toEqual(["01JABCDEFGHJKMNPQRSTVWXYZ12"]);
      expect(prepareRoutineWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "report",
          routineName: "new-composer"
        })
      );
      // The provider ran in the host's workspace with the host's project name.
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]?.workspacePath).toBe(workspacePath);
      expect(providerInputs[0]?.prompt).toContain("new-composer-host");
      // A Routine Firing row was recorded against the host project.
      expect(runStore.listRoutineFirings()).toEqual([
        expect.objectContaining({
          id: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          state: "succeeded"
        })
      ]);
    } finally {
      runStore.close();
    }
  });
});
