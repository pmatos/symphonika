import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { RawGitHubPullRequest } from "../src/issue-polling.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-daemon-pr-merge-test-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const STATE_ROOT_RELATIVE = "./.symphonika";

async function writeValidProject(
  root: string,
  repository: { owner: string; repo: string } = {
    owner: "pmatos",
    repo: "symphonika"
  }
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      `  root: ${STATE_ROOT_RELATIVE}`,
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      `    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"`,
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      `      owner: ${repository.owner}`,
      `      repo: ${repository.repo}`,
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked", "needs-human"]',
      "    priority:",
      "      labels: {}",
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

async function fetchBoundPrLabelForm(
  url: string,
  prPath: string
): Promise<{
  cookie: string;
  csrfToken: string;
  snapshotOwner: string;
  snapshotRepo: string;
}> {
  const response = await fetch(`${url}${prPath}`);
  const html = await response.text();
  const csrfMatch = /name="csrf_token" value="([^"]*)"/.exec(html);
  const ownerMatch = /name="snapshot_owner" value="([^"]*)"/.exec(html);
  const repoMatch = /name="snapshot_repo" value="([^"]*)"/.exec(html);
  const setCookie = response.headers.get("set-cookie");
  if (
    csrfMatch?.[1] === undefined ||
    ownerMatch?.[1] === undefined ||
    repoMatch?.[1] === undefined ||
    setCookie === null
  ) {
    throw new Error(`could not extract bound PR label form from ${html}`);
  }
  return {
    cookie: setCookie.split(";")[0] ?? "",
    csrfToken: csrfMatch[1],
    snapshotOwner: ownerMatch[1],
    snapshotRepo: repoMatch[1]
  };
}

async function appendDuplicateNamedProject(
  root: string,
  repository: { owner: string; repo: string }
): Promise<void> {
  await appendFile(
    path.join(root, "symphonika.yml"),
    [
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      `      owner: ${repository.owner}`,
      `      repo: ${repository.repo}`,
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked", "needs-human"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces/symphonika-duplicate",
      "      git:",
      `        remote: git@github.com:${repository.owner}/${repository.repo}.git`,
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
}

// The daemon polls PRs on startup, the same tick as the issue poll (#309
// part 1) — populating the fixture through that natural poll cycle (rather
// than seeding project_pull_request_snapshots via a side-channel RunStore
// write before startDaemon) avoids the poll immediately overwriting a
// manually-seeded row with its own (empty) result.
function orphanPullRequestFixture(
  overrides: Partial<RawGitHubPullRequest> = {}
): RawGitHubPullRequest {
  return {
    draft: false,
    head: { ref: "sym/symphonika/246-orphan", sha: "abc123" },
    html_url: "https://github.com/pmatos/symphonika/pull/246",
    merged_at: null,
    number: 246,
    state: "open",
    title: "Orphaned PR",
    ...overrides
  };
}

async function fetchPrsCsrfToken(
  url: string,
  prPath: string
): Promise<{
  cookie: string;
  csrfToken: string;
  expectedHeadSha: string;
}> {
  const response = await fetch(`${url}${prPath}`);
  const html = await response.text();
  const match = /name="csrf_token" value="([^"]*)"/.exec(html);
  // The merge form's own hidden field, carrying whatever headSha this page
  // actually shows -- the merge POST is expected to submit this back
  // rather than trust a fresh DB read (ADR 0078).
  const headShaMatch = /name="expected_head_sha" value="([^"]*)"/.exec(html);
  const setCookie = response.headers.get("set-cookie");
  if (
    match?.[1] === undefined ||
    headShaMatch?.[1] === undefined ||
    setCookie === null
  ) {
    throw new Error(
      `could not extract csrf token/head sha/cookie from ${html}`
    );
  }
  return {
    cookie: setCookie.split(";")[0] ?? "",
    csrfToken: match[1],
    expectedHeadSha: headShaMatch[1]
  };
}

describe("daemon-wired POST /prs/:project/:number/merge (#309 part 3, ADR 0078)", () => {
  it("calls GitHubIssuesApi.mergePullRequest with the resolved owner/repo/token and records durable evidence", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([orphanPullRequestFixture()]),
      mergePullRequest: vi.fn().mockResolvedValue(undefined)
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const { cookie, csrfToken, expectedHeadSha } = await fetchPrsCsrfToken(
        daemon.url,
        "/prs/symphonika/246"
      );
      const response = await fetch(`${daemon.url}/prs/symphonika/246/merge`, {
        body: new URLSearchParams({
          csrf_token: csrfToken,
          expected_head_sha: expectedHeadSha
        }).toString(),
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: daemon.url
        },
        method: "POST"
      });
      const html = await response.text();

      expect(html).toContain("Merge attempted on GitHub");
      // No `pull_requests:` block is configured, so this is the policy
      // default (DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY.merge.method) -- not
      // a hardcoded "merge", which 405s on the common squash-only repo
      // configuration.
      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledWith({
        expectedHeadSha: "abc123",
        method: "squash",
        owner: "pmatos",
        pullNumber: 246,
        repo: "symphonika",
        token: "secret-token"
      });

      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        const attempts = runStore.listPullRequestMergeAttempts(
          "symphonika",
          246
        );
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          error: null,
          method: "squash",
          ok: true,
          prNumber: 246,
          projectName: "symphonika"
        });
      } finally {
        runStore.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("uses the project's configured merge method instead of the policy default", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    await appendFile(
      path.join(root, "symphonika.yml"),
      "pull_requests:\n  merge:\n    method: merge\n"
    );
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([orphanPullRequestFixture()]),
      mergePullRequest: vi.fn().mockResolvedValue(undefined)
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const { cookie, csrfToken, expectedHeadSha } = await fetchPrsCsrfToken(
        daemon.url,
        "/prs/symphonika/246"
      );
      await fetch(`${daemon.url}/prs/symphonika/246/merge`, {
        body: new URLSearchParams({
          csrf_token: csrfToken,
          expected_head_sha: expectedHeadSha
        }).toString(),
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: daemon.url
        },
        method: "POST"
      });

      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ method: "merge" })
      );
    } finally {
      await daemon.stop();
    }
  });

  it("surfaces a GitHub-side merge refusal honestly and still records the failed attempt as evidence", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([orphanPullRequestFixture()]),
      mergePullRequest: vi
        .fn()
        .mockRejectedValue(new Error("Pull Request is not mergeable"))
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const { cookie, csrfToken, expectedHeadSha } = await fetchPrsCsrfToken(
        daemon.url,
        "/prs/symphonika/246"
      );
      const response = await fetch(`${daemon.url}/prs/symphonika/246/merge`, {
        body: new URLSearchParams({
          csrf_token: csrfToken,
          expected_head_sha: expectedHeadSha
        }).toString(),
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: daemon.url
        },
        method: "POST"
      });
      const html = await response.text();

      expect(html).toContain("Merge failed");
      expect(html).toContain("Pull Request is not mergeable");
      expect(html).toContain("could not be re-derived");

      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        const attempts = runStore.listPullRequestMergeAttempts(
          "symphonika",
          246
        );
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          error: "Pull Request is not mergeable",
          method: "squash",
          ok: false,
          prNumber: 246,
          projectName: "symphonika"
        });
      } finally {
        runStore.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("does not record evidence when the configured GitHub API cannot attempt the merge", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([orphanPullRequestFixture()])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const { cookie, csrfToken, expectedHeadSha } = await fetchPrsCsrfToken(
        daemon.url,
        "/prs/symphonika/246"
      );
      const response = await fetch(`${daemon.url}/prs/symphonika/246/merge`, {
        body: new URLSearchParams({
          csrf_token: csrfToken,
          expected_head_sha: expectedHeadSha
        }).toString(),
        headers: {
          cookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: daemon.url
        },
        method: "POST"
      });
      const html = await response.text();

      expect(html).toContain(
        "merging is not supported by the configured GitHub API"
      );

      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        expect(
          runStore.listPullRequestMergeAttempts("symphonika", 246)
        ).toEqual([]);
      } finally {
        runStore.close();
      }
    } finally {
      await daemon.stop();
    }
  });
});

describe("daemon-wired POST /prs/:project/:number/labels/add (#309 part 2)", () => {
  it("refuses a stale rendered form after a successful repository swap replaces the same PR number", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([orphanPullRequestFixture()])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const form = await fetchBoundPrLabelForm(
        daemon.url,
        "/prs/symphonika/246"
      );
      await writeValidProject(root, {
        owner: "pmatos",
        repo: "different-repository"
      });
      const pollResponse = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(pollResponse.status).toBe(200);

      const response = await fetch(
        `${daemon.url}/prs/symphonika/246/labels/add`,
        {
          body: new URLSearchParams({
            csrf_token: form.csrfToken,
            label: "agent-ready",
            snapshot_owner: form.snapshotOwner,
            snapshot_repo: form.snapshotRepo
          }).toString(),
          headers: {
            cookie: form.cookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: daemon.url
          },
          method: "POST"
        }
      );
      const html = await response.text();

      expect(html).toContain('Add label "agent-ready" failed');
      expect(html).toContain(
        "rendered snapshot repository pmatos/symphonika does not match current snapshot repository pmatos/different-repository"
      );
      expect(githubIssuesApi.addLabelsToIssue).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it("does not expose PR rows polled from a shadowed duplicate Project repository", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    await appendDuplicateNamedProject(root, {
      owner: "pmatos",
      repo: "different-repository"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn((input: { repo: string }) =>
        Promise.resolve([
          orphanPullRequestFixture({
            head: {
              ref: `sym/symphonika/${input.repo === "symphonika" ? 246 : 247}-orphan`,
              sha: input.repo === "symphonika" ? "abc123" : "def456"
            },
            html_url: `https://github.com/pmatos/${input.repo}/pull/${input.repo === "symphonika" ? 246 : 247}`,
            number: input.repo === "symphonika" ? 246 : 247,
            title:
              input.repo === "symphonika"
                ? "Shadowed repository PR"
                : "Active repository PR"
          })
        ])
      )
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const { cookie, csrfToken } = await fetchPrsCsrfToken(
        daemon.url,
        "/prs/symphonika/247"
      );
      const response = await fetch(
        `${daemon.url}/prs/symphonika/246/labels/add`,
        {
          body: new URLSearchParams({
            csrf_token: csrfToken,
            label: "agent-ready"
          }).toString(),
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: daemon.url
          },
          method: "POST"
        }
      );

      expect(response.status).toBe(404);
      expect(githubIssuesApi.addLabelsToIssue).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });
});
