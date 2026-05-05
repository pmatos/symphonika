#!/usr/bin/env node
import { InvalidArgumentError, Command } from "commander";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DaemonHandle, StartDaemonOptions } from "./daemon.js";
import { startDaemon } from "./daemon.js";
import { daemonEndpointPath, readDaemonEndpoint } from "./daemon-endpoint.js";
import type {
  ClearStaleOptions,
  ClearStaleReport,
  DoctorProjectReport,
  DoctorOptions,
  DoctorReport,
  InitProjectOptions,
  InitProjectReport
} from "./doctor.js";
import { runClearStale, runDoctor, runInitProject } from "./doctor.js";
import type { ProjectIssuePollReport } from "./issue-polling.js";
import type {
  ListRunsFilter,
  OpenRunStoreOptions,
  ProjectState,
  RunState,
  RunStore
} from "./run-store.js";
import { openRunStore as openRunStoreReal } from "./run-store.js";
import type { SmokeOptions, SmokeReport } from "./smoke.js";
import { runSmoke } from "./smoke.js";
import {
  formatCapReachedReason,
  parseCapReachedReason
} from "./lifecycle/terminal-reason.js";
import { resolveStateRoot } from "./state.js";
import { VERSION } from "./version.js";

export type CliDependencies = {
  fetch?: FetchFn;
  openRunStore?: (options: OpenRunStoreOptions) => RunStore;
  registerSignalHandlers?: boolean;
  runClearStale?: (options: ClearStaleOptions) => Promise<ClearStaleReport>;
  runDoctor?: (options: DoctorOptions) => Promise<DoctorReport>;
  runInitProject?: (options: InitProjectOptions) => Promise<InitProjectReport>;
  runSmoke?: (options: SmokeOptions) => Promise<SmokeReport>;
  startDaemon?: (options: StartDaemonOptions) => Promise<DaemonHandle>;
};

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type DaemonStatusResponse = {
  candidateIssues?: unknown[];
  filteredIssues?: unknown[];
  issuePolling?: {
    errors?: string[];
    projects?: ProjectIssuePollReport[];
  };
  projectStates?: ProjectState[];
  staleIssues?: unknown[];
  state?: string;
  stateRoot?: string;
};

type PollNowResponse = {
  candidateIssues: number;
  dispatching: boolean;
  errors: number;
  filteredIssues: number;
  issuePolling: {
    errors: string[];
    projects: ProjectIssuePollReport[];
  };
  kind: "coalesced" | "queued";
  state: "dispatching" | "idle";
};

export function buildCli(dependencies: CliDependencies = {}): Command {
  const doctor = dependencies.runDoctor ?? runDoctor;
  const initProject = dependencies.runInitProject ?? runInitProject;
  const clearStale = dependencies.runClearStale ?? runClearStale;
  const smoke = dependencies.runSmoke ?? runSmoke;
  const start = dependencies.startDaemon ?? startDaemon;
  const openRunStore = dependencies.openRunStore ?? openRunStoreReal;
  const fetcher = dependencies.fetch ?? fetch;
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
        printStaleSection(program, report.projects);
        return;
      }

      writeErr(program, "doctor failed:\n");
      for (const error of report.errors) {
        writeErr(program, `- ${error}\n`);
      }
      printStaleSection(program, report.projects);
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
      "remove sym:stale, sym:claimed, and sym:running from a target issue after explicit confirmation"
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
        writeOut(program, `started:      ${detail.createdAt}\n`);
        writeOut(program, `updated:      ${detail.updatedAt}\n`);
        writeOut(program, `branch:       ${formatPath(detail.branchName)}\n`);
        writeOut(program, `workspace:    ${formatPath(detail.workspacePath)}\n`);
        writeOut(program, `prompt.md:                 ${formatEvidencePath(detail.promptPath)}\n`);
        writeOut(program, `provider.raw.jsonl:        ${formatEvidencePath(detail.rawLogPath)}\n`);
        writeOut(program, `provider.normalized.jsonl: ${formatEvidencePath(detail.normalizedLogPath)}\n`);
        writeOut(program, `issue-snapshot.json:       ${formatEvidencePath(detail.issueSnapshotPath)}\n`);
        writeOut(program, `prompt-metadata.json:      ${formatEvidencePath(detail.metadataPath)}\n`);
        if (detail.terminalReason !== null) {
          writeOut(program, `terminal:     ${detail.terminalReason}\n`);
        }
      }
    });

  program
    .command("status")
    .description("print project validation, issue polling, and run summaries")
    .option("--config <path>", "service config path", "symphonika.yml")
    .option("--daemon-url <url>", "local daemon base URL")
    .action(async (options: { config: string; daemonUrl?: string }) => {
      const stateRoot = resolveStateRoot({ configPath: options.config }).stateRoot;
      const store = openRunStore({ stateRoot });
      try {
        const report = await doctor({ configPath: options.config });
        const daemonUrl = resolveDaemonUrl(stateRoot, options.daemonUrl);
        const daemonStatus =
          daemonUrl === undefined
            ? ({ error: "not configured", kind: "unavailable" } as const)
            : await fetchDaemonStatus(fetcher, daemonUrl, stateRoot);
        const all = store.listRuns();
        const byState = new Map<string, number>();
        for (const run of all) {
          byState.set(run.state, (byState.get(run.state) ?? 0) + 1);
        }
        writeOut(program, `state root: ${stateRoot}\n`);
        if (daemonUrl !== undefined) {
          writeOut(
            program,
            `daemon: ${formatDaemonAvailability(daemonStatus, daemonUrl)}\n`
          );
        }
        writeOut(program, "\nProjects:\n");
        if (report.projects.length === 0) {
          writeOut(program, "  (no projects validated)\n");
        }
        for (const project of report.projects) {
          writeOut(
            program,
            `  ${project.name}: ${project.validForDispatch ? "valid" : "invalid"}\n`
          );
          writeOut(program, `    workflow: ${project.workflowPath}\n`);
          writeOut(
            program,
            `    missing operational labels: ${formatList(project.missingOperationalLabels)}\n`
          );
          const cursor = projectCursorFromStatus(daemonStatus, project.name);
          if (cursor !== undefined) {
            writeOut(program, `    ${formatProjectCursor(cursor)}\n`);
            writeOut(program, `    ${formatProjectLastPoll(cursor)}\n`);
            writeOut(program, `    ${formatProjectLastDispatch(cursor)}\n`);
          }
        }
        if (report.errors.length > 0) {
          writeOut(program, "validation errors:\n");
          for (const error of report.errors) {
            writeOut(program, `  - ${error}\n`);
          }
        }
        const issueCounts = issueCountsFromStatus(
          daemonStatus,
          report.projects,
          byState
        );
        writeOut(program, "\nIssue counts:\n");
        writeOut(program, `  candidate: ${issueCounts.candidate}\n`);
        writeOut(program, `  filtered:  ${issueCounts.filtered}\n`);
        writeOut(program, `  running:   ${issueCounts.running}\n`);
        writeOut(program, `  failed:    ${issueCounts.failed}\n`);
        writeOut(program, `  stale:     ${issueCounts.stale}\n`);
        writeOut(
          program,
          `last poll outcome: ${formatLastPollOutcome(daemonStatus)}\n`
        );
        writeOut(program, "\nRun state counts:\n");
        writeOut(program, `total runs: ${all.length}\n`);
        for (const [state, count] of [...byState.entries()].sort()) {
          writeOut(program, `${state}: ${count}\n`);
        }
        if (all.length > 0) {
          writeOut(program, "\nrecent runs:\n");
          for (const run of all.slice(0, 25)) {
            const suffix = formatRecentRunSuffix(run, store);
            writeOut(
              program,
              `  ${run.id}  ${run.project}  #${run.issueNumber}  ${run.state}  ${run.provider}${suffix}\n`
            );
          }
        }
        printStaleSection(program, report.projects);
      } finally {
        store.close();
      }
    });

  program
    .command("poll-now")
    .description("ask the running daemon to reconcile and poll immediately")
    .option("--config <path>", "service config path", "symphonika.yml")
    .option("--daemon-url <url>", "local daemon base URL")
    .action(async (options: { config: string; daemonUrl?: string }) => {
      const stateRoot = resolveStateRoot({ configPath: options.config }).stateRoot;
      const daemonUrl = resolveDaemonUrl(stateRoot, options.daemonUrl);
      if (daemonUrl === undefined) {
        const descriptorPath = daemonEndpointPath(stateRoot);
        writeErr(
          program,
          `poll-now failed: daemon endpoint not found at ${descriptorPath}\n`
        );
        program.error("poll-now failed: daemon endpoint not found", {
          exitCode: 1
        });
        return;
      }

      const daemonStatus = await fetchDaemonStatus(fetcher, daemonUrl, stateRoot);
      if (daemonStatus.kind === "unavailable") {
        writeErr(program, `poll-now failed: ${daemonStatus.error}\n`);
        program.error(`poll-now failed: ${daemonStatus.error}`, {
          exitCode: 1
        });
        return;
      }

      const outcome = await postPollNow(fetcher, daemonUrl);
      if (!outcome.ok) {
        writeErr(program, `poll-now failed: ${outcome.error}\n`);
        program.error(`poll-now failed: ${outcome.error}`, { exitCode: 1 });
        return;
      }

      printPollNowResult(program, outcome.response);
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
          writeOut(program, "id  project  issue  state  started  updated\n");
          for (const run of runs) {
            writeOut(
              program,
              `${run.id}  ${run.project}  #${run.issueNumber}  ${run.state}  ${run.createdAt}  ${run.updatedAt}\n`
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
        writeOut(program, `started:      ${detail.createdAt}\n`);
        writeOut(program, `updated:      ${detail.updatedAt}\n`);
        writeOut(program, `branch:       ${formatPath(detail.branchName)}\n`);
        writeOut(program, `workspace:    ${formatPath(detail.workspacePath)}\n`);
        writeOut(program, `prompt.md:                 ${formatEvidencePath(detail.promptPath)}\n`);
        writeOut(program, `provider.raw.jsonl:        ${formatEvidencePath(detail.rawLogPath)}\n`);
        writeOut(program, `provider.normalized.jsonl: ${formatEvidencePath(detail.normalizedLogPath)}\n`);
        writeOut(program, `issue-snapshot.json:       ${formatEvidencePath(detail.issueSnapshotPath)}\n`);
        writeOut(program, `prompt-metadata.json:      ${formatEvidencePath(detail.metadataPath)}\n`);
        writeOut(program, `retries:      ${detail.retryCount}${detail.isContinuation ? " (continuation)" : ""}\n`);
        if (detail.terminalReason !== null) {
          writeOut(program, `terminal:     ${detail.terminalReason}\n`);
          const capKind = parseCapReachedReason(detail.terminalReason);
          if (capKind !== null) {
            const count = store.countSucceededContinuations(
              detail.project,
              detail.issueNumber
            );
            writeOut(
              program,
              `cap context:  ${formatCapReachedReason(capKind, count)}\n`
            );
          }
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
        writeOut(program, `\nnormalized events (last ${events.length}):\n`);
        if (events.length === 0) {
          writeOut(program, "  (no events recorded)\n");
        }
        for (const event of events) {
          const message =
            typeof event.normalized.message === "string"
              ? event.normalized.message
              : JSON.stringify(event.normalized);
          writeOut(program, `  ${event.sequence}. ${event.type}  ${message}\n`);
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
    .option("--daemon-url <url>", "local daemon base URL")
    .action(async (id: string, options: { config: string; daemonUrl?: string }) => {
      const stateRoot = resolveStateRoot({ configPath: options.config }).stateRoot;
      const daemonUrl = resolveDaemonUrl(stateRoot, options.daemonUrl);
      if (daemonUrl === undefined) {
        const descriptorPath = daemonEndpointPath(stateRoot);
        writeErr(program, `cancel failed: daemon endpoint not found at ${descriptorPath}\n`);
        program.error("cancel failed: daemon endpoint not found", { exitCode: 1 });
        return;
      }

      const daemonStatus = await fetchDaemonStatus(fetcher, daemonUrl, stateRoot);
      if (daemonStatus.kind === "unavailable") {
        writeErr(program, `cancel failed: ${daemonStatus.error}\n`);
        program.error(`cancel failed: ${daemonStatus.error}`, { exitCode: 1 });
        return;
      }
      const outcome = await postCancel(fetcher, daemonUrl, id);
      if (outcome.kind === "cancelled") {
        writeOut(program, `cancelled ${id}\n`);
        return;
      }
      if (outcome.kind === "not-found") {
        writeErr(program, `run ${id} not found\n`);
        program.error(`run ${id} not found`, { exitCode: 1 });
        return;
      }
      if (outcome.kind === "already-terminal") {
        writeErr(program, `run ${id} already ${outcome.state}\n`);
        program.error(`run ${id} already ${outcome.state}`, { exitCode: 1 });
        return;
      }
      writeErr(program, `cancel failed: ${outcome.error}\n`);
      program.error(`cancel failed: ${outcome.error}`, { exitCode: 1 });
    });

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await buildCli().parseAsync(argv);
}

async function fetchDaemonStatus(
  fetcher: FetchFn,
  daemonUrl: string,
  expectedStateRoot: string
): Promise<
  | { kind: "available"; status: DaemonStatusResponse }
  | { kind: "unavailable"; error: string }
> {
  try {
    const response = await fetcher(`${daemonUrl}/api/status`);
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, kind: "unavailable" };
    }
    const status = (await response.json()) as DaemonStatusResponse;
    if (typeof status.stateRoot !== "string") {
      return {
        error: "daemon status did not report a state root",
        kind: "unavailable"
      };
    }
    if (path.resolve(status.stateRoot) !== path.resolve(expectedStateRoot)) {
      return {
        error: `state root mismatch (${status.stateRoot})`,
        kind: "unavailable"
      };
    }
    return { kind: "available", status };
  } catch (error) {
    return { error: errorMessage(error), kind: "unavailable" };
  }
}

function resolveDaemonUrl(
  stateRoot: string,
  explicitDaemonUrl: string | undefined
): string | undefined {
  if (explicitDaemonUrl !== undefined) {
    return trimTrailingSlash(explicitDaemonUrl);
  }

  const endpoint = readDaemonEndpoint(stateRoot);
  return endpoint === undefined ? undefined : trimTrailingSlash(endpoint.url);
}

async function postCancel(
  fetcher: FetchFn,
  daemonUrl: string,
  runId: string
): Promise<
  | { kind: "cancelled" }
  | { kind: "not-found" }
  | { kind: "already-terminal"; state: RunState }
  | { kind: "error"; error: string }
> {
  let response: Response;
  try {
    response = await fetcher(
      `${daemonUrl}/api/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" }
    );
  } catch (error) {
    return { error: errorMessage(error), kind: "error" };
  }

  if (response.status === 404) {
    return { kind: "not-found" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.status === 409) {
    const state = readRunState(body);
    return state === undefined
      ? { error: "daemon returned terminal conflict without a run state", kind: "error" }
      : { kind: "already-terminal", state };
  }
  if (!response.ok) {
    return { error: `daemon returned HTTP ${response.status}`, kind: "error" };
  }
  if (isObject(body) && body.kind === "cancelled") {
    return { kind: "cancelled" };
  }
  return {
    error: "daemon returned an unexpected cancellation response",
    kind: "error"
  };
}

async function postPollNow(
  fetcher: FetchFn,
  daemonUrl: string
): Promise<
  | { ok: false; error: string }
  | { ok: true; response: PollNowResponse }
> {
  let response: Response;
  try {
    response = await fetcher(`${daemonUrl}/api/poll-now`, { method: "POST" });
  } catch (error) {
    return { error: errorMessage(error), ok: false };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const error =
      isObject(body) && typeof body.error === "string"
        ? body.error
        : `daemon returned HTTP ${response.status}`;
    return { error, ok: false };
  }

  const parsed = readPollNowResponse(body);
  if (parsed === undefined) {
    return {
      error: "daemon returned an unexpected poll-now response",
      ok: false
    };
  }
  return { ok: true, response: parsed };
}

function readPollNowResponse(value: unknown): PollNowResponse | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind !== "queued" && kind !== "coalesced") {
    return undefined;
  }
  const candidateIssues = readNonnegativeNumber(value.candidateIssues);
  const filteredIssues = readNonnegativeNumber(value.filteredIssues);
  const errors = readNonnegativeNumber(value.errors);
  if (
    candidateIssues === undefined ||
    filteredIssues === undefined ||
    errors === undefined
  ) {
    return undefined;
  }
  const dispatching =
    typeof value.dispatching === "boolean" ? value.dispatching : false;
  const state =
    value.state === "dispatching" || dispatching ? "dispatching" : "idle";

  return {
    candidateIssues,
    dispatching,
    errors,
    filteredIssues,
    issuePolling: readPollNowIssuePolling(value.issuePolling),
    kind,
    state
  };
}

function readPollNowIssuePolling(value: unknown): PollNowResponse["issuePolling"] {
  if (!isObject(value)) {
    return { errors: [], projects: [] };
  }
  return {
    errors: Array.isArray(value.errors)
      ? value.errors.filter((error): error is string => typeof error === "string")
      : [],
    projects: readPollNowProjects(value.projects)
  };
}

function readPollNowProjects(value: unknown): ProjectIssuePollReport[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const projects: ProjectIssuePollReport[] = [];
  for (const entry of value) {
    if (
      !isObject(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.ok !== "boolean"
    ) {
      continue;
    }
    const fetchedIssues = readNonnegativeNumber(entry.fetchedIssues);
    if (fetchedIssues === undefined) {
      continue;
    }
    const project: ProjectIssuePollReport = {
      fetchedIssues,
      name: entry.name,
      ok: entry.ok
    };
    const candidateIssues = readNonnegativeNumber(entry.candidateIssues);
    if (candidateIssues !== undefined) {
      project.candidateIssues = candidateIssues;
    }
    const filteredIssues = readNonnegativeNumber(entry.filteredIssues);
    if (filteredIssues !== undefined) {
      project.filteredIssues = filteredIssues;
    }
    const weight = readNonnegativeNumber(entry.weight);
    if (weight !== undefined) {
      project.weight = weight;
    }
    if (typeof entry.lastPolledAt === "string") {
      project.lastPolledAt = entry.lastPolledAt;
    }
    if (typeof entry.error === "string") {
      project.error = entry.error;
    }
    projects.push(project);
  }
  return projects;
}

function readNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readRunState(value: unknown): RunState | undefined {
  if (!isObject(value) || typeof value.state !== "string") {
    return undefined;
  }
  return isRunState(value.state) ? value.state : undefined;
}

function isRunState(value: string): value is RunState {
  return (
    value === "queued" ||
    value === "preparing_workspace" ||
    value === "running" ||
    value === "input_required" ||
    value === "failed" ||
    value === "succeeded" ||
    value === "cancelled" ||
    value === "stale"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function issueCountsFromStatus(
  daemonStatus:
    | { kind: "available"; status: DaemonStatusResponse }
    | { kind: "unavailable"; error: string },
  projects: DoctorProjectReport[],
  byState: Map<string, number>
): {
  candidate: number;
  failed: number;
  filtered: number;
  running: number;
  stale: number;
} {
  if (daemonStatus.kind === "available") {
    const filteredIssues = daemonStatus.status.filteredIssues;
    return {
      candidate: arrayLength(daemonStatus.status.candidateIssues),
      failed: Math.max(
        countIssuesWithLabel(filteredIssues, "sym:failed"),
        (byState.get("failed") ?? 0) + (byState.get("input_required") ?? 0)
      ),
      filtered: arrayLength(filteredIssues),
      running: Math.max(
        countIssuesWithLabel(filteredIssues, "sym:running"),
        byState.get("running") ?? 0
      ),
      stale: Math.max(
        projects.reduce((count, project) => count + project.staleIssues.length, 0),
        countIssuesWithLabel(filteredIssues, "sym:stale"),
        arrayLength(daemonStatus.status.staleIssues),
        byState.get("stale") ?? 0
      )
    };
  }

  return {
    candidate: 0,
    failed: (byState.get("failed") ?? 0) + (byState.get("input_required") ?? 0),
    filtered: 0,
    running: byState.get("running") ?? 0,
    stale: Math.max(
      projects.reduce((count, project) => count + project.staleIssues.length, 0),
      byState.get("stale") ?? 0
    )
  };
}

function countIssuesWithLabel(
  entries: unknown[] | undefined,
  label: string
): number {
  if (!Array.isArray(entries)) {
    return 0;
  }
  const seen = new Set<string>();
  let anonymous = 0;
  for (const entry of entries) {
    const labels = labelsFromPollEntry(entry);
    if (!labels.has(label)) {
      continue;
    }
    const key = pollEntryKey(entry);
    if (key === undefined) {
      anonymous += 1;
      continue;
    }
    seen.add(key);
  }
  return seen.size + anonymous;
}

function labelsFromPollEntry(entry: unknown): Set<string> {
  if (!isObject(entry) || !isObject(entry.issue)) {
    return new Set();
  }
  const labels = entry.issue.labels;
  if (!Array.isArray(labels)) {
    return new Set();
  }
  return new Set(labels.filter((label): label is string => typeof label === "string"));
}

function pollEntryKey(entry: unknown): string | undefined {
  if (!isObject(entry) || !isObject(entry.issue)) {
    return undefined;
  }
  const project = typeof entry.project === "string" ? entry.project : "unknown";
  const number = entry.issue.number;
  if (typeof number === "number" || typeof number === "string") {
    return `${project}:number:${number}`;
  }
  return undefined;
}

function arrayLength(value: unknown[] | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

function formatDaemonAvailability(
  daemonStatus:
    | { kind: "available"; status: DaemonStatusResponse }
    | { kind: "unavailable"; error: string },
  daemonUrl: string
): string {
  if (daemonStatus.kind === "available") {
    return `${daemonStatus.status.state ?? "unknown"} at ${daemonUrl}`;
  }
  return `unavailable at ${daemonUrl} (${daemonStatus.error})`;
}

function formatLastPollOutcome(
  daemonStatus:
    | { kind: "available"; status: DaemonStatusResponse }
    | { kind: "unavailable"; error: string }
): string {
  if (daemonStatus.kind === "unavailable") {
    return `unknown (${daemonStatus.error})`;
  }
  const issuePolling = daemonStatus.status.issuePolling;
  if (issuePolling === undefined) {
    return "unknown";
  }
  const errors = issuePolling.errors ?? [];
  if (errors.length > 0) {
    return `failed: ${errors.join("; ")}`;
  }
  const projects = issuePolling.projects ?? [];
  if (projects.length === 0) {
    return "not yet polled";
  }
  return projects
    .map((project) =>
      project.ok
        ? `${project.name} ok (${project.fetchedIssues} fetched)`
        : `${project.name} failed (${project.error ?? "unknown error"})`
    )
    .join("; ");
}

function printPollNowResult(program: Command, result: PollNowResponse): void {
  writeOut(program, `poll-now ${result.kind}\n`);
  writeOut(program, `state:     ${result.state}\n`);
  writeOut(program, `candidate: ${result.candidateIssues}\n`);
  writeOut(program, `filtered:  ${result.filteredIssues}\n`);
  writeOut(program, `errors:    ${result.errors}\n`);
  if (result.issuePolling.projects.length > 0) {
    writeOut(program, "projects:\n");
    for (const project of result.issuePolling.projects) {
      writeOut(program, `  ${formatPollNowProject(project)}\n`);
    }
  }
  if (result.issuePolling.errors.length > 0) {
    writeOut(program, "poll errors:\n");
    for (const error of result.issuePolling.errors) {
      writeOut(program, `  - ${error}\n`);
    }
  }
}

function formatPollNowProject(project: ProjectIssuePollReport): string {
  if (!project.ok) {
    return `${project.name} failed (${project.error ?? "unknown error"})`;
  }
  return [
    `${project.name} ok`,
    `(${project.fetchedIssues} fetched,`,
    `${project.candidateIssues ?? 0} candidate,`,
    `${project.filteredIssues ?? 0} filtered)`
  ].join(" ");
}

function projectCursorFromStatus(
  daemonStatus:
    | { kind: "available"; status: DaemonStatusResponse }
    | { kind: "unavailable"; error: string },
  projectName: string
): ProjectState | undefined {
  if (daemonStatus.kind === "unavailable") {
    return undefined;
  }
  return daemonStatus.status.projectStates?.find(
    (state) => state.projectName === projectName
  );
}

function formatProjectCursor(state: ProjectState): string {
  return [
    `cursor: weight ${state.weight}`,
    `validation ${state.validationState}`,
    `current weight ${state.schedulerCurrentWeight}`
  ].join(", ");
}

function formatProjectLastPoll(state: ProjectState): string {
  const outcome =
    state.lastPollOk === null ? "unknown" : state.lastPollOk ? "ok" : "failed";
  return [
    `last poll: ${outcome} at ${state.lastPollFinishedAt ?? "never"}`,
    `(${state.lastFetchedIssues} fetched, ${state.lastCandidateIssues} candidate, ${state.lastFilteredIssues} filtered)`
  ].join(" ");
}

function formatProjectLastDispatch(state: ProjectState): string {
  if (
    state.lastDispatchedAt === null ||
    state.lastDispatchedIssueNumber === null
  ) {
    return "last dispatch: never";
  }
  return `last dispatch: #${state.lastDispatchedIssueNumber} at ${state.lastDispatchedAt}`;
}

function formatList(values: string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function formatEvidencePath(value: string): string {
  return formatPath(value);
}

function formatRecentRunSuffix(
  run: { issueNumber: number; project: string; state: RunState; terminalReason: string | null },
  store: RunStore
): string {
  if (run.terminalReason === null || run.state !== "failed") {
    return "";
  }
  const capKind = parseCapReachedReason(run.terminalReason);
  if (capKind === null) {
    return `  — ${run.terminalReason}`;
  }
  const count = store.countSucceededContinuations(run.project, run.issueNumber);
  return `  — ${formatCapReachedReason(capKind, count)}`;
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

function printStaleSection(
  program: Command,
  projects: DoctorProjectReport[]
): void {
  for (const project of projects) {
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
