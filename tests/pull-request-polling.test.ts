import { describe, expect, it } from "vitest";

import type {
  GitHubIssuesApi,
  PollingServiceConfig,
  RawGitHubPullRequestFollowupState
} from "../src/issue-polling.js";
import {
  classifyPullRequestBranchOrigin,
  pollConfiguredGitHubPullRequestsFromConfig,
  PULL_REQUEST_ENRICHMENT_CONCURRENCY
} from "../src/pull-request-polling.js";

describe("classifyPullRequestBranchOrigin (#309, ADR 0077)", () => {
  it("classifies a Symphonika Issue Branch", () => {
    expect(classifyPullRequestBranchOrigin("sym/alpha/42-fix-login")).toBe(
      "issue_branch"
    );
  });

  it("classifies a Symphonika Routine Firing branch", () => {
    expect(
      classifyPullRequestBranchOrigin(
        "sym/alpha/routine/nightly-audit/abc1234567"
      )
    ).toBe("routine_firing_branch");
  });

  it("classifies a non-Symphonika branch as neither", () => {
    expect(classifyPullRequestBranchOrigin("feature/manual-branch")).toBe(
      "neither"
    );
  });

  it("classifies a missing ref as neither", () => {
    expect(classifyPullRequestBranchOrigin(undefined)).toBe("neither");
  });
});

type TestProject = PollingServiceConfig["projects"][number];

function project(overrides: Partial<TestProject> = {}): TestProject {
  return {
    agent: { provider: "codex" },
    issue_filters: { labels_all: [], labels_none: [], states: ["open"] },
    name: "alpha",
    priority: { default: 0, labels: {} },
    tracker: {
      kind: "github",
      owner: "pmatos",
      repo: "symphonika",
      token: "$GITHUB_TOKEN"
    },
    ...overrides
  };
}

describe("pollConfiguredGitHubPullRequestsFromConfig (#309, ADR 0077)", () => {
  it("persists the cheap REST fields even when per-PR state enrichment fails", async () => {
    const api: GitHubIssuesApi = {
      getPullRequestFollowupState: () =>
        Promise.reject(new Error("rate limited")),
      listOpenIssues: () => Promise.resolve([]),
      listPullRequests: () =>
        Promise.resolve([
          {
            draft: false,
            head: { ref: "sym/alpha/1-fix", sha: "abc123" },
            html_url: "https://github.com/pmatos/symphonika/pull/246",
            merged_at: null,
            number: 246,
            state: "open",
            title: "Fix login"
          }
        ])
    };
    const status = await pollConfiguredGitHubPullRequestsFromConfig({
      config: { projects: [project()] },
      env: { GITHUB_TOKEN: "secret" },
      githubIssuesApi: api
    });

    expect(status.projects).toEqual([
      {
        fetchedPullRequests: 1,
        lastPolledAt: expect.any(String) as string,
        name: "alpha",
        ok: true
      }
    ]);
    expect(status.pullRequests).toHaveLength(1);
    expect(status.pullRequests[0]).toMatchObject({
      branchOrigin: "issue_branch",
      checks: null,
      draft: false,
      headRef: "sym/alpha/1-fix",
      headSha: "abc123",
      mergeable: null,
      merged: false,
      open: true,
      prNumber: 246,
      project: "alpha",
      stateAvailable: false,
      title: "Fix login"
    });
  });

  it("caps concurrent per-PR state fetches instead of bursting every open PR at once", async () => {
    const totalPullRequests = PULL_REQUEST_ENRICHMENT_CONCURRENCY * 3;
    let inFlight = 0;
    let maxInFlight = 0;
    const api: GitHubIssuesApi = {
      getPullRequestFollowupState: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield so overlapping calls actually overlap rather than each
        // resolving synchronously before the next one starts.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const fixture: RawGitHubPullRequestFollowupState = {
          draft: false,
          headSha: "abc123",
          mergeable: "MERGEABLE",
          merged: false,
          number: 1,
          reviewDecision: "APPROVED",
          state: "OPEN",
          statusCheckRollupState: "SUCCESS",
          unresolvedReviewThreads: [],
          url: "https://github.com/pmatos/symphonika/pull/1"
        };
        return fixture;
      },
      listOpenIssues: () => Promise.resolve([]),
      listPullRequests: () =>
        Promise.resolve(
          Array.from({ length: totalPullRequests }, (_, index) => ({
            draft: false,
            head: { ref: `sym/alpha/${index}-fix`, sha: "abc123" },
            html_url: `https://github.com/pmatos/symphonika/pull/${index}`,
            merged_at: null,
            number: index,
            state: "open" as const,
            title: `Fix ${index}`
          }))
        )
    };
    const status = await pollConfiguredGitHubPullRequestsFromConfig({
      config: { projects: [project()] },
      env: { GITHUB_TOKEN: "secret" },
      githubIssuesApi: api
    });

    expect(status.pullRequests).toHaveLength(totalPullRequests);
    expect(maxInFlight).toBeLessThanOrEqual(
      PULL_REQUEST_ENRICHMENT_CONCURRENCY
    );
    // Concurrency was actually exercised, not accidentally serialized down
    // to 1 by the test fixture itself.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("enriches with Symphonika's Pull Request State when available", async () => {
    const followup: RawGitHubPullRequestFollowupState = {
      draft: false,
      headSha: "def456",
      mergeable: "MERGEABLE",
      merged: false,
      number: 247,
      reviewDecision: "APPROVED",
      state: "OPEN",
      statusCheckRollupState: "SUCCESS",
      unresolvedReviewThreads: [],
      url: "https://github.com/pmatos/symphonika/pull/247"
    };
    const api: GitHubIssuesApi = {
      getPullRequestFollowupState: () => Promise.resolve(followup),
      listOpenIssues: () => Promise.resolve([]),
      listPullRequests: () =>
        Promise.resolve([
          {
            draft: false,
            head: { ref: "sym/alpha/2-fix", sha: "def456" },
            html_url: "https://github.com/pmatos/symphonika/pull/247",
            merged_at: null,
            number: 247,
            state: "open",
            title: "Fix logout"
          }
        ])
    };
    const status = await pollConfiguredGitHubPullRequestsFromConfig({
      config: { projects: [project()] },
      env: { GITHUB_TOKEN: "secret" },
      githubIssuesApi: api
    });

    expect(status.pullRequests[0]).toMatchObject({
      checks: "success",
      mergeable: "mergeable",
      reviewDecision: "approved",
      stateAvailable: true,
      trackingState: "open",
      unresolvedReviewThreads: 0
    });
  });

  it("records a token-resolution error without listing pull requests", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([]),
      listPullRequests: () => Promise.resolve([])
    };
    const status = await pollConfiguredGitHubPullRequestsFromConfig({
      config: {
        projects: [
          project({
            tracker: {
              kind: "github",
              owner: "pmatos",
              repo: "symphonika",
              token: "$MISSING_TOKEN"
            }
          })
        ]
      },
      env: {},
      githubIssuesApi: api
    });

    expect(status.errors).toEqual([
      "projects.alpha.tracker.token references unset environment variable $MISSING_TOKEN"
    ]);
    expect(status.projects).toEqual([
      {
        error:
          "projects.alpha.tracker.token references unset environment variable $MISSING_TOKEN",
        fetchedPullRequests: 0,
        lastPolledAt: expect.any(String) as string,
        name: "alpha",
        ok: false
      }
    ]);
    expect(status.pullRequests).toEqual([]);
  });

  it("skips a disabled project", async () => {
    const api: GitHubIssuesApi = {
      listOpenIssues: () => Promise.resolve([]),
      listPullRequests: () => Promise.reject(new Error("should not be called"))
    };
    const status = await pollConfiguredGitHubPullRequestsFromConfig({
      config: { projects: [project({ disabled: true })] },
      env: { GITHUB_TOKEN: "secret" },
      githubIssuesApi: api
    });
    expect(status.projects).toEqual([]);
    expect(status.pullRequests).toEqual([]);
  });
});
