import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssuePollStatus, IssueSnapshot } from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "../src/lifecycle/run-controller.js";
import type {
  AgentProvider,
  AgentProviderName,
  ProviderEvent
} from "../src/provider.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function projectConfig(
  root: string,
  name: string,
  repo = name
): RunControllerProjectConfig {
  return {
    agent: { provider: "codex" },
    issue_filters: {
      labels_none: [],
      ready_label: "agent-ready",
      states: ["open"]
    },
    mode: "dispatch",
    name,
    priority: { default: 99, labels: {} },
    tracker: { kind: "github", owner: "acme", repo, token: "$GITHUB_TOKEN" },
    weight: 1,
    workflow: { format: "auto", path: "WORKFLOW.md" },
    workspace: {
      git: { base_branch: "main", remote: `git@github.com:acme/${repo}.git` },
      root: path.join(root, "workspaces", name)
    }
  };
}

function trackingProvider(name: AgentProviderName): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name,
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

async function createHarness(
  projects: Array<{ name: string; repo?: string }>,
  options: {
    providersConfig?: Partial<RunControllerProvidersConfig>;
    registered?: AgentProviderName[];
  } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-chain-plan-"));
  tempRoots.push(root);
  const stateRoot = path.join(root, "state");
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");
  const runStore = openRunStore({ stateRoot });
  openStores.push(runStore);
  runStore.syncProjectStates(projects.map(({ name }) => ({ name, weight: 1 })));
  const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
  const providers = Object.fromEntries(
    (options.registered ?? ["codex", "omp"]).map((name) => [
      name,
      trackingProvider(name)
    ])
  ) as Partial<Record<AgentProviderName, AgentProvider>>;
  let runCounter = 0;
  const controller = new RunController({
    activeRuns: new ActiveRunRegistry(),
    agentProviders: providers,
    configDir: root,
    createRunId: () => `run-${++runCounter}`,
    emailConfigLoader: () => undefined,
    env: { GITHUB_TOKEN: "secret" },
    githubIssuesApi: {
      addLabelsToIssue,
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    },
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
        new Map(
          projects.map(({ name, repo }) => [
            name,
            projectConfig(root, name, repo)
          ])
        )
      ),
    providersLoader: () =>
      Promise.resolve(
        (options.providersConfig ?? {
          codex: { command: "codex" },
          omp: { command: "omp" }
        }) as RunControllerProvidersConfig
      ),
    runStore,
    schedule: () => true,
    stateRoot
  });
  return { addLabelsToIssue, controller, runStore };
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
  candidates: Array<{ issueNumber: number; project: string; repo?: string }>
): IssuePollStatus {
  return {
    candidateIssues: candidates.map(({ issueNumber, project, repo }) => ({
      issue: issue(issueNumber),
      project,
      repository: { owner: "acme", repo: repo ?? project }
    })),
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

function seedPlan(
  runStore: RunStore,
  input: {
    id?: string;
    issueNumber: number;
    project: string;
    provider: AgentProviderName;
    repo?: string;
    status?: "label_failed" | "label_written";
  }
): void {
  const id = input.id ?? `plan-${input.issueNumber}`;
  runStore.createProviderPlan({
    graphFingerprint: "sha256:graph",
    id,
    issueNumber: input.issueNumber,
    projectName: input.project,
    provider: input.provider,
    readyLabel: "agent-ready",
    repository: { owner: "acme", repo: input.repo ?? input.project },
    snapshotPolledAt: "2026-10-09T10:00:00.000Z"
  });
  if (input.status === "label_failed") {
    runStore.markProviderPlanLabelResult(id, { error: "boom", ok: false });
  } else if (input.status === "label_written") {
    runStore.markProviderPlanLabelResult(id, { ok: true });
  }
}

function claimLabelWrites(harness: {
  addLabelsToIssue: ReturnType<typeof vi.fn>;
}): number {
  return harness.addLabelsToIssue.mock.calls.filter(
    (call) =>
      Array.isArray((call[0] as { labels?: string[] }).labels) &&
      (call[0] as { labels: string[] }).labels.includes("sym:claimed")
  ).length;
}

async function dispatch(
  harness: Awaited<ReturnType<typeof createHarness>>,
  status: IssuePollStatus
) {
  const batch = await harness.controller.dispatchFresh(status);
  await Promise.all(batch.lifecycles);
  return batch;
}

describe("chain-wide provider plan at the fresh claim boundary", () => {
  it("launches the plan's provider instead of the project default and consumes the plan", async () => {
    const harness = await createHarness([{ name: "alpha" }]);
    seedPlan(harness.runStore, {
      issueNumber: 1,
      project: "alpha",
      provider: "omp",
      status: "label_written"
    });

    const batch = await dispatch(
      harness,
      pollStatus([{ issueNumber: 1, project: "alpha" }])
    );

    expect(batch.claims).toEqual([{ dispatched: true, runId: "run-1" }]);
    expect(harness.runStore.getRun("run-1")?.provider).toBe("omp");
    expect(harness.runStore.getProviderPlan("plan-1")).toMatchObject({
      consumedRunId: "run-1",
      status: "consumed"
    });
    expect(harness.runStore.getChainProviderPlan("run-1")?.provider).toBe(
      "omp"
    );
  });

  it("keeps the project default when no plan exists", async () => {
    const harness = await createHarness([{ name: "alpha" }]);

    await dispatch(harness, pollStatus([{ issueNumber: 1, project: "alpha" }]));

    expect(harness.runStore.getRun("run-1")?.provider).toBe("codex");
    expect(harness.runStore.getChainProviderPlan("run-1")).toBeUndefined();
  });

  it("consumes a pending plan that has not yet seen its label write confirmed", async () => {
    const harness = await createHarness([{ name: "alpha" }]);
    seedPlan(harness.runStore, {
      issueNumber: 1,
      project: "alpha",
      provider: "omp"
    });

    await dispatch(harness, pollStatus([{ issueNumber: 1, project: "alpha" }]));

    expect(harness.runStore.getRun("run-1")?.provider).toBe("omp");
    expect(harness.runStore.getProviderPlan("plan-1")?.status).toBe("consumed");
  });

  it("skips a label_failed candidate without a claim, a run or a label write, while others still dispatch", async () => {
    const harness = await createHarness([{ name: "alpha" }]);
    seedPlan(harness.runStore, {
      issueNumber: 1,
      project: "alpha",
      provider: "omp",
      status: "label_failed"
    });

    const batch = await dispatch(
      harness,
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "alpha" }
      ])
    );

    expect(batch.claims).toEqual([{ dispatched: true, runId: "run-1" }]);
    expect(harness.runStore.getRun("run-1")?.issueNumber).toBe(2);
    expect(claimLabelWrites(harness)).toBe(1);
    expect(harness.runStore.getProviderPlan("plan-1")?.status).toBe(
      "label_failed"
    );
  });

  it("skips only the candidate whose planned provider has no command, creating no failed run", async () => {
    const harness = await createHarness([{ name: "alpha" }], {
      providersConfig: { codex: { command: "codex" } }
    });
    seedPlan(harness.runStore, {
      issueNumber: 1,
      project: "alpha",
      provider: "omp"
    });

    const batch = await dispatch(
      harness,
      pollStatus([
        { issueNumber: 1, project: "alpha" },
        { issueNumber: 2, project: "alpha" }
      ])
    );

    expect(batch.claims.filter((claim) => claim.dispatched)).toHaveLength(1);
    expect(harness.runStore.getRun("run-1")).toBeUndefined();
    expect(harness.runStore.getRun("run-2")?.issueNumber).toBe(2);
    expect(claimLabelWrites(harness)).toBe(1);
    expect(harness.runStore.getProviderPlan("plan-1")?.status).toBe("pending");
  });

  it("skips a candidate whose planned provider is not registered", async () => {
    const harness = await createHarness([{ name: "alpha" }], {
      registered: ["codex"]
    });
    seedPlan(harness.runStore, {
      issueNumber: 1,
      project: "alpha",
      provider: "omp"
    });

    const batch = await dispatch(
      harness,
      pollStatus([{ issueNumber: 1, project: "alpha" }])
    );

    expect(batch.claims.some((claim) => claim.dispatched)).toBe(false);
    expect(harness.runStore.getRun("run-1")).toBeUndefined();
    expect(claimLabelWrites(harness)).toBe(0);
  });

  it("defers the claim when the plan is cancelled between resolution and the claim boundary", async () => {
    const harness = await createHarness([{ name: "alpha" }]);
    seedPlan(harness.runStore, {
      issueNumber: 1,
      project: "alpha",
      provider: "omp",
      status: "label_written"
    });
    const originalGet = harness.runStore.getActiveProviderPlan.bind(
      harness.runStore
    );
    let reads = 0;
    vi.spyOn(harness.runStore, "getActiveProviderPlan").mockImplementation(
      (...args) => {
        reads += 1;
        if (reads === 3) {
          harness.runStore.cancelProviderPlan("plan-1");
        }
        return originalGet(...args);
      }
    );

    const batch = await dispatch(
      harness,
      pollStatus([{ issueNumber: 1, project: "alpha" }])
    );

    expect(batch.claims.some((claim) => claim.dispatched)).toBe(false);
    expect(claimLabelWrites(harness)).toBe(0);
    expect(harness.runStore.getRun("run-1")).toBeUndefined();
  });

  it("defers the claim when a plan appears after the provider was resolved", async () => {
    const harness = await createHarness([{ name: "alpha" }]);
    const originalGet = harness.runStore.getActiveProviderPlan.bind(
      harness.runStore
    );
    let reads = 0;
    vi.spyOn(harness.runStore, "getActiveProviderPlan").mockImplementation(
      (...args) => {
        reads += 1;
        if (reads === 3) {
          seedPlan(harness.runStore, {
            issueNumber: 1,
            project: "alpha",
            provider: "omp"
          });
        }
        return originalGet(...args);
      }
    );

    const batch = await dispatch(
      harness,
      pollStatus([{ issueNumber: 1, project: "alpha" }])
    );

    expect(batch.claims.some((claim) => claim.dispatched)).toBe(false);
    expect(harness.runStore.getRun("run-1")).toBeUndefined();
    expect(claimLabelWrites(harness)).toBe(0);
  });

  it("applies a plan to every project aliasing the same repository", async () => {
    const harness = await createHarness([
      { name: "alpha", repo: "shared" },
      { name: "beta", repo: "shared" }
    ]);
    seedPlan(harness.runStore, {
      issueNumber: 1,
      project: "alpha",
      provider: "omp",
      repo: "shared",
      status: "label_written"
    });

    await dispatch(
      harness,
      pollStatus([{ issueNumber: 1, project: "beta", repo: "shared" }])
    );

    expect(harness.runStore.getRun("run-1")?.provider).toBe("omp");
  });
});
