import type { Logger } from "pino";

import {
  tryListBranchCommits,
  tryListPullRequestsForBranch,
  type GitHubIssueRepositoryInput,
  type GitHubIssuesApi
} from "../issue-polling.js";
import type { CapReachedKind } from "./terminal-reason.js";

export type ClassifyCapReachedOutcomeInput = {
  api: GitHubIssuesApi;
  branch: string;
  logger?: Logger | undefined;
  repository: GitHubIssueRepositoryInput;
};

export async function classifyCapReachedOutcome(
  input: ClassifyCapReachedOutcomeInput
): Promise<CapReachedKind> {
  if (input.branch === "") {
    return "no_commits";
  }

  try {
    const commits = await tryListBranchCommits(input.api, {
      ...input.repository,
      branch: input.branch,
      perPage: 1
    });
    if (commits === undefined) {
      input.logger?.warn(
        { branch: input.branch },
        "cap-reached classifier: listBranchCommits unavailable; classifying as unknown"
      );
      return "unknown";
    }
    if (commits === null || commits.length === 0) {
      return "no_commits";
    }

    const prs = await tryListPullRequestsForBranch(input.api, {
      ...input.repository,
      branch: input.branch
    });
    if (prs === undefined) {
      input.logger?.warn(
        { branch: input.branch },
        "cap-reached classifier: listPullRequestsForBranch unavailable; classifying as unknown"
      );
      return "unknown";
    }
    if (prs.length === 0) {
      return "no_pr";
    }
    if (prs.some((pr) => pr.merged_at != null)) {
      return "work_landed";
    }
    return "no_pr";
  } catch (error) {
    input.logger?.warn(
      { branch: input.branch, err: error },
      "cap-reached classifier: GitHub call failed; classifying as unknown"
    );
    return "unknown";
  }
}
