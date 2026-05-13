import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";

import type {
  GitHubIssueRepositoryInput,
  GitHubIssuesApi,
  RawGitHubPullRequest,
  RawGitHubPullRequestFollowupState
} from "./issue-polling.js";
import {
  resolveEnvBackedValue,
  tryGetPullRequestFollowupState,
  tryListPullRequestsForBranch,
  tryMergePullRequest
} from "./issue-polling.js";
import type {
  ReviewFollowupContext,
  RunController,
  RunControllerProjectConfig
} from "./lifecycle/run-controller.js";
import type { RunStore, TrackedPullRequest } from "./run-store.js";

export type PullRequestFollowupPolicy = {
  enabled: boolean;
  maxReviewDispatchesPerPr: number;
  merge: {
    enabled: boolean;
    method: "merge" | "rebase" | "squash";
    requireReviewDecision: boolean;
    requireStatusSuccess: boolean;
  };
};

export type PullRequestFollowupResult =
  | { action: "disabled"; reason: string }
  | { action: "merged"; prNumber: number }
  | { action: "none"; reason: string }
  | { action: "review_dispatch"; prNumber: number; runId: string }
  | { action: "tracked"; count: number };

export type RunPullRequestFollowupOptions = {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger?: Logger;
  policy?: PullRequestFollowupPolicy;
  projectsLoader: () => Promise<Map<string, RunControllerProjectConfig>>;
  runController: RunController;
  runStore: RunStore;
};

export const DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY: PullRequestFollowupPolicy = {
  enabled: true,
  maxReviewDispatchesPerPr: 3,
  merge: {
    enabled: true,
    method: "squash",
    requireReviewDecision: false,
    requireStatusSuccess: true
  }
};

const mergeMethodSchema = z.enum(["merge", "rebase", "squash"]);
const pullRequestPolicySchema = z
  .object({
    pull_requests: z
      .object({
        enabled: z.boolean().optional(),
        merge: z
          .object({
            enabled: z.boolean().optional(),
            method: mergeMethodSchema.optional(),
            require_review_decision: z.boolean().optional(),
            require_status_success: z.boolean().optional()
          })
          .passthrough()
          .optional(),
        review_followup: z
          .object({
            max_dispatches_per_pr: z.number().int().nonnegative().optional()
          })
          .passthrough()
          .optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export async function runPullRequestFollowup(
  options: RunPullRequestFollowupOptions
): Promise<PullRequestFollowupResult> {
  const policy =
    options.policy ?? (await readPullRequestFollowupPolicy(options.configPath));
  if (!policy.enabled) {
    return { action: "disabled", reason: "pull request follow-up disabled" };
  }

  const env = options.env ?? process.env;
  const projects = await options.projectsLoader();
  const discovered = await discoverPullRequests({
    env,
    githubIssuesApi: options.githubIssuesApi,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    projects,
    runStore: options.runStore
  });
  const action = await processTrackedPullRequests({
    env,
    githubIssuesApi: options.githubIssuesApi,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    policy,
    projects,
    runController: options.runController,
    runStore: options.runStore
  });
  if (action.action !== "none") {
    return action;
  }
  if (discovered > 0) {
    return { action: "tracked", count: discovered };
  }
  return action;
}

export async function readPullRequestFollowupPolicy(
  configPath: string
): Promise<PullRequestFollowupPolicy> {
  let raw: unknown;
  try {
    raw = parse(await readFile(configPath, "utf8")) ?? {};
  } catch {
    return DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY;
  }
  const parsed = pullRequestPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY;
  }
  return pullRequestFollowupPolicyFromRaw(parsed.data) ?? DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY;
}

export function pullRequestFollowupPolicyFromRaw(
  raw: unknown
): PullRequestFollowupPolicy | undefined {
  const parsed = pullRequestPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const input = parsed.data.pull_requests;
  return {
    enabled: input?.enabled ?? DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.enabled,
    maxReviewDispatchesPerPr:
      input?.review_followup?.max_dispatches_per_pr ??
      DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.maxReviewDispatchesPerPr,
    merge: {
      enabled:
        input?.merge?.enabled ??
        DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.merge.enabled,
      method:
        input?.merge?.method ?? DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.merge.method,
      requireReviewDecision:
        input?.merge?.require_review_decision ??
        DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.merge.requireReviewDecision,
      requireStatusSuccess:
        input?.merge?.require_status_success ??
        DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.merge.requireStatusSuccess
    }
  };
}

export function pullRequestNeedsReviewFollowup(
  state: RawGitHubPullRequestFollowupState
): boolean {
  return (
    state.reviewDecision === "CHANGES_REQUESTED" ||
    state.unresolvedReviewThreads.length > 0
  );
}

export function pullRequestReadyToMerge(
  state: RawGitHubPullRequestFollowupState,
  policy: PullRequestFollowupPolicy = DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY
): boolean {
  if (!policy.merge.enabled || state.draft || state.merged || state.state !== "OPEN") {
    return false;
  }
  if (state.mergeable !== "MERGEABLE") {
    return false;
  }
  if (
    policy.merge.requireStatusSuccess &&
    state.statusCheckRollupState !== "SUCCESS"
  ) {
    return false;
  }
  if (
    policy.merge.requireReviewDecision &&
    state.reviewDecision !== "APPROVED"
  ) {
    return false;
  }
  return (
    state.reviewDecision !== "CHANGES_REQUESTED" &&
    state.reviewDecision !== "REVIEW_REQUIRED" &&
    state.unresolvedReviewThreads.length === 0
  );
}

export function reviewFeedbackFingerprint(
  state: RawGitHubPullRequestFollowupState
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        headSha: state.headSha,
        reviewDecision: state.reviewDecision,
        threads: state.unresolvedReviewThreads.map((thread) => ({
          comments: thread.comments.map((comment) => ({
            body: comment.body,
            createdAt: comment.createdAt,
            url: comment.url
          })),
          id: thread.id,
          isOutdated: thread.isOutdated,
          line: thread.line,
          path: thread.path
        }))
      })
    )
    .digest("hex")}`;
}

async function discoverPullRequests(input: {
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger?: Logger;
  projects: Map<string, RunControllerProjectConfig>;
  runStore: RunStore;
}): Promise<number> {
  let discovered = 0;
  for (const run of input.runStore.listRunsAwaitingPullRequestDiscovery()) {
    const project = input.projects.get(run.projectName);
    const repository = repositoryForProject(project, input.env);
    if (project === undefined || repository === undefined) {
      continue;
    }
    let pullRequests: RawGitHubPullRequest[] | undefined;
    try {
      pullRequests = await tryListPullRequestsForBranch(input.githubIssuesApi, {
        ...repository,
        branch: run.branchName
      });
    } catch (error) {
      input.logger?.warn(
        { branch: run.branchName, err: error },
        "symphonika PR follow-up discovery failed"
      );
      continue;
    }
    if (pullRequests === undefined) {
      input.logger?.debug(
        { branch: run.branchName },
        "symphonika PR follow-up discovery unavailable"
      );
      continue;
    }
    const pullRequest = selectOpenPullRequest(pullRequests, run.branchName);
    if (pullRequest === undefined) {
      input.runStore.recordPullRequestDiscoveryAttempt(run.runId);
      continue;
    }
    input.runStore.trackPullRequest({
      branchName: run.branchName,
      headSha: pullRequest.head?.sha ?? "",
      issueNumber: run.issueNumber,
      projectName: run.projectName,
      prNumber: pullRequest.number ?? 0,
      prUrl:
        pullRequest.html_url ??
        `https://github.com/${repository.owner}/${repository.repo}/pull/${pullRequest.number}`,
      runId: run.runId
    });
    discovered += 1;
  }
  return discovered;
}

async function processTrackedPullRequests(input: {
  env: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  logger?: Logger;
  policy: PullRequestFollowupPolicy;
  projects: Map<string, RunControllerProjectConfig>;
  runController: RunController;
  runStore: RunStore;
}): Promise<PullRequestFollowupResult> {
  for (const tracked of input.runStore.listOpenTrackedPullRequests()) {
    const project = input.projects.get(tracked.projectName);
    const repository = repositoryForProject(project, input.env);
    if (project === undefined || repository === undefined) {
      continue;
    }
    const state = await loadPullRequestState({
      api: input.githubIssuesApi,
      ...(input.logger === undefined ? {} : { logger: input.logger }),
      repository,
      tracked
    });
    if (state === undefined) {
      continue;
    }
    if (state === null) {
      input.runStore.recordPullRequestObservation({
        headSha: tracked.lastSeenHeadSha,
        id: tracked.id,
        prUrl: tracked.prUrl,
        state: "closed"
      });
      continue;
    }

    const trackingState = trackedStateFor(state);
    input.runStore.recordPullRequestObservation({
      headSha: state.headSha,
      id: tracked.id,
      prUrl: state.url,
      state: trackingState
    });
    if (trackingState !== "open") {
      continue;
    }

    if (pullRequestNeedsReviewFollowup(state)) {
      const result = await dispatchReviewFollowupIfNeeded({
        policy: input.policy,
        runController: input.runController,
        runStore: input.runStore,
        state,
        tracked
      });
      if (result !== undefined) {
        return result;
      }
      continue;
    }

    if (!pullRequestReadyToMerge(state, input.policy)) {
      continue;
    }
    // Defer to the workflow when a merge_pr state is parked on this issue —
    // otherwise the first-discovery tick would merge with the global method
    // before reEvaluateWaitingRun has a chance to apply the workflow's
    // method override and record merge_pr evidence. See ADR 0048.
    if (
      await input.runController.isIssueParkedInMergePrState({
        issueNumber: tracked.issueNumber,
        projectName: tracked.projectName
      })
    ) {
      input.logger?.info(
        { prNumber: tracked.prNumber, issueNumber: tracked.issueNumber },
        "symphonika PR follow-up merge deferred: workflow merge_pr state will handle"
      );
      continue;
    }
    const merged = await tryMergePullRequest(input.githubIssuesApi, {
      ...repository,
      expectedHeadSha: state.headSha,
      method: input.policy.merge.method,
      pullNumber: tracked.prNumber
    });
    if (!merged) {
      input.logger?.warn(
        { prNumber: tracked.prNumber },
        "symphonika PR follow-up cannot merge: merge API unavailable"
      );
      continue;
    }
    input.runStore.recordPullRequestObservation({
      headSha: state.headSha,
      id: tracked.id,
      prUrl: state.url,
      state: "merged"
    });
    return { action: "merged", prNumber: tracked.prNumber };
  }

  return { action: "none", reason: "no pull request follow-up action" };
}

async function dispatchReviewFollowupIfNeeded(input: {
  policy: PullRequestFollowupPolicy;
  runController: RunController;
  runStore: RunStore;
  state: RawGitHubPullRequestFollowupState;
  tracked: TrackedPullRequest;
}): Promise<PullRequestFollowupResult | undefined> {
  if (
    input.tracked.reviewDispatchCount >=
    input.policy.maxReviewDispatchesPerPr
  ) {
    return undefined;
  }

  const fingerprint = reviewFeedbackFingerprint(input.state);
  if (input.tracked.lastReviewDispatchFingerprint === fingerprint) {
    return undefined;
  }

  const result = await input.runController.dispatchReviewFollowup({
    issueNumber: input.tracked.issueNumber,
    parentRunId: input.tracked.lastFollowupRunId ?? input.tracked.runId,
    projectName: input.tracked.projectName,
    review: reviewContextFromState(input.state)
  });
  if (!result.dispatched) {
    return undefined;
  }

  input.runStore.recordPullRequestReviewDispatch({
    fingerprint,
    headSha: input.state.headSha,
    id: input.tracked.id,
    runId: result.runId
  });
  return {
    action: "review_dispatch",
    prNumber: input.tracked.prNumber,
    runId: result.runId
  };
}

async function loadPullRequestState(input: {
  api: GitHubIssuesApi;
  logger?: Logger;
  repository: GitHubIssueRepositoryInput;
  tracked: TrackedPullRequest;
}): Promise<RawGitHubPullRequestFollowupState | null | undefined> {
  try {
    return await tryGetPullRequestFollowupState(input.api, {
      ...input.repository,
      pullNumber: input.tracked.prNumber
    });
  } catch (error) {
    input.logger?.warn(
      { err: error, prNumber: input.tracked.prNumber },
      "symphonika PR follow-up poll failed"
    );
    return undefined;
  }
}

function repositoryForProject(
  project: RunControllerProjectConfig | undefined,
  env: NodeJS.ProcessEnv
): GitHubIssueRepositoryInput | undefined {
  if (project === undefined || project.disabled === true) {
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
  pullRequests: RawGitHubPullRequest[],
  branchName: string
): RawGitHubPullRequest | undefined {
  return pullRequests.find(
    (pullRequest) =>
      pullRequest.state === "open" &&
      pullRequest.draft !== true &&
      pullRequest.number !== undefined &&
      pullRequest.number > 0 &&
      pullRequest.head?.ref === branchName &&
      pullRequest.head.sha !== undefined &&
      pullRequest.head.sha.length > 0
  );
}

function trackedStateFor(
  state: RawGitHubPullRequestFollowupState
): "closed" | "merged" | "open" {
  if (state.merged || state.state === "MERGED") {
    return "merged";
  }
  if (state.state === "CLOSED") {
    return "closed";
  }
  return "open";
}

function reviewContextFromState(
  state: RawGitHubPullRequestFollowupState
): ReviewFollowupContext {
  return {
    headSha: state.headSha,
    pullRequestNumber: state.number,
    pullRequestUrl: state.url,
    reviewDecision: state.reviewDecision,
    statusCheckRollupState: state.statusCheckRollupState,
    unresolvedThreads: state.unresolvedReviewThreads
  };
}
