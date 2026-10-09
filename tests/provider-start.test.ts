import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitHubIssuesApi, RawGitHubIssue } from "../src/issue-polling.js";
import { createAsyncMutex } from "../src/lifecycle/async-mutex.js";
import type { RunControllerProjectConfig } from "../src/lifecycle/run-controller.js";
import {
  createProviderStartService,
  startBlockers,
  type ProviderStartService
} from "../src/issues/provider-start.js";
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

const POLLED_AT = "2026-10-09T10:00:00.000Z";

function rawIssue(overrides: Partial<RawGitHubIssue> = {}): RawGitHubIssue {
  return {
    body: "",
    created_at: "2026-10-01T00:00:00Z",
    html_url: "https://github.com/acme/widgets/issues/7",
    id: 7,
    labels: [{ name: "bug" }],
    number: 7,
    state: "open",
    title: "An issue",
    updated_at: "2026-10-01T00:00:00Z",
    ...overrides
  } as RawGitHubIssue;
}

function projectConfig(
  options: { fingerprint?: string; repo?: string } = {}
): RunControllerProjectConfig {
  return {
    agent: { provider: "codex" },
    issue_filters: {
      labels_none: [],
      ready_label: "agent-ready",
      states: ["open"]
    },
    mode: "dispatch",
    name: "widgets",
    priority: { default: 99, labels: {} },
    tracker: {
      kind: "github",
      owner: "acme",
      repo: options.repo ?? "widgets",
      token: "$GITHUB_TOKEN"
    },
    weight: 1,
    workflow: {
      body: "",
      contentHash: options.fingerprint ?? "sha256:graph-a",
      evidence: { ignore: [] },
      expandedWorkflow: {
        contentHash: options.fingerprint ?? "sha256:graph-a",
        initial: "implement",
        name: "default",
        source: { kind: "raw_fsm", path: "workflow.yml" },
        states: []
      },
      format: "auto",
      path: "workflow.yml"
    },
    workspace: {
      git: { base_branch: "main", remote: "git@github.com:acme/widgets.git" },
      root: "/tmp/ws"
    }
  } as unknown as RunControllerProjectConfig;
}

async function createService(
  options: {
    addLabelsToIssue?: ReturnType<typeof vi.fn>;
    getIssue?: ReturnType<typeof vi.fn>;
    getIssueDependencies?: ReturnType<typeof vi.fn>;
    liveRunId?: () => string | undefined;
    project?: () => RunControllerProjectConfig;
    registered?: string[];
    snapshotLabels?: string[];
    snapshotReasons?: string[];
    bindingError?: () => string | undefined;
  } = {}
): Promise<{
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  runStore: RunStore;
  service: ProviderStartService;
  mutex: ReturnType<typeof createAsyncMutex>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-start-"));
  tempRoots.push(root);
  const runStore = openRunStore({ stateRoot: root });
  openStores.push(runStore);
  runStore.replaceProjectIssueSnapshots({
    polledAt: POLLED_AT,
    projectName: "widgets",
    repository: { owner: "acme", repo: "widgets" },
    rows: [
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 7,
        kind: "filtered",
        labels: options.snapshotLabels ?? ["bug"],
        priority: 99,
        reasons: options.snapshotReasons ?? [
          "missing required label agent-ready"
        ],
        title: "An issue"
      }
    ]
  });
  const addLabelsToIssue =
    options.addLabelsToIssue ?? vi.fn().mockResolvedValue(undefined);
  const getIssue = options.getIssue ?? vi.fn().mockResolvedValue(rawIssue());
  const githubIssuesApi = {
    addLabelsToIssue,
    getIssue,
    getIssueDependencies:
      options.getIssueDependencies ?? vi.fn().mockResolvedValue(new Map()),
    listOpenIssues: vi.fn().mockResolvedValue([])
  } as unknown as GitHubIssuesApi;
  const mutex = createAsyncMutex();
  let counter = 0;
  const registered = options.registered ?? ["codex", "claude", "omp"];
  const service = createProviderStartService({
    checkLiveRun: () => options.liveRunId?.(),
    createPlanId: () => `plan-${++counter}`,
    dispatchMutex: mutex,
    getProject: () => (options.project ?? projectConfig)(),
    getProvidersConfig: () => ({
      claude: { command: "claude" },
      codex: { command: "codex" },
      omp: { command: "omp" }
    }),
    githubIssuesApi,
    isProviderRegistered: (name) => registered.includes(name),
    resolveToken: () => "token",
    runStore,
    verifySnapshotBinding: () => options.bindingError?.()
  });
  return { addLabelsToIssue, getIssue, mutex, runStore, service };
}

const startRequest = {
  graphFingerprint: "sha256:graph-a",
  issueNumber: 7,
  projectName: "widgets",
  provider: "omp",
  snapshotPolledAt: POLLED_AT,
  snapshotRepository: { owner: "acme", repo: "widgets" }
};

const repository = { owner: "acme", repo: "widgets" };

describe("startBlockers", () => {
  it("drops the missing-ready-label reason but keeps every other reason", () => {
    expect(
      startBlockers({
        labels: ["bug"],
        liveRunId: undefined,
        plan: undefined,
        readyLabel: "agent-ready",
        snapshotReasons: [
          "missing required label agent-ready",
          "blocked by open dependency #3"
        ],
        suppressed: false
      })
    ).toEqual(["blocked by open dependency #3"]);
  });

  it("flags an already-ready issue, a live reservation and a suppressed issue", () => {
    const blockers = startBlockers({
      labels: ["Agent-Ready"],
      liveRunId: "run-9",
      plan: undefined,
      readyLabel: "agent-ready",
      snapshotReasons: [],
      suppressed: true
    });
    expect(blockers).toHaveLength(3);
    expect(blockers.join(" ")).toContain("already has the Ready Label");
    expect(blockers.join(" ")).toContain("run-9");
  });
});

describe("ProviderStartService.preview", () => {
  it("exposes the fingerprint, configured providers and an empty blocker list", async () => {
    const { service } = await createService({ registered: ["codex", "omp"] });
    const preview = service.preview("widgets", 7);
    expect(preview?.context).toMatchObject({
      defaultProvider: "codex",
      graphFingerprint: "sha256:graph-a",
      providers: ["omp", "codex"],
      readyLabel: "agent-ready",
      repository
    });
    expect(preview?.blockers).toEqual([]);
  });

  it("returns undefined for an unknown issue", async () => {
    const { service } = await createService();
    expect(service.preview("widgets", 999)).toBeUndefined();
  });
});

describe("ProviderStartService.start", () => {
  it("persists the pending plan before adding the Ready Label", async () => {
    const harness = await createService();
    let planAtLabelWrite: string | undefined;
    harness.addLabelsToIssue.mockImplementation(() => {
      planAtLabelWrite = harness.runStore.getActiveProviderPlan({
        issueNumber: 7,
        repository
      })?.status;
      return Promise.resolve();
    });

    const outcome = await harness.service.start(startRequest);

    expect(planAtLabelWrite).toBe("pending");
    expect(outcome).toMatchObject({
      kind: "started",
      plan: { provider: "omp", status: "label_written" }
    });
    expect(harness.addLabelsToIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 7, labels: ["agent-ready"] })
    );
  });

  it.each([
    [
      "a stale snapshot",
      { snapshotPolledAt: "2026-10-09T09:00:00.000Z" },
      {},
      /snapshot changed/
    ],
    [
      "a stale graph fingerprint",
      { graphFingerprint: "sha256:old" },
      {},
      /workflow changed/
    ],
    [
      "an unconfigured provider",
      { provider: "omp" },
      { registered: ["codex"] },
      /not configured/
    ],
    ["an unknown provider", { provider: "gemini" }, {}, /not a known provider/],
    [
      "a changed repository binding",
      {},
      { bindingError: () => "rendered snapshot repository mismatch" },
      /repository mismatch/
    ],
    [
      "a live Issue Reservation",
      {},
      { liveRunId: () => "run-live" },
      /run-live/
    ],
    [
      "an unresolved dependency in the snapshot",
      {},
      {
        snapshotReasons: [
          "missing required label agent-ready",
          "blocked by open dependency #3"
        ]
      },
      /open dependency/
    ],
    [
      "an already-ready snapshot",
      {},
      { snapshotLabels: ["agent-ready"], snapshotReasons: [] },
      /already has the Ready Label/
    ],
    [
      "a claimed issue",
      {},
      {
        snapshotLabels: ["sym:claimed"],
        snapshotReasons: [
          "missing required label agent-ready",
          "has operational label sym:claimed"
        ]
      },
      /sym:claimed/
    ]
  ])(
    "refuses %s without persisting a plan or touching GitHub",
    async (_name, requestOverrides, harnessOptions, message) => {
      const harness = await createService(harnessOptions);

      const outcome = await harness.service.start({
        ...startRequest,
        ...requestOverrides
      });

      expect(outcome.kind).toBe("refused");
      expect(JSON.stringify(outcome)).toMatch(message);
      expect(
        harness.runStore.getActiveProviderPlan({ issueNumber: 7, repository })
      ).toBeUndefined();
      expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
    }
  );

  it("refuses when live GitHub already shows the Ready Label though the snapshot is stale", async () => {
    const harness = await createService({
      getIssue: vi
        .fn()
        .mockResolvedValue(rawIssue({ labels: [{ name: "agent-ready" }] }))
    });

    const outcome = await harness.service.start(startRequest);

    expect(outcome).toMatchObject({ kind: "refused" });
    expect(
      harness.runStore.getActiveProviderPlan({ issueNumber: 7, repository })
    ).toBeUndefined();
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("refuses on an open or truncated live blocker", async () => {
    const open = await createService({
      getIssueDependencies: vi.fn().mockResolvedValue(
        new Map([
          [
            7,
            {
              blockedBy: [
                { number: 3, owner: "acme", repo: "widgets", state: "OPEN" }
              ],
              truncated: false
            }
          ]
        ])
      )
    });
    expect((await open.service.start(startRequest)).kind).toBe("refused");
    expect(open.addLabelsToIssue).not.toHaveBeenCalled();

    const truncated = await createService({
      getIssueDependencies: vi
        .fn()
        .mockResolvedValue(new Map([[7, { blockedBy: [], truncated: true }]]))
    });
    expect((await truncated.service.start(startRequest)).kind).toBe("refused");
    expect(truncated.addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("fails closed when the live read fails", async () => {
    const harness = await createService({
      getIssue: vi.fn().mockRejectedValue(new Error("network down"))
    });
    const outcome = await harness.service.start(startRequest);
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(JSON.stringify(outcome)).toContain("network down");
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("reports a label write failure honestly and leaves a retryable label_failed plan", async () => {
    const harness = await createService({
      addLabelsToIssue: vi.fn().mockRejectedValue(new Error("403 forbidden"))
    });

    const outcome = await harness.service.start(startRequest);

    expect(outcome).toMatchObject({
      error: "403 forbidden",
      kind: "label_write_failed",
      plan: { status: "label_failed" }
    });
    expect(
      harness.runStore.getActiveProviderPlan({ issueNumber: 7, repository })
    ).toMatchObject({ lastError: "403 forbidden", status: "label_failed" });
  });

  it("does not flip a consumed plan to label_failed when the write throws after a claim", async () => {
    const harness = await createService();
    harness.addLabelsToIssue.mockImplementation(() => {
      harness.runStore.createRun({
        id: "run-x",
        issue: {
          body: "",
          created_at: "",
          id: 7,
          labels: [],
          number: 7,
          priority: 0,
          state: "open",
          title: "x",
          updated_at: "",
          url: "https://github.com/acme/widgets/issues/7"
        },
        projectName: "widgets",
        providerCommand: "omp",
        providerName: "omp"
      });
      harness.runStore.consumeProviderPlan("plan-1", "run-x");
      return Promise.reject(new Error("timeout after landing"));
    });

    const outcome = await harness.service.start(startRequest);

    expect(outcome).toMatchObject({
      kind: "started",
      plan: { status: "consumed" }
    });
  });

  it("refuses a second concurrent Start while the first plan is pending", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createService({
      addLabelsToIssue: vi.fn().mockImplementation(() => gate)
    });

    const first = harness.service.start(startRequest);
    await vi.waitFor(() => {
      expect(harness.addLabelsToIssue).toHaveBeenCalledTimes(1);
    });
    const second = await harness.service.start(startRequest);
    release();
    await first;

    expect(second.kind).toBe("refused");
    expect(harness.addLabelsToIssue).toHaveBeenCalledTimes(1);
  });

  it("does not hold the dispatch mutex across the GitHub label write", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await createService({
      addLabelsToIssue: vi.fn().mockImplementation(() => gate)
    });

    const pending = harness.service.start(startRequest);
    await vi.waitFor(() => {
      expect(harness.addLabelsToIssue).toHaveBeenCalledTimes(1);
    });

    expect(harness.mutex.held).toBe(false);
    release();
    await pending;
  });
});

describe("ProviderStartService.retry and cancel", () => {
  async function failedPlan() {
    const addLabelsToIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const harness = await createService({ addLabelsToIssue });
    await harness.service.start(startRequest);
    return harness;
  }

  const retryRequest = {
    issueNumber: 7,
    planId: "plan-1",
    projectName: "widgets",
    snapshotRepository: repository
  };

  it("retries a failed plan with the same provider", async () => {
    const harness = await failedPlan();

    const outcome = await harness.service.retry(retryRequest);

    expect(outcome).toMatchObject({
      kind: "started",
      plan: { attemptCount: 2, provider: "omp", status: "label_written" }
    });
    expect(harness.addLabelsToIssue).toHaveBeenCalledTimes(2);
  });

  it("retries without a second write when the Ready Label already landed", async () => {
    const harness = await failedPlan();
    harness.getIssue.mockResolvedValue(
      rawIssue({ labels: [{ name: "agent-ready" }] })
    );

    const outcome = await harness.service.retry(retryRequest);

    expect(outcome).toMatchObject({
      kind: "started",
      plan: { status: "label_written" }
    });
    expect(harness.addLabelsToIssue).toHaveBeenCalledTimes(1);
  });

  it("refuses to retry after the workflow fingerprint changed", async () => {
    let fingerprint = "sha256:graph-a";
    const addLabelsToIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const harness = await createService({
      addLabelsToIssue,
      project: () => projectConfig({ fingerprint })
    });
    await harness.service.start(startRequest);
    fingerprint = "sha256:graph-b";

    const outcome = await harness.service.retry(retryRequest);

    expect(outcome.kind).toBe("refused");
    expect(addLabelsToIssue).toHaveBeenCalledTimes(1);
    expect(harness.runStore.getProviderPlan("plan-1")?.status).toBe(
      "label_failed"
    );
  });

  it("refuses to retry a plan from another repository", async () => {
    let repo = "widgets";
    const addLabelsToIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const harness = await createService({
      addLabelsToIssue,
      project: () => projectConfig({ repo })
    });
    await harness.service.start(startRequest);
    repo = "gadgets";

    const outcome = await harness.service.retry(retryRequest);

    expect(outcome.kind).toBe("refused");
    expect(addLabelsToIssue).toHaveBeenCalledTimes(1);
  });

  it("cancels a failed plan and then refuses to cancel it again", async () => {
    const harness = await failedPlan();

    expect(await harness.service.cancel(retryRequest)).toEqual({
      kind: "cancelled"
    });
    expect(harness.runStore.getProviderPlan("plan-1")?.status).toBe(
      "cancelled"
    );
    expect((await harness.service.cancel(retryRequest)).kind).toBe("refused");
  });

  it("refuses to cancel a label_written plan while the Issue still has the Ready Label", async () => {
    const harness = await createService();
    await harness.service.start(startRequest);
    harness.getIssue.mockResolvedValue(
      rawIssue({ labels: [{ name: "agent-ready" }] })
    );

    const outcome = await harness.service.cancel(retryRequest);

    expect(outcome.kind).toBe("refused");
    expect(harness.runStore.getProviderPlan("plan-1")?.status).toBe(
      "label_written"
    );

    harness.getIssue.mockResolvedValue(rawIssue());
    expect(await harness.service.cancel(retryRequest)).toEqual({
      kind: "cancelled"
    });
  });
});
