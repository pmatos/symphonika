import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-daemon-issue-labels-test-")
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
      "  root: ./.symphonika",
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

function issueFixture(overrides: {
  labels: unknown[];
  number: number;
  title: string;
}) {
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

async function fetchIssuesCsrfToken(
  url: string,
  issuePath: string
): Promise<{
  cookie: string;
  csrfToken: string;
}> {
  const response = await fetch(`${url}${issuePath}`);
  const html = await response.text();
  const match = /name="csrf_token" value="([^"]*)"/.exec(html);
  const setCookie = response.headers.get("set-cookie");
  if (match?.[1] === undefined || setCookie === null) {
    throw new Error(`could not extract csrf token/cookie from ${html}`);
  }
  return { cookie: setCookie.split(";")[0] ?? "", csrfToken: match[1] };
}

describe("daemon-wired POST /issues/:project/:number/labels/(add|remove) (#308 part 2)", () => {
  it("calls GitHubIssuesApi.addLabelsToIssue with the project's resolved owner/repo/token", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi
        .fn()
        .mockResolvedValue([
          issueFixture({ labels: ["blocked"], number: 6, title: "Filtered" })
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
      const { cookie, csrfToken } = await fetchIssuesCsrfToken(
        daemon.url,
        "/issues/symphonika/6"
      );
      const response = await fetch(
        `${daemon.url}/issues/symphonika/6/labels/add`,
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
      const html = await response.text();

      expect(html).toContain('Added label "agent-ready" on GitHub');
      expect(githubIssuesApi.addLabelsToIssue).toHaveBeenCalledWith({
        issueNumber: 6,
        labels: ["agent-ready"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
    } finally {
      await daemon.stop();
    }
  });

  it("surfaces a real GitHub API failure through the full daemon wiring", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      removeLabelsFromIssue: vi
        .fn()
        .mockRejectedValue(new Error("404 Label does not exist")),
      listOpenIssues: vi
        .fn()
        .mockResolvedValue([
          issueFixture({ labels: ["blocked"], number: 6, title: "Filtered" })
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
      const { cookie, csrfToken } = await fetchIssuesCsrfToken(
        daemon.url,
        "/issues/symphonika/6"
      );
      const response = await fetch(
        `${daemon.url}/issues/symphonika/6/labels/remove`,
        {
          body: new URLSearchParams({
            csrf_token: csrfToken,
            label: "blocked"
          }).toString(),
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: daemon.url
          },
          method: "POST"
        }
      );
      const html = await response.text();

      expect(html).toContain('Remove label "blocked" failed');
      expect(html).toContain("404 Label does not exist");
      expect(html).toContain("labels shown below are unchanged");
    } finally {
      await daemon.stop();
    }
  });

  it("refuses a label write when hot reload points the Project at a different repository", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn(
        (input: {
          repo: string;
        }): Promise<ReturnType<typeof issueFixture>[]> =>
          input.repo === "symphonika"
            ? Promise.resolve([
                issueFixture({
                  labels: ["blocked"],
                  number: 6,
                  title: "Filtered"
                })
              ])
            : Promise.reject(new Error("new repository poll failed"))
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
      const { cookie, csrfToken } = await fetchIssuesCsrfToken(
        daemon.url,
        "/issues/symphonika/6"
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
        `${daemon.url}/issues/symphonika/6/labels/add`,
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
      const html = await response.text();

      expect(html).toContain('Add label "agent-ready" failed');
      expect(html).toContain(
        "snapshot repository pmatos/symphonika does not match current tracker repository pmatos/different-repository"
      );
      expect(githubIssuesApi.addLabelsToIssue).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it("does not expose issue rows polled from a shadowed duplicate Project repository", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    await appendDuplicateNamedProject(root, {
      owner: "pmatos",
      repo: "different-repository"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn((input: { repo: string }) =>
        Promise.resolve([
          issueFixture({
            labels: ["blocked"],
            number: input.repo === "symphonika" ? 6 : 7,
            title:
              input.repo === "symphonika"
                ? "Shadowed repository issue"
                : "Active repository issue"
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
      const { cookie, csrfToken } = await fetchIssuesCsrfToken(
        daemon.url,
        "/issues/symphonika/7"
      );
      const response = await fetch(
        `${daemon.url}/issues/symphonika/6/labels/add`,
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
