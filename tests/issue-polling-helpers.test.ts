import { describe, expect, it } from "vitest";

import {
  fetchIssueDependencies,
  fetchPullRequestFollowupState,
  swallowLabelNotFound,
  tryAddLabelsToIssue,
  tryGetIssue,
  tryListBranchCommits,
  tryListPullRequests,
  tryListPullRequestsForBranch,
  tryRemoveLabelsFromIssue,
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

describe("tryRemoveLabelsFromIssue", () => {
  it("returns false when the implementation does not provide removeLabelsFromIssue", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryRemoveLabelsFromIssue(api, labelInput)).toBe(false);
  });

  it("propagates a non-404 error thrown by the implementation", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([]),
      removeLabelsFromIssue: () => Promise.reject(new Error("boom"))
    };
    await expect(tryRemoveLabelsFromIssue(api, labelInput)).rejects.toThrow(
      "boom"
    );
  });

  it("propagates a 404 thrown by the implementation -- idempotent-removal handling lives in removeLabelsFromIssue's own per-label loop, not here", async () => {
    // A wrapper-level catch here can only see "did the whole (possibly
    // multi-label) call throw", not which individual label 404d -- so it
    // can't distinguish "the only requested label was absent" from "an
    // earlier label was absent and a later one was never attempted". See
    // swallowLabelNotFound / OctokitGitHubIssuesApi.removeLabelsFromIssue.
    const notFound = Object.assign(new Error("Label does not exist"), {
      status: 404
    });
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([]),
      removeLabelsFromIssue: () => Promise.reject(notFound)
    };
    await expect(tryRemoveLabelsFromIssue(api, labelInput)).rejects.toThrow(
      "Label does not exist"
    );
  });
});

describe("swallowLabelNotFound", () => {
  it("resolves without throwing when the attempt 404s with GitHub's absent-label message", async () => {
    const labelNotFound = Object.assign(new Error("Label does not exist"), {
      status: 404
    });
    await expect(
      swallowLabelNotFound(() => Promise.reject(labelNotFound))
    ).resolves.toBeUndefined();
  });

  it("propagates a 404 whose message does not identify an absent label -- e.g. the issue or repo itself is missing/inaccessible", async () => {
    // GitHub's remove-label endpoint 404s for more than one reason (label
    // absent, issue absent, repo absent/inaccessible); only the first is
    // safe to treat as an idempotent no-op. A generic "Not Found" must
    // still surface as a real failure, not a false success.
    const genericNotFound = Object.assign(new Error("Not Found"), {
      status: 404
    });
    await expect(
      swallowLabelNotFound(() => Promise.reject(genericNotFound))
    ).rejects.toThrow("Not Found");
  });

  it("propagates a non-404 error from the attempt", async () => {
    await expect(
      swallowLabelNotFound(() => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
  });

  it("resolves normally when the attempt succeeds", async () => {
    let called = false;
    await swallowLabelNotFound(() => {
      called = true;
      return Promise.resolve();
    });
    expect(called).toBe(true);
  });

  it("lets a loop continue past an absent-label 404 to reach a later attempt -- the bug this exists to fix", async () => {
    const labelNotFound = Object.assign(new Error("Label does not exist"), {
      status: 404
    });
    const attempted: string[] = [];
    const labels = ["sym:stale", "agent-ready"];
    for (const label of labels) {
      await swallowLabelNotFound(() => {
        attempted.push(label);
        return label === "sym:stale"
          ? Promise.reject(labelNotFound)
          : Promise.resolve();
      });
    }
    expect(attempted).toEqual(["sym:stale", "agent-ready"]);
  });
});

describe("tryGetIssue", () => {
  it("preserves `this` when invoking a class-based implementation", async () => {
    class Api {
      readonly received: Array<{ issueNumber: number }> = [];
      getIssue(
        input: GitHubIssueRepositoryInput & { issueNumber: number }
      ): Promise<RawGitHubIssue> {
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
    const calls: Array<{ query: string; variables: Record<string, unknown> }> =
      [];
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
    expect(state?.unresolvedReviewThreads.map((thread) => thread.id)).toEqual([
      "only"
    ]);
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
    expect(state?.unresolvedReviewThreads.map((thread) => thread.id)).toEqual([
      "open"
    ]);
  });
});

describe("fetchIssueDependencies", () => {
  it("returns an empty blockedBy list for an issue with no dependencies", async () => {
    const executor: GraphqlExecutor = () =>
      Promise.resolve({
        repository: {
          i299: { blockedBy: { nodes: [], totalCount: 0 }, number: 299 }
        }
      });

    const result = await fetchIssueDependencies(executor, {
      issueNumbers: [299],
      owner: "pmatos",
      repo: "symphonika",
      token: "secret"
    });

    expect(result.get(299)).toEqual({ blockedBy: [], truncated: false });
  });

  it("classifies blockers by state and marks unresolved ones distinctly from closed ones", async () => {
    const executor: GraphqlExecutor = () =>
      Promise.resolve({
        repository: {
          i299: {
            blockedBy: {
              nodes: [
                {
                  number: 295,
                  repository: { name: "symphonika", owner: { login: "pmatos" } },
                  state: "CLOSED",
                  title: "slice 6"
                },
                {
                  number: 301,
                  repository: { name: "symphonika", owner: { login: "pmatos" } },
                  state: "OPEN",
                  title: "sibling slice"
                }
              ],
              totalCount: 2
            },
            number: 299
          }
        }
      });

    const result = await fetchIssueDependencies(executor, {
      issueNumbers: [299],
      owner: "pmatos",
      repo: "symphonika",
      token: "secret"
    });

    expect(result.get(299)).toEqual({
      blockedBy: [
        {
          number: 295,
          owner: "pmatos",
          repo: "symphonika",
          state: "CLOSED",
          title: "slice 6"
        },
        {
          number: 301,
          owner: "pmatos",
          repo: "symphonika",
          state: "OPEN",
          title: "sibling slice"
        }
      ],
      truncated: false
    });
  });

  it("resolves a cross-repo blocker using its own repository, not the polled repo", async () => {
    const executor: GraphqlExecutor = () =>
      Promise.resolve({
        repository: {
          i10: {
            blockedBy: {
              nodes: [
                {
                  number: 4,
                  repository: { name: "other-repo", owner: { login: "someone-else" } },
                  state: "OPEN",
                  title: "external blocker"
                }
              ],
              totalCount: 1
            },
            number: 10
          }
        }
      });

    const result = await fetchIssueDependencies(executor, {
      issueNumbers: [10],
      owner: "pmatos",
      repo: "symphonika",
      token: "secret"
    });

    expect(result.get(10)?.blockedBy).toEqual([
      {
        number: 4,
        owner: "someone-else",
        repo: "other-repo",
        state: "OPEN",
        title: "external blocker"
      }
    ]);
  });

  it("marks an issue truncated when totalCount exceeds the fetched blockers", async () => {
    const executor: GraphqlExecutor = () =>
      Promise.resolve({
        repository: {
          i50: {
            blockedBy: {
              nodes: [
                {
                  number: 1,
                  repository: { name: "symphonika", owner: { login: "pmatos" } },
                  state: "OPEN",
                  title: "one of many"
                }
              ],
              totalCount: 30
            },
            number: 50
          }
        }
      });

    const result = await fetchIssueDependencies(executor, {
      issueNumbers: [50],
      owner: "pmatos",
      repo: "symphonika",
      token: "secret"
    });

    expect(result.get(50)?.truncated).toBe(true);
  });

  it("batches every requested issue into a single GraphQL call", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> =
      [];
    const executor: GraphqlExecutor = (query, variables) => {
      calls.push({ query, variables });
      return Promise.resolve({
        repository: {
          i1: { blockedBy: { nodes: [], totalCount: 0 }, number: 1 },
          i2: { blockedBy: { nodes: [], totalCount: 0 }, number: 2 }
        }
      });
    };

    const result = await fetchIssueDependencies(executor, {
      issueNumbers: [1, 2],
      owner: "pmatos",
      repo: "symphonika",
      token: "secret"
    });

    expect(calls).toHaveLength(1);
    expect(result.get(1)).toEqual({ blockedBy: [], truncated: false });
    expect(result.get(2)).toEqual({ blockedBy: [], truncated: false });
  });

  it("splits a large issue list into chunked GraphQL calls instead of one unbounded query", async () => {
    const issueNumbers = Array.from({ length: 45 }, (_, index) => index + 1);
    const calls: number[][] = [];
    const executor: GraphqlExecutor = (query, variables) => {
      const owner = variables.owner as string;
      const repo = variables.repo as string;
      expect(owner).toBe("pmatos");
      expect(repo).toBe("symphonika");
      const aliasMatches = [...query.matchAll(/i(\d+): issue\(/g)].map((match) =>
        Number(match[1])
      );
      calls.push(aliasMatches);
      const repository: Record<
        string,
        { blockedBy: { nodes: never[]; totalCount: number }; number: number }
      > = {};
      for (const issueNumber of aliasMatches) {
        repository[`i${issueNumber}`] = {
          blockedBy: { nodes: [], totalCount: 0 },
          number: issueNumber
        };
      }
      return Promise.resolve({ repository });
    };

    const result = await fetchIssueDependencies(executor, {
      issueNumbers,
      owner: "pmatos",
      repo: "symphonika",
      token: "secret"
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flat().sort((a, b) => a - b)).toEqual(issueNumbers);
    expect(result.size).toBe(45);
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
    expect(
      await tryListPullRequestsForBranch(api, branchInput)
    ).toBeUndefined();
  });
});

const repoInput: GitHubIssueRepositoryInput = {
  owner: "pmatos",
  repo: "symphonika",
  token: "secret"
};

describe("tryListPullRequests", () => {
  it("preserves `this` when invoking a class-based implementation", async () => {
    class Api {
      readonly received: GitHubIssueRepositoryInput[] = [];
      listOpenIssues(): Promise<never[]> {
        return Promise.resolve([]);
      }
      listPullRequests(
        input: GitHubIssueRepositoryInput
      ): Promise<RawGitHubPullRequest[]> {
        this.received.push(input);
        return Promise.resolve([{ number: 7, merged_at: null }]);
      }
    }
    const api = new Api();
    const result = await tryListPullRequests(api, repoInput);
    expect(api.received).toEqual([repoInput]);
    expect(result).toEqual([{ number: 7, merged_at: null }]);
  });

  it("returns undefined when the implementation does not provide listPullRequests", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([])
    };
    expect(await tryListPullRequests(api, repoInput)).toBeUndefined();
  });
});
