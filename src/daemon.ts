import { serve, type ServerType } from "@hono/node-server";
import type { Logger } from "pino";
import pino from "pino";

import { dispatchOneEligibleIssue } from "./dispatch.js";
import { createHttpApp } from "./http/app.js";
import type {
  GitHubIssuesApi,
  PollConfiguredGitHubIssuesOptions
} from "./issue-polling.js";
import {
  DEFAULT_GITHUB_ISSUES_API,
  emptyIssuePollStatus,
  pollConfiguredGitHubIssues,
  readConfiguredPollingIntervalMs,
  replaceIssuePollStatus
} from "./issue-polling.js";
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
  const agentProviders = options.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
  const dispatchRuntime = {
    dispatching: false
  };
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let scheduledWork = Promise.resolve();
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
  const dispatchEligibleIssue = async (): Promise<void> => {
    if (
      !state.configExists ||
      dispatchRuntime.dispatching ||
      !hasRegisteredProviders(agentProviders)
    ) {
      return;
    }

    dispatchRuntime.dispatching = true;
    try {
      await dispatchOneEligibleIssue({
        agentProviders,
        configDir: state.configDir,
        configPath: state.configPath,
        githubIssuesApi: options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API,
        issuePollStatus,
        runStore,
        stateRoot: state.stateRoot,
        ...(options.createRunId === undefined
          ? {}
          : { createRunId: options.createRunId }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.prepareIssueWorkspace === undefined
          ? {}
          : { prepareIssueWorkspace: options.prepareIssueWorkspace })
      });
    } catch (error) {
      issuePollStatus.errors.push(errorMessage(error));
      logger.error({ err: error }, "symphonika dispatch failed");
    } finally {
      dispatchRuntime.dispatching = false;
    }
  };
  const refreshAndDispatch = async (): Promise<void> => {
    await refreshIssuePollStatus();
    await dispatchEligibleIssue();
  };
  const scheduleRefreshAndDispatch = (): void => {
    scheduledWork = scheduledWork.then(refreshAndDispatch, refreshAndDispatch);
    void scheduledWork;
  };

  if (state.configExists) {
    await refreshIssuePollStatus();
    const intervalMs = await readConfiguredPollingIntervalMs(state.configPath);
    pollTimer = setInterval(scheduleRefreshAndDispatch, intervalMs);
    pollTimer.unref?.();
  }
  const app = createHttpApp({
    dispatchRuntime,
    getRuns: () => runStore.listRuns(),
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
  const dispatchPromise = dispatchEligibleIssue();

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
      if (dispatchPromise !== undefined) {
        await dispatchPromise;
      }
      await scheduledWork;
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
