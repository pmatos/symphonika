import { beforeEach, describe, expect, it, vi } from "vitest";

const issuesUpdate = vi.fn();
const issuesCreateComment = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(function MockOctokit() {
    return {
      rest: {
        issues: {
          createComment: issuesCreateComment,
          update: issuesUpdate
        }
      }
    };
  })
}));

const { DEFAULT_GITHUB_ISSUES_API } = await import("../src/issue-polling.js");

describe("OctokitGitHubIssuesApi.closeIssue", () => {
  beforeEach(() => {
    issuesUpdate.mockReset().mockResolvedValue({ data: {} });
  });

  it("closes the issue with state_reason completed", async () => {
    await DEFAULT_GITHUB_ISSUES_API.closeIssue?.({
      issueNumber: 213,
      owner: "pmatos",
      repo: "forseti",
      stateReason: "completed",
      token: "secret"
    });

    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 213,
        owner: "pmatos",
        repo: "forseti",
        state: "closed",
        state_reason: "completed"
      })
    );
  });

  it("closes the issue with state_reason not_planned", async () => {
    await DEFAULT_GITHUB_ISSUES_API.closeIssue?.({
      issueNumber: 7,
      owner: "pmatos",
      repo: "symphonika",
      stateReason: "not_planned",
      token: "secret"
    });

    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        owner: "pmatos",
        repo: "symphonika",
        state: "closed",
        state_reason: "not_planned"
      })
    );
  });

  it("forwards an abort signal under request, matching the label-write methods", async () => {
    const controller = new AbortController();
    await DEFAULT_GITHUB_ISSUES_API.closeIssue?.({
      issueNumber: 1,
      owner: "pmatos",
      repo: "symphonika",
      signal: controller.signal,
      stateReason: "completed",
      token: "secret"
    });

    expect(issuesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { signal: controller.signal }
      })
    );
  });
});

describe("OctokitGitHubIssuesApi.addIssueComment", () => {
  beforeEach(() => {
    issuesCreateComment.mockReset().mockResolvedValue({ data: {} });
  });

  it("posts the comment body to the issue", async () => {
    await DEFAULT_GITHUB_ISSUES_API.addIssueComment?.({
      body: "Part of this issue landed in #252; remaining scope tracked here.",
      issueNumber: 213,
      owner: "pmatos",
      repo: "forseti",
      token: "secret"
    });

    expect(issuesCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Part of this issue landed in #252; remaining scope tracked here.",
        issue_number: 213,
        owner: "pmatos",
        repo: "forseti"
      })
    );
  });
});
