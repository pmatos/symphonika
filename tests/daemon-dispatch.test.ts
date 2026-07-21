import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import { ActiveRunRegistry } from "../src/lifecycle/active-runs.js";
import {
  RunController,
  type RunControllerProjectConfig,
  type WorkflowSnapshot
} from "../src/lifecycle/run-controller.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../src/provider.js";
import { RuntimeConfigReloader } from "../src/reload.js";
import { databasePath, openRunStore } from "../src/run-store.js";
import { loadExpandedWorkflow } from "../src/workflow.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";
import {
  createGitWorkspaceAhead,
  createGitWorkspaceAtBase
} from "./helpers/git-workspace.js";

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-dispatch-test-"));
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
      issueDirectoryName:
        "8-dispatch-an-end-to-end-run-through-a-test-provider",
      reused: false,
      workspacePath
    };
    await createGitWorkspaceAhead(preparedWorkspace);
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
      const expectedEvidenceDir = path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-issue-8"
      );
      const expectedNormalizedLogPath = path.join(
        expectedEvidenceDir,
        "provider.normalized.jsonl"
      );
      const expectedPromptPath = path.join(expectedEvidenceDir, "prompt.md");
      const expectedRawLogPath = path.join(
        expectedEvidenceDir,
        "provider.raw.jsonl"
      );
      const expectedWorkflowGraphPath = path.join(
        expectedEvidenceDir,
        "workflow-graph.json"
      );

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
      const workspaceInput = firstPrepareIssueWorkspaceInput(
        prepareIssueWorkspace
      );
      expect(workspaceInput.configDir).toBe(root);
      expect(workspaceInput.issue).toEqual({
        number: 8,
        title: "Dispatch an end-to-end run through a test provider"
      });
      expect(workspaceInput.project.name).toBe("symphonika");
      expect(codexProvider.validate).toHaveBeenCalledWith(
        DEFAULT_CODEX_COMMAND
      );
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]).toMatchObject({
        issue: {
          number: 8
        },
        promptPath: expectedPromptPath,
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
        project: "symphonika",
        provider: "codex",
        state: "succeeded",
        workspacePath
      });

      const graphContents = JSON.parse(
        await fetchRunArtifact(daemon.url, run.id, "workflow_graph")
      ) as Record<string, unknown>;
      expect(graphContents).toMatchObject({
        initial: "run_agent",
        name: "single_agent_workflow",
        source: { kind: "markdown" }
      });
      expect(path.relative(workspacePath, expectedWorkflowGraphPath)).toMatch(
        /^\.\./
      );

      const canonicalGraph = await loadExpandedWorkflow(
        path.join(root, "WORKFLOW.md")
      );
      expect(canonicalGraph.errors).toEqual([]);
      expect(graphContents).toEqual(canonicalGraph.workflow);

      const promptMetadataPath = path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-issue-8",
        "prompt-metadata.json"
      );
      const promptMetadata = JSON.parse(
        await readFile(promptMetadataPath, "utf8")
      ) as { workflow: { content_hash: string } };
      expect(graphContents.contentHash).toBe(
        promptMetadata.workflow.content_hash
      );

      expect(path.relative(workspacePath, expectedPromptPath)).toMatch(/^\.\./);
      const promptContents = await fetchRunArtifact(
        daemon.url,
        run.id,
        "prompt"
      );
      expect(promptContents).toContain("Autonomous run instructions");
      expect(promptContents).toContain(
        "Dispatch an end-to-end run through a test provider"
      );
      expect(
        readJsonl(await fetchRunArtifact(daemon.url, run.id, "provider_raw"))
      ).toEqual([
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
      expect(
        readJsonl(
          await fetchRunArtifact(daemon.url, run.id, "provider_normalized")
        )
      ).toEqual([
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
          normalized_log_path: expectedNormalizedLogPath,
          project_name: "symphonika",
          prompt_path: expectedPromptPath,
          provider_command: DEFAULT_CODEX_COMMAND,
          provider_name: "codex",
          raw_log_path: expectedRawLogPath,
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
          normalized_log_path: expectedNormalizedLogPath,
          prompt_path: expectedPromptPath,
          provider_name: "codex",
          raw_log_path: expectedRawLogPath,
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
    await writeValidProject(root, { pollingIntervalMs: 10 });
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

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
        return Promise.resolve(preparedWorkspace);
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

      expect(
        githubIssuesApi.listOpenIssues.mock.calls.length
      ).toBeGreaterThanOrEqual(2);
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
      issueDirectoryName:
        "8-dispatch-an-end-to-end-run-through-a-test-provider",
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
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
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
      expect(
        readJsonl(await fetchRunArtifact(daemon.url, run.id, "provider_raw"))
      ).toEqual([
        {
          code: 1,
          kind: "exit"
        }
      ]);
      expect(
        readJsonl(
          await fetchRunArtifact(daemon.url, run.id, "provider_normalized")
        )
      ).toEqual([
        {
          exitCode: 1,
          type: "process_exit"
        }
      ]);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        {
          readonly: true
        }
      );
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

  it("records provider input_required as a failed terminal run", async () => {
    const root = await makeTempRoot();
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
            type: "input_required"
          },
          raw: {
            kind: "input_required"
          }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const preparedWorkspace = preparedWorkspaceFixture(root);
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
      createRunId: () => "run-issue-8-input-required",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      const status = await waitForRun(daemon.url, "failed");
      const run = firstRun(status);
      expect(run).toMatchObject({
        id: "run-issue-8-input-required",
        issueNumber: 8,
        state: "failed"
      });

      expect(githubIssuesApi.removeLabelsFromIssue).toHaveBeenCalledWith({
        issueNumber: 8,
        labels: ["sym:running"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });
      expect(githubIssuesApi.addLabelsToIssue).toHaveBeenCalledWith({
        issueNumber: 8,
        labels: ["sym:failed"],
        owner: "pmatos",
        repo: "symphonika",
        token: "secret-token"
      });

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const storedRun = database
          .prepare(
            [
              "select state, terminal_reason, failure_classification",
              "from runs where id = ?"
            ].join(" ")
          )
          .get("run-issue-8-input-required");
        expect(storedRun).toMatchObject({
          failure_classification: "input_required",
          state: "failed",
          terminal_reason: "provider requested input"
        });
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

  it("backfills old input_required rows on daemon startup and leaves recent rows untouched", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "legacy-input-required",
      issue: issueSnapshotFixture({ number: 45, title: "Legacy input" }),
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    store.updateRunState("legacy-input-required", "input_required");
    store.createRun({
      id: "fresh-input-required",
      issue: issueSnapshotFixture({ number: 46, title: "Fresh input" }),
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    store.updateRunState("fresh-input-required", "input_required");
    store.close();

    const database = new Database(databasePath(stateRoot));
    try {
      database
        .prepare("update runs set updated_at = ? where id = ?")
        .run(
          new Date(Date.now() - 120_000).toISOString(),
          "legacy-input-required"
        );
      database
        .prepare("update runs set updated_at = ? where id = ?")
        .run(new Date().toISOString(), "fresh-input-required");
    } finally {
      database.close();
    }

    const daemon = await startDaemon({
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      legacyInputRequiredRecheckDelayMs: 0,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const after = new Database(databasePath(stateRoot), { readonly: true });
      try {
        const rows = after
          .prepare(
            "select id, state, terminal_reason, failure_classification from runs order by id"
          )
          .all();
        expect(rows).toEqual([
          {
            failure_classification: null,
            id: "fresh-input-required",
            state: "input_required",
            terminal_reason: null
          },
          {
            failure_classification: "input_required",
            id: "legacy-input-required",
            state: "failed",
            terminal_reason: "provider requested input (legacy)"
          }
        ]);
      } finally {
        after.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("rechecks input_required rows after the grace window so freshly-written legacy rows do not require a second restart", async () => {
    const root = await makeTempRoot();
    const stateRoot = path.join(root, ".symphonika");
    const store = openRunStore({ stateRoot });
    store.createRun({
      id: "fresh-input-required",
      issue: issueSnapshotFixture({ number: 47, title: "Fresh input recheck" }),
      projectName: "symphonika",
      providerCommand: "codex fake",
      providerName: "codex"
    });
    store.updateRunState("fresh-input-required", "input_required");
    store.close();

    // Age the row to 30s ago: inside the 60s grace window, so the
    // startup sweep skips it. Then start the daemon with a 300ms recheck
    // delay and, before that timer fires, age the row past the grace
    // window. The recheck must observe the new updated_at and reap it.
    const seeding = new Database(databasePath(stateRoot));
    try {
      seeding
        .prepare("update runs set updated_at = ? where id = ?")
        .run(
          new Date(Date.now() - 30_000).toISOString(),
          "fresh-input-required"
        );
    } finally {
      seeding.close();
    }

    const daemon = await startDaemon({
      configPath: path.join(root, "symphonika.yml"),
      cwd: root,
      legacyInputRequiredRecheckDelayMs: 300,
      logger: pino({ enabled: false }),
      port: 0
    });

    try {
      const initial = new Database(databasePath(stateRoot), { readonly: true });
      try {
        const stateAfterStartup = initial
          .prepare("select state from runs where id = ?")
          .get("fresh-input-required") as { state: string } | undefined;
        expect(stateAfterStartup?.state).toBe("input_required");
      } finally {
        initial.close();
      }

      const aging = new Database(databasePath(stateRoot));
      try {
        aging
          .prepare("update runs set updated_at = ? where id = ?")
          .run(
            new Date(Date.now() - 120_000).toISOString(),
            "fresh-input-required"
          );
      } finally {
        aging.close();
      }

      await vi.waitFor(
        () => {
          const after = new Database(databasePath(stateRoot), {
            readonly: true
          });
          try {
            const row = after
              .prepare(
                "select state, terminal_reason, failure_classification from runs where id = ?"
              )
              .get("fresh-input-required");
            expect(row).toEqual({
              failure_classification: "input_required",
              state: "failed",
              terminal_reason: "provider requested input (legacy)"
            });
          } finally {
            after.close();
          }
        },
        { interval: 25, timeout: 3_000 }
      );
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

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        {
          readonly: true
        }
      );
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
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
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

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        {
          readonly: true
        }
      );
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

  it("dispatches using the snapshot graph rather than re-expanding the workflow", async () => {
    const root = await makeTempRoot();
    await writeValidProject(root);
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const reloader = new RuntimeConfigReloader({
      configPath: path.join(root, "symphonika.yml")
    });
    await reloader.reload();
    const project = reloader.projectsByName().get("symphonika");
    if (project === undefined) {
      throw new Error("expected reloader to expose symphonika project");
    }
    const snapshot = project.workflow;
    if (!("expandedWorkflow" in snapshot)) {
      throw new Error("expected reloader to expose a workflow snapshot");
    }
    const sentinelTemplate = "sentinel-only-in-snapshot.txt";
    const mutatedSnapshot: WorkflowSnapshot = {
      ...snapshot,
      expandedWorkflow: {
        ...snapshot.expandedWorkflow,
        templateFiles: [
          ...snapshot.expandedWorkflow.templateFiles,
          sentinelTemplate
        ]
      }
    };
    const mutatedProject: RunControllerProjectConfig = {
      ...project,
      workflow: mutatedSnapshot
    };

    const codexProvider = successfulCodexProvider();
    const runStore = openRunStore({
      stateRoot: path.join(root, ".symphonika")
    });
    try {
      const controller = new RunController({
        activeRuns: new ActiveRunRegistry(),
        agentProviders: { codex: codexProvider },
        configDir: root,
        createRunId: () => "run-sentinel",
        env: { GITHUB_TOKEN: "secret-token" },
        githubIssuesApi: {
          addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
          listOpenIssues: vi.fn().mockResolvedValue([]),
          removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
        },
        lifecyclePolicy: {
          continuation: { cap: 0, delayMs: 0 },
          retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
        },
        logger: pino({ enabled: false }),
        prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace),
        projectsLoader: () =>
          Promise.resolve(new Map([[mutatedProject.name, mutatedProject]])),
        providersLoader: () => Promise.resolve(reloader.providersConfig()),
        runStore,
        schedule: () => undefined,
        stateRoot: path.join(root, ".symphonika")
      });

      const result = await controller.dispatchOneFresh({
        candidateIssues: [
          {
            issue: {
              body: "irrelevant",
              created_at: "2026-05-01T10:00:00Z",
              id: 5008,
              labels: ["agent-ready"],
              number: 8,
              priority: 99,
              state: "open",
              title: "Dispatch an end-to-end run through a test provider",
              updated_at: "2026-05-02T11:00:00Z",
              url: "https://github.com/pmatos/symphonika/issues/8"
            },
            project: mutatedProject.name
          }
        ],
        errors: [],
        filteredIssues: [],
        projects: []
      });
      expect(result).toEqual({ dispatched: true, runId: "run-sentinel" });

      const graphPath = path.join(
        root,
        ".symphonika",
        "logs",
        "runs",
        "run-sentinel",
        "workflow-graph.json"
      );
      const graph = JSON.parse(await readFile(graphPath, "utf8")) as {
        templateFiles: string[];
      };
      expect(graph.templateFiles).toContain(sentinelTemplate);
    } finally {
      runStore.close();
    }
  });

  it("walks a raw FSM workflow from the initial agent state to a terminal success state", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "8-dispatch-an-end-to-end-run-through-a-test-provider"
    );
    await writeRawFsmProject(root);

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
    const codexProvider = successfulCodexProvider();
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => "run-raw-fsm-success",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const status = await waitForRun(daemon.url, "succeeded");
      const run = firstRun(status);
      expect(run).toMatchObject({
        id: "run-raw-fsm-success",
        issueNumber: 8,
        state: "succeeded",
        workspacePath
      });

      // The rendered prompt should use the agent action's prompt file
      // (prompt.md) rather than the YAML workflow body. The template
      // substitutes {{issue.title}} so the resulting prompt contains the
      // issue title verbatim and does NOT contain the raw YAML keywords.
      const promptContents = await fetchRunArtifact(
        daemon.url,
        run.id,
        "prompt"
      );
      expect(promptContents).toContain(
        "Dispatch an end-to-end run through a test provider"
      );
      expect(promptContents).not.toContain("complete_when:");
      expect(promptContents).not.toContain("workflow:\n  name:");

      const graphContents = JSON.parse(
        await fetchRunArtifact(daemon.url, run.id, "workflow_graph")
      ) as Record<string, unknown>;
      expect(graphContents).toMatchObject({
        initial: "run_agent",
        name: "tracer_bullet",
        source: { kind: "raw_fsm" }
      });

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const storedRun = database
          .prepare(
            "select current_state_id, terminal_state_id, state_transition_reason from runs where id = ?"
          )
          .get("run-raw-fsm-success");
        expect(storedRun).toMatchObject({
          current_state_id: null,
          terminal_state_id: "done"
        });
        const reason = stringColumn(storedRun, "state_transition_reason");
        expect(reason).toContain("run_agent advanced to done");
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("walks a multi-state raw FSM workflow through sequential agent states on the same workspace", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "8-dispatch-an-end-to-end-run-through-a-test-provider"
    );
    await writeMultiStateRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // listOpenIssues only sees the issue on the first poll; subsequent polls
      // return nothing so polling cannot dispatch a parallel claim. State
      // advance uses getIssue to refresh.
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulCodexProvider();
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-fsm-multi-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      // cap=0 proves state advance bypasses the continuation cap: if the FSM
      // walk went through the continuation path it would be blocked.
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      // Wait until the implementing run reaches terminal_state_id=done.
      const deadline = Date.now() + 15_000;
      const databasePath = path.join(root, ".symphonika", "symphonika.db");
      while (Date.now() < deadline) {
        try {
          const database = new Database(databasePath, { readonly: true });
          try {
            const row = database
              .prepare(
                "select count(*) as c from runs where terminal_state_id = 'done'"
              )
              .get() as { c: number };
            if (row.c >= 1) {
              break;
            }
          } finally {
            database.close();
          }
        } catch {
          // database may not be readable yet during startup
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare(
            [
              "select id, state, is_continuation, current_state_id,",
              "terminal_state_id, state_transition_reason, branch_name,",
              "workspace_path, continuation_parent_run_id",
              "from runs order by created_at"
            ].join(" ")
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(2);

        const planningRun = rows[0]!;
        const implementingRun = rows[1]!;

        // Planning ran as the fresh dispatch, advanced to implementing, and
        // recorded the advance in its row.
        expect(planningRun).toMatchObject({
          id: "run-fsm-multi-1",
          state: "succeeded",
          is_continuation: 0,
          current_state_id: "implementing",
          terminal_state_id: null
        });
        expect(stringColumn(planningRun, "state_transition_reason")).toContain(
          "planning advanced to implementing"
        );

        // Implementing ran as a state-advance continuation, inherited the
        // parent's current_state_id, and advanced into the terminal.
        expect(implementingRun).toMatchObject({
          id: "run-fsm-multi-2",
          state: "succeeded",
          is_continuation: 1,
          current_state_id: null,
          terminal_state_id: "done",
          continuation_parent_run_id: "run-fsm-multi-1"
        });
        expect(
          stringColumn(implementingRun, "state_transition_reason")
        ).toContain("implementing advanced to done");

        // Both runs share the same workspace and branch — they are two states
        // of one workflow walk, not two parallel issue claims.
        expect(planningRun["workspace_path"]).toBe(workspacePath);
        expect(implementingRun["workspace_path"]).toBe(workspacePath);
        expect(planningRun["branch_name"]).toBe(implementingRun["branch_name"]);
      } finally {
        database.close();
      }

      // The rendered prompts should reflect each state's prompt file (and not
      // the YAML workflow body or each other).
      const planningPrompt = await readFile(
        path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-fsm-multi-1",
          "prompt.md"
        ),
        "utf8"
      );
      expect(planningPrompt).toContain("Draft a plan");
      expect(planningPrompt).not.toContain("Implement the plan");

      const implementingPrompt = await readFile(
        path.join(
          root,
          ".symphonika",
          "logs",
          "runs",
          "run-fsm-multi-2",
          "prompt.md"
        ),
        "utf8"
      );
      expect(implementingPrompt).toContain("Implement the plan");
      expect(implementingPrompt).not.toContain("Draft a plan");
    } finally {
      await daemon.stop();
    }
  });

  // Regression: a planning agent that exits 0 without committing yields a
  // deterministic `no_workspace_changes` per-state outcome, but the FSM
  // transition `to: implementing when: provider_success: true` still matches.
  // scheduleNext used to bail on failed-deterministic outcomes before the
  // state-advance branch was reached, leaving the planning stage as the last
  // run and never spawning the implementer. Verify the FSM advance fires.
  it("schedules state advance after a planning step with no commits", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      "8-dispatch-an-end-to-end-run-through-a-test-provider"
    );
    await writeTransitionOnlyMultiStateRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulCodexProvider();
    const preparedWorkspace = preparedWorkspaceFixture(root);
    // Base commit only — provider exits 0 without committing, so
    // branch_ahead_of_base = false and classifyFailure returns
    // {kind: failed, classification: deterministic, reason: no_workspace_changes}.
    await createGitWorkspaceAtBase(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-fsm-advance-noop-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      // Wait until both the planning and implementing rows have finished and
      // had their workspace evidence written. Counting `state in ('blocked',
      // 'succeeded')` avoids a race where the implementing continuation row
      // exists (insert is synchronous) but startAttempt has not yet populated
      // `workspace_path`; the implementer also classifies as blocked (its own
      // per-state result is no_workspace_changes, and its FSM fallback lands
      // on a `terminal: blocked` node) because the test provider exits clean
      // without committing.
      const deadline = Date.now() + 15_000;
      const databaseFile = path.join(root, ".symphonika", "symphonika.db");
      while (Date.now() < deadline) {
        try {
          const database = new Database(databaseFile, { readonly: true });
          try {
            const row = database
              .prepare(
                "select count(*) as c from runs where state in ('blocked','succeeded')"
              )
              .get() as { c: number };
            if (row.c >= 2) {
              break;
            }
          } finally {
            database.close();
          }
        } catch {
          // database may not be readable yet during startup
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const database = new Database(databaseFile, { readonly: true });
      try {
        const rows = database
          .prepare(
            [
              "select id, state, is_continuation, current_state_id,",
              "terminal_state_id, state_transition_reason, terminal_reason,",
              "workspace_path, continuation_parent_run_id",
              "from runs order by created_at"
            ].join(" ")
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(2);

        const planningRun = rows[0]!;
        const implementingRun = rows[1]!;

        // The planning row classifies as blocked (no commits → no_workspace_changes,
        // a non-actionable decline rather than a real failure — see ADR 0058)
        // but the workflow predicate engine still advanced the FSM. Both pieces
        // of state must be present on the row.
        expect(planningRun).toMatchObject({
          id: "run-fsm-advance-noop-1",
          state: "blocked",
          is_continuation: 0,
          current_state_id: "implementing",
          terminal_state_id: null,
          terminal_reason: "no_workspace_changes"
        });
        expect(stringColumn(planningRun, "state_transition_reason")).toContain(
          "planning advanced to implementing"
        );

        // The implementing run was spawned by the state advance, sharing the
        // workspace with planning. It also exits clean without committing, and
        // its only fallback transition lands on a `terminal: blocked` FSM node,
        // so it too records as blocked (not failed).
        expect(implementingRun).toMatchObject({
          id: "run-fsm-advance-noop-2",
          is_continuation: 1,
          continuation_parent_run_id: "run-fsm-advance-noop-1",
          state: "blocked",
          terminal_reason: "workflow_terminal_blocked"
        });
        expect(planningRun["workspace_path"]).toBe(workspacePath);
        expect(implementingRun["workspace_path"]).toBe(workspacePath);
      } finally {
        database.close();
      }

      // Label hygiene: the planning step's per-state outcome classifies as
      // blocked (no_workspace_changes), but its workflow outcome advanced to
      // `implementing`. applyTerminalLabels must NOT add `sym:blocked` on
      // that transition — otherwise the issue stays externally marked
      // blocked even though a later state may succeed (subsequent
      // applyTerminalLabels calls only remove `sym:running`). The
      // implementing step does legitimately terminate here (provider exits
      // clean without committing → no_workspace_changes → no transition
      // matches except the fallback `to: failed` node, which is
      // `terminal: blocked`), so we expect exactly one `sym:blocked` label
      // add (from implementing's terminal), not two, and zero `sym:failed`
      // adds — nothing here indicates a real failure.
      const failedLabelAdds =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter(
          (call: unknown[]) => {
            const args = call[0] as { labels?: string[] } | undefined;
            return args?.labels?.includes("sym:failed") === true;
          }
        );
      expect(failedLabelAdds).toHaveLength(0);
      const blockedLabelAdds =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter(
          (call: unknown[]) => {
            const args = call[0] as { labels?: string[] } | undefined;
            return args?.labels?.includes("sym:blocked") === true;
          }
        );
      expect(blockedLabelAdds).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  // Regression: when the FSM intends to advance after a blocked-deterministic
  // outcome (no_workspace_changes), `applyTerminalLabels` suppresses
  // `sym:blocked` on the assumption that `executeStateAdvance` will run. But
  // `scheduleNext`'s `stateAdvance` branch calls `refreshIssue` first, and
  // that can bail on a transient GitHub API failure. Without restoration the
  // run is persisted as blocked and the issue has had `sym:running` removed
  // but never gets `sym:blocked` — stuck wearing only `sym:claimed`. Verify
  // the rollback puts `sym:blocked` back on `refreshIssue` failures.
  it("restores sym:blocked when a state-advance refresh aborts after fsmContinuing suppression", async () => {
    const root = await makeTempRoot();
    await writeTransitionOnlyMultiStateRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // Throw on every getIssue so refreshIssue returns undefined, which
      // takes scheduleNext's stateAdvance bail-out path.
      getIssue: vi.fn().mockRejectedValue(new Error("transient API hiccup")),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulCodexProvider();
    const preparedWorkspace = preparedWorkspaceFixture(root);
    // Base commit only — planning exits clean without committing →
    // outcome.kind = failed, classification = deterministic, reason =
    // no_workspace_changes (which isBlockedOutcome maps to RunState
    // "blocked"). FSM matches `to: implementing when: provider_success:
    // true`, so stateAdvance fires, but getIssue (via refreshIssue) throws →
    // scheduleNext bails.
    await createGitWorkspaceAtBase(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-fsm-advance-abort-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      // Wait until the planning row terminates. Only one row will ever exist
      // because the stateAdvance bail prevents a continuation row from being
      // created.
      const deadline = Date.now() + 15_000;
      const databaseFile = path.join(root, ".symphonika", "symphonika.db");
      while (Date.now() < deadline) {
        try {
          const database = new Database(databaseFile, { readonly: true });
          try {
            const row = database
              .prepare("select count(*) as c from runs where state = 'blocked'")
              .get() as { c: number };
            if (row.c >= 1) {
              break;
            }
          } finally {
            database.close();
          }
        } catch {
          // database may not be readable yet during startup
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Give scheduleNext's bail-out path time to call markIssueBlocked
      // before reading the mock call list.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const database = new Database(databaseFile, { readonly: true });
      try {
        const rows = database
          .prepare(
            "select id, state, is_continuation, current_state_id from runs order by created_at"
          )
          .all() as Array<Record<string, unknown>>;
        // Only the planning row exists — the stateAdvance bail prevented
        // any implementing row from being created.
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          state: "blocked",
          is_continuation: 0,
          current_state_id: "implementing"
        });
      } finally {
        database.close();
      }

      // The rollback restored `sym:blocked` so the issue is not orphaned.
      const blockedLabelAdds =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter(
          (call: unknown[]) => {
            const args = call[0] as { labels?: string[] } | undefined;
            return args?.labels?.includes("sym:blocked") === true;
          }
        );
      expect(blockedLabelAdds).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it("retries a transient failure before taking a non-terminal failure transition", async () => {
    const root = await makeTempRoot();
    await writeTransientFailureFallbackRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const renderedPrompts: string[] = [];
    let providerAttempts = 0;
    const codexProvider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        providerAttempts += 1;
        renderedPrompts.push(await readFile(input.promptPath, "utf8"));
        yield {
          normalized: {
            exitCode: providerAttempts === 1 ? 1 : 0,
            type: "process_exit"
          },
          raw: {
            code: providerAttempts === 1 ? 1 : 0,
            kind: "exit"
          }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-fsm-transient-retry-first-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 1, delaysMs: [5], maxBackoffMs: 10 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForSettledAttemptCount(root, 2);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare(
            [
              "select id, state, is_continuation, current_state_id,",
              "terminal_state_id, retry_count from runs order by created_at"
            ].join(" ")
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: "run-fsm-transient-retry-first-1",
          state: "succeeded",
          is_continuation: 0,
          current_state_id: null,
          terminal_state_id: "done",
          retry_count: 1
        });

        const attempts = database
          .prepare(
            "select run_id, attempt_number from attempts order by created_at"
          )
          .all() as Array<Record<string, unknown>>;
        expect(attempts).toMatchObject([
          { run_id: "run-fsm-transient-retry-first-1", attempt_number: 1 },
          { run_id: "run-fsm-transient-retry-first-1", attempt_number: 2 }
        ]);
      } finally {
        database.close();
      }

      expect(renderedPrompts).toHaveLength(2);
      expect(renderedPrompts[0]).toContain("Draft a plan");
      expect(renderedPrompts[1]).toContain("Draft a plan");
      expect(renderedPrompts[0]).not.toContain("Recover");
      expect(renderedPrompts[1]).not.toContain("Recover");
    } finally {
      await daemon.stop();
    }
  });

  // Regression: when a transient per-state failure has retry budget
  // (`willRetry === true`), `applyTerminalLabels` does NOT add `sym:failed`
  // — the retry path is supposed to handle the run. Even if the failure's
  // signals match a non-terminal fallback transition, that advance is deferred
  // until the retry budget is spent, so the issue must not be marked failed
  // while the retry is still pending.
  it("does not add sym:failed while a retryable transient fallback waits for retry", async () => {
    const root = await makeTempRoot();
    // Reuse the input_required-fallback workflow: planning's only fallback
    // is `to: error_handler` (no `when:`), so a transient failure with
    // `provider_success: false` signals matches it and sets
    // `workflowOutcome.advancedToState = "error_handler"`.
    await writeInputRequiredFallbackRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    let attempts = 0;
    const transientFailingProvider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        attempts += 1;
        yield {
          normalized: { exitCode: 1, type: "process_exit" },
          raw: { code: 1, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      // Throw on every getIssue so refreshIssue returns undefined and the
      // stateAdvance branch always bails.
      getIssue: vi.fn().mockRejectedValue(new Error("transient API hiccup")),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAtBase(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: transientFailingProvider },
      createRunId: () => `run-fsm-advance-willretry-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        // cap: 1 means the first attempt has willRetry=true; after the
        // retry runs and also fails, willRetry becomes false.
        retry: { cap: 1, delaysMs: [10], maxBackoffMs: 50 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      // Wait until the planning attempt has finished.
      const deadline = Date.now() + 15_000;
      const databaseFile = path.join(root, ".symphonika", "symphonika.db");
      while (Date.now() < deadline) {
        try {
          const database = new Database(databaseFile, { readonly: true });
          try {
            const row = database
              .prepare("select count(*) as c from runs where state = 'failed'")
              .get() as { c: number };
            if (row.c >= 1) {
              break;
            }
          } finally {
            database.close();
          }
        } catch {
          // database may not be readable yet during startup
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Give the deferred-advance path and retry scheduling time to settle.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The attempt ran exactly once because executeRetry's refreshIssue
      // also throws (same mock), so the retry was scheduled but dropped.
      // The lack of `sym:failed` verifies that the non-terminal fallback did
      // not convert the retryable transient into a visible issue failure.
      expect(attempts).toBeGreaterThanOrEqual(1);
      const failedLabelAdds =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter(
          (call: unknown[]) => {
            const args = call[0] as { labels?: string[] } | undefined;
            return args?.labels?.includes("sym:failed") === true;
          }
        );
      expect(failedLabelAdds).toHaveLength(0);
    } finally {
      await daemon.stop();
    }
  });

  // Regression: when an agent emits `input_required` from a state whose
  // fallback transition advances to another non-terminal state, the FSM's
  // `advancedToState` is non-null and `fsmContinuing` would be true. But
  // `scheduleNext` returns immediately for `input_required` at the very top,
  // so no continuation actually runs. Suppressing `sym:failed` in that
  // window would orphan the issue (no `sym:running`, no `sym:failed`, no
  // continuation). Verify input_required always marks the issue failed,
  // regardless of `fsmContinuing`.
  it("marks the issue failed on input_required even when the workflow has a non-terminal fallback", async () => {
    const root = await makeTempRoot();
    await writeInputRequiredFallbackRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        yield {
          normalized: { message: "needs input", type: "input_required" },
          raw: { kind: "input_request" }
        };
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAtBase(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-fsm-input-required-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      // Wait until the planning row reaches its terminal state. Note
      // `mapOutcomeToRunState` collapses `input_required` outcomes to
      // `state = 'failed'` in the runs table; the `input_required` shape
      // survives in `terminal_reason` instead.
      const deadline = Date.now() + 15_000;
      const databaseFile = path.join(root, ".symphonika", "symphonika.db");
      while (Date.now() < deadline) {
        try {
          const database = new Database(databaseFile, { readonly: true });
          try {
            const row = database
              .prepare("select count(*) as c from runs where state = 'failed'")
              .get() as { c: number };
            if (row.c >= 1) {
              break;
            }
          } finally {
            database.close();
          }
        } catch {
          // database may not be readable yet during startup
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // No continuation should be created — `scheduleNext` returns
      // immediately for input_required at the top of the method.
      const database = new Database(databaseFile, { readonly: true });
      try {
        const rows = database
          .prepare(
            "select id, state, is_continuation, terminal_reason from runs order by created_at"
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          state: "failed",
          is_continuation: 0
        });
        expect(stringColumn(rows[0]!, "terminal_reason")).toMatch(
          /input|requested input/i
        );
      } finally {
        database.close();
      }

      // `sym:failed` must have been added even though `applyWorkflowOutcome`
      // advanced the FSM to a non-terminal fallback (so `fsmContinuing` was
      // true). Without the narrowed suppression the issue would be orphaned
      // with no `sym:running`, no `sym:failed`, and no continuation.
      const failedLabelAdds =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter(
          (call: unknown[]) => {
            const args = call[0] as { labels?: string[] } | undefined;
            return args?.labels?.includes("sym:failed") === true;
          }
        );
      expect(failedLabelAdds).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it("routes a state advance through the provider declared on the next agent state", async () => {
    const root = await makeTempRoot();
    await writePerStateProviderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const codexProvider = successfulProvider("codex", codexInputs);
    const claudeProvider = successfulProvider("claude", claudeInputs);
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { claude: claudeProvider, codex: codexProvider },
      createRunId: () => `run-fsm-provider-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForTerminalState(root, "done");

      expect(codexInputs).toHaveLength(1);
      expect(claudeInputs).toHaveLength(1);
      expect(codexInputs[0]?.provider).toMatchObject({
        name: "codex",
        command: DEFAULT_CODEX_COMMAND
      });
      expect(claudeInputs[0]?.provider).toMatchObject({
        name: "claude",
        command:
          "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"
      });

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare("select id, provider_name from runs order by created_at")
          .all() as Array<Record<string, unknown>>;
        expect(rows).toMatchObject([
          { id: "run-fsm-provider-1", provider_name: "codex" },
          { id: "run-fsm-provider-2", provider_name: "claude" }
        ]);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("recomputes the target state provider when a delayed state advance fires", async () => {
    const root = await makeTempRoot();
    await writePerStateProviderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const codexProvider = successfulProvider("codex", codexInputs);
    const claudeProvider = successfulProvider("claude", claudeInputs);
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { claude: claudeProvider, codex: codexProvider },
      createRunId: () => `run-fsm-reloaded-provider-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 250 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForStoredRunState(root, "succeeded");
      await writeProviderRoutingWorkflow(root, "codex");
      await waitForTerminalState(root, "done");

      expect(codexInputs).toHaveLength(2);
      expect(claudeInputs).toHaveLength(0);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare("select id, provider_name from runs order by created_at")
          .all() as Array<Record<string, unknown>>;
        expect(rows).toMatchObject([
          { id: "run-fsm-reloaded-provider-1", provider_name: "codex" },
          { id: "run-fsm-reloaded-provider-2", provider_name: "codex" }
        ]);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("records a reloaded terminal target without launching the next provider", async () => {
    const root = await makeTempRoot();
    await writePerStateProviderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 9,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const codexProvider = successfulProvider("codex", codexInputs);
    const claudeProvider = successfulProvider("claude", claudeInputs);
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { claude: claudeProvider, codex: codexProvider },
      createRunId: () => `run-fsm-terminal-target-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 250 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForStoredRunState(root, "succeeded");
      await writeWorkflowWithTerminalAutofix(root);
      await waitForTerminalState(root, "autofix");

      // planning ran once (codex); the reloaded autofix is terminal, so neither
      // provider was invoked for the state-advance attempt.
      expect(codexInputs).toHaveLength(1);
      expect(claudeInputs).toHaveLength(0);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare(
            "select id, state, terminal_state_id from runs order by created_at"
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toMatchObject([
          { id: "run-fsm-terminal-target-1", state: "succeeded" },
          {
            id: "run-fsm-terminal-target-2",
            state: "succeeded",
            terminal_state_id: "autofix"
          }
        ]);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("falls back to last-known-good workflow when a delayed advance reload is invalid", async () => {
    const root = await makeTempRoot();
    await writePerStateProviderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 10,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const codexProvider = successfulProvider("codex", codexInputs);
    const claudeProvider = successfulProvider("claude", claudeInputs);
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { claude: claudeProvider, codex: codexProvider },
      createRunId: () => `run-fsm-stale-reload-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 250 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForStoredRunState(root, "succeeded");
      // Simulate a mid-save / malformed edit during the continuation delay.
      // SPEC §5.2: the daemon must keep the last-known-good effective workflow
      // for future work and must not fail the mid-walk run.
      await writeFile(
        path.join(root, "workflow.yml"),
        "workflow:\n  initial:\n    -\n"
      );
      await waitForTerminalState(root, "done");

      // The state-advance must still complete the autofix state using the
      // last-known-good workflow (claude per writePerStateProviderRawFsmProject).
      expect(claudeInputs).toHaveLength(1);
      expect(codexInputs).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });

  it("falls back to the project provider when the next agent state omits provider", async () => {
    const root = await makeTempRoot();
    await writeFallbackProviderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const codexProvider = successfulProvider("codex", codexInputs);
    const claudeProvider = successfulProvider("claude", claudeInputs);
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { claude: claudeProvider, codex: codexProvider },
      createRunId: () => `run-fsm-fallback-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForTerminalState(root, "done");

      expect(codexInputs).toHaveLength(2);
      expect(claudeInputs).toHaveLength(0);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare("select id, provider_name from runs order by created_at")
          .all() as Array<Record<string, unknown>>;
        expect(rows).toMatchObject([
          { id: "run-fsm-fallback-1", provider_name: "codex" },
          { id: "run-fsm-fallback-2", provider_name: "codex" }
        ]);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("records a deterministic state-advance failure when the chosen provider is not registered", async () => {
    const root = await makeTempRoot();
    await writePerStateProviderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulProvider("codex");
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-fsm-missing-provider-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForStoredRunState(root, "failed");

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare(
            [
              "select id, state, provider_name, terminal_reason,",
              "failure_classification from runs order by created_at"
            ].join(" ")
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toMatchObject([
          {
            id: "run-fsm-missing-provider-1",
            provider_name: "codex",
            state: "succeeded"
          },
          {
            failure_classification: "deterministic",
            id: "run-fsm-missing-provider-2",
            provider_name: "claude",
            state: "failed",
            terminal_reason: "provider_not_registered: claude"
          }
        ]);
      } finally {
        database.close();
      }

      const failedLabelCalls =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter((call) => {
          const arg = call[0] as { labels?: string[] } | undefined;
          return arg?.labels?.includes("sym:failed") ?? false;
        });
      expect(failedLabelCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.stop();
    }
  });

  it("retries a transient failure on the state-selected provider, not the project default", async () => {
    const root = await makeTempRoot();
    await writePerStateProviderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const codexProvider = successfulProvider("codex", codexInputs);
    let claudeAttempts = 0;
    const claudeProvider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "claude",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        claudeInputs.push(input);
        claudeAttempts += 1;
        if (claudeAttempts === 1) {
          yield {
            normalized: { exitCode: 1, type: "process_exit" },
            raw: { code: 1, kind: "exit" }
          };
          return;
        }
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    };
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { claude: claudeProvider, codex: codexProvider },
      createRunId: () => `run-fsm-retry-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 1, delaysMs: [5], maxBackoffMs: 10 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForTerminalState(root, "done");

      // planning runs once on codex; autofix runs twice on claude
      // (transient failure, then retry succeeds — both on claude, not the
      // project default of codex).
      expect(codexInputs).toHaveLength(1);
      expect(claudeInputs).toHaveLength(2);
      expect(claudeInputs[0]?.provider).toMatchObject({
        command:
          "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json",
        name: "claude"
      });
      expect(claudeInputs[1]?.provider).toMatchObject({
        command:
          "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json",
        name: "claude"
      });

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const attemptRows = database
          .prepare(
            "select run_id, attempt_number, provider_name from attempts order by created_at"
          )
          .all() as Array<Record<string, unknown>>;
        // Attempts: 1 planning (codex), 2 autofix (claude x2 — both retries).
        expect(attemptRows).toMatchObject([
          { provider_name: "codex", run_id: "run-fsm-retry-1" },
          { provider_name: "claude", run_id: "run-fsm-retry-2" },
          { provider_name: "claude", run_id: "run-fsm-retry-2" }
        ]);
        const retriedRun = database
          .prepare("select retry_count from runs where id = ?")
          .get("run-fsm-retry-2") as { retry_count: number } | undefined;
        expect(retriedRun?.retry_count).toBe(1);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("honors action.provider on the initial raw-FSM state during fresh dispatch", async () => {
    const root = await makeTempRoot();
    await writeInitialStateClaudeRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexInputs: ProviderRunInput[] = [];
    const claudeInputs: ProviderRunInput[] = [];
    const codexProvider = successfulProvider("codex", codexInputs);
    const claudeProvider = successfulProvider("claude", claudeInputs);
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { claude: claudeProvider, codex: codexProvider },
      createRunId: () => `run-fsm-initial-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForTerminalState(root, "done");

      // Project default is codex, initial state declares provider: claude.
      // The first attempt MUST launch claude, not codex — the SPEC contract
      // applies to raw-FSM agent states broadly, including the initial one.
      expect(claudeInputs).toHaveLength(1);
      expect(codexInputs).toHaveLength(0);
      expect(claudeInputs[0]?.provider).toMatchObject({
        command:
          "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json",
        name: "claude"
      });

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const rows = database
          .prepare("select id, provider_name from runs order by created_at")
          .all() as Array<Record<string, unknown>>;
        expect(rows[0]).toMatchObject({
          id: "run-fsm-initial-1",
          provider_name: "claude"
        });
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("records a deterministic fresh-dispatch failure when the initial state's provider is not registered", async () => {
    const root = await makeTempRoot();
    await writeInitialStateClaudeRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulProvider("codex");
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => `run-fsm-initial-missing-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForStoredRunState(root, "failed");

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const row = database
          .prepare(
            [
              "select id, state, provider_name, terminal_reason,",
              "failure_classification, is_continuation from runs",
              "order by created_at"
            ].join(" ")
          )
          .get() as Record<string, unknown>;
        expect(row).toMatchObject({
          failure_classification: "deterministic",
          id: "run-fsm-initial-missing-1",
          is_continuation: 0,
          provider_name: "claude",
          state: "failed",
          terminal_reason: "provider_not_registered: claude"
        });
      } finally {
        database.close();
      }

      const failedLabelCalls =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter((call) => {
          const arg = call[0] as { labels?: string[] } | undefined;
          return arg?.labels?.includes("sym:failed") ?? false;
        });
      expect(failedLabelCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.stop();
    }
  });

  it("picks the first transition in YAML order when multiple transitions match the observed signals", async () => {
    const root = await makeTempRoot();
    await writeTransitionOrderRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulCodexProvider();
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => "run-fsm-order",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForRun(daemon.url, "succeeded");

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        // Both `first_match` (when: branch_ahead_of_base) and `unconditional`
        // (when: {}) match the success signals. The state machine must take
        // the YAML-first match.
        const storedRun = database
          .prepare(
            "select current_state_id, terminal_state_id, state_transition_reason from runs where id = ?"
          )
          .get("run-fsm-order");
        expect(storedRun).toMatchObject({
          current_state_id: null,
          terminal_state_id: "first_match"
        });
        const reason = stringColumn(storedRun, "state_transition_reason");
        expect(reason).toContain("advanced to first_match");
        expect(reason).not.toContain("advanced to unconditional");
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("records the workflow as blocked when an agent state succeeds but no transition's when predicates match", async () => {
    const root = await makeTempRoot();
    await writeNoMatchingTransitionRawFsmProject(root);

    const issue = issueFixture({
      labels: ["agent-ready"],
      number: 8,
      title: "Dispatch an end-to-end run through a test provider"
    });
    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(issue),
      listOpenIssues: vi
        .fn()
        .mockResolvedValueOnce([issue])
        .mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };
    const codexProvider = successfulCodexProvider();
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => "run-fsm-blocked",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 5 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      await waitForRun(daemon.url, "succeeded");
      // Wait beyond the continuation delay to confirm no state advance fires.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const status = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as { runs: Array<Record<string, unknown>> };
      // Exactly one run row: no state advance and no continuation dispatched
      // because the workflow blocked.
      expect(status.runs).toHaveLength(1);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const storedRun = database
          .prepare(
            [
              "select state, current_state_id, terminal_state_id,",
              "state_transition_reason from runs where id = ?"
            ].join(" ")
          )
          .get("run-fsm-blocked");
        expect(storedRun).toMatchObject({
          // Agent succeeded; only the workflow instance is blocked.
          state: "succeeded",
          // Preserved on block so a future retry resumes at the stuck state
          // instead of restarting the FSM at the initial state.
          current_state_id: "planning",
          terminal_state_id: "planning"
        });
        const reason = stringColumn(storedRun, "state_transition_reason");
        expect(reason).toContain("no transition matching");
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("records terminal_state_id at the stuck agent state when a raw FSM run fails", async () => {
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
    await writeRawFsmProject(root);

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
      name: "codex" as const,
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 1, type: "process_exit" },
          raw: { code: 1, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const preparedWorkspace = preparedWorkspaceFixture(root);

    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => "run-raw-fsm-failed",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const status = await waitForRun(daemon.url, "failed");
      const run = firstRun(status);
      expect(run).toMatchObject({
        id: "run-raw-fsm-failed",
        state: "failed"
      });

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const storedRun = database
          .prepare(
            "select current_state_id, terminal_state_id, state_transition_reason from runs where id = ?"
          )
          .get("run-raw-fsm-failed");
        expect(storedRun).toMatchObject({
          // Preserved so a transient retry (if scheduled) resumes at the
          // stuck state instead of falling back to expandedWorkflow.initial.
          current_state_id: "run_agent",
          terminal_state_id: "run_agent"
        });
        const reason = stringColumn(storedRun, "state_transition_reason");
        expect(reason).toContain("run_agent");
        expect(reason).toContain("provider_success");
        expect(reason).toContain("not satisfied");
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
    }
  });

  it("walks a raw FSM workflow to a terminal failure node and records the run as failed", async () => {
    const root = await makeTempRoot();
    await writeFailureTerminalRawFsmProject(root);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi
        .fn()
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
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => "run-raw-fsm-terminal-failure",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const status = await waitForRun(daemon.url, "failed");
      // Wait beyond continuation delay to confirm no follow-up run is dispatched.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const run = firstRun(status);
      expect(run).toMatchObject({
        id: "run-raw-fsm-terminal-failure",
        issueNumber: 8,
        state: "failed"
      });

      const finalStatus = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as { runs: StatusRun[] };
      expect(finalStatus.runs).toHaveLength(1);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const storedRun = database
          .prepare(
            [
              "select state, current_state_id, terminal_state_id,",
              "terminal_reason, failure_classification from runs",
              "where id = ?"
            ].join(" ")
          )
          .get("run-raw-fsm-terminal-failure");
        expect(storedRun).toMatchObject({
          state: "failed",
          current_state_id: null,
          terminal_state_id: "done",
          terminal_reason: "workflow_terminal_failure",
          failure_classification: "deterministic"
        });
      } finally {
        database.close();
      }

      // The workflow drove the failure (not a transient provider crash) so
      // the issue must end up with sym:failed applied.
      const failedLabelCalls =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter((call) => {
          const arg = call[0] as { labels?: string[] } | undefined;
          return arg?.labels?.includes("sym:failed") ?? false;
        });
      expect(failedLabelCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.stop();
    }
  });

  // Distinct from the "no transition matching observed signals" test above,
  // which exercises decideNextStep returning `kind: "blocked"` without ever
  // entering a terminal node — that case still records state="succeeded"
  // because the workflow merely stalled. This test exercises the explicit
  // `terminal: blocked` node path, which is a workflow-author-declared failure.
  it("walks a raw FSM workflow to a terminal blocked node and records the run as blocked", async () => {
    const root = await makeTempRoot();
    await writeBlockedTerminalRawFsmProject(root);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi
        .fn()
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
    const preparedWorkspace = preparedWorkspaceFixture(root);
    await createGitWorkspaceAhead(preparedWorkspace);

    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => "run-raw-fsm-terminal-blocked",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const status = await waitForRun(daemon.url, "blocked");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const run = firstRun(status);
      expect(run).toMatchObject({
        id: "run-raw-fsm-terminal-blocked",
        issueNumber: 8,
        state: "blocked"
      });

      const finalStatus = (await fetch(`${daemon.url}/api/status`).then((r) =>
        r.json()
      )) as { runs: StatusRun[] };
      expect(finalStatus.runs).toHaveLength(1);

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const storedRun = database
          .prepare(
            [
              "select state, current_state_id, terminal_state_id,",
              "terminal_reason, failure_classification from runs",
              "where id = ?"
            ].join(" ")
          )
          .get("run-raw-fsm-terminal-blocked");
        expect(storedRun).toMatchObject({
          state: "blocked",
          current_state_id: null,
          terminal_state_id: "done",
          terminal_reason: "workflow_terminal_blocked",
          failure_classification: "deterministic"
        });
      } finally {
        database.close();
      }

      // A workflow-declared `terminal: blocked` node is a non-actionable
      // no-op verdict, not a real failure — it must add `sym:blocked`, not
      // `sym:failed`. See ADR 0058 / issue #271.
      const failedLabelCalls =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter((call) => {
          const arg = call[0] as { labels?: string[] } | undefined;
          return arg?.labels?.includes("sym:failed") ?? false;
        });
      expect(failedLabelCalls).toHaveLength(0);
      const blockedLabelCalls =
        githubIssuesApi.addLabelsToIssue.mock.calls.filter((call) => {
          const arg = call[0] as { labels?: string[] } | undefined;
          return arg?.labels?.includes("sym:blocked") ?? false;
        });
      expect(blockedLabelCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.stop();
    }
  });

  // Regression test for #272: a pre-attempt error (e.g. provider.validate()
  // rejecting before any attempt row is created) must not be routed through
  // the FSM as if the agent action had executed and legitimately fallen
  // through to a workflow-declared `terminal: blocked` node. Distinct from
  // the test above, where the agent genuinely runs and the workflow author's
  // FSM deliberately routes a successful run to a blocked terminal.
  it("does not reclassify a pre-attempt error as workflow_terminal_blocked", async () => {
    const root = await makeTempRoot();
    await writePreAttemptFallbackBlockedRawFsmProject(root);

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi
        .fn()
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
    const codexProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex" as const,
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi
        .fn()
        .mockRejectedValue(
          new Error("simulated pre-attempt contention: max_in_flight reached")
        )
    } satisfies AgentProvider;
    const preparedWorkspace = preparedWorkspaceFixture(root);

    const daemon = await startDaemon({
      agentProviders: { codex: codexProvider },
      createRunId: () => "run-pre-attempt-error",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      lifecyclePolicy: {
        continuation: { cap: 0, delayMs: 0 },
        retry: { cap: 0, delaysMs: [], maxBackoffMs: 0 }
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace: () => Promise.resolve(preparedWorkspace)
    });

    try {
      const status = await waitForRun(daemon.url, "failed");
      const run = firstRun(status);
      expect(run).toMatchObject({
        id: "run-pre-attempt-error",
        issueNumber: 8,
        state: "failed"
      });

      const database = new Database(
        path.join(root, ".symphonika", "symphonika.db"),
        { readonly: true }
      );
      try {
        const storedRun = database
          .prepare(
            [
              "select state, terminal_reason, failure_classification",
              "from runs where id = ?"
            ].join(" ")
          )
          .get("run-pre-attempt-error");
        expect(storedRun).toMatchObject({
          state: "failed",
          terminal_reason:
            "simulated pre-attempt contention: max_in_flight reached",
          failure_classification: "transient"
        });

        const attemptCount = database
          .prepare("select count(*) as c from attempts where run_id = ?")
          .get("run-pre-attempt-error") as { c: number };
        expect(attemptCount.c).toBe(0);
      } finally {
        database.close();
      }

      expect(codexProvider.runAttempt).not.toHaveBeenCalled();
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

function issueSnapshotFixture(overrides: { number: number; title: string }): {
  body: string;
  created_at: string;
  id: number;
  labels: string[];
  number: number;
  priority: number;
  state: "open";
  title: string;
  updated_at: string;
  url: string;
} {
  return {
    body: `${overrides.title} body.`,
    created_at: "2026-04-20T10:00:00Z",
    id: 6000 + overrides.number,
    labels: ["agent-ready"],
    number: overrides.number,
    priority: 99,
    state: "open",
    title: overrides.title,
    updated_at: "2026-04-21T11:00:00Z",
    url: `https://github.com/pmatos/symphonika/issues/${overrides.number}`
  };
}

function successfulCodexProvider(): AgentProvider {
  return successfulProvider("codex");
}

function successfulProvider(
  name: "codex" | "claude",
  inputs: ProviderRunInput[] = []
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

async function writeRawFsmProject(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      `    command: "${DEFAULT_CODEX_COMMAND}"`,
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
      "  name: tracer_bullet",
      "  initial: run_agent",
      "  states:",
      "    run_agent:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
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
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeFailureTerminalRawFsmProject(root: string): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: failure_terminal",
      "  initial: run_agent",
      "  states:",
      "    run_agent:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
      "      transitions:",
      "        - to: done",
      "    done:",
      "      terminal: failure",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeBlockedTerminalRawFsmProject(root: string): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: blocked_terminal",
      "  initial: run_agent",
      "  states:",
      "    run_agent:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
      "      transitions:",
      "        - to: done",
      "    done:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

// No `complete_when`, so decideNextStep never rejects on an unmet predicate,
// and an unconditional fallback transition into a `terminal: blocked` node.
// A run whose agent action never actually executed (a pre-attempt error, e.g.
// contention or a provider.validate() failure) must not be routed through
// this transition as if the agent had run and legitimately reached it.
async function writePreAttemptFallbackBlockedRawFsmProject(
  root: string
): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: pre_attempt_fallback_blocked",
      "  initial: run_agent",
      "  states:",
      "    run_agent:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      transitions:",
      "        - to: done",
      "    done:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeTransitionOrderRawFsmProject(root: string): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: ordered_transitions",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
      "      transitions:",
      "        - to: first_match",
      "          when:",
      "            branch_ahead_of_base: true",
      "        - to: unconditional",
      "    first_match:",
      "      terminal: success",
      "    unconditional:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeNoMatchingTransitionRawFsmProject(
  root: string
): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: requires_pr_open",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: prompt.md",
      "      complete_when:",
      "        provider_success: true",
      "        branch_ahead_of_base: true",
      "      transitions:",
      "        - to: review",
      "          when:",
      "            pr_open: true",
      "    review:",
      "      terminal: success",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "prompt.md"),
    "Work on #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeRawFsmProjectConfig(
  root: string,
  options: { agentProvider?: "codex" | "claude" } = {}
): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "providers:",
      "  codex:",
      `    command: "${DEFAULT_CODEX_COMMAND}"`,
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
      `      provider: ${options.agentProvider ?? "codex"}`,
      "    workflow: ./workflow.yml",
      ""
    ].join("\n")
  );
}

async function writeMultiStateRawFsmProject(root: string): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: plan_then_implement",
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
      "        - to: implementing",
      "    implementing:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: implement-prompt.md",
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
    "Draft a plan for #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "implement-prompt.md"),
    "Implement the plan for #{{issue.number}}: {{issue.title}}.\n"
  );
}

// Mirrors the shape of `builtin:plan-tdd-pr`: planning advances on
// `provider_success: true` alone (no `complete_when` gate, no
// `branch_ahead_of_base` requirement on the transition). Implementing still
// gates on `branch_ahead_of_base: true` so an uncommitted impl pass falls
// through to the fallback `to: failed` terminal.
async function writeTransitionOnlyMultiStateRawFsmProject(
  root: string
): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: plan_then_implement_transition_only",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      transitions:",
      "        - to: implementing",
      "          when:",
      "            provider_success: true",
      "        - to: failed",
      "    implementing:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: implement-prompt.md",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            provider_success: true",
      "            branch_ahead_of_base: true",
      "        - to: failed",
      "    done:",
      "      terminal: success",
      "    failed:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Draft a plan for #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "implement-prompt.md"),
    "Implement the plan for #{{issue.number}}: {{issue.title}}.\n"
  );
}

// Workflow with a non-terminal fallback transition: planning's only
// fallback is `to: error_handler` (an agent state), so signals from an
// `input_required` outcome (which carry `provider_success: false`) match
// the fallback and `applyWorkflowOutcome` sets `advancedToState =
// "error_handler"`. Used to exercise the orphan-label edge case where
// `fsmContinuing` would be true but `scheduleNext` bails on input_required.
async function writeInputRequiredFallbackRawFsmProject(
  root: string
): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: input_required_fallback",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      transitions:",
      "        - to: implementing",
      "          when:",
      "            provider_success: true",
      "            branch_ahead_of_base: true",
      "        - to: error_handler",
      "    implementing:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: implement-prompt.md",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            provider_success: true",
      "            branch_ahead_of_base: true",
      "        - to: failed",
      "    error_handler:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: error-prompt.md",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            provider_success: true",
      "        - to: failed",
      "    done:",
      "      terminal: success",
      "    failed:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Draft a plan for #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "implement-prompt.md"),
    "Implement the plan for #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "error-prompt.md"),
    "Recover #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeTransientFailureFallbackRawFsmProject(
  root: string
): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: transient_failure_fallback",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: plan-prompt.md",
      "      transitions:",
      "        - to: done",
      "          when:",
      "            provider_success: true",
      "        - to: error_handler",
      "          when:",
      "            provider_success: false",
      "    error_handler:",
      "      action:",
      "        kind: agent",
      "        provider: codex",
      "        prompt: error-prompt.md",
      "      transitions:",
      "        - to: recovered",
      "          when:",
      "            provider_success: true",
      "        - to: failed",
      "    done:",
      "      terminal: success",
      "    recovered:",
      "      terminal: success",
      "    failed:",
      "      terminal: blocked",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "plan-prompt.md"),
    "Draft a plan for #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "error-prompt.md"),
    "Recover #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writePerStateProviderRawFsmProject(root: string): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeProviderRoutingWorkflow(root, "claude");
}

async function writeProviderRoutingWorkflow(
  root: string,
  autofixProvider: "codex" | "claude"
): Promise<void> {
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: provider_routing",
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
      `        provider: ${autofixProvider}`,
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
    "Draft a plan for #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "autofix-prompt.md"),
    "Apply the autofix for #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeWorkflowWithTerminalAutofix(root: string): Promise<void> {
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: provider_routing",
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
      "      terminal: success",
      "    done:",
      "      terminal: success",
      ""
    ].join("\n")
  );
}

async function writeFallbackProviderRawFsmProject(root: string): Promise<void> {
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: provider_fallback",
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
      "        - to: implementation",
      "    implementation:",
      "      action:",
      "        kind: agent",
      "        prompt: implement-prompt.md",
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
    "Draft a plan for #{{issue.number}}: {{issue.title}}.\n"
  );
  await writeFile(
    path.join(root, "implement-prompt.md"),
    "Implement the plan for #{{issue.number}}: {{issue.title}}.\n"
  );
}

async function writeInitialStateClaudeRawFsmProject(
  root: string
): Promise<void> {
  // Project default is codex; the initial raw-FSM state declares claude so a
  // fresh dispatch must honor the per-state override on attempt 1.
  await writeRawFsmProjectConfig(root);
  await writeFile(
    path.join(root, "workflow.yml"),
    [
      "workflow:",
      "  name: initial_state_provider_routing",
      "  initial: planning",
      "  states:",
      "    planning:",
      "      action:",
      "        kind: agent",
      "        provider: claude",
      "        prompt: plan-prompt.md",
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
    "Draft a plan for #{{issue.number}}: {{issue.title}}.\n"
  );
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
      "---",
      "autonomy:",
      "  max_turns: 8",
      "---",
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
  project: string;
  provider: string;
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
  const timeoutMs = options.timeoutMs ?? 15_000;
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

async function waitForTerminalState(
  root: string,
  terminalStateId: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  const databaseFile = path.join(root, ".symphonika", "symphonika.db");

  while (Date.now() < deadline) {
    try {
      const database = new Database(databaseFile, { readonly: true });
      try {
        const row = database
          .prepare("select count(*) as c from runs where terminal_state_id = ?")
          .get(terminalStateId) as { c: number };
        if (row.c >= 1) {
          return;
        }
      } finally {
        database.close();
      }
    } catch {
      // The daemon may still be starting and creating its SQLite store.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`run did not reach terminal state ${terminalStateId}`);
}

async function waitForStoredRunState(
  root: string,
  state: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  const databaseFile = path.join(root, ".symphonika", "symphonika.db");

  while (Date.now() < deadline) {
    try {
      const database = new Database(databaseFile, { readonly: true });
      try {
        const row = database
          .prepare("select count(*) as c from runs where state = ?")
          .get(state) as { c: number };
        if (row.c >= 1) {
          return;
        }
      } finally {
        database.close();
      }
    } catch {
      // The daemon may still be starting and creating its SQLite store.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`run did not reach state ${state}`);
}

async function waitForSettledAttemptCount(
  root: string,
  expectedAttempts: number,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  const databaseFile = path.join(root, ".symphonika", "symphonika.db");

  while (Date.now() < deadline) {
    try {
      const database = new Database(databaseFile, { readonly: true });
      try {
        const row = database
          .prepare(
            [
              "select count(*) as attempts,",
              "sum(case when state = 'running' then 1 else 0 end) as running",
              "from attempts"
            ].join(" ")
          )
          .get() as { attempts: number; running: number | null };
        if (
          row.attempts >= expectedAttempts &&
          (row.running === null || row.running === 0)
        ) {
          return;
        }
      } finally {
        database.close();
      }
    } catch {
      // The daemon may still be starting and creating its SQLite store.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `expected ${expectedAttempts} settled attempts before timeout`
  );
}

async function waitForStatusError(
  url: string,
  message: string,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
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

async function fetchRunArtifact(
  daemonUrl: string,
  runId: string,
  kind: string
): Promise<string> {
  const response = await fetch(
    `${daemonUrl}/logs/runs/${encodeURIComponent(runId)}/${encodeURIComponent(kind)}`
  );
  if (!response.ok) {
    throw new Error(
      `expected artifact ${kind} for ${runId}: HTTP ${response.status}`
    );
  }
  return response.text();
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
