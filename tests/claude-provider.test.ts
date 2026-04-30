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
import { afterEach, describe, expect, it } from "vitest";

import { createClaudeProvider } from "../src/providers/claude.js";
import type { ProviderEvent, ProviderRunInput } from "../src/provider.js";

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
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
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
    const provider = createClaudeProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`,
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

  it("maps AskUserQuestion tool use to input_required and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const provider = createClaudeProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} --scenario=input-required -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`,
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
    const provider = createClaudeProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} --scenario=malformed -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`,
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
    const provider = createClaudeProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeClaudePath} --scenario=error -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`,
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
    const provider = createClaudeProvider();
    const iterable = provider.runAttempt({
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeClaudePath} --scenario=wait -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`,
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
    expect(normalizedEvents[0]).toEqual(
      {
        cwd: workspacePath,
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        sessionId: "session-10",
        type: "session_started"
      }
    );
    expect(normalizedEvents[1]).toMatchObject({
      cancelled: true,
      type: "process_exit"
    });
  });

  it("validates the configured full-permission stream-json command", async () => {
    const root = await makeTempRoot();
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeClaudePath = path.join(root, "fake-claude.mjs");
    await writeFakeClaudeStreamJson(fakeClaudePath, transcriptPath);
    const provider = createClaudeProvider();

    await expect(
      provider.validate(
        `${process.execPath} ${fakeClaudePath} -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`
      )
    ).resolves.toBeUndefined();
  });

  it("preserves backslashes inside quoted command executables", async () => {
    const root = await makeTempRoot();
    const fakeClaudeDir = path.join(root, "fake\\claude dir");
    await mkdir(fakeClaudeDir, { recursive: true });
    const fakeClaudePath = path.join(fakeClaudeDir, "fake\\claude");
    await writeFakeClaudeHelpExecutable(fakeClaudePath);
    const provider = createClaudeProvider();

    await expect(
      provider.validate(
        `"${fakeClaudePath}" -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`
      )
    ).resolves.toBeUndefined();
  });

  it("preserves backslashes inside unquoted command executables", async () => {
    const root = await makeTempRoot();
    const fakeClaudeDir = path.join(root, "fake\\claude");
    await mkdir(fakeClaudeDir, { recursive: true });
    const fakeClaudePath = path.join(fakeClaudeDir, "claude\\bin");
    await writeFakeClaudeHelpExecutable(fakeClaudePath);
    const provider = createClaudeProvider();

    await expect(
      provider.validate(
        `${fakeClaudePath} -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json`
      )
    ).resolves.toBeUndefined();
  });

  it("rejects Claude commands that do not speak stream-json", async () => {
    const provider = createClaudeProvider();

    await expect(
      provider.validate("claude -p --dangerously-skip-permissions")
    ).rejects.toThrow("--input-format stream-json");
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
        "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json",
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
