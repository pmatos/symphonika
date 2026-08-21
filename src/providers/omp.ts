import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";

import {
  createProcessScope,
  type ProcessScope
} from "../lifecycle/process-scope.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../provider.js";
import { renderProviderCommandTemplate } from "../provider-command-template.js";
import { parseProviderCommand, type ProviderLabel } from "./command-parse.js";
import {
  providerProcessExitResult,
  shutdownProviderProcess,
  spawnProviderProcess
} from "./provider-process.js";

type JsonObject = Record<string, unknown>;

const PROVIDER_LABEL: ProviderLabel = "Oh My Pi";

type ActiveOmpRun = {
  assistantText?: string;
  cancelled: boolean;
  child?: ChildProcessWithoutNullStreams;
  completedAssistantText?: string;
  nextRequestId: number;
  promptDispatched: boolean;
  queue?: ProcessQueue;
  terminalEventSeen: boolean;
  sessionId: string | undefined;
};

type ProcessQueueItem =
  | {
      kind: "exit";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      error: Error;
      kind: "error";
    }
  | {
      kind: "malformed";
      line: string;
      message: string;
    }
  | {
      kind: "message";
      promptDispatched: boolean;
      raw: unknown;
    };

export type ProcessQueue = {
  discardBeforeFrameLimits: () => void;
  next: () => Promise<ProcessQueueItem>;
  setFrameLimits: (maxFrameBytes: number, maxReassembledBytes: number) => void;
  setProtocolVersion: (version: 1 | 2) => void;
  readonly size: number;
};

type PendingRpcChunks = {
  buffer: Buffer;
  byteLength: number;
  chunkId: string;
  count: number;
  nextIndex: number;
  receivedBytes: number;
};

type ResponseReadResult = {
  response?: unknown;
  stopped: boolean;
};

export type OmpProviderOptions = {
  processScope?: ProcessScope;
};

export function createOmpProvider(
  options: OmpProviderOptions = {}
): AgentProvider {
  const processScope = options.processScope ?? createProcessScope();
  const activeRuns = new Map<string, ActiveOmpRun>();

  return {
    cancel: (runId) => {
      const activeRun = activeRuns.get(runId);
      if (activeRun === undefined) {
        return Promise.resolve();
      }

      activeRun.cancelled = true;
      if (activeRun.child === undefined) {
        return Promise.resolve();
      }

      activeRun.queue?.discardBeforeFrameLimits();
      const child = activeRun.child;
      return shutdownProviderProcess(
        child,
        () => {
          if (!child.stdin.destroyed && child.stdin.writable) {
            writeJson(child, {
              id: requestId(activeRun),
              type: "abort"
            });
          }
        },
        "cancellation"
      );
    },
    name: "omp",
    runAttempt: async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      const activeRun: ActiveOmpRun = {
        cancelled: false,
        nextRequestId: 1,
        promptDispatched: false,
        sessionId: undefined,
        terminalEventSeen: false
      };
      activeRuns.set(input.run.id, activeRun);

      const renderedCommand = renderProviderCommandTemplate(
        input.provider.command,
        input.routine ?? {}
      ).rendered;
      const command = await processScope.wrapForProviderScope(
        input.run,
        parseProviderCommand(renderedCommand, PROVIDER_LABEL)
      );
      if (activeRun.cancelled) {
        activeRuns.delete(input.run.id);
        await processScope.stopProviderScope(input.run);
        yield processExitEvent(activeRun, null, null);
        return;
      }

      const child = spawnProviderProcess(command, input.workspacePath);
      activeRun.child = child;
      child.stderr.resume();
      const queue = createProcessQueue(child, {
        isPromptDispatched: () => activeRun.promptDispatched
      });
      activeRun.queue = queue;

      try {
        const ready = yield* readUntilFrame(
          queue,
          activeRun,
          (raw) => stringField(raw, "type") === "ready"
        );
        if (ready.stopped) {
          return;
        }
        if (ready.response === undefined) {
          queue.discardBeforeFrameLimits();
          await shutdownProviderProcess(child);
          yield* drainUntilExit(queue, activeRun);
          return;
        }
        try {
          validateReadyFrame(ready.response);
          queue.setFrameLimits(
            numberField(ready.response, "maxFrameBytes") ?? 0,
            numberField(ready.response, "maxReassembledFrameBytes") ?? 0
          );
        } catch {
          yield {
            normalized: {
              message: "Oh My Pi provider emitted an incompatible ready frame",
              type: "turn_failed"
            },
            raw: ready.response
          };
          queue.discardBeforeFrameLimits();
          await shutdownProviderProcess(child);
          yield* drainUntilExit(queue, activeRun);
          return;
        }

        if (
          arrayField(ready.response, "supportedProtocolVersions").includes(2)
        ) {
          const id = requestId(activeRun);
          writeJson(child, {
            id,
            protocolVersion: 2,
            type: "negotiate_protocol"
          });
          const negotiated = yield* readUntilResponse(
            queue,
            id,
            activeRun,
            mapNegotiationResponse
          );
          if (negotiated.stopped) {
            return;
          }
          if (!negotiatedV2Response(negotiated.response)) {
            await shutdownProviderProcess(child);
            yield* drainUntilExit(queue, activeRun);
            return;
          }
          queue.setProtocolVersion(2);
        }

        const stateId = requestId(activeRun);
        writeJson(child, { id: stateId, type: "get_state" });
        const state = yield* readUntilResponse(
          queue,
          stateId,
          activeRun,
          (raw) => mapStateResponse(raw, activeRun)
        );
        if (state.stopped) {
          return;
        }
        if (!successfulResponse(state.response)) {
          await shutdownProviderProcess(child);
          yield* drainUntilExit(queue, activeRun);
          return;
        }

        const promptId = requestId(activeRun);
        activeRun.promptDispatched = true;
        writeJson(child, {
          id: promptId,
          message: input.prompt,
          type: "prompt"
        });
        const prompt = yield* readUntilResponse(
          queue,
          promptId,
          activeRun,
          mapPromptResponse
        );
        if (prompt.stopped) {
          return;
        }
        if (!agentInvokedResponse(prompt.response)) {
          await shutdownProviderProcess(child);
          yield* drainUntilExit(queue, activeRun);
          return;
        }

        while (true) {
          const item = await queue.next();
          const event = providerEventFromQueueItem(item, activeRun);
          const type = event.normalized?.type;

          if (type === "process_exit") {
            // The OMP lifecycle drains a session through a terminal
            // agent_end; a clean exit without one is a protocol failure,
            // not a successful turn. Cancellation and earlier terminal
            // failures are already classified.
            if (!activeRun.terminalEventSeen && !activeRun.cancelled) {
              yield {
                normalized: {
                  message:
                    "Oh My Pi provider exited before a terminal agent_end",
                  type: "turn_failed"
                },
                raw: { kind: "missing_terminal_agent_end" }
              };
            }
            yield event;
            return;
          }

          yield event;

          if (isTerminalAgentEnd(event.raw)) {
            await markTerminalAgentEnd(activeRun);
            if (terminalAgentEndBeforePrompt(item)) {
              yield terminalAgentEndBeforePromptEvent(event.raw);
              yield* drainUntilExit(queue, activeRun);
              return;
            }
          }

          if (isTerminalFailure(type)) {
            activeRun.terminalEventSeen = true;
            await shutdownProviderProcess(child);
          }
        }
      } finally {
        activeRuns.delete(input.run.id);
        await shutdownProviderProcess(child);
        await processScope.stopProviderScope(input.run);
      }
    },
    validate: async (command, values = {}) => {
      const rendered = renderProviderCommandTemplate(command, values).rendered;
      const parsed = parseProviderCommand(rendered, PROVIDER_LABEL);
      validateOmpProtocolFlags(parsed.args);
      await validateOmpRpcCommand(parsed);
    }
  };
}

function providerEventFromQueueItem(
  item: ProcessQueueItem,
  activeRun: ActiveOmpRun
): ProviderEvent {
  switch (item.kind) {
    case "error":
      return {
        normalized: {
          message: item.error.message,
          type: "turn_failed"
        },
        raw: {
          kind: "process_error",
          message: item.error.message
        }
      };
    case "exit":
      return processExitEvent(activeRun, item.exitCode, item.signal);
    case "malformed":
      return {
        normalized: {
          line: item.line,
          message: item.message,
          type: "malformed_event"
        },
        raw: {
          kind: "malformed_json",
          line: item.line,
          message: item.message
        }
      };
    case "message":
      return mapOmpFrame(item.raw, activeRun);
  }
}

function mapOmpFrame(raw: unknown, activeRun: ActiveOmpRun): ProviderEvent {
  const type = stringField(raw, "type");

  if (type === "extension_ui_request") {
    const method = stringField(raw, "method");
    if (
      method === "select" ||
      method === "confirm" ||
      method === "input" ||
      method === "editor" ||
      method === "open_url"
    ) {
      return {
        normalized: {
          instructions: stringField(raw, "instructions"),
          message: stringField(raw, "message"),
          method,
          requestId: stringField(raw, "id"),
          sessionId: activeRun.sessionId,
          title: stringField(raw, "title"),
          type: "input_required",
          url: stringField(raw, "url")
        },
        raw
      };
    }
  }

  if (type === "message_update") {
    const update = objectField(raw, "assistantMessageEvent");
    const updateType = stringField(update, "type");
    if (updateType === "text_delta" || updateType === "thinking_delta") {
      const delta = stringField(update, "delta") ?? "";
      if (updateType === "text_delta") {
        activeRun.assistantText = (activeRun.assistantText ?? "") + delta;
      }
      return {
        normalized: {
          message: delta,
          messageKind: updateType === "text_delta" ? "text" : "thinking",
          sessionId: activeRun.sessionId,
          type: "message"
        },
        raw
      };
    }
    if (updateType === "error") {
      const errorMessage = objectField(update, "error");
      return {
        normalized: {
          message:
            stringField(errorMessage, "errorMessage") ??
            "Oh My Pi assistant turn failed",
          type: "turn_failed"
        },
        raw
      };
    }
  }

  if (type === "notice" && stringField(raw, "level") === "error") {
    return {
      normalized: {
        message: stringField(raw, "message") ?? "Oh My Pi reported an error",
        type: "turn_failed"
      },
      raw
    };
  }

  if (type === "message_end") {
    const message = objectField(raw, "message");
    if (
      stringField(message, "role") === "assistant" &&
      activeRun.assistantText !== undefined
    ) {
      activeRun.completedAssistantText = activeRun.assistantText;
      delete activeRun.assistantText;
    }
    const usage = objectField(message, "usage");
    if (stringField(message, "role") === "assistant" && usage !== undefined) {
      return {
        normalized: {
          sessionId: activeRun.sessionId,
          tokenUsage: {
            cacheReadTokens: numberField(usage, "cacheRead"),
            cacheWriteTokens: numberField(usage, "cacheWrite"),
            inputTokens: numberField(usage, "input"),
            outputTokens: numberField(usage, "output"),
            totalTokens: numberField(usage, "totalTokens")
          },
          type: "usage_updated"
        },
        raw
      };
    }
  }

  if (type === "tool_execution_start") {
    return {
      normalized: {
        input: objectField(raw, "args"),
        sessionId: activeRun.sessionId,
        toolCallId: stringField(raw, "toolCallId"),
        toolName: stringField(raw, "toolName"),
        type: "tool_call"
      },
      raw
    };
  }

  if (type === "turn_end") {
    const result = activeRun.assistantText ?? activeRun.completedAssistantText;
    // OMP does not expose a stable turn id, and a session can emit more than
    // one turn_end before its terminal agent_end. Clearing the completed
    // text once consumed here stops a later, textless turn from reporting an
    // earlier turn's stale result.
    delete activeRun.completedAssistantText;
    return {
      normalized: {
        ...(result === undefined ? {} : { result }),
        sessionId: activeRun.sessionId,
        type: "turn_completed"
      },
      raw
    };
  }

  return { raw };
}

function mapStateResponse(
  raw: unknown,
  activeRun: ActiveOmpRun
): ProviderEvent {
  if (!successfulResponse(raw)) {
    return mapFailedResponse(raw);
  }

  const state = objectField(raw, "data");
  const sessionId = stringField(state, "sessionId");
  activeRun.sessionId = sessionId;
  const model = objectField(state, "model");
  const modelId = stringField(model, "id");
  const modelProvider = stringField(model, "provider");

  return {
    normalized: {
      model:
        modelProvider !== undefined && modelId !== undefined
          ? `${modelProvider}/${modelId}`
          : modelId,
      sessionFile: stringField(state, "sessionFile"),
      sessionId,
      type: "session_started"
    },
    raw
  };
}

function mapFailedResponse(raw: unknown): ProviderEvent {
  return {
    normalized: {
      command: stringField(raw, "command"),
      message: stringField(raw, "error") ?? "Oh My Pi RPC command failed",
      type: "turn_failed"
    },
    raw
  };
}

function mapPromptResponse(raw: unknown): ProviderEvent {
  if (!successfulResponse(raw)) {
    return mapFailedResponse(raw);
  }
  if (booleanField(objectField(raw, "data"), "agentInvoked") !== true) {
    return {
      normalized: {
        command: "prompt",
        message: "Oh My Pi did not invoke an agent for the prompt",
        type: "turn_failed"
      },
      raw
    };
  }
  return { raw };
}

function mapNegotiationResponse(raw: unknown): ProviderEvent {
  if (!successfulResponse(raw)) {
    return mapFailedResponse(raw);
  }
  if (numberField(objectField(raw, "data"), "protocolVersion") !== 2) {
    return {
      normalized: {
        command: "negotiate_protocol",
        message: "Oh My Pi did not confirm RPC protocol v2",
        type: "turn_failed"
      },
      raw
    };
  }
  return { raw };
}

async function* readUntilFrame(
  queue: ProcessQueue,
  activeRun: ActiveOmpRun,
  predicate: (raw: unknown) => boolean
): AsyncGenerator<ProviderEvent, ResponseReadResult> {
  while (true) {
    const item = await queue.next();
    const event = providerEventFromQueueItem(item, activeRun);
    if (event.normalized?.type === "process_exit") {
      // A clean exit while awaiting a required handshake frame is a
      // protocol failure, not a successful attempt (same lifecycle class
      // as exiting mid-turn without a terminal agent_end).
      if (!activeRun.cancelled && !activeRun.terminalEventSeen) {
        yield {
          normalized: {
            message: "Oh My Pi provider exited before a terminal agent_end",
            type: "turn_failed"
          },
          raw: { kind: "missing_terminal_agent_end" }
        };
      }
      yield event;
      return { stopped: true };
    }
    yield event;
    if (item.kind === "message" && isTerminalAgentEnd(item.raw)) {
      await markTerminalAgentEnd(activeRun);
      if (terminalAgentEndBeforePrompt(item)) {
        yield terminalAgentEndBeforePromptEvent(item.raw);
        yield* drainUntilExit(queue, activeRun);
        return { stopped: true };
      }
    }
    if (item.kind === "message" && predicate(item.raw)) {
      return { response: item.raw, stopped: false };
    }
    if (isTerminalFailure(event.normalized?.type)) {
      activeRun.terminalEventSeen = true;
      return { stopped: false };
    }
  }
}

async function* readUntilResponse(
  queue: ProcessQueue,
  id: string,
  activeRun: ActiveOmpRun,
  mapResponse: (raw: unknown, activeRun: ActiveOmpRun) => ProviderEvent = (
    raw
  ) => (successfulResponse(raw) ? { raw } : mapFailedResponse(raw))
): AsyncGenerator<ProviderEvent, ResponseReadResult> {
  while (true) {
    const item = await queue.next();
    const event =
      item.kind === "message" && stringField(item.raw, "id") === id
        ? mapResponse(item.raw, activeRun)
        : providerEventFromQueueItem(item, activeRun);
    if (event.normalized?.type === "process_exit") {
      if (!activeRun.cancelled && !activeRun.terminalEventSeen) {
        yield {
          normalized: {
            message: "Oh My Pi provider exited before a terminal agent_end",
            type: "turn_failed"
          },
          raw: { kind: "missing_terminal_agent_end" }
        };
      }
      yield event;
      return { stopped: true };
    }
    yield event;
    if (item.kind === "message" && isTerminalAgentEnd(item.raw)) {
      await markTerminalAgentEnd(activeRun);
      if (terminalAgentEndBeforePrompt(item)) {
        yield terminalAgentEndBeforePromptEvent(item.raw);
        yield* drainUntilExit(queue, activeRun);
        return { stopped: true };
      }
    }
    if (item.kind === "message" && stringField(item.raw, "id") === id) {
      return { response: item.raw, stopped: false };
    }
    if (isTerminalFailure(event.normalized?.type)) {
      activeRun.terminalEventSeen = true;
      return { stopped: false };
    }
  }
}

async function* drainUntilExit(
  queue: ProcessQueue,
  activeRun: ActiveOmpRun
): AsyncGenerator<ProviderEvent> {
  while (true) {
    const event = providerEventFromQueueItem(await queue.next(), activeRun);
    yield event;
    if (event.normalized?.type === "process_exit") {
      return;
    }
  }
}

function successfulResponse(raw: unknown): boolean {
  return (
    stringField(raw, "type") === "response" &&
    booleanField(raw, "success") === true
  );
}

function agentInvokedResponse(raw: unknown): boolean {
  return (
    successfulResponse(raw) &&
    booleanField(objectField(raw, "data"), "agentInvoked") === true
  );
}

function negotiatedV2Response(raw: unknown): boolean {
  return (
    successfulResponse(raw) &&
    numberField(objectField(raw, "data"), "protocolVersion") === 2
  );
}

function requestId(activeRun: ActiveOmpRun): string {
  const id = `symphonika-${activeRun.nextRequestId}`;
  activeRun.nextRequestId += 1;
  return id;
}

function processExitEvent(
  activeRun: ActiveOmpRun,
  exitCode: number | null,
  signal: NodeJS.Signals | null
): ProviderEvent {
  return {
    normalized: {
      cancelled: activeRun.cancelled,
      exitCode,
      signal,
      type: "process_exit"
    },
    raw: {
      cancelled: activeRun.cancelled,
      exitCode,
      kind: "process_exit",
      signal
    }
  };
}

const MALFORMED_EVIDENCE_MAX_BYTES = 4096;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PROBE_STDERR_TAIL_BYTES = 8192;
const DEFAULT_MAX_PENDING_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_ITEMS = 4096;
const MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;

function boundedMalformedEvidence(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= MALFORMED_EVIDENCE_MAX_BYTES) {
    return line;
  }
  let byteLength = 0;
  let endIndex = 0;
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > MALFORMED_EVIDENCE_MAX_BYTES) {
      break;
    }
    byteLength += characterBytes;
    endIndex += character.length;
  }
  // Round-trip through a Buffer so the returned string is a fresh allocation
  // rather than a V8 sliced string that would retain the oversized parent.
  return Buffer.from(line.slice(0, endIndex), "utf8").toString("utf8");
}

export type ProcessQueueOptions = {
  isPromptDispatched?: () => boolean;
  maxPendingFrameBytes?: number;
  maxPendingItems?: number;
};

export function createProcessQueue(
  child: ChildProcessWithoutNullStreams,
  options: ProcessQueueOptions = {}
): ProcessQueue {
  if (
    (options.maxPendingFrameBytes !== undefined &&
      (!Number.isSafeInteger(options.maxPendingFrameBytes) ||
        options.maxPendingFrameBytes < 1)) ||
    (options.maxPendingItems !== undefined &&
      (!Number.isSafeInteger(options.maxPendingItems) ||
        options.maxPendingItems < 1))
  ) {
    throw new Error("invalid Oh My Pi RPC queue limits");
  }
  const maxPendingFrameBytes =
    options.maxPendingFrameBytes ?? DEFAULT_MAX_PENDING_FRAME_BYTES;
  const maxPendingItems = options.maxPendingItems ?? DEFAULT_MAX_PENDING_ITEMS;
  const resumePendingFrameBytes = Math.floor(maxPendingFrameBytes / 2);
  const resumePendingItems = Math.floor(maxPendingItems / 2);
  const pending: Array<{ byteSize: number; item: ProcessQueueItem }> = [];
  let pendingFrameBytes = 0;
  const frameDecoder = new RpcChunkDecoder();
  let waiting: ((item: ProcessQueueItem) => void) | undefined;
  let stdoutBuffer = Buffer.alloc(0);
  let stdoutOverflowed = false;
  let frameLimitsSet = false;
  let protocolVersion: 1 | 2 = 1;
  let readySeen = false;
  let awaitingFrameLimits = false;
  let stdoutEnded = false;
  let discardingOutput = false;
  let closeResult:
    { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let exitEnqueued = false;

  const push = (item: ProcessQueueItem, byteSize = 0): void => {
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      resolve(item);
      return;
    }
    pending.push({ byteSize, item });
    pendingFrameBytes += byteSize;
  };
  const pushParsedLine = (line: Buffer): void => {
    const lineBytes = line.byteLength;
    if (lineBytes > frameDecoder.maxFrameBytes) {
      frameDecoder.interrupt();
      const evidence = boundedMalformedEvidence(line.toString("utf8"));
      push(
        {
          kind: "malformed",
          line: evidence,
          message: "Oh My Pi RPC frame exceeds the physical frame limit"
        },
        Buffer.byteLength(evidence, "utf8")
      );
      return;
    }
    // Decode fatally: setEncoding("utf8") would silently substitute U+FFFD
    // for invalid wire bytes and let fabricated text parse as a valid frame.
    let text: string;
    try {
      text = FATAL_UTF8_DECODER.decode(line);
    } catch {
      frameDecoder.interrupt();
      const evidence = boundedMalformedEvidence(line.toString("utf8"));
      push(
        {
          kind: "malformed",
          line: evidence,
          message: "Oh My Pi RPC frame is not valid UTF-8"
        },
        Buffer.byteLength(evidence, "utf8")
      );
      return;
    }
    if (text.trim().length === 0) {
      // Blank lines are noise-tolerated JSONL, but between chunks they are
      // an interruption like any other non-chunk frame.
      if (frameDecoder.interrupt()) {
        push(
          {
            kind: "malformed",
            line: text,
            message:
              "Oh My Pi RPC chunk sequence interrupted by a non-chunk frame"
          },
          lineBytes
        );
      }
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      frameDecoder.interrupt();
      push(
        {
          kind: "malformed",
          line: text,
          message: error instanceof Error ? error.message : String(error)
        },
        lineBytes
      );
      return;
    }
    // Every protocol frame is a JSON object with a type field (ADR 0066);
    // arrays, null, and scalars are not valid frames.
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      frameDecoder.interrupt();
      push(
        {
          kind: "malformed",
          line: text,
          message: "Oh My Pi physical RPC frame must be an object"
        },
        lineBytes
      );
      return;
    }
    const frameType = stringField(raw, "type");
    if (frameType === undefined) {
      frameDecoder.interrupt();
      push(
        {
          kind: "malformed",
          line: text,
          message: "Oh My Pi physical RPC frame must have a string type"
        },
        lineBytes
      );
      return;
    }

    push(
      {
        kind: "message",
        promptDispatched: options.isPromptDispatched?.() === true,
        raw
      },
      lineBytes
    );
    // The protocol begins with the versioned ready frame (ADR 0066); any
    // other first nonblank frame is malformed, not evidence to scan past.
    if (!readySeen && frameType !== "ready") {
      frameDecoder.interrupt();
      push(
        {
          kind: "malformed",
          line: text,
          message: "Oh My Pi RPC protocol must begin with a ready frame"
        },
        lineBytes
      );
      return;
    }
    if (frameType === "ready") {
      readySeen = true;
    }
    // Pause draining after the pre-limit ready frame so later frames are
    // measured against the negotiated limits once setFrameLimits installs
    // them, not against the 1 MiB default. Pausing stdout also stops an
    // invalid ready from streaming into the deferred buffer during the
    // shutdown grace period.
    if (frameType === "ready" && !frameLimitsSet) {
      awaitingFrameLimits = true;
      child.stdout.pause();
    }
    if (frameType !== "rpc_chunk") {
      if (frameDecoder.interrupt()) {
        push(
          {
            kind: "malformed",
            line: text,
            message:
              "Oh My Pi RPC chunk sequence interrupted by a non-chunk frame"
          },
          lineBytes
        );
      }
      return;
    }

    // rpc_chunk exists only under protocol v2 (ADR 0066); a chunk received
    // before a successful negotiate_protocol response is malformed.
    if (protocolVersion !== 2) {
      frameDecoder.interrupt();
      push(
        {
          kind: "malformed",
          line: text,
          message: "Oh My Pi RPC chunk received before protocol v2 negotiation"
        },
        lineBytes
      );
      return;
    }

    try {
      const logical = frameDecoder.push(raw);
      if (logical !== undefined) {
        push(
          {
            kind: "message",
            promptDispatched: options.isPromptDispatched?.() === true,
            raw: logical.frame
          },
          logical.byteLength
        );
      }
    } catch (error) {
      push(
        {
          kind: "malformed",
          line: text,
          message: error instanceof Error ? error.message : String(error)
        },
        lineBytes
      );
    }
  };

  const enforceStdoutBound = (): void => {
    if (stdoutOverflowed) {
      return;
    }
    // Only the unterminated suffix after the last newline is a physical
    // frame in progress; complete queued lines ahead of it are preserved
    // for later draining, not measured here.
    const suffixStart = stdoutBuffer.lastIndexOf(0x0a) + 1;
    const suffix = stdoutBuffer.subarray(suffixStart);
    if (suffix.byteLength <= frameDecoder.maxFrameBytes) {
      return;
    }
    stdoutOverflowed = true;
    stdoutBuffer = stdoutBuffer.subarray(0, suffixStart);
    frameDecoder.interrupt();
    const evidence = boundedMalformedEvidence(suffix.toString("utf8"));
    push(
      {
        kind: "malformed",
        line: evidence,
        message: "Oh My Pi RPC frame exceeds the physical frame limit"
      },
      Buffer.byteLength(evidence, "utf8")
    );
  };

  const drainStdoutLines = (): void => {
    let newlineIndex = stdoutBuffer.indexOf(0x0a);
    while (!awaitingFrameLimits && newlineIndex >= 0) {
      // Stop before the backlog crosses either high-water mark so a single
      // data callback cannot burst-enqueue past it; the remainder stays
      // buffered until the consumer drains below the low-water marks.
      if (
        pendingFrameBytes >= maxPendingFrameBytes ||
        pending.length >= maxPendingItems
      ) {
        child.stdout.pause();
        return;
      }
      const line = stdoutBuffer.subarray(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
      pushParsedLine(line);
      newlineIndex = stdoutBuffer.indexOf(0x0a);
    }
    // Pause even when the remainder has no newline: with the queue full,
    // further chunks would grow the unterminated tail while enforcement is
    // deferred to the consumer.
    if (
      pendingFrameBytes >= maxPendingFrameBytes ||
      pending.length >= maxPendingItems
    ) {
      child.stdout.pause();
    }
  };

  const finishStdout = (): void => {
    if (!stdoutEnded || awaitingFrameLimits || exitEnqueued) {
      return;
    }
    drainStdoutLines();
    // Backpressured even at EOF: leave the buffered backlog intact; next()
    // re-enters finishStdout as the consumer drains below the low-water
    // marks until the finish completes.
    if (
      pendingFrameBytes >= maxPendingFrameBytes ||
      pending.length >= maxPendingItems
    ) {
      return;
    }
    if (stdoutBuffer.length > 0) {
      pushParsedLine(stdoutBuffer);
      stdoutBuffer = Buffer.alloc(0);
    }
    if (frameDecoder.interrupt()) {
      push({
        kind: "malformed",
        line: "",
        message: "Oh My Pi RPC chunk sequence incomplete at end of stream"
      });
    }
    // The exit event goes last: evidence buffered before the close must be
    // consumed before runAttempt can see process_exit.
    if (closeResult !== undefined) {
      exitEnqueued = true;
      push({
        exitCode: closeResult.exitCode,
        kind: "exit",
        signal: closeResult.signal
      });
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (discardingOutput) {
      return;
    }
    let data = chunk;
    if (stdoutOverflowed) {
      const frameEndIndex = data.indexOf(0x0a);
      if (frameEndIndex < 0) {
        return;
      }
      stdoutOverflowed = false;
      data = data.subarray(frameEndIndex + 1);
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, data]);
    drainStdoutLines();
    // While paused for the ready frame's advertised limits, defer the bound
    // check too: enforcing the old default here could reject frames that fit
    // a larger negotiated limit. setFrameLimits runs in the microtask after
    // the ready callback and re-checks everything deferred.
    if (!awaitingFrameLimits) {
      enforceStdoutBound();
    }
  });
  child.stdout.on("end", () => {
    stdoutEnded = true;
    finishStdout();
  });
  child.stdin.on("error", (error: Error) => {
    push({ error, kind: "error" });
  });
  child.once("error", (error) => {
    push({ error, kind: "error" });
  });
  child.once("close", (exitCode, signal) => {
    closeResult = providerProcessExitResult(child, exitCode, signal);
    // A destroyed stdout never emits 'end'; treat close as terminal either way.
    stdoutEnded = true;
    finishStdout();
  });

  return {
    discardBeforeFrameLimits: () => {
      // Pre-limit failure teardown (e.g. an invalid ready): drop the
      // deferred output without parsing it, resume the latch-paused stream
      // so close is not delayed, and let a stored exit enqueue. No-ops once
      // limits are installed: post-negotiation output is real evidence.
      if (discardingOutput || frameLimitsSet) {
        return;
      }
      awaitingFrameLimits = false;
      discardingOutput = true;
      stdoutBuffer = Buffer.alloc(0);
      frameDecoder.interrupt();
      child.stdout.resume();
      if (closeResult !== undefined && !exitEnqueued) {
        exitEnqueued = true;
        push({
          exitCode: closeResult.exitCode,
          kind: "exit",
          signal: closeResult.signal
        });
      }
    },
    get size() {
      return pending.length;
    },
    next: () => {
      const entry = pending.shift();
      if (entry !== undefined) {
        pendingFrameBytes -= entry.byteSize;
        if (
          pendingFrameBytes <= resumePendingFrameBytes &&
          pending.length <= resumePendingItems
        ) {
          if (stdoutEnded) {
            finishStdout();
          } else {
            drainStdoutLines();
          }
          // The ready latch owns its own pause: only setFrameLimits may
          // resume it, once negotiated limits are installed.
          if (
            !awaitingFrameLimits &&
            pendingFrameBytes < maxPendingFrameBytes &&
            pending.length < maxPendingItems
          ) {
            child.stdout.resume();
          }
        }
        return Promise.resolve(entry.item);
      }
      return new Promise<ProcessQueueItem>((resolve) => {
        waiting = resolve;
      });
    },
    setProtocolVersion: (version) => {
      protocolVersion = version;
    },
    setFrameLimits: (maxFrameBytes, maxReassembledBytes) => {
      frameDecoder.setLimits(maxFrameBytes, maxReassembledBytes);
      frameLimitsSet = true;
      awaitingFrameLimits = false;
      drainStdoutLines();
      if (stdoutEnded) {
        finishStdout();
      } else {
        enforceStdoutBound();
      }
      if (
        pendingFrameBytes < maxPendingFrameBytes &&
        pending.length < maxPendingItems
      ) {
        child.stdout.resume();
      }
    }
  };
}

export class RpcChunkDecoder {
  private maxFrameBytesValue = 1024 * 1024;
  private maxReassembledBytes = MAX_REASSEMBLED_FRAME_BYTES;
  private pending: PendingRpcChunks | undefined = undefined;

  get pendingBufferBytes(): number {
    return this.pending === undefined ? 0 : this.pending.buffer.byteLength;
  }

  get maxFrameBytes(): number {
    return this.maxFrameBytesValue;
  }

  setLimits(maxFrameBytes: number, maxReassembledBytes: number): void {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      !Number.isSafeInteger(maxReassembledBytes) ||
      maxFrameBytes < 1 ||
      maxReassembledBytes < maxFrameBytes
    ) {
      throw new Error("invalid Oh My Pi RPC frame limits");
    }
    this.maxFrameBytesValue = maxFrameBytes;
    this.maxReassembledBytes = Math.min(
      maxReassembledBytes,
      MAX_REASSEMBLED_FRAME_BYTES
    );
  }

  interrupt(): boolean {
    if (this.pending === undefined) {
      return false;
    }
    this.pending = undefined;
    return true;
  }

  push(raw: unknown): { byteLength: number; frame: unknown } | undefined {
    const chunkId = stringField(raw, "chunkId");
    const index = numberField(raw, "index");
    const count = numberField(raw, "count");
    const byteLength = numberField(raw, "byteLength");
    const data = stringField(raw, "data");
    // Any chunk-validation failure kills the pending sequence: a later chunk
    // must not complete a sequence that already produced a malformed event.
    try {
      if (
        chunkId === undefined ||
        chunkId.length === 0 ||
        chunkId.length > 128 ||
        index === undefined ||
        count === undefined ||
        byteLength === undefined ||
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(byteLength) ||
        index < 0 ||
        count < 2 ||
        index >= count ||
        byteLength < this.maxFrameBytesValue ||
        byteLength > this.maxReassembledBytes ||
        data === undefined
      ) {
        throw new Error("invalid Oh My Pi RPC chunk metadata");
      }

      const bytes = decodeBase64(data);
      if (bytes.byteLength > this.maxFrameBytesValue) {
        throw new Error("Oh My Pi RPC chunk exceeds the physical frame limit");
      }

      if (this.pending === undefined) {
        if (index !== 0) {
          throw new Error("Oh My Pi RPC chunk sequence must start at index 0");
        }
        // Reassemble into one contiguous buffer whose capacity tracks bytes
        // actually received (geometric growth, capped by the declared
        // length): retaining a Buffer per chunk pins millions of tiny
        // allocations, while preallocating the declared length lets a tiny
        // chunk with a max declaration amplify allocations through
        // declare-interrupt cycles.
        this.pending = {
          buffer: Buffer.alloc(bytes.byteLength),
          byteLength,
          chunkId,
          count,
          nextIndex: 0,
          receivedBytes: 0
        };
      }
      const pending = this.pending;
      if (
        pending.chunkId !== chunkId ||
        pending.count !== count ||
        pending.byteLength !== byteLength ||
        pending.nextIndex !== index
      ) {
        throw new Error("Oh My Pi RPC chunk sequence mismatch");
      }

      if (pending.receivedBytes + bytes.byteLength > pending.byteLength) {
        throw new Error("Oh My Pi RPC chunks exceed their declared length");
      }
      const needed = pending.receivedBytes + bytes.byteLength;
      if (needed > pending.buffer.byteLength) {
        const grown = Buffer.alloc(
          Math.min(
            Math.max(needed, pending.buffer.byteLength * 2),
            pending.byteLength
          )
        );
        pending.buffer.copy(grown, 0, 0, pending.receivedBytes);
        pending.buffer = grown;
      }
      pending.buffer.set(bytes, pending.receivedBytes);
      pending.receivedBytes += bytes.byteLength;
      pending.nextIndex += 1;
      if (pending.nextIndex < pending.count) {
        return undefined;
      }
      if (pending.receivedBytes !== pending.byteLength) {
        throw new Error("Oh My Pi RPC chunk sequence length mismatch");
      }

      this.pending = undefined;
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        pending.buffer.subarray(0, pending.receivedBytes)
      );
      const logicalFrame = JSON.parse(decoded) as unknown;
      if (
        typeof logicalFrame !== "object" ||
        logicalFrame === null ||
        Array.isArray(logicalFrame)
      ) {
        throw new Error("Oh My Pi logical RPC frame must be an object");
      }
      if (stringField(logicalFrame, "type") === undefined) {
        throw new Error("Oh My Pi logical RPC frame must have a string type");
      }
      return { byteLength: pending.byteLength, frame: logicalFrame };
    } catch (error) {
      this.pending = undefined;
      throw error;
    }
  }
}

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error("invalid Oh My Pi RPC chunk data");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("invalid Oh My Pi RPC chunk data");
  }
  return decoded;
}

function validateOmpProtocolFlags(args: string[]): void {
  const modeValues = optionValues(args, "--mode");
  if (modeValues.length === 0) {
    throw new Error("Oh My Pi provider command must include --mode rpc");
  }
  if (modeValues.length !== 1 || modeValues[0] !== "rpc") {
    throw new Error(
      "Oh My Pi provider command must select exactly one --mode rpc"
    );
  }
  if (args.includes("-p") || args.includes("--print")) {
    throw new Error("Oh My Pi provider command must not use print mode");
  }
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === option) {
      values.push(args[index + 1] ?? "");
      index += 1;
    } else if (arg?.startsWith(`${option}=`) === true) {
      values.push(arg.slice(option.length + 1));
    }
  }
  return values;
}

async function validateOmpRpcCommand(command: {
  args: string[];
  executable: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const queue = createProcessQueue(child);
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    child.stderr.on("data", (chunk: Buffer) => {
      const combined = Buffer.concat([stderrTail, chunk]);
      // Copy on truncation so the retained tail never shares the larger
      // combined backing store.
      stderrTail =
        combined.byteLength > PROBE_STDERR_TAIL_BYTES
          ? Buffer.from(
              combined.subarray(combined.byteLength - PROBE_STDERR_TAIL_BYTES)
            )
          : combined;
    });

    const timer = setTimeout(() => {
      settle(() => {
        shutdownProbeProcess(child);
        reject(new Error("Oh My Pi provider command validation timed out"));
      });
    }, ompProbeTimeoutMs());

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    void (async () => {
      while (true) {
        const item = await queue.next();
        if (item.kind === "error") {
          settle(() => {
            reject(
              new Error(
                `Oh My Pi provider command executable not available: ${command.executable}: ${item.error.message}`
              )
            );
          });
          return;
        }
        if (item.kind === "malformed") {
          settle(() => {
            shutdownProbeProcess(child);
            reject(
              new Error(
                `Oh My Pi provider command emitted malformed JSON before ready: ${item.message}`
              )
            );
          });
          return;
        }
        if (item.kind === "exit") {
          settle(() => {
            reject(
              new Error(
                `Oh My Pi provider command exited before ready with code ${item.exitCode ?? "unknown"}${stderrTail.toString("utf8").trim().length === 0 ? "" : `: ${stderrTail.toString("utf8").trim()}`}`
              )
            );
          });
          return;
        }
        if (stringField(item.raw, "type") !== "ready") {
          continue;
        }

        try {
          validateReadyFrame(item.raw);
          queue.setFrameLimits(
            numberField(item.raw, "maxFrameBytes") ?? 0,
            numberField(item.raw, "maxReassembledFrameBytes") ?? 0
          );
        } catch (error) {
          queue.discardBeforeFrameLimits();
          settle(() => {
            shutdownProbeProcess(child);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
          return;
        }
        endStdin(child);
        break;
      }

      while (true) {
        const item = await queue.next();
        if (item.kind === "exit") {
          settle(() => {
            if (item.exitCode === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `Oh My Pi provider command validation failed with exit code ${item.exitCode ?? "unknown"}${stderrTail.toString("utf8").trim().length === 0 ? "" : `: ${stderrTail.toString("utf8").trim()}`}`
                )
              );
            }
          });
          return;
        }
        if (item.kind === "error") {
          settle(() => {
            reject(
              new Error(
                `Oh My Pi provider command validation failed: ${item.error.message}`
              )
            );
          });
          return;
        }
      }
    })().catch((error: unknown) => {
      settle(() => {
        shutdownProbeProcess(child);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
}

function validateReadyFrame(raw: unknown): void {
  if (
    numberField(raw, "protocolVersion") !== 1 ||
    !arrayField(raw, "supportedProtocolVersions").includes(1) ||
    !Number.isSafeInteger(numberField(raw, "maxFrameBytes")) ||
    !Number.isSafeInteger(numberField(raw, "maxReassembledFrameBytes"))
  ) {
    throw new Error(
      "Oh My Pi provider command emitted an incompatible ready frame"
    );
  }
}

function ompProbeTimeoutMs(): number {
  const configured = Number(process.env.SYMPHONIKA_OMP_PROBE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 5_000;
}

function writeJson(
  child: ChildProcessWithoutNullStreams,
  value: JsonObject
): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function endStdin(child: ChildProcessWithoutNullStreams): void {
  if (!child.stdin.destroyed && child.stdin.writable) {
    child.stdin.end();
  }
}

function terminateProcess(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
}

function shutdownProbeProcess(child: ChildProcessWithoutNullStreams): void {
  endStdin(child);
  const timer = setTimeout(() => {
    terminateProcess(child);
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      // Release the pipes even if the child ignores SIGKILL (or a
      // grandchild inherited them), so 'close' fires and FDs are freed.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, ompKillGraceMs());
    killTimer.unref();
  }, 250);
  timer.unref();
}

function ompKillGraceMs(): number {
  const configured = Number(process.env.SYMPHONIKA_OMP_KILL_GRACE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 1_000;
}

function isTerminalFailure(type: string | undefined): boolean {
  return (
    type === "input_required" ||
    type === "malformed_event" ||
    type === "turn_failed"
  );
}

function isTerminalAgentEnd(raw: unknown): boolean {
  return (
    stringField(raw, "type") === "agent_end" &&
    booleanField(raw, "isTerminal") !== false
  );
}

function terminalAgentEndBeforePrompt(item: ProcessQueueItem): boolean {
  return (
    item.kind === "message" &&
    !item.promptDispatched &&
    isTerminalAgentEnd(item.raw)
  );
}

function terminalAgentEndBeforePromptEvent(raw: unknown): ProviderEvent {
  return {
    normalized: {
      message: "Oh My Pi provider emitted terminal agent_end before prompt",
      type: "turn_failed"
    },
    raw: {
      event: raw,
      kind: "terminal_agent_end_before_prompt"
    }
  };
}

async function markTerminalAgentEnd(activeRun: ActiveOmpRun): Promise<void> {
  activeRun.terminalEventSeen = true;
  if (activeRun.child !== undefined) {
    // Bound the child's exit even when the terminal frame arrives during a
    // handshake read: a host waiting for stdin EOF must not deadlock the
    // run, and a hung child gets the bounded SIGTERM→SIGKILL escalation.
    await shutdownProviderProcess(activeRun.child);
  }
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return value[key as keyof typeof value];
  }
  return undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
  const field = objectField(value, key);
  return Array.isArray(field) ? field : [];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = objectField(value, key);
  return typeof field === "number" ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const field = objectField(value, key);
  return typeof field === "boolean" ? field : undefined;
}
