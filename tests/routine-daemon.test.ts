import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCli } from "../src/cli.js";
import { startDaemon } from "../src/daemon.js";
import { openRunStore } from "../src/run-store.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type { PreparedRoutineWorkspace } from "../src/routines/workspace.js";

const tempRoots: string[] = [];

type RoutineApiRow = {
  lastFiredAt: string | null;
  name: string;
  nextFireAt: string | null;
  projectName: string;
  state: string;
};

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-routine-daemon-"));
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

describe("daemon routine firing", () => {
  it("fires a one-shot kind: report routine once after the scheduled time", async () => {
    const root = await makeTempRoot();
    const fireAt = new Date(Date.now() + 50).toISOString();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "alpha",
      "routines",
      "daily-report",
      "routine-fire-1"
    );
    await writeRoutineProject(root, fireAt);
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
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRoutineFiringId: () => "routine-fire-1",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace
    });

    try {
      const routines = await waitForRoutine(daemon.url, "expired");
      expect(routines).toHaveLength(1);
      const routine = routines[0];
      expect(routine?.lastFiredAt).toEqual(expect.any(String));
      expect(routine).toMatchObject({
        name: "daily-report",
        nextFireAt: null,
        projectName: "alpha",
        state: "expired"
      });
      const status = (await fetch(`${daemon.url}/api/status`).then((response) =>
        response.json()
      )) as { routines?: RoutineApiRow[] };
      expect(status.routines).toEqual(routines);
      await waitForProviderInputs(providerInputs, 1);
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]?.prompt).toContain(
        "Routine daily-report for alpha."
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      expect(providerInputs).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it("cancels an in-flight routine firing by id, killing the provider and preserving workspace evidence", async () => {
    const root = await makeTempRoot();
    const fireAt = new Date(Date.now() + 50).toISOString();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "alpha",
      "routines",
      "daily-report",
      "routine-fire-cancel"
    );
    await writeRoutineProject(root, fireAt);
    let resolveHold: (() => void) | undefined;
    const holdUntilCancelled = new Promise<void>((resolve) => {
      resolveHold = resolve;
    });
    const provider = {
      cancel: vi.fn(() => {
        resolveHold?.();
        return Promise.resolve();
      }),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        await holdUntilCancelled;
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

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRoutineFiringId: () => "routine-fire-cancel",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace
    });

    try {
      await waitForFiringState(daemon.url, "daily-report", "alpha", "running");

      const cancelResponse = await fetch(
        `${daemon.url}/api/runs/routine-fire-cancel/cancel`,
        { method: "POST" }
      );
      expect(cancelResponse.status).toBe(200);
      expect(await cancelResponse.json()).toEqual({ kind: "cancelled" });

      await vi.waitFor(() => {
        expect(provider.cancel).toHaveBeenCalledWith("routine-fire-cancel");
      });
      const firing = await waitForFiringState(
        daemon.url,
        "daily-report",
        "alpha",
        "cancelled"
      );
      expect(firing).toMatchObject({
        id: "routine-fire-cancel",
        cancelReason: "operator",
        state: "cancelled",
        workspacePath
      });

      // Unknown id
      const notFound = await fetch(`${daemon.url}/api/runs/no-such-id/cancel`, {
        method: "POST"
      });
      expect(notFound.status).toBe(404);

      // Already-terminal firing
      const alreadyTerminal = await fetch(
        `${daemon.url}/api/runs/routine-fire-cancel/cancel`,
        { method: "POST" }
      );
      expect(alreadyTerminal.status).toBe(409);
      expect(await alreadyTerminal.json()).toEqual({
        kind: "already-terminal",
        state: "cancelled"
      });
    } finally {
      await daemon.stop();
    }
  });

  it("keeps a last-known-good Routine live when its declaration reload becomes invalid", async () => {
    const root = await makeTempRoot();
    const fireAt = new Date(Date.now() + 1_000).toISOString();
    const routinePath = path.join(root, "daily-report.md");
    await writeRoutineProject(root, fireAt);
    const provider = quietProvider();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "alpha",
      "routines",
      "daily-report",
      "routine-fire-lkg"
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRoutineFiringId: () => "routine-fire-lkg",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace: vi.fn().mockResolvedValue({
        branchName: "main",
        branchRef: "refs/remotes/origin/main",
        cachePath: path.join(root, ".cache", "repo.git"),
        reused: false,
        workspacePath
      })
    });

    try {
      await waitForRoutine(daemon.url, "active");
      await writeFile(
        routinePath,
        ["---", "name: ../unsafe", "kind: report", "---", "Body", ""].join("\n")
      );
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });

      const status = (await fetch(`${daemon.url}/api/status`).then((response) =>
        response.json()
      )) as {
        reload?: {
          errors: string[];
          ok: boolean;
          usingLastKnownGood: boolean;
        };
      };
      // Per-routine isolation (docs/adr/0060): a single routine's invalidity
      // no longer forces a whole-snapshot last-known-good rollback — only
      // that routine carries forward its own last-known-good declaration.
      expect(status.reload).toMatchObject({
        ok: false,
        usingLastKnownGood: false
      });
      expect(status.reload?.errors.join("\n")).toContain(
        'name "../unsafe" is not path-safe'
      );
      await waitForRoutine(daemon.url, "expired");
      await vi.waitFor(() => {
        expect(provider.runAttempt).toHaveBeenCalledTimes(1);
      });
    } finally {
      await daemon.stop();
    }
  });

  it("gives a brand-new invalid routine declaration a persistent invalid identity across ticks", async () => {
    const root = await makeTempRoot();
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        `  at: ${fireAt}`,
        "kind: report",
        "---",
        "Routine {{routine.name}} for {{project.name}}.",
        ""
      ].join("\n")
    );
    // Valid name, but no schedule/kind — never had a prior valid snapshot.
    await writeFile(
      path.join(root, "broken-routine.md"),
      ["---", "name: broken-routine", "---", "Body", ""].join("\n")
    );
    await writeProjectConfig(root, "alpha", [
      "./daily-report.md",
      "./broken-routine.md"
    ]);
    const provider = quietProvider();

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace: vi.fn()
    });

    try {
      await waitForRoutine(daemon.url, "invalid");
      // Multiple dispatch ticks must not let syncRoutines's removal-detection
      // path demote the stub to disabled/removed_from_config.
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await new Promise((resolve) => setTimeout(resolve, 80));

      const body = (await fetch(`${daemon.url}/api/routines`).then((response) =>
        response.json()
      )) as { routines: RoutineApiRow[] };
      expect(body.routines).toContainEqual(
        expect.objectContaining({
          name: "broken-routine",
          projectName: "alpha",
          state: "invalid"
        })
      );
      expect(body.routines).toContainEqual(
        expect.objectContaining({ name: "daily-report", state: "active" })
      );
      expect(provider.runAttempt).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it("hides disabled Project routines and restores expired one-shots without refiring", async () => {
    const root = await makeTempRoot();
    await writeRoutineProject(root, "2026-05-22T10:00:00.000Z");
    const provider = quietProvider();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "alpha",
      "routines",
      "daily-report",
      "routine-fire-1"
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRoutineFiringId: () => "routine-fire-1",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace: vi.fn().mockResolvedValue({
        branchName: "main",
        branchRef: "refs/remotes/origin/main",
        cachePath: path.join(root, ".cache", "repo.git"),
        reused: false,
        workspacePath
      })
    });

    try {
      const fired = await waitForRoutine(daemon.url, "expired");
      expect(fired[0]?.lastFiredAt).toEqual(expect.any(String));
      await vi.waitFor(() => {
        expect(provider.runAttempt).toHaveBeenCalledTimes(1);
      });

      await writeProjectConfig(root, "alpha", ["./daily-report.md"], true);
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });

      expect(await waitForNoRoutines(daemon.url)).toEqual([]);
      const inactive = (await fetch(
        `${daemon.url}/api/routines?include_inactive=true`
      ).then((response) => response.json())) as { routines: RoutineApiRow[] };
      expect(inactive.routines).toEqual([
        expect.objectContaining({
          lastFiredAt: fired[0]?.lastFiredAt,
          name: "daily-report",
          projectName: "alpha",
          state: "inactive"
        })
      ]);

      await writeProjectConfig(root, "alpha", ["./daily-report.md"]);
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });

      const restored = await waitForRoutine(daemon.url, "expired");
      expect(restored[0]?.lastFiredAt).toBe(fired[0]?.lastFiredAt);
      expect(provider.runAttempt).toHaveBeenCalledTimes(1);
    } finally {
      await daemon.stop();
    }
  });

  it("prunes routine rows for projects removed from the service config", async () => {
    const root = await makeTempRoot();
    await writeRoutineProject(root, "2030-05-22T10:00:00.000Z");
    const provider = quietProvider();

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace: vi.fn()
    });

    try {
      await waitForRoutine(daemon.url, "active");

      await writeProjectWithoutRoutines(root, "beta");
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      expect(await waitForNoRoutines(daemon.url)).toEqual([]);

      const output = { stderr: "", stdout: "" };
      const program = buildCli({
        openRunStore: () =>
          openRunStore({ stateRoot: path.join(root, ".symphonika") }),
        registerSignalHandlers: false
      });
      program.configureOutput({
        writeErr: (message) => {
          output.stderr += message;
        },
        writeOut: (message) => {
          output.stdout += message;
        }
      });
      program.exitOverride();

      await program.parseAsync([
        "node",
        "symphonika",
        "routines",
        "--config",
        path.join(root, "symphonika.yml")
      ]);

      expect(output.stdout).toBe("(no routines)\n");
    } finally {
      await daemon.stop();
    }
  });

  it("recomputes a recurring next_fire_at on restart without catch-up", async () => {
    const root = await makeTempRoot();
    const routine = {
      kind: "report" as const,
      name: "yearly-report",
      prompt: "Report.",
      provider: null,
      schedule: { cron: "0 0 1 1 *", tz: "Etc/UTC" },
      sourcePath: path.join(root, "yearly-report.md")
    };
    await writeRecurringRoutineProject(root);
    const seededStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    seededStore.syncRoutines("alpha", [routine], {
      now: new Date("2020-06-01T00:00:00.000Z")
    });
    expect(seededStore.listRoutines()[0]?.nextFireAt).toBe(
      "2021-01-01T00:00:00.000Z"
    );
    seededStore.close();

    const provider = quietProvider();
    const startedAt = Date.now();
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace: vi.fn()
    });

    try {
      await waitForRoutine(daemon.url, "active");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const routines = await fetch(`${daemon.url}/api/routines`)
        .then((response) => response.json())
        .then((body) => (body as { routines: RoutineApiRow[] }).routines);

      expect(routines[0]?.lastFiredAt).toBeNull();
      expect(new Date(routines[0]?.nextFireAt ?? 0).getTime()).toBeGreaterThan(
        startedAt
      );
      expect(provider.runAttempt).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it("fires exactly one missed recurring event on restart with catch-up enabled", async () => {
    const root = await makeTempRoot();
    const routine = {
      catchUp: "fire_once_if_missed" as const,
      kind: "report" as const,
      name: "yearly-report",
      prompt: "Report.",
      provider: null,
      schedule: { cron: "0 0 1 1 *", tz: "Etc/UTC" },
      sourcePath: path.join(root, "yearly-report.md")
    };
    await writeRecurringRoutineProject(root, true);
    const seededStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    seededStore.syncRoutines("alpha", [routine], {
      now: new Date("2020-06-01T00:00:00.000Z")
    });
    seededStore.close();
    const providerInputs: ProviderRunInput[] = [];
    const provider = quietProvider();
    vi.mocked(provider.runAttempt).mockImplementation(async function* (input) {
      await Promise.resolve();
      providerInputs.push(input);
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    });
    const startedAt = Date.now();
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRoutineFiringId: () => "catch-up-fire",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace: vi.fn().mockResolvedValue({
        branchName: "main",
        branchRef: "refs/remotes/origin/main",
        cachePath: path.join(root, ".cache", "repo.git"),
        reused: false,
        workspacePath: path.join(root, "catch-up-workspace")
      })
    });

    try {
      await waitForProviderInputs(providerInputs, 1);
      const routines = await waitForRoutine(daemon.url, "active");
      expect(routines[0]?.lastFiredAt).toEqual(expect.any(String));
      expect(new Date(routines[0]?.nextFireAt ?? 0).getTime()).toBeGreaterThan(
        startedAt
      );
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      expect(providerInputs).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });
});

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

async function writeRoutineProject(
  root: string,
  fireAt: string
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on {{issue.title}}.\n");
  await writeFile(
    path.join(root, "daily-report.md"),
    [
      "---",
      "name: daily-report",
      "schedule:",
      `  at: ${fireAt}`,
      "kind: report",
      "---",
      "Routine {{routine.name}} for {{project.name}}.",
      ""
    ].join("\n")
  );
  await writeProjectConfig(root, "alpha", ["./daily-report.md"]);
}

async function writeRecurringRoutineProject(
  root: string,
  catchUp = false
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "WORKFLOW.md"), "Work.");
  await writeFile(
    path.join(root, "yearly-report.md"),
    [
      "---",
      "name: yearly-report",
      "schedule:",
      "  cron: yearly",
      "kind: report",
      ...(catchUp ? ["catch_up: fire_once_if_missed"] : []),
      "---",
      "Report.",
      ""
    ].join("\n")
  );
  await writeProjectConfig(root, "alpha", ["./yearly-report.md"]);
}

async function writeProjectWithoutRoutines(
  root: string,
  projectName: string
): Promise<void> {
  await writeProjectConfig(root, projectName, []);
}

async function writeProjectConfig(
  root: string,
  projectName: string,
  routines: string[],
  disabled = false
): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 25",
      "providers:",
      "  codex:",
      '    command: "codex fake"',
      "  claude:",
      '    command: "claude fake"',
      "projects:",
      `  - name: ${projectName}`,
      `    disabled: ${disabled}`,
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      `      repo: ${projectName}`,
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      `      root: ./.symphonika/workspaces/${projectName}`,
      "      git:",
      `        remote: git@github.com:pmatos/${projectName}.git`,
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ...routineLines(routines),
      ""
    ].join("\n")
  );
}

function routineLines(routines: string[]): string[] {
  if (routines.length === 0) {
    return [];
  }
  return ["    routines:", ...routines.map((routine) => `      - ${routine}`)];
}

async function waitForProviderInputs(
  inputs: ProviderRunInput[],
  count: number
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (inputs.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`provider did not receive ${count} input(s)`);
}

async function waitForRoutine(
  baseUrl: string,
  state: string
): Promise<RoutineApiRow[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = (await fetch(`${baseUrl}/api/routines`).then((response) =>
      response.json()
    )) as { routines: RoutineApiRow[] };
    if (body.routines.some((routine) => routine.state === state)) {
      return body.routines;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`routine did not reach ${state}`);
}

type RoutineFiringApiRow = {
  cancelReason: string | null;
  id: string;
  state: string;
  workspacePath: string;
};

async function waitForFiringState(
  baseUrl: string,
  routineName: string,
  project: string,
  state: string
): Promise<RoutineFiringApiRow> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = (await fetch(
      `${baseUrl}/api/routines/${routineName}/firings?project=${project}`
    ).then((response) => response.json())) as {
      firings: RoutineFiringApiRow[];
    };
    const match = body.firings.find((firing) => firing.state === state);
    if (match !== undefined) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`firing did not reach ${state}`);
}

async function waitForNoRoutines(baseUrl: string): Promise<RoutineApiRow[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = (await fetch(`${baseUrl}/api/routines`).then((response) =>
      response.json()
    )) as { routines: RoutineApiRow[] };
    if (body.routines.length === 0) {
      return body.routines;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("routines were not pruned");
}
