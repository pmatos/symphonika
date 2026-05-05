import { describe, expect, it } from "vitest";

import {
  fetchPullRequestFollowupState,
  tryAddLabelsToIssue,
  tryGetIssue,
  tryListBranchCommits,
  tryListPullRequestsForBranch,
  type GitHubIssueLabelInput,
  type GitHubIssueRepositoryInput,
  type GitHubIssuesApi,
  type GitHubPullRequestInput,
  type GraphqlExecutor,
  type RawGitHubCommit,
  type RawGitHubIssue,
  type RawGitHubPullRequest
} from "../src/issue-polling.js";

const labelInput: GitHubIssueLabelInput = {
  issueNumber: 1,
  labels: ["sym:stale"],
  owner: "pmatos",
  repo: "symphonika",
  token: "secret"
};

const fetchInput: GitHubIssueRepositoryInput & { issueNumber: number } = {
  issueNumber: 1,
  owner: "pmatos",
  repo: "symphonika",
  token: "secret"
};

describe("tryAddLabelsToIssue", () => {
  it("preserves `this` when invoking a class-based implementation", async () => {
    class Api {
      readonly received: GitHubIssueLabelInput[] = [];
      addLabelsToIssue(input: GitHubIssueLabelInput): Promise<void> {
        this.received.push(input);
        return Promise.resolve();
      }
      listOpenIssues(): Promise<never[]> {
        return Promise.resolve([]);
      }
    }
    const api = new Api();
    const called = await tryAddLabelsToIssue(api, labelInput);
    expect(called).toBe(true);
    expect(api.received).toEqual([labelInput]);
  });

  it("returns false when the implementation does not provide addLabelsToIssue", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryAddLabelsToIssue(api, labelInput)).toBe(false);
  });

  it("propagates errors thrown by the implementation", async () => {
    const api: GitHubIssuesApi = {
      addLabelsToIssue: () => Promise.reject(new Error("boom")),
      listOpenIssues: () => Promise.resolve([])
    };
    await expect(tryAddLabelsToIssue(api, labelInput)).rejects.toThrow("boom");
  });
});

describe("tryGetIssue", () => {
  it("preserves `this` when invoking a class-based implementation", async () => {
    class Api {
      readonly received: Array<{ issueNumber: number }> = [];
      getIssue(input: GitHubIssueRepositoryInput & { issueNumber: number }): Promise<RawGitHubIssue> {
        this.received.push({ issueNumber: input.issueNumber });
        return Promise.resolve({ number: input.issueNumber, state: "open" });
      }
      listOpenIssues(): Promise<never[]> {
        return Promise.resolve([]);
      }
    }
    const api = new Api();
    const result = await tryGetIssue(api, fetchInput);
    expect(api.received).toEqual([{ issueNumber: 1 }]);
    expect(result).toEqual({ number: 1, state: "open" });
  });

  it("returns undefined when the implementation does not provide getIssue", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryGetIssue(api, fetchInput)).toBeUndefined();
  });

  it("returns null when the implementation reports the issue is missing", async () => {
    const api: GitHubIssuesApi = {
      getIssue: () => Promise.resolve(null),
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryGetIssue(api, fetchInput)).toBeNull();
  });
});

const branchInput: GitHubIssueRepositoryInput & { branch: string } = {
  branch: "symphonika/issue65",
  owner: "pmatos",
  repo: "symphonika",
  token: "secret"
};

describe("tryListBranchCommits", () => {
  it("preserves `this` when invoking a class-based implementation", async () => {
    class Api {
      readonly received: string[] = [];
      listOpenIssues(): Promise<never[]> {
        return Promise.resolve([]);
      }
      listBranchCommits(
        input: GitHubIssueRepositoryInput & { branch: string }
      ): Promise<RawGitHubCommit[] | null> {
        this.received.push(input.branch);
        return Promise.resolve([{ sha: "abc" }]);
      }
    }
    const api = new Api();
    const result = await tryListBranchCommits(api, branchInput);
    expect(api.received).toEqual(["symphonika/issue65"]);
    expect(result).toEqual([{ sha: "abc" }]);
  });

  it("returns undefined when the implementation does not provide listBranchCommits", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryListBranchCommits(api, branchInput)).toBeUndefined();
  });

  it("propagates null when the branch is missing", async () => {
    const api: GitHubIssuesApi = {
      listBranchCommits: () => Promise.resolve(null),
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryListBranchCommits(api, branchInput)).toBeNull();
  });
});

const followupInput: GitHubPullRequestInput = {
  owner: "pmatos",
  pullNumber: 83,
  repo: "symphonika",
  token: "secret"
};

function buildPullRequestPage(
  threadIds: string[],
  options: { hasNextPage: boolean; endCursor: string | null }
): unknown {
  return {
    repository: {
      pullRequest: {
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }]
        },
        headRefOid: "deadbeef",
        isDraft: false,
        mergeable: "MERGEABLE",
        merged: false,
        number: followupInput.pullNumber,
        reviewDecision: "REVIEW_REQUIRED",
        reviewThreads: {
          nodes: threadIds.map((id, index) => ({
            comments: { nodes: [] },
            id,
            isOutdated: false,
            isResolved: false,
            line: index,
            path: `src/file-${id}.ts`
          })),
          pageInfo: {
            endCursor: options.endCursor,
            hasNextPage: options.hasNextPage
          }
        },
        state: "OPEN",
        url: "https://github.com/pmatos/symphonika/pull/83"
      }
    }
  };
}

function buildContinuationPage(
  threadIds: string[],
  options: { hasNextPage: boolean; endCursor: string | null }
): unknown {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: threadIds.map((id, index) => ({
            comments: { nodes: [] },
            id,
            isOutdated: false,
            isResolved: false,
            line: 100 + index,
            path: `src/file-${id}.ts`
          })),
          pageInfo: {
            endCursor: options.endCursor,
            hasNextPage: options.hasNextPage
          }
        }
      }
    }
  };
}

describe("fetchPullRequestFollowupState", () => {
  it("aggregates unresolved review threads across pagination boundaries", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const executor: GraphqlExecutor = (query, variables) => {
      calls.push({ query, variables });
      if (calls.length === 1) {
        return Promise.resolve(
          buildPullRequestPage(["t1", "t2"], {
            endCursor: "cursor-1",
            hasNextPage: true
          })
        );
      }
      if (calls.length === 2) {
        return Promise.resolve(
          buildContinuationPage(["t3", "t4"], {
            endCursor: "cursor-2",
            hasNextPage: true
          })
        );
      }
      return Promise.resolve(
        buildContinuationPage(["t5"], { endCursor: null, hasNextPage: false })
      );
    };

    const state = await fetchPullRequestFollowupState(executor, followupInput);

    expect(state).not.toBeNull();
    expect(state?.unresolvedReviewThreads.map((thread) => thread.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5"
    ]);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.variables).toMatchObject({ after: "cursor-1" });
    expect(calls[2]?.variables).toMatchObject({ after: "cursor-2" });
  });

  it("returns null when the pull request is missing", async () => {
    const executor: GraphqlExecutor = () =>
      Promise.resolve({ repository: { pullRequest: null } });
    const state = await fetchPullRequestFollowupState(executor, followupInput);
    expect(state).toBeNull();
  });

  it("stops paginating when hasNextPage is false even if endCursor is present", async () => {
    let callCount = 0;
    const executor: GraphqlExecutor = () => {
      callCount += 1;
      return Promise.resolve(
        buildPullRequestPage(["only"], {
          endCursor: "cursor-x",
          hasNextPage: false
        })
      );
    };

    const state = await fetchPullRequestFollowupState(executor, followupInput);

    expect(callCount).toBe(1);
    expect(state?.unresolvedReviewThreads.map((thread) => thread.id)).toEqual(["only"]);
  });

  it("filters resolved threads after pagination completes", async () => {
    const executor: GraphqlExecutor = () =>
      Promise.resolve({
        repository: {
          pullRequest: {
            commits: { nodes: [] },
            headRefOid: "sha",
            isDraft: false,
            mergeable: "MERGEABLE",
            merged: false,
            number: followupInput.pullNumber,
            reviewDecision: "REVIEW_REQUIRED",
            reviewThreads: {
              nodes: [
                {
                  comments: { nodes: [] },
                  id: "open",
                  isOutdated: false,
                  isResolved: false,
                  line: 1,
                  path: "src/a.ts"
                },
                {
                  comments: { nodes: [] },
                  id: "closed",
                  isOutdated: false,
                  isResolved: true,
                  line: 2,
                  path: "src/b.ts"
                }
              ],
              pageInfo: { endCursor: null, hasNextPage: false }
            },
            state: "OPEN",
            url: "u"
          }
        }
      });
    const state = await fetchPullRequestFollowupState(executor, followupInput);
    expect(state?.unresolvedReviewThreads.map((thread) => thread.id)).toEqual(["open"]);
  });
});

describe("tryListPullRequestsForBranch", () => {
  it("preserves `this` when invoking a class-based implementation", async () => {
    class Api {
      readonly received: string[] = [];
      listOpenIssues(): Promise<never[]> {
        return Promise.resolve([]);
      }
      listPullRequestsForBranch(
        input: GitHubIssueRepositoryInput & { branch: string }
      ): Promise<RawGitHubPullRequest[]> {
        this.received.push(input.branch);
        return Promise.resolve([{ number: 7, merged_at: null }]);
      }
    }
    const api = new Api();
    const result = await tryListPullRequestsForBranch(api, branchInput);
    expect(api.received).toEqual(["symphonika/issue65"]);
    expect(result).toEqual([{ number: 7, merged_at: null }]);
  });

  it("returns undefined when the implementation does not provide listPullRequestsForBranch", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryListPullRequestsForBranch(api, branchInput)).toBeUndefined();
  });
});
