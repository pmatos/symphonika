import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssuePollStatus, IssueSnapshot } from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  createHostPressureGate,
  type HostPressureGate,
  type HostPressurePolicy,
  type HostPressureSample
} from "../src/lifecycle/host-pressure.js";
import {
  RunController,
  type RunControllerProjectConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { dispatchDueRoutines } from "../src/routines/dispatcher.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-pressure-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const STALLED_POLICY: HostPressurePolicy = {
  enabled: true,
  sampleIntervalMs: 0,
  thresholds: { io: undefined, memory: 10 }
};

function gateReading(memory: number): HostPressureGate {
  return createHostPressureGate({
    policy: () => STALLED_POLICY,
    readPressure: (): Promise<HostPressureSample> =>
      Promise.resolve({ fullAvg60: { memory }, unavailable: {} })
  });
}

describe("issue dispatch under host pressure", () => {
  it("refuses a fresh dispatch and names the stalled resource", async () => {
    const harness = await createHarness({ hostPressureGate: gateReading(42) });

    const result = await harness.controller.dispatchOneFresh(pollStatus());

    expect(result).toEqual({
      dispatched: false,
      reason:
        "host memory pressure (full avg60 42.00% >= 10%) — deferring dispatch"
    });
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
    expect(harness.runStore.listRuns({})).toHaveLength(0);
  });

  it("leaves the Project scheduler cursor untouched while deferring", async () => {
    const harness = await createHarness({ hostPressureGate: gateReading(42) });

    await harness.controller.dispatchOneFresh(pollStatus());

    const state = harness.runStore.getProjectStatesByName().get("alpha");
    expect(state?.lastDispatchedIssueNumber).toBeNull();
    expect(state?.schedulerCurrentWeight).toBe(0);
  });

  it("dispatches once the host recovers below the threshold", async () => {
    const harness = await createHarness({ hostPressureGate: gateReading(1) });

    const result = await harness.controller.dispatchOneFresh(pollStatus());

    expect(result).toEqual({ dispatched: true, runId: "run-1" });
  });

  it("dispatches when no gate is configured at all", async () => {
    // The one-shot CLI builds a controller without a gate; it must behave
    // exactly as it did before the gate existed.
    const harness = await createHarness();

    const result = await harness.controller.dispatchOneFresh(pollStatus());

    expect(result).toEqual({ dispatched: true, runId: "run-1" });
  });

  it("dispatches while the configured policy is disabled", async () => {
    const harness = await createHarness({
      hostPressureGate: createHostPressureGate({
        policy: () => ({ ...STALLED_POLICY, enabled: false }),
        readPressure: () =>
          Promise.resolve({ fullAvg60: { memory: 99 }, unavailable: {} })
      })
    });

    const result = await harness.controller.dispatchOneFresh(pollStatus());

    expect(result).toEqual({ dispatched: true, runId: "run-1" });
  });

  it("dispatches on a host with no PSI counters to read", async () => {
    const harness = await createHarness({
      hostPressureGate: createHostPressureGate({
        policy: () => STALLED_POLICY,
        readPressure: () =>
          Promise.resolve({
            fullAvg60: {},
            unavailable: { io: "ENOENT", memory: "ENOENT" }
          })
      })
    });

    const result = await harness.controller.dispatchOneFresh(pollStatus());

    expect(result).toEqual({ dispatched: true, runId: "run-1" });
  });
});

describe("in-mutex claim under host pressure", () => {
  it("reports host pressure without consulting the concurrency cap", async () => {
    // claimAndPersistRun is the one admission point every claim path funnels
    // through — continuation, state advance and PR review follow-up reach it
    // cold. Checking the cap first would report a full cap on a stalled host,
    // hiding the real cause; assert the pressure check short-circuits before
    // the concurrency loader is even consulted. See ADR 0088.
    let reads = 0;
    let concurrencyLoads = 0;
    const harness = await createHarness({
      globalConcurrencyLoader: () => {
        concurrencyLoads += 1;
        return Promise.resolve({ maxInFlight: undefined });
      },
      hostPressureGate: createHostPressureGate({
        policy: () => STALLED_POLICY,
        // Healthy for dispatchOneFresh's own gate, stalled by the time the
        // in-mutex re-check runs — the window this check exists to cover.
        readPressure: () => {
          reads += 1;
          return Promise.resolve({
            fullAvg60: { memory: reads === 1 ? 0 : 42 },
            unavailable: {}
          });
        }
      })
    });

    const result = await harness.controller.dispatchOneFresh(pollStatus());

    expect(result).toEqual({
      dispatched: false,
      reason:
        "host memory pressure (full avg60 42.00% >= 10%) — deferring dispatch"
    });
    expect(reads).toBe(2);
    // Exactly one load — pickTargetFromCandidates' own global-cap check. A
    // second would mean claimAndPersistRun evaluated capacity despite the
    // stalled host, i.e. the cap-first ordering this test pins against.
    expect(concurrencyLoads).toBe(1);
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("still reports the concurrency cap when only the cap is breached", async () => {
    const harness = await createHarness({
      globalConcurrencyLoader: () => Promise.resolve({ maxInFlight: 1 }),
      hostPressureGate: gateReading(0),
      inFlightRuns: [{ issueNumber: 99, runId: "other-run" }]
    });

    const result = await harness.controller.dispatchOneFresh(pollStatus());

    expect(result).toEqual({
      dispatched: false,
      reason: "no eligible issue has a registered provider"
    });
  });
});

describe("routine firing under host pressure", () => {
  it("skips a due Routine and records the host_pressure reason", async () => {
    const harness = await createRoutineHarness();

    const result = await dispatchDueRoutines({
      activeRuns: harness.activeRuns,
      agentProviders: { codex: succeedingProvider() },
      configDir: harness.root,
      globalConcurrency: { maxInFlight: undefined },
      hostPressure: {
        admitted: false,
        observed: 42,
        reason: "host memory pressure (full avg60 42.00% >= 10%)",
        resource: "memory",
        threshold: 10
      },
      now: new Date("2026-05-22T10:00:01.000Z"),
      projects: harness.projects,
      providersConfig: {
        claude: { command: "claude" },
        codex: { command: "codex" }
      },
      runStore: harness.runStore,
      stateRoot: harness.stateRoot
    });

    expect(result.fired).toEqual([]);
    expect(result.skipped).toEqual([
      { projectName: "alpha", reason: "host_pressure", routineName: "daily" }
    ]);
    const routine = harness.runStore.listRoutines({
      now: new Date("2026-05-22T10:00:02.000Z")
    })[0];
    expect(routine?.lastSkipReason).toBe("host_pressure");
    expect(routine?.skipCounts24h.host_pressure).toBe(1);
    expect(routine?.skipCounts24h.concurrency_cap).toBe(0);
  });

  it("fires a due Routine when the host is admitted", async () => {
    const harness = await createRoutineHarness();

    const result = await dispatchDueRoutines({
      activeRuns: harness.activeRuns,
      agentProviders: { codex: succeedingProvider() },
      configDir: harness.root,
      globalConcurrency: { maxInFlight: undefined },
      hostPressure: { admitted: true },
      now: new Date("2026-05-22T10:00:01.000Z"),
      prepareRoutineWorkspace: () =>
        Promise.resolve({
          branchName: "sym/routine/alpha/daily",
          branchRef: "refs/heads/sym/routine/alpha/daily",
          cachePath: path.join(harness.root, "cache", "repo.git"),
          firingDirectoryName: "daily",
          reused: false,
          workspacePath: path.join(harness.root, "routine-workspace")
        }),
      projects: harness.projects,
      providersConfig: {
        claude: { command: "claude" },
        codex: { command: "codex" }
      },
      runStore: harness.runStore,
      stateRoot: harness.stateRoot
    });

    expect(result.skipped).toEqual([]);
    expect(result.fired).toHaveLength(1);
  });
});

async function createRoutineHarness(): Promise<{
  activeRuns: ActiveRunRegistry;
  projects: Map<string, RunControllerProjectConfig>;
  root: string;
  runStore: RunStore;
  stateRoot: string;
}> {
  const root = await makeTempRoot();
  const stateRoot = path.join(root, "state");
  const runStore = openRunStore({ stateRoot });
  openStores.push(runStore);
  runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);
  const promptPath = path.join(root, "daily.md");
  await writeFile(promptPath, "Do the daily thing.\n");
  const project: RunControllerProjectConfig = {
    ...projectConfig(root),
    routines: [
      {
        kind: "report",
        name: "daily",
        projectName: "alpha",
        prompt: "Do the daily thing.",
        provider: "codex",
        schedule: { at: "2026-05-22T10:00:00.000Z" },
        sourcePath: promptPath
      }
    ]
  };

  return {
    activeRuns: new ActiveRunRegistry(),
    projects: new Map([["alpha", project]]),
    root,
    runStore,
    stateRoot
  };
}

function projectConfig(root: string): RunControllerProjectConfig {
  return {
    agent: { provider: "codex" },
    issue_filters: {
      labels_all: ["agent-ready"],
      labels_none: [],
      states: ["open"]
    },
    mode: "dispatch",
    name: "alpha",
    priority: { default: 99, labels: {} },
    tracker: {
      kind: "github",
      owner: "acme",
      repo: "alpha",
      token: "$GITHUB_TOKEN"
    },
    weight: 1,
    workflow: { format: "auto", path: "WORKFLOW.md" },
    workspace: {
      git: { base_branch: "main", remote: "git@github.com:acme/alpha.git" },
      root: path.join(root, "workspaces", "alpha")
    }
  };
}

async function createHarness(
  options: {
    globalConcurrencyLoader?: () => Promise<{
      maxInFlight: number | undefined;
    }>;
    hostPressureGate?: HostPressureGate;
    inFlightRuns?: Array<{ issueNumber: number; runId: string }>;
  } = {}
): Promise<{
  activeRuns: ActiveRunRegistry;
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  controller: RunController;
  runStore: RunStore;
}> {
  const root = await makeTempRoot();
  const stateRoot = path.join(root, "state");
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");

  const runStore = openRunStore({ stateRoot });
  openStores.push(runStore);
  runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);
  const activeRuns = new ActiveRunRegistry();
  for (const entry of options.inFlightRuns ?? []) {
    activeRuns.reserveSlot({ ...entry, projectName: "alpha" });
  }
  const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

  let runCounter = 0;
  const controller = new RunController({
    activeRuns,
    agentProviders: { codex: succeedingProvider() },
    configDir: root,
    createRunId: () => `run-${++runCounter}`,
    env: { GITHUB_TOKEN: "secret" },
    githubIssuesApi: {
      addLabelsToIssue,
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    },
    ...(options.globalConcurrencyLoader === undefined
      ? {}
      : { globalConcurrencyLoader: options.globalConcurrencyLoader }),
    ...(options.hostPressureGate === undefined
      ? {}
      : { hostPressureGate: options.hostPressureGate }),
    lifecyclePolicy: {
      continuation: { cap: 0, delayMs: 0 },
      retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
    },
    prepareIssueWorkspace: ({ issue: candidate }) =>
      Promise.resolve({
        branchName: `sym/alpha/${candidate.number}-candidate`,
        branchRef: `refs/heads/sym/alpha/${candidate.number}-candidate`,
        cachePath: path.join(root, "cache", "repo.git"),
        issueDirectoryName: `${candidate.number}-candidate`,
        reused: false,
        workspacePath: path.join(root, "workspaces", "alpha", "issues", "1")
      }),
    projectsLoader: () =>
      Promise.resolve(new Map([["alpha", projectConfig(root)]])),
    providersLoader: () =>
      Promise.resolve({
        claude: { command: "claude" },
        codex: { command: "codex" }
      }),
    runStore,
    schedule: () => undefined,
    stateRoot
  });

  return { activeRuns, addLabelsToIssue, controller, runStore };
}

function issue(): IssueSnapshot {
  return {
    body: "",
    created_at: "2026-08-01T00:00:00.000Z",
    id: 1,
    labels: ["agent-ready"],
    number: 1,
    priority: 1,
    state: "open",
    title: "Issue",
    updated_at: "2026-08-01T00:00:00.000Z",
    url: "https://example.test/issues/1"
  };
}

function pollStatus(): IssuePollStatus {
  return {
    candidateIssues: [
      {
        issue: issue(),
        project: "alpha",
        repository: { owner: "acme", repo: "alpha" }
      }
    ],
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

function succeedingProvider(): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    async *runAttempt(): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    },
    validate: vi.fn().mockResolvedValue(undefined)
  };
}
