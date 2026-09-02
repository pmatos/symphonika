import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssuePollStatus, IssueSnapshot } from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  createAsyncMutex,
  type AsyncMutex
} from "../src/lifecycle/async-mutex.js";
import {
  RunController,
  type RunControllerProjectConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { createGitWorkspaceAtBase } from "./helpers/git-workspace.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const openStores: RunStore[] = [];

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-overlap-test-"));
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

describe("dispatch file-overlap guard", () => {
  it("skips a known collision without advancing the Project cursor", async () => {
    const harness = await createHarness();
    const result = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Candidate" }))
    );

    expect(result.dispatched).toBe(false);
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
    expect(
      harness.runStore.getProjectStatesByName().get("alpha")
        ?.lastDispatchedIssueNumber
    ).toBeNull();
    expect(
      harness.runStore.getProjectStatesByName().get("alpha")
        ?.schedulerCurrentWeight
    ).toBe(0);
  });

  it("selects a later non-colliding candidate in the same Project", async () => {
    const harness = await createHarness();
    const result = await harness.controller.dispatchOneFresh(
      pollStatusFor([
        issue({ number: 2, title: "Candidate" }),
        issue({ number: 3, title: "Independent" })
      ])
    );

    expect(result).toEqual({
      dispatched: true,
      runId: "candidate-run-1"
    });
    expect(harness.runStore.getRun("candidate-run-1")?.issueNumber).toBe(3);
  });

  it("dispatches a skipped candidate after the conflicting Run unregisters", async () => {
    const harness = await createHarness();
    const skipped = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Candidate" }))
    );
    expect(skipped.dispatched).toBe(false);

    harness.activeRuns.unregister("active-run");
    const retried = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Candidate" }))
    );

    expect(retried).toEqual({
      dispatched: true,
      runId: "candidate-run-1"
    });
    expect(harness.runStore.getRun("candidate-run-1")?.issueNumber).toBe(2);
    expect(harness.addLabelsToIssue).toHaveBeenCalledWith({
      issueNumber: 2,
      labels: ["sym:claimed"],
      owner: "acme",
      repo: "alpha",
      token: "secret"
    });
  });

  it("counts a committed branch change as in-flight footprint", async () => {
    const harness = await createHarness({
      setupWorkspace: async (workspacePath) => {
        await writeFile(path.join(workspacePath, "shared.ts"), "in flight\n");
        await git(["-C", workspacePath, "add", "shared.ts"]);
        await git(["-C", workspacePath, "commit", "-m", "In-flight work"]);
      }
    });
    const result = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Candidate" }))
    );

    expect(result.dispatched).toBe(false);
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("counts both paths of a committed in-flight rename", async () => {
    const harness = await createHarness({
      pullRequestFiles: () => Promise.resolve([{ filename: "README.md" }]),
      setupWorkspace: async (workspacePath) => {
        await git([
          "-C",
          workspacePath,
          "mv",
          "README.md",
          "renamed-readme.md"
        ]);
        await git(["-C", workspacePath, "commit", "-m", "Rename readme"]);
      }
    });
    const result = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Edits renamed source" }))
    );

    expect(result.dispatched).toBe(false);
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("counts both paths of a candidate pull request rename", async () => {
    const harness = await createHarness({
      pullRequestFiles: () =>
        Promise.resolve([
          { filename: "new-name.ts", previous_filename: "old-name.ts" }
        ]),
      setupWorkspace: (workspacePath) =>
        writeFile(path.join(workspacePath, "old-name.ts"), "in flight\n")
    });
    const result = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Candidate rename" }))
    );

    expect(result.dispatched).toBe(false);
    expect(harness.addLabelsToIssue).not.toHaveBeenCalled();
  });

  it("serializes overlap admission with the in-flight slot reservation", async () => {
    let markFirstAttemptStarted: (() => void) | undefined;
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      markFirstAttemptStarted = resolve;
    });
    const firstAttemptRelease = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const claimMutex = createAsyncMutex();
    await claimMutex.acquire();
    let claimAttempts = 0;
    let markFirstClaimWaiting: (() => void) | undefined;
    let markBothClaimsWaiting: (() => void) | undefined;
    const firstClaimWaiting = new Promise<void>((resolve) => {
      markFirstClaimWaiting = resolve;
    });
    const bothClaimsWaiting = new Promise<void>((resolve) => {
      markBothClaimsWaiting = resolve;
    });
    const observedClaimMutex: AsyncMutex = {
      acquire: async () => {
        claimAttempts += 1;
        if (claimAttempts === 1) {
          markFirstClaimWaiting?.();
        }
        if (claimAttempts === 2) {
          markBothClaimsWaiting?.();
        }
        await claimMutex.acquire();
      },
      get held() {
        return claimMutex.held;
      },
      release: () => claimMutex.release(),
      tryAcquire: () => claimMutex.tryAcquire()
    };
    let attemptCount = 0;
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        attemptCount += 1;
        if (attemptCount === 1) {
          markFirstAttemptStarted?.();
          await firstAttemptRelease;
        }
        yield {
          normalized: { exitCode: 1, type: "process_exit" },
          raw: { code: 1, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const harness = await createHarness({
      agentProvider: provider,
      dispatchMutex: observedClaimMutex,
      includeActiveRun: false,
      pullRequestFiles: () => Promise.resolve([{ filename: "shared.ts" }])
    });

    const firstDispatch = harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "First candidate" }))
    );
    await firstClaimWaiting;
    const secondDispatch = harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 3, title: "Second candidate" }))
    );
    await bothClaimsWaiting;
    claimMutex.release();
    await firstAttemptStarted;
    const secondResult = await secondDispatch;

    releaseFirstAttempt?.();
    await firstDispatch;

    expect(secondResult.dispatched).toBe(false);
    expect(harness.runStore.getRun("candidate-run-2")).toBeUndefined();
  });

  it("ignores base-branch commits the in-flight Run never made", async () => {
    const harness = await createHarness({
      setupWorkspace: async (workspacePath) => {
        await writeFile(path.join(workspacePath, "isolated.ts"), "in flight\n");
        await git(["-C", workspacePath, "add", "isolated.ts"]);
        await git(["-C", workspacePath, "commit", "-m", "In-flight work"]);
        // The shared repository cache re-fetches the base branch while a Run
        // is live, so origin/main can carry a commit touching the candidate's
        // files that this Run never made. A two-dot range would read that as
        // this Run's own footprint and block the candidate forever.
        const baseSha = await git([
          "-C",
          workspacePath,
          "rev-parse",
          "refs/remotes/origin/main"
        ]);
        await git([
          "-C",
          workspacePath,
          "checkout",
          "-q",
          "-b",
          "base",
          baseSha
        ]);
        await writeFile(path.join(workspacePath, "shared.ts"), "landed\n");
        await git(["-C", workspacePath, "add", "shared.ts"]);
        await git(["-C", workspacePath, "commit", "-m", "Base advance"]);
        await git([
          "-C",
          workspacePath,
          "update-ref",
          "refs/remotes/origin/main",
          await git(["-C", workspacePath, "rev-parse", "HEAD"])
        ]);
        await git([
          "-C",
          workspacePath,
          "checkout",
          "-q",
          "sym/alpha/1-active"
        ]);
      }
    });
    const result = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Candidate" }))
    );

    expect(result).toEqual({
      dispatched: true,
      runId: "candidate-run-1"
    });
  });

  it("fails open when a linked pull request footprint cannot be loaded", async () => {
    const harness = await createHarness();
    const result = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 4, title: "Unavailable footprint" }))
    );

    expect(result).toEqual({
      dispatched: true,
      runId: "candidate-run-1"
    });
  });

  it("fails open when an expired candidate footprint cannot be refreshed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const harness = await createHarness();
    const firstResult = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Initially conflicting" }))
    );
    expect(firstResult.dispatched).toBe(false);

    now.mockReturnValue(31_001);
    harness.listPullRequestFiles.mockRejectedValue(
      new Error("GitHub files unavailable")
    );
    const retryResult = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "No longer conflicting" }))
    );

    expect(retryResult).toEqual({
      dispatched: true,
      runId: "candidate-run-1"
    });
  });

  it("clears a stale in-flight footprint when its refresh fails", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const harness = await createHarness();
    const firstResult = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "Initially conflicting" }))
    );
    expect(firstResult.dispatched).toBe(false);

    await rm(path.join(harness.workspacePath, "shared.ts"));
    await rm(path.join(harness.workspacePath, ".git"), {
      force: true,
      recursive: true
    });
    now.mockReturnValue(31_001);
    const retryResult = await harness.controller.dispatchOneFresh(
      pollStatus(issue({ number: 2, title: "No longer conflicting" }))
    );

    expect(retryResult).toEqual({
      dispatched: true,
      runId: "candidate-run-1"
    });
    expect(harness.activeRuns.get("active-run")?.touchedFiles).toEqual({
      files: [],
      refreshedAt: 31_001
    });
  });
});

async function createHarness(
  options: {
    agentProvider?: AgentProvider;
    dispatchMutex?: AsyncMutex;
    includeActiveRun?: boolean;
    pullRequestFiles?: () => Promise<
      Array<{ filename?: string; previous_filename?: string }>
    >;
    setupWorkspace?: (workspacePath: string) => Promise<void>;
  } = {}
): Promise<{
  activeRuns: ActiveRunRegistry;
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  controller: RunController;
  listPullRequestFiles: ReturnType<typeof vi.fn>;
  runStore: RunStore;
  workspacePath: string;
}> {
  const root = await makeTempRoot();
  const stateRoot = path.join(root, "state");
  const workspacePath = path.join(
    root,
    "workspaces",
    "alpha",
    "issues",
    "1-active"
  );
  await createGitWorkspaceAtBase({
    branchName: "sym/alpha/1-active",
    workspacePath
  });
  if (options.includeActiveRun !== false) {
    if (options.setupWorkspace === undefined) {
      await writeFile(path.join(workspacePath, "shared.ts"), "in flight\n");
    } else {
      await options.setupWorkspace(workspacePath);
    }
  }
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");

  const runStore = openRunStore({ stateRoot });
  openStores.push(runStore);
  const activeRuns = new ActiveRunRegistry();
  runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);
  if (options.includeActiveRun !== false) {
    runStore.createRun({
      id: "active-run",
      issue: issue({ number: 1, title: "Active" }),
      projectName: "alpha",
      providerCommand: "codex",
      providerName: "codex"
    });
    runStore.updateRunEvidence("active-run", {
      branchName: "sym/alpha/1-active",
      branchRef: "refs/heads/sym/alpha/1-active",
      issueSnapshotPath: path.join(stateRoot, "issue.json"),
      metadataPath: path.join(stateRoot, "metadata.json"),
      normalizedLogPath: path.join(stateRoot, "normalized.jsonl"),
      promptPath: path.join(stateRoot, "prompt.md"),
      rawLogPath: path.join(stateRoot, "raw.jsonl"),
      workflowGraphPath: path.join(stateRoot, "workflow.json"),
      workspacePath
    });
    activeRuns.reserveSlot({
      issueNumber: 1,
      projectName: "alpha",
      runId: "active-run"
    });
  }

  const project: RunControllerProjectConfig = {
    agent: { provider: "codex" },
    dispatch: { overlap_guard: true },
    issue_filters: {
      labels_all: ["agent-ready"],
      labels_none: [],
      states: ["open"]
    },
    max_in_flight: 2,
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
      git: {
        base_branch: "main",
        remote: "git@github.com:acme/alpha.git"
      },
      root: path.join(root, "workspaces", "alpha")
    }
  };
  const addLabelsToIssue = vi.fn().mockResolvedValue(undefined);
  const listPullRequestFiles = vi
    .fn()
    .mockImplementation(({ pullNumber }: { pullNumber: number }) => {
      if (options.pullRequestFiles !== undefined) {
        return options.pullRequestFiles();
      }
      if (pullNumber === 44) {
        return Promise.reject(new Error("GitHub files unavailable"));
      }
      return Promise.resolve([
        { filename: pullNumber === 22 ? "shared.ts" : "independent.ts" }
      ]);
    });
  let runCounter = 0;
  const controller = new RunController({
    activeRuns,
    agentProviders: { codex: options.agentProvider ?? failingProvider() },
    configDir: root,
    createRunId: () => `candidate-run-${++runCounter}`,
    ...(options.dispatchMutex === undefined
      ? {}
      : { dispatchMutex: options.dispatchMutex }),
    emailConfigLoader: () => undefined,
    env: { GITHUB_TOKEN: "secret" },
    githubIssuesApi: {
      addLabelsToIssue,
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequestFiles,
      listPullRequestsForBranch: vi
        .fn()
        .mockImplementation(({ branch }: { branch: string }) =>
          Promise.resolve([
            {
              draft: false,
              head: { ref: branch, sha: `head-${branch}` },
              number: branch.includes("/2-")
                ? 22
                : branch.includes("/3-")
                  ? 33
                  : 44,
              state: "open"
            }
          ])
        ),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    },
    lifecyclePolicy: {
      continuation: { cap: 0, delayMs: 0 },
      retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
    },
    prepareIssueWorkspace: ({ issue: candidateIssue }) =>
      Promise.resolve({
        branchName: `sym/alpha/${candidateIssue.number}-candidate`,
        branchRef: `refs/heads/sym/alpha/${candidateIssue.number}-candidate`,
        cachePath: path.join(root, "cache", "repo.git"),
        issueDirectoryName: `${candidateIssue.number}-candidate`,
        reused: false,
        workspacePath: path.join(
          root,
          "workspaces",
          "alpha",
          "issues",
          `${candidateIssue.number}-candidate`
        )
      }),
    projectsLoader: () => Promise.resolve(new Map([["alpha", project]])),
    providersLoader: () =>
      Promise.resolve({
        claude: { command: "claude" },
        codex: { command: "codex" }
      }),
    runStore,
    schedule: () => true,
    stateRoot
  });

  return {
    activeRuns,
    addLabelsToIssue,
    controller,
    listPullRequestFiles,
    runStore,
    workspacePath
  };
}

function issue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "2026-08-01T00:00:00.000Z",
    id: overrides.number ?? 1,
    labels: ["agent-ready"],
    number: 1,
    priority: 1,
    state: "open",
    title: "Issue",
    updated_at: "2026-08-01T00:00:00.000Z",
    url: "https://example.test/issues/1",
    ...overrides
  };
}

function pollStatus(candidate: IssueSnapshot): IssuePollStatus {
  return pollStatusFor([candidate]);
}

function pollStatusFor(candidates: IssueSnapshot[]): IssuePollStatus {
  return {
    candidateIssues: candidates.map((candidate) => ({
      issue: candidate,
      project: "alpha",
      repository: { owner: "acme", repo: "alpha" }
    })),
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

function failingProvider(): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    async *runAttempt(): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      yield {
        normalized: { exitCode: 1, type: "process_exit" },
        raw: { code: 1, kind: "exit" }
      };
    },
    validate: vi.fn().mockResolvedValue(undefined)
  };
}
