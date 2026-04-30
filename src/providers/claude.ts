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

type JsonObject = Record<string, unknown>;

type ActiveClaudeRun = {
  cancelled: boolean;
  child: ChildProcessWithoutNullStreams;
  sessionId?: string;
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

export function createClaudeProvider(): AgentProvider {
  const activeRuns = new Map<string, ActiveClaudeRun>();

  return {
    cancel: (runId) => {
      const activeRun = activeRuns.get(runId);
      if (activeRun === undefined) {
        return Promise.resolve();
      }

      activeRun.cancelled = true;
      shutdownProcess(activeRun.child);
      return Promise.resolve();
    },
    name: "claude",
    runAttempt: async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      const command = parseCommand(input.provider.command);
      const child = spawn(command.executable, command.args, {
        cwd: input.workspacePath,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const activeRun: ActiveClaudeRun = {
        cancelled: false,
        child
      };
      activeRuns.set(input.run.id, activeRun);
      child.stderr.resume();
      const queue = createProcessQueue(child);

      try {
        writeClaudeInput(child, input.prompt);
        child.stdin.end();

        while (true) {
          const events = providerEventsFromQueueItem(
            await queue.next(),
            activeRun
          );
          for (const event of events) {
            yield event;
            const type = event.normalized?.type;

            if (type === "process_exit") {
              return;
            }

            if (isTerminalFailure(type)) {
              shutdownProcess(child);
            }
          }
        }
      } finally {
        activeRuns.delete(input.run.id);
      }
    },
    validate: async (command) => {
      const parsed = parseCommand(command);
      validateClaudeProtocolFlags(parsed.args);
      await validateClaudeStreamJsonCommand(parsed);
    }
  };
}

function providerEventsFromQueueItem(
  item: ProcessQueueItem,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  switch (item.kind) {
    case "error":
      return [
        {
          normalized: {
            message: item.error.message,
            type: "turn_failed"
          },
          raw: {
            kind: "process_error",
            message: item.error.message
          }
        }
      ];
    case "exit":
      return [
        {
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
        }
      ];
    case "malformed":
      return [
        {
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
        }
      ];
    case "message":
      return mapClaudeStreamJsonMessage(item.raw, activeRun);
  }
}

function mapClaudeStreamJsonMessage(
  raw: unknown,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  const type = stringField(raw, "type");

  if (type === "system") {
    return mapSystemMessage(raw, activeRun);
  }

  if (type === "assistant") {
    return mapAssistantMessage(raw, activeRun);
  }

  if (type === "result") {
    return mapResultMessage(raw, activeRun);
  }

  if (type === "stream_event") {
    return mapStreamEvent(raw, activeRun);
  }

  if (isInputRequiredType(type)) {
    return [
      {
        normalized: {
          input: objectField(raw, "input"),
          message:
            stringField(raw, "message") ?? "Claude provider requested input",
          sessionId: stringField(raw, "session_id") ?? activeRun.sessionId,
          type: "input_required"
        },
        raw
      }
    ];
  }

  if (type === "rate_limit") {
    return [
      {
        normalized: {
          rateLimits: objectField(raw, "rate_limits") ?? objectField(raw, "rateLimits"),
          type: "rate_limit_updated"
        },
        raw
      }
    ];
  }

  if (type === "error") {
    return [
      {
        normalized: {
          message:
            stringField(raw, "message") ??
            stringField(objectField(raw, "error"), "message") ??
            "Claude provider error",
          sessionId: stringField(raw, "session_id") ?? activeRun.sessionId,
          type: "turn_failed"
        },
        raw
      }
    ];
  }

  return [
    {
      raw
    }
  ];
}

function mapSystemMessage(
  raw: unknown,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  if (stringField(raw, "subtype") !== "init") {
    return [
      {
        raw
      }
    ];
  }

  const sessionId = stringField(raw, "session_id");
  if (sessionId !== undefined) {
    activeRun.sessionId = sessionId;
  }

  return [
    {
      normalized: {
        cwd: stringField(raw, "cwd"),
        model: stringField(raw, "model"),
        permissionMode: stringField(raw, "permissionMode"),
        sessionId,
        type: "session_started"
      },
      raw
    }
  ];
}

function mapAssistantMessage(
  raw: unknown,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  const message = objectField(raw, "message");
  const sessionId = stringField(raw, "session_id") ?? activeRun.sessionId;
  const events: ProviderEvent[] = [];

  for (const block of arrayField(message, "content")) {
    const blockType = stringField(block, "type");
    if (blockType === "text") {
      events.push({
        normalized: {
          message: stringField(block, "text") ?? "",
          sessionId,
          type: "message"
        },
        raw
      });
      continue;
    }

    if (blockType === "tool_use") {
      const toolName = stringField(block, "name");
      const toolInput = objectField(block, "input");
      if (isInputRequiredTool(toolName)) {
        events.push({
          normalized: {
            input: toolInput,
            sessionId,
            toolCallId: stringField(block, "id"),
            toolName,
            type: "input_required"
          },
          raw
        });
        continue;
      }

      events.push({
        normalized: {
          input: toolInput,
          sessionId,
          toolCallId: stringField(block, "id"),
          toolName,
          type: "tool_call"
        },
        raw
      });
    }
  }

  const usage = objectField(message, "usage");
  if (usage !== undefined) {
    events.push({
      normalized: {
        sessionId,
        tokenUsage: usage,
        type: "usage_updated"
      },
      raw
    });
  }

  if (events.length === 0) {
    return [
      {
        raw
      }
    ];
  }

  return events;
}

function mapResultMessage(
  raw: unknown,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  const sessionId = stringField(raw, "session_id") ?? activeRun.sessionId;
  const subtype = stringField(raw, "subtype");
  const isError = booleanField(raw, "is_error");

  if (subtype === "success" && isError !== true) {
    return [
      {
        normalized: {
          durationMs: numberField(raw, "duration_ms"),
          numTurns: numberField(raw, "num_turns"),
          result: stringField(raw, "result"),
          sessionId,
          totalCostUsd: numberField(raw, "total_cost_usd"),
          type: "turn_completed"
        },
        raw
      }
    ];
  }

  return [
    {
      normalized: {
        durationMs: numberField(raw, "duration_ms"),
        message:
          stringField(raw, "result") ??
          `Claude provider result ended with ${subtype ?? "unknown"} status`,
        numTurns: numberField(raw, "num_turns"),
        sessionId,
        subtype,
        type: "turn_failed"
      },
      raw
    }
  ];
}

function mapStreamEvent(
  raw: unknown,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  const event = objectField(raw, "event");
  const eventType = stringField(event, "type");
  const sessionId = stringField(raw, "session_id") ?? activeRun.sessionId;

  if (eventType === "content_block_delta") {
    const delta = objectField(event, "delta");
    if (stringField(delta, "type") === "text_delta") {
      return [
        {
          normalized: {
            message: stringField(delta, "text") ?? "",
            sessionId,
            type: "message"
          },
          raw
        }
      ];
    }
  }

  if (eventType === "content_block_start") {
    const contentBlock = objectField(event, "content_block");
    if (stringField(contentBlock, "type") === "tool_use") {
      return [
        {
          normalized: {
            input: objectField(contentBlock, "input"),
            sessionId,
            toolCallId: stringField(contentBlock, "id"),
            toolName: stringField(contentBlock, "name"),
            type: "tool_call"
          },
          raw
        }
      ];
    }
  }

  return [
    {
      raw
    }
  ];
}

function isInputRequiredType(type: string | undefined): boolean {
  return (
    type === "input_required" ||
    type === "permission_request" ||
    type === "tool_permission_request" ||
    type === "user_input_request"
  );
}

function isInputRequiredTool(toolName: string | undefined): boolean {
  return toolName === "AskUserQuestion";
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

function writeClaudeInput(
  child: ChildProcessWithoutNullStreams,
  prompt: string
): void {
  child.stdin.write(
    `${JSON.stringify({
      message: {
        content: [
          {
            text: prompt,
            type: "text"
          }
        ],
        role: "user"
      },
      type: "user"
    })}\n`
  );
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

async function validateClaudeStreamJsonCommand(command: {
  args: string[];
  executable: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, [...command.args, "--help"], {
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
      reject(new Error("Claude provider command validation timed out"));
    }, 5_000);

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
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
      settle(() => {
        reject(
          new Error(
            `Claude provider command executable not available: ${command.executable}: ${error.message}`
          )
        );
      });
    });
    child.once("close", (exitCode) => {
      settle(() => {
        if (exitCode !== 0) {
          reject(
            new Error(
              `Claude provider command validation failed with exit code ${exitCode ?? "unknown"}`
            )
          );
          return;
        }

        if (!/stream-json/.test(output)) {
          reject(
            new Error(
              "Claude provider command help output does not mention stream-json"
            )
          );
          return;
        }

        resolve();
      });
    });
  });
}

function validateClaudeProtocolFlags(args: string[]): void {
  if (!args.includes("-p") && !args.includes("--print")) {
    throw new Error("Claude provider command must include -p or --print");
  }

  if (!hasOptionValue(args, "--input-format", "stream-json")) {
    throw new Error(
      "Claude provider command must include --input-format stream-json"
    );
  }

  if (!hasOptionValue(args, "--output-format", "stream-json")) {
    throw new Error(
      "Claude provider command must include --output-format stream-json"
    );
  }

  if (
    !args.includes("--dangerously-skip-permissions") &&
    !hasOptionValue(args, "--permission-mode", "bypassPermissions")
  ) {
    throw new Error(
      "Claude provider command must run with full permissions using --dangerously-skip-permissions or --permission-mode bypassPermissions"
    );
  }
}

function hasOptionValue(
  args: string[],
  option: string,
  expectedValue: string
): boolean {
  return args.some((arg, index) => {
    if (arg === option) {
      return args[index + 1] === expectedValue;
    }

    return arg === `${option}=${expectedValue}`;
  });
}

function parseCommand(command: string): { args: string[]; executable: string } {
  const parts = splitCommand(command);
  const executable = parts[0];
  if (executable === undefined) {
    throw new Error("Claude provider command is empty");
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
  const trimmedCommand = command.trim();

  for (let index = 0; index < trimmedCommand.length; index += 1) {
    const character = trimmedCommand[index] ?? "";
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (quote !== undefined) {
      if (character === "\\") {
        const nextCharacter = trimmedCommand[index + 1];
        if (nextCharacter === quote || nextCharacter === "\\") {
          current += nextCharacter;
          index += 1;
        } else {
          current += character;
        }
        continue;
      }

      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\\") {
      const nextCharacter = trimmedCommand[index + 1];
      if (
        nextCharacter === "'" ||
        nextCharacter === '"' ||
        (nextCharacter !== undefined && /\s/.test(nextCharacter))
      ) {
        escaping = true;
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
    throw new Error("Claude provider command has an unterminated quote");
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function arrayField(value: unknown, key: string): unknown[] {
  const valueAtKey = field(value, key);
  return Array.isArray(valueAtKey) ? valueAtKey : [];
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

function numberField(value: unknown, key: string): number | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "number") {
    return valueAtKey;
  }

  return undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "boolean") {
    return valueAtKey;
  }

  return undefined;
}
