import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { LifecyclePolicy } from "../src/lifecycle/active-runs.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];
const noFollowupPolicy: LifecyclePolicy = {
  continuation: { cap: 0, delayMs: 0 },
  retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
};

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-reload-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("daemon hot reload", () => {
  it("reschedules automatic polling when polling.interval_ms changes", async () => {
    const root = await makeTempRoot();
    await writeProject(root, { pollingIntervalMs: 1_000 });
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([])
    };

    const daemon = await startDaemon({
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      expect(githubIssuesApi.listOpenIssues).toHaveBeenCalledTimes(1);

      await writeProject(root, { pollingIntervalMs: 10 });
      const response = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(response.status).toBe(200);
      await waitFor(() =>
        Promise.resolve(githubIssuesApi.listOpenIssues.mock.calls.length >= 4)
      );
    } finally {
      await daemon.stop();
    }
  });

  it("keeps last-known-good behavior and reports reload errors when service config reload is invalid", async () => {
    const root = await makeTempRoot();
    await writeProject(root, { pollingIntervalMs: 1_000 });
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready"],
          number: 81,
          title: "Reloadable issue"
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
      await expectCandidateNumbers(daemon.url, [81]);

      await writeFile(path.join(root, "symphonika.yml"), "projects:\n  - [\n");
      const response = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(response.status).toBe(200);

      const status = await statusJson(daemon.url);
      expect(candidateNumbers(status)).toEqual([81]);
      expect(status.reload).toMatchObject({
        ok: false,
        errors: [expect.stringContaining("service config could not be parsed")]
      });
      expect(githubIssuesApi.listOpenIssues).toHaveBeenCalledTimes(2);
    } finally {
      await daemon.stop();
    }
  });

  it("keeps periodic reload attempts after an invalid startup config", async () => {
    const root = await makeTempRoot();
    await writeProjectWithoutProviders(root, { pollingIntervalMs: 10 });
    const githubIssuesApi = {
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready"],
          number: 82,
          title: "Recovered startup config"
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
      expect(githubIssuesApi.listOpenIssues).not.toHaveBeenCalled();

      await writeProject(root, { pollingIntervalMs: 10 });
      await waitFor(() =>
        Promise.resolve(githubIssuesApi.listOpenIssues.mock.calls.length >= 1)
      );
    } finally {
      await daemon.stop();
    }
  });

  it("applies changed project filters, provider commands, and workflow prompts to future work", async () => {
    const root = await makeTempRoot();
    await writeProject(root, {
      labelsAll: ["agent-ready"],
      pollingIntervalMs: 1_000,
      providerCommand: "codex old-command app-server",
      workflowBody: "First workflow for {{issue.title}}.\n"
    });
    const firstWorkspace = preparedWorkspaceFixture(root, 81, "first-reload-run");
    const secondWorkspace = preparedWorkspaceFixture(root, 82, "second-reload-run");
    await createGitWorkspaceAhead(firstWorkspace);
    await createGitWorkspaceAhead(secondWorkspace);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(null),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([
          issueFixture({
            labels: ["agent-ready"],
            number: 81,
            title: "First reload run"
          })
        ])
        .mockResolvedValueOnce([
          issueFixture({
            labels: ["next-ready"],
            number: 82,
            title: "Second reload run"
          }),
          issueFixture({
            labels: ["agent-ready"],
            number: 83,
            title: "Old filter should not dispatch"
          })
        ])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const providerInputs: ProviderRunInput[] = [];
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        providerInputs.push(input);
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        return Promise.resolve(
          input.issue.number === 82 ? secondWorkspace : firstWorkspace
        );
      }
    );
    let runSequence = 0;

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-reload-${++runSequence}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: noFollowupPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitFor(() => Promise.resolve(providerInputs.length === 1));
      await waitForRunCount(daemon.url, 1);

      await writeProject(root, {
        labelsAll: ["next-ready"],
        pollingIntervalMs: 1_000,
        providerCommand: "codex new-command app-server",
        workflowBody: "Second workflow for {{issue.title}}.\n"
      });
      const response = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(response.status).toBe(200);
      await waitFor(() => Promise.resolve(providerInputs.length === 2));
      await waitForRunCount(daemon.url, 2);

      expect(providerInputs[0]?.issue.number).toBe(81);
      expect(providerInputs[0]?.provider.command).toBe(
        "codex old-command app-server"
      );
      expect(providerInputs[0]?.prompt).toContain(
        "First workflow for First reload run."
      );
      expect(providerInputs[1]?.issue.number).toBe(82);
      expect(providerInputs[1]?.provider.command).toBe(
        "codex new-command app-server"
      );
      expect(providerInputs[1]?.prompt).toContain(
        "Second workflow for Second reload run."
      );
      expect(providerInputs[1]?.prompt).not.toContain("First workflow");
      expect(prepareIssueWorkspace).toHaveBeenCalledTimes(2);
    } finally {
      await daemon.stop();
    }
  });

  it("keeps the last good workflow snapshot when a workflow reload is invalid", async () => {
    const root = await makeTempRoot();
    await writeProject(root, {
      pollingIntervalMs: 1_000,
      workflowBody: "Stable workflow for {{issue.title}}.\n"
    });
    const firstWorkspace = preparedWorkspaceFixture(root, 91, "first-workflow-run");
    const secondWorkspace = preparedWorkspaceFixture(root, 92, "second-workflow-run");
    await createGitWorkspaceAhead(firstWorkspace);
    await createGitWorkspaceAhead(secondWorkspace);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(null),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([
          issueFixture({
            labels: ["agent-ready"],
            number: 91,
            title: "First workflow run"
          })
        ])
        .mockResolvedValueOnce([
          issueFixture({
            labels: ["agent-ready"],
            number: 92,
            title: "Second workflow run"
          })
        ])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const providerInputs: ProviderRunInput[] = [];
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        providerInputs.push(input);
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        return Promise.resolve(
          input.issue.number === 92 ? secondWorkspace : firstWorkspace
        );
      }
    );
    let runSequence = 0;

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-workflow-reload-${++runSequence}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: noFollowupPolicy,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitFor(() => Promise.resolve(providerInputs.length === 1));

      await writeFile(
        path.join(root, "WORKFLOW.md"),
        "Broken workflow for {{not_a_real_object.title}}.\n"
      );
      const response = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(response.status).toBe(200);
      await waitFor(() => Promise.resolve(providerInputs.length === 2));

      expect(providerInputs[1]?.issue.number).toBe(92);
      expect(providerInputs[1]?.prompt).toContain(
        "Stable workflow for Second workflow run."
      );
      expect(providerInputs[1]?.prompt).not.toContain("Broken workflow");
      const status = await statusJson(daemon.url);
      expect(status.reload).toMatchObject({
        ok: false,
        usingLastKnownGood: true,
        errors: [expect.stringContaining("references unknown variable")]
      });
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

async function expectCandidateNumbers(
  url: string,
  expected: number[]
): Promise<void> {
  await waitFor(async () => candidateNumbers(await statusJson(url)).join(",") === expected.join(","));
}

async function statusJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/api/status`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function candidateNumbers(status: Record<string, unknown>): number[] {
  const candidates = status["candidateIssues"];
  if (!Array.isArray(candidates)) {
    return [];
  }
  const numbers: number[] = [];
  for (const entry of candidates) {
    if (!isRecord(entry)) {
      continue;
    }
    const issue = entry["issue"];
    if (!isRecord(issue)) {
      continue;
    }
    const number = issue["number"];
    if (typeof number === "number") {
      numbers.push(number);
    }
  }
  return numbers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function writeProject(
  root: string,
  options: {
    labelsAll?: string[];
    pollingIntervalMs: number;
    providerCommand?: string;
    workflowBody?: string;
  }
): Promise<void> {
  await mkdir(root, { recursive: true });
  const labelsAll = options.labelsAll ?? ["agent-ready"];
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      `  interval_ms: ${options.pollingIntervalMs}`,
      "providers:",
      "  codex:",
      `    command: "${options.providerCommand ?? "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"}"`,
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
      `      labels_all: [${labelsAll.map((label) => `"${label}"`).join(", ")}]`,
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
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    options.workflowBody ?? "Work on {{issue.title}}.\n"
  );
}

async function writeProjectWithoutProviders(
  root: string,
  options: { pollingIntervalMs: number }
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      `  interval_ms: ${options.pollingIntervalMs}`,
      "projects:",
      "  - name: symphonika",
      ""
    ].join("\n")
  );
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on {{issue.title}}.\n");
}

function preparedWorkspaceFixture(
  root: string,
  issueNumber: number,
  slug: string
): PreparedIssueWorkspace {
  const issueDirectoryName = `${issueNumber}-${slug}`;
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    issueDirectoryName
  );
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
    workspacePath
  };
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

async function waitForRunCount(url: string, count: number): Promise<void> {
  await waitFor(async () => {
    const status = await statusJson(url);
    const runs = status["runs"];
    return Array.isArray(runs) && runs.length === count;
  });
}
