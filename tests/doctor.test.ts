import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import {
  REQUIRED_OPERATIONAL_LABELS,
  runDoctor,
  type GitHubApi
} from "../src/doctor.js";
import type { AgentProviderRegistry } from "../src/provider.js";

const tempRoots: string[] = [];
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalExitCode = process.exitCode;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-doctor-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  if (originalGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGithubToken;
  }
  delete process.env.SYMPHONIKA_MISSING_TOKEN;
  delete process.env.SYMPHONIKA_TEST_TOKEN;
  process.exitCode = originalExitCode;

  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("doctor", () => {
  it("accepts a valid final-shaped service config and workflow contract", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}} using {{provider.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";
    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).not.toBe(1);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("doctor ok");
    expect(output.stdout).toContain("1 project");
  });

  it("reports clear errors for a missing Projects list", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "providers:",
        "  codex:",
        '    command: "codex --dangerously-bypass-approvals-and-sandbox app-server"',
        "  claude:",
        '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
        ""
      ].join("\n")
    );

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("doctor failed");
    expect(output.stderr).toContain("projects");
  });

  it("reports invalid provider names and unsupported tracker kinds", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      agentProvider: "gpt",
      trackerKind: "linear"
    });
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("projects.0.tracker.kind");
    expect(output.stderr).toContain("github");
    expect(output.stderr).toContain("projects.0.agent.provider");
    expect(output.stderr).toContain("codex");
  });

  it("reports missing workflow contract paths", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      workflowPath: "./missing/WORKFLOW.md"
    });
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("workflow contract not found");
  });

  it("resolves environment-backed tracker tokens without printing secret values", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      token: "$SYMPHONIKA_TEST_TOKEN"
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.SYMPHONIKA_TEST_TOKEN = "super-secret-do-not-print";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).not.toBe(1);
    expect(output.stdout).toContain("doctor ok");
    expect(output.stdout).not.toContain("super-secret-do-not-print");
    expect(output.stderr).not.toContain("super-secret-do-not-print");
  });

  it("reports missing environment-backed tracker tokens by variable name", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      token: "$SYMPHONIKA_MISSING_TOKEN"
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    delete process.env.SYMPHONIKA_MISSING_TOKEN;

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("$SYMPHONIKA_MISSING_TOKEN");
  });

  it("reports Codex provider command validation errors", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const report = await runDoctor({
      agentProviders: {
        codex: {
          cancel: () => Promise.resolve(),
          name: "codex",
          runAttempt: async function* () {
            await Promise.resolve();
            yield* [];
          },
          validate: () => Promise.reject(new Error("codex app-server missing"))
        }
      },
      configPath,
      githubApi: successfulGitHubApi()
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.providers.codex.command is invalid: codex app-server missing"
    );
    expect(report.projects[0]).toMatchObject({
      validForDispatch: false
    });
  });

  it("accepts workflow front matter for prompt-adjacent policy", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      [
        "---",
        "autonomy:",
        "  max_turns: 8",
        "---",
        "Work on {{issue.title}} for {{project.name}}.",
        ""
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).not.toBe(1);
    expect(output.stdout).toContain("doctor ok");
  });

  it("rejects workflow front matter service discovery keys", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      ["---", "tracker:", "  kind: github", "---", "Work on {{issue.title}}.", ""].join(
        "\n"
      )
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("front matter");
    expect(output.stderr).toContain("tracker");
  });

  it("rejects unknown workflow template variables", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{ticket.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("unknown variable");
    expect(output.stderr).toContain("{{ticket.title}}");
  });
});

async function runDoctorCommand(
  configPath: string,
  githubApi: GitHubApi = successfulGitHubApi()
): Promise<{ stderr: string; stdout: string }> {
  const output = { stderr: "", stdout: "" };
  const program = buildCli({
    registerSignalHandlers: false,
    runDoctor: (options) =>
      runDoctor({
        ...options,
        agentProviders: fakeAgentProviders(),
        githubApi
      })
  });
  program.configureOutput({
    writeErr: (message) => {
      output.stderr += message;
    },
    writeOut: (message) => {
      output.stdout += message;
    }
  });

  await program.parseAsync([
    "node",
    "symphonika",
    "doctor",
    "--config",
    configPath
  ]);

  return output;
}

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

function successfulGitHubApi(): GitHubApi {
  return {
    createLabel: () => Promise.resolve(),
    listLabels: () => Promise.resolve([...REQUIRED_OPERATIONAL_LABELS]),
    validateRepositoryAccess: () => Promise.resolve({ ok: true })
  };
}

async function writeValidConfig(
  configPath: string,
  overrides: {
    agentProvider?: string;
    token?: string;
    trackerKind?: string;
    workflowPath?: string;
  } = {}
): Promise<void> {
  const configDir = path.dirname(configPath);
  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
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
      `      kind: ${overrides.trackerKind ?? "github"}`,
      "      owner: pmatos",
      "      repo: symphonika",
      `      token: "${overrides.token ?? "$GITHUB_TOKEN"}"`,
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
      `      provider: ${overrides.agentProvider ?? "codex"}`,
      `    workflow: ${overrides.workflowPath ?? "./WORKFLOW.md"}`,
      ""
    ].join("\n")
  );
}
