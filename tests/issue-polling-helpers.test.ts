import { describe, expect, it } from "vitest";

import {
  tryAddLabelsToIssue,
  tryGetIssue,
  type GitHubIssueLabelInput,
  type GitHubIssueRepositoryInput,
  type GitHubIssuesApi,
  type RawGitHubIssue
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
