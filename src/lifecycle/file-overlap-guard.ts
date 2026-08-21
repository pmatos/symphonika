import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "pino";

import {
  resolveEnvBackedValue,
  tryListPullRequestFiles,
  tryListPullRequestsForBranch,
  type GitHubIssuesApi,
  type IssueSnapshot,
  type RawGitHubPullRequest
} from "../issue-polling.js";
import type { RunStore } from "../run-store.js";
import { planWorkspacePaths } from "../workspace-paths.js";
import type { ActiveRunRegistry } from "./active-runs.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_OVERLAP_FOOTPRINT_REFRESH_MS = 30_000;

type GuardProject = {
  name: string;
  tracker?:
    | {
        owner: string;
        repo: string;
        token: string;
      }
    | undefined;
  workspace: {
    git: { base_branch: string };
    root: string;
  };
};

type CandidateFootprintCacheEntry = {
  files: readonly string[];
  refreshedAt: number;
};

export class DispatchFileOverlapGuard {
  private readonly activeRuns: ActiveRunRegistry;
  private readonly candidateCache = new Map<
    string,
    CandidateFootprintCacheEntry
  >();
  private readonly configDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly githubIssuesApi: GitHubIssuesApi;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly runStore: RunStore;

  constructor(input: {
    activeRuns: ActiveRunRegistry;
    configDir: string;
    env: NodeJS.ProcessEnv;
    githubIssuesApi: GitHubIssuesApi;
    logger?: Logger;
    now?: () => number;
    refreshIntervalMs?: number;
    runStore: RunStore;
  }) {
    this.activeRuns = input.activeRuns;
    this.configDir = input.configDir;
    this.env = input.env;
    this.githubIssuesApi = input.githubIssuesApi;
    if (input.logger !== undefined) {
      this.logger = input.logger;
    }
    this.now = input.now ?? Date.now;
    this.refreshIntervalMs =
      input.refreshIntervalMs ?? DEFAULT_OVERLAP_FOOTPRINT_REFRESH_MS;
    this.runStore = input.runStore;
  }

  async hasKnownOverlap(input: {
    issue: IssueSnapshot;
    project: GuardProject;
  }): Promise<boolean> {
    const activeIssueRuns = this.activeRuns.list().flatMap((active) => {
      if (active.projectName !== input.project.name) {
        return [];
      }
      const run = this.runStore.getRun(active.runId);
      return run === undefined ? [] : [{ active, run }];
    });
    if (activeIssueRuns.length === 0) {
      return false;
    }
    const candidateFiles = await this.candidateFiles(input);
    if (candidateFiles.length === 0) {
      return false;
    }
    const candidateFileSet = new Set(candidateFiles);
    const now = this.now();

    for (const { active, run } of activeIssueRuns) {
      let touchedFiles = active.touchedFiles;
      if (
        active.touchedFilesRefreshedAt === undefined ||
        now - active.touchedFilesRefreshedAt >= this.refreshIntervalMs
      ) {
        if (run.workspacePath.length === 0) {
          continue;
        }
        try {
          touchedFiles = await readTouchedFiles({
            baseBranch: input.project.workspace.git.base_branch,
            workspacePath: run.workspacePath
          });
          this.activeRuns.updateTouchedFiles(active.runId, {
            files: touchedFiles,
            refreshedAt: now
          });
        } catch (error) {
          this.logger?.warn(
            {
              err: error,
              project: active.projectName,
              runId: active.runId,
              workspacePath: run.workspacePath
            },
            "symphonika dispatch overlap Workspace inspection failed"
          );
        }
      }

      const collision = touchedFiles.find((file) => candidateFileSet.has(file));
      if (collision !== undefined) {
        this.logger?.info(
          {
            candidateIssueNumber: input.issue.number,
            collision,
            conflictingRunId: active.runId,
            project: input.project.name
          },
          "symphonika skipped dispatch candidate with known file overlap"
        );
        return true;
      }
    }
    return false;
  }

  private async candidateFiles(input: {
    issue: IssueSnapshot;
    project: GuardProject;
  }): Promise<readonly string[]> {
    const now = this.now();
    const repository = repositoryFor(input.project, this.env);
    if (repository === undefined) {
      return [];
    }
    const key = `${input.project.name}:${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}#${input.issue.number}`;
    this.pruneCandidateCache(key, now);
    const cached = this.candidateCache.get(key);
    if (
      cached !== undefined &&
      now - cached.refreshedAt < this.refreshIntervalMs
    ) {
      return cached.files;
    }
    try {
      const tracked = this.runStore
        .listOpenTrackedPullRequests()
        .find(
          (pullRequest) =>
            pullRequest.projectName === input.project.name &&
            pullRequest.issueNumber === input.issue.number
        );
      let pullNumber = tracked?.prNumber;
      if (pullNumber === undefined) {
        const branchName = planWorkspacePaths({
          configDir: this.configDir,
          issue: input.issue,
          project: input.project
        }).branchName;
        const pullRequests = await tryListPullRequestsForBranch(
          this.githubIssuesApi,
          {
            ...repository,
            branch: branchName
          }
        );
        pullNumber = selectOpenPullRequest(
          pullRequests ?? [],
          branchName
        )?.number;
      }
      if (pullNumber === undefined) {
        this.candidateCache.set(key, { files: [], refreshedAt: now });
        return [];
      }
      const files = await tryListPullRequestFiles(this.githubIssuesApi, {
        ...repository,
        pullNumber
      });
      if (files === undefined) {
        return cached?.files ?? [];
      }
      const normalized = Array.from(
        new Set(
          files
            .map((file) => normalizeRepositoryPath(file.filename))
            .filter((file): file is string => file !== undefined)
        )
      );
      this.candidateCache.set(key, { files: normalized, refreshedAt: now });
      return normalized;
    } catch (error) {
      this.logger?.warn(
        {
          candidateIssueNumber: input.issue.number,
          err: error,
          project: input.project.name
        },
        "symphonika dispatch overlap candidate inspection failed"
      );
      return cached?.files ?? [];
    }
  }

  private pruneCandidateCache(currentKey: string, now: number): void {
    for (const [key, cached] of this.candidateCache) {
      if (
        key !== currentKey &&
        now - cached.refreshedAt >= this.refreshIntervalMs
      ) {
        this.candidateCache.delete(key);
      }
    }
  }
}

async function readTouchedFiles(input: {
  baseBranch: string;
  workspacePath: string;
}): Promise<readonly string[]> {
  const [committed, status] = await Promise.all([
    gitOutput(input.workspacePath, [
      "diff",
      "--name-only",
      "-z",
      `refs/remotes/origin/${input.baseBranch}..HEAD`,
      "--"
    ]),
    gitOutput(input.workspacePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all"
    ])
  ]);
  return Array.from(
    new Set([
      ...parseNullSeparatedPaths(committed),
      ...parseStatusPaths(status)
    ])
  );
}

async function gitOutput(
  workspacePath: string,
  args: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspacePath, ...args],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout;
}

function parseNullSeparatedPaths(output: string): string[] {
  return output
    .split("\0")
    .map((file) => normalizeRepositoryPath(file))
    .filter((file): file is string => file !== undefined);
}

function parseStatusPaths(output: string): string[] {
  const fields = output.split("\0");
  const files: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    const file = normalizeRepositoryPath(field.slice(3));
    if (file !== undefined) {
      files.push(file);
    }
    if (/[RC]/.test(status)) {
      const renamedFrom = normalizeRepositoryPath(fields[index + 1]);
      if (renamedFrom !== undefined) {
        files.push(renamedFrom);
      }
      index += 1;
    }
  }
  return files;
}

function normalizeRepositoryPath(file: string | undefined): string | undefined {
  if (file === undefined) {
    return undefined;
  }
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.length === 0 ? undefined : normalized;
}

function repositoryFor(
  project: GuardProject,
  env: NodeJS.ProcessEnv
): { owner: string; repo: string; token: string } | undefined {
  if (project.tracker === undefined) {
    return undefined;
  }
  const token = resolveEnvBackedValue(project.tracker.token, env);
  if (token === undefined) {
    return undefined;
  }
  return {
    owner: project.tracker.owner,
    repo: project.tracker.repo,
    token
  };
}

function selectOpenPullRequest(
  pullRequests: readonly RawGitHubPullRequest[],
  branchName: string
): (RawGitHubPullRequest & { number: number }) | undefined {
  return pullRequests.find(
    (pullRequest): pullRequest is RawGitHubPullRequest & { number: number } =>
      pullRequest.state === "open" &&
      pullRequest.number !== undefined &&
      pullRequest.number > 0 &&
      pullRequest.head?.ref === branchName
  );
}
