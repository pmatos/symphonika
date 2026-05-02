#!/usr/bin/env node
import { InvalidArgumentError, Command } from "commander";
import { pathToFileURL } from "node:url";

import type { DaemonHandle, StartDaemonOptions } from "./daemon.js";
import { startDaemon } from "./daemon.js";
import type {
  ClearStaleOptions,
  ClearStaleReport,
  DoctorOptions,
  DoctorReport,
  InitProjectOptions,
  InitProjectReport
} from "./doctor.js";
import { runClearStale, runDoctor, runInitProject } from "./doctor.js";
import type {
  ListRunsFilter,
  OpenRunStoreOptions,
  RunState,
  RunStore
} from "./run-store.js";
import { openRunStore as openRunStoreReal } from "./run-store.js";
import type { SmokeOptions, SmokeReport } from "./smoke.js";
import { runSmoke } from "./smoke.js";
import { resolveStateRoot } from "./state.js";
import { VERSION } from "./version.js";

export type CliDependencies = {
  openRunStore?: (options: OpenRunStoreOptions) => RunStore;
  registerSignalHandlers?: boolean;
  runClearStale?: (options: ClearStaleOptions) => Promise<ClearStaleReport>;
  runDoctor?: (options: DoctorOptions) => Promise<DoctorReport>;
  runInitProject?: (options: InitProjectOptions) => Promise<InitProjectReport>;
  runSmoke?: (options: SmokeOptions) => Promise<SmokeReport>;
  startDaemon?: (options: StartDaemonOptions) => Promise<DaemonHandle>;
};

export function buildCli(dependencies: CliDependencies = {}): Command {
  const doctor = dependencies.runDoctor ?? runDoctor;
  const initProject = dependencies.runInitProject ?? runInitProject;
  const clearStale = dependencies.runClearStale ?? runClearStale;
  const smoke = dependencies.runSmoke ?? runSmoke;
  const start = dependencies.startDaemon ?? startDaemon;
  const openRunStore = dependencies.openRunStore ?? openRunStoreReal;
  const registerSignalHandlers = dependencies.registerSignalHandlers ?? true;
  const program = new Command();

  program
    .name("symphonika")
    .description("Local daemon for orchestrating coding-agent runs from GitHub issues")
    .version(VERSION);

  program
    .command("doctor")
    .description("validate service config and workflow contracts without dispatching work")
    .option("--config <path>", "service config path", "symphonika.yml")
    .action(async (options: { config: string }) => {
      const report = await doctor({ configPath: options.config });

      const printStaleSection = (): void => {
        for (const project of report.projects) {
          if (project.staleIssues.length === 0) {
            continue;
          }
          writeOut(
            program,
            `- project: ${project.name} — stale issues: ${project.staleIssues.length}\n`
          );
          for (const issue of project.staleIssues) {
            writeOut(program, `    • #${issue.number}  ${issue.title} (${issue.url})\n`);
          }
        }
      };

      if (report.ok) {
        writeOut(
          program,
          `doctor ok: ${report.projects.length} ${pluralize("project", report.projects.length)} valid\n`
        );
        printStaleSection();
        return;
      }

      writeErr(program, "doctor failed:\n");
      for (const error of report.errors) {
        writeErr(program, `- ${error}\n`);
      }
      printStaleSection();
      process.exitCode = 1;
    });

  program
    .command("init-project")
    .description("create missing GitHub operational labels after explicit confirmation")
    .option("--config <path>", "service config path", "symphonika.yml")
    .option("--yes", "create missing operational labels without an interactive prompt")
    .action(async (options: { config: string; yes?: boolean }) => {
      const emittedWarnings = new Set<string>();
      const report = await initProject({
        configPath: options.config,
        onWarning: (warning) => {
          emittedWarnings.add(warning);
          writeErr(program, `warning: ${warning}\n`);
        },
        yes: options.yes === true
      });

      for (const warning of report.warnings) {
        if (emittedWarnings.has(warning)) {
          continue;
        }
        writeErr(program, `warning: ${warning}\n`);
      }

      if (!report.ok) {
        writeErr(program, "init-project failed:\n");
        for (const error of report.errors) {
          writeErr(program, `- ${error}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const createdLabels = report.projects.flatMap((project) =>
        project.createdOperationalLabels.map((label) => ({
          label,
          repository: project.repository
        }))
      );

      writeOut(
        program,
        `init-project ok: created ${createdLabels.length} ${pluralize("label", createdLabels.length)}\n`
      );
      for (const created of createdLabels) {
        writeOut(program, `- ${created.label} in ${created.repository}\n`);
      }
    });

  program
    .command("clear-stale")
    .description(
      "remove sym:stale and sym:claimed from a target issue after explicit confirmation"
    )
    .argument("<project>", "project name from symphonika.yml")
    .argument("<issue-number>", "GitHub issue number", parseIssueNumber)
    .option("--config <path>", "service config path", "symphonika.yml")
    .option("--yes", "remove labels without an interactive prompt")
    .action(
      async (
        project: string,
        issueNumber: number,
        options: { config: string; yes?: boolean }
      ) => {
        const emittedWarnings = new Set<string>();
        const report = await clearStale({
          configPath: options.config,
          issueNumber,
          onWarning: (warning) => {
            emittedWarnings.add(warning);
            writeErr(program, `warning: ${warning}\n`);
          },
          project,
          yes: options.yes === true
        });

        for (const warning of report.warnings) {
          if (emittedWarnings.has(warning)) {
            continue;
          }
          writeErr(program, `warning: ${warning}\n`);
        }

        if (!report.ok) {
          writeErr(program, "clear-stale failed:\n");
          for (const error of report.errors) {
            writeErr(program, `- ${error}\n`);
          }
          process.exitCode = 1;
          return;
        }

        writeOut(
          program,
          `clear-stale ok: removed ${report.removedLabels.length} ${pluralize("label", report.removedLabels.length)} from ${report.repository}#${report.issueNumber}\n`
        );
        for (const label of report.removedLabels) {
          writeOut(program, `- ${label}\n`);
        }
      }
    );

  program
    .command("daemon")
    .description("start the local Symphonika daemon without dispatching work")
    .option("--config <path>", "service config path", "symphonika.yml")
    .option("--port <port>", "local HTTP port", parsePort, 3000)
    .action(async (options: { config: string; port: number }) => {
      const daemon = await start({
        configPath: options.config,
        port: options.port
      });

      if (registerSignalHandlers) {
        registerShutdownHandlers(daemon);
      }
    });

  program
    .command("smoke")
    .description(
      "claim and run one agent-ready issue once via the configured provider, then exit"
    )
    .option("--config <path>", "service config path", "symphonika.yml")
    .action(async (options: { config: string }) => {
      const report = await smoke({ configPath: options.config });

      for (const warning of report.warnings) {
        writeErr(program, `warning: ${warning}\n`);
      }

      if (!report.ok) {
        writeErr(program, "smoke failed:\n");
        for (const error of report.errors) {
          writeErr(program, `- ${error}\n`);
        }
        process.exitCode = 1;
        return;
      }

      if (!report.dispatched) {
        writeOut(
          program,
          `smoke skipped: ${report.skipReason ?? "no eligible issues to dispatch"}\n`
        );
        return;
      }

      const detail = report.runDetail;
      writeOut(program, `smoke ok: dispatched ${report.runId ?? ""}\n`);
      if (detail !== undefined) {
        writeOut(program, `project:      ${detail.project}\n`);
        writeOut(program, `issue:        #${detail.issueNumber} ${detail.issueTitle}\n`);
        writeOut(program, `state:        ${detail.state}\n`);
        writeOut(program, `provider:     ${detail.provider}\n`);
        writeOut(program, `branch:       ${formatPath(detail.branchName)}\n`);
        writeOut(program, `workspace:    ${formatPath(detail.workspacePath)}\n`);
        writeOut(program, `prompt:       ${formatPath(detail.promptPath)}\n`);
        writeOut(program, `raw log:      ${formatPath(detail.rawLogPath)}\n`);
        writeOut(program, `normalized:   ${formatPath(detail.normalizedLogPath)}\n`);
        writeOut(program, `metadata:     ${formatPath(detail.metadataPath)}\n`);
        writeOut(program, `issue snap:   ${formatPath(detail.issueSnapshotPath)}\n`);
        if (detail.terminalReason !== null) {
          writeOut(program, `terminal:     ${detail.terminalReason}\n`);
        }
      }
    });

  program
    .command("status")
    .description("print run store summary grouped by lifecycle state")
    .option("--config <path>", "service config path", "symphonika.yml")
    .action((options: { config: string }) => {
      const stateRoot = resolveStateRoot({ configPath: options.config }).stateRoot;
      const store = openRunStore({ stateRoot });
      try {
        const all = store.listRuns();
        const byState = new Map<string, number>();
        for (const run of all) {
          byState.set(run.state, (byState.get(run.state) ?? 0) + 1);
        }
        writeOut(program, `state root: ${stateRoot}\n`);
        writeOut(program, `total runs: ${all.length}\n`);
        for (const [state, count] of [...byState.entries()].sort()) {
          writeOut(program, `${state}: ${count}\n`);
        }
        if (all.length > 0) {
          writeOut(program, "\nrecent runs:\n");
          for (const run of all.slice(0, 25)) {
            writeOut(
              program,
              `  ${run.id}  ${run.project}  #${run.issueNumber}  ${run.state}  ${run.provider}\n`
            );
          }
        }
      } finally {
        store.close();
      }
    });

  program
    .command("runs")
    .description("list runs from the run store")
    .option("--config <path>", "service config path", "symphonika.yml")
    .option("--state <state>", "filter by run state")
    .option("--project <project>", "filter by project name")
    .option("--limit <n>", "max rows", parsePositiveInt)
    .action(
      (options: {
        config: string;
        limit?: number;
        project?: string;
        state?: string;
      }) => {
        const stateRoot = resolveStateRoot({ configPath: options.config }).stateRoot;
        const store = openRunStore({ stateRoot });
        try {
          const filter: ListRunsFilter = {};
          if (options.state !== undefined) {
            filter.state = options.state as RunState;
          }
          if (options.project !== undefined) {
            filter.project = options.project;
          }
          if (options.limit !== undefined) {
            filter.limit = options.limit;
          }
          const runs = store.listRuns(filter);
          if (runs.length === 0) {
            writeOut(program, "(no runs)\n");
            return;
          }
          for (const run of runs) {
            writeOut(
              program,
              `${run.id}  ${run.project}  #${run.issueNumber}  ${run.state}  ${run.provider}\n`
            );
          }
        } finally {
          store.close();
        }
      }
    );

  program
    .command("show-run")
    .description("show run detail, attempts, transitions, and recent events")
    .argument("<id>", "run id")
    .option("--config <path>", "service config path", "symphonika.yml")
    .option("--events <n>", "max recent events", parsePositiveInt, 25)
    .action((id: string, options: { config: string; events: number }) => {
      const stateRoot = resolveStateRoot({ configPath: options.config }).stateRoot;
      const store = openRunStore({ stateRoot });
      try {
        const detail = store.getRun(id);
        if (detail === undefined) {
          writeErr(program, `run ${id} not found\n`);
          program.error(`run ${id} not found`, { exitCode: 1 });
          return;
        }
        writeOut(program, `id:           ${detail.id}\n`);
        writeOut(program, `project:      ${detail.project}\n`);
        writeOut(program, `issue:        #${detail.issueNumber} ${detail.issueTitle}\n`);
        writeOut(program, `state:        ${detail.state}\n`);
        writeOut(program, `provider:     ${detail.provider}\n`);
        writeOut(program, `branch:       ${formatPath(detail.branchName)}\n`);
        writeOut(program, `workspace:    ${formatPath(detail.workspacePath)}\n`);
        writeOut(program, `prompt:       ${formatPath(detail.promptPath)}\n`);
        writeOut(program, `raw log:      ${formatPath(detail.rawLogPath)}\n`);
        writeOut(program, `normalized:   ${formatPath(detail.normalizedLogPath)}\n`);
        writeOut(program, `metadata:     ${formatPath(detail.metadataPath)}\n`);
        writeOut(program, `issue snap:   ${formatPath(detail.issueSnapshotPath)}\n`);
        writeOut(program, `retries:      ${detail.retryCount}${detail.isContinuation ? " (continuation)" : ""}\n`);
        if (detail.terminalReason !== null) {
          writeOut(program, `terminal:     ${detail.terminalReason}\n`);
        }
        if (detail.cancelRequested) {
          writeOut(
            program,
            `cancel:       requested (reason ${detail.cancelReason ?? "unknown"})\n`
          );
        }
        if (detail.attempts.length > 0) {
          writeOut(program, "\nattempts:\n");
          for (const attempt of detail.attempts) {
            writeOut(
              program,
              `  ${attempt.attemptNumber}. ${attempt.id}  ${attempt.state}  ${attempt.providerName}\n`
            );
          }
        }
        if (detail.transitions.length > 0) {
          writeOut(program, "\ntransitions:\n");
          for (const transition of detail.transitions) {
            writeOut(
              program,
              `  ${transition.sequence}. ${transition.state}  ${transition.createdAt}\n`
            );
          }
        }
        const events = store.listProviderEvents(id, { limit: options.events });
        if (events.length > 0) {
          writeOut(program, `\nrecent events (last ${events.length}):\n`);
          for (const event of events) {
            const message =
              typeof event.normalized.message === "string"
                ? event.normalized.message
                : JSON.stringify(event.normalized);
            writeOut(
              program,
              `  ${event.sequence}. ${event.type}  ${message}\n`
            );
          }
        }
      } finally {
        store.close();
      }
    });

  program
    .command("cancel")
    .description("request cancellation of an active run via the run store")
    .argument("<id>", "run id")
    .option("--config <path>", "service config path", "symphonika.yml")
    .action((id: string, options: { config: string }) => {
      const stateRoot = resolveStateRoot({ configPath: options.config }).stateRoot;
      const store = openRunStore({ stateRoot });
      try {
        const detail = store.getRun(id);
        if (detail === undefined) {
          writeErr(program, `run ${id} not found\n`);
          program.error(`run ${id} not found`, { exitCode: 1 });
          return;
        }
        if (
          detail.state === "cancelled" ||
          detail.state === "failed" ||
          detail.state === "stale" ||
          detail.state === "succeeded"
        ) {
          writeErr(program, `run ${id} already ${detail.state}\n`);
          program.error(`run ${id} already ${detail.state}`, { exitCode: 1 });
          return;
        }
        store.markCancelRequested(id, "operator");
        writeOut(program, `cancel requested for ${id}\n`);
        writeOut(
          program,
          "the running daemon will pick up the request on its next iteration; if no daemon is running, the request will be honored on next startup.\n"
        );
      } finally {
        store.close();
      }
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await buildCli().parseAsync(argv);
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
}

function formatPath(value: string): string {
  return value.length === 0 ? "<not yet recorded>" : value;
}

function parsePort(value: string): number {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError("port must be an integer from 1 to 65535");
  }

  return port;
}

function parseIssueNumber(value: string): number {
  const issue = Number(value);

  if (!Number.isInteger(issue) || issue < 1) {
    throw new InvalidArgumentError("issue number must be a positive integer");
  }

  return issue;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function writeOut(program: Command, message: string): void {
  const output = program.configureOutput();
  if (output.writeOut !== undefined) {
    output.writeOut(message);
    return;
  }

  process.stdout.write(message);
}

function writeErr(program: Command, message: string): void {
  const output = program.configureOutput();
  if (output.writeErr !== undefined) {
    output.writeErr(message);
    return;
  }

  process.stderr.write(message);
}

function registerShutdownHandlers(daemon: DaemonHandle): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    void daemon.stop().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
