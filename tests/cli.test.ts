import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import type { StartDaemonOptions } from "../src/daemon.js";
import type {
  ClearStaleOptions,
  ClearStaleReport,
  InitProjectOptions
} from "../src/doctor.js";
import type { SmokeOptions, SmokeReport } from "../src/smoke.js";

const tempRoots: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-cli-test-"));
  tempRoots.push(root);
  return root;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("CLI", () => {
  it("prints top-level help when invoked through an npm-style bin symlink", async () => {
    const root = await makeTempRoot();
    const binPath = path.join(root, "symphonika");
    await symlink(path.join(repoRoot, "src", "cli.ts"), binPath);

    const { stdout } = await execFile(
      process.execPath,
      ["--import", "tsx", binPath, "--help"],
      { cwd: repoRoot }
    );

    expect(stdout).toContain("Usage: symphonika");
    expect(stdout).toContain("Commands:");
    expect(stdout).toContain("doctor");
    expect(stdout).toContain("clear-stale");
    expect(stdout).toContain("workflow");
    expect(stdout).toContain("status");
    expect(stdout).toContain("show-run");
  });

  it("starts the daemon with the selected config path and port", async () => {
    const starts: StartDaemonOptions[] = [];
    const program = buildCli({
      registerSignalHandlers: false,
      startDaemon: (options) => {
        starts.push(options);
        return Promise.resolve({
          host: "127.0.0.1",
          port: options.port ?? 3000,
          stateRoot: "/tmp/symphonika",
          stop: () => Promise.resolve(),
          url: "http://127.0.0.1:4001"
        });
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "daemon",
      "--config",
      "custom.yml",
      "--port",
      "4001"
    ]);

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      configPath: "custom.yml",
      port: 4001
    });
  });

  it("clear-stale calls the underlying runner with --yes and prints removed labels", async () => {
    const calls: ClearStaleOptions[] = [];
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runClearStale: (options) => {
        calls.push(options);
        return Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          issueNumber: options.issueNumber,
          ok: true,
          project: options.project,
          removedLabels: ["sym:stale", "sym:claimed", "sym:running"],
          repository: "pmatos/symphonika",
          warnings: [
            "clear-stale will remove sym:stale, sym:claimed, sym:running from pmatos/symphonika#42"
          ]
        } satisfies ClearStaleReport);
      }
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
      "clear-stale",
      "symphonika",
      "42",
      "--yes"
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      issueNumber: 42,
      project: "symphonika",
      yes: true
    });
    expect(output.stdout).toContain("clear-stale ok");
    expect(output.stdout).toContain("sym:stale");
    expect(output.stdout).toContain("sym:claimed");
    expect(output.stdout).toContain("sym:running");
  });

  it("clear-stale exits non-zero when the runner reports failure (no --yes)", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runClearStale: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: ["pass --yes to remove stale-claim labels non-interactively"],
          issueNumber: 7,
          ok: false,
          project: "symphonika",
          removedLabels: [],
          repository: "pmatos/symphonika",
          warnings: [
            "clear-stale would remove sym:stale, sym:claimed, sym:running from pmatos/symphonika#7"
          ]
        } satisfies ClearStaleReport)
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync([
        "node",
        "symphonika",
        "clear-stale",
        "symphonika",
        "7"
      ]);

      expect(process.exitCode).toBe(1);
      expect(output.stderr).toContain("clear-stale failed");
      expect(output.stderr).toContain("pass --yes");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("smoke forwards --config to the runner and prints a dispatched-run summary", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const calls: SmokeOptions[] = [];
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runSmoke: (options) => {
        calls.push(options);
        return Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          dispatched: true,
          errors: [],
          ok: true,
          runDetail: {
            branchName: "sym/symphonika/42-x",
            createdAt: "2026-05-04T17:00:00.000Z",
            id: "run-x",
            issueNumber: 42,
            issueSnapshotPath: "/tmp/state/logs/runs/run-x/issue-snapshot.json",
            issueTitle: "Title",
            metadataPath: "/tmp/state/logs/runs/run-x/prompt-metadata.json",
            normalizedLogPath:
              "/tmp/state/logs/runs/run-x/provider.normalized.jsonl",
            project: "symphonika",
            promptPath: "/tmp/state/logs/runs/run-x/prompt.md",
            provider: "codex",
            rawLogPath: "/tmp/state/logs/runs/run-x/provider.raw.jsonl",
            state: "succeeded",
            terminalReason: null,
            updatedAt: "2026-05-04T17:00:01.000Z",
            workspacePath: "/tmp/state/workspaces/symphonika/issues/42-x"
          },
          runId: "run-x",
          warnings: []
        } satisfies SmokeReport);
      }
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync([
        "node",
        "symphonika",
        "smoke",
        "--config",
        "custom.yml"
      ]);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ configPath: "custom.yml" });
      expect(output.stdout).toContain("smoke ok");
      expect(output.stdout).toContain("run-x");
      expect(output.stdout).toContain("succeeded");
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("smoke exits non-zero when the runner reports a doctor failure", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runSmoke: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          dispatched: false,
          errors: [
            "projects.symphonika.tracker.repository pmatos/symphonika is missing operational labels: sym:claimed"
          ],
          ok: false,
          warnings: []
        } satisfies SmokeReport)
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync(["node", "symphonika", "smoke"]);

      expect(process.exitCode).toBe(1);
      expect(output.stderr).toContain("smoke failed");
      expect(output.stderr).toContain("missing operational labels");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("smoke prints a descriptive error when a dispatched run fails", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runSmoke: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          dispatched: true,
          errors: [
            "run run-failed terminated in state failed; terminalReason=turn_failed: boom; provider.normalized.jsonl: /tmp/state/logs/runs/run-failed/provider.normalized.jsonl"
          ],
          ok: false,
          runDetail: {
            branchName: "sym/symphonika/99-x",
            createdAt: "2026-05-04T17:00:00.000Z",
            id: "run-failed",
            issueNumber: 99,
            issueSnapshotPath:
              "/tmp/state/logs/runs/run-failed/issue-snapshot.json",
            issueTitle: "Failure",
            metadataPath: "/tmp/state/logs/runs/run-failed/prompt-metadata.json",
            normalizedLogPath:
              "/tmp/state/logs/runs/run-failed/provider.normalized.jsonl",
            project: "symphonika",
            promptPath: "/tmp/state/logs/runs/run-failed/prompt.md",
            provider: "codex",
            rawLogPath: "/tmp/state/logs/runs/run-failed/provider.raw.jsonl",
            state: "failed",
            terminalReason: "turn_failed: boom",
            updatedAt: "2026-05-04T17:00:01.000Z",
            workspacePath: "/tmp/state/workspaces/symphonika/issues/99-x"
          },
          runId: "run-failed",
          warnings: []
        } satisfies SmokeReport)
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync(["node", "symphonika", "smoke"]);

      expect(process.exitCode).toBe(1);
      expect(output.stderr).toContain("smoke failed");
      expect(output.stderr).toContain("run run-failed terminated in state failed");
      expect(output.stderr).toContain("terminalReason=turn_failed");
      expect(output.stderr).toContain("provider.normalized.jsonl");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("smoke prints a skipReason when no eligible issue exists and exits zero", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runSmoke: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          dispatched: false,
          errors: [],
          ok: true,
          skipReason: "no eligible issues to dispatch",
          warnings: []
        } satisfies SmokeReport)
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync(["node", "symphonika", "smoke"]);

      expect(process.exitCode).not.toBe(1);
      expect(output.stdout).toContain("smoke skipped");
      expect(output.stdout).toContain("no eligible issues");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("clear-stale rejects non-numeric issue arguments", async () => {
    const program = buildCli({
      registerSignalHandlers: false,
      runClearStale: () =>
        Promise.reject(new Error("should not be invoked"))
    });
    program.exitOverride();
    for (const command of program.commands) {
      command.exitOverride();
    }
    program.configureOutput({
      writeErr: () => {
        /* swallow Commander's stderr noise */
      },
      writeOut: () => {
        /* swallow Commander's stdout noise */
      }
    });

    await expect(
      program.parseAsync([
        "node",
        "symphonika",
        "clear-stale",
        "symphonika",
        "not-a-number",
        "--yes"
      ])
    ).rejects.toThrow(/issue number/i);
  });

  it("doctor prints stale issues per project after the OK summary", async () => {
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runDoctor: () =>
        Promise.resolve({
          configPath: "/tmp/symphonika.yml",
          errors: [],
          ok: true,
          projects: [
            {
              missingOperationalLabels: [],
              name: "symphonika",
              staleIssues: [
                {
                  number: 42,
                  title: "Orphan claimed issue",
                  url: "https://github.com/pmatos/symphonika/issues/42"
                }
              ],
              validForDispatch: true,
              workflowPath: "/tmp/WORKFLOW.md"
            }
          ]
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
    expect(output.stdout).toContain("project: symphonika — stale issues: 1");
    expect(output.stdout).toContain("#42  Orphan claimed issue");
  });

  it("doctor points first-time users to init when the default user config is missing", async () => {
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.exitCode = 0;
    const root = await makeTempRoot();
    const configHome = path.join(root, "config");
    const stateHome = path.join(root, "state");
    process.chdir(root);
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_STATE_HOME = stateHome;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync(["node", "symphonika", "doctor"]);

      expect(process.exitCode).toBe(1);
      expect(output.stderr).toContain("doctor failed");
      expect(output.stderr).toContain(
        path.join(configHome, "symphonika", "symphonika.yml")
      );
      expect(output.stderr).toContain("symphonika init");
    } finally {
      process.chdir(previousCwd);
      restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
      restoreEnv("XDG_STATE_HOME", previousStateHome);
      process.exitCode = previousExitCode;
    }
  });

  it("init creates a user service config for the current GitHub project", async () => {
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.exitCode = 0;
    const root = await makeTempRoot();
    const projectRoot = path.join(root, "s11");
    const configHome = path.join(root, "config");
    const stateHome = path.join(root, "state");
    await mkdir(projectRoot, { recursive: true });
    await execFile("git", ["init", "--initial-branch", "main"], {
      cwd: projectRoot
    });
    await execFile(
      "git",
      ["remote", "add", "origin", "https://github.com/pmatos/s11.git"],
      { cwd: projectRoot }
    );
    process.chdir(projectRoot);
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_STATE_HOME = stateHome;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.exitOverride();
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });
    const configPath = path.join(configHome, "symphonika", "symphonika.yml");
    const stateRoot = path.join(stateHome, "symphonika");
    const workflowPath = path.join(projectRoot, "WORKFLOW.md");

    try {
      await program.parseAsync(["node", "symphonika", "init"]);

      const config = await readFile(configPath, "utf8");
      const workflow = await readFile(workflowPath, "utf8");
      expect(config).toContain(`root: ${stateRoot}`);
      expect(config).toContain("owner: pmatos");
      expect(config).toContain("repo: s11");
      expect(config).toContain("remote: https://github.com/pmatos/s11.git");
      expect(config).toContain(`root: ${path.join(stateRoot, "workspaces", "s11")}`);
      expect(config).toContain(`workflow: ${workflowPath}`);
      expect(workflow).toContain("# Implementing issue #{{issue.number}}");
      expect(output.stdout).toContain("init ok");
      expect(output.stdout).toContain(configPath);
      expect(output.stdout).toContain("symphonika doctor");
      expect(output.stderr).toBe("");
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.chdir(previousCwd);
      restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
      restoreEnv("XDG_STATE_HOME", previousStateHome);
      process.exitCode = previousExitCode;
    }
  });

  it("runs init-project with the selected config path and explicit confirmation", async () => {
    const initializations: InitProjectOptions[] = [];
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runInitProject: (options) => {
        initializations.push(options);
        return Promise.resolve({
          configPath: "/tmp/custom.yml",
          errors: [],
          ok: true,
          projects: [
            {
              createdOperationalLabels: ["sym:running"],
              missingOperationalLabels: ["sym:running"],
              name: "symphonika",
              repository: "pmatos/symphonika"
            }
          ],
          warnings: [
            "init-project will create operational labels in pmatos/symphonika: sym:running"
          ]
        });
      }
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
      "init-project",
      "--config",
      "custom.yml",
      "--yes"
    ]);

    expect(initializations).toHaveLength(1);
    expect(initializations[0]).toMatchObject({
      configPath: "custom.yml",
      yes: true
    });
    expect(output.stderr).toContain("will create operational labels");
    expect(output.stdout).toContain("init-project ok");
    expect(output.stdout).toContain("sym:running");
  });

  it("explains the expanded workflow graph for a selected project", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      complete_when:",
        "        artifact_exists: PLAN.md",
        "      transitions:",
        "        - to: pr_open",
        "    pr_open:",
        "      exit: success",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: done",
        "  states:",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.exitOverride();
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
      "workflow",
      "explain",
      "--config",
      configPath,
      "--project",
      "symphonika"
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("workflow: issue_to_merge");
    expect(output.stdout).toContain(`source: ${path.join(root, "workflow.yml")}`);
    expect(output.stdout).toContain(`template files: ${templatePath}`);
    expect(output.stdout).toContain("state: build_pr.planning");
    expect(output.stdout).toContain(
      "action: agent provider=codex prompt=prompts/plan.md"
    );
    expect(output.stdout).toContain("terminal: success");
  });

  it("validates the selected workflow graph and reports state-machine errors", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: agent",
        "        provider: codex",
        "        prompt: prompts/plan.md",
        "      transitions:",
        "        - to: missing_state",
        ""
      ].join("\n")
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync([
        "node",
        "symphonika",
        "workflow",
        "validate",
        "--config",
        configPath,
        "--project",
        "symphonika"
      ]);

      expect(process.exitCode).toBe(1);
      expect(output.stdout).toBe("");
      expect(output.stderr).toContain("workflow validate failed");
      expect(output.stderr).toContain("missing_state");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("rejects YAML workflow files that omit the top-level workflow mapping", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflows:",
        "  name: typo",
        "  initial: planning",
        "  states:",
        "    planning:",
        "      action:",
        "        kind: wait",
        ""
      ].join("\n")
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync([
        "node",
        "symphonika",
        "workflow",
        "validate",
        "--config",
        configPath,
        "--project",
        "symphonika"
      ]);

      expect(process.exitCode).toBe(1);
      expect(output.stdout).toBe("");
      expect(output.stderr).toContain("workflow validate failed");
      expect(output.stderr).toContain("top-level workflow mapping");
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("rejects terminal workflow states that declare work", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: done",
        "  states:",
        "    done:",
        "      terminal: success",
        "      action:",
        "        kind: wait",
        "      complete_when:",
        "        provider_success: true",
        "      transitions:",
        "        - to: next",
        "    next:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync([
        "node",
        "symphonika",
        "workflow",
        "validate",
        "--config",
        configPath,
        "--project",
        "symphonika"
      ]);

      expect(process.exitCode).toBe(1);
      expect(output.stdout).toBe("");
      expect(output.stderr).toContain("workflow validate failed");
      expect(output.stderr).toContain(
        "terminal states must not define action, complete_when, or transitions"
      );
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("reports the compatibility graph when validating a Markdown WORKFLOW.md", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.exitOverride();
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
      "workflow",
      "validate",
      "--config",
      configPath,
      "--project",
      "symphonika"
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain(
      "workflow validate ok: symphonika -> single_agent_workflow"
    );
    expect(output.stdout).toContain(`source: ${path.join(root, "WORKFLOW.md")}`);
    expect(output.stdout).toContain("states: 2");
  });

  it("validates a template-backed workflow and prints the expanded graph", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const templateDir = path.join(root, ".symphonika", "workflow-templates");
    await mkdir(templateDir, { recursive: true });
    const templatePath = path.join(templateDir, "plan-tdd-pr.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      templatePath,
      [
        "name: plan_tdd_pr",
        "entry: planning",
        "exits:",
        "  success: pr_open",
        "states:",
        "  planning:",
        "    action:",
        "      kind: agent",
        "      provider: codex",
        "      prompt: prompts/plan.md",
        "    transitions:",
        "      - to: pr_open",
        "  pr_open:",
        "    exit: success",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: issue_to_merge",
        "  initial: build_pr",
        "  use:",
        "    build_pr:",
        "      template: .symphonika/workflow-templates/plan-tdd-pr.yml",
        "      exits:",
        "        success: done",
        "  states:",
        "    done:",
        "      terminal: success",
        ""
      ].join("\n")
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.exitOverride();
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
      "workflow",
      "validate",
      "--config",
      configPath,
      "--project",
      "symphonika"
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("workflow validate ok: symphonika -> issue_to_merge");
    expect(output.stdout).toContain(`template files: ${templatePath}`);
    expect(output.stdout).toContain("state: build_pr.planning");
    expect(output.stdout).not.toContain("state: pr_open");
  });

  it("explains the compatibility graph for a Markdown WORKFLOW.md", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "WORKFLOW.md"),
      "Work on {{issue.title}}.\n"
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.exitOverride();
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
      "workflow",
      "explain",
      "--config",
      configPath,
      "--project",
      "symphonika"
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("workflow: single_agent_workflow");
    expect(output.stdout).toContain(`source: ${path.join(root, "WORKFLOW.md")}`);
    expect(output.stdout).toContain("initial: run_agent");
    expect(output.stdout).toContain("state: run_agent");
    expect(output.stdout).toContain("state: done");
    expect(output.stdout).toContain("terminal: success");
  });

  it("validates a workflow backed by a built-in template and surfaces builtin: provenance", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: issue_to_pr",
        "  initial: shipit",
        "  use:",
        "    shipit:",
        "      template: builtin:single-agent-pr",
        "      with:",
        "        provider: codex",
        "        prompt: prompts/single-agent.md",
        "      exits:",
        "        success: done",
        "        blocked: failed",
        "  states:",
        "    done:",
        "      terminal: success",
        "    failed:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.exitOverride();
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
      "workflow",
      "validate",
      "--config",
      configPath,
      "--project",
      "symphonika"
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain(
      "workflow validate ok: symphonika -> issue_to_pr"
    );
    expect(output.stdout).toContain("template files: builtin:single-agent-pr");
    expect(output.stdout).toContain("state: shipit.agent");
  });

  it("explains a workflow that gates merge on the builtin:merge-when-green template", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: symphonika",
        "    workflow: ./workflow.yml",
        ""
      ].join("\n")
    );
    await writeFile(
      path.join(root, "workflow.yml"),
      [
        "workflow:",
        "  name: pr_merge",
        "  initial: gate",
        "  use:",
        "    gate:",
        "      template: builtin:merge-when-green",
        "      exits:",
        "        success: shipped",
        "        blocked: needs_human",
        "  states:",
        "    shipped:",
        "      terminal: success",
        "    needs_human:",
        "      terminal: blocked",
        ""
      ].join("\n")
    );
    const output = { stderr: "", stdout: "" };
    const program = buildCli({ registerSignalHandlers: false });
    program.exitOverride();
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
      "workflow",
      "explain",
      "--config",
      configPath,
      "--project",
      "symphonika"
    ]);

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("workflow: pr_merge");
    expect(output.stdout).toContain("template files: builtin:merge-when-green");
    expect(output.stdout).toContain("initial: gate.merging");
    expect(output.stdout).toContain("state: gate.merging");
  });
});
