import { readFile } from "node:fs/promises";

import { serve, type ServerType } from "@hono/node-server";
import type { Logger } from "pino";
import pino from "pino";
import { parse } from "yaml";

import { createHttpApp } from "./http/app.js";
import type {
  GitHubIssuesApi,
  PollConfiguredGitHubIssuesOptions,
  PollingProjectConfig
} from "./issue-polling.js";
import {
  DEFAULT_GITHUB_ISSUES_API,
  emptyIssuePollStatus,
  loadPollingProjectsByName,
  pollConfiguredGitHubIssues,
  readConfiguredPollingIntervalMs,
  replaceIssuePollStatus
} from "./issue-polling.js";
import { ActiveRunRegistry } from "./lifecycle/active-runs.js";
import type {
  LifecyclePolicy,
  ScheduledWorkInput
} from "./lifecycle/active-runs.js";
import { reconcileActiveRuns } from "./lifecycle/reconcile.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type RunControllerProvidersConfig
} from "./lifecycle/run-controller.js";
import { detectStaleClaims } from "./lifecycle/stale-claims.js";
import type { AgentProviderRegistry } from "./provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import { openRunStore } from "./run-store.js";
import { resolveStateRoot } from "./state.js";
import { VERSION } from "./version.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "./workspace.js";

export type StartDaemonOptions = {
  agentProviders?: AgentProviderRegistry;
  configPath?: string;
  createRunId?: () => string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi?: GitHubIssuesApi;
  host?: string;
  lifecyclePolicy?: LifecyclePolicy;
  logger?: Logger;
  port?: number;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
};

export type DaemonHandle = {
  host: string;
  port: number;
  stateRoot: string;
  url: string;
  stop: () => Promise<void>;
};

export async function startDaemon(
  options: StartDaemonOptions = {}
): Promise<DaemonHandle> {
  const logger = options.logger ?? pino();
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  const stateRootOptions: Parameters<typeof resolveStateRoot>[0] = {};
  if (options.configPath !== undefined) {
    stateRootOptions.configPath = options.configPath;
  }
  if (options.cwd !== undefined) {
    stateRootOptions.cwd = options.cwd;
  }
  const state = resolveStateRoot(stateRootOptions);
  const issuePollStatus = emptyIssuePollStatus();
  const runStore = openRunStore({
    stateRoot: state.stateRoot
  });
  const sweptOnStartup = runStore.markLeakedRunsAsStale();
  if (sweptOnStartup.length > 0) {
    logger.info(
      { swept: sweptOnStartup },
      "symphonika startup: marked leaked runs as stale"
    );
  }
  const agentProviders = options.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
  const githubIssuesApi = options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const env = options.env ?? process.env;
  const activeRuns = new ActiveRunRegistry();
  const dispatchMutex = createAsyncMutex();
  const dispatchRuntime = {
    get dispatching(): boolean {
      return dispatchMutex.held;
    }
  };
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let scheduledWork = Promise.resolve();
  const inflightDispatches = new Set<Promise<void>>();
  const projectsLoader = async (): Promise<
    Map<string, RunControllerProjectConfig>
  > => {
    if (!state.configExists) {
      return new Map();
    }
    const map = await loadPollingProjectsByName(state.configPath);
    const enriched = new Map<string, RunControllerProjectConfig>();
    const richDetails = await loadRichProjects(state.configPath);
    for (const [name, project] of map) {
      const detail = richDetails.get(name);
      if (detail === undefined) {
        continue;
      }
      enriched.set(name, {
        ...project,
        workflow: detail.workflow,
        workspace: detail.workspace
      });
    }
    return enriched;
  };
  const providersLoader = async (): Promise<RunControllerProvidersConfig> => {
    return loadProvidersConfig(state.configPath);
  };
  const enqueueScheduledWork = (work: () => Promise<void>): void => {
    scheduledWork = scheduledWork.then(work, work);
    void scheduledWork;
  };
  const runController = new RunController({
    activeRuns,
    agentProviders,
    configDir: state.configDir,
    githubIssuesApi,
    logger,
    projectsLoader,
    providersLoader,
    runStore,
    schedule: (item: ScheduledWorkInput) => {
      activeRuns.scheduleDelayed({
        delayMs: item.delayMs,
        fire: async () => {
          // Register the entire fire callback in inflightDispatches BEFORE
          // awaiting the mutex, so a shutdown that races with a freshly-fired
          // timer (while another dispatch still holds the mutex) cannot snapshot
          // the set early and miss this work.
          const promise = (async () => {
            await dispatchMutex.acquire();
            try {
              await item.fire();
            } catch (error) {
              logger.error({ err: error }, "symphonika scheduled work failed");
            } finally {
              dispatchMutex.release();
            }
          })();
          inflightDispatches.add(promise);
          void promise.finally(() => {
            inflightDispatches.delete(promise);
          });
          await promise;
        },
        kind: item.kind,
        runId: item.runId
      });
    },
    stateRoot: state.stateRoot,
    ...(options.createRunId === undefined
      ? {}
      : { createRunId: options.createRunId }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.lifecyclePolicy === undefined
      ? {}
      : { lifecyclePolicy: options.lifecyclePolicy }),
    ...(options.prepareIssueWorkspace === undefined
      ? {}
      : { prepareIssueWorkspace: options.prepareIssueWorkspace })
  });
  const refreshIssuePollStatus = async (): Promise<void> => {
    if (!state.configExists || polling) {
      return;
    }

    polling = true;
    try {
      replaceIssuePollStatus(
        issuePollStatus,
        await pollConfiguredGitHubIssues(issuePollOptions(state.configPath, options))
      );
    } catch (error) {
      issuePollStatus.errors = [errorMessage(error)];
      issuePollStatus.projects = [];
      issuePollStatus.candidateIssues = [];
      issuePollStatus.filteredIssues = [];
    } finally {
      polling = false;
    }
  };
  const reconcile = async (): Promise<void> => {
    if (!state.configExists) {
      return;
    }
    let projects: Map<string, PollingProjectConfig>;
    try {
      projects = await loadPollingProjectsByName(state.configPath);
    } catch {
      return;
    }
    try {
      await reconcileActiveRuns({
        activeRuns,
        env,
        githubIssuesApi,
        logger,
        pollStatus: issuePollStatus,
        projects,
        runStore
      });
    } catch (error) {
      logger.error({ err: error }, "symphonika reconcile failed");
    }

    if (dispatchMutex.held) {
      return;
    }

    try {
      await detectStaleClaims({
        activeRuns,
        env,
        githubIssuesApi,
        logger,
        pollStatus: issuePollStatus,
        projects,
        runStore
      });
    } catch (error) {
      logger.error({ err: error }, "symphonika stale-claim detection failed");
    }
  };
  const launchDispatch = (): void => {
    if (
      !state.configExists ||
      !hasRegisteredProviders(agentProviders) ||
      !dispatchMutex.tryAcquire()
    ) {
      return;
    }
    const promise = (async () => {
      try {
        await runController.dispatchOneFresh(issuePollStatus);
      } catch (error) {
        issuePollStatus.errors.push(errorMessage(error));
        logger.error({ err: error }, "symphonika dispatch failed");
      } finally {
        dispatchMutex.release();
      }
    })();
    inflightDispatches.add(promise);
    void promise.finally(() => {
      inflightDispatches.delete(promise);
    });
  };
  const tick = async (): Promise<void> => {
    await refreshIssuePollStatus();
    await reconcile();
    launchDispatch();
  };
  const scheduleTick = (): void => {
    enqueueScheduledWork(tick);
  };

  let intervalMs: number | undefined;
  if (state.configExists) {
    await refreshIssuePollStatus();
    intervalMs = await readConfiguredPollingIntervalMs(state.configPath);
  }
  const app = createHttpApp({
    dispatchRuntime,
    getActiveRuns: () =>
      activeRuns.list().map((entry) => ({
        cancelReason: entry.cancelReason ?? null,
        cancelRequested: entry.cancelRequested,
        issueNumber: entry.issueNumber,
        projectName: entry.projectName,
        runId: entry.runId
      })),
    getRuns: () => runStore.listRuns(),
    getScheduled: () => activeRuns.peekDelayed(),
    issuePollStatus,
    stateRoot: state.stateRoot,
    version: VERSION
  });

  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port: requestedPort
  });
  await waitForListening(server);
  const port = resolveListeningPort(server, requestedPort);
  const url = `http://${host}:${port}`;
  if (state.configExists) {
    await reconcile();
    if (issuePollStatus.candidateIssues.length > 0) {
      launchDispatch();
    }
    if (intervalMs !== undefined) {
      pollTimer = setInterval(scheduleTick, intervalMs);
      pollTimer.unref?.();
    }
  }

  logger.info(
    {
      configPath: state.configPath,
      host,
      port,
      stateRoot: state.stateRoot
    },
    "symphonika daemon started"
  );

  return {
    host,
    port,
    stateRoot: state.stateRoot,
    url,
    stop: async () => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
      }
      activeRuns.cancelAll();
      await scheduledWork;
      await Promise.allSettled(Array.from(inflightDispatches));
      await stopServer(server, logger);
      runStore.close();
    }
  };
}

function issuePollOptions(
  configPath: string,
  options: StartDaemonOptions
): PollConfiguredGitHubIssuesOptions {
  const pollOptions: PollConfiguredGitHubIssuesOptions = {
    configPath
  };
  if (options.env !== undefined) {
    pollOptions.env = options.env;
  }
  if (options.githubIssuesApi !== undefined) {
    pollOptions.githubIssuesApi = options.githubIssuesApi;
  }
  return pollOptions;
}

function waitForListening(server: ServerType): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function resolveListeningPort(server: ServerType, fallbackPort: number): number {
  const address = server.address();

  if (typeof address === "object" && address !== null) {
    return address.port;
  }

  return fallbackPort;
}

function stopServer(server: ServerType, logger: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      logger.info("symphonika daemon stopped");
      resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasRegisteredProviders(
  providers: AgentProviderRegistry | undefined
): providers is AgentProviderRegistry {
  return providers !== undefined && Object.values(providers).some(Boolean);
}

type RichProjectDetail = {
  workflow: string;
  workspace: {
    git: {
      base_branch: string;
      remote: string;
    };
    root: string;
  };
};

async function loadRichProjects(
  configPath: string
): Promise<Map<string, RichProjectDetail>> {
  const map = new Map<string, RichProjectDetail>();
  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8")) ?? {};
  } catch {
    return map;
  }
  if (!isRecord(raw)) {
    return map;
  }
  const projects = raw["projects"];
  if (!Array.isArray(projects)) {
    return map;
  }
  for (const project of projects) {
    if (!isRecord(project)) {
      continue;
    }
    const name = project["name"];
    if (typeof name !== "string") {
      continue;
    }
    const workflow = project["workflow"];
    const workspace = project["workspace"];
    if (typeof workflow !== "string" || !isRecord(workspace)) {
      continue;
    }
    const root = workspace["root"];
    const git = workspace["git"];
    if (typeof root !== "string" || !isRecord(git)) {
      continue;
    }
    const remote = git["remote"];
    const baseBranch = git["base_branch"];
    if (typeof remote !== "string" || typeof baseBranch !== "string") {
      continue;
    }
    map.set(name, {
      workflow,
      workspace: {
        git: {
          base_branch: baseBranch,
          remote
        },
        root
      }
    });
  }
  return map;
}

async function loadProvidersConfig(
  configPath: string
): Promise<RunControllerProvidersConfig> {
  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8")) ?? {};
  } catch {
    return defaultProvidersConfig();
  }
  if (!isRecord(raw)) {
    return defaultProvidersConfig();
  }
  const providers = raw["providers"];
  if (!isRecord(providers)) {
    return defaultProvidersConfig();
  }
  return {
    claude: { command: providerCommand(providers["claude"], defaultProvidersConfig().claude.command) },
    codex: { command: providerCommand(providers["codex"], defaultProvidersConfig().codex.command) }
  };
}

function providerCommand(input: unknown, fallback: string): string {
  if (isRecord(input) && typeof input["command"] === "string") {
    return input["command"];
  }
  return fallback;
}

function defaultProvidersConfig(): RunControllerProvidersConfig {
  return {
    claude: {
      command:
        "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"
    },
    codex: { command: "codex --dangerously-bypass-approvals-and-sandbox app-server" }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AsyncMutex = {
  acquire: () => Promise<void>;
  readonly held: boolean;
  release: () => void;
  tryAcquire: () => boolean;
};

function createAsyncMutex(): AsyncMutex {
  const waiters: Array<() => void> = [];
  let locked = false;
  return {
    acquire(): Promise<void> {
      if (!locked) {
        locked = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    get held(): boolean {
      return locked;
    },
    release(): void {
      const next = waiters.shift();
      if (next !== undefined) {
        next();
        return;
      }
      locked = false;
    },
    tryAcquire(): boolean {
      if (locked) {
        return false;
      }
      locked = true;
      return true;
    }
  };
}
