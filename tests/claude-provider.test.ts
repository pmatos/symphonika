import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeProvider } from "../src/providers/claude.js";
import type { ProviderEvent, ProviderRunInput } from "../src/provider.js";
import type {
  ProcessCommand,
  ProviderRunIdentity
} from "../src/lifecycle/process-scope.js";

type RecordingProcessScope = {
  stopCalls: ProviderRunIdentity[];
  wrapCalls: Array<{ command: ProcessCommand; run: ProviderRunIdentity }>;
  stopProviderScope: (run: ProviderRunIdentity) => Promise<boolean>;
  wrapForProviderScope: (
    run: ProviderRunIdentity,
    command: ProcessCommand
  ) => Promise<ProcessCommand>;
};

// The default processScope probes real systemd-run availability, which is
// true on a dev box with a live systemd --user session (XDG_RUNTIME_DIR
// set) — every existing test here injects this no-op bypass so spawned
// fake-subprocess commands are never actually wrapped in a real transient
// systemd scope, regardless of the host running the suite.
function noopProcessScope(): RecordingProcessScope {
  const wrapCalls: RecordingProcessScope["wrapCalls"] = [];
  const stopCalls: RecordingProcessScope["stopCalls"] = [];
  return {
    stopCalls,
    stopProviderScope: (run) => {
      stopCalls.push(run);
      return Promise.resolve(true);
    },
    wrapCalls,
    wrapForProviderScope: (run, command) => {
      wrapCalls.push({ command, run });
      return Promise.resolve(command);
    }
  };
}

const tempRoots: string[] = [];
const originalFakeClaudeTranscript =
  process.env.SYMPHONIKA_FAKE_CLAUDE_TRANSCRIPT;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-claude-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  if (originalFakeClaudeTranscript === undefined) {
    delete process.env.SYMPHONIKA_FAKE_CLAUDE_TRANSCRIPT;
  } else {
    process.env.SYMPHONIKA_FAKE_CLAUDE_TRANSCRIPT =
      originalFakeClaudeTranscript;
  }

  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Claude stream-json provider", () => {
  it("launches the configured command in the workspace and maps a completed turn", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
          name: "claude"
        },
        workspacePath
      })
    );

    const requests = readJsonl(await readFile(transcriptPath, "utf8"));
    expect(requests).toEqual([
      {
        message: {
          content: [
            {
              text: "Implement issue #10.",
              type: "text"
            }
          ],
          role: "user"
        },
        type: "user"
      }
    ]);
    expect(events.map((event) => event.raw)).toEqual([
      {
        cwd: workspacePath,
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        session_id: "session-10",
        subtype: "init",
        tools: ["Read", "Bash"],
        type: "system"
      },
      {
        message: {
          content: [
            {
              text: "done",
              type: "text"
            }
          ],
          id: "msg_10",
          role: "assistant",
          type: "message",
          usage: {
            input_tokens: 11,
            output_tokens: 7
          }
        },
        session_id: "session-10",
        type: "assistant"
      },
      {
        message: {
          content: [
            {
              text: "done",
              type: "text"
            }
          ],
          id: "msg_10",
          role: "assistant",
          type: "message",
          usage: {
            input_tokens: 11,
            output_tokens: 7
          }
        },
        session_id: "session-10",
        type: "assistant"
      },
      {
        duration_api_ms: 90,
        duration_ms: 123,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "session-10",
        subtype: "success",
        total_cost_usd: 0.01,
        type: "result"
      },
      {
        cancelled: false,
        exitCode: 0,
        kind: "process_exit",
        signal: null
      }
    ]);
    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents).toEqual([
      {
        cwd: workspacePath,
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        sessionId: "session-10",
        type: "session_started"
      },
      {
        message: "done",
        sessionId: "session-10",
        type: "message"
      },
      {
        sessionId: "session-10",
        tokenUsage: {
          input_tokens: 11,
          output_tokens: 7
        },
        type: "usage_updated"
      },
      {
        durationMs: 123,
        numTurns: 1,
        result: "done",
        sessionId: "session-10",
        totalCostUsd: 0.01,
        type: "turn_completed"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
  });

  it("wraps the spawned command via the injected process scope and stops the scope when the run completes normally", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const processScope = noopProcessScope();
    const provider = createClaudeProvider({ processScope });
    const command = `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`;

    await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: { command, name: "claude" },
        workspacePath
      })
    );

    expect(processScope.wrapCalls).toEqual([
      {
        command: {
          args: [
            fakeClaudePath,
            "-p",
            "--dangerously-skip-permissions",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json"
          ],
          executable: process.execPath
        },
        run: { attempt: 1, id: "run-issue-10" }
      }
    ]);
    // The regression this guards: ordinary successful completion takes the
    // `process_exit` early-return path, which bypasses terminateProcess
    // entirely — stopProviderScope must still fire from the unconditional
    // cleanup path, not only on cancellation.
    expect(processScope.stopCalls).toEqual([
      { attempt: 1, id: "run-issue-10" }
    ]);
  });

  it("maps AskUserQuestion tool use to input_required and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} --scenario=input-required -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
          name: "claude"
        },
        workspacePath
      })
    );

    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents.slice(0, 2)).toEqual([
      {
        cwd: workspacePath,
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        sessionId: "session-10",
        type: "session_started"
      },
      {
        input: {
          questions: [
            {
              header: "Choice",
              options: [
                {
                  description: "Use the default implementation",
                  label: "Default"
                }
              ],
              question: "Which approach?"
            }
          ]
        },
        sessionId: "session-10",
        toolCallId: "toolu_question",
        toolName: "AskUserQuestion",
        type: "input_required"
      }
    ]);
    expect(normalizedEvents[2]).toMatchObject({
      cancelled: false,
      type: "process_exit"
    });
  });

  it("maps malformed stream-json output to malformed_event and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} --scenario=malformed -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
          name: "claude"
        },
        workspacePath
      })
    );

    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents.slice(0, 2)).toMatchObject([
      {
        cwd: workspacePath,
        sessionId: "session-10",
        type: "session_started"
      },
      {
        line: "{bad json",
        type: "malformed_event"
      }
    ]);
    expect(String(objectField(normalizedEvents[1], "message"))).toContain(
      "JSON"
    );
    expect(normalizedEvents[2]).toMatchObject({
      cancelled: false,
      type: "process_exit"
    });
  });

  it("maps Claude error results to turn_failed", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} --scenario=error -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
          name: "claude"
        },
        workspacePath
      })
    );

    expect(events.map((event) => event.normalized).filter(Boolean)).toEqual([
      {
        cwd: workspacePath,
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        sessionId: "session-10",
        type: "session_started"
      },
      {
        durationMs: 50,
        message: "model exploded politely",
        numTurns: 1,
        sessionId: "session-10",
        subtype: "error_during_execution",
        type: "turn_failed"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
  });

  it("stops the stream-json process on cancellation", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const processScope = noopProcessScope();
    const provider = createClaudeProvider({ processScope });
    const iterable = provider.runAttempt({
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeClaudePath} --scenario=wait -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
        name: "claude"
      },
      workspacePath
    });
    const iterator = iterable[Symbol.asyncIterator]();

    const initialEvent = await nextProviderEvent(iterator);
    await provider.cancel("run-issue-10");
    const events = [initialEvent, ...(await collectIteratorEvents(iterator))];

    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents[0]).toEqual({
      cwd: workspacePath,
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      sessionId: "session-10",
      type: "session_started"
    });
    expect(normalizedEvents[1]).toMatchObject({
      cancelled: true,
      type: "process_exit"
    });
    expect(processScope.stopCalls).toEqual([
      { attempt: 1, id: "run-issue-10" }
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "terminates provider-spawned grandchildren on cancellation",
    async () => {
      const root = await makeTempRoot();
      const workspacePath = path.join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const grandchildPath = path.join(root, "grandchild.mjs");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      const fakeClaudePath = path.join(root, "fake-claude-process-tree.mjs");
      await writeFakeClaudeProcessTree(
        fakeClaudePath,
        grandchildPath,
        grandchildPidPath
      );
      const provider = createClaudeProvider({
        processScope: noopProcessScope()
      });
      const iterator = provider
        .runAttempt({
          ...providerInputFixture(),
          provider: {
            command: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
            name: "claude"
          },
          workspacePath
        })
        [Symbol.asyncIterator]();
      let grandchildPid: number | undefined;

      try {
        const initialEvent = await nextProviderEvent(iterator);
        grandchildPid = Number(await waitForFileContent(grandchildPidPath));

        await provider.cancel("run-issue-10");
        const events = [
          initialEvent,
          ...(await collectIteratorEvents(iterator))
        ];

        expect(events.at(-1)?.normalized).toMatchObject({
          cancelled: true,
          type: "process_exit"
        });
        await waitForProcessStopped(grandchildPid);
      } finally {
        if (
          grandchildPid !== undefined &&
          Number.isSafeInteger(grandchildPid)
        ) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // The provider already cleaned the process up.
          }
          await waitForProcessStopped(grandchildPid).catch(() => {
            // Best-effort cleanup after an assertion failure.
          });
        }
      }
    }
  );

  // Regression: wrapForProviderScope's await (up to probeTimeoutMs on an
  // uncached probe) sits between RunController's one-shot pre-start
  // cancellation recheck (ADR 0052) and the point where this provider used
  // to register a cancellable entry. A cancel arriving in that window must
  // not be silently swallowed -- it must stop the process from ever being
  // spawned.
  it("never spawns claude when cancelled while the scope probe is still pending", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);

    let resolveWrap: ((command: ProcessCommand) => void) | undefined;
    const wrapPending = new Promise<ProcessCommand>((resolve) => {
      resolveWrap = resolve;
    });
    const processScope = {
      stopCalls: [] as ProviderRunIdentity[],
      stopProviderScope: (run: ProviderRunIdentity) => {
        processScope.stopCalls.push(run);
        return Promise.resolve(true);
      },
      wrapForProviderScope: (
        _run: ProviderRunIdentity,
        command: ProcessCommand
      ) => {
        void command;
        return wrapPending;
      }
    };
    const provider = createClaudeProvider({ processScope });
    const iterable = provider.runAttempt({
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
        name: "claude"
      },
      workspacePath
    });
    const iterator = iterable[Symbol.asyncIterator]();
    const eventsPromise = collectIteratorEvents(iterator);

    // Regression: the placeholder registered before the wrapForProviderScope
    // await lives outside the try/finally that owns the only
    // activeRuns.delete call, so the early return taken on this cancellation
    // path used to skip cleanup entirely and leak the map entry for the
    // lifetime of the provider instance.
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    await provider.cancel("run-issue-10");
    resolveWrap?.({
      args: [fakeClaudePath],
      executable: process.execPath
    });
    const events = await eventsPromise;

    expect(events.map((event) => event.normalized)).toEqual([
      {
        cancelled: true,
        exitCode: null,
        signal: null,
        type: "process_exit"
      }
    ]);
    await expect(readFile(transcriptPath, "utf8")).rejects.toThrow();
    expect(deleteSpy).toHaveBeenCalledWith("run-issue-10");
    deleteSpy.mockRestore();
  });

  it("validates the configured full-permission stream-json command", async () => {
    const root = await makeTempRoot();
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`
      )
    ).resolves.toBeUndefined();
  });

  it("preserves backslashes inside quoted command executables", async () => {
    const root = await makeTempRoot();
    const fakeClaudeDir = path.join(root, "fake\\claude dir");
    await mkdir(fakeClaudeDir, { recursive: true });
    const fakeClaudePath = path.join(fakeClaudeDir, "fake\\claude");
    await writeFakeClaudeHelpExecutable(fakeClaudePath);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        `"${fakeClaudePath}" -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`
      )
    ).resolves.toBeUndefined();
  });

  it("preserves backslashes inside unquoted command executables", async () => {
    const root = await makeTempRoot();
    const fakeClaudeDir = path.join(root, "fake\\claude");
    await mkdir(fakeClaudeDir, { recursive: true });
    const fakeClaudePath = path.join(fakeClaudeDir, "claude\\bin");
    await writeFakeClaudeHelpExecutable(fakeClaudePath);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        `${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`
      )
    ).resolves.toBeUndefined();
  });

  it("preserves escaped quotes inside quoted command arguments", async () => {
    const root = await makeTempRoot();
    const fakeClaudePath = path.join(root, "fake-claude-argv.mjs");
    const settingsJson = '{"permissions":{"allow":["Read"]}}';
    await writeFakeClaudeArgvValidator(fakeClaudePath, settingsJson);
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        `${process.execPath} ${fakeClaudePath} --settings "${settingsJson.replaceAll('"', '\\"')}" -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`
      )
    ).resolves.toBeUndefined();
  });

  it("rejects Claude commands that do not speak stream-json", async () => {
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate("claude -p --dangerously-skip-permissions")
    ).rejects.toThrow("--input-format stream-json");
  });

  it("rejects Claude commands missing --verbose", async () => {
    const provider = createClaudeProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"
      )
    ).rejects.toThrow("--verbose");
  });

  it("appends --disallowedTools last when executionOptions.disallowedTools is set", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const processScope = noopProcessScope();
    const provider = createClaudeProvider({ processScope });

    await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        executionOptions: {
          disallowedTools: ["ScheduleWakeup", "Monitor", "CronCreate"]
        },
        provider: {
          command: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
          name: "claude"
        },
        workspacePath
      })
    );

    expect(processScope.wrapCalls).toHaveLength(1);
    const args = processScope.wrapCalls[0]?.command.args ?? [];
    expect(args.slice(-4)).toEqual([
      "--disallowedTools",
      "ScheduleWakeup",
      "Monitor",
      "CronCreate"
    ]);
  });

  it("does not append --disallowedTools when executionOptions is absent", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const processScope = noopProcessScope();
    const provider = createClaudeProvider({ processScope });

    await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
          name: "claude"
        },
        workspacePath
      })
    );

    const args = processScope.wrapCalls[0]?.command.args ?? [];
    expect(args).not.toContain("--disallowedTools");
  });

  it("sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 in the spawned env when executionOptions.disableBackgroundTasks is true", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeClaudePath = path.join(root, "fake-claude-env.mjs");
    await writeFakeClaudeEnvReporter(fakeClaudePath);
    const provider = createClaudeProvider({
      processScope: noopProcessScope()
    });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        executionOptions: { disableBackgroundTasks: true },
        provider: {
          command: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`,
          name: "claude"
        },
        workspacePath
      })
    );

    const initEvent = events.find(
      (event) =>
        typeof event.raw === "object" &&
        event.raw !== null &&
        "disableBackgroundTasksEnv" in event.raw
    );
    expect(
      (initEvent?.raw as { disableBackgroundTasksEnv: string | null })
        .disableBackgroundTasksEnv
    ).toBe("1");
  });
});

async function collectProviderEvents(
  iterable: AsyncIterable<ProviderEvent>
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function collectIteratorEvents(
  iterator: AsyncIterator<ProviderEvent>
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  while (true) {
    const result = await iterator.next();
    if (result.done === true) {
      return events;
    }

    events.push(result.value);
  }
}

async function nextProviderEvent(
  iterator: AsyncIterator<ProviderEvent>
): Promise<ProviderEvent> {
  const result = await iterator.next();
  if (result.done === true) {
    throw new Error("expected provider event");
  }

  return result.value;
}

function providerInputFixture(): ProviderRunInput {
  return {
    branchName: "sym/symphonika/10-add-claude-stream-json-provider-adapter",
    issue: {
      body: "Issue body",
      created_at: "2026-04-20T10:00:00Z",
      id: 5010,
      labels: ["agent-ready"],
      number: 10,
      priority: 99,
      state: "open",
      title: "Add Claude stream-json provider adapter",
      updated_at: "2026-04-21T11:00:00Z",
      url: "https://github.com/pmatos/symphonika/issues/10"
    },
    prompt: "Implement issue #10.",
    promptPath: "/tmp/prompt.md",
    provider: {
      command:
        "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json",
      name: "claude"
    },
    run: {
      attempt: 1,
      id: "run-issue-10"
    },
    workspacePath: "/tmp/workspace"
  };
}

async function writeFakeClaudeStreamJson(
  filePath: string,
  transcriptPath: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "import { appendFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      "",
      "const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='));",
      "const scenario = scenarioArg ? scenarioArg.slice('--scenario='.length) : 'success';",
      "",
      "if (process.argv.includes('--help')) {",
      "  process.stdout.write('Usage: fake-claude -p --input-format stream-json --output-format stream-json\\n');",
      "  process.exit(0);",
      "}",
      "",
      "const transcriptPath = process.env.SYMPHONIKA_FAKE_CLAUDE_TRANSCRIPT;",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) {",
      "  process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "}",
      "async function record(message) {",
      "  if (transcriptPath) {",
      "    await appendFile(transcriptPath, `${JSON.stringify(message)}\\n`, 'utf8');",
      "  }",
      "}",
      "",
      "for await (const line of rl) {",
      "  const message = JSON.parse(line);",
      "  await record(message);",
      "  send({ type: 'system', subtype: 'init', session_id: 'session-10', cwd: process.cwd(), tools: ['Read', 'Bash'], model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions' });",
      "  if (scenario === 'input-required') {",
      "    send({ type: 'assistant', session_id: 'session-10', message: { id: 'msg_question', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_question', name: 'AskUserQuestion', input: { questions: [{ header: 'Choice', question: 'Which approach?', options: [{ label: 'Default', description: 'Use the default implementation' }] }] } }] } });",
      "    await new Promise(() => {});",
      "  }",
      "  if (scenario === 'malformed') {",
      "    process.stdout.write('{bad json\\n');",
      "    await new Promise(() => {});",
      "  }",
      "  if (scenario === 'error') {",
      "    send({ type: 'result', subtype: 'error_during_execution', duration_ms: 50, duration_api_ms: 40, is_error: true, num_turns: 1, result: 'model exploded politely', session_id: 'session-10', total_cost_usd: 0.01 });",
      "    process.exit(0);",
      "  }",
      "  if (scenario === 'wait') {",
      "    await new Promise(() => {});",
      "  }",
      "  send({ type: 'assistant', session_id: 'session-10', message: { id: 'msg_10', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 11, output_tokens: 7 } } });",
      "  send({ type: 'result', subtype: 'success', duration_ms: 123, duration_api_ms: 90, is_error: false, num_turns: 1, result: 'done', session_id: 'session-10', total_cost_usd: 0.01 });",
      "  process.exit(0);",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  process.env.SYMPHONIKA_FAKE_CLAUDE_TRANSCRIPT = transcriptPath;
}

async function writeFakeClaudeProcessTree(
  filePath: string,
  grandchildPath: string,
  grandchildPidPath: string
): Promise<void> {
  await writeFile(
    grandchildPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "process.on('SIGTERM', () => {});",
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    filePath,
    [
      "import { spawn } from 'node:child_process';",
      "import readline from 'node:readline';",
      `spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: 'ignore' });`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "for await (const line of rl) {",
      "  JSON.parse(line);",
      "  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-10', cwd: process.cwd(), tools: ['Read', 'Bash'], model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions' })}\\n`);",
      "  await new Promise(() => {});",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function waitForFileContent(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      // The child process has not created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for file ${filePath}`);
}

async function waitForProcessStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await processIsRunning(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for process ${pid} to stop`);
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }

  if (process.platform !== "linux") {
    return true;
  }

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd < 0 || stat.slice(commandEnd + 2, commandEnd + 3) !== "Z";
  } catch (error) {
    return !hasErrorCode(error, "ENOENT");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function writeFakeClaudeEnvReporter(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "",
      "if (process.argv.includes('--help')) {",
      "  process.stdout.write('Usage: fake-claude -p --input-format stream-json --output-format stream-json\\n');",
      "  process.exit(0);",
      "}",
      "",
      "const rl = readline.createInterface({ input: process.stdin });",
      "for await (const _line of rl) {",
      "  process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-env', cwd: process.cwd(), tools: [], model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions', disableBackgroundTasksEnv: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null })}\\n`);",
      "  process.stdout.write(`${JSON.stringify({ type: 'assistant', session_id: 'session-env', message: { id: 'msg_env', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } } })}\\n`);",
      "  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: 'done', session_id: 'session-env', total_cost_usd: 0 })}\\n`);",
      "  process.exit(0);",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeClaudeHelpExecutable(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "#!/bin/sh",
      "printf '%s\\n' 'Usage: fake-claude -p --input-format stream-json --output-format stream-json'",
      "exit 0",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(filePath, 0o755);
}

async function writeFakeClaudeArgvValidator(
  filePath: string,
  expectedSettings: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "const expectedSettings = " + JSON.stringify(expectedSettings) + ";",
      "const settingsIndex = process.argv.indexOf('--settings');",
      "if (settingsIndex < 0 || process.argv[settingsIndex + 1] !== expectedSettings) {",
      "  process.stderr.write(`settings mismatch: ${JSON.stringify(process.argv)}\\n`);",
      "  process.exit(1);",
      "}",
      "if (process.argv.includes('--help')) {",
      "  process.stdout.write('Usage: fake-claude -p --input-format stream-json --output-format stream-json\\n');",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      ""
    ].join("\n"),
    "utf8"
  );
}

function readJsonl(contents: string): unknown[] {
  return contents
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return value[key as keyof typeof value];
  }

  return undefined;
}
