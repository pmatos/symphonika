import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ProcessCommand,
  ProviderRunIdentity
} from "../src/lifecycle/process-scope.js";
import type { ProviderEvent, ProviderRunInput } from "../src/provider.js";
import type { ProcessQueue } from "../src/providers/omp.js";
import {
  createOmpProvider,
  createProcessQueue,
  RpcChunkDecoder
} from "../src/providers/omp.js";

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

  it("bounds an unterminated frame accumulated across chunks and resumes after it", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-unterminated-frame-omp.mjs");
    await writeFakeUnterminatedFrameOmp(fakeOmpPath);
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

    const malformed = events
      .map((event) => event.normalized)
      .filter((event) => event?.type === "malformed_event");
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({
      message: "Oh My Pi RPC frame exceeds the physical frame limit",
      type: "malformed_event"
    });
    expect(events.at(-1)?.normalized).toMatchObject({
      exitCode: 0,
      type: "process_exit"
    });
  });

  it("enforces the byte limit on unterminated multibyte input and caps evidence", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-multibyte-overflow-omp.mjs");
    await writeFakeMultibyteOverflowOmp(fakeOmpPath);
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

    const malformedLines = events
      .map((event) => event.normalized)
      .flatMap((event) =>
        event?.type === "malformed_event" && typeof event.line === "string"
          ? [event.line]
          : []
      );
    expect(malformedLines).toHaveLength(2);
    // 600 two-byte characters stay under the limit as characters but exceed
    // it as UTF-8 bytes, so the small payload is preserved in full.
    expect(malformedLines[0]).toBe("é".repeat(600));
    expect(Buffer.byteLength(malformedLines[0] ?? "", "utf8")).toBe(1200);
    expect(
      Buffer.byteLength(malformedLines[1] ?? "", "utf8")
    ).toBeLessThanOrEqual(4096);
    expect(malformedLines[1]).not.toContain("\uFFFD");
    expect(events.at(-1)?.normalized).toMatchObject({
      exitCode: 0,
      type: "process_exit"
    });
  });

  it("bounds an unterminated frame between data callbacks and discards the overflow", async () => {
    const root = await makeTempRoot();
    const echoPath = path.join(root, "echo-omp.mjs");
    await writeFakeEchoOmp(echoPath);
    const child = spawn(process.execPath, [echoPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    try {
      const queue = createProcessQueue(child);
      queue.setFrameLimits(1024, 8192);
      const send = (command: unknown): void => {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      };

      send({ write: "a".repeat(600) });
      send({ write: "b".repeat(600) });
      // Awaiting the overflow item is the acknowledgement that the data
      // callback latched, so the discarded chunk below cannot coalesce with
      // the buffered frame.
      const overflow = await queue.next();
      expect(overflow).toMatchObject({
        kind: "malformed",
        line: "a".repeat(600) + "b".repeat(600),
        message: "Oh My Pi RPC frame exceeds the physical frame limit"
      });

      send({ newline: true, write: "c".repeat(600) });
      send({
        exit: true,
        newline: true,
        write: JSON.stringify({ message: "resumed", type: "notice" })
      });
      const resumed = await queue.next();
      expect(resumed).toMatchObject({
        kind: "message",
        raw: { message: "resumed", type: "notice" }
      });
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  });

  it("re-checks buffered output when negotiated frame limits tighten", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    // One write carries a complete ready frame plus an unterminated
    // remainder that fits the pre-ready 1 MiB default but not the limit the
    // ready frame negotiates down to.
    stdout.write(`${JSON.stringify({ type: "ready" })}\n${"d".repeat(2000)}`);
    queue.setFrameLimits(1024, 8192);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      line: "d".repeat(2000),
      message: "Oh My Pi RPC frame exceeds the physical frame limit"
    });
  });

  it("revalidates complete frames queued in the same write as the ready frame", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    stdout.write(`${JSON.stringify({ type: "ready" })}\n${"e".repeat(2000)}\n`);

    expect(stdout.isPaused()).toBe(true);
    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.setFrameLimits(1024, 8192);
    expect(stdout.isPaused()).toBe(false);
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC frame exceeds the physical frame limit"
    });
  });

  it("keeps stdout paused when no frame limits arrive for a latched ready", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    stdout.write(
      `${JSON.stringify({ type: "ready" })}\n${"g".repeat(2000)}\n${"g".repeat(2000)}\n`
    );

    expect(queue.size).toBe(1);
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(queue.size).toBe(0);
    expect(stdout.isPaused()).toBe(true);
  });

  it("flushes a deferred EOF remainder after limits are installed", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    stdout.write(`${JSON.stringify({ type: "ready" })}\n${"f".repeat(2000)}`);
    stdout.end();

    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.setFrameLimits(1024, 8192);
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC frame exceeds the physical frame limit"
    });
  });

  it("parses deferred chunk lines before reporting a pending sequence at EOF", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    const [first] = rpcChunkLines(
      JSON.stringify({ message: "x".repeat(1100), type: "notice" }),
      "chunk-deferred"
    );
    stdout.write(`${JSON.stringify({ type: "ready" })}\n${first}\n`);
    stdout.end();

    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.setFrameLimits(1024, 8192);
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence incomplete at end of stream"
    });
  });

  it("accepts a coalesced frame that exceeds the default limit but fits the advertised one", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    const frame = JSON.stringify({
      message: "x".repeat(1_100_000),
      type: "notice"
    });
    stdout.write(`${JSON.stringify({ type: "ready" })}\n${frame}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.setFrameLimits(2 * 1024 * 1024, 4 * 1024 * 1024);
    expect(await queue.next()).toMatchObject({
      kind: "message",
      raw: { message: "x".repeat(1_100_000), type: "notice" }
    });
  });

  it("rejects a non-chunk frame that interrupts a pending chunk sequence", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const [first, second] = rpcChunkLines(
      JSON.stringify({ message: "x".repeat(1100), type: "notice" }),
      "chunk-1"
    );
    stdout.write(`${first}\n`);
    stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    stdout.write(`${second}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence interrupted by a non-chunk frame"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence must start at index 0"
    });
  });

  it("rejects a reassembled chunk payload that is not a JSON object", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const [first, second] = rpcChunkLines(
      `[${"1,".repeat(600)}1]`,
      "chunk-array"
    );
    stdout.write(`${first}\n`);
    stdout.write(`${second}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi logical RPC frame must be an object"
    });
  });

  it("rejects rpc_chunk frames before protocol v2 is negotiated", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 },
      protocolV2: false
    });
    const [first, second] = rpcChunkLines(
      JSON.stringify({ message: "x".repeat(1100), type: "notice" }),
      "chunk-v1"
    );
    stdout.write(`${first}\n`);
    stdout.write(`${second}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk received before protocol v2 negotiation"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk received before protocol v2 negotiation"
    });
  });

  it("grows the chunk buffer with received bytes instead of the declared length", () => {
    const decoder = new RpcChunkDecoder();
    decoder.setLimits(1024, 16 * 1024 * 1024);
    // A 1-byte chunk declaring the maximum logical length: capacity must
    // track the received byte, not the 16 MiB declaration, across repeated
    // declare-then-interrupt cycles.
    const firstChunk = {
      byteLength: 16 * 1024 * 1024,
      chunkId: "chunk-grow",
      count: 16 * 1024 * 1024,
      data: Buffer.from("a").toString("base64"),
      index: 0,
      type: "rpc_chunk"
    };
    decoder.push(firstChunk);
    expect(decoder.pendingBufferBytes).toBe(1);
    expect(decoder.interrupt()).toBe(true);
    decoder.push(firstChunk);
    expect(decoder.pendingBufferBytes).toBe(1);
  });

  it("reassembles a logical frame from more than two chunks", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const payload = JSON.stringify({
      message: "x".repeat(1100),
      type: "notice"
    });
    const payloadBytes = Buffer.from(payload, "utf8");
    const chunkCount = 4;
    const sliceSize = Math.ceil(payloadBytes.byteLength / chunkCount);
    for (let index = 0; index < chunkCount; index += 1) {
      stdout.write(
        `${JSON.stringify({
          byteLength: payloadBytes.byteLength,
          chunkId: "chunk-multi",
          count: chunkCount,
          data: payloadBytes
            .subarray(index * sliceSize, (index + 1) * sliceSize)
            .toString("base64"),
          index,
          type: "rpc_chunk"
        })}\n`
      );
    }

    for (let index = 0; index < chunkCount; index += 1) {
      expect(await queue.next()).toMatchObject({ kind: "message" });
    }
    expect(await queue.next()).toMatchObject({
      kind: "message",
      raw: { message: "x".repeat(1100), type: "notice" }
    });
  });

  it("rejects a blank line that interrupts a pending chunk sequence", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const [first, second] = rpcChunkLines(
      JSON.stringify({ message: "x".repeat(1100), type: "notice" }),
      "chunk-blank"
    );
    stdout.write(`${first}\n`);
    stdout.write("\n");
    stdout.write(`${second}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence interrupted by a non-chunk frame"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence must start at index 0"
    });
  });

  it("tolerates blank lines while no chunk sequence is pending", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    stdout.write("\n");
    stdout.write("   \n");
    stdout.write(`${JSON.stringify({ type: "notice" })}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
  });

  it("rejects a reassembled chunk payload without a string type", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const [first, second] = rpcChunkLines(
      JSON.stringify({ pad: "x".repeat(1100) }),
      "chunk-typeless"
    );
    stdout.write(`${first}\n`);
    stdout.write(`${second}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi logical RPC frame must have a string type"
    });
  });

  it("does not complete a chunk sequence after a mismatched chunk", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const payload = JSON.stringify({
      message: "x".repeat(1100),
      type: "notice"
    });
    const [first, second] = rpcChunkLines(payload, "chunk-mismatch");
    stdout.write(`${first}\n`);
    stdout.write(`${second.replace("chunk-mismatch", "chunk-other")}\n`);
    stdout.write(`${second}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence mismatch"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence must start at index 0"
    });
  });

  it("does not complete a chunk sequence after a malformed physical frame", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const payload = JSON.stringify({
      message: "x".repeat(1100),
      type: "notice"
    });
    const [first, second] = rpcChunkLines(payload, "chunk-garbage");
    stdout.write(`${first}\n`);
    stdout.write("not-json\n");
    stdout.write(`${second}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({ kind: "malformed" });
    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence must start at index 0"
    });
  });

  it("rejects an incomplete chunk sequence when stdout ends", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const [first] = rpcChunkLines(
      JSON.stringify({ message: "x".repeat(1100), type: "notice" }),
      "chunk-truncated"
    );
    stdout.write(`${first}\n`);
    stdout.end();

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC chunk sequence incomplete at end of stream"
    });
  });

  it("routes stdin write errors through the process queue", async () => {
    const { queue, stdin } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });

    stdin.destroy(new Error("write EPIPE"));

    const item = await queue.next();
    expect(item.kind).toBe("error");
  });

  it("pauses stdout when queued frame bytes cross the high-water mark", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 },
      queueOptions: { maxPendingFrameBytes: 2048 }
    });
    const frame = JSON.stringify({ message: "x".repeat(560), type: "notice" });
    // One write, five ~590-byte frames: the drain stops mid-callback once
    // the backlog crosses the byte high-water mark.
    stdout.write(`${frame}\n${frame}\n${frame}\n${frame}\n${frame}\n`);

    expect(stdout.isPaused()).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      expect(await queue.next()).toMatchObject({ kind: "message" });
    }
    expect(stdout.isPaused()).toBe(false);
  });

  it("pauses stdout when the queued item count crosses the high-water mark", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 },
      queueOptions: { maxPendingItems: 3 }
    });
    const frame = `${JSON.stringify({ type: "notice" })}\n`;
    stdout.write(frame.repeat(5));

    expect(stdout.isPaused()).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      expect(await queue.next()).toMatchObject({ kind: "message" });
    }
    expect(stdout.isPaused()).toBe(false);
  });

  it("drains a deferred EOF backlog without crossing the high-water marks", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false,
      queueOptions: { maxPendingFrameBytes: 2048, maxPendingItems: 4 }
    });
    // ready latches the drain; the ten tiny frames plus EOF arrive together,
    // so they can only be enqueued as the consumer drains below the marks.
    const frame = `${JSON.stringify({ type: "notice" })}\n`;
    stdout.write(`${JSON.stringify({ type: "ready" })}\n${frame.repeat(10)}`);
    stdout.end();

    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.setFrameLimits(1024, 8192);
    expect(stdout.isPaused()).toBe(true);
    // The backlog stops at the item high-water mark even though the
    // producer has already finished the stream.
    expect(queue.size).toBe(4);
    for (let index = 0; index < 10; index += 1) {
      expect(await queue.next()).toMatchObject({ kind: "message" });
    }
    expect(stdout.isPaused()).toBe(false);
  });

  it("does not discard a deferred backlog as oversized when limits install mid-stream", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false,
      queueOptions: { maxPendingFrameBytes: 2048, maxPendingItems: 4 }
    });
    // The six frames left buffered at the high-water mark total more than
    // the negotiated physical limit, so an unguarded enforceStdoutBound
    // would misclassify and discard them as one oversized frame.
    const frame = JSON.stringify({ message: "x".repeat(180), type: "notice" });
    stdout.write(
      `${JSON.stringify({ type: "ready" })}\n${`${frame}\n`.repeat(10)}`
    );

    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.setFrameLimits(1024, 8192);
    const kinds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      kinds.push((await queue.next()).kind);
    }
    expect(kinds).toEqual(Array.from({ length: 10 }, () => "message"));
  });

  it("defers process exit until a latched backlog drains", async () => {
    const { close, queue, stdout } = await createQueueHarness({
      emitReady: false,
      queueOptions: { maxPendingItems: 3 }
    });
    const frame = JSON.stringify({ type: "notice" });
    stdout.write(
      `${JSON.stringify({ type: "ready" })}\n${`${frame}\n`.repeat(5)}`
    );
    stdout.end();
    close(0, null);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.setFrameLimits(1024, 8192);
    const kinds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      kinds.push((await queue.next()).kind);
    }
    expect(kinds).toEqual([
      "message",
      "message",
      "message",
      "message",
      "message",
      "exit"
    ]);
  });

  it("enqueues a stored exit after discard when limits never install", async () => {
    const { close, queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    stdout.write(
      `${JSON.stringify({ type: "ready" })}\n${JSON.stringify({ type: "notice" })}\n`
    );
    stdout.end();
    close(0, null);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    queue.discardBeforeFrameLimits();
    expect(await queue.next()).toMatchObject({ exitCode: 0, kind: "exit" });
    queue.discardBeforeFrameLimits();
  });

  it("pauses stdout when the queue fills with an unterminated remainder buffered", async () => {
    const { stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 },
      queueOptions: { maxPendingItems: 4 }
    });
    const frame = JSON.stringify({ type: "notice" });
    // The fourth frame crosses the item high-water mark and the trailing
    // partial frame has no newline, so the drain loop never reaches its
    // in-loop pause check.
    stdout.write(`${frame}\n${frame}\n${frame}\n${frame}\npartial`);

    expect(stdout.isPaused()).toBe(true);
  });

  it("measures only the unterminated suffix against the physical limit", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    const frame = JSON.stringify({ message: "x".repeat(560), type: "notice" });
    // Whole buffer is 1190 bytes, but the unterminated suffix is 600: the
    // complete frame must still be parsed, not discarded as oversized.
    stdout.write(`${frame}\n${"z".repeat(600)}`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
  });

  it("preserves a backpressured complete frame left buffered with a short suffix", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 },
      queueOptions: { maxPendingItems: 4 }
    });
    const frame = JSON.stringify({ type: "notice" });
    // Four frames cross the item high-water mark; the fifth complete frame
    // and a 600-byte suffix stay buffered until the consumer drains.
    stdout.write(
      `${frame}\n${frame}\n${frame}\n${frame}\n${frame}\n${"z".repeat(600)}`
    );
    expect(stdout.isPaused()).toBe(true);

    for (let index = 0; index < 5; index += 1) {
      expect(await queue.next()).toMatchObject({ kind: "message" });
    }
  });

  it("rejects a non-ready first protocol frame", async () => {
    const { queue, stdout } = await createQueueHarness({
      emitReady: false
    });
    stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

    expect(await queue.next()).toMatchObject({ kind: "message" });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC protocol must begin with a ready frame"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
  });

  it("rejects non-object physical RPC frames", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    stdout.write(`[]\n`);
    stdout.write(`${JSON.stringify({ type: "notice" })}\n`);

    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi physical RPC frame must be an object"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
  });

  it("rejects physical frames without a string type field", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    stdout.write("{}\n");
    stdout.write('{"type":1}\n');
    stdout.write(`${JSON.stringify({ type: "notice" })}\n`);

    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi physical RPC frame must have a string type"
    });
    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi physical RPC frame must have a string type"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
  });

  it("rejects frames containing invalid UTF-8", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    stdout.write(
      Buffer.concat([
        Buffer.from('{"type":"notice","message":"', "utf8"),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}\n', "utf8")
      ])
    );

    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC frame is not valid UTF-8"
    });
  });

  it("measures physical frames before removing the JSONL delimiter", async () => {
    const { queue, stdout } = await createQueueHarness({
      limits: { maxFrameBytes: 1024, maxReassembledBytes: 8192 }
    });
    // The JSON alone fits the physical limit; the trailing spaces push the
    // wire frame over it.
    const frame = JSON.stringify({ message: "x".repeat(980), type: "notice" });
    stdout.write(`${frame}${" ".repeat(20)}\n`);
    stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);

    expect(await queue.next()).toMatchObject({
      kind: "malformed",
      message: "Oh My Pi RPC frame exceeds the physical frame limit"
    });
    expect(await queue.next()).toMatchObject({ kind: "message" });
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

  it("reports a protocol failure when OMP exits before a terminal agent_end", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-premature-exit-omp.mjs");
    await writeFakePrematureExitOmp(fakeOmpPath);
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

    const types = events.map((event) => event.normalized?.type);
    expect(
      events
        .map((event) => event.normalized)
        .find((event) => event?.type === "turn_failed")
    ).toMatchObject({
      message: "Oh My Pi provider exited before a terminal agent_end",
      type: "turn_failed"
    });
    expect(events.at(-1)?.normalized).toMatchObject({
      exitCode: 0,
      type: "process_exit"
    });
    expect(types.indexOf("turn_failed")).toBeLessThan(
      types.indexOf("process_exit")
    );
  });

  it("reports malformed events for non-object frames mid-run", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const fakeOmpPath = path.join(root, "fake-scalar-frame-omp.mjs");
    await writeFile(
      fakeOmpPath,
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
        "    process.stdout.write('[]\\n');",
        "    send({ type: 'agent_end', isTerminal: true, messages: [] });",
        "    process.stdout.write('', () => process.exit(0));",
        "  }",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
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
      message: "Oh My Pi physical RPC frame must be an object",
      type: "malformed_event"
    });
  });

  it("escalates shutdown when OMP hangs after a terminal agent_end", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const pidPath = path.join(root, "hang.pid");
    const fakeOmpPath = path.join(root, "fake-terminal-hang-omp.mjs");
    await writeFile(
      fakeOmpPath,
      [
        "import { writeFileSync } from 'node:fs';",
        "import readline from 'node:readline';",
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "const rl = readline.createInterface({ input: process.stdin });",
        "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
        "send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });",
        "for await (const line of rl) {",
        "  const command = JSON.parse(line);",
        "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
        "  if (command.type === 'prompt') {",
        "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
        "    send({ type: 'agent_end', isTerminal: true, messages: [] });",
        "  }",
        "}",
        "// Hang after the terminal frame instead of exiting on stdin EOF.",
        "setInterval(() => {}, 1000);",
        ""
      ].join("\n"),
      "utf8"
    );
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

    const types = events.map((event) => event.normalized?.type);
    expect(types).not.toContain("turn_failed");
    expect(events.at(-1)?.normalized).toMatchObject({
      signal: "SIGTERM",
      type: "process_exit"
    });
    await waitForProcessExit(Number(await waitForFileContent(pidPath)));
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

  it("skips the abort write when cancellation arrives after stdin closed", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "terminal-requests.jsonl");
    const fakeOmpPath = path.join(root, "fake-terminal-omp.mjs");
    await writeFakeTerminalOmp(fakeOmpPath, transcriptPath);
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
    // The provider's endStdin has reached the child, so the abort write
    // would target an ended stream.
    await waitForTranscriptCommand(transcriptPath, "stdin-ended");
    await provider.cancel(input.run.id);
    const events = await collecting;

    expect(
      readJsonl(await readFile(transcriptPath, "utf8")).some(
        (command) => objectField(command, "type") === "abort"
      )
    ).toBe(false);
    expect(events.at(-1)?.normalized).toMatchObject({
      cancelled: true,
      type: "process_exit"
    });
  });

  it("cancels a run before the ready frame arrives", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const pidPath = path.join(root, "silent.pid");
    const fakeOmpPath = path.join(root, "fake-silent-omp.mjs");
    await writeFile(
      fakeOmpPath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
        ""
      ].join("\n"),
      "utf8"
    );
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
    const pid = Number(await waitForFileContent(pidPath));
    await provider.cancel(input.run.id);
    const events = await collecting;

    expect(events.at(-1)?.normalized).toMatchObject({
      cancelled: true,
      type: "process_exit"
    });
    await waitForProcessExit(pid);
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

  it("caps the stderr retained by the validation probe", async () => {
    const root = await makeTempRoot();
    const spewPath = path.join(root, "stderr-spew.mjs");
    await writeFile(
      spewPath,
      "process.stderr.write('x'.repeat(100000), () => process.exit(3));\n",
      "utf8"
    );
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const failure = await provider
      .validate(`${process.execPath} ${spewPath} --mode rpc --auto-approve`)
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("exited before ready with code 3");
    expect(message.endsWith("x".repeat(100))).toBe(true);
    expect(message.length).toBeLessThan(8400);
  });

  it("escalates an unresponsive validation probe to SIGKILL", async () => {
    const root = await makeTempRoot();
    const pidPath = path.join(root, "probe.pid");
    const immunePath = path.join(root, "sigterm-immune.mjs");
    await writeFile(
      immunePath,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
        ""
      ].join("\n"),
      "utf8"
    );
    const provider = createOmpProvider({ processScope: noopProcessScope() });

    const previousTimeout = process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS;
    const previousKillGrace = process.env.SYMPHONIKA_OMP_KILL_GRACE_MS;
    // Generous enough for slow CI runners to boot the child before the
    // timeout fires; the SIGTERM-immune fixture then survives until SIGKILL.
    process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS = "200";
    process.env.SYMPHONIKA_OMP_KILL_GRACE_MS = "25";
    let pid: number | undefined;
    try {
      await expect(
        provider.validate(
          `${process.execPath} ${immunePath} --mode rpc --auto-approve`
        )
      ).rejects.toThrow("validation timed out");
      pid = Number(await waitForFileContent(pidPath));
      await waitForProcessExit(pid);
    } finally {
      if (pid !== undefined && Number.isSafeInteger(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The probe already cleaned the process up.
        }
      }
      if (previousTimeout === undefined) {
        delete process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS;
      } else {
        process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS = previousTimeout;
      }
      if (previousKillGrace === undefined) {
        delete process.env.SYMPHONIKA_OMP_KILL_GRACE_MS;
      } else {
        process.env.SYMPHONIKA_OMP_KILL_GRACE_MS = previousKillGrace;
      }
    }
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

type QueueHarness = {
  close: (exitCode?: number | null, signal?: NodeJS.Signals | null) => void;
  queue: ProcessQueue;
  stdin: PassThrough;
  stdout: PassThrough;
};

async function createQueueHarness(options: {
  emitReady?: boolean;
  limits?: {
    maxFrameBytes: number;
    maxReassembledBytes: number;
  };
  protocolV2?: boolean;
  queueOptions?: {
    maxPendingFrameBytes?: number;
    maxPendingItems?: number;
  };
}): Promise<QueueHarness> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handlers: {
    close?:
      | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    error?: ((error: Error) => void) | undefined;
  } = {};
  const child = {
    stdin,
    stdout,
    stderr: new PassThrough(),
    once: (event: string, handler: unknown) => {
      if (event === "close") {
        handlers.close = handler as typeof handlers.close;
      } else if (event === "error") {
        handlers.error = handler as typeof handlers.error;
      }
      return child;
    }
  } as unknown as ChildProcessWithoutNullStreams;
  const queue = createProcessQueue(child, options.queueOptions);
  if (options.limits !== undefined) {
    queue.setFrameLimits(
      options.limits.maxFrameBytes,
      options.limits.maxReassembledBytes
    );
  }
  if (options.protocolV2 !== false) {
    queue.setProtocolVersion(2);
  }
  // Production queues begin with a ready frame; drain it here unless the
  // test drives pre-ready behavior itself.
  if (options.emitReady !== false) {
    stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
    await queue.next();
  }
  const close = (
    exitCode: number | null = 0,
    signal: NodeJS.Signals | null = null
  ): void => {
    handlers.close?.(exitCode, signal);
  };
  return { close, queue, stdin, stdout };
}

function rpcChunkLines(payload: string, chunkId: string): [string, string] {
  const payloadBytes = Buffer.from(payload, "utf8");
  const half = Math.ceil(payloadBytes.byteLength / 2);
  return [0, 1].map((index) =>
    JSON.stringify({
      byteLength: payloadBytes.byteLength,
      chunkId,
      count: 2,
      data: payloadBytes
        .subarray(index * half, (index + 1) * half)
        .toString("base64"),
      index,
      type: "rpc_chunk"
    })
  ) as [string, string];
}

async function writeFakeEchoOmp(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  if (typeof command.write === 'string') process.stdout.write(command.write);",
      "  if (command.newline === true) process.stdout.write('\\n');",
      "  if (command.exit === true) process.stdout.write('', () => process.exit(0));",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeUnterminatedFrameOmp(filePath: string): Promise<void> {
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
      "    process.stdout.write('a'.repeat(600));",
      "    process.stdout.write('b'.repeat(600));",
      "    process.stdout.write('c'.repeat(600));",
      "    process.stdout.write('\\n');",
      "    process.stdout.write(`${JSON.stringify({ type: 'agent_end', isTerminal: true, messages: [] })}\\n`, () => process.exit(0));",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeFakeMultibyteOverflowOmp(filePath: string): Promise<void> {
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
      "    process.stdout.write('é'.repeat(600));",
      "    process.stdout.write('\\n');",
      "    process.stdout.write('é'.repeat(5000));",
      "    process.stdout.write('\\n');",
      "    process.stdout.write(`${JSON.stringify({ type: 'agent_end', isTerminal: true, messages: [] })}\\n`, () => process.exit(0));",
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

async function writeFakePrematureExitOmp(filePath: string): Promise<void> {
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
      "    process.stdout.write('', () => process.exit(0));",
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

async function writeFakeTerminalOmp(
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
      "process.stdin.on('end', () => { void record({ type: 'stdin-ended' }); });",
      "// Keep the event loop alive after stdin closes; the provider kills us.",
      "setInterval(() => {}, 1000);",
      "for await (const line of rl) {",
      "  const command = JSON.parse(line);",
      "  await record(command);",
      "  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'omp-session-335', model: { provider: 'openai', id: 'gpt-5.4' } } });",
      "  if (command.type === 'prompt') {",
      "    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } });",
      "    send({ type: 'agent_end', isTerminal: true, messages: [] });",
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

async function waitForFileContent(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      // The child process has not created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for file ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
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
