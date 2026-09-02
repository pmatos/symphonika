import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import {
  REQUIRED_OPERATIONAL_LABELS,
  runDoctor,
  type GitHubApi
} from "../src/doctor.js";
import type { AgentProviderRegistry } from "../src/provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "../src/providers/index.js";
import {
  renderProvidersSliceUnit,
  renderServiceUnit,
  renderSliceUnit
} from "../src/service.js";
import {
  doctorEnvironmentFixture,
  writeStubExecutables
} from "./helpers/doctor-environment.js";

const tempRoots: string[] = [];
// Built by the real generator rather than hand-written, so a new structural
// directive in the unit template can never silently leave these fixtures
// behind while the drift checks they exercise still claim to pass.
const currentServiceUnit = (unitPath = "/usr/bin:/bin") =>
  renderServiceUnit({
    environmentFilePath: "/home/op/.config/symphonika/env",
    execPath: "/usr/bin/node",
    path: unitPath,
    scriptPath: "/opt/symphonika/dist/cli.js"
  });
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;
const originalCodexHome = process.env.CODEX_HOME;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalExitCode = process.exitCode;
const originalPath = process.env.PATH;
const TEST_DOCTOR_ENVIRONMENT = doctorEnvironmentFixture();

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-doctor-test-"));
  tempRoots.push(root);
  return root;
}

beforeEach(() => {
  delete process.env.CODEX_HOME;
});

afterEach(async () => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  if (originalGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGithubToken;
  }
  delete process.env.SYMPHONIKA_MISSING_TOKEN;
  delete process.env.SYMPHONIKA_TEST_TOKEN;
  process.exitCode = originalExitCode;
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
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
        `    command: "${DEFAULT_CODEX_COMMAND}"`,
        "  claude:",
        '    command: "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json"',
        ""
      ].join("\n")
    );

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stdout).toContain("execution environment:");
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
    expect(output.stderr).toContain("doctor failed");
    expect(output.stderr).toContain("projects.0");
  });

  it("reports a non-boolean project dispatch.overlap_guard", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      projectLines: ["    dispatch:", '      overlap_guard: "sometimes"']
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work on this Issue.\n");
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("projects.0");
    expect(output.stderr).toContain("Invalid input");
  });

  it("reports unknown workspace hook lifecycle keys", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      workspaceHookLines: [
        "      hooks:",
        "        after_merge:",
        '          command: "npm ci"'
      ]
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("projects.0.workspace.hooks.after_merge");
    expect(output.stderr).toContain("allowed lifecycles");
    expect(output.stderr).toContain(
      "after_create, before_run, after_run, before_remove"
    );
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

  it("reports invalid enumerated Routine declarations beside workflow errors", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const routinePath = path.join(root, "routines", "broken.md");
    await writeValidConfig(configPath, {
      routinePaths: ["./routines/broken.md"]
    });
    await mkdir(path.dirname(routinePath));
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await writeFile(
      routinePath,
      [
        "---",
        "name: broken",
        "schedule:",
        "  cron: fortnightly",
        "kind: report",
        "---",
        "Create a report.",
        ""
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stdout).toContain("execution environment:");
    expect(output.stderr).toContain("doctor failed");
    expect(output.stderr).toContain(`routine at ${routinePath}`);
    expect(output.stderr).toContain("schedule.cron is invalid");
  });

  it("reports invalid service-level Routine defaults", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      routineDefaultLines: [
        "routine_defaults:",
        "  permission_mode: ''",
        "  timeout_minutes: 0"
      ]
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("routine_defaults.permission_mode");
    expect(output.stderr).toContain("routine_defaults.timeout_minutes");
  });

  it("skips the live provider check by default", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(report.liveCheck).toBeUndefined();
  });

  it("reports an unresolved binary from the rendered command for each selected provider", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const missingCodex = path.join(root, "missing-codex");
    const binDir = path.join(root, "bin");
    await writeValidConfig(configPath, {
      codexCommand: `${missingCodex} {{#model}}--model {{model}}{{/model}} app-server`
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await mkdir(binDir);
    const ghPath = path.join(binDir, "gh");
    await writeStubExecutables(binDir, ["gh"]);

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: binDir },
      githubApi: successfulGitHubApi(),
      homeDir: root,
      offline: true
    });

    expect(report.environment.providerBinaries).toEqual([
      {
        executable: missingCodex,
        provider: "codex",
        resolvedPath: null,
        status: "unresolved"
      }
    ]);
    expect(report.environment.gh).toEqual({
      executablePath: ghPath,
      status: "skipped_offline"
    });
    expect(report.errors).toContain(
      `provider codex executable ${missingCodex} is not resolvable on PATH`
    );
  });

  it("rejects provider executables relative to a future Workspace", async () => {
    const root = await makeTempRoot();
    const doctorCwd = path.join(root, "doctor-cwd");
    const configPath = path.join(root, "symphonika.yml");
    const binDir = path.join(root, "bin");
    const executable = "./tools/agent-wrapper";
    await writeValidConfig(configPath, {
      codexCommand: `${executable} app-server`
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await writeStubExecutables(path.join(doctorCwd, "tools"), [
      "agent-wrapper"
    ]);
    await writeStubExecutables(binDir, ["gh"]);

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      cwd: doctorCwd,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: binDir },
      githubApi: successfulGitHubApi(),
      homeDir: root,
      offline: true
    });

    expect(report.environment.providerBinaries).toEqual([
      {
        executable,
        provider: "codex",
        resolvedPath: null,
        status: "unresolved"
      }
    ]);
    expect(report.errors).toContain(
      `provider codex executable ${executable} is relative to the future Workspace; use an absolute path or a command resolvable on PATH`
    );
  });

  it("does not accept a same-named executable directory on PATH", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, { codexCommand: "codex app-server" });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    const codexPath = path.join(root, "test-bin", "codex");
    await rm(codexPath);
    await mkdir(codexPath);

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: {
        GITHUB_TOKEN: "test-secret-token",
        PATH: path.join(root, "test-bin")
      },
      githubApi: successfulGitHubApi(),
      homeDir: root,
      offline: true
    });

    expect(report.environment.providerBinaries).toContainEqual({
      executable: "codex",
      provider: "codex",
      resolvedPath: null,
      status: "unresolved"
    });
    expect(report.errors).toContain(
      "provider codex executable codex is not resolvable on PATH"
    );
  });

  it.skipIf(process.platform === "win32")(
    "distinguishes an unset PATH from an explicitly empty PATH",
    async () => {
      const root = await makeTempRoot();
      const doctorCwd = path.join(root, "doctor-cwd");
      const configPath = path.join(root, "symphonika.yml");
      await writeValidConfig(configPath, { codexCommand: "sh app-server" });
      await writeFile(
        path.join(root, "WORKFLOW.md"),
        "Work on {{issue.title}} for {{project.name}}.\n"
      );
      await writeStubExecutables(doctorCwd, ["sh"]);

      const withoutPath = await runDoctor({
        agentProviders: fakeAgentProviders(),
        configPath,
        cwd: doctorCwd,
        env: { GITHUB_TOKEN: "test-secret-token" },
        githubApi: successfulGitHubApi(),
        homeDir: root,
        offline: true
      });
      const withEmptyPath = await runDoctor({
        agentProviders: fakeAgentProviders(),
        configPath,
        cwd: doctorCwd,
        env: { GITHUB_TOKEN: "test-secret-token", PATH: "" },
        githubApi: successfulGitHubApi(),
        homeDir: root,
        offline: true
      });

      expect(["/usr/bin/sh", "/bin/sh"]).toContain(
        withoutPath.environment.providerBinaries[0]?.resolvedPath
      );
      expect(withEmptyPath.environment.providerBinaries[0]).toMatchObject({
        executable: "sh",
        provider: "codex",
        resolvedPath: path.join(doctorCwd, "sh"),
        status: "resolved"
      });
    }
  );

  it("checks each distinct provider selected across Projects once", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      additionalProjectLines: [
        "  - name: claude-host",
        "    mode: routine_host",
        "    workspace:",
        "      root: ./.symphonika/workspaces/claude-host",
        "      git:",
        "        remote: git@github.com:pmatos/claude-host.git",
        "        base_branch: main",
        "    agent:",
        "      provider: claude",
        "  - name: second-codex-host",
        "    mode: routine_host",
        "    workspace:",
        "      root: ./.symphonika/workspaces/second-codex-host",
        "      git:",
        "        remote: git@github.com:pmatos/second-codex-host.git",
        "        base_branch: main",
        "    agent:",
        "      provider: codex"
      ],
      claudeCommand:
        "claude --print --input-format stream-json --output-format stream-json",
      codexCommand: "codex app-server"
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await writeStubExecutables(path.join(root, "test-bin"), ["claude"]);
    const provider = (name: "claude" | "codex") => ({
      cancel: () => Promise.resolve(),
      name,
      runAttempt: async function* () {
        await Promise.resolve();
        yield* [];
      },
      validate: () => Promise.resolve()
    });

    const report = await runDoctor({
      agentProviders: {
        claude: provider("claude"),
        codex: provider("codex")
      },
      configPath,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: process.env.PATH },
      githubApi: successfulGitHubApi(),
      homeDir: root,
      offline: true
    });

    expect(
      report.environment.providerBinaries.map((binary) => binary.provider)
    ).toEqual(["codex", "claude"]);
    expect(report.environment.providerBinaries).toHaveLength(2);
  });

  it("reports each missing or mismatched Codex profile key", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const binDir = path.join(root, "bin");
    await writeValidConfig(configPath, { codexCommand: "codex app-server" });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "config.toml"),
      '[profiles.symphonika]\nsandbox_mode = "workspace-write"\n'
    );
    await writeStubExecutables(binDir, ["codex", "gh"]);

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: binDir },
      githubApi: successfulGitHubApi(),
      homeDir: root,
      offline: true
    });

    expect(report.environment.codexProfile).toMatchObject({
      checks: [
        {
          actual: "workspace-write",
          expected: "danger-full-access",
          key: "sandbox_mode",
          status: "mismatch"
        },
        {
          actual: null,
          expected: "never",
          key: "approval_policy",
          status: "missing"
        },
        {
          actual: null,
          expected: "detailed",
          key: "model_reasoning_summary",
          status: "missing"
        },
        {
          actual: null,
          expected: "medium",
          key: "model_verbosity",
          status: "missing"
        }
      ],
      path: path.join(root, ".codex", "config.toml"),
      status: "invalid"
    });
    expect(report.errors).toContain(
      'Codex profile profiles.symphonika.sandbox_mode is "workspace-write"; expected "danger-full-access"'
    );
    expect(report.errors).toContain(
      'Codex profile profiles.symphonika.approval_policy is missing; expected "never"'
    );
    expect(report.errors).toContain(
      'Codex profile profiles.symphonika.model_reasoning_summary is missing; expected "detailed"'
    );
    expect(report.errors).toContain(
      'Codex profile profiles.symphonika.model_verbosity is missing; expected "medium"'
    );
  });

  it("checks the Codex profile the configured command actually selects", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const binDir = path.join(root, "bin");
    await writeValidConfig(configPath, {
      codexCommand: "codex --profile acme app-server"
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "config.toml"),
      [
        "[profiles.acme]",
        'sandbox_mode = "danger-full-access"',
        'approval_policy = "never"',
        'model_reasoning_summary = "detailed"',
        'model_verbosity = "medium"',
        "",
        "[profiles.symphonika]",
        'sandbox_mode = "workspace-write"',
        ""
      ].join("\n")
    );
    await writeStubExecutables(binDir, ["codex", "gh"]);

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: binDir },
      githubApi: successfulGitHubApi(),
      homeDir: root,
      offline: true
    });

    expect(report.environment.codexProfile.status).toBe("valid");
    expect(report.errors).toEqual([]);
  });

  it("reads the Codex config from an absolute CODEX_HOME", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const binDir = path.join(root, "bin");
    const codexHome = path.join(root, "codex-home");
    await writeValidConfig(configPath, { codexCommand: "codex app-server" });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(codexHome, "config.toml"),
      '[profiles.symphonika]\nsandbox_mode = "danger-full-access"\napproval_policy = "never"\nmodel_reasoning_summary = "detailed"\nmodel_verbosity = "medium"\n'
    );
    await writeStubExecutables(binDir, ["codex", "gh"]);

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: {
        CODEX_HOME: codexHome,
        GITHUB_TOKEN: "test-secret-token",
        PATH: binDir
      },
      githubApi: successfulGitHubApi(),
      homeDir: root,
      offline: true
    });

    expect(report.environment.codexProfile).toMatchObject({
      path: path.join(codexHome, "config.toml"),
      status: "valid"
    });
    expect(report.errors).toEqual([]);
  });

  it("distinguishes an installed but logged-out gh CLI", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const binDir = path.join(root, "bin");
    await writeValidConfig(configPath, { codexCommand: "codex app-server" });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await mkdir(binDir);
    await writeStubExecutables(binDir, ["codex"]);
    const ghPath = path.join(binDir, "gh");
    await writeStubExecutables(
      binDir,
      ["gh"],
      '#!/bin/sh\n[ "$1" = auth ] && [ "$2" = status ] && exit 1\nexit 2\n'
    );

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: binDir },
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(report.environment.gh).toEqual({
      executablePath: ghPath,
      status: "unauthenticated"
    });
    expect(report.errors).toContainEqual(
      expect.stringContaining(
        "gh is installed but not authenticated; run `gh auth login`"
      )
    );
  });

  it("reports a fatal gh auth probe failure separately from logged-out credentials", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const binDir = path.join(root, "bin");
    await writeValidConfig(configPath, { codexCommand: "codex app-server" });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await writeStubExecutables(binDir, ["codex"]);
    const ghPath = path.join(binDir, "gh");
    await writeStubExecutables(
      binDir,
      ["gh"],
      '#!/bin/sh\necho "gh backend unavailable" >&2\nexit 2\n'
    );

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: binDir },
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(report.environment.gh).toEqual({
      executablePath: ghPath,
      reason: "gh backend unavailable",
      status: "probe_failed"
    });
    expect(report.errors).toContain(
      "gh authentication probe failed: gh backend unavailable"
    );
    expect(report.errors).not.toContainEqual(
      expect.stringContaining("run `gh auth login`")
    );
  });

  it("checks only the active GitHub.com gh account", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const binDir = path.join(root, "bin");
    await writeValidConfig(configPath, { codexCommand: "codex app-server" });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    await writeStubExecutables(binDir, ["codex"]);
    await writeStubExecutables(
      binDir,
      ["gh"],
      [
        "#!/bin/sh",
        '[ "$1" = auth ] || exit 2',
        '[ "$2" = status ] || exit 2',
        '[ "$3" = --active ] || exit 2',
        '[ "$4" = --hostname ] || exit 2',
        '[ "$5" = github.com ] || exit 2',
        "exit 0",
        ""
      ].join("\n")
    );

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      env: { GITHUB_TOKEN: "test-secret-token", PATH: binDir },
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(report.environment.gh).toEqual({
      executablePath: path.join(binDir, "gh"),
      status: "authenticated"
    });
    expect(report.errors).toEqual([]);
  });

  it("runs the live provider check when requested and reports success", async () => {
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
        ...fakeAgentProviders(),
        codex: {
          cancel: () => Promise.resolve(),
          name: "codex",
          runAttempt: async function* () {
            await Promise.resolve();
            yield {
              normalized: { result: "Hi there!", type: "turn_completed" },
              raw: {}
            };
          },
          validate: () => Promise.resolve()
        }
      },
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root,
      liveCheckProvider: "codex"
    });

    expect(report.liveCheck).toEqual({
      detail: "Hi there!",
      ok: true,
      provider: "codex"
    });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails doctor when the requested live provider check fails", async () => {
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
        ...fakeAgentProviders(),
        codex: {
          cancel: () => Promise.resolve(),
          name: "codex",
          runAttempt: async function* () {
            await Promise.resolve();
            yield {
              normalized: { message: "auth expired", type: "turn_failed" },
              raw: {}
            };
          },
          validate: () => Promise.resolve()
        }
      },
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root,
      liveCheckProvider: "codex"
    });

    expect(report.liveCheck).toEqual({
      detail: "auth expired",
      ok: false,
      provider: "codex"
    });
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("--live-check codex failed: auth expired");
  });

  it("reports a missing adapter for the requested live provider check", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, { ompCommand: "omp --mode rpc" });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root,
      liveCheckProvider: "omp"
    });

    expect(report.liveCheck).toBeUndefined();
    expect(report.errors).toContain(
      "--live-check omp requested, but no adapter is registered"
    );
  });

  it("reports duplicate Routine names within one Project", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const firstPath = path.join(root, "routines", "first.md");
    const secondPath = path.join(root, "routines", "second.md");
    await writeValidConfig(configPath, {
      routinePaths: ["./routines/first.md", "./routines/second.md"]
    });
    await mkdir(path.dirname(firstPath));
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    const routine = [
      "---",
      "name: repeated",
      "schedule:",
      "  cron: daily",
      "kind: report",
      "---",
      "Create a report.",
      ""
    ].join("\n");
    await writeFile(firstPath, routine);
    await writeFile(secondPath, routine);
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain('duplicate routine name "repeated"');
    expect(output.stderr).toContain(firstPath);
    expect(output.stderr).toContain(secondPath);
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
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.providers.codex.command is invalid: codex app-server missing"
    );
    expect(report.projects[0]).toMatchObject({
      validForDispatch: false
    });
  });

  it("reports missing provider adapters as invalid for dispatch", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, {
      agentProvider: "claude"
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const report = await runDoctor({
      agentProviders: fakeAgentProviders(),
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "projects.symphonika.agent.provider references claude, but no adapter is registered"
    );
    expect(report.projects[0]).toMatchObject({
      validForDispatch: false
    });
  });

  it("accepts Claude from the default registry now that its adapter is implemented", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeHelp(fakeClaudePath);
    await writeValidConfig(configPath, {
      agentProvider: "claude",
      claudeCommand: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`
    });
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}} for {{project.name}}.\n"
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const report = await runDoctor({
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(DEFAULT_AGENT_PROVIDERS.claude?.name).toBe("claude");
    expect(DEFAULT_AGENT_PROVIDERS.omp?.name).toBe("omp");
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.projects[0]).toMatchObject({
      validForDispatch: true
    });
  });

  it("validates OMP Projects through the registered RPC adapter", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const ompCommand = "omp --mode rpc --auto-approve";
    await writeValidConfig(configPath, {
      agentProvider: "omp",
      ompCommand
    });
    await writeFile(path.join(root, "WORKFLOW.md"), "Work with OMP.\n");
    process.env.GITHUB_TOKEN = "test-secret-token";
    const validatedCommands: string[] = [];

    const report = await runDoctor({
      agentProviders: {
        omp: {
          cancel: () => Promise.resolve(),
          name: "omp",
          runAttempt: async function* () {
            await Promise.resolve();
            yield* [];
          },
          validate: (command) => {
            validatedCommands.push(command);
            return Promise.resolve();
          }
        }
      },
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(validatedCommands).toEqual([ompCommand]);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.projects[0]).toMatchObject({
      validForDispatch: true
    });
  });

  it("validates an OMP command selected by a Routine override", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const routinePath = path.join(root, "routines", "weekly-audit.md");
    const ompCommand = "omp --mode rpc --auto-approve";
    await writeValidConfig(configPath, {
      ompCommand,
      routinePaths: ["./routines/weekly-audit.md"]
    });
    await mkdir(path.dirname(routinePath), { recursive: true });
    await writeFile(
      routinePath,
      [
        "---",
        "name: weekly-audit",
        "kind: report",
        "provider: omp",
        "schedule:",
        '  cron: "@weekly"',
        "---",
        "Audit this Project.",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(root, "WORKFLOW.md"), "Work on this issue.\n");
    process.env.GITHUB_TOKEN = "test-secret-token";
    const validatedCommands: string[] = [];

    const report = await runDoctor({
      agentProviders: {
        codex: {
          cancel: () => Promise.resolve(),
          name: "codex",
          runAttempt: async function* () {
            await Promise.resolve();
            yield* [];
          },
          validate: () => Promise.resolve()
        },
        omp: {
          cancel: () => Promise.resolve(),
          name: "omp",
          runAttempt: async function* () {
            await Promise.resolve();
            yield* [];
          },
          validate: (command) => {
            validatedCommands.push(command);
            return Promise.resolve();
          }
        }
      },
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(validatedCommands).toContain(ompCommand);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
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

  it("reports invalid Workflow Contract evidence.ignore entries", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      [
        "---",
        "evidence:",
        '  ignore: ["../escape"]',
        "---",
        "Work on {{issue.title}} for {{project.name}}.",
        ""
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("evidence.ignore[0] must not contain ..");
  });

  it("rejects workflow front matter service discovery keys", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath);
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      [
        "---",
        "tracker:",
        "  kind: github",
        "---",
        "Work on {{issue.title}}.",
        ""
      ].join("\n")
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

  it("rejects raw FSM workflows whose agent prompt files are missing on disk", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, { workflowPath: "./workflow.yml" });
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: missing_prompt",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("prompt not found");
    expect(output.stderr).toContain("planning");
  });

  it("rejects raw FSM workflows referencing an unconfigured provider", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeValidConfig(configPath, { workflowPath: "./workflow.yml" });
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(path.join(root, "prompts", "plan.md"), "Plan.\n");
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: omp_override",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: omp",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-secret-token";

    const output = await runDoctorCommand(configPath);

    expect(process.exitCode).toBe(1);
    expect(output.stderr).toContain("providers.omp.command is missing");
  });

  it("validates a workflow-referenced OMP command through the adapter", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const ompCommand = "omp --mode rpc --auto-approve";
    await writeValidConfig(configPath, {
      ompCommand,
      workflowPath: "./workflow.yml"
    });
    await mkdir(path.join(root, "prompts"), { recursive: true });
    await writeFile(path.join(root, "prompts", "plan.md"), "Plan.\n");
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: omp_override",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: omp",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: done",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    process.env.GITHUB_TOKEN = "test-secret-token";
    const validatedCommands: string[] = [];

    const report = await runDoctor({
      agentProviders: {
        codex: {
          cancel: () => Promise.resolve(),
          name: "codex",
          runAttempt: async function* () {
            await Promise.resolve();
            yield* [];
          },
          validate: () => Promise.resolve()
        },
        omp: {
          cancel: () => Promise.resolve(),
          name: "omp",
          runAttempt: async function* () {
            await Promise.resolve();
            yield* [];
          },
          validate: (command) => {
            validatedCommands.push(command);
            return Promise.resolve();
          }
        }
      },
      configPath,
      githubApi: successfulGitHubApi(),
      homeDir: root
    });

    expect(validatedCommands).toContain(ompCommand);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  describe("installed systemd unit drift", () => {
    it("uses the PATH from the installed unit's drop-ins", async () => {
      const root = await makeTempRoot();
      const configPath = path.join(root, "symphonika.yml");
      const shellBin = path.join(root, "shell-bin");
      const baseUnitBin = path.join(root, "base-unit-bin");
      const dropInBin = path.join(root, "drop-in-bin");
      const unitDir = path.join(root, ".config", "systemd", "user");
      const servicePath = path.join(unitDir, "symphonika.service");
      const dropInDir = `${servicePath}.d`;
      await writeValidConfig(configPath, { codexCommand: "codex app-server" });
      await writeFile(
        path.join(root, "WORKFLOW.md"),
        "Work on {{issue.title}} for {{project.name}}.\n"
      );
      await writeStubExecutables(shellBin, ["codex", "gh"]);
      await writeStubExecutables(baseUnitBin, ["codex", "gh"]);
      await writeStubExecutables(dropInBin, ["codex", "gh"]);
      await mkdir(dropInDir, { recursive: true });
      await writeFile(servicePath, currentServiceUnit(baseUnitBin));
      await writeFile(
        path.join(dropInDir, "20-path.conf"),
        `[Service]\nEnvironment="PATH=${dropInBin}"\n`
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit()
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit()
      );

      const report = await runDoctor({
        agentProviders: fakeAgentProviders(),
        configPath,
        env: { GITHUB_TOKEN: "test-secret-token", PATH: shellBin },
        githubApi: successfulGitHubApi(),
        homeDir: root,
        hostParallelism: 1,
        offline: true
      });

      expect(report.environment.installedUnit).toMatchObject({
        binaries: [
          {
            executable: "codex",
            provider: "codex",
            resolvedPath: path.join(dropInBin, "codex")
          },
          { executable: "gh", resolvedPath: path.join(dropInBin, "gh") }
        ],
        environmentPath: dropInBin,
        servicePath,
        status: "checked"
      });
      expect(report.warnings).toEqual([]);
    });

    it("warns for a provider missing from the installed unit's frozen PATH", async () => {
      const root = await makeTempRoot();
      const configPath = path.join(root, "symphonika.yml");
      const shellBin = path.join(root, "shell-bin");
      const unitBin = path.join(root, "unit-bin");
      const unitDir = path.join(root, ".config", "systemd", "user");
      await writeValidConfig(configPath, { codexCommand: "codex app-server" });
      await writeFile(
        path.join(root, "WORKFLOW.md"),
        "Work on {{issue.title}} for {{project.name}}.\n"
      );
      await mkdir(shellBin);
      await mkdir(unitBin);
      await writeStubExecutables(shellBin, ["codex", "gh"]);
      const unitGhPath = path.join(unitBin, "gh");
      await writeStubExecutables(unitBin, ["gh"]);
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin)
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit()
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit()
      );

      const report = await runDoctor({
        agentProviders: fakeAgentProviders(),
        configPath,
        env: { GITHUB_TOKEN: "test-secret-token", PATH: shellBin },
        githubApi: successfulGitHubApi(),
        homeDir: root,
        hostParallelism: 1,
        offline: true
      });

      expect(report.environment.installedUnit).toEqual({
        binaries: [
          { executable: "codex", provider: "codex", resolvedPath: null },
          { executable: "gh", resolvedPath: unitGhPath }
        ],
        environmentPath: unitBin,
        servicePath: path.join(unitDir, "symphonika.service"),
        status: "checked"
      });
      expect(report.warnings).toContain(
        `${path.join(unitDir, "symphonika.service")} PATH does not resolve provider codex executable codex`
      );
      expect(report.ok).toBe(true);
    });

    it("does not treat the home directory as PATH when the unit has no PATH directive", async () => {
      const root = await makeTempRoot();
      const configPath = path.join(root, "symphonika.yml");
      const unitDir = path.join(root, ".config", "systemd", "user");
      await writeValidConfig(configPath, { codexCommand: "codex app-server" });
      await writeFile(
        path.join(root, "WORKFLOW.md"),
        "Work on {{issue.title}} for {{project.name}}.\n"
      );
      await writeStubExecutables(root, ["codex", "gh"]);
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit().replace(/^Environment="PATH=.*"\n/m, "")
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit()
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit()
      );

      const report = await runDoctor({
        agentProviders: fakeAgentProviders(),
        configPath,
        env: {
          GITHUB_TOKEN: "test-secret-token",
          PATH: process.env.PATH
        },
        githubApi: successfulGitHubApi(),
        homeDir: root,
        hostParallelism: 1,
        offline: true
      });

      const servicePath = path.join(unitDir, "symphonika.service");
      expect(report.environment.installedUnit).toEqual({
        binaries: [],
        environmentPath: null,
        servicePath,
        status: "path_missing"
      });
      expect(report.warnings).toEqual([
        `${servicePath} is installed but has no Environment=PATH= directive`
      ]);
    });

    it("reports no warnings when no systemd unit has been installed", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(report.warnings).toEqual([]);
    });

    it("warns when the installed unit predates the daemon/provider cgroup split", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=simple\nSlice=symphonika.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("cgroup") && warning.includes("service install")
        )
      ).toBe(true);
    });

    // Regression: `symphonika service install --force` only rewrites unit
    // files and runs `systemctl --user daemon-reload` -- it never restarts
    // an already-running daemon, so that daemon keeps its old unit (and
    // lacks the watchdog/cgroup protections this drift check exists to
    // surface) until an operator separately restarts it. The remediation
    // hint must say so, not just "re-run install".
    it("tells the operator a running daemon needs an explicit restart, not just re-install", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=simple\nSlice=symphonika.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some((warning) => warning.includes("restart"))
      ).toBe(true);
    });

    it("warns when the installed unit predates the systemd watchdog heartbeat", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=simple\nSlice=symphonika-daemon.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("watchdog") && warning.includes("service install")
        )
      ).toBe(true);
    });

    it("warns when the installed service does not request daemon protection from OOM victim selection", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      await mkdir(unitDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin).replace(/^OOMScoreAdjust=-500\n/m, ""),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit(),
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("daemon protection from OOM victim selection") &&
            warning.includes("service install")
        )
      ).toBe(true);
    });

    it("warns when a service drop-in neutralizes the daemon's OOM protection request", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      const dropInDir = path.join(unitDir, "symphonika.service.d");
      await mkdir(dropInDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin),
        "utf8"
      );
      await writeFile(
        path.join(dropInDir, "20-oom-score.conf"),
        "[Service]\nOOMScoreAdjust=0\n",
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit(),
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some((warning) =>
          warning.includes("daemon protection from OOM victim selection")
        )
      ).toBe(true);
    });

    it("warns when the installed unit predates environment-file secret injection", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=notify\nWatchdogSec=90\nNotifyAccess=all\nTimeoutStartSec=300\nSlice=symphonika-daemon.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("environment-backed secrets") &&
            warning.includes("service install") &&
            warning.includes("repeat the original `--config <path>`")
        )
      ).toBe(true);
    });

    // Regression: the generated unit explains Type=notify in comments. If an
    // operator changes the active directive to Type=simple, matching a bare
    // substring must not mistake the explanatory comment for the directive.
    it("warns when Type=notify appears only in a comment", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        [
          "[Service]",
          "Type=simple",
          "# Type=notify holds the unit activating until READY=1.",
          "WatchdogSec=90",
          "TimeoutStartSec=300",
          "NotifyAccess=all",
          "Slice=symphonika-daemon.slice",
          ""
        ].join("\n"),
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("watchdog") && warning.includes("service install")
        )
      ).toBe(true);
    });

    it("accepts systemd-valid whitespace around an active Type=notify directive", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        [
          "[Service]",
          "  Type = notify  ",
          "WatchdogSec=90",
          "TimeoutStartSec=300",
          "NotifyAccess=all",
          "Slice=symphonika-daemon.slice",
          ""
        ].join("\n"),
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("watchdog") && warning.includes("service install")
        )
      ).toBe(false);
    });

    // Regression: a unit installed from a build between the watchdog
    // heartbeat landing (Type=notify/WatchdogSec=90) and NotifyAccess=all
    // being added to fix the child-process-notifier rejection would have
    // Type=notify but no NotifyAccess=all -- its READY=1/WATCHDOG=1 pings
    // are silently discarded by systemd, so it must still be flagged as
    // stale rather than reported current just because Type=notify matches.
    it("warns when the installed unit has Type=notify but predates NotifyAccess=all", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=notify\nWatchdogSec=90\nSlice=symphonika-daemon.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("watchdog") && warning.includes("service install")
        )
      ).toBe(true);
    });

    // Regression: Type=notify and NotifyAccess=all alone don't guarantee a
    // working watchdog -- without WatchdogSec=, systemd never sets
    // WATCHDOG_USEC in the daemon's environment, so
    // systemdWatchdogPingIntervalMs stays undefined and the ping timer never
    // starts, silently, with no other symptom. The check must require
    // WatchdogSec= too, not just the notify-transport markers.
    it("warns when the installed unit has Type=notify and NotifyAccess=all but no WatchdogSec=", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=notify\nNotifyAccess=all\nSlice=symphonika-daemon.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("watchdog") && warning.includes("service install")
        )
      ).toBe(true);
    });

    // Regression: the check must match the WatchdogSec= directive, not any
    // occurrence of the substring -- the unit template's own comment above
    // it ("WatchdogSec= requires a periodic...") contains the literal text
    // "WatchdogSec=", and an operator's hand-tuned WatchdogSec=120 must not
    // be flagged as stale just because it isn't the default 90.
    it("does not warn about an operator's hand-tuned WatchdogSec= value", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=notify\nWatchdogSec=120\nNotifyAccess=all\nTimeoutStartSec=300\nSlice=symphonika-daemon.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some((warning) => warning.includes("watchdog"))
      ).toBe(false);
    });

    // Regression: a unit installed before TimeoutStartSec= was added has no
    // startup-timeout override, leaving it exposed to the default
    // DefaultTimeoutStartSec=90s -- slow initial GitHub polling can then
    // restart-loop an otherwise healthy daemon before it ever sends READY=1.
    it("warns when the installed unit predates TimeoutStartSec=", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=notify\nWatchdogSec=90\nNotifyAccess=all\nSlice=symphonika-daemon.slice\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("watchdog") && warning.includes("service install")
        )
      ).toBe(true);
    });

    it("warns when an installed slice file's content has drifted from the generator", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        "[Service]\nType=notify\nSlice=symphonika-daemon.slice\n",
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        "[Slice]\nMemoryHigh=999G\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("symphonika-daemon.slice") &&
            warning.includes("service install")
        )
      ).toBe(true);
    });

    it("does not warn about operator-customized slice resource limits", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      await mkdir(unitDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit()
          .replace("MemoryHigh=4G", "MemoryHigh=2G")
          .replace("MemoryMax=6G", "MemoryMax=3G"),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit()
          .replace("MemoryMax=32G", "MemoryMax=12G")
          .replace("TasksMax=4096", "TasksMax=2048"),
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(report.warnings).toEqual([]);
    });

    it("warns when host build parallelism and configured concurrency outrun the providers slice budget", async () => {
      const report = await runProviderCapacityDoctor({
        hostParallelism: 24
      });

      const warning = report.warnings.find((entry) =>
        entry.includes("provider build memory estimate")
      );
      expect(warning).toContain("host parallelism=24");
      expect(warning).toContain("1.5 GiB/compiler");
      expect(warning).toContain("global.max_in_flight=8");
      expect(warning).toContain("symphonika max_in_flight=1");
      expect(warning).toContain("effective max_in_flight=1");
      expect(warning).toContain("MemoryMax=32G");
      expect(warning).toContain("36 GiB");
      expect(warning).toContain("lower max_in_flight");
      expect(warning).toContain("raise MemoryMax=");
      expect(warning).toContain("build-parallelism ceiling from #643");
      expect(report.ok).toBe(true);
    });

    it("does not warn when the build memory estimate exceeds MemoryMax by less than the 10% margin", async () => {
      const report = await runProviderCapacityDoctor({
        hostParallelism: 22
      });

      expect(
        report.warnings.some((entry) =>
          entry.includes("provider build memory estimate")
        )
      ).toBe(false);
    });

    it("uses a drop-in's winning MemoryMax value for the build memory estimate", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "64G",
        hostParallelism: 24
      });

      expect(
        report.warnings.some((entry) =>
          entry.includes("provider build memory estimate")
        )
      ).toBe(false);
    });

    it("parses an unsuffixed MemoryMax= as raw bytes, not kibibytes", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "34359738368", // 32 GiB in bytes, no K/M/G/T suffix
        hostParallelism: 24
      });

      const warning = report.warnings.find((entry) =>
        entry.includes("provider build memory estimate")
      );
      expect(warning).toContain("MemoryMax=34359738368");
      expect(warning).toContain("(32 GiB)");
      expect(warning).toContain("36 GiB");
    });

    it.each([
      "bogus",
      "0",
      "10garbage",
      "32GB",
      "0%",
      "50.123%",
      "+50.123%",
      "200%",
      "0B",
      "0 0",
      "0G0M",
      "+0G",
      "64+4G",
      "1G2G",
      "512M1G",
      "0G0.1B",
      "0.6B0.6",
      "18446744073709551614B0.9999999999999999",
      "0.18446744073709551616G",
      "0.99999999999999999999K",
      "+16E",
      "15.1E",
      "16E1P",
      "18446744073709551615",
      "+18446744073709551615",
      "+ 64G",
      "+64G\u00a0+512M",
      "64G\u00a0",
      "-50%",
      "-100%",
      "-500.5\u2030",
      "-5000\u2031",
      "1G500m",
      "Infinity",
      "INFINITY"
    ])(
      "falls back to the last valid MemoryMax= when a later drop-in is invalid (%s)",
      async (invalidValue) => {
        const report = await runProviderCapacityDoctor({
          dropInMemoryMax: invalidValue,
          hostParallelism: 24
        });

        const warning = report.warnings.find((entry) =>
          entry.includes("provider build memory estimate")
        );
        expect(warning).toContain("MemoryMax=32G");
        expect(warning).toContain("36 GiB");
      }
    );

    it("recognizes MemoryMax= in a drop-in that starts with a UTF-8 BOM", async () => {
      const report = await runProviderCapacityDoctor({
        dropInBom: true,
        dropInMemoryMax: "6G",
        hostParallelism: 24
      });

      const warning = report.warnings.find((entry) =>
        entry.includes("provider build memory estimate")
      );
      expect(warning).toContain("MemoryMax=6G");
    });

    it("does not overflow-reject a bare MemoryMax= within 2 of the uint64 ceiling", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "18446744073709551614", // 2^64 - 2
        hostParallelism: 24
      });

      expect(
        report.warnings.some((entry) =>
          entry.includes("provider build memory estimate")
        )
      ).toBe(false);
    });

    it("accepts a fractional remainder on the uint64 sentinel the way systemd's own overflow guard wraps", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "18446744073709551615.1K", // wraps to 18446744073709550694
        hostParallelism: 24
      });

      expect(
        report.warnings.some((entry) =>
          entry.includes("provider build memory estimate")
        )
      ).toBe(false);
    });

    it("rounds a near-one fractional byte the way systemd's own double-widening does", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "0.9999999999999999B", // widens to exactly 1 byte, not 0
        hostParallelism: 24
      });

      expect(
        report.warnings.some((entry) =>
          entry.includes("provider build memory estimate")
        )
      ).toBe(false);
    });

    it("still rejects a whole-number part past UINT64_MAX even with a fractional remainder", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "18446744073709551616.1K", // 2^64, strtoull() itself would ERANGE
        hostParallelism: 24
      });

      const warning = report.warnings.find((entry) =>
        entry.includes("provider build memory estimate")
      );
      expect(warning).toContain("MemoryMax=32G");
      expect(warning).toContain("36 GiB");
    });

    it("rejects a long malformed digit run without catastrophic backtracking", async () => {
      const start = Date.now();
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: `${"1".repeat(2000)}x`,
        hostParallelism: 24
      });
      expect(Date.now() - start).toBeLessThan(2000);

      const warning = report.warnings.find((entry) =>
        entry.includes("provider build memory estimate")
      );
      expect(warning).toContain("MemoryMax=32G");
      expect(warning).toContain("36 GiB");
    });

    it.each([
      "50%",
      "100%",
      "+50%",
      "+100%",
      "-0.01%",
      "-00.01%",
      "0x32%",
      "0b1%",
      "0144%",
      "500.5‰",
      "+500.5‰",
      "-0.1‰",
      "5000‱",
      "+5000‱",
      "1024B",
      "2P",
      "1G 500M",
      "3. G",
      "+3.G2.M",
      "+64G",
      "64G512M",
      "64G+512M",
      "+64G+512M",
      "1K1B1",
      "+1G 500M",
      "64G\v512M",
      "64G\f512M"
    ])(
      "does not fall back past a MemoryMax= form it cannot parse but systemd accepts (%s)",
      async (unparseableButValid) => {
        const report = await runProviderCapacityDoctor({
          dropInMemoryMax: unparseableButValid,
          hostParallelism: 24
        });

        expect(
          report.warnings.some((entry) =>
            entry.includes("provider build memory estimate")
          )
        ).toBe(false);
      }
    );

    it("parses a MemoryMax= with whitespace before the suffix", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "32 G",
        hostParallelism: 24
      });

      const warning = report.warnings.find((entry) =>
        entry.includes("provider build memory estimate")
      );
      expect(warning).toContain("MemoryMax=32 G");
      expect(warning).toContain("(32 GiB)");
      expect(warning).toContain("36 GiB");
    });

    it("does not fall back past a lowercase MemoryMax=infinity reset", async () => {
      const report = await runProviderCapacityDoctor({
        dropInMemoryMax: "infinity",
        hostParallelism: 24
      });

      expect(
        report.warnings.some((entry) =>
          entry.includes("provider build memory estimate")
        )
      ).toBe(false);
    });

    // `service install --force` never reaches a host that doesn't re-run it,
    // so an installed providers slice still carrying the MemoryHigh= that
    // docs/adr/0089 removed keeps throttling every concurrent provider at
    // once — with nothing killed — exactly as before the fix. Structural
    // presence is checked here, never the operator's chosen value.
    it("warns when the installed providers slice still declares MemoryHigh=", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      await mkdir(unitDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit().replace(
          "MemoryMax=32G",
          "MemoryHigh=24G\nMemoryMax=32G"
        ),
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("symphonika-providers.slice") &&
            warning.includes("MemoryHigh=") &&
            warning.includes("service install")
        )
      ).toBe(true);
    });

    // Regression: `service install --force` rewrites only the base unit, so a
    // MemoryHigh= an operator or config manager parked in a drop-in survives
    // the upgrade and keeps throttling the whole slice. The base file alone
    // shows nothing wrong.
    it("warns when a providers-slice drop-in declares MemoryHigh=", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      const dropInDir = path.join(unitDir, "symphonika-providers.slice.d");
      await mkdir(dropInDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(dropInDir, "10-local.conf"),
        "[Slice]\nMemoryHigh=24G\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      // The remediation must name the drop-in, not the base unit: re-running
      // `service install --force` would never clear it.
      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("10-local.conf") &&
            warning.includes("MemoryHigh=24G") &&
            warning.includes("daemon-reload")
        )
      ).toBe(true);
    });

    // systemd applies drop-ins after the base unit in sorted order and the
    // last scalar assignment wins, so `MemoryHigh=infinity` there is the
    // idiomatic way to neutralize a limit without editing the base unit.
    // Warning on the directive's presence would nag the operator who fixed it.
    it("does not warn when a drop-in neutralizes MemoryHigh= with infinity", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      const dropInDir = path.join(unitDir, "symphonika-providers.slice.d");
      await mkdir(dropInDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit().replace(
          "MemoryMax=32G",
          "MemoryHigh=24G\nMemoryMax=32G"
        ),
        "utf8"
      );
      await writeFile(
        path.join(dropInDir, "20-no-soft-limit.conf"),
        "[Slice]\nMemoryHigh=infinity\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(report.warnings).toEqual([]);
    });

    // The required-directive half stays base-only on purpose: `service
    // install` writes the base unit, so that is the only place a required
    // directive can go missing, and folding drop-ins in would let one that
    // re-states a directive mask a truncated base unit.
    it("still reports a required directive missing from the base slice when a drop-in supplies it", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      const dropInDir = path.join(unitDir, "symphonika-providers.slice.d");
      await mkdir(dropInDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit().replace("MemoryMax=32G\n", ""),
        "utf8"
      );
      await writeFile(
        path.join(dropInDir, "10-local.conf"),
        "[Slice]\nMemoryMax=32G\n",
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(
        report.warnings.some(
          (warning) =>
            warning.includes("symphonika-providers.slice") &&
            warning.includes("MemoryMax=") &&
            warning.includes("missing required")
        )
      ).toBe(true);
    });

    it("reports no warnings when the installed units match the current generator output", async () => {
      const root = await makeTempRoot();
      const homeDir = await makeTempRoot();
      const unitDir = path.join(homeDir, ".config", "systemd", "user");
      const unitBin = path.join(homeDir, "bin");
      await mkdir(unitDir, { recursive: true });
      await writeStubExecutables(unitBin, ["gh"]);
      await writeFile(
        path.join(unitDir, "symphonika.service"),
        currentServiceUnit(unitBin),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-daemon.slice"),
        renderSliceUnit(),
        "utf8"
      );
      await writeFile(
        path.join(unitDir, "symphonika-providers.slice"),
        renderProvidersSliceUnit(),
        "utf8"
      );

      const report = await runDoctor({
        configPath: path.join(root, "nonexistent.yml"),
        env: {},
        homeDir
      });

      expect(report.warnings).toEqual([]);
    });

    it("prints doctor warnings to stdout alongside an ok result", async () => {
      const output = { stderr: "", stdout: "" };
      const program = buildCli({
        registerSignalHandlers: false,
        runDoctor: () =>
          Promise.resolve({
            configPath: "/tmp/symphonika.yml",
            environment: TEST_DOCTOR_ENVIRONMENT,
            errors: [],
            ok: true,
            projects: [],
            warnings: ["symphonika.service predates the cgroup split"]
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

      await program.parseAsync(["node", "symphonika", "doctor"]);

      expect(output.stdout).toContain("doctor ok");
      expect(output.stdout).toContain(
        "symphonika.service predates the cgroup split"
      );
    });

    it("prints doctor warnings alongside a failed result", async () => {
      const output = { stderr: "", stdout: "" };
      const program = buildCli({
        registerSignalHandlers: false,
        runDoctor: () =>
          Promise.resolve({
            configPath: "/tmp/symphonika.yml",
            environment: TEST_DOCTOR_ENVIRONMENT,
            errors: ["projects is required"],
            ok: false,
            projects: [],
            warnings: ["symphonika.service predates the cgroup split"]
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

      await program.parseAsync(["node", "symphonika", "doctor"]);

      expect(output.stderr).toContain("doctor failed");
      expect(output.stdout).toContain("- gh: authenticated (/usr/bin/gh)");
      expect(output.stdout).toContain(
        "symphonika.service predates the cgroup split"
      );
    });
  });
});

async function runDoctorCommand(
  configPath: string,
  githubApi: GitHubApi = successfulGitHubApi()
): Promise<{ stderr: string; stdout: string }> {
  // Isolated, unit-free homeDir: without this, the installed-unit-drift
  // check (see checkInstalledUnitDrift in doctor.ts) would default to the
  // real homedir() and pick up whatever systemd unit happens to be
  // installed on the machine running the suite, making these tests
  // non-hermetic.
  const homeDir = await makeTempRoot();
  await mkdir(path.join(homeDir, ".codex"), { recursive: true });
  await writeFile(
    path.join(homeDir, ".codex", "config.toml"),
    '[profiles.symphonika]\nsandbox_mode = "danger-full-access"\napproval_policy = "never"\nmodel_reasoning_summary = "detailed"\nmodel_verbosity = "medium"\n'
  );
  const output = { stderr: "", stdout: "" };
  const program = buildCli({
    registerSignalHandlers: false,
    runDoctor: (options) =>
      runDoctor({
        ...options,
        agentProviders: fakeAgentProviders(),
        githubApi,
        homeDir
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

async function runProviderCapacityDoctor(input: {
  dropInMemoryMax?: string;
  dropInBom?: boolean;
  hostParallelism: number;
}) {
  const root = await makeTempRoot();
  const configPath = path.join(root, "symphonika.yml");
  const unitDir = path.join(root, ".config", "systemd", "user");
  const unitBin = path.join(root, "bin");
  await writeValidConfig(configPath, {
    globalLines: ["global:", "  max_in_flight: 8"],
    projectLines: ["    max_in_flight: 1"]
  });
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    "Work on {{issue.title}} for {{project.name}}.\n"
  );
  await mkdir(unitDir, { recursive: true });
  await writeStubExecutables(unitBin, ["codex", "gh"]);
  await writeFile(
    path.join(unitDir, "symphonika.service"),
    currentServiceUnit(unitBin),
    "utf8"
  );
  await writeFile(
    path.join(unitDir, "symphonika-daemon.slice"),
    renderSliceUnit(),
    "utf8"
  );
  await writeFile(
    path.join(unitDir, "symphonika-providers.slice"),
    renderProvidersSliceUnit(),
    "utf8"
  );
  if (input.dropInMemoryMax !== undefined) {
    const dropInDir = path.join(unitDir, "symphonika-providers.slice.d");
    await mkdir(dropInDir);
    await writeFile(
      path.join(dropInDir, "20-memory-budget.conf"),
      `${input.dropInBom === true ? "\uFEFF" : ""}[Slice]\nMemoryMax=${input.dropInMemoryMax}\n`,
      "utf8"
    );
  }

  return runDoctor({
    agentProviders: fakeAgentProviders(),
    configPath,
    env: {
      GITHUB_TOKEN: "test-secret-token",
      PATH: process.env.PATH
    },
    githubApi: successfulGitHubApi(),
    homeDir: root,
    hostParallelism: input.hostParallelism,
    offline: true
  });
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
    listLabels: () =>
      Promise.resolve(["agent-ready", ...REQUIRED_OPERATIONAL_LABELS]),
    validateRepositoryAccess: () => Promise.resolve({ ok: true })
  };
}

async function writeValidConfig(
  configPath: string,
  overrides: {
    additionalProjectLines?: string[];
    agentProvider?: string;
    claudeCommand?: string;
    codexCommand?: string;
    globalLines?: string[];
    ompCommand?: string;
    projectLines?: string[];
    routineDefaultLines?: string[];
    routinePaths?: string[];
    token?: string;
    trackerKind?: string;
    workspaceHookLines?: string[];
    workflowPath?: string;
  } = {}
): Promise<void> {
  const configDir = path.dirname(configPath);
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(configDir, ".codex"), { recursive: true });
  await writeFile(
    path.join(configDir, ".codex", "config.toml"),
    '[profiles.symphonika]\nsandbox_mode = "danger-full-access"\napproval_policy = "never"\nmodel_reasoning_summary = "detailed"\nmodel_verbosity = "medium"\n'
  );
  const binDir = path.join(configDir, "test-bin");
  await mkdir(binDir, { recursive: true });
  await writeStubExecutables(binDir, ["claude", "codex", "gh", "omp"]);
  process.env.PATH = [binDir, originalPath ?? ""]
    .filter(Boolean)
    .join(path.delimiter);
  await writeFile(
    configPath,
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      ...(overrides.globalLines ?? []),
      "providers:",
      "  codex:",
      `    command: "${overrides.codexCommand ?? DEFAULT_CODEX_COMMAND}"`,
      "  claude:",
      `    command: "${overrides.claudeCommand ?? "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json"}"`,
      ...(overrides.ompCommand === undefined
        ? []
        : ["  omp:", `    command: "${overrides.ompCommand}"`]),
      ...(overrides.routineDefaultLines ?? []),
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      ...(overrides.projectLines ?? []),
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
      ...(overrides.workspaceHookLines ?? []),
      "    agent:",
      `      provider: ${overrides.agentProvider ?? "codex"}`,
      `    workflow: ${overrides.workflowPath ?? "./WORKFLOW.md"}`,
      ...(overrides.additionalProjectLines ?? []),
      ...(overrides.routinePaths === undefined
        ? []
        : [
            "routines:",
            ...overrides.routinePaths.map(
              (routinePath) =>
                `  - projects: [symphonika]\n    path: ${routinePath}`
            )
          ]),
      ""
    ].join("\n")
  );
}

async function writeFakeClaudeHelp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "if (process.argv.includes('--help')) {",
      "  process.stdout.write('Usage: fake-claude -p --input-format stream-json --output-format stream-json\\n');",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      ""
    ].join("\n"),
    "utf8"
  );
}
