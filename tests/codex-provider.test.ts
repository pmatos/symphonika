import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexProvider } from "../src/providers/codex.js";
import type { ProviderEvent, ProviderRunInput } from "../src/provider.js";

const tempRoots: string[] = [];
const originalFakeCodexTranscript = process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-codex-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  if (originalFakeCodexTranscript === undefined) {
    delete process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT;
  } else {
    process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT = originalFakeCodexTranscript;
  }

  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("Codex JSON-RPC provider", () => {
  it("launches the configured app-server in the workspace and maps a completed turn", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    const requests = readJsonl(await readFile(transcriptPath, "utf8"));
    expect(requests.map((request) => objectField(request, "method"))).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start"
    ]);
    expect(requests[2]).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        cwd: workspacePath,
        experimentalRawEvents: false,
        permissionProfile: {
          type: "disabled"
        }
      }
    });
    expect(requests[3]).toMatchObject({
      method: "turn/start",
      params: {
        input: [
          {
            text: "Implement issue #9.",
            text_elements: [],
            type: "text"
          }
        ],
        threadId: "thread-9"
      }
    });

    expect(events.map((event) => event.raw)).toEqual([
      {
        id: 1,
        result: {
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "linux",
          userAgent: "fake-codex-app-server"
        }
      },
      {
        id: 2,
        result: {
          cwd: workspacePath,
          thread: {
            id: "thread-9"
          }
        }
      },
      {
        id: 3,
        result: {
          turn: {
            id: "turn-9",
            status: "inProgress"
          }
        }
      },
      {
        method: "item/agentMessage/delta",
        params: {
          delta: "done",
          itemId: "item-1",
          threadId: "thread-9",
          turnId: "turn-9"
        }
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-9",
          tokenUsage: {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18
          },
          turnId: "turn-9"
        }
      },
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              remaining: 42,
              resetAt: 1777470000
            }
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-9",
          turn: {
            id: "turn-9",
            status: "completed"
          }
        }
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
    expect(normalizedEvents).toMatchObject([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        message: "done",
        threadId: "thread-9",
        turnId: "turn-9",
        type: "message"
      },
      {
        threadId: "thread-9",
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18
        },
        turnId: "turn-9",
        type: "usage_updated"
      },
      {
        rateLimits: {
          primary: {
            remaining: 42,
            resetAt: 1777470000
          }
        },
        type: "rate_limit_updated"
      },
      {
        status: "completed",
        threadId: "thread-9",
        turnId: "turn-9",
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

  it("maps app-server input requests to input_required and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} --scenario=input-required app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents).toMatchObject([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        method: "item/tool/requestUserInput",
        params: {
          itemId: "item-input",
          questions: [
            {
              header: "Choice",
              id: "choice",
              options: [],
              question: "Need operator input?"
            }
          ],
          threadId: "thread-9",
          turnId: "turn-9"
        },
        requestId: "input-1",
        type: "input_required"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
  });

  it("maps malformed app-server output to malformed_event and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} --scenario=malformed app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents).toMatchObject([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        line: "{bad json",
        type: "malformed_event"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
    expect(String(objectField(normalizedEvents[1], "message"))).toContain("JSON");
  });

  it("maps app-server error notifications to turn_failed and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider();

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} --scenario=error app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    expect(events.map((event) => event.normalized).filter(Boolean)).toEqual([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        message: "model exploded politely",
        threadId: "thread-9",
        turnId: "turn-9",
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

  it("interrupts and stops the app-server process on cancellation", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider();
    const iterable = provider.runAttempt({
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeServerPath} --scenario=wait app-server`,
        name: "codex"
      },
      workspacePath
    });
    const iterator = iterable[Symbol.asyncIterator]();

    const initialEvents = [
      await nextProviderEvent(iterator),
      await nextProviderEvent(iterator),
      await nextProviderEvent(iterator)
    ];
    await provider.cancel("run-issue-9");
    const remainingEvents = await collectIteratorEvents(iterator);
    const events = [...initialEvents, ...remainingEvents];

    const requests = readJsonl(await readFile(transcriptPath, "utf8"));
    expect(requests.map((request) => objectField(request, "method"))).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/interrupt"
    ]);
    expect(events.map((event) => event.normalized).filter(Boolean)).toEqual([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        cancelled: true,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
  });
});

describe("Codex provider validate", () => {
  it("succeeds when no profile is configured", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, []);
    const provider = createCodexProvider();

    await expect(
      provider.validate(`${process.execPath} ${fakePath} app-server`)
    ).resolves.toBeUndefined();
  });

  it("succeeds when the configured profile exists", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, ["symphonika"]);
    const provider = createCodexProvider();

    await expect(
      provider.validate(
        `${process.execPath} ${fakePath} -p symphonika app-server`
      )
    ).resolves.toBeUndefined();
  });

  it("returns an actionable error including the [profiles.<name>] snippet when the profile is missing", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, []);
    const provider = createCodexProvider();

    await expect(
      provider.validate(
        `${process.execPath} ${fakePath} -p symphonika app-server`
      )
    ).rejects.toThrow(/\[profiles\.symphonika\][\s\S]*memories\s*=\s*false/);
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
    branchName: "sym/symphonika/9-add-codex-json-rpc-provider-adapter",
    issue: {
      body: "Issue body",
      created_at: "2026-04-20T10:00:00Z",
      id: 5009,
      labels: ["agent-ready"],
      number: 9,
      priority: 99,
      state: "open",
      title: "Add Codex JSON-RPC provider adapter",
      updated_at: "2026-04-21T11:00:00Z",
      url: "https://github.com/pmatos/symphonika/issues/9"
    },
    prompt: "Implement issue #9.",
    promptPath: "/tmp/prompt.md",
    provider: {
      command: "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server",
      name: "codex"
    },
    run: {
      attempt: 1,
      id: "run-issue-9"
    },
    workspacePath: "/tmp/workspace"
  };
}

async function writeFakeCodexAppServer(
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
      "  process.stdout.write('Usage: fake-codex app-server --listen <URL>\\n');",
      "  process.exit(0);",
      "}",
      "",
      "const transcriptPath = process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT;",
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
      "  if (message.method === 'initialize') {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        codexHome: '/tmp/fake-codex-home',",
      "        platformFamily: 'unix',",
      "        platformOs: 'linux',",
      "        userAgent: 'fake-codex-app-server'",
      "      }",
      "    });",
      "  }",
      "  if (message.method === 'thread/start') {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        cwd: process.cwd(),",
      "        thread: {",
      "          id: 'thread-9'",
      "        }",
      "      }",
      "    });",
      "  }",
      "  if (message.method === 'turn/start') {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        turn: {",
      "          id: 'turn-9',",
      "          status: 'inProgress'",
      "        }",
      "      }",
      "    });",
      "    if (scenario === 'input-required') {",
      "      send({ method: 'item/tool/requestUserInput', id: 'input-1', params: { threadId: 'thread-9', turnId: 'turn-9', itemId: 'item-input', questions: [{ header: 'Choice', id: 'choice', question: 'Need operator input?', options: [] }] } });",
      "      continue;",
      "    }",
      "    if (scenario === 'malformed') {",
      "      process.stdout.write('{bad json\\n');",
      "      continue;",
      "    }",
      "    if (scenario === 'error') {",
      "      send({ method: 'error', params: { threadId: 'thread-9', turnId: 'turn-9', error: { message: 'model exploded politely', codexErrorInfo: null, additionalDetails: null }, willRetry: false } });",
      "      continue;",
      "    }",
      "    if (scenario === 'wait') {",
      "      continue;",
      "    }",
      "    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-9', turnId: 'turn-9', itemId: 'item-1', delta: 'done' } });",
      "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-9', turnId: 'turn-9', tokenUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } } });",
      "    send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { remaining: 42, resetAt: 1777470000 } } } });",
      "    send({ method: 'turn/completed', params: { threadId: 'thread-9', turn: { id: 'turn-9', status: 'completed' } } });",
      "    process.exit(0);",
      "  }",
      "  if (message.method === 'turn/interrupt') {",
      "    send({ id: message.id, result: {} });",
      "    process.exit(0);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT = transcriptPath;
}

async function writeFakeCodexValidator(
  filePath: string,
  knownProfiles: string[]
): Promise<void> {
  await writeFile(
    filePath,
    [
      `const known = new Set(${JSON.stringify(knownProfiles)});`,
      "const args = process.argv.slice(2);",
      "function profileFrom(args) {",
      "  for (let i = 0; i < args.length; i++) {",
      "    const a = args[i];",
      "    if (a === '-p' || a === '--profile') return args[i + 1];",
      "    if (a.startsWith('--profile=')) return a.slice('--profile='.length);",
      "  }",
      "  return undefined;",
      "}",
      "if (args.includes('--help')) {",
      "  process.stdout.write('Usage: fake-codex app-server --listen <URL>\\n');",
      "  process.exit(0);",
      "}",
      "if (args.includes('features') && args.includes('list')) {",
      "  const profile = profileFrom(args);",
      "  if (profile !== undefined && !known.has(profile)) {",
      "    process.stderr.write('Error: config profile `' + profile + '` not found\\n');",
      "    process.exit(1);",
      "  }",
      "  process.stdout.write('memories experimental true\\n');",
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
