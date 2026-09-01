import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// The RunStore watermark this test pins against is written by a synchronous
// SQLite call that persistProviderEvent (run-controller.ts) now issues
// *before* awaiting the JSONL append for the same event. Blocking that
// append here — without also blocking the SQLite write — is what lets the
// test observe the watermark while the append is still in flight. Hoisted
// because vi.mock factories run before this file's own imports execute, so
// the factory below can only close over state built the same way. See ADR
// 0090.
const providerAppendGate = vi.hoisted(() => {
  let blockedSuffix: string | null = null;
  let releaseGate: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  let signalBlocked: (() => void) | null = null;
  let blocked: Promise<void> | null = null;

  return {
    arm(suffix: string): void {
      blockedSuffix = suffix;
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      blocked = new Promise<void>((resolve) => {
        signalBlocked = resolve;
      });
    },
    disarm(): void {
      blockedSuffix = null;
      releaseGate = null;
      gate = null;
      signalBlocked = null;
      blocked = null;
    },
    async holdIfMatched(filePath: string): Promise<void> {
      if (blockedSuffix === null || !filePath.endsWith(blockedSuffix)) {
        return;
      }
      signalBlocked?.();
      await gate;
    },
    release(): void {
      releaseGate?.();
    },
    waitUntilBlocked(): Promise<void> {
      return blocked ?? Promise.resolve();
    }
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (
      filePath: Parameters<typeof actual.appendFile>[0],
      data: Parameters<typeof actual.appendFile>[1],
      options?: Parameters<typeof actual.appendFile>[2]
    ) => {
      if (typeof filePath === "string") {
        await providerAppendGate.holdIfMatched(filePath);
      }
      return actual.appendFile(filePath, data, options);
    }
  };
});

import type { IssuePollStatus, IssueSnapshot } from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-provider-event-ordering-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  providerAppendGate.disarm();
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("persistProviderEvent ordering", () => {
  it("advances the provider stream watermark before the JSONL append for the same event resolves", async () => {
    // Armed before dispatch: the very first provider event this attempt
    // receives is raw-only (normalized: undefined), which routes through
    // recordProviderStreamReceipt and appends only to the raw log — so
    // gating provider.raw.jsonl blocks exactly that append.
    providerAppendGate.arm("provider.raw.jsonl");

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield { raw: { chunk: "partial provider output" } };
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const harness = await createHarness(provider);
    // Matches runFreshLifecycle's fixed attemptId shape (`${runId}-attempt-
    // ${attemptNumber}`) for a first attempt against this harness's
    // deterministic createRunId.
    const attemptId = "run-1-attempt-1";

    const dispatchPromise = harness.controller.dispatchOneFresh(pollStatus());

    await providerAppendGate.waitUntilBlocked();

    try {
      const receipt = harness.runStore.getProviderStreamReceipt(attemptId);
      expect(receipt).toBeDefined();
      expect(receipt?.lastEventSequence).toBe(1);
    } finally {
      // Release even if the assertions above throw, so the attempt still
      // drains instead of leaving a dangling append behind for this test.
      providerAppendGate.release();
    }

    const result = await dispatchPromise;
    expect(result).toEqual({ dispatched: true, runId: "run-1" });
  });
});

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

async function createHarness(
  provider: AgentProvider
): Promise<{ controller: RunController; runStore: RunStore }> {
  const root = await makeTempRoot();
  const stateRoot = path.join(root, "state");
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");

  const runStore = openRunStore({ stateRoot });
  openStores.push(runStore);
  runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);
  const activeRuns = new ActiveRunRegistry();

  const controller = new RunController({
    activeRuns,
    agentProviders: { codex: provider },
    configDir: root,
    createRunId: () => "run-1",
    emailConfigLoader: () => undefined,
    env: { GITHUB_TOKEN: "secret" },
    githubIssuesApi: {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    },
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

  return { controller, runStore };
}
