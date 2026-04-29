#!/usr/bin/env node
import { InvalidArgumentError, Command } from "commander";
import { pathToFileURL } from "node:url";

import type { DaemonHandle, StartDaemonOptions } from "./daemon.js";
import { startDaemon } from "./daemon.js";
import { VERSION } from "./version.js";

export type CliDependencies = {
  registerSignalHandlers?: boolean;
  startDaemon?: (options: StartDaemonOptions) => Promise<DaemonHandle>;
};

export function buildCli(dependencies: CliDependencies = {}): Command {
  const start = dependencies.startDaemon ?? startDaemon;
  const registerSignalHandlers = dependencies.registerSignalHandlers ?? true;
  const program = new Command();

  program
    .name("symphonika")
    .description("Local daemon for orchestrating coding-agent runs from GitHub issues")
    .version(VERSION);

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
