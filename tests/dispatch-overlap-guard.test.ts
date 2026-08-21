import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IssuePollStatus, IssueSnapshot } from "../src/issue-polling.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig
} from "../src/lifecycle/run-controller.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { createGitWorkspaceAtBase } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-overlap-test-"));
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

describe("dispatch file-overlap guard", () => {
  it("skips a known collision without advancing the Project cursor", async () => {
    const harness = await createHarness();
    try {
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
    } finally {
      harness.runStore.close();
    }
  });

  it("selects a later non-colliding candidate in the same Project", async () => {
    const harness = await createHarness();
    try {
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
    } finally {
      harness.runStore.close();
    }
  });

  it("dispatches a skipped candidate after the conflicting Run unregisters", async () => {
    const harness = await createHarness();
    try {
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
    } finally {
      harness.runStore.close();
    }
  });

  it("fails open when a linked pull request footprint cannot be loaded", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.controller.dispatchOneFresh(
        pollStatus(issue({ number: 4, title: "Unavailable footprint" }))
      );

      expect(result).toEqual({
        dispatched: true,
        runId: "candidate-run-1"
      });
    } finally {
      harness.runStore.close();
    }
  });
});

async function createHarness(): Promise<{
  activeRuns: ActiveRunRegistry;
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  controller: RunController;
  runStore: RunStore;
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
  await writeFile(path.join(workspacePath, "shared.ts"), "in flight\n");
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");

  const runStore = openRunStore({ stateRoot });
  const activeRuns = new ActiveRunRegistry();
  runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);
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
  let runCounter = 0;
  const controller = new RunController({
    activeRuns,
    agentProviders: { codex: failingProvider() },
    configDir: root,
    createRunId: () => `candidate-run-${++runCounter}`,
    env: { GITHUB_TOKEN: "secret" },
    githubIssuesApi: {
      addLabelsToIssue,
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequestFiles: vi
        .fn()
        .mockImplementation(({ pullNumber }: { pullNumber: number }) => {
          if (pullNumber === 44) {
            return Promise.reject(new Error("GitHub files unavailable"));
          }
          return Promise.resolve([
            { filename: pullNumber === 22 ? "shared.ts" : "independent.ts" }
          ]);
        }),
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
    schedule: () => undefined,
    stateRoot
  });

  return { activeRuns, addLabelsToIssue, controller, runStore };
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
