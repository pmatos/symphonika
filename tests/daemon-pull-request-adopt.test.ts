import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type {
  RawGitHubIssue,
  RawGitHubPullRequest,
  RawGitHubPullRequestFollowupState
} from "../src/issue-polling.js";
import { openRunStore } from "../src/run-store.js";
import { planWorkspacePaths } from "../src/workspace-paths.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-daemon-pr-adopt-test-")
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

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

async function createRemoteRepository(
  root: string
): Promise<{ remotePath: string; seedPath: string }> {
  const remotePath = path.join(root, "remote.git");
  const seedPath = path.join(root, "seed");
  await git(["init", "--bare", remotePath]);
  await git(["init", "--initial-branch=main", seedPath]);
  await git(["-C", seedPath, "config", "user.email", "test@example.com"]);
  await git(["-C", seedPath, "config", "user.name", "Symphonika Test"]);
  await writeFile(path.join(seedPath, "README.md"), "# Symphonika\n");
  await git(["-C", seedPath, "add", "README.md"]);
  await git(["-C", seedPath, "commit", "-m", "Initial commit"]);
  await git(["-C", seedPath, "remote", "add", "origin", remotePath]);
  await git(["-C", seedPath, "push", "origin", "main"]);
  return { remotePath, seedPath };
}

async function branchExists(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    await git(["-C", repoPath, "rev-parse", "--verify", "--quiet", branchName]);
    return true;
  } catch {
    return false;
  }
}

async function pushBranchCommit(
  seedPath: string,
  branchName: string,
  fileName: string,
  content: string
): Promise<string> {
  if (await branchExists(seedPath, branchName)) {
    await git(["-C", seedPath, "checkout", branchName]);
  } else {
    await git(["-C", seedPath, "checkout", "-b", branchName, "main"]);
  }
  await writeFile(path.join(seedPath, fileName), content);
  await git(["-C", seedPath, "add", fileName]);
  await git(["-C", seedPath, "commit", "-m", `update ${fileName}`]);
  await git(["-C", seedPath, "push", "origin", branchName]);
  const sha = await git(["-C", seedPath, "rev-parse", "HEAD"]);
  await git(["-C", seedPath, "checkout", "main"]);
  return sha;
}

const STATE_ROOT_RELATIVE = "./.symphonika";
const ISSUE = { number: 246, title: "Orphan pr" };
const PROJECT_NAME = "symphonika";
const branchName = planWorkspacePaths({
  issue: ISSUE,
  project: { name: PROJECT_NAME, workspace: { root: "unused" } }
}).branchName;

// A raw FSM (not markdown) workflow, so listAdoptableEntryStates finds real
// wait/merge_pr states: implement (agent, never adoptable) -> wait_for_pr
// (wait, adoptable) -> merging (merge_pr, adoptable) -> done (terminal).
async function writeAdoptPrProject(
  root: string,
  remotePath: string
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
      '    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"',
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects:",
      `  - name: ${PROJECT_NAME}`,
      "    disabled: false",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      `      repo: ${PROJECT_NAME}`,
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked", "needs-human"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      `      root: ./.symphonika/workspaces/${PROJECT_NAME}`,
      "      git:",
      `        remote: ${remotePath}`,
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./workflow.yml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: adopt_pr_test",
      "  initial: implement",
      "  states:",
      "    implement:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      transitions:",
      "        - to: wait_for_pr",
      "          when:",
      "            provider_success: true",
      "    wait_for_pr:",
      "      action:",
      "        kind: wait",
      "      transitions:",
      "        - to: merging",
      "          when:",
      "            checks: success",
      "            unresolved_review_threads: 0",
      "        - to: implement",
      "          when:",
      "            checks: failure",
      "        - to: implement",
      "          when:",
      "            has_unresolved_reviews: true",
      "    merging:",
      "      action:",
      "        kind: merge_pr",
      "        method: squash",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            pr_merged: true",
      "        - to: implement",
      "          when:",
      "            pr_open: false",
      "        - to: implement",
      "          when:",
      "            checks: failure",
      "        - to: implement",
      "          when:",
      "            mergeable: false",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

// A second project shape with no wait/merge_pr state anywhere -- the
// builtin_single_agent_pr case ADR-2026-09-03-1158 refuses outright.
async function writeNonPrAwareProject(root: string): Promise<void> {
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
      '    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"',
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects:",
      `  - name: ${PROJECT_NAME}`,
      "    disabled: false",
      "    weight: 1",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      `      repo: ${PROJECT_NAME}`,
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked", "needs-human"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      `      root: ./.symphonika/workspaces/${PROJECT_NAME}`,
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./workflow.yml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: single_agent",
      "  initial: implement",
      "  states:",
      "    implement:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            provider_success: true",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

function issueFixture(overrides: Partial<RawGitHubIssue> = {}): RawGitHubIssue {
  return {
    body: "",
    created_at: "2026-05-01T00:00:00Z",
    html_url: `https://github.com/pmatos/symphonika/issues/${ISSUE.number}`,
    id: 5001,
    labels: [],
    number: ISSUE.number,
    state: "open",
    title: ISSUE.title,
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

function pullRequestFixture(
  headSha: string,
  overrides: Partial<RawGitHubPullRequest> = {}
): RawGitHubPullRequest {
  return {
    draft: false,
    head: { ref: branchName, sha: headSha },
    html_url: "https://github.com/pmatos/symphonika/pull/12",
    merged_at: null,
    number: 12,
    state: "open",
    title: "Fix login",
    ...overrides
  };
}

function followupStateFixture(
  overrides: Partial<RawGitHubPullRequestFollowupState> = {}
): RawGitHubPullRequestFollowupState {
  return {
    draft: false,
    headSha: "will-be-overridden",
    mergeable: "MERGEABLE",
    merged: false,
    number: 12,
    reviewDecision: "APPROVED",
    state: "OPEN",
    statusCheckRollupState: "SUCCESS",
    unresolvedReviewThreads: [],
    url: "https://example.test/pr/12",
    ...overrides
  };
}

async function postAdopt(
  daemonUrl: string,
  project: string,
  prNumber: number,
  issueNumber: number,
  entryStateId: string
): Promise<{ body: unknown; status: number }> {
  const response = await fetch(
    `${daemonUrl}/api/prs/${project}/${prNumber}/adopt`,
    {
      body: JSON.stringify({ entryStateId, issueNumber }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }
  );
  return { body: await response.json(), status: response.status };
}

describe("daemon-wired POST /api/prs/:project/:number/adopt (ADR-2026-09-03-1158)", () => {
  it("adopts an orphaned PR into a waiting Run parked at the requested state", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const headSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "fix v1\n"
    );
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([pullRequestFixture(headSha)])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "wait_for_pr"
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ kind: "adopted" });
      const runId = (body as { runId: string }).runId;

      expect(githubIssuesApi.addLabelsToIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: ISSUE.number,
          labels: ["sym:claimed"]
        })
      );

      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        const run = runStore.getRun(runId);
        expect(run?.state).toBe("waiting");
        expect(run?.currentStateId).toBe("wait_for_pr");
        expect(run?.stateTransitionReason).toBe("adopted_pull_request");
        expect(run?.isContinuation).toBe(false);
        expect(run?.workspacePath).toContain(PROJECT_NAME);

        const tracked = runStore.findTrackedPullRequestByProjectAndNumber({
          prNumber: 12,
          projectName: PROJECT_NAME
        });
        expect(tracked?.runId).toBe(runId);
        expect(tracked?.branchName).toBe(branchName);
      } finally {
        runStore.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("advances and merges immediately on the next poll tick when the entry state's predicates are already satisfied", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const headSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "fix v1\n"
    );
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      getPullRequestFollowupState: vi
        .fn()
        .mockResolvedValue(followupStateFixture({ headSha })),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi
        .fn()
        .mockResolvedValue([pullRequestFixture(headSha)]),
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
      // Adopted directly into `merging` (kind: merge_pr) -- the PR already
      // satisfies the merge policy per followupStateFixture's defaults, so
      // this is the accepted-risk scenario ADR-2026-09-03-1158 documents: no dwell
      // time, the parked position's own transitions decide.
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "merging"
      );
      expect(status).toBe(200);
      const runId = (body as { runId: string }).runId;

      const pollResponse = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(pollResponse.status).toBe(200);

      expect(githubIssuesApi.mergePullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ method: "squash", pullNumber: 12 })
      );

      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        const run = runStore.getRun(runId);
        expect(run?.state).toBe("succeeded");
        expect(run?.terminalStateId).toBe("done");
      } finally {
        runStore.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("refuses invalid-entry-state for a state whose action.kind is not wait or merge_pr", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const headSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "fix v1\n"
    );
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([pullRequestFixture(headSha)])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "implement"
      );
      expect(status).toBe(422);
      const parsed = body as { kind: string; validStateIds: string[] };
      expect(parsed.kind).toBe("invalid-entry-state");
      expect(parsed.validStateIds).toContain("wait_for_pr");
      expect(parsed.validStateIds).toContain("merging");
    } finally {
      await daemon.stop();
    }
  });

  it("refuses not-pr-aware-workflow when the project's workflow has no wait/merge_pr state", async () => {
    const root = await makeTempRoot();
    await writeNonPrAwareProject(root);
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "implement"
      );
      expect(status).toBe(422);
      expect(body).toEqual({ kind: "not-pr-aware-workflow" });
    } finally {
      await daemon.stop();
    }
  });

  it("refuses live-run-conflict when a Run already owns the issue", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const headSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "fix v1\n"
    );
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([pullRequestFixture(headSha)])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        runStore.createRun({
          id: "live-run",
          issue: {
            body: "",
            created_at: "",
            id: 1,
            labels: [],
            number: ISSUE.number,
            priority: 99,
            state: "open",
            title: ISSUE.title,
            updated_at: "",
            url: `https://github.com/pmatos/symphonika/issues/${ISSUE.number}`
          },
          projectName: PROJECT_NAME,
          providerCommand: "codex",
          providerName: "codex"
        });
      } finally {
        runStore.close();
      }

      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "wait_for_pr"
      );
      expect(status).toBe(409);
      expect(body).toEqual({ kind: "live-run-conflict", runId: "live-run" });
    } finally {
      await daemon.stop();
    }
  });

  it("refuses not-issue-branch when the PR's head is not this project's deterministic branch", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    await pushBranchCommit(seedPath, "some-other-branch", "x.txt", "x\n");
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([
        pullRequestFixture("deadbeef", {
          head: { ref: "some-other-branch", sha: "deadbeef" }
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
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "wait_for_pr"
      );
      expect(status).toBe(422);
      expect(body).toEqual({ kind: "not-issue-branch" });
    } finally {
      await daemon.stop();
    }
  });

  it("adopts a PR whose issue title was edited after the branch was created", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const headSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "fix v1\n"
    );
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // The title fetched live at adoption time no longer matches the title
      // that produced `branchName` above -- a maintainer edit that happened
      // any time after the branch's original Run created it.
      getIssue: vi
        .fn()
        .mockResolvedValue(issueFixture({ title: "Orphan pr, renamed" })),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([pullRequestFixture(headSha)])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "wait_for_pr"
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ kind: "adopted" });
      const runId = (body as { runId: string }).runId;

      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        const run = runStore.getRun(runId);
        // Workspace pathing follows the branch's own (pre-rename) slug, not
        // a fresh recompute from the renamed title.
        expect(run?.workspacePath).toContain("orphan-pr");
        expect(run?.workspacePath).not.toContain("renamed");

        const tracked = runStore.findTrackedPullRequestByProjectAndNumber({
          prNumber: 12,
          projectName: PROJECT_NAME
        });
        expect(tracked?.branchName).toBe(branchName);
      } finally {
        runStore.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("refuses snapshot-unavailable when the Project hasn't polled this PR yet", async () => {
    const root = await makeTempRoot();
    const { remotePath } = await createRemoteRepository(root);
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        999,
        ISSUE.number,
        "wait_for_pr"
      );
      expect(status).toBe(422);
      expect(body).toEqual({ kind: "snapshot-unavailable" });
    } finally {
      await daemon.stop();
    }
  });

  it("refuses snapshot-incomplete when the polled snapshot has no URL", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const headSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "fix v1\n"
    );
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi
        .fn()
        .mockResolvedValue([pullRequestFixture(headSha, { html_url: null })])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "wait_for_pr"
      );
      expect(status).toBe(422);
      expect(body).toEqual({ kind: "snapshot-incomplete" });
    } finally {
      await daemon.stop();
    }
  });

  it("reassigns a stale tracked_pull_requests row to the newly-adopted run", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const headSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "fix v1\n"
    );
    await writeAdoptPrProject(root, remotePath);
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issueFixture()),
      listOpenIssues: vi.fn().mockResolvedValue([]),
      listPullRequests: vi.fn().mockResolvedValue([pullRequestFixture(headSha)])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });
    try {
      const runStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        runStore.createRun({
          id: "dead-run",
          issue: {
            body: "",
            created_at: "",
            id: 1,
            labels: [],
            number: ISSUE.number,
            priority: 99,
            state: "open",
            title: ISSUE.title,
            updated_at: "",
            url: `https://github.com/pmatos/symphonika/issues/${ISSUE.number}`
          },
          projectName: PROJECT_NAME,
          providerCommand: "codex",
          providerName: "codex"
        });
        runStore.updateRunState("dead-run", "failed");
        runStore.trackPullRequest({
          branchName,
          headSha,
          issueNumber: ISSUE.number,
          prNumber: 12,
          projectName: PROJECT_NAME,
          prUrl: "https://github.com/pmatos/symphonika/pull/12",
          runId: "dead-run"
        });
      } finally {
        runStore.close();
      }

      const { body, status } = await postAdopt(
        daemon.url,
        PROJECT_NAME,
        12,
        ISSUE.number,
        "wait_for_pr"
      );
      expect(status).toBe(200);
      const runId = (body as { runId: string }).runId;
      expect(runId).not.toBe("dead-run");

      const verifyRunStore = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        const tracked = verifyRunStore.findTrackedPullRequestByProjectAndNumber(
          {
            prNumber: 12,
            projectName: PROJECT_NAME
          }
        );
        expect(tracked?.runId).toBe(runId);
      } finally {
        verifyRunStore.close();
      }
    } finally {
      await daemon.stop();
    }
  });
});
