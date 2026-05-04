import { describe, expect, it, vi } from "vitest";

import type { GitHubIssuesApi } from "../src/issue-polling.js";
import { classifyCapReachedOutcome } from "../src/lifecycle/cap-reached-context.js";

const repository = {
  owner: "pmatos",
  repo: "symphonika",
  token: "secret"
};

const baseApi: GitHubIssuesApi = {
  listOpenIssues: () => Promise.resolve([])
};

describe("classifyCapReachedOutcome", () => {
  it("returns no_commits when the branch is empty", async () => {
    const kind = await classifyCapReachedOutcome({
      api: baseApi,
      branch: "",
      repository
    });
    expect(kind).toBe("no_commits");
  });

  it("returns no_commits when listBranchCommits reports the branch missing (404) and no PR exists", async () => {
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue(null),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([])
    };
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("no_commits");
  });

  it("returns unknown when the branch is missing and listPullRequestsForBranch is unavailable", async () => {
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue(null)
      // listPullRequestsForBranch intentionally absent
    };
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("unknown");
  });

  it("returns work_landed when the branch is missing (auto-deleted) but a merged PR still exists", async () => {
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue(null),
      listPullRequestsForBranch: vi
        .fn()
        .mockResolvedValue([
          { merged_at: "2026-05-04T00:00:00Z", number: 9, state: "closed" }
        ])
    };
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("work_landed");
  });

  it("returns no_commits when the branch reports zero commits", async () => {
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([])
    };
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("no_commits");
  });

  it("returns unknown when listBranchCommits is not implemented on the API", async () => {
    const kind = await classifyCapReachedOutcome({
      api: baseApi,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("unknown");
  });

  it("returns no_pr when commits exist but no pull requests are open or closed", async () => {
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([{ sha: "abc" }]),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([])
    };
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("no_pr");
  });

  it("returns no_pr when PRs exist but none have merged_at set", async () => {
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([{ sha: "abc" }]),
      listPullRequestsForBranch: vi
        .fn()
        .mockResolvedValue([
          { merged_at: null, number: 7, state: "open" },
          { merged_at: null, number: 8, state: "closed" }
        ])
    };
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("no_pr");
  });

  it("returns unknown when listBranchCommits throws (never rethrows)", async () => {
    const warn = vi.fn();
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockRejectedValue(new Error("boom")),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([])
    };
    const logger = { warn } as unknown as Parameters<
      typeof classifyCapReachedOutcome
    >[0]["logger"];
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      logger,
      repository
    });
    expect(kind).toBe("unknown");
    expect(warn).toHaveBeenCalled();
  });

  it("returns work_landed when at least one PR has a merged_at timestamp", async () => {
    const api: GitHubIssuesApi = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([{ sha: "abc" }]),
      listPullRequestsForBranch: vi
        .fn()
        .mockResolvedValue([
          { merged_at: null, number: 7, state: "closed" },
          { merged_at: "2026-05-04T00:00:00Z", number: 8, state: "closed" }
        ])
    };
    const kind = await classifyCapReachedOutcome({
      api,
      branch: "feature/x",
      repository
    });
    expect(kind).toBe("work_landed");
  });
});
