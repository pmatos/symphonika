import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
const execFile = promisify(execFileCallback);

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-github-test-"));
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

describe("GitHub Project validation", () => {
  it("explains how to load a daemon env file when the SMTP password is absent from a manual doctor run", async () => {
    const root = await makeTempRoot();
    const configRoot = path.join(root, "config with spaces");
    await mkdir(configRoot);
    await writeValidProject(configRoot);
    const configPath = path.join(configRoot, "symphonika.yml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "providers:\n",
        [
          "email:",
          '  from: "symphonika@example.com"',
          '  to: "operator@example.com"',
          '  smtp_host: "smtp.example.com"',
          '  smtp_username: "server-token"',
          '  smtp_password_env: "SMTP_TEST_PASSWORD"',
          "providers:",
          ""
        ].join("\n")
      )
    );
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi
        .fn()
        .mockResolvedValue([
          "agent-ready",
          "sym:claimed",
          "sym:running",
          "sym:failed",
          "sym:blocked",
          "sym:stale"
        ]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      cwd: configRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      `email.smtp_password_env references $SMTP_TEST_PASSWORD, but it is not set; for a manual run, load the daemon's env file first (for example: set -a; . '${path.join(configRoot, "env")}'; set +a)`
    );
  });

  it("marks a Project valid for dispatch when operational and required eligibility labels are present", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi
        .fn()
        .mockResolvedValue([
          "agent-ready",
          "sym:claimed",
          "sym:running",
          "sym:failed",
          "sym:blocked",
          "sym:stale",
          "sym:human-needed"
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
      missingEligibilityLabels: [],
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
      listLabels: vi.fn().mockResolvedValue(["agent-ready", "sym:claimed"]),
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
      "projects.symphonika.tracker.repository pmatos/symphonika is missing operational labels: sym:running, sym:failed, sym:blocked, sym:stale, sym:human-needed"
    );
    expect(report.projects[0]).toMatchObject({
      missingOperationalLabels: [
        "sym:running",
        "sym:failed",
        "sym:blocked",
        "sym:stale",
        "sym:human-needed"
      ],
      validForDispatch: false
    });
    expect(githubApi.createLabel).not.toHaveBeenCalled();
  });

  it("reports missing required eligibility labels and rejects dispatch", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi
        .fn()
        .mockResolvedValue([
          "sym:claimed",
          "sym:running",
          "sym:failed",
          "sym:blocked",
          "sym:stale",
          "sym:human-needed"
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

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika is missing required eligibility labels: agent-ready"
    );
    expect(report.projects[0]).toMatchObject({
      missingEligibilityLabels: ["agent-ready"],
      missingOperationalLabels: [],
      validForDispatch: false
    });
    expect(githubApi.createLabel).not.toHaveBeenCalled();
  });

  it("surfaces sym:stale issues per project in the doctor report", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi
        .fn()
        .mockResolvedValue([
          "agent-ready",
          "sym:claimed",
          "sym:running",
          "sym:failed",
          "sym:blocked",
          "sym:stale",
          "sym:human-needed"
        ]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };
    const githubIssuesApi: GitHubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          html_url: "https://github.com/pmatos/symphonika/issues/77",
          id: 5077,
          labels: [
            { name: "agent-ready" },
            { name: "sym:claimed" },
            { name: "sym:stale" }
          ],
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
  it("refuses to replace an existing Project name unless forced", async () => {
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
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(
      /project symphonika already exists.*pass --force/i
    );
    expect(githubApi.validateRepositoryAccess).not.toHaveBeenCalled();
    expect(githubApi.createLabel).not.toHaveBeenCalled();
  });

  it("creates missing operational labels when non-interactively confirmed", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn().mockResolvedValue(undefined),
      listLabels: vi
        .fn()
        .mockResolvedValue(["agent-ready", "sym:claimed", "sym:failed"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      force: true,
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(true);
    expect(report.warnings).toContain(
      "init-project will create operational labels in pmatos/symphonika: sym:running, sym:blocked, sym:stale, sym:human-needed"
    );
    expect(report.projects[0]).toMatchObject({
      createdOperationalLabels: [
        "sym:running",
        "sym:blocked",
        "sym:stale",
        "sym:human-needed"
      ],
      missingOperationalLabels: [
        "sym:running",
        "sym:blocked",
        "sym:stale",
        "sym:human-needed"
      ]
    });
    expect(githubApi.createLabel).toHaveBeenCalledTimes(4);
    expect(githubApi.createLabel).toHaveBeenNthCalledWith(1, {
      name: "sym:running",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(githubApi.createLabel).toHaveBeenNthCalledWith(2, {
      name: "sym:blocked",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(githubApi.createLabel).toHaveBeenNthCalledWith(3, {
      name: "sym:stale",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(githubApi.createLabel).toHaveBeenNthCalledWith(4, {
      name: "sym:human-needed",
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
      listLabels: vi
        .fn()
        .mockResolvedValue(["agent-ready", "sym:claimed", "sym:running"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    await runInitProject({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      force: true,
      githubApi,
      onWarning: (warning) => {
        events.push(`warning:${warning}`);
      },
      yes: true
    });

    expect(events).toEqual([
      "warning:init-project will create operational labels in pmatos/symphonika: sym:failed, sym:blocked, sym:stale, sym:human-needed",
      "create:sym:failed",
      "create:sym:blocked",
      "create:sym:stale",
      "create:sym:human-needed"
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
      listLabels: vi
        .fn()
        .mockResolvedValue(["agent-ready", "sym:claimed", "sym:failed"]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      force: true,
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika could not create operational label sym:stale: already exists"
    );
    expect(report.projects[0]).toMatchObject({
      createdOperationalLabels: [
        "sym:running",
        "sym:blocked",
        "sym:human-needed"
      ],
      missingOperationalLabels: [
        "sym:running",
        "sym:blocked",
        "sym:stale",
        "sym:human-needed"
      ]
    });
  });
});

describe("runClearStale", () => {
  it("lists every stale Issue before requiring --yes for --all", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listIssueNumbersByLabel: vi.fn().mockResolvedValue([42, 7, 42]),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn(),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      all: true,
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      project: "symphonika"
    });

    expect(githubApi.listIssueNumbersByLabel).toHaveBeenCalledWith({
      label: "sym:stale",
      owner: "pmatos",
      repo: "symphonika",
      token: "secret-token"
    });
    expect(report.warnings).toContain(
      "clear-stale would remove sym:stale, sym:claimed, sym:running from pmatos/symphonika issues #7, #42"
    );
    expect(report.errors).toContain(
      "pass --yes to remove stale-claim labels non-interactively"
    );
    expect(report.outcomes).toEqual([]);
    expect(githubApi.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("uses singular wording when --all selects exactly one stale Issue", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listIssueNumbersByLabel: vi.fn().mockResolvedValue([42]),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn(),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      all: true,
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      project: "symphonika"
    });

    expect(report.warnings).toContain(
      "clear-stale would remove sym:stale, sym:claimed, sym:running from pmatos/symphonika issue #42"
    );
  });

  it("reports an error when the GitHub adapter does not support --all discovery", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      removeIssueLabel: vi.fn(),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      all: true,
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      project: "symphonika",
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.tracker.repository pmatos/symphonika GitHub adapter does not support listIssueNumbersByLabel"
    );
    expect(report.outcomes).toEqual([]);
    expect(githubApi.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("reports each --all outcome and continues after an Issue error", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const removeIssueLabel = vi.fn(
      (input: { issueNumber: number; name: string }) => {
        if (input.issueNumber === 12) {
          return Promise.reject(notFound);
        }
        if (input.issueNumber === 13 && input.name === "sym:stale") {
          return Promise.reject(new Error("write failed"));
        }
        if (input.issueNumber === 13 && input.name === "sym:running") {
          return Promise.reject(notFound);
        }
        return Promise.resolve();
      }
    );
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listIssueNumbersByLabel: vi.fn().mockResolvedValue([11, 12, 13]),
      listLabels: vi.fn(),
      removeIssueLabel,
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      all: true,
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      project: "symphonika",
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.outcomes).toEqual([
      {
        errors: [],
        issueNumber: 11,
        removedLabels: ["sym:stale", "sym:claimed", "sym:running"],
        status: "cleared"
      },
      {
        errors: [],
        issueNumber: 12,
        removedLabels: [],
        status: "already-removed"
      },
      {
        errors: [
          "projects.symphonika.tracker.repository pmatos/symphonika could not remove label sym:stale from issue 13: write failed"
        ],
        issueNumber: 13,
        removedLabels: ["sym:claimed"],
        status: "error"
      }
    ]);
    expect(removeIssueLabel).toHaveBeenCalledTimes(9);
  });

  it("succeeds without writes when --all finds no stale Issues", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listIssueNumbersByLabel: vi.fn().mockResolvedValue([]),
      listLabels: vi.fn(),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runClearStale({
      all: true,
      configPath: "symphonika.yml",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      project: "symphonika",
      yes: true
    });

    expect(report).toMatchObject({
      errors: [],
      ok: true,
      outcomes: [],
      warnings: [
        "clear-stale will remove sym:stale, sym:claimed, sym:running from pmatos/symphonika issues (none)"
      ]
    });
  });

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
      "clear-stale would remove sym:stale, sym:claimed, sym:running from pmatos/symphonika#42"
    );
    expect(report.errors).toContain(
      "pass --yes to remove stale-claim labels non-interactively"
    );
    expect(report.outcomes).toEqual([]);
    expect(githubApi.removeIssueLabel).not.toHaveBeenCalled();
  });

  it("removes sym:stale, sym:claimed, and sym:running when --yes is supplied", async () => {
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
    expect(report.outcomes).toEqual([
      {
        errors: [],
        issueNumber: 42,
        removedLabels: ["sym:stale", "sym:claimed", "sym:running"],
        status: "cleared"
      }
    ]);
    expect(report.repository).toBe("pmatos/symphonika");
    expect(report.warnings).toContain(
      "clear-stale will remove sym:stale, sym:claimed, sym:running from pmatos/symphonika#42"
    );
    expect(githubApi.removeIssueLabel).toHaveBeenCalledTimes(3);
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
    expect(githubApi.removeIssueLabel).toHaveBeenNthCalledWith(3, {
      issueNumber: 42,
      name: "sym:running",
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
        .mockResolvedValueOnce(undefined)
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
    expect(report.outcomes).toEqual([
      {
        errors: [],
        issueNumber: 99,
        removedLabels: ["sym:claimed", "sym:running"],
        status: "cleared"
      }
    ]);
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
  await execFile("git", ["init", "--initial-branch", "main"], { cwd: root });
  await execFile(
    "git",
    ["remote", "add", "origin", "https://github.com/pmatos/symphonika.git"],
    { cwd: root }
  );
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
      '    command: "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json"',
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
