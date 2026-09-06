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
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-fresh-batch-"));
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

type ProjectSpec = {
  name: string;
  weight?: number;
};

function projectConfig(
  root: string,
  spec: ProjectSpec
): RunControllerProjectConfig {
  return {
    agent: { provider: "codex" },
    issue_filters: {
      labels_all: ["agent-ready"],
      labels_none: [],
      states: ["open"]
    },
    mode: "dispatch",
    name: spec.name,
    priority: { default: 99, labels: {} },
    tracker: {
      kind: "github",
      owner: "acme",
      repo: spec.name,
      token: "$GITHUB_TOKEN"
    },
    weight: spec.weight ?? 1,
    workflow: { format: "auto", path: "WORKFLOW.md" },
    workspace: {
      git: {
        base_branch: "main",
        remote: `git@github.com:acme/${spec.name}.git`
      },
      root: path.join(root, "workspaces", spec.name)
    }
  };
}

async function createHarness(
  specs: ProjectSpec[],
  options: {
    createRunId?: () => string;
    globalConcurrencyLoader?: () => Promise<{
      maxInFlight: number | undefined;
    }>;
    hostPressureGate?: HostPressureGate;
    // Empty map simulates every project's provider having no configured
    // command (provider_command_missing), without needing a project whose
    // provider isn't registered in agentProviders -- pickTargetFromCandidates
    // itself filters those out before a dispatch target is ever selected.
    // Partial because resolveAndClaim itself only ever reads it via a
    // Partial<RunControllerProvidersConfig> cast (run-controller.ts).
    providersConfig?: Partial<RunControllerProvidersConfig>;
  } = {}
): Promise<{
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  controller: RunController;
  root: string;
  runStore: RunStore;
}> {
  const root = await makeTempRoot();
  const stateRoot = path.join(root, "state");
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");

  const runStore = openRunStore({ stateRoot });
  openStores.push(runStore);
  runStore.syncProjectStates(
    specs.map((spec) => ({ name: spec.name, weight: spec.weight ?? 1 }))
  );
  const activeRuns = new ActiveRunRegistry();
  const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);

  let runCounter = 0;
  const controller = new RunController({
    activeRuns,
    agentProviders: { codex: succeedingProvider() },
    configDir: root,
    createRunId: options.createRunId ?? (() => `run-${++runCounter}`),
    emailConfigLoader: () => undefined,
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
    prepareIssueWorkspace: ({ issue: candidate, project }) =>
      Promise.resolve({
        branchName: `sym/${project.name}/${candidate.number}-candidate`,
        branchRef: `refs/heads/sym/${project.name}/${candidate.number}-candidate`,
        cachePath: path.join(root, "cache", `${project.name}.git`),
        issueDirectoryName: `${candidate.number}-candidate`,
        reused: false,
        workspacePath: path.join(
          root,
          "workspaces",
          project.name,
          "issues",
          String(candidate.number)
        )
      }),
    projectsLoader: () =>
      Promise.resolve(
        new Map(specs.map((spec) => [spec.name, projectConfig(root, spec)]))
      ),
    providersLoader: () =>
      Promise.resolve(
        (options.providersConfig ?? {
          claude: { command: "claude" },
          codex: { command: "codex" }
        }) as RunControllerProvidersConfig
      ),
    runStore,
    schedule: () => true,
    stateRoot
  });

  return { addLabelsToIssue, controller, root, runStore };
}

function issue(number: number): IssueSnapshot {
  return {
    body: "",
    created_at: "2026-08-01T00:00:00.000Z",
    id: number,
    labels: ["agent-ready"],
    number,
    priority: 1,
    state: "open",
    title: `Issue ${number}`,
    updated_at: "2026-08-01T00:00:00.000Z",
    url: `https://example.test/issues/${number}`
  };
}

function pollStatus(
  candidates: Array<{ issueNumber: number; project: string }>
): IssuePollStatus {
  return {
    candidateIssues: candidates.map(({ issueNumber, project }) => ({
      issue: issue(issueNumber),
      project,
      repository: { owner: "acme", repo: project }
    })),
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

// sampleIntervalMs: 0 means every refreshHostPressure() call re-samples
// (no TTL caching), so the loop's per-iteration re-check actually observes
// readPressure's next queued value instead of a cached admitted verdict.
const ALWAYS_SAMPLE_POLICY: HostPressurePolicy = {
  enabled: true,
  sampleIntervalMs: 0,
  thresholds: { io: undefined, memory: 10 }
};

// Admits the first `admitCount` samples, then reports stalled memory
// pressure forever after -- lets a test simulate the host becoming
// pressured partway through a multi-pick dispatchFresh call.
function gateAdmittingThenStalling(admitCount: number): HostPressureGate {
  let sampleCount = 0;
  return createHostPressureGate({
    policy: () => ALWAYS_SAMPLE_POLICY,
    readPressure: (): Promise<HostPressureSample> => {
      sampleCount += 1;
      const memory = sampleCount <= admitCount ? 0 : 42;
      return Promise.resolve({ fullAvg60: { memory }, unavailable: {} });
    }
  });
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

describe("RunController.dispatchFresh", () => {
  it("claims all N candidates across multiple Projects in one call when the global cap allows it", async () => {
    const harness = await createHarness([
      { name: "alpha" },
      { name: "beta" },
      { name: "gamma" }
    ]);

    const batch = await harness.controller.dispatchFresh(
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "beta" },
        { issueNumber: 3, project: "gamma" }
      ])
    );

    expect(batch.claims).toHaveLength(3);
    expect(batch.claims.every((claim) => claim.dispatched === true)).toBe(true);
    expect(batch.lifecycles).toHaveLength(3);
    await Promise.all(batch.lifecycles);
  });

  it("registers each lifecycle via onLifecycle as it is created, even when a later pick throws", async () => {
    // createRunId throws on its 3rd call (gamma's pick, given equal weights
    // and insertion-order tie-breaking) -- an error resolveAndClaim does not
    // catch, so it propagates out of dispatchFresh entirely. A caller that
    // only reads the returned `lifecycles` array (as daemon.ts originally
    // did, registering into inflightDispatches after dispatchFresh returned)
    // would never see alpha's and beta's lifecycles in that case. onLifecycle
    // must have already registered them before the throw.
    let runCounter = 0;
    const harness = await createHarness(
      [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      {
        createRunId: () => {
          runCounter += 1;
          if (runCounter === 3) {
            throw new Error("boom-3");
          }
          return `run-${runCounter}`;
        }
      }
    );
    const registered: Array<Promise<void>> = [];

    await expect(
      harness.controller.dispatchFresh(
        pollStatus([
          { issueNumber: 1, project: "alpha" },
          { issueNumber: 2, project: "beta" },
          { issueNumber: 3, project: "gamma" }
        ]),
        { onLifecycle: (lifecycle) => registered.push(lifecycle) }
      )
    ).rejects.toThrow("boom-3");

    expect(registered).toHaveLength(2);
    await Promise.all(registered);
  });

  it("stops claiming once the global cap is reached, leaving later candidates untouched", async () => {
    const harness = await createHarness([{ name: "alpha" }, { name: "beta" }], {
      globalConcurrencyLoader: () => Promise.resolve({ maxInFlight: 1 })
    });

    const batch = await harness.controller.dispatchFresh(
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "beta" }
      ])
    );

    // One claim succeeds; the loop then sees the global cap reached
    // (pickTargetFromCandidates' own lock-free check returns undefined) and
    // stops without ever attempting the second candidate.
    expect(batch.claims).toEqual([{ dispatched: true, runId: "run-1" }]);
    expect(batch.lifecycles).toHaveLength(1);
    await Promise.all(batch.lifecycles);
  });

  it("does not spin on a candidate whose provider has no configured command", async () => {
    const harness = await createHarness([{ name: "alpha" }], {
      providersConfig: {}
    });

    const batch = await harness.controller.dispatchFresh(
      pollStatus([{ issueNumber: 1, project: "alpha" }])
    );

    // Resolves promptly with exactly one claim attempt recorded -- the
    // regression this guards is dispatchFresh looping forever on a
    // misconfigured-provider candidate that failFreshDispatchBeforeProvider
    // reports as dispatched:true without ever reserving a slot.
    expect(batch.claims).toEqual([{ dispatched: true, runId: "run-1" }]);
    expect(batch.lifecycles).toEqual([]);
  });

  it("excludes the whole project after a misconfigured-provider claim, not just the one candidate", async () => {
    const harness = await createHarness([{ name: "alpha" }], {
      providersConfig: {}
    });

    const batch = await harness.controller.dispatchFresh(
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "alpha" },
        { issueNumber: 3, project: "alpha" }
      ])
    );

    // Without the project-wide exclusion, dispatchFresh would burn through
    // all 3 candidates via real label-write calls in this one call; the
    // project's scheduler_current_weight never advances (no
    // recordProjectDispatchSelection on this path), so it would otherwise
    // keep winning every pick. A single failFreshDispatchBeforeProvider call
    // legitimately makes several label-write calls of its own (sym:claimed,
    // then applyTerminal's sym:failed/sym:claimed-release cascade) for issue
    // #1 alone, so the real assertion is that issues #2 and #3 were never
    // touched, not a raw call count.
    expect(batch.claims).toEqual([{ dispatched: true, runId: "run-1" }]);
    const touchedIssues = new Set(
      harness.addLabelsToIssue.mock.calls.map(
        (call: unknown[]) => (call[0] as { issueNumber: number }).issueNumber
      )
    );
    expect(touchedIssues).toEqual(new Set([1]));
    expect(harness.runStore.listRuns({})).toHaveLength(1);
  });

  it("re-checks host pressure on every iteration and stops claiming once it trips mid-loop", async () => {
    // With sampleIntervalMs: 0 every refreshHostPressure() call re-samples,
    // including claimAndPersistRun's own in-mutex re-check -- so alpha's
    // single successful claim consumes 2 samples (the loop's own check, then
    // the mutex-internal one) before the loop's NEXT iteration (beta's) sees
    // the 3rd sample, now stalled. If dispatchFresh only checked pressure
    // once, up front, it would keep claiming beta and gamma regardless.
    const harness = await createHarness(
      [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      { hostPressureGate: gateAdmittingThenStalling(2) }
    );

    const batch = await harness.controller.dispatchFresh(
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "beta" },
        { issueNumber: 3, project: "gamma" }
      ])
    );

    expect(batch.claims).toEqual([{ dispatched: true, runId: "run-1" }]);
    expect(batch.lifecycles).toHaveLength(1);
    const touchedIssues = new Set(
      harness.addLabelsToIssue.mock.calls.map(
        (call: unknown[]) => (call[0] as { issueNumber: number }).issueNumber
      )
    );
    expect(touchedIssues).toEqual(new Set([1]));
    await Promise.all(batch.lifecycles);
  });

  it("preserves weighted round-robin fairness across a multi-pick call", async () => {
    const specs: ProjectSpec[] = [
      { name: "alpha", weight: 1 },
      { name: "beta", weight: 3 }
    ];

    const batchHarness = await createHarness(specs);
    const batch = await batchHarness.controller.dispatchFresh(
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "beta" }
      ])
    );
    expect(batch.claims).toHaveLength(2);
    await Promise.all(batch.lifecycles);
    const batchStates = batchHarness.runStore.getProjectStatesByName();

    // Equivalent to the batch call above, but as two separate ticks: each
    // call's poll status only carries the candidate(s) not yet claimed by
    // the previous call, mirroring how a real second poll would no longer
    // see an issue that already got sym:claimed.
    const sequentialHarness = await createHarness(specs);
    const first = await sequentialHarness.controller.dispatchOneFresh(
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "beta" }
      ])
    );
    expect(first.dispatched).toBe(true);
    // beta's weight (3) must win the first pick over alpha's (1) -- confirms
    // the two-call comparison below exercises the same pick order the batch
    // call took, not a coincidentally-matching total.
    expect(
      first.dispatched &&
        sequentialHarness.runStore.getRun(first.runId)?.project
    ).toBe("beta");
    const second = await sequentialHarness.controller.dispatchOneFresh(
      pollStatus([{ issueNumber: 1, project: "alpha" }])
    );
    expect(second.dispatched).toBe(true);
    const sequentialStates =
      sequentialHarness.runStore.getProjectStatesByName();

    expect(batchStates.get("alpha")?.schedulerCurrentWeight).toBe(
      sequentialStates.get("alpha")?.schedulerCurrentWeight
    );
    expect(batchStates.get("beta")?.schedulerCurrentWeight).toBe(
      sequentialStates.get("beta")?.schedulerCurrentWeight
    );
  });
});
