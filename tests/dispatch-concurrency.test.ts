import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { createDeferred } from "./helpers/deferred.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-concurrency-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

const baseIssue = {
  body: "issue body",
  created_at: "2026-04-20T10:00:00Z",
  html_url: "https://github.com/acme/repo/issues/1",
  id: 0,
  number: 0,
  state: "open",
  title: "issue",
  updated_at: "2026-04-21T11:00:00Z"
};

type ProjectFixture = {
  issueNumber: number;
  issueTitle: string;
  maxInFlightLine?: string;
  name: string;
  owner: string;
  repo: string;
};

async function preparedFor(
  root: string,
  projectName: string,
  issueNumber: number
): Promise<PreparedIssueWorkspace> {
  const slug = `${issueNumber}-issue`;
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    projectName,
    "issues",
    slug
  );
  const prepared: PreparedIssueWorkspace = {
    branchName: `sym/${projectName}/${slug}`,
    branchRef: `refs/heads/sym/${projectName}/${slug}`,
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      projectName,
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: slug,
    reused: false,
    workspacePath
  };
  await createGitWorkspaceAhead(prepared);
  return prepared;
}

function projectYaml(fixture: ProjectFixture): string[] {
  return [
    `  - name: ${fixture.name}`,
    "    disabled: false",
    "    weight: 1",
    ...(fixture.maxInFlightLine === undefined ? [] : [fixture.maxInFlightLine]),
    "    tracker:",
    "      kind: github",
    `      owner: ${fixture.owner}`,
    `      repo: ${fixture.repo}`,
    '      token: "$GITHUB_TOKEN"',
    "    issue_filters:",
    '      states: ["open"]',
    '      labels_all: ["agent-ready"]',
    '      labels_none: ["blocked"]',
    "    priority:",
    "      labels: {}",
    "      default: 99",
    "    workspace:",
    `      root: ./.symphonika/workspaces/${fixture.name}`,
    "      git:",
    `        remote: git@github.com:${fixture.owner}/${fixture.repo}.git`,
    "        base_branch: main",
    "    agent:",
    "      provider: codex",
    "    workflow: ./WORKFLOW.md"
  ];
}

async function writeConfig(
  root: string,
  fixtures: ProjectFixture[],
  options: { globalMaxInFlightLine?: string } = {}
): Promise<void> {
  const lines: string[] = [
    "state:",
    "  root: ./.symphonika",
    "polling:",
    "  interval_ms: 25"
  ];
  if (options.globalMaxInFlightLine !== undefined) {
    lines.push("global:", options.globalMaxInFlightLine);
  }
  lines.push(
    "providers:",
    "  codex:",
    '    command: "codex"',
    "  claude:",
    '    command: "claude"',
    "projects:"
  );
  for (const fixture of fixtures) {
    lines.push(...projectYaml(fixture));
  }
  lines.push("");
  await writeFile(path.join(root, "symphonika.yml"), lines.join("\n"));
  await writeFile(path.join(root, "WORKFLOW.md"), "Work {{issue.number}}\n");
}

function fakeGithub(
  fixtures: ProjectFixture[]
): {
  addLabelsToIssue: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  listBranchCommits: ReturnType<typeof vi.fn>;
  listOpenIssues: ReturnType<typeof vi.fn>;
  listPullRequestsForBranch: ReturnType<typeof vi.fn>;
  removeLabelsFromIssue: ReturnType<typeof vi.fn>;
} {
  const issuesByOwnerRepo = new Map<string, typeof baseIssue>();
  for (const fixture of fixtures) {
    const key = `${fixture.owner}/${fixture.repo}`;
    issuesByOwnerRepo.set(key, {
      ...baseIssue,
      id: fixture.issueNumber,
      number: fixture.issueNumber,
      title: fixture.issueTitle
    });
  }
  return {
    addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
    getIssue: vi
      .fn()
      .mockImplementation(({ issueNumber }: { issueNumber: number }) => {
        for (const issue of issuesByOwnerRepo.values()) {
          if (issue.number === issueNumber) {
            return Promise.resolve({ ...issue, labels: ["agent-ready"] });
          }
        }
        return Promise.resolve({ ...baseIssue, labels: ["agent-ready"] });
      }),
    listBranchCommits: vi.fn().mockResolvedValue([]),
    listOpenIssues: vi
      .fn()
      .mockImplementation(
        ({ owner, repo }: { owner: string; repo: string }) => {
          const issue = issuesByOwnerRepo.get(`${owner}/${repo}`);
          if (issue === undefined) return Promise.resolve([]);
          return Promise.resolve([{ ...issue, labels: ["agent-ready"] }]);
        }
      ),
    listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
    removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
  };
}

describe("dispatch concurrency caps (slice 2)", () => {
  it("project at per-project cap is skipped, other project is picked", async () => {
    const root = await makeTempRoot();
    const fixtures: ProjectFixture[] = [
      {
        issueNumber: 11,
        issueTitle: "A1",
        name: "project-a",
        owner: "acme",
        repo: "project-a"
      },
      {
        issueNumber: 22,
        issueTitle: "B1",
        name: "project-b",
        owner: "acme",
        repo: "project-b"
      }
    ];
    await writeConfig(root, fixtures);

    const preparedByIssue = new Map<number, PreparedIssueWorkspace>();
    preparedByIssue.set(11, await preparedFor(root, "project-a", 11));
    preparedByIssue.set(22, await preparedFor(root, "project-b", 22));

    const gate = createDeferred<void>();
    const observedProjects: string[] = [];
    const allEntered = createDeferred<void>();

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(input: { issue: { number: number } }): AsyncGenerator<ProviderEvent> {
        observedProjects.push(input.issue.number === 11 ? "project-a" : "project-b");
        if (observedProjects.length >= 2) {
          allEntered.resolve();
        }
        await gate.promise;
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = fakeGithub(fixtures);
    const prepareIssueWorkspace = vi.fn(
      ({ issue }: { issue: { number: number } }): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(preparedByIssue.get(issue.number)!)
    );

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret" },
      githubIssuesApi: githubIssuesApi as never,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // With both projects at default cap 1 and one ready issue each, two
      // ticks should dispatch one issue per project concurrently.
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });

      const timeoutId = setTimeout(() => {
        allEntered.reject(new Error("expected both projects to dispatch concurrently"));
      }, 5_000);
      await allEntered.promise.finally(() => clearTimeout(timeoutId));

      expect(observedProjects.sort()).toEqual(["project-a", "project-b"]);
    } finally {
      gate.resolve();
      await daemon.stop();
    }
  });

  it("global cap reached → pick returns undefined (third project's issue is gated)", async () => {
    const root = await makeTempRoot();
    const fixtures: ProjectFixture[] = [
      {
        issueNumber: 11,
        issueTitle: "A",
        name: "project-a",
        owner: "acme",
        repo: "project-a"
      },
      {
        issueNumber: 22,
        issueTitle: "B",
        name: "project-b",
        owner: "acme",
        repo: "project-b"
      },
      {
        issueNumber: 33,
        issueTitle: "C",
        name: "project-c",
        owner: "acme",
        repo: "project-c"
      }
    ];
    await writeConfig(root, fixtures, {
      globalMaxInFlightLine: "  max_in_flight: 2"
    });

    const preparedByIssue = new Map<number, PreparedIssueWorkspace>();
    preparedByIssue.set(11, await preparedFor(root, "project-a", 11));
    preparedByIssue.set(22, await preparedFor(root, "project-b", 22));
    preparedByIssue.set(33, await preparedFor(root, "project-c", 33));

    const gate = createDeferred<void>();
    const observedIssues: number[] = [];
    const twoEntered = createDeferred<void>();

    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(input: { issue: { number: number } }): AsyncGenerator<ProviderEvent> {
        observedIssues.push(input.issue.number);
        if (observedIssues.length >= 2) {
          twoEntered.resolve();
        }
        await gate.promise;
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = fakeGithub(fixtures);
    const prepareIssueWorkspace = vi.fn(
      ({ issue }: { issue: { number: number } }): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(preparedByIssue.get(issue.number)!)
    );

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret" },
      githubIssuesApi: githubIssuesApi as never,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      // Drive several ticks; global cap is 2, so only two of the three
      // projects should ever be in-flight at the same time.
      for (let i = 0; i < 5; i++) {
        await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      }

      const timeoutId = setTimeout(() => {
        twoEntered.reject(new Error("expected two issues to dispatch"));
      }, 5_000);
      await twoEntered.promise.finally(() => clearTimeout(timeoutId));

      // Give the daemon a generous moment to misbehave (it should not).
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(observedIssues).toHaveLength(2);
      // /api/status should confirm the global cap is reflected.
      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as {
        concurrency?: {
          global: { inFlight: number; maxInFlight: number | null };
        };
      };
      expect(status.concurrency?.global.maxInFlight).toBe(2);
      expect(status.concurrency?.global.inFlight).toBe(2);
    } finally {
      gate.resolve();
      await daemon.stop();
    }
  });
});
