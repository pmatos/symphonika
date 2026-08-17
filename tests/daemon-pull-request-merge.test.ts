import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function writeValidProject(root: string): Promise<void> {
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
      "      owner: pmatos",
      "      repo: symphonika",
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

// The daemon polls PRs on startup, the same tick as the issue poll (#309
// part 1) — populating the fixture through that natural poll cycle (rather
// than seeding project_pull_request_snapshots via a side-channel RunStore
// write before startDaemon) avoids the poll immediately overwriting a
// manually-seeded row with its own (empty) result.
function orphanPullRequestFixture(): RawGitHubPullRequest {
  return {
    draft: false,
    head: { ref: "sym/symphonika/246-orphan", sha: "abc123" },
    html_url: "https://github.com/pmatos/symphonika/pull/246",
    merged_at: null,
    number: 246,
    state: "open",
    title: "Orphaned PR"
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
      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledWith({
        expectedHeadSha: "abc123",
        method: "merge",
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
          method: "merge",
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
          method: "merge",
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
});
