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
import { VERSION } from "./version.js";

export type CliDependencies = {
  registerSignalHandlers?: boolean;
  runClearStale?: (options: ClearStaleOptions) => Promise<ClearStaleReport>;
  runDoctor?: (options: DoctorOptions) => Promise<DoctorReport>;
  runInitProject?: (options: InitProjectOptions) => Promise<InitProjectReport>;
  startDaemon?: (options: StartDaemonOptions) => Promise<DaemonHandle>;
};

export function buildCli(dependencies: CliDependencies = {}): Command {
  const doctor = dependencies.runDoctor ?? runDoctor;
  const initProject = dependencies.runInitProject ?? runInitProject;
  const clearStale = dependencies.runClearStale ?? runClearStale;
  const start = dependencies.startDaemon ?? startDaemon;
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

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await buildCli().parseAsync(argv);
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
