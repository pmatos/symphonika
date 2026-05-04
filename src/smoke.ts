import path from "node:path";

import {
  dispatchOneEligibleIssue,
  type DispatchIssueOptions
} from "./dispatch.js";
import {
  runDoctor,
  type DoctorOptions,
  type GitHubApi
} from "./doctor.js";
import {
  DEFAULT_GITHUB_ISSUES_API,
  pollConfiguredGitHubIssues,
  type GitHubIssuesApi,
  type IssuePollStatus
} from "./issue-polling.js";
import type { AgentProviderRegistry } from "./provider.js";
import { DEFAULT_AGENT_PROVIDERS } from "./providers/index.js";
import { openRunStore, type RunDetail, type RunStore } from "./run-store.js";
import { resolveStateRoot } from "./state.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "./workspace.js";

export type SmokeOptions = {
  agentProviders?: AgentProviderRegistry;
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  githubApi?: GitHubApi;
  githubIssuesApi?: GitHubIssuesApi;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
};

export type SmokeRunDetail = Pick<
  RunDetail,
  | "branchName"
  | "createdAt"
  | "id"
  | "issueNumber"
  | "issueSnapshotPath"
  | "issueTitle"
  | "metadataPath"
  | "normalizedLogPath"
  | "project"
  | "promptPath"
  | "provider"
  | "rawLogPath"
  | "state"
  | "terminalReason"
  | "updatedAt"
  | "workspacePath"
>;

export type SmokeReport = {
  configPath: string;
  dispatched: boolean;
  errors: string[];
  ok: boolean;
  runDetail?: SmokeRunDetail;
  runId?: string;
  skipReason?: string;
  warnings: string[];
};

export async function runSmoke(options: SmokeOptions = {}): Promise<SmokeReport> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath ?? "symphonika.yml");
  const env = options.env ?? process.env;
  const agentProviders = options.agentProviders ?? DEFAULT_AGENT_PROVIDERS;
  const githubIssuesApi =
    options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const errors: string[] = [];
  const warnings: string[] = [];

  const doctorOptions: DoctorOptions = {
    agentProviders,
    configPath,
    cwd,
    env,
    githubIssuesApi
  };
  if (options.githubApi !== undefined) {
    doctorOptions.githubApi = options.githubApi;
  }
  const doctorReport = await runDoctor(doctorOptions);
  if (!doctorReport.ok) {
    errors.push(...doctorReport.errors);
    return {
      configPath,
      dispatched: false,
      errors,
      ok: false,
      warnings
    };
  }

  const state = resolveStateRoot({ configPath, cwd });
  const runStore = openRunStore({ stateRoot: state.stateRoot });
  try {
    const issuePollStatus = await pollConfiguredGitHubIssues({
      configPath,
      env,
      githubIssuesApi
    });

    if (issuePollStatus.errors.length > 0) {
      errors.push(...issuePollStatus.errors);
      return {
        configPath,
        dispatched: false,
        errors,
        ok: false,
        warnings
      };
    }

    warnings.push(...staleClaimWarnings(issuePollStatus, runStore, configPath));

    if (issuePollStatus.candidateIssues.length === 0) {
      return {
        configPath,
        dispatched: false,
        errors,
        ok: true,
        skipReason: "no eligible issues to dispatch",
        warnings
      };
    }

    const dispatchOptions: DispatchIssueOptions = {
      agentProviders,
      configDir: state.configDir,
      configPath,
      env,
      githubIssuesApi,
      issuePollStatus,
      runStore,
      stateRoot: state.stateRoot
    };
    if (options.prepareIssueWorkspace !== undefined) {
      dispatchOptions.prepareIssueWorkspace = options.prepareIssueWorkspace;
    }
    const dispatchResult = await dispatchOneEligibleIssue(dispatchOptions);

    if (!dispatchResult.dispatched) {
      return {
        configPath,
        dispatched: false,
        errors,
        ok: true,
        skipReason: dispatchResult.reason,
        warnings
      };
    }

    const detail = runStore.getRun(dispatchResult.runId);
    const runDetail = detail === undefined ? undefined : pickRunDetail(detail);
    const ok = runDetail === undefined ? true : isTerminalSuccess(runDetail.state);
    if (!ok && runDetail !== undefined) {
      errors.push(formatRunFailure(runDetail));
    }
    return {
      configPath,
      dispatched: true,
      errors,
      ok,
      ...(runDetail === undefined ? {} : { runDetail }),
      runId: dispatchResult.runId,
      warnings
    };
  } finally {
    runStore.close();
  }
}

function pickRunDetail(detail: RunDetail): SmokeRunDetail {
  return {
    branchName: detail.branchName,
    createdAt: detail.createdAt,
    id: detail.id,
    issueNumber: detail.issueNumber,
    issueSnapshotPath: detail.issueSnapshotPath,
    issueTitle: detail.issueTitle,
    metadataPath: detail.metadataPath,
    normalizedLogPath: detail.normalizedLogPath,
    project: detail.project,
    promptPath: detail.promptPath,
    provider: detail.provider,
    rawLogPath: detail.rawLogPath,
    state: detail.state,
    terminalReason: detail.terminalReason,
    updatedAt: detail.updatedAt,
    workspacePath: detail.workspacePath
  };
}

function isTerminalSuccess(state: RunDetail["state"]): boolean {
  return state === "succeeded";
}

function formatRunFailure(detail: SmokeRunDetail): string {
  const reason =
    detail.terminalReason === null
      ? `provider terminated in state ${detail.state}`
      : `terminalReason=${detail.terminalReason}`;
  return `run ${detail.id} terminated in state ${detail.state}; ${reason}; provider.normalized.jsonl: ${detail.normalizedLogPath}`;
}

function staleClaimWarnings(
  issuePollStatus: IssuePollStatus,
  runStore: RunStore,
  configPath: string
): string[] {
  const liveIssues = new Set(
    runStore
      .listActiveRunIds()
      .map((entry) => issueKey(entry.projectName, entry.issueNumber))
  );
  const warnings: string[] = [];

  for (const filtered of issuePollStatus.filteredIssues) {
    const labels = filtered.issue.labels.filter(
      (label) => label === "sym:claimed" || label === "sym:running"
    );
    if (labels.length === 0) {
      continue;
    }
    if (liveIssues.has(issueKey(filtered.project, filtered.issue.number))) {
      continue;
    }
    warnings.push(
      `issue #${filtered.issue.number} carries ${labels.join(", ")} without a live local run in project ${filtered.project}; run symphonika clear-stale ${filtered.project} ${filtered.issue.number} --config ${configPath}`
    );
  }

  return warnings;
}

function issueKey(projectName: string, issueNumber: number): string {
  return `${projectName}#${issueNumber}`;
}
