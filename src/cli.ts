#!/usr/bin/env node
import { InvalidArgumentError, Command } from "commander";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { DaemonHandle, StartDaemonOptions } from "./daemon.js";
import { startDaemon } from "./daemon.js";
import { resolveServiceConfigPath } from "./config-paths.js";
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
import type { InitOptions, InitProvider, InitReport } from "./init.js";
import { runInit } from "./init.js";
import type { ProjectIssuePollReport } from "./issue-polling.js";
import { RuntimeConfigReloader, type RuntimeReloadStatus } from "./reload.js";
import type {
  ListRunsFilter,
  OpenRunStoreOptions,
  RunDetail,
  ProjectState,
  RunArtifactDescriptor,
  RunState,
  RunStatus,
  RunStore
} from "./run-store.js";
import { openRunStore as openRunStoreReal } from "./run-store.js";
import type { ServiceInstallOptions, ServiceInstallReport } from "./service.js";
import { runServiceInstall as runServiceInstallReal } from "./service.js";
import type { SmokeOptions, SmokeReport } from "./smoke.js";
import { runSmoke } from "./smoke.js";
import {
  formatCapReachedReason,
  parseCapReachedReason
} from "./lifecycle/terminal-reason.js";
import { resolveStateRoot } from "./state.js";
import {
  renderStatusDashboardRedrawFrame,
  renderStatusDashboard,
  summarizeDashboardEvent,
  type DashboardEventSummary
} from "./status-dashboard.js";
import { VERSION } from "./version.js";
import {
  explainWorkflow,
  loadProjectWorkflow,
  type ExpandedWorkflow
} from "./workflow.js";
import {
  planWorkspacePaths,
  type WorkspacePathPlan
} from "./workspace-paths.js";

export type CliDependencies = {
  fetch?: FetchFn;
  openRunStore?: (options: OpenRunStoreOptions) => RunStore;
  registerSignalHandlers?: boolean;
  runClearStale?: (options: ClearStaleOptions) => Promise<ClearStaleReport>;
  runDoctor?: (options: DoctorOptions) => Promise<DoctorReport>;
  runInit?: (options: InitOptions) => Promise<InitReport>;
  runInitProject?: (options: InitProjectOptions) => Promise<InitProjectReport>;
  runServiceInstall?: (
    options: ServiceInstallOptions
  ) => Promise<ServiceInstallReport>;
  runSmoke?: (options: SmokeOptions) => Promise<SmokeReport>;
  startDaemon?: (options: StartDaemonOptions) => Promise<DaemonHandle>;
};

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type DaemonStatusResponse = {
  candidateIssues?: unknown[];
  filteredIssues?: unknown[];
  issuePolling?: {
    errors?: string[];
    projects?: ProjectIssuePollReport[];
  };
  projectStates?: ProjectState[];
  reload?: RuntimeReloadStatus;
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

const DEFAULT_STATUS_WATCH_DOCTOR_TTL_MS = 5000;

export function buildCli(dependencies: CliDependencies = {}): Command {
  const doctor = dependencies.runDoctor ?? runDoctor;
  const init = dependencies.runInit ?? runInit;
  const initProject = dependencies.runInitProject ?? runInitProject;
  const clearStale = dependencies.runClearStale ?? runClearStale;
  const serviceInstall =
    dependencies.runServiceInstall ?? runServiceInstallReal;
  const smoke = dependencies.runSmoke ?? runSmoke;
  const start = dependencies.startDaemon ?? startDaemon;
  const openRunStore = dependencies.openRunStore ?? openRunStoreReal;
  const fetcher = dependencies.fetch ?? fetch;
  const registerSignalHandlers = dependencies.registerSignalHandlers ?? true;
  const program = new Command();

  program
    .name("symphonika")
    .description(
      "Local daemon for orchestrating coding-agent runs from GitHub issues"
    )
    .version(VERSION);

  program
    .command("doctor")
    .description(
      "validate service config and workflow contracts without dispatching work"
    )
    .option("--config <path>", "service config path")
    .action(async (options: { config?: string }) => {
      const report = await doctor(withConfigPath(options.config));

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
    .command("init")
    .description(
      "create a user service config for the current GitHub repository"
    )
    .option(
      "--provider <name>",
      "agent provider for the project",
      parseProvider,
      "codex"
    )
    .option("--force", "overwrite an existing user service config")
    .action(async (options: { force?: boolean; provider: InitProvider }) => {
      const report = await init({
        force: options.force === true,
        provider: options.provider
      });

      if (!report.ok) {
        writeErr(program, "init failed:\n");
        for (const error of report.errors) {
          writeErr(program, `- ${error}\n`);
        }
        process.exitCode = 1;
        return;
      }

      writeOut(program, "init ok\n");
      writeOut(program, `config:    ${report.configPath}\n`);
      writeOut(program, `state:     ${report.stateRoot}\n`);
      if (report.repository !== null) {
        writeOut(program, `repo:      ${report.repository}\n`);
      }
      if (report.projectName !== null) {
        writeOut(program, `project:   ${report.projectName}\n`);
      }
      if (report.workflowPath !== null) {
        const workflowLabel = report.createdWorkflow
          ? "workflow:"
          : "workflow:  existing";
        writeOut(program, `${workflowLabel} ${report.workflowPath}\n`);
      }
      writeOut(
        program,
        "next:      export GITHUB_TOKEN=... && symphonika doctor\n"
      );
      writeOut(program, "then:      symphonika init-project --yes\n");
    });

  program
    .command("init-project")
    .description(
      "create missing GitHub operational labels after explicit confirmation"
    )
    .option("--config <path>", "service config path")
    .option(
      "--yes",
      "create missing operational labels without an interactive prompt"
    )
    .action(async (options: { config?: string; yes?: boolean }) => {
      const emittedWarnings = new Set<string>();
      const report = await initProject({
        ...withConfigPath(options.config),
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
    .option("--config <path>", "service config path")
    .option("--yes", "remove labels without an interactive prompt")
    .action(
      async (
        project: string,
        issueNumber: number,
        options: { config?: string; yes?: boolean }
      ) => {
        const emittedWarnings = new Set<string>();
        const report = await clearStale({
          ...withConfigPath(options.config),
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
    .option("--config <path>", "service config path")
    .option("--port <port>", "local HTTP port", parsePort, 3000)
    .action(async (options: { config?: string; port: number }) => {
      const daemon = await start({
        ...withConfigPath(options.config),
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
    .option("--config <path>", "service config path")
    .action(async (options: { config?: string }) => {
      const report = await smoke(withConfigPath(options.config));

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
        writeOut(
          program,
          `issue:        #${detail.issueNumber} ${detail.issueTitle}\n`
        );
        writeOut(program, `state:        ${detail.state}\n`);
        writeOut(program, `provider:     ${detail.provider}\n`);
        writeOut(program, `started:      ${detail.createdAt}\n`);
        writeOut(program, `updated:      ${detail.updatedAt}\n`);
        writeOut(program, `branch:       ${formatPath(detail.branchName)}\n`);
        writeOut(
          program,
          `workspace:    ${formatPath(detail.workspacePath)}\n`
        );
        writeOut(
          program,
          `artifacts:    ${formatArtifactKinds(detail.artifacts)}\n`
        );
        if (detail.terminalReason !== null) {
          writeOut(program, `terminal:     ${detail.terminalReason}\n`);
        }
      }
    });

  const serviceCommand = program
    .command("service")
    .description("manage the systemd --user service unit for this install");

  serviceCommand
    .command("install")
    .description(
      "generate systemd --user unit files matching the current runtime and daemon-reload"
    )
    .option("--force", "overwrite existing unit files")
    .option(
      "--print",
      "print the generated units to stdout without writing or reloading"
    )
    .option("--no-reload", "skip systemctl --user daemon-reload after writing")
    .action(
      async (options: {
        force?: boolean;
        print?: boolean;
        reload?: boolean;
      }) => {
        const report = await serviceInstall({
          force: options.force === true,
          print: options.print === true,
          reload: options.reload !== false
        });

        if (report.printed) {
          for (const file of report.files) {
            writeOut(program, `# ${file.path}\n`);
            writeOut(program, file.content);
            writeOut(program, "\n");
          }
          return;
        }

        if (!report.ok) {
          writeErr(program, "service install failed:\n");
          for (const error of report.errors) {
            writeErr(program, `- ${error}\n`);
          }
          process.exitCode = 1;
          return;
        }

        writeOut(program, "service install ok\n");
        for (const file of report.files) {
          writeOut(program, `wrote:  ${file.path}\n`);
        }
        if (report.reloadError !== null) {
          writeErr(
            program,
            `warning: systemctl --user daemon-reload failed: ${report.reloadError}\n`
          );
          writeErr(
            program,
            "run systemctl --user daemon-reload yourself once systemd --user is available\n"
          );
        } else if (report.reloaded) {
          writeOut(program, "ran:    systemctl --user daemon-reload\n");
        }
        writeOut(
          program,
          "next:   systemctl --user enable --now symphonika.service\n"
        );
        writeOut(program, "then:   journalctl --user -u symphonika -f\n");
      }
    );

  const workflowCommand = program
    .command("workflow")
    .description("validate and explain repository workflow definitions");

  workflowCommand
    .command("validate")
    .description(
      "validate the expanded workflow graph without dispatching work"
    )
    .option("--config <path>", "service config path")
    .option("--project <name>", "project name from symphonika.yml")
    .action(async (options: { config?: string; project?: string }) => {
      const report = await loadProjectWorkflow({
        configPath: resolveServiceConfigPath(withConfigPath(options.config))
          .configPath,
        ...(options.project === undefined
          ? {}
          : { projectName: options.project })
      });

      if (report.workflow === null || report.errors.length > 0) {
        writeErr(program, "workflow validate failed:\n");
        for (const error of report.errors) {
          writeErr(program, `- ${error}\n`);
        }
        process.exitCode = 1;
        return;
      }

      writeOut(
        program,
        `workflow validate ok: ${report.projectName ?? "(unknown project)"} -> ${report.workflow.name}\n`
      );
      writeOut(
        program,
        `source: ${report.workflowPath ?? report.workflow.source.path}\n`
      );
      writeOut(program, `states: ${report.workflow.states.length}\n`);
      writeOut(program, explainWorkflow(report.workflow));
    });

  workflowCommand
    .command("explain")
    .description("print the expanded workflow graph without dispatching work")
    .option("--config <path>", "service config path")
    .option("--project <name>", "project name from symphonika.yml")
    .action(async (options: { config?: string; project?: string }) => {
      const report = await loadProjectWorkflow({
        configPath: resolveServiceConfigPath(withConfigPath(options.config))
          .configPath,
        ...(options.project === undefined
          ? {}
          : { projectName: options.project })
      });

      if (report.workflow === null || report.errors.length > 0) {
        writeErr(program, "workflow explain failed:\n");
        for (const error of report.errors) {
          writeErr(program, `- ${error}\n`);
        }
        process.exitCode = 1;
        return;
      }

      writeOut(program, explainWorkflow(report.workflow));
    });

  program
    .command("status")
    .description("print project validation, issue polling, and run summaries")
    .option("--config <path>", "service config path")
    .option("--daemon-url <url>", "local daemon base URL")
    .option("--dashboard", "render a compact terminal status dashboard")
    .option("--watch", "refresh the terminal dashboard until interrupted")
    .option(
      "--interval-ms <n>",
      "watch refresh interval in milliseconds",
      parsePositiveInt,
      1000
    )
    .option(
      "--doctor-ttl-ms <n>",
      "minimum milliseconds between full doctor checks in watch mode; 0 checks every frame",
      parseNonNegativeInt,
      DEFAULT_STATUS_WATCH_DOCTOR_TTL_MS
    )
    .action(
      async (options: {
        config?: string;
        daemonUrl?: string;
        dashboard?: boolean;
        doctorTtlMs: number;
        intervalMs: number;
        watch?: boolean;
      }) => {
        let watchDoctorCache:
          { expiresAtMs: number; report: DoctorReport } | undefined;

        const refreshDoctorReport = async (): Promise<DoctorReport> => {
          if (options.watch !== true) {
            return doctor(withConfigPath(options.config));
          }
          const now = Date.now();
          if (
            options.doctorTtlMs > 0 &&
            watchDoctorCache !== undefined &&
            now < watchDoctorCache.expiresAtMs
          ) {
            return watchDoctorCache.report;
          }
          const report = await doctor(withConfigPath(options.config));
          watchDoctorCache = {
            expiresAtMs: Date.now() + options.doctorTtlMs,
            report
          };
          return report;
        };

        const printOnce = async (
          dashboard: boolean,
          redrawState?: { previousLineCount: number }
        ): Promise<void> => {
          const stateRoot = resolveStateRoot(
            withConfigPath(options.config)
          ).stateRoot;
          const store = openRunStore({ stateRoot });
          try {
            const report = await refreshDoctorReport();
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
            const issueCounts = issueCountsFromStatus(
              daemonStatus,
              report.projects,
              byState
            );

            if (dashboard) {
              const dashboardOutput = renderStatusDashboard({
                daemon:
                  daemonUrl === undefined
                    ? "unavailable (not configured)"
                    : formatDaemonAvailability(daemonStatus, daemonUrl),
                issueCounts,
                lastPollOutcome: formatLastPollOutcome(daemonStatus),
                latestEvents: collectLatestDashboardEvents(store, all),
                projects: report.projects,
                reload: formatReloadOutcome(daemonStatus),
                routines: store.listRoutines(),
                runs: all,
                stateRoot
              });
              if (redrawState !== undefined) {
                const frame = renderStatusDashboardRedrawFrame(
                  dashboardOutput,
                  redrawState.previousLineCount
                );
                redrawState.previousLineCount = frame.lineCount;
                writeOut(program, frame.output);
                return;
              }
              writeOut(program, dashboardOutput);
              return;
            }

            writeOut(program, `state root: ${stateRoot}\n`);
            if (daemonUrl !== undefined) {
              writeOut(
                program,
                `daemon: ${formatDaemonAvailability(daemonStatus, daemonUrl)}\n`
              );
              writeOut(
                program,
                `config reload: ${formatReloadOutcome(daemonStatus)}\n`
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
              const cursor = projectCursorFromStatus(
                daemonStatus,
                project.name
              );
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
        };

        if (options.watch === true) {
          const redrawState = { previousLineCount: 0 };
          for (;;) {
            await printOnce(true, redrawState);
            await sleep(options.intervalMs);
          }
        }

        await printOnce(options.dashboard === true);
      }
    );

  program
    .command("poll-now")
    .description("ask the running daemon to reconcile and poll immediately")
    .option("--config <path>", "service config path")
    .option("--daemon-url <url>", "local daemon base URL")
    .action(async (options: { config?: string; daemonUrl?: string }) => {
      const stateRoot = resolveStateRoot(
        withConfigPath(options.config)
      ).stateRoot;
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

      const daemonStatus = await fetchDaemonStatus(
        fetcher,
        daemonUrl,
        stateRoot
      );
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
    .option("--config <path>", "service config path")
    .option("--state <state>", "filter by run state")
    .option("--project <project>", "filter by project name")
    .option("--limit <n>", "max rows", parsePositiveInt)
    .action(
      (options: {
        config?: string;
        limit?: number;
        project?: string;
        state?: string;
      }) => {
        const stateRoot = resolveStateRoot(
          withConfigPath(options.config)
        ).stateRoot;
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
    .command("routines")
    .description("list routines from the run store")
    .option("--config <path>", "service config path")
    .option("--project <project>", "filter by project name")
    .action((options: { config?: string; project?: string }) => {
      const stateRoot = resolveStateRoot(
        withConfigPath(options.config)
      ).stateRoot;
      const store = openRunStore({ stateRoot });
      try {
        const routines = store.listRoutines(
          options.project === undefined ? {} : { project: options.project }
        );
        if (routines.length === 0) {
          writeOut(program, "(no routines)\n");
          return;
        }
        writeOut(
          program,
          "project  routine  state  next_fire_at  last_fired_at\n"
        );
        for (const routine of routines) {
          writeOut(
            program,
            [
              routine.projectName,
              routine.name,
              routine.state,
              routine.nextFireAt ?? "-",
              routine.lastFiredAt ?? "-"
            ].join("  ") + "\n"
          );
        }
      } finally {
        store.close();
      }
    });

  program
    .command("show-run")
    .description("show run detail, attempts, transitions, and recent events")
    .argument("<id>", "run id")
    .option("--config <path>", "service config path")
    .option("--events <n>", "max recent events", parsePositiveInt, 25)
    .action(
      async (id: string, options: { config?: string; events: number }) => {
        const state = resolveStateRoot(withConfigPath(options.config));
        const store = openRunStore({ stateRoot: state.stateRoot });
        try {
          const detail = store.getRun(id);
          if (detail === undefined) {
            writeErr(program, `run ${id} not found\n`);
            program.error(`run ${id} not found`, { exitCode: 1 });
            return;
          }
          const displayDetail = await fillMissingRunDisplayPaths(detail, {
            configDir: state.configDir,
            configPath: state.configPath
          });
          writeOut(program, `id:           ${displayDetail.id}\n`);
          writeOut(program, `project:      ${displayDetail.project}\n`);
          writeOut(
            program,
            `issue:        #${displayDetail.issueNumber} ${displayDetail.issueTitle}\n`
          );
          writeOut(program, `state:        ${displayDetail.state}\n`);
          writeOut(program, `provider:     ${displayDetail.provider}\n`);
          writeOut(program, `started:      ${displayDetail.createdAt}\n`);
          writeOut(program, `updated:      ${displayDetail.updatedAt}\n`);
          writeOut(
            program,
            `branch:       ${formatPath(displayDetail.branchName)}\n`
          );
          writeOut(
            program,
            `workspace:    ${formatPath(displayDetail.workspacePath)}\n`
          );
          writeOut(
            program,
            `artifacts:    ${formatArtifactKinds(store.listRunArtifacts(detail.id))}\n`
          );
          writeOut(
            program,
            formatWorkflowGraphSummary(await store.getWorkflowGraph(detail.id))
          );
          writeOut(
            program,
            `retries:      ${detail.retryCount}${detail.isContinuation ? " (continuation)" : ""}\n`
          );
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
          const events = store.listProviderEvents(id, {
            limit: options.events
          });
          writeOut(program, `\nnormalized events (last ${events.length}):\n`);
          if (events.length === 0) {
            writeOut(program, "  (no events recorded)\n");
          }
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
        } finally {
          store.close();
        }
      }
    );

  program
    .command("cancel")
    .description("request cancellation of an active run via the run store")
    .argument("<id>", "run id")
    .option("--config <path>", "service config path")
    .option("--daemon-url <url>", "local daemon base URL")
    .action(
      async (id: string, options: { config?: string; daemonUrl?: string }) => {
        const stateRoot = resolveStateRoot(
          withConfigPath(options.config)
        ).stateRoot;
        const daemonUrl = resolveDaemonUrl(stateRoot, options.daemonUrl);
        if (daemonUrl === undefined) {
          const descriptorPath = daemonEndpointPath(stateRoot);
          writeErr(
            program,
            `cancel failed: daemon endpoint not found at ${descriptorPath}\n`
          );
          program.error("cancel failed: daemon endpoint not found", {
            exitCode: 1
          });
          return;
        }

        const daemonStatus = await fetchDaemonStatus(
          fetcher,
          daemonUrl,
          stateRoot
        );
        if (daemonStatus.kind === "unavailable") {
          writeErr(program, `cancel failed: ${daemonStatus.error}\n`);
          program.error(`cancel failed: ${daemonStatus.error}`, {
            exitCode: 1
          });
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
      }
    );

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await buildCli().parseAsync(argv);
}

function isDirectCliInvocation(
  moduleUrl: string,
  argvEntry: string | undefined
): boolean {
  if (argvEntry === undefined) {
    return false;
  }

  let entryPath = argvEntry;
  try {
    entryPath = realpathSync(argvEntry);
  } catch {
    // Fall back to the raw argv path so direct invocation still works when
    // the entrypoint disappears between process launch and this check.
  }

  return moduleUrl === pathToFileURL(entryPath).href;
}

function collectLatestDashboardEvents(
  store: RunStore,
  runs: RunStatus[]
): Map<string, DashboardEventSummary> {
  const latestEvents = new Map<string, DashboardEventSummary>();
  for (const run of runs) {
    if (!statusDashboardShowsLatestEvent(run.state)) {
      continue;
    }
    const events = store.listProviderEvents(run.id, {
      limit: 1,
      order: "desc"
    });
    const summary = summarizeDashboardEvent(events[0]);
    if (summary !== undefined) {
      latestEvents.set(run.id, summary);
    }
  }
  return latestEvents;
}

function statusDashboardShowsLatestEvent(state: RunState): boolean {
  return (
    state === "queued" ||
    state === "preparing_workspace" ||
    state === "running" ||
    state === "waiting"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      ? {
          error: "daemon returned terminal conflict without a run state",
          kind: "error"
        }
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
  { ok: false; error: string } | { ok: true; response: PollNowResponse }
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

function readPollNowIssuePolling(
  value: unknown
): PollNowResponse["issuePolling"] {
  if (!isObject(value)) {
    return { errors: [], projects: [] };
  }
  return {
    errors: Array.isArray(value.errors)
      ? value.errors.filter(
          (error): error is string => typeof error === "string"
        )
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
        byState.get("failed") ?? 0
      ),
      filtered: arrayLength(filteredIssues),
      running: Math.max(
        countIssuesWithLabel(filteredIssues, "sym:running"),
        byState.get("running") ?? 0
      ),
      stale: Math.max(
        projects.reduce(
          (count, project) => count + project.staleIssues.length,
          0
        ),
        countIssuesWithLabel(filteredIssues, "sym:stale"),
        arrayLength(daemonStatus.status.staleIssues),
        byState.get("stale") ?? 0
      )
    };
  }

  return {
    candidate: 0,
    failed: byState.get("failed") ?? 0,
    filtered: 0,
    running: byState.get("running") ?? 0,
    stale: Math.max(
      projects.reduce(
        (count, project) => count + project.staleIssues.length,
        0
      ),
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
  return new Set(
    labels.filter((label): label is string => typeof label === "string")
  );
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

function formatReloadOutcome(
  daemonStatus:
    | { kind: "available"; status: DaemonStatusResponse }
    | { kind: "unavailable"; error: string }
): string {
  if (daemonStatus.kind === "unavailable") {
    return `unknown (${daemonStatus.error})`;
  }
  const reload = daemonStatus.status.reload;
  if (reload === undefined) {
    return "unknown";
  }
  if (reload.ok) {
    return reload.lastLoadedAt === null
      ? "not yet loaded"
      : `ok at ${reload.lastLoadedAt}`;
  }
  const suffix = reload.usingLastKnownGood ? " (using last known good)" : "";
  return `failed${suffix}: ${reload.errors.join("; ")}`;
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

function withConfigPath(configPath: string | undefined): {
  configPath?: string;
} {
  return configPath === undefined ? {} : { configPath };
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
}

function parseNonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return n;
}

function formatPath(value: string): string {
  return value.length === 0 ? "<not yet recorded>" : value;
}

function formatArtifactKinds(artifacts: RunArtifactDescriptor[]): string {
  const present = artifacts
    .filter((artifact) => artifact.present)
    .map((artifact) =>
      artifact.sizeBytes === undefined
        ? artifact.kind
        : `${artifact.kind}(${artifact.sizeBytes} bytes)`
    );
  return present.length === 0 ? "(none)" : present.join(", ");
}

async function fillMissingRunDisplayPaths(
  detail: RunDetail,
  input: { configDir: string; configPath: string }
): Promise<RunDetail> {
  if (detail.branchName.length > 0 && detail.workspacePath.length > 0) {
    return detail;
  }

  const plan = await planRunWorkspacePaths(detail, input);
  if (plan === undefined) {
    return detail;
  }

  return {
    ...detail,
    branchName:
      detail.branchName.length === 0 ? plan.branchName : detail.branchName,
    workspacePath:
      detail.workspacePath.length === 0
        ? plan.workspacePath
        : detail.workspacePath
  };
}

async function planRunWorkspacePaths(
  detail: RunStatus,
  input: { configDir: string; configPath: string }
): Promise<WorkspacePathPlan | undefined> {
  try {
    const reloader = new RuntimeConfigReloader({
      configPath: input.configPath
    });
    const snapshot = await reloader.reload();
    const project = snapshot?.projects.find(
      (entry) => entry.name === detail.project
    );
    if (project === undefined) {
      return undefined;
    }
    return planWorkspacePaths({
      configDir: input.configDir,
      issue: {
        number: detail.issueNumber,
        title: detail.issueTitle
      },
      project
    });
  } catch {
    return undefined;
  }
}

function formatWorkflowGraphSummary(
  graph: ExpandedWorkflow | undefined
): string {
  if (graph === undefined) {
    return "workflow:     (no workflow graph evidence)\n";
  }
  const name = typeof graph.name === "string" ? graph.name : "(unknown)";
  const sourceKind =
    typeof graph.source?.kind === "string" ? graph.source.kind : "(unknown)";
  const sourcePath =
    typeof graph.source?.path === "string" ? graph.source.path : "(unknown)";
  const initial =
    typeof graph.initial === "string" ? graph.initial : "(unknown)";
  const stateCount = Array.isArray(graph.states) ? graph.states.length : 0;
  const contentHash =
    typeof graph.contentHash === "string" ? graph.contentHash : "(unknown)";
  return [
    `workflow:     ${name}`,
    `source kind:  ${sourceKind}`,
    `source path:  ${sourcePath}`,
    `initial:      ${initial}`,
    `states:       ${stateCount}`,
    `content hash: ${contentHash}`,
    ""
  ].join("\n");
}

function formatRecentRunSuffix(
  run: {
    issueNumber: number;
    project: string;
    state: RunState;
    terminalReason: string | null;
  },
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

function parseProvider(value: string): InitProvider {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new InvalidArgumentError("provider must be one of codex, claude");
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
      writeOut(
        program,
        `    • #${issue.number}  ${issue.title} (${issue.url})\n`
      );
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

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  runCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
