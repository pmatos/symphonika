#!/usr/bin/env node
import { InvalidArgumentError, Command } from "commander";
import { pathToFileURL } from "node:url";

import type { DaemonHandle, StartDaemonOptions } from "./daemon.js";
import { startDaemon } from "./daemon.js";
import type { DoctorOptions, DoctorReport } from "./doctor.js";
import { runDoctor } from "./doctor.js";
import { VERSION } from "./version.js";

export type CliDependencies = {
  registerSignalHandlers?: boolean;
  runDoctor?: (options: DoctorOptions) => Promise<DoctorReport>;
  startDaemon?: (options: StartDaemonOptions) => Promise<DaemonHandle>;
};

export function buildCli(dependencies: CliDependencies = {}): Command {
  const doctor = dependencies.runDoctor ?? runDoctor;
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

      if (report.ok) {
        writeOut(
          program,
          `doctor ok: ${report.projects.length} ${pluralize("project", report.projects.length)} valid\n`
        );
        return;
      }

      writeErr(program, "doctor failed:\n");
      for (const error of report.errors) {
        writeErr(program, `- ${error}\n`);
      }
      process.exitCode = 1;
    });

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
