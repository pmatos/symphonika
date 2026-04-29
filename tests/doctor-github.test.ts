import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runDoctor,
  runInitProject,
  type GitHubApi
} from "../src/doctor.js";

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
});

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
      '    command: "codex --dangerously-bypass-approvals-and-sandbox app-server"',
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
