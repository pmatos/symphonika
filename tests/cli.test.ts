import { describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import type { StartDaemonOptions } from "../src/daemon.js";
import type {
  ClearStaleOptions,
  ClearStaleReport,
  InitProjectOptions
} from "../src/doctor.js";
import type { SmokeOptions, SmokeReport } from "../src/smoke.js";

describe("CLI", () => {
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
          removedLabels: ["sym:stale", "sym:claimed"],
          repository: "pmatos/symphonika",
          warnings: [
            "clear-stale will remove sym:stale, sym:claimed from pmatos/symphonika#42"
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
      configPath: "symphonika.yml",
      issueNumber: 42,
      project: "symphonika",
      yes: true
    });
    expect(output.stdout).toContain("clear-stale ok");
    expect(output.stdout).toContain("sym:stale");
    expect(output.stdout).toContain("sym:claimed");
    expect(output.stdout).not.toContain("sym:running");
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
            "clear-stale would remove sym:stale, sym:claimed from pmatos/symphonika#7"
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
});
