import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-polling-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("daemon GitHub issue polling", () => {
  it("exposes normalized eligible issue snapshots through the status API", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        {
          body: "Implement the polling slice.",
          created_at: "2026-04-20T10:00:00Z",
          html_url: "https://github.com/pmatos/symphonika/issues/5",
          id: 5005,
          labels: [{ name: "agent-ready" }, { name: "priority:high" }],
          number: 5,
          state: "open",
          title: "Poll GitHub and display eligible issue snapshots",
          updated_at: "2026-04-21T11:00:00Z"
        }
      ])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const response = await fetch(`${daemon.url}/api/status`);
      const body: unknown = await response.json();

      expect(response.status).toBe(200);
      expect(githubIssuesApi.listOpenIssues).toHaveBeenCalledWith({
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
      expect(body).toMatchObject({
        candidateIssues: [
          {
            issue: {
              body: "Implement the polling slice.",
              created_at: "2026-04-20T10:00:00Z",
              id: 5005,
              labels: ["agent-ready", "priority:high"],
              number: 5,
              priority: 1,
              state: "open",
              title: "Poll GitHub and display eligible issue snapshots",
              updated_at: "2026-04-21T11:00:00Z",
              url: "https://github.com/pmatos/symphonika/issues/5"
            },
            project: "symphonika"
          }
        ],
        filteredIssues: []
      });
    } finally {
      await daemon.stop();
    }
  });

  it("shows filtered snapshots when required, excluded, or operational labels block eligibility", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["priority:low"],
          number: 10,
          title: "Missing required label"
        }),
        issueFixture({
          labels: ["agent-ready", "blocked"],
          number: 11,
          title: "Blocked by workflow label"
        }),
        issueFixture({
          labels: ["agent-ready", "sym:running"],
          number: 12,
          title: "Already running"
        }),
        issueFixture({
          labels: ["agent-ready"],
          number: 13,
          title: "Ready to work"
        })
      ])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const response = await fetch(`${daemon.url}/api/status`);
      const body = (await response.json()) as {
        candidateIssues: Array<{ issue: { number: number } }>;
        filteredIssues: Array<{
          issue: { number: number };
          reasons: string[];
        }>;
      };

      expect(body.candidateIssues.map((entry) => entry.issue.number)).toEqual([
        13
      ]);
      expect(
        body.filteredIssues.map((entry) => ({
          number: entry.issue.number,
          reasons: entry.reasons
        }))
      ).toEqual([
        {
          number: 10,
          reasons: ["missing required label agent-ready"]
        },
        {
          number: 11,
          reasons: ["has excluded label blocked"]
        },
        {
          number: 12,
          reasons: ["has operational label sym:running"]
        }
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it("sorts candidate snapshots by priority and ignores pull requests from the issues endpoint", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready", "priority:low"],
          number: 20,
          title: "Low priority issue"
        }),
        issueFixture({
          labels: ["agent-ready", "priority:critical"],
          number: 21,
          title: "Critical issue"
        }),
        {
          ...issueFixture({
            labels: ["agent-ready", "priority:critical"],
            number: 22,
            title: "Pull request returned by issues endpoint"
          }),
          pull_request: {
            html_url: "https://github.com/pmatos/symphonika/pull/22"
          }
        },
        issueFixture({
          labels: ["agent-ready", "priority:medium"],
          number: 23,
          title: "Medium priority issue"
        })
      ])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const response = await fetch(`${daemon.url}/api/status`);
      const body = (await response.json()) as {
        candidateIssues: Array<{
          issue: { number: number; priority: number };
        }>;
      };

      expect(
        body.candidateIssues.map((entry) => ({
          number: entry.issue.number,
          priority: entry.issue.priority
        }))
      ).toEqual([
        { number: 21, priority: 0 },
        { number: 23, priority: 2 },
        { number: 20, priority: 3 }
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it("refreshes issue snapshots on the configured polling interval", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root, { pollingIntervalMs: 10 });
    const githubIssuesApi = {
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([
          issueFixture({
            labels: ["agent-ready"],
            number: 30,
            title: "Startup snapshot"
          })
        ])
        .mockResolvedValue([
          issueFixture({
            labels: ["agent-ready"],
            number: 31,
            title: "Refreshed snapshot"
          })
        ])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      await waitFor(async () => {
        const response = await fetch(`${daemon.url}/api/status`);
        const body = (await response.json()) as {
          candidateIssues: Array<{ issue: { number: number } }>;
        };

        return (
          githubIssuesApi.listOpenIssues.mock.calls.length >= 2 &&
          body.candidateIssues.map((entry) => entry.issue.number).includes(31)
        );
      });
    } finally {
      await daemon.stop();
    }
  });

  it("marks GitHub issues stale when sym:claimed is present and no live run exists", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready", "sym:claimed"],
          number: 77,
          title: "Orphan claimed issue"
        })
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      await waitFor(() =>
        Promise.resolve(githubIssuesApi.addLabelsToIssue.mock.calls.length >= 1)
      );
      expect(githubIssuesApi.addLabelsToIssue).toHaveBeenCalledWith({
        issueNumber: 77,
        labels: ["sym:stale"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
      const response = await fetch(`${daemon.url}/api/status`);
      const body = (await response.json()) as {
        staleIssues: Array<{
          issue: { number: number };
          project: string;
          reasons: string[];
        }>;
      };
      expect(body.staleIssues).toHaveLength(1);
      expect(body.staleIssues[0]?.issue.number).toBe(77);
      expect(body.staleIssues[0]?.project).toBe("symphonika");
      expect(body.staleIssues[0]?.reasons).toEqual([
        "has operational label sym:claimed"
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it("continues polling valid projects when another project entry is invalid", async () => {
    const root = await makeTempRoot();
    await writeConfigWithInvalidAndValidProjects(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready"],
          number: 40,
          title: "Valid project issue"
        })
      ])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const response = await fetch(`${daemon.url}/api/status`);
      const body = (await response.json()) as {
        candidateIssues: Array<{ issue: { number: number }; project: string }>;
        issuePolling: { errors: string[] };
      };

      expect(githubIssuesApi.listOpenIssues).toHaveBeenCalledWith({
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
      expect(
        body.candidateIssues.map((entry) => ({
          number: entry.issue.number,
          project: entry.project
        }))
      ).toEqual([{ number: 40, project: "symphonika" }]);
      expect(body.issuePolling.errors.join("\n")).toContain(
        "projects.0.tracker.repo"
      );
    } finally {
      await daemon.stop();
    }
  });
});

function issueFixture(overrides: {
  labels: unknown[];
  number: number;
  title: string;
}): {
  body: string;
  created_at: string;
  html_url: string;
  id: number;
  labels: unknown[];
  number: number;
  state: string;
  title: string;
  updated_at: string;
} {
  return {
    body: `${overrides.title} body.`,
    created_at: "2026-04-20T10:00:00Z",
    html_url: `https://github.com/pmatos/symphonika/issues/${overrides.number}`,
    id: 5000 + overrides.number,
    labels: overrides.labels,
    number: overrides.number,
    state: "open",
    title: overrides.title,
    updated_at: "2026-04-21T11:00:00Z"
  };
}

async function writeValidProject(
  root: string,
  options: { pollingIntervalMs?: number } = {}
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      `  interval_ms: ${options.pollingIntervalMs ?? 30000}`,
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server"',
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked", "needs-human"]',
      "    priority:",
      "      labels:",
      '        "priority:critical": 0',
      '        "priority:high": 1',
      '        "priority:medium": 2',
      '        "priority:low": 3',
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces/symphonika",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on {{issue.title}}.\n");
}

async function writeConfigWithInvalidAndValidProjects(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server"',
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects:",
      "  - name: malformed",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    agent:",
      "      provider: codex",
      "  - name: symphonika",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    agent:",
      "      provider: codex",
      ""
    ].join("\n")
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("condition was not met before timeout");
}
