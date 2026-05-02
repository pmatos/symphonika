import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";

import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../provider.js";
import { VERSION } from "../version.js";

type JsonObject = Record<string, unknown>;

type ActiveCodexRun = {
  cancelled: boolean;
  child: ChildProcessWithoutNullStreams;
  nextRequestId: number;
  threadId?: string;
  turnId?: string;
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
      raw: unknown;
    };

type ProcessQueue = {
  next: () => Promise<ProcessQueueItem>;
};

type ResponseReadResult = {
  events: ProviderEvent[];
  stopped: boolean;
};

export function createCodexProvider(): AgentProvider {
  const activeRuns = new Map<string, ActiveCodexRun>();

  return {
    cancel: (runId) => {
      const activeRun = activeRuns.get(runId);
      if (activeRun === undefined) {
        return Promise.resolve();
      }

      activeRun.cancelled = true;
      if (activeRun.threadId !== undefined && activeRun.turnId !== undefined) {
        writeJson(activeRun.child, {
          id: activeRun.nextRequestId,
          method: "turn/interrupt",
          params: {
            threadId: activeRun.threadId,
            turnId: activeRun.turnId
          }
        });
        activeRun.nextRequestId += 1;
      }
      shutdownProcess(activeRun.child);
      return Promise.resolve();
    },
    name: "codex",
    runAttempt: async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      const command = parseCommand(input.provider.command);
      const child = spawn(command.executable, command.args, {
        cwd: input.workspacePath,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const activeRun: ActiveCodexRun = {
        cancelled: false,
        child,
        nextRequestId: 4
      };
      activeRuns.set(input.run.id, activeRun);
      child.stderr.resume();
      const queue = createProcessQueue(child);

      try {
        writeJson(child, {
          id: 1,
          method: "initialize",
          params: {
            capabilities: {
              experimentalApi: true
            },
            clientInfo: {
              name: "symphonika",
              title: "Symphonika",
              version: VERSION
            }
          }
        });
        const initialized = await readUntilResponse(queue, 1, activeRun, (raw) => ({
          raw
        }));
        yield* initialized.events;
        if (initialized.stopped) {
          return;
        }

        writeJson(child, {
          method: "initialized"
        });
        writeJson(child, {
          id: 2,
          method: "thread/start",
          params: {
            approvalPolicy: "never",
            cwd: input.workspacePath,
            experimentalRawEvents: false,
            permissionProfile: {
              type: "disabled"
            },
            persistExtendedHistory: true
          }
        });
        const threadStarted = await readUntilResponse(
          queue,
          2,
          activeRun,
          (raw) => {
            const result = objectField(raw, "result");
            const thread = objectField(result, "thread");
            const threadId = stringField(thread, "id");
            if (threadId !== undefined) {
              activeRun.threadId = threadId;
            }

            if (threadId === undefined) {
              return {
                raw
              };
            }

            return {
              normalized: {
                cwd: stringField(result, "cwd") ?? input.workspacePath,
                sessionId: threadId,
                threadId,
                type: "session_started"
              },
              raw
            };
          }
        );
        yield* threadStarted.events;
        if (threadStarted.stopped) {
          return;
        }

        const threadId = activeRun.threadId;
        if (threadId === undefined) {
          yield protocolFailure("thread/start response did not include thread.id");
          shutdownProcess(child);
          yield* await drainUntilExit(queue, activeRun);
          return;
        }

        writeJson(child, {
          id: 3,
          method: "turn/start",
          params: {
            input: [
              {
                text: input.prompt,
                text_elements: [],
                type: "text"
              }
            ],
            threadId
          }
        });
        const turnStarted = await readUntilResponse(queue, 3, activeRun, (raw) => {
          const result = objectField(raw, "result");
          const turn = objectField(result, "turn");
          const turnId = stringField(turn, "id");
          if (turnId !== undefined) {
            activeRun.turnId = turnId;
          }

          return {
            raw
          };
        });
        yield* turnStarted.events;
        if (turnStarted.stopped) {
          return;
        }

        while (true) {
          const event = providerEventFromQueueItem(await queue.next(), activeRun);
          yield event;
          const type = event.normalized?.type;

          if (type === "process_exit") {
            return;
          }

          if (
            type === "input_required" ||
            type === "malformed_event" ||
            type === "turn_completed" ||
            type === "turn_failed"
          ) {
            shutdownProcess(child);
          }
        }
      } finally {
        activeRuns.delete(input.run.id);
      }
    },
    validate: async (command) => {
      const parsed = parseCommand(command);
      if (!parsed.args.includes("app-server")) {
        throw new Error(
          "Codex provider command must include the app-server subcommand"
        );
      }

      await validateCodexAppServerCommand(parsed);
    }
  };
}

async function readUntilResponse(
  queue: ProcessQueue,
  requestId: number,
  activeRun: ActiveCodexRun,
  mapResponse: (raw: unknown) => ProviderEvent
): Promise<ResponseReadResult> {
  const events: ProviderEvent[] = [];

  while (true) {
    const item = await queue.next();
    if (item.kind === "message" && responseId(item.raw) === requestId) {
      if (objectField(item.raw, "error") !== undefined) {
        events.push(jsonRpcErrorEvent(item.raw));
        shutdownProcess(activeRun.child);
        events.push(...(await drainUntilExit(queue, activeRun)));
        return {
          events,
          stopped: true
        };
      }

      events.push(mapResponse(item.raw));
      return {
        events,
        stopped: false
      };
    }

    const event = providerEventFromQueueItem(item, activeRun);
    events.push(event);
    if (event.normalized?.type === "process_exit") {
      return {
        events,
        stopped: true
      };
    }
    if (isTerminalFailure(event.normalized?.type)) {
      shutdownProcess(activeRun.child);
      events.push(...(await drainUntilExit(queue, activeRun)));
      return {
        events,
        stopped: true
      };
    }
  }
}

async function drainUntilExit(
  queue: ProcessQueue,
  activeRun: ActiveCodexRun
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];

  while (true) {
    const event = providerEventFromQueueItem(await queue.next(), activeRun);
    events.push(event);
    if (event.normalized?.type === "process_exit") {
      return events;
    }
  }
}

function providerEventFromQueueItem(
  item: ProcessQueueItem,
  activeRun: ActiveCodexRun
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
      return {
        normalized: {
          cancelled: activeRun.cancelled,
          exitCode: item.exitCode,
          signal: item.signal,
          type: "process_exit"
        },
        raw: {
          cancelled: activeRun.cancelled,
          exitCode: item.exitCode,
          kind: "process_exit",
          signal: item.signal
        }
      };
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
      return mapCodexJsonRpcMessage(item.raw, activeRun);
  }
}

function mapCodexJsonRpcMessage(
  raw: unknown,
  activeRun: ActiveCodexRun
): ProviderEvent {
  const method = stringField(raw, "method");
  if (method === undefined) {
    if (objectField(raw, "error") !== undefined) {
      return jsonRpcErrorEvent(raw);
    }

    return {
      raw
    };
  }

  if (isInputRequiredMethod(method)) {
    return {
      normalized: {
        method,
        params: objectField(raw, "params"),
        requestId: responseId(raw),
        type: "input_required"
      },
      raw
    };
  }

  const params = objectField(raw, "params");
  if (method === "item/agentMessage/delta") {
    return {
      normalized: {
        message: stringField(params, "delta") ?? "",
        threadId: stringField(params, "threadId"),
        turnId: stringField(params, "turnId"),
        type: "message"
      },
      raw
    };
  }

  if (method === "thread/tokenUsage/updated") {
    return {
      normalized: {
        threadId: stringField(params, "threadId"),
        tokenUsage: objectField(params, "tokenUsage"),
        turnId: stringField(params, "turnId"),
        type: "usage_updated"
      },
      raw
    };
  }

  if (method === "account/rateLimits/updated") {
    return {
      normalized: {
        rateLimits: objectField(params, "rateLimits"),
        type: "rate_limit_updated"
      },
      raw
    };
  }

  if (method === "turn/completed") {
    const turn = objectField(params, "turn");
    const status = stringField(turn, "status");
    const turnId = stringField(turn, "id") ?? activeRun.turnId;
    const threadId = stringField(params, "threadId") ?? activeRun.threadId;

    if (status === "completed") {
      return {
        normalized: {
          status,
          threadId,
          turnId,
          type: "turn_completed"
        },
        raw
      };
    }

    return {
      normalized: {
        message:
          stringField(objectField(turn, "error"), "message") ??
          `turn completed with status ${status ?? "unknown"}`,
        status,
        threadId,
        turnId,
        type: "turn_failed"
      },
      raw
    };
  }

  if (method === "error") {
    const error = objectField(params, "error");
    return {
      normalized: {
        message: stringField(error, "message") ?? "Codex provider error",
        threadId: stringField(params, "threadId") ?? activeRun.threadId,
        turnId: stringField(params, "turnId") ?? activeRun.turnId,
        type: "turn_failed"
      },
      raw
    };
  }

  return {
    raw
  };
}

function jsonRpcErrorEvent(raw: unknown): ProviderEvent {
  const error = objectField(raw, "error");
  return {
    normalized: {
      message: stringField(error, "message") ?? "Codex JSON-RPC error",
      type: "turn_failed"
    },
    raw
  };
}

function protocolFailure(message: string): ProviderEvent {
  return {
    normalized: {
      message,
      type: "malformed_event"
    },
    raw: {
      kind: "protocol_error",
      message
    }
  };
}

function isInputRequiredMethod(method: string): boolean {
  return (
    method === "item/tool/requestUserInput" ||
    method === "mcpServer/elicitation/request" ||
    method.endsWith("/requestApproval")
  );
}

function isTerminalFailure(type: string | undefined): boolean {
  return (
    type === "input_required" ||
    type === "malformed_event" ||
    type === "turn_failed"
  );
}

function createProcessQueue(child: ChildProcessWithoutNullStreams): ProcessQueue {
  const pending: ProcessQueueItem[] = [];
  let waiting: ((item: ProcessQueueItem) => void) | undefined;
  let stdoutBuffer = "";

  const push = (item: ProcessQueueItem): void => {
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      resolve(item);
      return;
    }

    pending.push(item);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trimEnd();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      pushLine(line, push);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer.length > 0) {
      pushLine(stdoutBuffer.trimEnd(), push);
      stdoutBuffer = "";
    }
  });
  child.once("error", (error) => {
    push({
      error,
      kind: "error"
    });
  });
  child.once("close", (exitCode, signal) => {
    push({
      exitCode,
      kind: "exit",
      signal
    });
  });

  return {
    next: () => {
      const item = pending.shift();
      if (item !== undefined) {
        return Promise.resolve(item);
      }

      return new Promise<ProcessQueueItem>((resolve) => {
        waiting = resolve;
      });
    }
  };
}

function pushLine(
  line: string,
  push: (item: ProcessQueueItem) => void
): void {
  if (line.trim().length === 0) {
    return;
  }

  try {
    push({
      kind: "message",
      raw: JSON.parse(line) as unknown
    });
  } catch (error) {
    push({
      kind: "malformed",
      line,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function writeJson(
  child: ChildProcessWithoutNullStreams,
  value: JsonObject
): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function terminateProcess(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
}

function shutdownProcess(child: ChildProcessWithoutNullStreams): void {
  if (!child.stdin.destroyed && child.stdin.writable) {
    child.stdin.end();
  }

  const timer = setTimeout(() => {
    terminateProcess(child);
  }, 250);
  timer.unref();
}

async function validateCodexAppServerCommand(command: {
  args: string[];
  executable: string;
}): Promise<void> {
  const help = await runCodexProbe(command.executable, [
    ...command.args,
    "--help"
  ]);
  if (help.kind === "spawn_error") {
    throw new Error(
      `Codex provider command executable not available: ${command.executable}: ${help.message}`
    );
  }
  if (help.kind === "timeout") {
    throw new Error("Codex provider command validation timed out");
  }
  if (help.exitCode !== 0) {
    throw new Error(
      `Codex provider command validation failed with exit code ${help.exitCode ?? "unknown"}: ${help.output.trim() || "no output"}`
    );
  }
  if (!/app-server/.test(help.output)) {
    throw new Error(
      "Codex provider command help output does not look like app-server"
    );
  }

  const profile = extractProfileName(command.args);
  if (profile === undefined) {
    return;
  }

  const appServerIndex = command.args.indexOf("app-server");
  const baseArgs =
    appServerIndex >= 0
      ? command.args.slice(0, appServerIndex)
      : command.args.slice();
  const probe = await runCodexProbe(command.executable, [
    ...baseArgs,
    "features",
    "list"
  ]);
  if (probe.kind === "spawn_error") {
    throw new Error(
      `Codex profile probe for '${profile}' could not spawn ${command.executable}: ${probe.message}`
    );
  }
  if (probe.kind === "timeout") {
    throw new Error(
      `Codex profile probe for '${profile}' timed out; cannot verify profile exists`
    );
  }
  if (probe.exitCode === 0) {
    return;
  }

  const stderr = probe.output.trim();
  if (/config profile/i.test(stderr) && /not found/i.test(stderr)) {
    throw new Error(missingProfileMessage(profile, stderr));
  }
  throw new Error(
    `Codex profile probe for '${profile}' failed with exit code ${probe.exitCode ?? "unknown"}: ${stderr || "no output"}`
  );
}

type CodexProbeResult =
  | { exitCode: number | null; kind: "exit"; output: string }
  | { kind: "spawn_error"; message: string }
  | { kind: "timeout" };

async function runCodexProbe(
  executable: string,
  args: string[]
): Promise<CodexProbeResult> {
  const envTimeout = Number(process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5_000;
  return await new Promise<CodexProbeResult>((resolve) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateProcess(child);
      resolve({ kind: "timeout" });
    }, timeoutMs);

    const settle = (result: CodexProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      settle({ kind: "spawn_error", message: error.message });
    });
    child.once("close", (exitCode) => {
      settle({ exitCode, kind: "exit", output });
    });
  });
}

function extractProfileName(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-p" || arg === "--profile") {
      return args[i + 1];
    }
    if (arg.startsWith("--profile=")) {
      return arg.slice("--profile=".length);
    }
  }
  return undefined;
}

function missingProfileMessage(profile: string, stderr: string): string {
  return [
    `Codex profile '${profile}' is not defined in ~/.codex/config.toml.`,
    `Codex reported: ${stderr}`,
    "",
    `Add this block to ~/.codex/config.toml (see README.md and docs/adr/0042-codex-profile-for-headless-runs.md):`,
    "",
    `  [profiles.${profile}]`,
    `  analytics = { enabled = false }`,
    "",
    `  [profiles.${profile}.features]`,
    `  memories         = false`,
    `  multi_agent      = true`,
    `  codex_hooks      = false`,
    `  image_generation = false`
  ].join("\n");
}

function parseCommand(command: string): { args: string[]; executable: string } {
  const parts = splitCommand(command);
  const executable = parts[0];
  if (executable === undefined) {
    throw new Error("Codex provider command is empty");
  }

  return {
    args: parts.slice(1),
    executable
  };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of command.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote !== undefined) {
    throw new Error("Codex provider command has an unterminated quote");
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function responseId(value: unknown): string | number | undefined {
  const id = field(value, "id");
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function objectField(value: unknown, key: string): JsonObject | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "object" && valueAtKey !== null) {
    return valueAtKey as JsonObject;
  }

  return undefined;
}

function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return value[key as keyof typeof value];
  }

  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "string") {
    return valueAtKey;
  }

  return undefined;
}
