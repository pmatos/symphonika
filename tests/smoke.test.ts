import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REQUIRED_OPERATIONAL_LABELS, type GitHubApi } from "../src/doctor.js";
import type { GitHubIssuesApi } from "../src/issue-polling.js";
import type {
  AgentProvider,
  AgentProviderRegistry,
  ProviderEvent
} from "../src/provider.js";
import { runSmoke } from "../src/smoke.js";
import { openRunStore } from "../src/run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";
import {
  createGitWorkspaceAhead,
  createGitWorkspaceAtBase
} from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-smoke-test-"));
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

describe("runSmoke", () => {
  it("reports skipReason when no eligible issue exists in the configured project", async () => {
    const root = await makeTempRoot();
    await writeBootstrapProject(root);

    const githubApi = successfulGitHubApi();
    const githubIssuesApi: GitHubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([])
    };

    const report = await runSmoke({
      agentProviders: { codex: fakeCodexProvider() },
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: { GITHUB_TOKEN: "test-token" },
      githubApi,
      githubIssuesApi
    });

    expect(report.ok).toBe(true);
    expect(report.dispatched).toBe(false);
    expect(report.skipReason).toBeDefined();
    expect(report.skipReason).toMatch(/no eligible/i);
    expect(report.errors).toEqual([]);
  });

  it("warns when a claimed issue blocks smoke without a live local run", async () => {
    const root = await makeTempRoot();
    await writeBootstrapProject(root);

    const issueNumber = 77;
    const githubApi = successfulGitHubApi();
    const githubIssuesApi: GitHubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          body: "Body of issue 77",
          created_at: "2026-04-20T10:00:00Z",
          html_url: `https://github.com/pmatos/symphonika/issues/${issueNumber}`,
          id: 5077,
          labels: [{ name: "agent-ready" }, { name: "sym:claimed" }],
          number: issueNumber,
          state: "open",
          title: "Orphan claimed issue",
          updated_at: "2026-04-21T11:00:00Z"
        }
      ])
    };
    const codex = fakeCodexProvider();

    const report = await runSmoke({
      agentProviders: { codex },
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: { GITHUB_TOKEN: "test-token" },
      githubApi,
      githubIssuesApi
    });

    expect(report.ok).toBe(true);
    expect(report.dispatched).toBe(false);
    expect(report.skipReason).toBe("no eligible issues to dispatch");
    expect(report.warnings).toEqual([
      expect.stringContaining(
        "issue #77 carries sym:claimed without a live local run"
      )
    ]);
    expect(report.warnings[0]).toContain(
      "symphonika clear-stale symphonika 77"
    );
    expect(codex.runAttempt).not.toHaveBeenCalled();
  });

  it("short-circuits with doctor errors when operational labels are missing and never dispatches", async () => {
    const root = await makeTempRoot();
    await writeBootstrapProject(root);

    const githubApi: GitHubApi = {
      createLabel: vi.fn().mockResolvedValue(undefined),
      // No operational labels exist on the repo.
      listLabels: () => Promise.resolve([]),
      validateRepositoryAccess: () => Promise.resolve({ ok: true })
    };
    const githubIssuesApi: GitHubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([])
    };
    const codex = fakeCodexProvider();

    const report = await runSmoke({
      agentProviders: { codex },
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: { GITHUB_TOKEN: "test-token" },
      githubApi,
      githubIssuesApi
    });

    expect(report.ok).toBe(false);
    expect(report.dispatched).toBe(false);
    expect(
      report.errors.some((e) => e.includes("missing operational labels"))
    ).toBe(true);
    // Smoke must never auto-create labels (AC#7).
    expect(githubApi.createLabel).not.toHaveBeenCalled();
    // No provider attempt should be launched on doctor failure.
    expect(codex.runAttempt).not.toHaveBeenCalled();
  });

  it("dispatches one eligible issue, captures evidence, and reports succeeded", async () => {
    const root = await makeTempRoot();
    await writeBootstrapProject(root);

    const issueNumber = 42;
    const issueTitle = "Wire bootstrap smoke test";
    const issueDirectory = `${issueNumber}-wire-bootstrap-smoke-test`;
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      issueDirectory
    );

    const githubApi = successfulGitHubApi();
    const githubIssuesApi: GitHubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          body: "Body of issue 42",
          created_at: "2026-04-20T10:00:00Z",
          html_url: `https://github.com/pmatos/symphonika/issues/${issueNumber}`,
          id: 5042,
          labels: [{ name: "agent-ready" }],
          number: issueNumber,
          state: "open",
          title: issueTitle,
          updated_at: "2026-04-21T11:00:00Z"
        }
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codex: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { sessionId: "fake-session", type: "session_started" },
          raw: { id: "fake-session", kind: "session" }
        };
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        void input;
        const prepared = {
          branchName: `sym/symphonika/${issueDirectory}`,
          branchRef: `refs/heads/sym/symphonika/${issueDirectory}`,
          cachePath: path.join(
            root,
            ".symphonika",
            "workspaces",
            "symphonika",
            ".cache",
            "repo.git"
          ),
          issueDirectoryName: issueDirectory,
          reused: false,
          workspacePath
        };
        return Promise.resolve(prepared);
      }
    );
    await createGitWorkspaceAhead({
      branchName: `sym/symphonika/${issueDirectory}`,
      workspacePath
    });

    const report = await runSmoke({
      agentProviders: { codex },
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: { GITHUB_TOKEN: "test-token" },
      githubApi,
      githubIssuesApi,
      prepareIssueWorkspace
    });

    expect(report.ok).toBe(true);
    expect(report.dispatched).toBe(true);
    expect(report.runId).toBeDefined();
    expect(report.runDetail).toMatchObject({
      branchName: `sym/symphonika/${issueDirectory}`,
      issueNumber,
      project: "symphonika",
      provider: "codex",
      state: "succeeded",
      workspacePath
    });
    expect(githubIssuesApi.addLabelsToIssue).toHaveBeenCalled();
    expect(prepareIssueWorkspace).toHaveBeenCalledOnce();

    expect(report.runDetail).toBeDefined();
    const detail = report.runDetail!;
    expect(detail.artifacts.map((artifact) => artifact.kind)).toContain(
      "prompt"
    );
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    try {
      await expect(store.getRenderedPrompt(detail.id)).resolves.toContain(
        "Autonomous run instructions"
      );
      await expect(store.getRenderedPrompt(detail.id)).resolves.toContain(
        issueTitle
      );
    } finally {
      store.close();
    }
  });

  it("surfaces no_workspace_changes when an exit-0 provider leaves the issue branch at base", async () => {
    const root = await makeTempRoot();
    await writeBootstrapProject(root);

    const issueNumber = 52;
    const issueTitle = "Verify provider work before success";
    const issueDirectory = `${issueNumber}-verify-provider-work-before-success`;
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      issueDirectory
    );
    const branchName = `sym/symphonika/${issueDirectory}`;
    await createGitWorkspaceAtBase({ branchName, workspacePath });

    const githubApi = successfulGitHubApi();
    const githubIssuesApi: GitHubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          body: "Exit 0, but no workspace commits.",
          created_at: "2026-04-20T10:00:00Z",
          html_url: `https://github.com/pmatos/symphonika/issues/${issueNumber}`,
          id: 6000 + issueNumber,
          labels: [{ name: "agent-ready" }],
          number: issueNumber,
          state: "open",
          title: issueTitle,
          updated_at: "2026-04-21T11:00:00Z"
        }
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codex: AgentProvider = {
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
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve({
        branchName,
        branchRef: `refs/heads/${branchName}`,
        cachePath: path.join(
          root,
          ".symphonika",
          "workspaces",
          "symphonika",
          ".cache",
          "repo.git"
        ),
        issueDirectoryName: issueDirectory,
        reused: false,
        workspacePath
      })
    );

    const report = await runSmoke({
      agentProviders: { codex },
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: { GITHUB_TOKEN: "test-token" },
      githubApi,
      githubIssuesApi,
      prepareIssueWorkspace
    });

    expect(report.dispatched).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.runDetail).toMatchObject({
      issueNumber,
      state: "failed",
      terminalReason: "no_workspace_changes",
      workspacePath
    });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("terminalReason=no_workspace_changes");
    expect(githubIssuesApi.addLabelsToIssue).toHaveBeenCalledWith({
      issueNumber,
      labels: ["sym:failed"],
      owner: "pmatos",
      repo: "symphonika",
      token: "test-token"
    });
  });

  it("surfaces a failed terminal run state when the provider reports turn_failed", async () => {
    const root = await makeTempRoot();
    await writeBootstrapProject(root);

    const issueNumber = 99;
    const issueDirectory = `${issueNumber}-provider-failure`;
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      issueDirectory
    );
    await mkdir(workspacePath, { recursive: true });

    const githubApi = successfulGitHubApi();
    const githubIssuesApi: GitHubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          body: "This run will fail.",
          created_at: "2026-04-20T10:00:00Z",
          html_url: `https://github.com/pmatos/symphonika/issues/${issueNumber}`,
          id: 6000 + issueNumber,
          labels: [{ name: "agent-ready" }],
          number: issueNumber,
          state: "open",
          title: "Provider terminal failure",
          updated_at: "2026-04-21T11:00:00Z"
        }
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codex: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: {
            message: "turn_failed: legacy codex refused the run",
            type: "turn_failed"
          },
          raw: { kind: "turn_failed", message: "legacy codex refused the run" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn((): Promise<PreparedIssueWorkspace> =>
      Promise.resolve({
        branchName: `sym/symphonika/${issueDirectory}`,
        branchRef: `refs/heads/sym/symphonika/${issueDirectory}`,
        cachePath: path.join(
          root,
          ".symphonika",
          "workspaces",
          "symphonika",
          ".cache",
          "repo.git"
        ),
        issueDirectoryName: issueDirectory,
        reused: false,
        workspacePath
      })
    );

    const report = await runSmoke({
      agentProviders: { codex },
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      env: { GITHUB_TOKEN: "test-token" },
      githubApi,
      githubIssuesApi,
      prepareIssueWorkspace
    });

    expect(report.dispatched).toBe(true);
    expect(report.runDetail?.state).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(report.runId);
    expect(report.errors[0]).toContain("terminalReason=turn_failed");
    expect(report.errors[0]).toContain("provider_normalized");

    expect(githubIssuesApi.addLabelsToIssue).toHaveBeenCalledWith({
      issueNumber,
      labels: ["sym:failed"],
      owner: "pmatos",
      repo: "symphonika",
      token: "test-token"
    });
    expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledTimes(1);
    expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith({
      issueNumber,
      labels: ["sym:running"],
      owner: "pmatos",
      repo: "symphonika",
      token: "test-token"
    });
  });
});

async function writeBootstrapProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      `    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"`,
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
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
      "      labels:",
      '        "priority:high": 1',
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces/symphonika",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    [
      "Work on #{{issue.number}}: {{issue.title}}.",
      "Use {{workspace.path}} on {{branch.name}}.",
      "Provider {{provider.name}} runs {{provider.command}}.",
      ""
    ].join("\n")
  );
}

function successfulGitHubApi(): GitHubApi {
  return {
    createLabel: () => Promise.resolve(),
    listLabels: () => Promise.resolve([...REQUIRED_OPERATIONAL_LABELS]),
    validateRepositoryAccess: () => Promise.resolve({ ok: true })
  };
}

function fakeCodexProvider(): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    runAttempt: vi.fn(async function* () {
      await Promise.resolve();
      yield* [];
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

// Re-export to satisfy ts module shape; not a runtime use.
export type { AgentProviderRegistry };
