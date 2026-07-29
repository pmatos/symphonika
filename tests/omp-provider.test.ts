import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ProcessCommand,
  ProviderRunIdentity
} from "../src/lifecycle/process-scope.js";
import type { ProviderEvent, ProviderRunInput } from "../src/provider.js";
import { createOmpProvider } from "../src/providers/omp.js";

type RecordingProcessScope = {
  stopCalls: ProviderRunIdentity[];
  wrapCalls: Array<{ command: ProcessCommand; run: ProviderRunIdentity }>;
  stopProviderScope: (run: ProviderRunIdentity) => Promise<boolean>;
  wrapForProviderScope: (
    run: ProviderRunIdentity,
    command: ProcessCommand
  ) => Promise<ProcessCommand>;
};

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Oh My Pi RPC provider", () => {
  it("negotiates RPC v2 and maps a completed agent turn", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeOmpPath = path.join(root, "fake-omp.mjs");
    await writeFakeOmp(fakeOmpPath, transcriptPath);
    const processScope = noopProcessScope();
    const provider = createOmpProvider({ processScope });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(readJsonl(await readFile(transcriptPath, "utf8"))).toEqual([
      {
        id: "symphonika-1",
        protocolVersion: 2,
        type: "negotiate_protocol"
      },
      {
        id: "symphonika-2",
        type: "get_state"
      },
      {
        id: "symphonika-3",
        message: "Implement issue #335.",
        type: "prompt"
      }
    ]);
    expect(
      events.map((event) => event.normalized).filter(Boolean)
    ).toMatchObject([
      {
        model: "openai/gpt-5.4",
        sessionFile: "/tmp/omp-session.jsonl",
        sessionId: "omp-session-335",
        type: "session_started"
      },
      {
        message: "done",
        messageKind: "text",
        sessionId: "omp-session-335",
        type: "message"
      },
      {
        sessionId: "omp-session-335",
        tokenUsage: {
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 23
        },
        type: "usage_updated"
      },
      {
        input: { cmd: "npm test" },
        sessionId: "omp-session-335",
        toolCallId: "tool-1",
        toolName: "bash",
        type: "tool_call"
      },
      {
        sessionId: "omp-session-335",
        type: "turn_completed"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
    expect(processScope.stopCalls).toEqual([
      { attempt: 1, id: "run-issue-335" }
    ]);
  });

  it("reassembles protocol v2 chunks before normalizing the logical event", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeOmpPath = path.join(root, "fake-chunked-omp.mjs");
    const message = "x".repeat(1_600);
    await writeFakeChunkedOmp(fakeOmpPath, transcriptPath, message);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events
        .map((event) => event.raw)
        .filter((raw) => objectField(raw, "type") === "rpc_chunk")
    ).toHaveLength(3);
    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "message")
    ).toMatchObject({
      message,
      messageKind: "text",
      sessionId: "omp-session-335",
      type: "message"
    });
  });

  it("preserves and rejects malformed protocol v2 chunks", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-malformed-chunk-omp.mjs");
    await writeFakeMalformedChunkOmp(fakeOmpPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events.some((event) => objectField(event.raw, "type") === "rpc_chunk")
    ).toBe(true);
    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "malformed_event")
    ).toMatchObject({
      message: "invalid Oh My Pi RPC chunk data",
      type: "malformed_event"
    });
  });

  it("rejects physical frames above the ready-frame byte limit", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-oversized-frame-omp.mjs");
    await writeFakeOversizedFrameOmp(fakeOmpPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "malformed_event")
    ).toMatchObject({
      message: "Oh My Pi RPC frame exceeds the physical frame limit",
      type: "malformed_event"
    });
  });

  it("fails autonomous execution when OMP requests interactive input", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-input-omp.mjs");
    await writeFakeInputOmp(fakeOmpPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events.map((event) => event.normalized).filter(Boolean)
    ).toMatchObject([
      {
        sessionId: "omp-session-335",
        type: "session_started"
      },
      {
        method: "input",
        requestId: "ui-1",
        sessionId: "omp-session-335",
        title: "Choose a release channel",
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

  it("fails the turn when OMP accepts the prompt without invoking an agent", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-no-agent-omp.mjs");
    await writeFakeNoAgentOmp(fakeOmpPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "turn_failed")
    ).toMatchObject({
      command: "prompt",
      message: "Oh My Pi did not invoke an agent for the prompt",
      type: "turn_failed"
    });
  });

  it("fails before sending commands when OMP emits an incompatible ready frame", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-incompatible-omp.mjs");
    await writeFakeIncompatibleOmp(fakeOmpPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "turn_failed")
    ).toMatchObject({
      message: "Oh My Pi provider emitted an incompatible ready frame",
      type: "turn_failed"
    });
  });

  it("stops the handshake on malformed output before ready", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(
      root,
      "malformed-handshake-requests.jsonl"
    );
    await writeFile(transcriptPath, "", "utf8");
    const fakeOmpPath = path.join(root, "fake-malformed-handshake-omp.mjs");
    await writeFakeMalformedHandshakeOmp(fakeOmpPath, transcriptPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(await readFile(transcriptPath, "utf8")).toBe("");
    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "malformed_event")
    ).toMatchObject({ type: "malformed_event" });
  });

  it("requires OMP to confirm protocol v2 negotiation", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-bad-negotiation-omp.mjs");
    await writeFakeBadNegotiationOmp(fakeOmpPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "turn_failed")
    ).toMatchObject({
      command: "negotiate_protocol",
      message: "Oh My Pi did not confirm RPC protocol v2",
      type: "turn_failed"
    });
  });

  it("maps OMP error notices and assistant errors to failed turns", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-notice-omp.mjs");
    await writeFakeNoticeOmp(fakeOmpPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
          name: "omp"
        },
        workspacePath
      })
    );

    expect(
      events
        .map((event) => event.normalized)
        .filter((event) => event?.type === "turn_failed")
    ).toMatchObject([
      {
        message: "model request failed",
        type: "turn_failed"
      },
      {
        message: "provider stream failed",
        type: "turn_failed"
      }
    ]);
  });

  it("latches cancellation while process scoping is still starting", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "must-not-start.mjs");
    const processScope = noopProcessScope();
    let announceWrapStarted: (() => void) | undefined;
    let releaseWrap: (() => void) | undefined;
    const wrapStarted = new Promise<void>((resolve) => {
      announceWrapStarted = resolve;
    });
    processScope.wrapForProviderScope = (run, command) => {
      processScope.wrapCalls.push({ command, run });
      announceWrapStarted?.();
      return new Promise<ProcessCommand>((resolve) => {
        releaseWrap = () => resolve(command);
      });
    };
    const provider = createOmpProvider({ processScope });
    const input: ProviderRunInput = {
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
        name: "omp"
      },
      workspacePath
    };

    const collecting = collectProviderEvents(provider.runAttempt(input));
    await wrapStarted;
    await provider.cancel(input.run.id);
    releaseWrap?.();
    const events = await collecting;

    expect(events.map((event) => event.normalized).filter(Boolean)).toEqual([
      {
        cancelled: true,
        exitCode: null,
        signal: null,
        type: "process_exit"
      }
    ]);
    expect(processScope.stopCalls).toEqual([
      { attempt: 1, id: "run-issue-335" }
    ]);
  });

  it("sends abort and reports a cancelled exit for an active OMP run", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "cancel-requests.jsonl");
    const fakeOmpPath = path.join(root, "fake-cancellable-omp.mjs");
    await writeFakeCancellableOmp(fakeOmpPath, transcriptPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });
    const input: ProviderRunInput = {
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeOmpPath} --mode rpc --auto-approve`,
        name: "omp"
      },
      workspacePath
    };

    const collecting = collectProviderEvents(provider.runAttempt(input));
    await waitForTranscriptCommand(transcriptPath, "prompt");
    await provider.cancel(input.run.id);
    const events = await collecting;

    expect(readJsonl(await readFile(transcriptPath, "utf8"))).toContainEqual(
      expect.objectContaining({ type: "abort" })
    );
    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "process_exit")
    ).toEqual({
      cancelled: true,
      exitCode: 0,
      signal: null,
      type: "process_exit"
    });
  });

  it("validates a quoted OMP executable with a bounded ready-frame probe", async () => {
    const root = await makeTempRoot();
    const fakeOmpDirectory = path.join(root, "fake omp");
    await mkdir(fakeOmpDirectory, { recursive: true });
    const fakeOmpPath = path.join(fakeOmpDirectory, "omp executable");
    const transcriptPath = path.join(root, "validation.txt");
    await writeFakeOmpValidator(fakeOmpPath, transcriptPath);
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(`"${fakeOmpPath}" --mode rpc --auto-approve`)
    ).resolves.toBeUndefined();
    await expect(readFile(transcriptPath, "utf8")).resolves.toBe(
      "started\neof\n"
    );
  });

  it("rejects OMP commands that are not autonomous RPC commands", async () => {
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    await expect(provider.validate("omp --auto-approve")).rejects.toThrow(
      "must include --mode rpc"
    );
    await expect(provider.validate("omp --mode rpc")).rejects.toThrow(
      "must run with full permissions"
    );
    await expect(
      provider.validate("omp --mode rpc --auto-approve --print")
    ).rejects.toThrow("must not use print mode");
    await expect(
      provider.validate("omp --mode json --mode rpc --auto-approve")
    ).rejects.toThrow("must select exactly one --mode rpc");
  });

  it("rejects incompatible, early-exit, and timed-out OMP probes", async () => {
    const root = await makeTempRoot();
    const incompatiblePath = path.join(root, "incompatible.mjs");
    const earlyExitPath = path.join(root, "early-exit.mjs");
    const timeoutPath = path.join(root, "timeout.mjs");
    await writeFakeIncompatibleOmp(incompatiblePath);
    await writeFile(
      earlyExitPath,
      "process.stderr.write('missing credentials'); process.exit(3);\n",
      "utf8"
    );
    await writeFile(
      timeoutPath,
      "setInterval(() => undefined, 1000);\n",
      "utf8"
    );
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        `${process.execPath} ${incompatiblePath} --mode rpc --auto-approve`
      )
    ).rejects.toThrow("incompatible ready frame");
    await expect(
      provider.validate(
        `${process.execPath} ${earlyExitPath} --mode rpc --auto-approve`
      )
    ).rejects.toThrow("exited before ready with code 3: missing credentials");

    const previousTimeout = process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS;
    process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS = "25";
    try {
      await expect(
        provider.validate(
          `${process.execPath} ${timeoutPath} --mode rpc --auto-approve`
        )
      ).rejects.toThrow("validation timed out");
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS;
      } else {
        process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});

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

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-omp-test-"));
  tempRoots.push(root);
  return root;
}

async function collectProviderEvents(
  iterable: AsyncIterable<ProviderEvent>
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function providerInputFixture(): ProviderRunInput {
  return {
    branchName: "sym/symphonika/335-add-omp-provider",
    issue: {
      body: "Add actual Oh My Pi support.",
      created_at: "2026-07-28T10:00:00Z",
      id: 5335,
      labels: ["agent-ready"],
      number: 335,
      priority: 0,
      state: "open",
      title: "Add Oh My Pi provider",
      updated_at: "2026-07-28T11:00:00Z",
      url: "https://github.com/pmatos/symphonika/issues/335"
    },
    prompt: "Implement issue #335.",
    promptPath: "/tmp/prompt.md",
    provider: {
      command: "omp --mode rpc --auto-approve",
      name: "omp"
    },
    run: {
      attempt: 1,
      id: "run-issue-335"
    },
    workspacePath: "/tmp/workspace"
  };
}

async function writeFakeOmp(
  filePath: string,
  transcriptPath: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "import { appendFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      "",
      `const transcriptPath = ${JSON.stringify(transcriptPath)};`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) {",
      "  process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "}",
      "async function record(message) {",
      "  await appendFile(transcriptPath, `${JSON.stringify(message)}\\n`, 'utf8');",
      "}",
      "",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
      "for await (const line of rl) {",
      "  const message = JSON.parse(line);",
      "  await record(message);",
      "  if (message.type === 'negotiate_protocol') {",
      "    send({ id: message.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } });",
      "  }",
      "  if (message.type === 'get_state') {",
      "    send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', sessionFile: '/tmp/omp-session.jsonl', model: { provider: 'openai', id: 'gpt-5.4' }, thinkingLevel: 'high', isStreaming: false, isCompacting: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', interruptMode: 'immediate', autoCompactionEnabled: true, messageCount: 0, queuedMessageCount: 0, todoPhases: [] } });",
      "  }",
      "  if (message.type === 'prompt') {",
      "    send({ id: message.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "    send({ type: 'agent_start' });",
      "    send({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'done', partial: { role: 'assistant' } } });",
      "    send({ type: 'message_end', message: { role: 'assistant', model: 'gpt-5.4', usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 23, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });",
      "    send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { cmd: 'npm test' } });",
      "    send({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] });",
      "    send({ type: 'agent_end', isTerminal: true, messages: [] });",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeChunkedOmp(
  filePath: string,
  transcriptPath: string,
  message: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "import { appendFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      "",
      `const transcriptPath = ${JSON.stringify(transcriptPath)};`,
      `const delta = ${JSON.stringify(message)};`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "async function record(message) { await appendFile(transcriptPath, `${JSON.stringify(message)}\\n`, 'utf8'); }",
      "function sendChunked(message) {",
      "  const encoded = Buffer.from(JSON.stringify(message), 'utf8');",
      "  const chunkSize = 700;",
      "  const count = Math.ceil(encoded.length / chunkSize);",
      "  for (let index = 0; index < count; index += 1) {",
      "    send({ type: 'rpc_chunk', chunkId: 'chunk-1', index, count, byteLength: encoded.length, data: encoded.subarray(index * chunkSize, (index + 1) * chunkSize).toString('base64') });",
      "  }",
      "}",
      "",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1200, maxReassembledFrameBytes: 8192 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  await record(command);",
      "  if (command.type === 'negotiate_protocol') send({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } });",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') {",
      "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "    sendChunked({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: { role: 'assistant' } } });",
      "    send({ type: 'agent_end', isTerminal: true, messages: [] });",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeMalformedChunkOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1024, maxReassembledFrameBytes: 8192 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  if (command.type === 'negotiate_protocol') send({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } });",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') {",
      "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "    send({ type: 'rpc_chunk', chunkId: 'bad-1', index: 0, count: 2, byteLength: 2048, data: '**not-base64**' });",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeOversizedFrameOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1024, maxReassembledFrameBytes: 8192 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') {",
      "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "    send({ type: 'notice', level: 'info', message: 'x'.repeat(2048) });",
      "    setTimeout(() => process.exit(0), 10);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeInputOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') {",
      "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "    send({ type: 'extension_ui_request', id: 'ui-1', method: 'input', title: 'Choose a release channel', placeholder: 'stable' });",
      "    process.exit(0);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeNoAgentOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') {",
      "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: false } });",
      "    process.exit(0);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeIncompatibleOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "process.stdout.write(`${JSON.stringify({ type: 'ready', protocolVersion: 9, supportedProtocolVersions: [9], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 })}\\n`);",
      "setTimeout(() => process.exit(0), 10);",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeMalformedHandshakeOmp(
  filePath: string,
  transcriptPath: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "import { appendFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const transcriptPath = ${JSON.stringify(transcriptPath)};`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "process.stdout.write('not-json\\n');",
      "setTimeout(() => process.stdout.write(`${JSON.stringify({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 })}\\n`), 10);",
      "for await (const line of rl) {",
      "  await appendFile(transcriptPath, `${line}\\n`, 'utf8');",
      "  process.exit(0);",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeBadNegotiationOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  if (command.type === 'negotiate_protocol') send({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 1 } });",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: false, error: 'unexpected get_state' });",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeNoticeOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') {",
      "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "    send({ type: 'notice', level: 'error', message: 'model request failed' });",
      "    send({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'error', reason: 'error', error: { role: 'assistant', errorMessage: 'provider stream failed' } } });",
      "    setTimeout(() => process.exit(0), 10);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeCancellableOmp(
  filePath: string,
  transcriptPath: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "import { appendFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const transcriptPath = ${JSON.stringify(transcriptPath)};`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "async function record(message) { await appendFile(transcriptPath, `${JSON.stringify(message)}\\n`, 'utf8'); }",
      "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  await record(command);",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "  if (command.type === 'abort') process.exit(0);",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function waitForTranscriptCommand(
  transcriptPath: string,
  commandType: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const commands = readJsonl(await readFile(transcriptPath, "utf8"));
      if (
        commands.some((command) => objectField(command, "type") === commandType)
      ) {
        return;
      }
    } catch {
      // The fake process has not created its transcript yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for OMP command ${commandType}`);
}

async function writeFakeOmpValidator(
  filePath: string,
  transcriptPath: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "#!/usr/bin/env node",
      "import { appendFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      `const transcriptPath = ${JSON.stringify(transcriptPath)};`,
      "await appendFile(transcriptPath, 'started\\n', 'utf8');",
      "process.stdout.write(`${JSON.stringify({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 })}\\n`);",
      "const rl = readline.createInterface({ input: process.stdin });",
      "for await (const _line of rl) {}",
      "await appendFile(transcriptPath, 'eof\\n', 'utf8');",
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 }
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
