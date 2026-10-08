import { describe, expect, it, vi } from "vitest";

import type {
  GitHubIssuesApi,
  RawGitHubPullRequest
} from "../src/issue-polling.js";
import type { RunControllerProjectConfig } from "../src/lifecycle/run-controller.js";
import type { RunStore } from "../src/run-store.js";
import { createRoutineGithubObservation } from "../src/routines/github-observation.js";

const branchName = "sym/alpha/routine/audit/01TEST";
const project: RunControllerProjectConfig = {
  mode: "routine_host",
  name: "alpha",
  agent: { provider: "codex" },
  tracker: {
    kind: "github",
    owner: "pmatos",
    repo: "alpha",
    token: "$GITHUB_TOKEN"
  },
  workspace: { git: { base_branch: "main", remote: "origin" }, root: "." }
};

function observer(input: {
  pullRequests: RawGitHubPullRequest[][];
  runStore?: Pick<RunStore, "getRoutineFiring" | "recordRoutinePullRequest">;
}) {
  const listPullRequestsForBranch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(input.pullRequests.shift() ?? [])
    );
  const githubIssuesApi: GitHubIssuesApi = {
    listOpenIssues: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    listPullRequestsForBranch
  };
  const recordRoutinePullRequest = vi.fn();
  const runStore = input.runStore ?? {
    getRoutineFiring: vi.fn().mockReturnValue(undefined),
    recordRoutinePullRequest
  };
  return {
    listPullRequestsForBranch,
    observation: createRoutineGithubObservation({
      branchName,
      env: { GITHUB_TOKEN: "token" },
      firingId: "fire-1",
      githubIssuesApi,
      kind: "git",
      logger: undefined,
      project,
      routineName: "audit",
      runStore,
      since: "2026-05-22T00:00:00.000Z",
      claimUrlVerificationTimeoutMs: 1000
    }),
    recordRoutinePullRequest
  };
}

describe("Routine Firing GitHub observation", () => {
  it("observes a new closed PR but records only an open PR", async () => {
    const closed: RawGitHubPullRequest = {
      head: { ref: branchName, sha: "abc" },
      html_url: "https://github.com/pmatos/alpha/pull/42",
      number: 42,
      state: "closed"
    };
    const { observation, recordRoutinePullRequest } = observer({
      pullRequests: [[], [closed]]
    });
    const before = await observation.capture();
    const after = await observation.capture();

    expect(
      await observation.assess({ phase: "success", before, after, claim: null })
    ).toMatchObject({
      githubObservationAvailable: true,
      observedAction: { action: "pr", url: closed.html_url },
      pullRequestObserved: true
    });
    expect(recordRoutinePullRequest).not.toHaveBeenCalled();
  });

  it("does not discover or record PRs for a failed firing", async () => {
    const open: RawGitHubPullRequest = {
      head: { ref: branchName, sha: "def" },
      number: 43,
      state: "open"
    };
    const { observation, listPullRequestsForBranch, recordRoutinePullRequest } =
      observer({ pullRequests: [[], [open], [open]] });
    const before = await observation.capture();
    const after = await observation.capture();

    expect(
      await observation.assess({ phase: "failure", before, after })
    ).toMatchObject({
      observedAction: { action: "pr" },
      pullRequestObserved: true
    });
    expect(listPullRequestsForBranch).toHaveBeenCalledTimes(2);
    expect(recordRoutinePullRequest).not.toHaveBeenCalled();
  });
});
