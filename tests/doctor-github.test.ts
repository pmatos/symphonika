import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runClearStale,
  runDoctor,
  runInitProject,
  type GitHubApi
} from "../src/doctor.js";
import type { GitHubIssuesApi } from "../src/issue-polling.js";
import type { AgentProviderRegistry } from "../src/provider.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-github-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("GitHub Project validation", () => {
  it("marks a Project valid for dispatch when repository access and operational labels are present", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([
        "agent-ready",
        "sym:claimed",
        "sym:running",
        "sym:failed",
        "sym:stale"
      ]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi
    });

    expect(report.ok).toBe(true);
    expect(report.projects[0]).toMatchObject({
      missingOperationalLabels: [],
      validForDispatch: true
    });
    expect(githubApi.listLabels).toHaveBeenCalledWith({
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
  });

  it("reports repository access failures during doctor validation", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      validateRepositoryAccess: vi.fn().mockResolvedValue({
        message: "Bad credentials",
        ok: false
      })
    };

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika is not accessible: Bad credentials"
    );
    expect(githubApi.validateRepositoryAccess).toHaveBeenCalledWith({
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(githubApi.listLabels).not.toHaveBeenCalled();
  });

  it("reports missing operational labels without creating them", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue(["sym:claimed"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika is missing operational labels: sym:running, sym:failed, sym:stale"
    );
    expect(report.projects[0]).toMatchObject({
      missingOperationalLabels: ["sym:running", "sym:failed", "sym:stale"],
      validForDispatch: false
    });
    expect(githubApi.createLabel).not.toHaveBeenCalled();
  });

  it("surfaces sym:stale issues per project in the doctor report", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([
        "agent-ready",
        "sym:claimed",
        "sym:running",
        "sym:failed",
        "sym:stale"
      ]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };
    const githubIssuesApi: GitHubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          html_url: "https://github.com/pmatos/symphonika/issues/77",
          id: 5077,
          labels: [{ name: "agent-ready" }, { name: "sym:claimed" }, { name: "sym:stale" }],
          number: 77,
          state: "open",
          title: "Orphan claimed issue"
        },
        {
          html_url: "https://github.com/pmatos/symphonika/issues/78",
          id: 5078,
          labels: [{ name: "agent-ready" }],
          number: 78,
          state: "open",
          title: "Plain ready issue"
        }
      ])
    };

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      githubIssuesApi
    });

    expect(report.ok).toBe(true);
    expect(report.projects[0]?.staleIssues).toEqual([
      {
        number: 77,
        title: "Orphan claimed issue",
        url: "https://github.com/pmatos/symphonika/issues/77"
      }
    ]);
    expect(githubIssuesApi.listOpenIssues).toHaveBeenCalledWith({
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
  });

  it("reports label-listing failures without throwing", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockRejectedValue(new Error("rate limited")),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika labels could not be listed: rate limited"
    );
    expect(report.projects[0]).toMatchObject({
      missingOperationalLabels: [],
      validForDispatch: false
    });
  });
});

function fakeAgentProviders(): AgentProviderRegistry {
  return {
    codex: {
      cancel: () => Promise.resolve(),
      name: "codex",
      runAttempt: async function* () {
        await Promise.resolve();
        yield* [];
      },
      validate: () => Promise.resolve()
    }
  };
}

describe("GitHub Project initialization", () => {
  it("warns about the target repository and labels without mutating unless confirmed", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue(["sym:claimed"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi
    });

    expect(report.ok).toBe(false);
    expect(report.warnings).toContain(
      "init-project would create operational labels in pmatos/symphonika: sym:running, sym:failed, sym:stale"
    );
    expect(report.errors).toContain(
      "pass --yes to create missing operational labels non-interactively"
    );
    expect(githubApi.createLabel).not.toHaveBeenCalled();
  });

  it("creates missing operational labels when non-interactively confirmed", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn().mockResolvedValue(undefined),
      listLabels: vi.fn().mockResolvedValue(["sym:claimed", "sym:failed"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(true);
    expect(report.warnings).toContain(
      "init-project will create operational labels in pmatos/symphonika: sym:running, sym:stale"
    );
    expect(report.projects[0]).toMatchObject({
      createdOperationalLabels: ["sym:running", "sym:stale"],
      missingOperationalLabels: ["sym:running", "sym:stale"]
    });
    expect(githubApi.createLabel).toHaveBeenCalledTimes(2);
    expect(githubApi.createLabel).toHaveBeenNthCalledWith(1, {
      name: "sym:running",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(githubApi.createLabel).toHaveBeenNthCalledWith(2, {
      name: "sym:stale",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
  });

  it("emits the mutation warning before confirmed label creation starts", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const events: string[] = [];
    const createLabel: GitHubApi["createLabel"] = (input) => {
      events.push(`create:${input.name}`);
      return Promise.resolve();
    };
    const githubApi: GitHubApi = {
      createLabel: vi.fn(createLabel),
      listLabels: vi.fn().mockResolvedValue(["sym:claimed", "sym:running"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    await runInitProject({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      onWarning: (warning) => {
        events.push(`warning:${warning}`);
      },
      yes: true
    });

    expect(events).toEqual([
      "warning:init-project will create operational labels in pmatos/symphonika: sym:failed, sym:stale",
      "create:sym:failed",
      "create:sym:stale"
    ]);
  });

  it("reports createLabel failures without throwing during confirmed initialization", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const createLabel: GitHubApi["createLabel"] = (input) => {
      if (input.name === "sym:stale") {
        return Promise.reject(new Error("already exists"));
      }
      return Promise.resolve();
    };
    const githubApi: GitHubApi = {
      createLabel: vi.fn(createLabel),
      listLabels: vi.fn().mockResolvedValue(["sym:claimed", "sym:failed"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika could not create operational label sym:stale: already exists"
    );
    expect(report.projects[0]).toMatchObject({
      createdOperationalLabels: ["sym:running"],
      missingOperationalLabels: ["sym:running", "sym:stale"]
    });
  });
});

describe("runClearStale", () => {
  it("refuses to remove labels without --yes", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn(),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      issueNumber: 42,
      project: "symphonika"
    });

    expect(report.ok).toBe(false);
    expect(report.warnings).toContain(
      "clear-stale would remove sym:stale, sym:claimed from pmatos/symphonika#42"
    );
    expect(report.errors).toContain(
      "pass --yes to remove stale-claim labels non-interactively"
    );
    expect(report.removedLabels).toEqual([]);
    expect(githubApi.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("removes only sym:stale and sym:claimed when --yes is supplied", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn().mockResolvedValue(undefined),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      issueNumber: 84,
      project: "symphonika",
      yes: true
    });

    expect(report.ok).toBe(true);
    expect(report.removedLabels).toEqual(["sym:stale", "sym:claimed"]);
    expect(githubApi.removeIssueLabel).toHaveBeenCalledTimes(2);
    expect(githubApi.removeIssueLabel).not.toHaveBeenCalledWith({
      issueNumber: 84,
      name: "sym:running",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(report.warnings[0]).toContain("sym:stale, sym:claimed");
  });

  it("removes sym:stale and sym:claimed when --yes is supplied", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn().mockResolvedValue(undefined),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      issueNumber: 42,
      project: "symphonika",
      yes: true
    });

    expect(report.ok).toBe(true);
    expect(report.removedLabels).toEqual(["sym:stale", "sym:claimed"]);
    expect(report.repository).toBe("pmatos/symphonika");
    expect(report.warnings).toContain(
      "clear-stale will remove sym:stale, sym:claimed from pmatos/symphonika#42"
    );
    expect(githubApi.removeIssueLabel).toHaveBeenCalledTimes(2);
    expect(githubApi.removeIssueLabel).toHaveBeenNthCalledWith(1, {
      issueNumber: 42,
      name: "sym:stale",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(githubApi.removeIssueLabel).toHaveBeenNthCalledWith(2, {
      issueNumber: 42,
      name: "sym:claimed",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
  });

  it("treats label-not-found as a successful removal", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      removeIssueLabel: vi
        .fn()
        .mockImplementationOnce(() => Promise.reject(notFound))
        .mockResolvedValueOnce(undefined),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      issueNumber: 99,
      project: "symphonika",
      yes: true
    });

    expect(report.ok).toBe(true);
    expect(report.removedLabels).toEqual(["sym:stale", "sym:claimed"]);
  });

  it("reports unknown projects as an error", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn(),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      issueNumber: 1,
      project: "missing",
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/missing.*not found/i);
    expect(githubApi.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("reports repository access failures and skips label removal", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn(),
      validateRepositoryAccess: vi
        .fn()
        .mockResolvedValue({ ok: false, message: "Bad credentials" })
    };

    const report = await runClearStale({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      issueNumber: 1,
      project: "symphonika",
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika is not accessible: Bad credentials"
    );
    expect(githubApi.removeIssueLabel).not.toHaveBeenCalled();
  });
});

async function writeValidProject(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server"',
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
      '      labels_none: ["blocked", "needs-human", "sym:stale"]',
      "    priority:",
      "      labels:",
      '        "priority:critical": 0',
      '        "priority:high": 1',
      '        "priority:medium": 2',
      '        "priority:low": 3',
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
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on {{issue.title}}.\n");
}
