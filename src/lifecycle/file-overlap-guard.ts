import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "pino";

import {
  tryListPullRequestFiles,
  tryListPullRequestsForBranch,
  type GitHubIssuesApi,
  type IssueSnapshot,
  type RawGitHubPullRequest
} from "../issue-polling.js";
import { repositoryForProject } from "../pull-request-followup.js";
import type { RunStore } from "../run-store.js";
import { planWorkspacePaths } from "../workspace-paths.js";
import type { ActiveRunEntry, ActiveRunRegistry } from "./active-runs.js";

const execFileAsync = promisify(execFile);

const DEFAULT_OVERLAP_FOOTPRINT_REFRESH_MS = 30_000;

// A wedged `git` (a stalled filesystem, index-lock contention with the live
// provider) would otherwise hang pickTargetFromCandidates, and with it every
// Project's dispatch, forever. Mirrors src/http/git-status.ts's own timeout.
const GIT_COMMAND_TIMEOUT_MS = 30_000;

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

type CandidateOverlapInspection = {
  candidateFiles: readonly string[];
  hasKnownOverlap: boolean;
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
  private readonly runStore: RunStore;

  constructor(input: {
    activeRuns: ActiveRunRegistry;
    configDir: string;
    env: NodeJS.ProcessEnv;
    githubIssuesApi: GitHubIssuesApi;
    logger?: Logger;
    now?: () => number;
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
    this.runStore = input.runStore;
  }

  // Never throws: an unexpected failure here must fail open (dispatch
  // proceeds) rather than abort the whole dispatch tick. See ADR 0085.
  async hasKnownOverlap(input: {
    issue: IssueSnapshot;
    project: GuardProject;
  }): Promise<boolean> {
    try {
      return await this.evaluateOverlap(input);
    } catch (error) {
      this.logger?.warn(
        {
          candidateIssueNumber: input.issue.number,
          err: error,
          project: input.project.name
        },
        "symphonika dispatch overlap evaluation failed"
      );
      return false;
    }
  }

  // Claim-time admission calls this while holding dispatchMutex. Returning the
  // candidate footprint lets the caller seed the newly reserved Run before
  // releasing that mutex, so another already-picked candidate can compare
  // against it atomically rather than waiting for Workspace preparation.
  async inspectCandidate(input: {
    issue: IssueSnapshot;
    project: GuardProject;
  }): Promise<CandidateOverlapInspection> {
    const refreshedAt = this.now();
    try {
      const candidateFiles = await this.candidateFiles(input);
      return {
        candidateFiles,
        hasKnownOverlap: await this.evaluateOverlap(input, candidateFiles),
        refreshedAt
      };
    } catch (error) {
      this.logger?.warn(
        {
          candidateIssueNumber: input.issue.number,
          err: error,
          project: input.project.name
        },
        "symphonika dispatch overlap claim inspection failed"
      );
      return { candidateFiles: [], hasKnownOverlap: false, refreshedAt };
    }
  }

  private async evaluateOverlap(
    input: {
      issue: IssueSnapshot;
      project: GuardProject;
    },
    candidateFootprint?: readonly string[]
  ): Promise<boolean> {
    const projectName = input.project.name;
    // Cheapest possible gate first: with nothing in flight for the Project
    // there is nothing to collide with, so neither the Run Store nor GitHub
    // is touched on an otherwise idle tick.
    if (this.activeRuns.countInFlightByProject(projectName) === 0) {
      return false;
    }
    const candidateFiles =
      candidateFootprint ?? (await this.candidateFiles(input));
    if (candidateFiles.length === 0) {
      return false;
    }
    const candidateFileSet = new Set(candidateFiles);
    const now = this.now();

    // One Run Store query for the Project rather than getRun per entry:
    // getRun also loads every attempt and stats every artifact on disk, and
    // all this needs is the Workspace path. Routine Firings share the
    // registry but own no `runs` row, so they drop out here and a routine
    // Workspace is never read as issue-Run footprint. A reserved issue Run
    // without a Workspace path contributes only when claim-time admission
    // seeded its known candidate footprint.
    const workspacePaths = new Map(
      this.runStore
        .listRuns({ project: projectName })
        .map((run) => [run.id, run.workspacePath])
    );
    // Deliberately re-read the registry after the GitHub round-trip above:
    // a Run can unregister during it, and a Run that is no longer in flight
    // must not keep blocking candidates.
    const activeIssueRuns = this.activeRuns.list().flatMap((active) => {
      const workspacePath = workspacePaths.get(active.runId);
      return active.projectName !== projectName ||
        ((workspacePath === undefined || workspacePath.length === 0) &&
          active.touchedFiles === undefined)
        ? []
        : [{ active, workspacePath }];
    });

    await Promise.all(
      activeIssueRuns.flatMap(({ active, workspacePath }) =>
        workspacePath === undefined || workspacePath.length === 0
          ? []
          : [
              this.refreshTouchedFiles({
                active,
                baseBranch: input.project.workspace.git.base_branch,
                now,
                workspacePath
              })
            ]
      )
    );

    for (const { active } of activeIssueRuns) {
      const collision = active.touchedFiles?.files.find((file) =>
        candidateFileSet.has(file)
      );
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

  private async refreshTouchedFiles(input: {
    active: ActiveRunEntry;
    baseBranch: string;
    now: number;
    workspacePath: string;
  }): Promise<void> {
    const refreshedAt = input.active.touchedFiles?.refreshedAt;
    if (
      refreshedAt !== undefined &&
      input.now - refreshedAt < DEFAULT_OVERLAP_FOOTPRINT_REFRESH_MS
    ) {
      return;
    }
    // On failure replace stale evidence with an empty footprint but still
    // stamp the attempt, so dispatch fails open without respawning two `git`
    // processes for every candidate on every tick.
    let files: readonly string[] = [];
    try {
      files = await readTouchedFiles({
        baseBranch: input.baseBranch,
        workspacePath: input.workspacePath
      });
    } catch (error) {
      this.logger?.warn(
        {
          err: error,
          project: input.active.projectName,
          runId: input.active.runId,
          workspacePath: input.workspacePath
        },
        "symphonika dispatch overlap Workspace inspection failed"
      );
    }
    this.activeRuns.updateTouchedFiles(input.active.runId, {
      files,
      refreshedAt: input.now
    });
  }

  private async candidateFiles(input: {
    issue: IssueSnapshot;
    project: GuardProject;
  }): Promise<readonly string[]> {
    const now = this.now();
    const repository = repositoryForProject(input.project, this.env);
    if (repository === undefined) {
      return [];
    }
    const key = `${input.project.name}:${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}#${input.issue.number}`;
    const cached = this.candidateCache.get(key);
    this.pruneCandidateCache(now);
    if (
      cached !== undefined &&
      now - cached.refreshedAt < DEFAULT_OVERLAP_FOOTPRINT_REFRESH_MS
    ) {
      return cached.files;
    }
    try {
      const files = await this.loadCandidateFiles({
        issue: input.issue,
        project: input.project,
        repository
      });
      this.candidateCache.set(key, { files, refreshedAt: now });
      return files;
    } catch (error) {
      this.logger?.warn(
        {
          candidateIssueNumber: input.issue.number,
          err: error,
          project: input.project.name
        },
        "symphonika dispatch overlap candidate inspection failed"
      );
      this.candidateCache.set(key, { files: [], refreshedAt: now });
      return [];
    }
  }

  // Returns the candidate PR's file footprint, or [] when there is nothing to
  // read. Every outcome is cached by the caller so a fail-open answer does not
  // re-issue the branch lookup to GitHub on the next tick.
  private async loadCandidateFiles(input: {
    issue: IssueSnapshot;
    project: GuardProject;
    repository: { owner: string; repo: string; token: string };
  }): Promise<readonly string[]> {
    const tracked = this.runStore.findTrackedPullRequestByIssue({
      issueNumber: input.issue.number,
      projectName: input.project.name
    });
    let pullNumber = tracked?.state === "open" ? tracked.prNumber : undefined;
    if (pullNumber === undefined) {
      const branchName = planWorkspacePaths({
        configDir: this.configDir,
        issue: input.issue,
        project: input.project
      }).branchName;
      const pullRequests = await tryListPullRequestsForBranch(
        this.githubIssuesApi,
        { ...input.repository, branch: branchName }
      );
      pullNumber = openPullRequestNumberForBranch(
        pullRequests ?? [],
        branchName
      );
    }
    if (pullNumber === undefined) {
      return [];
    }
    const files = await tryListPullRequestFiles(this.githubIssuesApi, {
      ...input.repository,
      pullNumber
    });
    // The adapter has no listFiles at all: fail open without stale evidence.
    if (files === undefined) {
      return [];
    }
    return Array.from(
      new Set(
        files
          .flatMap((file) => [
            normalizeRepositoryPath(file.filename),
            normalizeRepositoryPath(file.previous_filename)
          ])
          .filter((file): file is string => file !== undefined)
      )
    );
  }

  private pruneCandidateCache(now: number): void {
    for (const [key, cached] of this.candidateCache) {
      if (now - cached.refreshedAt >= DEFAULT_OVERLAP_FOOTPRINT_REFRESH_MS) {
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
      "--name-status",
      "-z",
      // Three-dot (merge-base) on purpose: the shared repository cache
      // re-fetches refs/remotes/origin/<base> on every Workspace
      // preparation, so a two-dot range would keep folding everything that
      // landed on the base branch since this Run branched into the Run's
      // own footprint and block unrelated candidates.
      `refs/remotes/origin/${input.baseBranch}...HEAD`,
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
    new Set([...parseDiffStatusPaths(committed), ...parseStatusPaths(status)])
  );
}

async function gitOutput(
  workspacePath: string,
  args: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    // --no-optional-locks: `git status` otherwise refreshes and rewrites the
    // index under .git/index.lock, and this runs inside a Workspace where
    // the provider is live and using Git itself.
    ["-C", workspacePath, "--no-optional-locks", ...args],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_COMMAND_TIMEOUT_MS
    }
  );
  return stdout;
}

function parseDiffStatusPaths(output: string): string[] {
  const fields = output.split("\0");
  const files: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (status === undefined || status.length === 0) {
      continue;
    }
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      const file = normalizeRepositoryPath(fields[index + 1]);
      if (file !== undefined) {
        files.push(file);
      }
      index += 1;
    }
  }
  return files;
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
  // Both sides already speak forward-slashed repository-relative paths (Git
  // reports them that way even on Windows, as does GitHub), so rewriting
  // backslashes would only corrupt a legitimate path that contains one.
  const normalized = file.replace(/^\.\//, "");
  return normalized.length === 0 ? undefined : normalized;
}

// Unlike the PR follow-up path's selector, drafts count here: a draft PR's
// files are a real footprint that a concurrent Run would still collide with.
function openPullRequestNumberForBranch(
  pullRequests: readonly RawGitHubPullRequest[],
  branchName: string
): number | undefined {
  return pullRequests.find(
    (pullRequest) =>
      pullRequest.state === "open" &&
      pullRequest.number !== undefined &&
      pullRequest.number > 0 &&
      pullRequest.head?.ref === branchName
  )?.number;
}
