import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  GitHubIssuesApi,
  RawGitHubIssue,
  RawGitHubPullRequest
} from "../src/issue-polling.js";
import type { RunControllerProjectConfig } from "../src/lifecycle/run-controller.js";
import {
  createRoutineGithubObservation,
  type RoutineGithubCapture
} from "../src/routines/github-observation.js";
import type {
  RoutineGithubSnapshot,
  RoutineOutcomeClaim
} from "../src/routines/outcome.js";

const branchName = "sym/alpha/routine/audit/01TEST";
const since = "2026-05-22T00:00:00.000Z";
const inWindow = "2026-05-22T01:00:00.000Z";
const beforeWindow = "2026-05-21T01:00:00.000Z";

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

type WithUndefined<T> = { [K in keyof T]?: T[K] | undefined };

function branchPullRequest(
  number: number,
  overrides: WithUndefined<RawGitHubPullRequest> = {}
): RawGitHubPullRequest {
  return {
    head: { ref: branchName, sha: `sha-${number}` },
    html_url: `https://github.com/pmatos/alpha/pull/${number}`,
    number,
    state: "open",
    title: `PR ${number}`,
    ...overrides
  } as RawGitHubPullRequest;
}

type FakeLogger = Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

function fakeLogger(): FakeLogger {
  return { info: vi.fn(), warn: vi.fn() } as unknown as FakeLogger;
}

function warnings(logger: FakeLogger): string[] {
  return logger.warn.mock.calls.map((call) => String(call[1]));
}

function infos(logger: FakeLogger): string[] {
  return logger.info.mock.calls.map((call) => String(call[1]));
}

function makeObservation(
  overrides: {
    api?: GitHubIssuesApi | undefined;
    env?: NodeJS.ProcessEnv;
    firingState?: string | undefined;
    kind?: "git" | "report";
    logger?: FakeLogger;
    project?: RunControllerProjectConfig;
    timeoutMs?: number;
  } = {}
) {
  const recordRoutinePullRequest = vi.fn();
  const getRoutineFiring = vi
    .fn()
    .mockReturnValue(
      overrides.firingState === undefined
        ? undefined
        : { state: overrides.firingState }
    );
  const api = "api" in overrides ? overrides.api : fullApi();
  const observation = createRoutineGithubObservation({
    branchName,
    claimUrlVerificationTimeoutMs: overrides.timeoutMs ?? 1000,
    env: overrides.env ?? { GITHUB_TOKEN: "token" },
    firingId: "fire-1",
    githubIssuesApi: api,
    kind: overrides.kind ?? "git",
    logger: overrides.logger,
    project: overrides.project ?? project,
    routineName: "audit",
    runStore: {
      getRoutineFiring,
      recordRoutinePullRequest
    },
    since
  });
  return { observation, recordRoutinePullRequest };
}

function fullApi(
  overrides: WithUndefined<GitHubIssuesApi> = {}
): GitHubIssuesApi {
  return {
    getPullRequest: vi.fn().mockResolvedValue(null),
    listIssues: vi.fn().mockResolvedValue([]),
    listOpenIssues: vi.fn().mockResolvedValue([]),
    listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
    ...overrides
  } as GitHubIssuesApi;
}

type IssueSeed = {
  closedAt?: string | null;
  createdAt?: string;
  state?: string;
};

function capturedIssues(
  seeds: Record<number, IssueSeed>
): RoutineGithubSnapshot["issues"] {
  return Object.fromEntries(
    Object.entries(seeds).map(([number, seed]) => [
      number,
      {
        closedAt: seed.closedAt ?? null,
        createdAt: seed.createdAt ?? beforeWindow,
        state: seed.state ?? "open",
        title: `Issue ${number}`,
        url: `https://github.com/pmatos/alpha/issues/${number}`
      }
    ])
  );
}

function capture(input: {
  issues?: Record<number, IssueSeed>;
  issuesAvailable?: boolean;
  pullRequests?: number[];
  pullRequestsAvailable?: boolean;
}): RoutineGithubCapture {
  const pullRequests = (input.pullRequests ?? []).map((number) =>
    branchPullRequest(number)
  );
  return {
    issuesAvailable: input.issuesAvailable ?? true,
    pullRequests,
    pullRequestsAvailable: input.pullRequestsAvailable ?? true,
    snapshot: {
      issues: capturedIssues(input.issues ?? {}),
      pullRequests: Object.fromEntries(
        pullRequests.map((pullRequest) => [
          String(pullRequest.number),
          { title: pullRequest.title ?? "", url: pullRequest.html_url ?? null }
        ])
      )
    }
  };
}

function claim(
  overrides: Partial<RoutineOutcomeClaim> = {}
): RoutineOutcomeClaim {
  return {
    action: "pr",
    status: "success",
    summary: "did it",
    title: "claimed",
    url: "https://github.com/pmatos/alpha/pull/99",
    ...overrides
  };
}

describe("Routine Firing GitHub observation capture", () => {
  it("skips observation and says why when the project has no tracker", async () => {
    const logger = fakeLogger();
    const api = fullApi();
    const { observation } = makeObservation({
      api,
      logger,
      project: { ...project, tracker: undefined }
    });

    expect(await observation.capture()).toBeNull();
    expect(infos(logger)).toEqual([
      "symphonika routine issue observation skipped: tracker absent"
    ]);
    expect(api.listIssues).not.toHaveBeenCalled();
  });

  it("skips observation when no GitHub API is wired", async () => {
    const logger = fakeLogger();
    const { observation } = makeObservation({ api: undefined, logger });

    expect(await observation.capture()).toBeNull();
    expect(infos(logger)).toEqual([
      "symphonika routine GitHub observation skipped: API unavailable"
    ]);
  });

  it("skips observation without calling GitHub when the token env var is unset", async () => {
    const logger = fakeLogger();
    const api = fullApi();
    const { observation } = makeObservation({ api, env: {}, logger });

    expect(await observation.capture()).toBeNull();
    expect(warnings(logger)).toEqual([
      "symphonika routine GitHub observation token unavailable"
    ]);
    expect(api.listIssues).not.toHaveBeenCalled();
    expect(api.listPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("lists all-state issues since the window start and never reads PRs for a report routine", async () => {
    const api = fullApi();
    const { observation } = makeObservation({ api, kind: "report" });

    const result = await observation.capture();

    expect(result).toMatchObject({
      issuesAvailable: true,
      pullRequests: [],
      pullRequestsAvailable: false
    });
    expect(api.listIssues).toHaveBeenCalledWith({
      owner: "pmatos",
      repo: "alpha",
      since,
      state: "all",
      token: "token"
    });
    expect(api.listPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("reports nothing when a report routine's API cannot list issues", async () => {
    const logger = fakeLogger();
    const { observation } = makeObservation({
      api: fullApi({ listIssues: undefined }),
      kind: "report",
      logger
    });

    expect(await observation.capture()).toBeNull();
    expect(infos(logger)).toEqual([
      "symphonika routine issue observation skipped: API unsupported"
    ]);
  });

  it("keeps the issue half of a git capture when the API cannot list branch PRs", async () => {
    const { observation } = makeObservation({
      api: fullApi({ listPullRequestsForBranch: undefined })
    });

    expect(await observation.capture()).toMatchObject({
      issuesAvailable: true,
      pullRequests: [],
      pullRequestsAvailable: false
    });
  });

  it("keeps the PR half of a git capture when issue listing is unsupported", async () => {
    const api = fullApi({
      listIssues: undefined,
      listPullRequestsForBranch: vi
        .fn()
        .mockResolvedValue([branchPullRequest(7)])
    });
    const { observation } = makeObservation({ api });

    const result = await observation.capture();

    expect(result).toMatchObject({
      issuesAvailable: false,
      pullRequestsAvailable: true
    });
    expect(Object.keys(result?.snapshot.pullRequests ?? {})).toEqual(["7"]);
    expect(api.listPullRequestsForBranch).toHaveBeenCalledWith({
      branch: branchName,
      owner: "pmatos",
      repo: "alpha",
      token: "token"
    });
  });

  it("keeps the PR half of a git capture when issue listing throws", async () => {
    const logger = fakeLogger();
    const failure = new Error("issues 500");
    const api = fullApi({
      listIssues: vi.fn().mockRejectedValue(failure),
      listPullRequestsForBranch: vi
        .fn()
        .mockResolvedValue([branchPullRequest(7)])
    });
    const { observation } = makeObservation({ api, logger });

    const result = await observation.capture();

    expect(result).toMatchObject({
      issuesAvailable: false,
      pullRequestsAvailable: true
    });
    expect(warnings(logger)).toEqual([
      "symphonika routine issue observation failed"
    ]);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ err: failure });
  });

  it("keeps the issue half of a git capture when PR listing throws", async () => {
    const logger = fakeLogger();
    const api = fullApi({
      listIssues: vi.fn().mockResolvedValue([
        {
          created_at: inWindow,
          html_url: "https://github.com/pmatos/alpha/issues/3",
          number: 3,
          state: "open",
          title: "New"
        }
      ]),
      listPullRequestsForBranch: vi.fn().mockRejectedValue(new Error("boom"))
    });
    const { observation } = makeObservation({ api, logger });

    const result = await observation.capture();

    expect(result).toMatchObject({
      issuesAvailable: true,
      pullRequestsAvailable: false
    });
    expect(Object.keys(result?.snapshot.issues ?? {})).toEqual(["3"]);
    expect(warnings(logger)).toEqual([
      "symphonika routine PR observation failed"
    ]);
  });

  it("reports nothing when both reads fail", async () => {
    const api = fullApi({
      listIssues: vi.fn().mockRejectedValue(new Error("a")),
      listPullRequestsForBranch: vi.fn().mockRejectedValue(new Error("b"))
    });
    const { observation } = makeObservation({ api, logger: fakeLogger() });

    expect(await observation.capture()).toBeNull();
  });

  it("normalizes raw issues: drops PR-shaped and unnumbered entries, fills missing fields", async () => {
    const rawIssues: RawGitHubIssue[] = [
      { number: 1, pull_request: {}, state: "open" },
      { state: "open", title: "no number" },
      { number: 0, state: "open" },
      { number: -4, state: "open" },
      {
        closed_at: inWindow,
        created_at: beforeWindow,
        html_url: "https://github.com/pmatos/alpha/issues/5",
        number: 5,
        state: "closed",
        title: "Fully populated"
      },
      { number: 6 }
    ];
    const { observation } = makeObservation({
      api: fullApi({ listIssues: vi.fn().mockResolvedValue(rawIssues) }),
      kind: "report"
    });

    const result = await observation.capture();

    expect(result?.snapshot.issues).toEqual({
      "5": {
        closedAt: inWindow,
        createdAt: beforeWindow,
        state: "closed",
        title: "Fully populated",
        url: "https://github.com/pmatos/alpha/issues/5"
      },
      "6": {
        closedAt: null,
        createdAt: new Date(0).toISOString(),
        state: "",
        title: "Issue #6",
        url: null
      }
    });
  });

  it("only snapshots well-formed PRs from this firing's own branch", async () => {
    const rawPullRequests: RawGitHubPullRequest[] = [
      branchPullRequest(10),
      branchPullRequest(11, { head: { ref: "other-branch", sha: "x" } }),
      branchPullRequest(12, { head: { ref: branchName, sha: "" } }),
      branchPullRequest(13, { head: { ref: branchName } }),
      { head: { ref: branchName, sha: "s" }, state: "open" },
      branchPullRequest(0),
      branchPullRequest(14, { html_url: undefined, title: undefined }),
      branchPullRequest(15, { head: undefined })
    ];
    const { observation } = makeObservation({
      api: fullApi({
        listPullRequestsForBranch: vi.fn().mockResolvedValue(rawPullRequests)
      })
    });

    const result = await observation.capture();

    expect(result?.snapshot.pullRequests).toEqual({
      "10": {
        title: "PR 10",
        url: "https://github.com/pmatos/alpha/pull/10"
      },
      "14": { title: "Pull request #14", url: null }
    });
  });
});

describe("Routine Firing GitHub observation assessment", () => {
  describe("failure phase", () => {
    it("reports unavailable when either capture is missing", async () => {
      const { observation } = makeObservation();

      expect(
        await observation.assess({
          after: capture({}),
          before: null,
          phase: "failure"
        })
      ).toEqual({
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false
      });
      expect(
        await observation.assess({
          after: null,
          before: capture({}),
          phase: "failure"
        })
      ).toMatchObject({ githubObservationAvailable: false });
    });

    it("reports unavailable when no channel survived in both captures", async () => {
      const { observation } = makeObservation();

      expect(
        await observation.assess({
          after: capture({ issuesAvailable: false }),
          before: capture({ pullRequestsAvailable: false }),
          phase: "failure"
        })
      ).toEqual({
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: false
      });
    });

    it("still surfaces an issue opened in the window but marks a git observation unavailable when the PR channel was lost", async () => {
      const { observation } = makeObservation();

      const result = await observation.assess({
        after: capture({
          issues: { 3: { createdAt: inWindow } },
          pullRequestsAvailable: false
        }),
        before: capture({}),
        phase: "failure"
      });

      expect(result).toMatchObject({
        githubObservationAvailable: false,
        observedAction: { action: "issue_opened", title: "Issue 3" },
        pullRequestObserved: false
      });
    });

    it("treats issues alone as sufficient for a report routine", async () => {
      const { observation } = makeObservation({ kind: "report" });

      const result = await observation.assess({
        after: capture({
          issues: { 3: { createdAt: inWindow } },
          pullRequestsAvailable: false
        }),
        before: capture({ pullRequestsAvailable: false }),
        phase: "failure"
      });

      expect(result).toMatchObject({
        githubObservationAvailable: true,
        observedAction: { action: "issue_opened" }
      });
    });

    it("ignores a channel that is unavailable on only one side instead of diffing against an empty snapshot", async () => {
      const { observation } = makeObservation();

      const result = await observation.assess({
        after: capture({ pullRequests: [5] }),
        before: capture({ pullRequestsAvailable: false }),
        phase: "failure"
      });

      expect(result.observedAction).toBeNull();
      expect(result.pullRequestObserved).toBe(false);
    });

    it("observes a close of an issue that was open before", async () => {
      const { observation } = makeObservation();

      const result = await observation.assess({
        after: capture({
          issues: { 4: { closedAt: inWindow, state: "closed" } }
        }),
        before: capture({ issues: { 4: { state: "open" } } }),
        phase: "failure"
      });

      expect(result.observedAction).toMatchObject({
        action: "issue_closed",
        title: "Issue 4"
      });
      expect(result.pullRequestObserved).toBe(false);
    });
  });

  describe("success phase PR bookkeeping", () => {
    it("observes a closed PR new to this firing but records only open ones", async () => {
      const api = fullApi({
        listPullRequestsForBranch: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([branchPullRequest(42, { state: "closed" })])
      });
      const { observation, recordRoutinePullRequest } = makeObservation({
        api
      });
      const before = await observation.capture();
      const after = await observation.capture();

      expect(
        await observation.assess({
          after,
          before,
          claim: null,
          phase: "success"
        })
      ).toMatchObject({
        githubObservationAvailable: true,
        observedAction: {
          action: "pr",
          url: "https://github.com/pmatos/alpha/pull/42"
        },
        pullRequestObserved: true
      });
      expect(recordRoutinePullRequest).not.toHaveBeenCalled();
    });

    it("records the firing's open PRs with their head sha and url", async () => {
      const { observation, recordRoutinePullRequest } = makeObservation();

      await observation.assess({
        after: capture({ pullRequests: [42, 43] }),
        before: capture({}),
        claim: null,
        phase: "success"
      });

      expect(recordRoutinePullRequest).toHaveBeenCalledTimes(2);
      expect(recordRoutinePullRequest).toHaveBeenCalledWith({
        firingId: "fire-1",
        headSha: "sha-42",
        prNumber: 42,
        prUrl: "https://github.com/pmatos/alpha/pull/42",
        projectName: "alpha",
        routineName: "audit"
      });
      expect(recordRoutinePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ headSha: "sha-43", prNumber: 43 })
      );
    });

    it("records a missing html_url as null", async () => {
      const { observation, recordRoutinePullRequest } = makeObservation();
      const after = capture({});
      after.pullRequests = [branchPullRequest(8, { html_url: undefined })];

      await observation.assess({
        after,
        before: capture({}),
        claim: null,
        phase: "success"
      });

      expect(recordRoutinePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 8, prUrl: null })
      );
    });

    it("does not count a PR that already existed before the firing as observed", async () => {
      const { observation, recordRoutinePullRequest } = makeObservation();

      const result = await observation.assess({
        after: capture({ pullRequests: [42] }),
        before: capture({ pullRequests: [42] }),
        claim: null,
        phase: "success"
      });

      expect(result.pullRequestObserved).toBe(false);
      expect(result.observedAction).toBeNull();
      expect(recordRoutinePullRequest).toHaveBeenCalledTimes(1);
    });

    it("counts any branch PR as observed when the before read had no PR channel", async () => {
      const { observation } = makeObservation();

      const result = await observation.assess({
        after: capture({ pullRequests: [42] }),
        before: capture({ pullRequestsAvailable: false }),
        claim: null,
        phase: "success"
      });

      expect(result.pullRequestObserved).toBe(true);
    });

    it("never reads or records PRs for a report routine", async () => {
      const api = fullApi();
      const { observation, recordRoutinePullRequest } = makeObservation({
        api,
        kind: "report"
      });

      const result = await observation.assess({
        after: capture({
          issues: { 2: { createdAt: inWindow } },
          pullRequestsAvailable: false
        }),
        before: capture({ pullRequestsAvailable: false }),
        claim: null,
        phase: "success"
      });

      expect(result.observedAction).toMatchObject({ action: "issue_opened" });
      expect(result.pullRequestObserved).toBe(false);
      expect(api.listPullRequestsForBranch).not.toHaveBeenCalled();
      expect(recordRoutinePullRequest).not.toHaveBeenCalled();
    });
  });

  describe("success phase fallback PR discovery", () => {
    function discoveryApi(
      discovery: () => Promise<RawGitHubPullRequest[] | undefined>
    ) {
      return fullApi({
        listPullRequestsForBranch: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(new Error("after snapshot failed"))
          .mockImplementation(discovery)
      });
    }

    async function assessAfterFailedSnapshot(
      observation: ReturnType<typeof makeObservation>["observation"]
    ) {
      const before = await observation.capture();
      const after = await observation.capture();
      expect(after?.pullRequestsAvailable).toBe(false);
      return observation.assess({
        after,
        before,
        claim: null,
        phase: "success"
      });
    }

    it("re-lists the branch's PRs when the after snapshot is missing and records what it finds", async () => {
      const { observation, recordRoutinePullRequest } = makeObservation({
        api: discoveryApi(() =>
          Promise.resolve([
            branchPullRequest(21),
            branchPullRequest(22, { state: "closed" })
          ])
        ),
        firingState: "running",
        logger: fakeLogger()
      });

      const result = await assessAfterFailedSnapshot(observation);

      expect(result).toMatchObject({
        githubObservationAvailable: false,
        observedAction: null,
        pullRequestObserved: true
      });
      expect(recordRoutinePullRequest).toHaveBeenCalledTimes(1);
      expect(recordRoutinePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 21 })
      );
    });

    it("does not count a PR that the before snapshot already held", async () => {
      const api = fullApi({
        listPullRequestsForBranch: vi
          .fn()
          .mockResolvedValueOnce([branchPullRequest(21)])
          .mockRejectedValueOnce(new Error("after snapshot failed"))
          .mockResolvedValue([branchPullRequest(21)])
      });
      const { observation, recordRoutinePullRequest } = makeObservation({
        api,
        firingState: "running",
        logger: fakeLogger()
      });

      const result = await assessAfterFailedSnapshot(observation);

      expect(result.pullRequestObserved).toBe(false);
      expect(recordRoutinePullRequest).toHaveBeenCalledTimes(1);
    });

    it("treats an API that cannot list branch PRs as finding nothing", async () => {
      const api = fullApi({
        listPullRequestsForBranch: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(new Error("after snapshot failed"))
          .mockResolvedValue(undefined)
      });
      const { observation, recordRoutinePullRequest } = makeObservation({
        api,
        firingState: "running",
        logger: fakeLogger()
      });

      const result = await assessAfterFailedSnapshot(observation);

      expect(result.pullRequestObserved).toBe(false);
      expect(recordRoutinePullRequest).not.toHaveBeenCalled();
    });

    it("swallows a failing discovery listing and reports no PR", async () => {
      const logger = fakeLogger();
      const { observation, recordRoutinePullRequest } = makeObservation({
        api: discoveryApi(() => Promise.reject(new Error("discovery 502"))),
        firingState: "running",
        logger
      });

      const result = await assessAfterFailedSnapshot(observation);

      expect(result.pullRequestObserved).toBe(false);
      expect(warnings(logger)).toContain(
        "symphonika routine PR discovery failed"
      );
      expect(recordRoutinePullRequest).not.toHaveBeenCalled();
    });

    it.each([["completed"], [undefined]])(
      "refuses to record PRs onto a firing whose stored state is %s",
      async (state) => {
        const logger = fakeLogger();
        const { observation, recordRoutinePullRequest } = makeObservation({
          api: discoveryApi(() => Promise.resolve([branchPullRequest(21)])),
          firingState: state,
          logger
        });

        const result = await assessAfterFailedSnapshot(observation);

        expect(result.pullRequestObserved).toBe(false);
        expect(warnings(logger)).toContain(
          "symphonika routine PR discovery abandoned after firing already completed"
        );
        expect(recordRoutinePullRequest).not.toHaveBeenCalled();
      }
    );

    it("does nothing when the project has no tracker", async () => {
      const api = fullApi();
      const { observation, recordRoutinePullRequest } = makeObservation({
        api,
        firingState: "running",
        project: { ...project, tracker: undefined }
      });

      const result = await observation.assess({
        after: null,
        before: null,
        claim: null,
        phase: "success"
      });

      expect(result.pullRequestObserved).toBe(false);
      expect(api.listPullRequestsForBranch).not.toHaveBeenCalled();
      expect(recordRoutinePullRequest).not.toHaveBeenCalled();
    });

    it("does nothing when no GitHub API is wired", async () => {
      const { observation, recordRoutinePullRequest } = makeObservation({
        api: undefined,
        firingState: "running"
      });

      const result = await observation.assess({
        after: null,
        before: null,
        claim: null,
        phase: "success"
      });

      expect(result.pullRequestObserved).toBe(false);
      expect(recordRoutinePullRequest).not.toHaveBeenCalled();
    });

    it("does not list PRs when the token env var is unset", async () => {
      const logger = fakeLogger();
      const api = fullApi();
      const { observation } = makeObservation({
        api,
        env: {},
        firingState: "running",
        logger
      });

      const result = await observation.assess({
        after: null,
        before: null,
        claim: null,
        phase: "success"
      });

      expect(result.pullRequestObserved).toBe(false);
      expect(warnings(logger)).toContain(
        "symphonika routine PR discovery token unavailable"
      );
      expect(api.listPullRequestsForBranch).not.toHaveBeenCalled();
    });
  });

  describe("success phase claim URL verification", () => {
    const observedPrSnapshots = {
      after: (issues: Record<number, IssueSeed>) =>
        capture({ issues, pullRequests: [5] }),
      before: (issues: Record<number, IssueSeed>) => capture({ issues })
    };

    it("confirms a PR claim from a different branch by fetching that PR directly", async () => {
      const getPullRequest = vi
        .fn<NonNullable<GitHubIssuesApi["getPullRequest"]>>()
        .mockResolvedValue({
          html_url: "https://github.com/pmatos/alpha/pull/99",
          number: 99,
          title: "Fix from elsewhere"
        });
      const { observation } = makeObservation({
        api: fullApi({ getPullRequest })
      });

      const result = await observation.assess({
        after: capture({}),
        before: capture({}),
        claim: claim(),
        phase: "success"
      });

      expect(result).toMatchObject({
        observedAction: {
          action: "pr",
          title: "Fix from elsewhere",
          url: "https://github.com/pmatos/alpha/pull/99"
        },
        pullRequestObserved: true
      });
      const request = getPullRequest.mock.calls[0]?.[0];
      if (request === undefined) throw new Error("no lookup issued");
      expect(request).toMatchObject({
        owner: "pmatos",
        pullNumber: 99,
        repo: "alpha",
        token: "token"
      });
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal?.aborted).toBe(false);
    });

    it("falls back to the claimed URL and a numbered title for a sparse PR payload", async () => {
      const { observation } = makeObservation({
        api: fullApi({
          getPullRequest: vi.fn().mockResolvedValue({ number: 99 })
        })
      });

      const result = await observation.assess({
        after: capture({}),
        before: capture({}),
        claim: claim(),
        phase: "success"
      });

      expect(result.observedAction).toEqual({
        action: "pr",
        title: "Pull request #99",
        url: "https://github.com/pmatos/alpha/pull/99"
      });
    });

    it.each([
      ["the PR does not exist", null],
      ["the API lacks single-PR lookup", undefined],
      ["the payload carries no number", {}]
    ])("leaves a PR claim unconfirmed when %s", async (_label, payload) => {
      const getPullRequest =
        payload === undefined ? undefined : vi.fn().mockResolvedValue(payload);
      const { observation } = makeObservation({
        api: fullApi({ getPullRequest })
      });

      const result = await observation.assess({
        after: capture({}),
        before: capture({}),
        claim: claim(),
        phase: "success"
      });

      expect(result.observedAction).toBeNull();
      expect(result.pullRequestObserved).toBe(false);
    });

    it("leaves a PR claim unconfirmed, and logs, when the lookup throws", async () => {
      const logger = fakeLogger();
      const failure = new Error("pulls 500");
      const { observation } = makeObservation({
        api: fullApi({ getPullRequest: vi.fn().mockRejectedValue(failure) }),
        logger
      });

      const result = await observation.assess({
        after: capture({}),
        before: capture({}),
        claim: claim(),
        phase: "success"
      });

      expect(result.observedAction).toBeNull();
      expect(warnings(logger)).toContain(
        "symphonika routine claim URL verification failed"
      );
      expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
        err: failure,
        number: 99,
        project: "alpha",
        referenceKind: "pull"
      });
    });

    it("gives up on a PR lookup that outlives the verification timeout", async () => {
      const logger = fakeLogger();
      const getPullRequest = vi.fn(
        (input: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            input.signal?.addEventListener("abort", () =>
              reject(new Error("lookup aborted"))
            );
          })
      );
      const { observation } = makeObservation({
        api: fullApi({
          getPullRequest: getPullRequest as GitHubIssuesApi["getPullRequest"]
        }),
        logger,
        timeoutMs: 25
      });

      const result = await observation.assess({
        after: capture({}),
        before: capture({}),
        claim: claim(),
        phase: "success"
      });

      expect(result.observedAction).toBeNull();
      expect(warnings(logger)).toContain(
        "symphonika routine claim URL verification failed"
      );
    });

    it.each([
      [
        "names a different repository",
        { url: "https://github.com/other/alpha/pull/99" }
      ],
      [
        "is not a GitHub URL",
        { url: "https://example.com/pmatos/alpha/pull/99" }
      ],
      ["is missing", { url: null }],
      [
        "points at an issue for a pr claim",
        { url: "https://github.com/pmatos/alpha/issues/99" }
      ],
      ["reports an error", { status: "error" as const }],
      ["claims a commit", { action: "commit" as const }],
      [
        "claims nothing",
        { action: "none" as const, status: "no_action" as const }
      ]
    ])(
      "never looks anything up when the claim %s",
      async (_label, overrides) => {
        const getPullRequest = vi.fn().mockResolvedValue({ number: 99 });
        const { observation } = makeObservation({
          api: fullApi({ getPullRequest })
        });

        const result = await observation.assess({
          after: capture({}),
          before: capture({}),
          claim: claim(overrides),
          phase: "success"
        });

        expect(getPullRequest).not.toHaveBeenCalled();
        expect(result.observedAction).toBeNull();
      }
    );

    it("skips verification when the branch-scoped diff already saw the claimed action", async () => {
      const getPullRequest = vi.fn().mockResolvedValue({ number: 99 });
      const { observation } = makeObservation({
        api: fullApi({ getPullRequest })
      });

      const result = await observation.assess({
        after: capture({ pullRequests: [5] }),
        before: capture({}),
        claim: claim(),
        phase: "success"
      });

      expect(getPullRequest).not.toHaveBeenCalled();
      expect(result.observedAction).toMatchObject({
        action: "pr",
        url: "https://github.com/pmatos/alpha/pull/5"
      });
    });

    it("skips verification for a report routine", async () => {
      const getPullRequest = vi.fn().mockResolvedValue({ number: 99 });
      const { observation } = makeObservation({
        api: fullApi({ getPullRequest }),
        kind: "report"
      });

      await observation.assess({
        after: capture({ pullRequestsAvailable: false }),
        before: capture({ pullRequestsAvailable: false }),
        claim: claim(),
        phase: "success"
      });

      expect(getPullRequest).not.toHaveBeenCalled();
    });

    it("warns and skips the lookup when the token is unavailable at verification time", async () => {
      const logger = fakeLogger();
      const getPullRequest = vi.fn().mockResolvedValue({ number: 99 });
      const { observation } = makeObservation({
        api: fullApi({ getPullRequest }),
        env: {},
        logger
      });

      const result = await observation.assess({
        after: capture({}),
        before: capture({}),
        claim: claim(),
        phase: "success"
      });

      expect(result.observedAction).toBeNull();
      expect(getPullRequest).not.toHaveBeenCalled();
      expect(warnings(logger)).toContain(
        "symphonika routine claim URL verification token unavailable"
      );
    });

    it("skips verification when the project has no tracker or API", async () => {
      const getPullRequest = vi.fn().mockResolvedValue({ number: 99 });
      const noTracker = makeObservation({
        api: fullApi({ getPullRequest }),
        project: { ...project, tracker: undefined }
      });
      const noApi = makeObservation({ api: undefined });

      for (const { observation } of [noTracker, noApi]) {
        const result = await observation.assess({
          after: capture({}),
          before: capture({}),
          claim: claim(),
          phase: "success"
        });
        expect(result.observedAction).toBeNull();
      }
      expect(getPullRequest).not.toHaveBeenCalled();
    });

    type IssueClaimCase = {
      action: "issue_opened" | "issue_closed";
      after: Record<number, IssueSeed>;
      before: Record<number, IssueSeed>;
      confirmed: boolean;
      label: string;
      url?: string;
    };
    const issueUrl = "https://github.com/pmatos/alpha/issues/77";
    const issueClaimCases: IssueClaimCase[] = [
      {
        action: "issue_opened",
        after: { 77: { createdAt: inWindow } },
        before: {},
        confirmed: true,
        label: "opened in the window and absent before"
      },
      {
        action: "issue_opened",
        after: { 77: { createdAt: since } },
        before: {},
        confirmed: true,
        label: "created exactly when the window began"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: since, state: "closed" } },
        before: {},
        confirmed: true,
        label: "unseen before and closed exactly when the window began"
      },
      {
        action: "issue_opened",
        after: { 77: { createdAt: beforeWindow } },
        before: {},
        confirmed: false,
        label: "opened before the window began"
      },
      {
        action: "issue_opened",
        after: { 77: { createdAt: inWindow } },
        before: { 77: { createdAt: inWindow } },
        confirmed: false,
        label: "already present in the before snapshot"
      },
      {
        action: "issue_opened",
        after: {},
        before: {},
        confirmed: false,
        label: "absent from the after snapshot"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: inWindow, state: "closed" } },
        before: { 77: { state: "open" } },
        confirmed: true,
        label: "open before and closed after"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: inWindow, state: "CLOSED" } },
        before: { 77: { state: "OPEN" } },
        confirmed: true,
        label: "closed with upper-case state names"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: inWindow, state: "closed" } },
        before: {},
        confirmed: true,
        label: "unseen before but closed inside the window"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: beforeWindow, state: "closed" } },
        before: {},
        confirmed: false,
        label: "unseen before and closed before the window"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: null, state: "closed" } },
        before: {},
        confirmed: false,
        label: "closed with no close timestamp"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: inWindow, state: "closed" } },
        before: { 77: { closedAt: beforeWindow, state: "closed" } },
        confirmed: false,
        label: "already closed in the before snapshot"
      },
      {
        action: "issue_closed",
        after: { 77: { state: "open" } },
        before: { 77: { state: "open" } },
        confirmed: false,
        label: "still open after"
      },
      {
        action: "issue_closed",
        after: { 77: { closedAt: inWindow, state: "closed" } },
        before: { 77: { state: "open" } },
        confirmed: false,
        label: "claimed with a pull request URL",
        url: "https://github.com/pmatos/alpha/pull/77"
      }
    ];

    it.each(issueClaimCases)(
      "judges a $action claim for an issue $label from the captured snapshots",
      async ({ action, after, before, confirmed, url }) => {
        const getPullRequest = vi.fn();
        const { observation } = makeObservation({
          api: fullApi({ getPullRequest })
        });

        const result = await observation.assess({
          after: observedPrSnapshots.after(after),
          before: observedPrSnapshots.before(before),
          claim: claim({ action, url: url ?? issueUrl }),
          phase: "success"
        });

        expect(getPullRequest).not.toHaveBeenCalled();
        expect(result.pullRequestObserved).toBe(true);
        if (confirmed) {
          expect(result.observedAction).toEqual({
            action,
            title: "Issue 77",
            url: issueUrl
          });
        } else {
          expect(result.observedAction).toMatchObject({ action: "pr" });
        }
      }
    );

    it("never confirms an issue claim from a stale lookup when a snapshot channel was unavailable", async () => {
      const { observation } = makeObservation();
      const seeded = { 77: { createdAt: inWindow } };

      const missingBefore = await observation.assess({
        after: capture({ issues: seeded, pullRequests: [5] }),
        before: capture({ issuesAvailable: false }),
        claim: claim({ action: "issue_opened", url: issueUrl }),
        phase: "success"
      });
      const missingAfter = await observation.assess({
        after: capture({ issuesAvailable: false, pullRequests: [5] }),
        before: capture({}),
        claim: claim({ action: "issue_opened", url: issueUrl }),
        phase: "success"
      });

      expect(missingBefore.observedAction).toMatchObject({ action: "pr" });
      expect(missingAfter.observedAction).toMatchObject({ action: "pr" });
    });

    it("lets a verified issue claim replace the observed PR while still crediting the PR", async () => {
      const { observation } = makeObservation();

      const result = await observation.assess({
        after: capture({
          issues: { 77: { createdAt: inWindow } },
          pullRequests: [5]
        }),
        before: capture({}),
        claim: claim({ action: "issue_opened", url: issueUrl }),
        phase: "success"
      });

      expect(result.observedAction?.action).toBe("issue_opened");
      expect(result.pullRequestObserved).toBe(true);
    });

    it("uses the numbered title and claimed URL when the confirmed issue has no URL of its own", async () => {
      const { observation } = makeObservation();
      const after = capture({
        issues: { 77: { createdAt: inWindow } },
        pullRequests: [5]
      });
      const issue = after.snapshot.issues["77"];
      if (issue === undefined) throw new Error("seed missing");
      issue.url = null;

      const result = await observation.assess({
        after,
        before: capture({}),
        claim: claim({ action: "issue_opened", url: issueUrl }),
        phase: "success"
      });

      expect(result.observedAction).toEqual({
        action: "issue_opened",
        title: "Issue 77",
        url: issueUrl
      });
    });
  });
});
