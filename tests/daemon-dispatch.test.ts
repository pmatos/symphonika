import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-dispatch-test-"));
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

describe("daemon dispatch", () => {
  it("claims one eligible issue and persists a completed fake-provider run", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "8-dispatch-an-end-to-end-run-through-a-test-provider"
    );
    await mkdir(workspacePath, { recursive: true });
    await writeValidProject(root);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready", "priority:high"],
          number: 8,
          title: "Dispatch an end-to-end run through a test provider"
        })
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const providerInputs: ProviderRunInput[] = [];
    const codexProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        providerInputs.push(input);
        yield {
          normalized: {
            sessionId: "fake-session-8",
            type: "session_started"
          },
          raw: {
            id: "fake-session-8",
            kind: "session"
          }
        };
        yield {
          normalized: {
            message: "completed fake issue 8",
            type: "message"
          },
          raw: {
            kind: "assistant_message",
            text: "completed fake issue 8"
          }
        };
        yield {
          normalized: {
            exitCode: 0,
            type: "process_exit"
          },
          raw: {
            code: 0,
            kind: "exit"
          }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const preparedWorkspace: PreparedIssueWorkspace = {
      branchName:
        "sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
      branchRef:
        "refs/heads/sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
      cachePath: path.join(
        root,
        ".symphonika",
        "workspaces",
        "symphonika",
        ".cache",
        "repo.git"
      ),
      issueDirectoryName: "8-dispatch-an-end-to-end-run-through-a-test-provider",
      reused: false,
      workspacePath
    };
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        void input;
        return Promise.resolve(preparedWorkspace);
      }
    );

    const daemon = await startDaemon({
      agentProviders: {
        codex: codexProvider
      },
      createRunId: () => "run-issue-8",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      const status = await waitForRun(daemon.url, "succeeded");
      const run = firstRun(status);

      expect(githubIssuesApi.addLabelsToIssue.mock.calls).toEqual([
        [
          {
            issueNumber: 8,
            labels: ["sym:claimed"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ],
        [
          {
            issueNumber: 8,
            labels: ["sym:running"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ]
      ]);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith({
        issueNumber: 8,
        labels: ["sym:running"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
      const workspaceInput = firstPrepareIssueWorkspaceInput(prepareIssueWorkspace);
      expect(workspaceInput.configDir).toBe(root);
      expect(workspaceInput.issue).toEqual({
        number: 8,
        title: "Dispatch an end-to-end run through a test provider"
      });
      expect(workspaceInput.project.name).toBe("symphonika");
      expect(codexProvider.validate).toHaveBeenCalledWith(
        "codex --dangerously-bypass-approvals-and-sandbox app-server"
      );
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]).toMatchObject({
        issue: {
          number: 8
        },
        promptPath: run.promptPath,
        run: {
          attempt: 1,
          id: "run-issue-8"
        },
        workspacePath
      });

      expect(run).toMatchObject({
        branchName:
          "sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
        issueNumber: 8,
        normalizedLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-issue-8",
          "provider.normalized.jsonl"
        ),
        project: "symphonika",
        promptPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-issue-8",
          "prompt.md"
        ),
        provider: "codex",
        rawLogPath: path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-issue-8",
          "provider.raw.jsonl"
        ),
        state: "succeeded",
        workspacePath
      });

      expect(path.relative(workspacePath, run.promptPath)).toMatch(/^\.\./);
      await expect(readFile(run.promptPath, "utf8")).resolves.toContain(
        "Autonomous run instructions"
      );
      await expect(readFile(run.promptPath, "utf8")).resolves.toContain(
        "Dispatch an end-to-end run through a test provider"
      );
      expect(readJsonl(await readFile(run.rawLogPath, "utf8"))).toEqual([
        {
          id: "fake-session-8",
          kind: "session"
        },
        {
          kind: "assistant_message",
          text: "completed fake issue 8"
        },
        {
          code: 0,
          kind: "exit"
        }
      ]);
      expect(readJsonl(await readFile(run.normalizedLogPath, "utf8"))).toEqual([
        {
          sessionId: "fake-session-8",
          type: "session_started"
        },
        {
          message: "completed fake issue 8",
          type: "message"
        },
        {
          exitCode: 0,
          type: "process_exit"
        }
      ]);

      const databasePath = path.join(root, ".symphonika", "symphonika.db");
      const database = new Database(databasePath, { readonly: true });
      try {
        const storedRun = database.prepare("select * from runs").get();
        expect(storedRun).toMatchObject({
          branch_name:
            "sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
          id: "run-issue-8",
          issue_number: 8,
          normalized_log_path: run.normalizedLogPath,
          project_name: "symphonika",
          prompt_path: run.promptPath,
          provider_command:
            "codex --dangerously-bypass-approvals-and-sandbox app-server",
          provider_name: "codex",
          raw_log_path: run.rawLogPath,
          state: "succeeded",
          workspace_path: workspacePath
        });
        const transitions = database
          .prepare("select state from run_state_transitions order by sequence")
          .all()
          .map((row) => stringColumn(row, "state"));
        expect(transitions).toEqual([
          "queued",
          "preparing_workspace",
          "running",
          "succeeded"
        ]);
        const attempts = database.prepare("select * from attempts").all();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          attempt_number: 1,
          normalized_log_path: run.normalizedLogPath,
          prompt_path: run.promptPath,
          provider_name: "codex",
          raw_log_path: run.rawLogPath,
          run_id: "run-issue-8",
          state: "succeeded"
        });
        const eventTypes = database
          .prepare("select type from provider_events order by sequence")
          .all()
          .map((row) => stringColumn(row, "type"));
        expect(eventTypes).toEqual([
          "session_started",
          "message",
          "process_exit"
        ]);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("dispatches an issue that becomes eligible on a later poll interval", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "8-dispatch-an-end-to-end-run-through-a-test-provider"
    );
    await mkdir(workspacePath, { recursive: true });
    await writeValidProject(root, { pollingIntervalMs: 10 });

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          issueFixture({
            labels: ["agent-ready"],
            number: 8,
            title: "Dispatch an end-to-end run through a test provider"
          })
        ])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulCodexProvider();
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        void input;
        return Promise.resolve(preparedWorkspaceFixture(root));
      }
    );

    const daemon = await startDaemon({
      agentProviders: {
        codex: codexProvider
      },
      createRunId: () => "run-issue-8-polled",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      const status = await waitForRun(daemon.url, "succeeded");
      const run = firstRun(status);

      expect(githubIssuesApi.listOpenIssues.mock.calls.length).toBeGreaterThanOrEqual(
        2
      );
      expect(run).toMatchObject({
        id: "run-issue-8-polled",
        issueNumber: 8,
        state: "succeeded",
        workspacePath
      });
      expect(prepareIssueWorkspace).toHaveBeenCalledOnce();
      expect(codexProvider.runAttempt).toHaveBeenCalledOnce();
    } finally {
      await daemon.stop();
    }
  });

  it("marks a fake-provider process failure and preserves logs for inspection", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "8-dispatch-an-end-to-end-run-through-a-test-provider"
    );
    await mkdir(workspacePath, { recursive: true });
    await writeValidProject(root);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready"],
          number: 8,
          title: "Dispatch an end-to-end run through a test provider"
        })
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: {
            exitCode: 1,
            type: "process_exit"
          },
          raw: {
            code: 1,
            kind: "exit"
          }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const preparedWorkspace: PreparedIssueWorkspace = {
      branchName:
        "sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
      branchRef:
        "refs/heads/sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
      cachePath: path.join(
        root,
        ".symphonika",
        "workspaces",
        "symphonika",
        ".cache",
        "repo.git"
      ),
      issueDirectoryName: "8-dispatch-an-end-to-end-run-through-a-test-provider",
      reused: false,
      workspacePath
    };
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        void input;
        return Promise.resolve(preparedWorkspace);
      }
    );

    const daemon = await startDaemon({
      agentProviders: {
        codex: codexProvider
      },
      createRunId: () => "run-issue-8-failed",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      const status = await waitForRun(daemon.url, "failed");
      const run = firstRun(status);

      expect(githubIssuesApi.addLabelsToIssue.mock.calls).toEqual([
        [
          {
            issueNumber: 8,
            labels: ["sym:claimed"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ],
        [
          {
            issueNumber: 8,
            labels: ["sym:running"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ],
        [
          {
            issueNumber: 8,
            labels: ["sym:failed"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ]
      ]);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith({
        issueNumber: 8,
        labels: ["sym:running"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
      expect(run).toMatchObject({
        id: "run-issue-8-failed",
        issueNumber: 8,
        state: "failed"
      });
      expect(readJsonl(await readFile(run.rawLogPath, "utf8"))).toEqual([
        {
          code: 1,
          kind: "exit"
        }
      ]);
      expect(readJsonl(await readFile(run.normalizedLogPath, "utf8"))).toEqual([
        {
          exitCode: 1,
          type: "process_exit"
        }
      ]);

      const database = new Database(path.join(root, ".symphonika", "symphonika.db"), {
        readonly: true
      });
      try {
        const transitions = database
          .prepare("select state from run_state_transitions order by sequence")
          .all()
          .map((row) => stringColumn(row, "state"));
        expect(transitions).toEqual([
          "queued",
          "preparing_workspace",
          "running",
          "failed"
        ]);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("does not persist a queued run when the initial claim label write fails", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockRejectedValue(new Error("claim rejected")),
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready"],
          number: 8,
          title: "Dispatch an end-to-end run through a test provider"
        })
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulCodexProvider();
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        void input;
        return Promise.resolve(preparedWorkspaceFixture(root));
      }
    );

    const daemon = await startDaemon({
      agentProviders: {
        codex: codexProvider
      },
      createRunId: () => "run-issue-8-claim-rejected",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      await waitForStatusError(daemon.url, "claim rejected");
      expect(prepareIssueWorkspace).not.toHaveBeenCalled();
      expect(codexProvider.validate).not.toHaveBeenCalled();

      const database = new Database(path.join(root, ".symphonika", "symphonika.db"), {
        readonly: true
      });
      try {
        expect(countRows(database, "runs")).toBe(0);
        expect(countRows(database, "attempts")).toBe(0);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("marks the attempt failed when provider execution throws after launch", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "8-dispatch-an-end-to-end-run-through-a-test-provider"
    );
    await mkdir(workspacePath, { recursive: true });
    await writeValidProject(root);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi.fn().mockResolvedValue([
        issueFixture({
          labels: ["agent-ready"],
          number: 8,
          title: "Dispatch an end-to-end run through a test provider"
        })
      ]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        yield await Promise.reject(new Error("provider crashed"));
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> => {
        void input;
        return Promise.resolve(preparedWorkspaceFixture(root));
      }
    );

    const daemon = await startDaemon({
      agentProviders: {
        codex: codexProvider
      },
      createRunId: () => "run-issue-8-provider-crashed",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      const status = await waitForRun(daemon.url, "failed");
      const run = firstRun(status);

      expect(githubIssuesApi.addLabelsToIssue.mock.calls).toEqual([
        [
          {
            issueNumber: 8,
            labels: ["sym:claimed"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ],
        [
          {
            issueNumber: 8,
            labels: ["sym:running"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ],
        [
          {
            issueNumber: 8,
            labels: ["sym:failed"],
            owner: "pmatos",
            repo: "symphonika",
            token: "secret-token"
          }
        ]
      ]);
      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith({
        issueNumber: 8,
        labels: ["sym:running"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
      expect(run).toMatchObject({
        id: "run-issue-8-provider-crashed",
        issueNumber: 8,
        state: "failed",
        workspacePath
      });

      const database = new Database(path.join(root, ".symphonika", "symphonika.db"), {
        readonly: true
      });
      try {
        const attempts = database.prepare("select * from attempts").all();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          run_id: "run-issue-8-provider-crashed",
          state: "failed"
        });
      } finally {
        database.close();
      }
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

function successfulCodexProvider(): AgentProvider {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    name: "codex",
    runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
      await Promise.resolve();
      yield {
        normalized: {
          exitCode: 0,
          type: "process_exit"
        },
        raw: {
          code: 0,
          kind: "exit"
        }
      };
    }),
    validate: vi.fn().mockResolvedValue(undefined)
  };
}

function preparedWorkspaceFixture(root: string): PreparedIssueWorkspace {
  const workspacePath = path.join(
    root,
    ".symphonika",
    "workspaces",
    "symphonika",
    "issues",
    "8-dispatch-an-end-to-end-run-through-a-test-provider"
  );

  return {
    branchName:
      "sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
    branchRef:
      "refs/heads/sym/symphonika/8-dispatch-an-end-to-end-run-through-a-test-provider",
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: "8-dispatch-an-end-to-end-run-through-a-test-provider",
    reused: false,
    workspacePath
  };
}

async function writeValidProject(
  root: string,
  options: { pollingIntervalMs?: number } = {}
): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      `  interval_ms: ${options.pollingIntervalMs ?? 30000}`,
      "providers:",
      "  codex:",
      '    command: "codex --dangerously-bypass-approvals-and-sandbox app-server"',
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
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    [
      "Work on #{{issue.number}}: {{issue.title}}.",
      "Use {{workspace.path}} on {{branch.name}}.",
      "Provider {{provider.name}} is running {{provider.command}}.",
      ""
    ].join("\n")
  );
}

type StatusRun = {
  branchName: string;
  id: string;
  issueNumber: number;
  normalizedLogPath: string;
  project: string;
  promptPath: string;
  provider: string;
  rawLogPath: string;
  state: string;
  workspacePath: string;
};

type PrepareIssueWorkspaceSpy = {
  mock: {
    calls: Array<[PrepareIssueWorkspaceInput]>;
  };
};

async function waitForRun(
  url: string,
  state: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ runs: StatusRun[] }> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as { runs?: StatusRun[] };

    if (body.runs?.some((run) => run.state === state)) {
      return {
        runs: body.runs
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`run did not reach ${state} before timeout`);
}

async function waitForStatusError(
  url: string,
  message: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as {
      issuePolling?: {
        errors?: string[];
      };
    };

    if (body.issuePolling?.errors?.some((error) => error.includes(message))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`status error did not include ${message} before timeout`);
}

function readJsonl(contents: string): unknown[] {
  return contents
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function firstRun(status: { runs: StatusRun[] }): StatusRun {
  const run = status.runs[0];
  if (run === undefined) {
    throw new Error("expected at least one status run");
  }

  return run;
}

function firstPrepareIssueWorkspaceInput(
  prepareIssueWorkspace: PrepareIssueWorkspaceSpy
): PrepareIssueWorkspaceInput {
  const call = prepareIssueWorkspace.mock.calls[0];
  if (call === undefined) {
    throw new Error("expected workspace preparation to be called");
  }

  return call[0];
}

function countRows(
  database: {
    prepare: (source: string) => {
      get: () => unknown;
    };
  },
  table: "attempts" | "runs"
): number {
  const row = database.prepare(`select count(*) as count from ${table}`).get();
  if (typeof row === "object" && row !== null && "count" in row) {
    const value = row.count;
    if (typeof value === "number") {
      return value;
    }
  }

  throw new Error(`expected row count for ${table}`);
}

function stringColumn(row: unknown, key: string): string {
  if (typeof row === "object" && row !== null && key in row) {
    const value = row[key as keyof typeof row];
    if (typeof value === "string") {
      return value;
    }
  }

  throw new Error(`expected string column ${key}`);
}
