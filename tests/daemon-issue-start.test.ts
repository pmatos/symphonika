import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type {
  AgentProvider,
  AgentProviderName,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type { PreparedIssueWorkspace } from "../src/workspace.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-daemon-start-"));
  tempRoots.push(root);
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
      '    command: "codex app-server"',
      "  claude:",
      '    command: "claude -p"',
      "  omp:",
      '    command: "omp --mode rpc"',
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
      "    workflow: ./workflow.yml",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: two_stage",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
      "      transitions:",
      "        - to: autofix",
      "    autofix:",
      "      action:",
      "        kind: agent",
      "        provider: claude",
      "        prompt: autofix-prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
      "      transitions:",
      "        - to: done",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Plan #{{issue.number}}.\n"
  );
  await writeFile(
    path.join(root, "autofix-prompt.md"),
    "Fix #{{issue.number}}.\n"
  );
  return root;
}

function issueFixture(labels: string[]) {
  return {
    body: "body",
    created_at: "2026-04-20T10:00:00Z",
    html_url: "https://github.com/pmatos/symphonika/issues/8",
    id: 5008,
    labels,
    number: 8,
    state: "open",
    title: "Dispatch an end-to-end run through a test provider",
    updated_at: "2026-04-21T11:00:00Z"
  };
}

function trackingProvider(
  name: AgentProviderName,
  inputs: ProviderRunInput[]
): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name,
    runAttempt: vi.fn(async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      inputs.push(input);
      yield {
        normalized: { exitCode: 0, type: "process_exit" },
        raw: { code: 0, kind: "exit" }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

function preparedWorkspace(root: string): PreparedIssueWorkspace {
  const issueDirectoryName =
    "8-dispatch-an-end-to-end-run-through-a-test-provider";
  return {
    branchName: `sym/symphonika/${issueDirectoryName}`,
    branchRef: `refs/heads/sym/symphonika/${issueDirectoryName}`,
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName,
    reused: false,
    workspacePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      issueDirectoryName
    )
  };
}

function queryDatabase<T>(root: string, sql: string): T[] {
  const database = new Database(
    path.join(root, ".symphonika", "symphonika.db"),
    { readonly: true }
  );
  try {
    return database.prepare(sql).all() as T[];
  } finally {
    database.close();
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch {
      // the daemon may still be creating its SQLite store
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openStartPage(url: string) {
  const response = await fetch(`${url}/issues/symphonika/8/start`);
  const html = await response.text();
  const field = (name: string): string =>
    new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    csrfToken: field("csrf_token"),
    graphFingerprint: field("graph_fingerprint"),
    html,
    snapshotOwner: field("snapshot_owner"),
    snapshotPolledAt: field("snapshot_polled_at"),
    snapshotRepo: field("snapshot_repo"),
    status: response.status
  };
}

async function postStart(
  url: string,
  page: Awaited<ReturnType<typeof openStartPage>>,
  provider: string
): Promise<string> {
  const response = await fetch(`${url}/issues/symphonika/8/start`, {
    body: new URLSearchParams({
      csrf_token: page.csrfToken,
      graph_fingerprint: page.graphFingerprint,
      provider,
      snapshot_owner: page.snapshotOwner,
      snapshot_polled_at: page.snapshotPolledAt,
      snapshot_repo: page.snapshotRepo
    }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: page.cookie
    },
    method: "POST"
  });
  return response.text();
}

describe("daemon start with a chain-wide provider (#861)", () => {
  it("persists the plan before labelling, then runs every state of the chain on the chosen provider", async () => {
    const root = await makeProject();
    const labels: string[] = [];
    let planStatusAtLabelWrite: string | undefined;
    const addLabelsToIssue = vi.fn((input: { labels: string[] }) => {
      if (input.labels.includes("agent-ready")) {
        planStatusAtLabelWrite = queryDatabase<{ status: string }>(
          root,
          "select status from run_chain_provider_plans"
        )[0]?.status;
      }
      labels.push(...input.labels);
      return Promise.resolve();
    });
    const githubIssuesApi = {
      addLabelsToIssue,
      getIssue: vi.fn(() => Promise.resolve(issueFixture([...labels]))),
      getIssueDependencies: vi.fn().mockResolvedValue(new Map()),
      listOpenIssues: vi.fn(() => Promise.resolve([issueFixture([...labels])])),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const ompInputs: ProviderRunInput[] = [];
    const workspace = preparedWorkspace(root);
    await createGitWorkspaceAhead(workspace);
    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: {
        claude: trackingProvider("claude", claudeInputs),
        codex: trackingProvider("codex", codexInputs),
        omp: trackingProvider("omp", ompInputs)
      },
      createRunId: () => `run-start-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(workspace)
    });

    try {
      let page = await openStartPage(daemon.url);
      await waitFor(async () => {
        page = await openStartPage(daemon.url);
        return page.status === 200 && page.snapshotPolledAt !== "";
      }, "the first poll to publish the issue snapshot");
      expect(page.html).toContain("pmatos/symphonika#8");
      expect(page.html).toContain(page.graphFingerprint);

      const result = await postStart(daemon.url, page, "omp");
      expect(result).toContain("the Ready Label was added on GitHub");
      expect(planStatusAtLabelWrite).toBe("pending");

      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await waitFor(
        () =>
          queryDatabase<{ c: number }>(
            root,
            "select count(*) as c from runs where state = 'succeeded'"
          )[0]?.c === 2,
        "both chain states to succeed"
      );

      expect(ompInputs).toHaveLength(2);
      expect(codexInputs).toHaveLength(0);
      expect(claudeInputs).toHaveLength(0);
      expect(
        queryDatabase<{ provider_name: string }>(
          root,
          "select provider_name from runs order by created_at"
        ).map((row) => row.provider_name)
      ).toEqual(["omp", "omp"]);
      expect(
        queryDatabase<{ status: string; consumed_run_id: string }>(
          root,
          "select status, consumed_run_id from run_chain_provider_plans"
        )
      ).toEqual([{ consumed_run_id: "run-start-1", status: "consumed" }]);
    } finally {
      await daemon.stop();
    }
  });

  it("reports a label write failure honestly and keeps a retryable plan that blocks default dispatch", async () => {
    const root = await makeProject();
    const labels: string[] = [];
    let failWrites = true;
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn((input: { labels: string[] }) => {
        if (failWrites && input.labels.includes("agent-ready")) {
          return Promise.reject(new Error("403 forbidden"));
        }
        labels.push(...input.labels);
        return Promise.resolve();
      }),
      getIssue: vi.fn(() => Promise.resolve(issueFixture([...labels]))),
      getIssueDependencies: vi.fn().mockResolvedValue(new Map()),
      listOpenIssues: vi.fn(() => Promise.resolve([issueFixture([...labels])])),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const ompInputs: ProviderRunInput[] = [];
    const codexInputs: ProviderRunInput[] = [];
    let retryRunCounter = 0;
    const workspace = preparedWorkspace(root);
    await createGitWorkspaceAhead(workspace);
    const daemon = await startDaemon({
      agentProviders: {
        claude: trackingProvider("claude", []),
        codex: trackingProvider("codex", codexInputs),
        omp: trackingProvider("omp", ompInputs)
      },
      createRunId: () => `run-retry-${++retryRunCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(workspace)
    });

    try {
      let page = await openStartPage(daemon.url);
      await waitFor(async () => {
        page = await openStartPage(daemon.url);
        return page.status === 200 && page.snapshotPolledAt !== "";
      }, "the first poll to publish the issue snapshot");

      const failed = await postStart(daemon.url, page, "omp");
      expect(failed).toContain("The Ready Label write failed");
      expect(failed).toContain("403 forbidden");
      expect(
        queryDatabase<{ status: string }>(
          root,
          "select status from run_chain_provider_plans"
        )[0]?.status
      ).toBe("label_failed");

      failWrites = false;
      const retry = await fetch(
        `${daemon.url}/issues/symphonika/8/start/retry`,
        {
          body: new URLSearchParams({
            csrf_token: page.csrfToken,
            plan_id:
              queryDatabase<{ id: string }>(
                root,
                "select id from run_chain_provider_plans"
              )[0]?.id ?? "",
            snapshot_owner: page.snapshotOwner,
            snapshot_repo: page.snapshotRepo
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: page.cookie
          },
          method: "POST"
        }
      );
      expect(await retry.text()).toContain("Retried");

      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await waitFor(
        () =>
          queryDatabase<{ c: number }>(
            root,
            "select count(*) as c from runs where state = 'succeeded'"
          )[0]?.c === 2,
        "the retried plan to dispatch"
      );
      expect(ompInputs.length).toBeGreaterThan(0);
      expect(codexInputs).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  });

  it("refuses a Start whose preview predates a workflow edit", async () => {
    const root = await makeProject();
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn(() => Promise.resolve(issueFixture([]))),
      getIssueDependencies: vi.fn().mockResolvedValue(new Map()),
      listOpenIssues: vi.fn(() => Promise.resolve([issueFixture([])])),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const daemon = await startDaemon({
      agentProviders: {
        claude: trackingProvider("claude", []),
        codex: trackingProvider("codex", []),
        omp: trackingProvider("omp", [])
      },
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      let page = await openStartPage(daemon.url);
      await waitFor(async () => {
        page = await openStartPage(daemon.url);
        return page.status === 200 && page.snapshotPolledAt !== "";
      }, "the first poll to publish the issue snapshot");

      const tampered = await postStart(
        daemon.url,
        { ...page, graphFingerprint: "sha256:stale" },
        "omp"
      );

      expect(tampered).toContain("Start refused");
      expect(tampered).toContain("workflow changed");
      expect(githubIssuesApi.addLabelsToIssue).not.toHaveBeenCalled();
      expect(
        queryDatabase(root, "select id from run_chain_provider_plans")
      ).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  });
});
