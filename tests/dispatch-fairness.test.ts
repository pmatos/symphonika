import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchOneEligibleIssue } from "../src/dispatch.js";
import type { IssuePollStatus, IssueSnapshot } from "../src/issue-polling.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-fairness-test-"));
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

describe("dispatch fairness", () => {
  it("dispatches fresh issues with weighted project fairness", async () => {
    const root = await makeTempRoot();
    await writeWeightedConfig(root);
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    runStore.syncProjectStates([
      { name: "alpha", weight: 2 },
      { name: "beta", weight: 1 }
    ]);
    let runCounter = 0;
    const provider: AgentProvider = {
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
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const pollStatus = pollStatusFor([
      { issue: issue({ number: 1, title: "Alpha issue" }), project: "alpha" },
      { issue: issue({ number: 2, title: "Beta issue" }), project: "beta" }
    ]);
    const prepareIssueWorkspace = vi.fn(
      async (
        input: PrepareIssueWorkspaceInput
      ): Promise<PreparedIssueWorkspace> => {
        const workspacePath = path.join(
          root,
          "workspaces",
          `${input.project.name}-${input.issue.number}-${runCounter}`
        );
        const prepared = {
          branchName: `sym/${input.project.name}/${input.issue.number}`,
          branchRef: `refs/heads/sym/${input.project.name}/${input.issue.number}`,
          cachePath: path.join(root, "cache", `${input.project.name}.git`),
          issueDirectoryName: `${input.issue.number}`,
          reused: false,
          workspacePath
        };
        await createGitWorkspaceAhead(prepared);
        return prepared;
      }
    );

    try {
      const dispatchedProjects: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const result = await dispatchOneEligibleIssue({
          agentProviders: { codex: provider },
          configDir: root,
          configPath: path.join(root, "symphonika.yml"),
          createRunId: () => {
            runCounter += 1;
            return `run-${runCounter}`;
          },
          env: { GITHUB_TOKEN: "secret-token" },
          githubIssuesApi,
          issuePollStatus: pollStatus,
          prepareIssueWorkspace,
          runStore,
          stateRoot: path.join(root, ".symphonika")
        });
        expect(result.dispatched).toBe(true);
        if (result.dispatched) {
          const run = runStore.getRun(result.runId);
          expect(run).toBeDefined();
          dispatchedProjects.push(run?.project ?? "");
        }
      }

      expect(dispatchedProjects).toEqual(["alpha", "beta", "alpha"]);
      expect(
        runStore.listProjectStates().map((state) => ({
          currentWeight: state.schedulerCurrentWeight,
          lastDispatchedIssueNumber: state.lastDispatchedIssueNumber,
          projectName: state.projectName
        }))
      ).toEqual([
        {
          currentWeight: 0,
          lastDispatchedIssueNumber: 1,
          projectName: "alpha"
        },
        {
          currentWeight: 0,
          lastDispatchedIssueNumber: 2,
          projectName: "beta"
        }
      ]);
    } finally {
      runStore.close();
    }
  });

  it("chooses the highest-priority oldest issue inside the selected project", async () => {
    const root = await makeTempRoot();
    await writeWeightedConfig(root);
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);
    let runCounter = 0;
    const provider: AgentProvider = {
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
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const pollStatus = pollStatusFor([
      {
        issue: issue({
          created_at: "2026-05-03T00:00:00.000Z",
          number: 30,
          priority: 3,
          title: "Low priority"
        }),
        project: "alpha"
      },
      {
        issue: issue({
          created_at: "2026-05-02T00:00:00.000Z",
          number: 20,
          priority: 1,
          title: "High priority newer"
        }),
        project: "alpha"
      },
      {
        issue: issue({
          created_at: "2026-05-01T00:00:00.000Z",
          number: 10,
          priority: 1,
          title: "High priority oldest"
        }),
        project: "alpha"
      }
    ]);
    const prepareIssueWorkspace = vi.fn(
      async (
        input: PrepareIssueWorkspaceInput
      ): Promise<PreparedIssueWorkspace> => {
        runCounter += 1;
        const workspacePath = path.join(
          root,
          "workspaces",
          `${input.project.name}-${input.issue.number}-${runCounter}`
        );
        const prepared = {
          branchName: `sym/${input.project.name}/${input.issue.number}`,
          branchRef: `refs/heads/sym/${input.project.name}/${input.issue.number}`,
          cachePath: path.join(root, "cache", `${input.project.name}.git`),
          issueDirectoryName: `${input.issue.number}`,
          reused: false,
          workspacePath
        };
        await createGitWorkspaceAhead(prepared);
        return prepared;
      }
    );

    try {
      const result = await dispatchOneEligibleIssue({
        agentProviders: { codex: provider },
        configDir: root,
        configPath: path.join(root, "symphonika.yml"),
        createRunId: () => "run-priority",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        issuePollStatus: pollStatus,
        prepareIssueWorkspace,
        runStore,
        stateRoot: path.join(root, ".symphonika")
      });

      expect(result.dispatched).toBe(true);
      expect(runStore.getRun("run-priority")?.issueNumber).toBe(10);
    } finally {
      runStore.close();
    }
  });

  it("records configured project weights during one-shot dispatch before project sync", async () => {
    const root = await makeTempRoot();
    await writeWeightedConfig(root);
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    const provider: AgentProvider = {
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
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const pollStatus = pollStatusFor([
      { issue: issue({ number: 1, title: "Alpha issue" }), project: "alpha" },
      { issue: issue({ number: 2, title: "Beta issue" }), project: "beta" }
    ]);
    const prepareIssueWorkspace = vi.fn(
      async (
        input: PrepareIssueWorkspaceInput
      ): Promise<PreparedIssueWorkspace> => {
        const prepared = {
          branchName: `sym/${input.project.name}/${input.issue.number}`,
          branchRef: `refs/heads/sym/${input.project.name}/${input.issue.number}`,
          cachePath: path.join(root, "cache", `${input.project.name}.git`),
          issueDirectoryName: `${input.issue.number}`,
          reused: false,
          workspacePath: path.join(
            root,
            "workspaces",
            `${input.project.name}-${input.issue.number}`
          )
        };
        await createGitWorkspaceAhead(prepared);
        return prepared;
      }
    );

    try {
      const result = await dispatchOneEligibleIssue({
        agentProviders: { codex: provider },
        configDir: root,
        configPath: path.join(root, "symphonika.yml"),
        createRunId: () => "run-weight-metadata",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi,
        issuePollStatus: pollStatus,
        prepareIssueWorkspace,
        runStore,
        stateRoot: path.join(root, ".symphonika")
      });

      expect(result.dispatched).toBe(true);
      expect(
        runStore.listProjectStates().map((state) => ({
          active: state.active,
          projectName: state.projectName,
          validationState: state.validationState,
          weight: state.weight
        }))
      ).toEqual([
        {
          active: true,
          projectName: "alpha",
          validationState: "valid",
          weight: 2
        },
        {
          active: true,
          projectName: "beta",
          validationState: "valid",
          weight: 1
        }
      ]);
    } finally {
      runStore.close();
    }
  });
});

function pollStatusFor(
  candidateIssues: IssuePollStatus["candidateIssues"]
): IssuePollStatus {
  return {
    candidateIssues,
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

function issue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "2026-05-01T00:00:00.000Z",
    id: overrides.number ?? 1,
    labels: ["agent-ready"],
    number: 1,
    priority: 1,
    state: "open",
    title: "Issue",
    updated_at: "2026-05-01T00:00:00.000Z",
    url: "https://example.test/1",
    ...overrides
  };
}

async function writeWeightedConfig(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "providers:",
      "  codex:",
      '    command: "codex fake"',
      "  claude:",
      '    command: "claude fake"',
      "projects:",
      "  - name: alpha",
      "    weight: 2",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: alpha",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./workspaces/alpha",
      "      git:",
      "        remote: git@github.com:pmatos/alpha.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      "  - name: beta",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: beta",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./workspaces/beta",
      "      git:",
      "        remote: git@github.com:pmatos/beta.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
}
