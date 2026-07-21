import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import {
  REQUIRED_OPERATIONAL_LABELS,
  runInitProject,
  type GitHubApi
} from "../src/doctor.js";

const execFile = promisify(execFileCallback);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Project initialization", () => {
  it("points to global initialization when the default user Service Config is missing", async () => {
    const root = await makeTempRoot();
    const configHome = path.join(root, "config-home");
    const expectedConfigPath = path.join(
      configHome,
      "symphonika",
      "symphonika.yml"
    );
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      validateRepositoryAccess: vi.fn()
    };

    const report = await runInitProject({
      cwd: root,
      env: { XDG_CONFIG_HOME: configHome },
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      `no initialized Service Config found at ${expectedConfigPath}; run \`symphonika init\` first`
    ]);
    expect(githubApi.validateRepositoryAccess).not.toHaveBeenCalled();
  });

  it("reports a plain missing-config error for a nonexistent explicit --config path", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "missing", "symphonika.yml");
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      validateRepositoryAccess: vi.fn()
    };

    const report = await runInitProject({
      configPath,
      cwd: root,
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      `service config not found at ${configPath}`
    ]);
    expect(githubApi.validateRepositoryAccess).not.toHaveBeenCalled();
  });

  it("appends the current repository while preserving existing config and creates its workflow", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "new-project");
    const configPath = path.join(root, "config", "symphonika.yml");
    await createGitHubRepository(
      repositoryRoot,
      "https://github.com/acme/new-project.git"
    );
    await writeExistingConfig(configPath, root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([...REQUIRED_OPERATIONAL_LABELS]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(true);
    expect(report.projects).toEqual([
      expect.objectContaining({
        name: "new-project",
        repository: "acme/new-project"
      })
    ]);
    const contents = await readFile(configPath, "utf8");
    const config = parse(contents) as {
      projects: Array<{
        name: string;
        tracker: { owner: string; repo: string };
        workflow: string;
      }>;
    };
    expect(contents).toContain("# Keep this operator note");
    expect(config.projects.map((project) => project.name)).toEqual([
      "existing",
      "new-project"
    ]);
    expect(config.projects[1]).toMatchObject({
      tracker: { owner: "acme", repo: "new-project" },
      workflow: path.join(repositoryRoot, "WORKFLOW.md")
    });
    await expect(
      readFile(path.join(repositoryRoot, "WORKFLOW.md"), "utf8")
    ).resolves.toContain("# Implementing issue #{{issue.number}}");
    expect(githubApi.validateRepositoryAccess).toHaveBeenCalledOnce();
    expect(githubApi.validateRepositoryAccess).toHaveBeenCalledWith({
      owner: "acme",
      repo: "new-project",
      token: "secret-token"
    });
  });

  it("uses interactive answers for repository-specific settings", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "source-repository");
    const configPath = path.join(root, "config", "symphonika.yml");
    await createGitHubRepository(
      repositoryRoot,
      "git@github.com:acme/source-repository.git"
    );
    await writeEmptyConfig(configPath, root);
    const answers: Record<string, string> = {
      baseBranch: "develop",
      excludedLabels: "paused, sym:stale",
      priorityLabels: "urgent=0, normal=5",
      projectName: "custom-project",
      provider: "claude",
      requiredLabels: "ready, backend",
      workflowPath: "automation/WORKFLOW.md"
    };
    const prompted: string[] = [];
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([...REQUIRED_OPERATIONAL_LABELS]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      prompt: (input) => {
        prompted.push(input.key);
        return Promise.resolve(answers[input.key] ?? "");
      }
    });

    expect(report.ok).toBe(true);
    const config = parse(await readFile(configPath, "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]).toMatchObject({
      agent: { provider: "claude" },
      issue_filters: {
        labels_all: ["ready", "backend"],
        labels_none: ["paused", "sym:stale"],
        states: ["open"]
      },
      name: "custom-project",
      priority: {
        default: 99,
        labels: { normal: 5, urgent: 0 }
      },
      workflow: path.join(repositoryRoot, "automation", "WORKFLOW.md"),
      workspace: { git: { base_branch: "develop" } }
    });
    expect(prompted).toEqual([
      "projectName",
      "provider",
      "baseBranch",
      "requiredLabels",
      "excludedLabels",
      "priorityLabels",
      "workflowPath"
    ]);
  });

  it("force replaces only the matching Project instead of adding a duplicate", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "new-project");
    const configPath = path.join(root, "config", "symphonika.yml");
    await createGitHubRepository(
      repositoryRoot,
      "https://github.com/acme/new-project.git"
    );
    await writeExistingConfig(configPath, root);
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([...REQUIRED_OPERATIONAL_LABELS]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      yes: true
    });
    const report = await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      force: true,
      githubApi,
      prompt: (input) =>
        Promise.resolve(input.key === "provider" ? "claude" : "")
    });

    expect(report.ok).toBe(true);
    const config = parse(await readFile(configPath, "utf8")) as {
      projects: Array<{ agent: { provider: string }; name: string }>;
    };
    expect(config.projects.map((project) => project.name)).toEqual([
      "existing",
      "new-project"
    ]);
    expect(config.projects[1]?.agent.provider).toBe("claude");
  });

  it("refuses to force-replace when the config already has duplicate Project names", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "dup-project");
    const configPath = path.join(root, "config", "symphonika.yml");
    await createGitHubRepository(
      repositoryRoot,
      "https://github.com/acme/dup-project.git"
    );
    await writeDuplicateProjectConfig(configPath, root, "dup-project");
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([...REQUIRED_OPERATIONAL_LABELS]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      force: true,
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      `project dup-project appears 2 times in ${configPath}; remove the duplicate Projects before running init-project`
    ]);
    const config = parse(await readFile(configPath, "utf8")) as {
      projects: Array<{ name: string }>;
    };
    expect(config.projects.map((project) => project.name)).toEqual([
      "dup-project",
      "dup-project"
    ]);
    expect(githubApi.validateRepositoryAccess).not.toHaveBeenCalled();
  });

  it("does not persist the new Project when the repository is not accessible", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "new-project");
    const configPath = path.join(root, "config", "symphonika.yml");
    await createGitHubRepository(
      repositoryRoot,
      "https://github.com/acme/new-project.git"
    );
    await writeExistingConfig(configPath, root);
    const originalContents = await readFile(configPath, "utf8");
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn(),
      validateRepositoryAccess: vi
        .fn()
        .mockResolvedValue({ message: "not a collaborator", ok: false })
    };

    const report = await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      "projects.new-project.tracker.repository acme/new-project is not accessible: not a collaborator"
    ]);
    expect(githubApi.listLabels).not.toHaveBeenCalled();
    expect(githubApi.createLabel).not.toHaveBeenCalled();
    await expect(readFile(configPath, "utf8")).resolves.toBe(originalContents);
    await expect(
      readFile(path.join(repositoryRoot, "WORKFLOW.md"), "utf8")
    ).rejects.toThrow();
  });

  it("does not register the Project without --yes when operational labels are missing", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "new-project");
    const configPath = path.join(root, "config", "symphonika.yml");
    await createGitHubRepository(
      repositoryRoot,
      "https://github.com/acme/new-project.git"
    );
    await writeExistingConfig(configPath, root);
    const originalContents = await readFile(configPath, "utf8");
    const githubApi: GitHubApi = {
      createLabel: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([]),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      prompt: (input) =>
        Promise.resolve(input.key === "provider" ? "codex" : "")
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      "pass --yes to create missing operational labels non-interactively"
    ]);
    expect(report.warnings).toEqual([
      expect.stringContaining(
        "init-project would create operational labels in acme/new-project"
      )
    ]);
    expect(report.projects).toEqual([
      expect.objectContaining({
        createdOperationalLabels: [],
        name: "new-project"
      })
    ]);
    expect(githubApi.createLabel).not.toHaveBeenCalled();
    await expect(readFile(configPath, "utf8")).resolves.toBe(originalContents);
    await expect(
      readFile(path.join(repositoryRoot, "WORKFLOW.md"), "utf8")
    ).rejects.toThrow();
  });

  it("does not persist the new Project when operational label creation fails", async () => {
    const root = await makeTempRoot();
    const repositoryRoot = path.join(root, "new-project");
    const configPath = path.join(root, "config", "symphonika.yml");
    await createGitHubRepository(
      repositoryRoot,
      "https://github.com/acme/new-project.git"
    );
    await writeExistingConfig(configPath, root);
    const originalContents = await readFile(configPath, "utf8");
    const missingLabel = REQUIRED_OPERATIONAL_LABELS[0];
    const githubApi: GitHubApi = {
      createLabel: vi.fn().mockRejectedValue(new Error("permission denied")),
      listLabels: vi
        .fn()
        .mockResolvedValue(
          REQUIRED_OPERATIONAL_LABELS.filter((label) => label !== missingLabel)
        ),
      validateRepositoryAccess: vi.fn().mockResolvedValue({ ok: true })
    };

    const report = await runInitProject({
      configPath,
      cwd: repositoryRoot,
      env: { GITHUB_TOKEN: "secret-token" },
      githubApi,
      yes: true
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      `projects.new-project.tracker.repository acme/new-project could not create operational label ${missingLabel}: permission denied`
    ]);
    expect(report.projects).toEqual([
      expect.objectContaining({
        createdOperationalLabels: [],
        missingOperationalLabels: [missingLabel],
        name: "new-project"
      })
    ]);
    expect(githubApi.createLabel).toHaveBeenCalledOnce();
    await expect(readFile(configPath, "utf8")).resolves.toBe(originalContents);
    await expect(
      readFile(path.join(repositoryRoot, "WORKFLOW.md"), "utf8")
    ).rejects.toThrow();
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-init-project-test-")
  );
  tempRoots.push(root);
  return root;
}

async function createGitHubRepository(
  root: string,
  remote: string
): Promise<void> {
  await mkdir(root, { recursive: true });
  await execFile("git", ["init", "--initial-branch", "main"], { cwd: root });
  await execFile("git", ["remote", "add", "origin", remote], { cwd: root });
}

async function writeExistingConfig(
  configPath: string,
  root: string
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    [
      "# Keep this operator note",
      "state:",
      `  root: ${path.join(root, "state")}`,
      "providers:",
      "  codex:",
      "    command: codex app-server",
      "  claude:",
      "    command: claude --stream",
      "projects:",
      "  - name: existing",
      "    tracker:",
      "      kind: github",
      "      owner: acme",
      "      repo: existing",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      `      root: ${path.join(root, "state", "workspaces", "existing")}`,
      "      git:",
      "        remote: https://github.com/acme/existing.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      `    workflow: ${path.join(root, "existing", "WORKFLOW.md")}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeEmptyConfig(
  configPath: string,
  root: string
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    [
      "state:",
      `  root: ${path.join(root, "state")}`,
      "providers:",
      "  codex:",
      "    command: codex app-server",
      "  claude:",
      "    command: claude --stream",
      "projects: []",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeDuplicateProjectConfig(
  configPath: string,
  root: string,
  name: string
): Promise<void> {
  const project = (repo: string): string[] => [
    `  - name: ${name}`,
    "    tracker:",
    "      kind: github",
    "      owner: acme",
    `      repo: ${repo}`,
    '      token: "$GITHUB_TOKEN"',
    "    issue_filters:",
    '      states: ["open"]',
    '      labels_all: ["agent-ready"]',
    '      labels_none: ["blocked"]',
    "    priority:",
    "      labels: {}",
    "      default: 99",
    "    workspace:",
    `      root: ${path.join(root, "state", "workspaces", repo)}`,
    "      git:",
    `        remote: https://github.com/acme/${repo}.git`,
    "        base_branch: main",
    "    agent:",
    "      provider: codex",
    `    workflow: ${path.join(root, repo, "WORKFLOW.md")}`
  ];

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    [
      "state:",
      `  root: ${path.join(root, "state")}`,
      "providers:",
      "  codex:",
      "    command: codex app-server",
      "  claude:",
      "    command: claude --stream",
      "projects:",
      ...project("first-copy"),
      ...project("second-copy"),
      ""
    ].join("\n"),
    "utf8"
  );
}
