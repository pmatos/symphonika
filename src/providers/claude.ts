import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";

import {
  createProcessScope,
  type ProcessScope
} from "../lifecycle/process-scope.js";
import { providerScratchEnvironment } from "../lifecycle/provider-scratch.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../provider.js";
import { renderProviderCommandTemplate } from "../provider-command-template.js";
import { parseProviderCommand, type ProviderLabel } from "./command-parse.js";
import {
  createJsonlProcessQueue,
  mapProcessQueueControlEvent,
  type ProcessQueueItem
} from "./jsonl-process-queue.js";
import {
  shutdownProviderProcess,
  spawnProviderProcess
} from "./provider-process.js";
import { attachProviderStderrLog } from "./provider-stderr.js";

type JsonObject = Record<string, unknown>;

const PROVIDER_LABEL: ProviderLabel = "Claude";

type ActiveClaudeRun = {
  cancelled: boolean;
  child?: ChildProcessWithoutNullStreams;
  sessionId?: string;
};

export type ClaudeProviderOptions = {
  processScope?: ProcessScope;
};

export function createClaudeProvider(
  options: ClaudeProviderOptions = {}
): AgentProvider {
  const processScope = options.processScope ?? createProcessScope();
  const activeRuns = new Map<string, ActiveClaudeRun>();

  return {
    cancel: (runId) => {
      const activeRun = activeRuns.get(runId);
      if (activeRun === undefined) {
        return Promise.resolve();
      }

      activeRun.cancelled = true;
      if (activeRun.child === undefined) {
        // Cancelled before the scope probe/spawn finished — runAttempt's own
        // post-probe recheck (see below) is what stops it from launching.
        return Promise.resolve();
      }
      return shutdownProviderProcess(
        activeRun.child,
        undefined,
        "cancellation"
      );
    },
    name: "claude",
    runAttempt: async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      // Registered before the scope-probe await below so a cancel arriving
      // during that await (up to probeTimeoutMs on the first, uncached
      // call) has somewhere to land instead of being a silent no-op —
      // cancel() finds this entry, sets cancelled, and the recheck right
      // after the await stops the spawn from ever happening. Without this
      // placeholder, a cancel here would be permanently lost: RunController
      // only rechecks its own cancellation latch once, before runAttempt is
      // called (see ADR 0052 at run-controller.ts:2274-2281), and this
      // await reopens that exact race one level deeper.
      const activeRun: ActiveClaudeRun = { cancelled: false };
      activeRuns.set(input.run.id, activeRun);

      const renderedCommand = renderProviderCommandTemplate(
        input.provider.command,
        input.routine ?? {}
      ).rendered;
      const command = await processScope.wrapForProviderScope(
        input.run,
        withOutputSchema(
          applyRoutineArguments(
            parseProviderCommand(renderedCommand, PROVIDER_LABEL),
            input.routine
          ),
          input.outputSchema
        )
      );
      if (activeRun.cancelled) {
        // Outside the try/finally below (which owns the only other
        // activeRuns.delete call) -- without this, this placeholder would
        // leak in the map for the lifetime of the provider instance.
        activeRuns.delete(input.run.id);
        yield {
          normalized: {
            cancelled: true,
            exitCode: null,
            signal: null,
            type: "process_exit"
          },
          raw: {
            cancelled: true,
            exitCode: null,
            kind: "process_exit",
            signal: null
          }
        };
        return;
      }
      const child = spawnProviderProcess(command, input.workspacePath, {
        ...providerScratchEnvironment(input.scratchPath),
        ...(input.routine === undefined
          ? {}
          : { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" })
      });
      activeRun.child = child;
      const stderrCapture = attachProviderStderrLog(
        child,
        input.stderrLogPath,
        input.stderrRedactSecrets === undefined
          ? {}
          : { redactSecrets: input.stderrRedactSecrets }
      );
      const queue = createJsonlProcessQueue(child);

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
              await shutdownProviderProcess(child);
            }
          }
        }
      } finally {
        activeRuns.delete(input.run.id);
        // Runs unconditionally, not only on cancellation: the `process_exit`
        // branch above returns directly on ordinary successful completion,
        // bypassing terminateProcess entirely. A provider-spawned build tool
        // can outlive that exit as a detached grandchild; stopping the
        // run's scope here is what actually reaps it (see docs/adr/0064).
        await processScope.stopProviderScope(input.run);
        // Last, so scope teardown is never delayed by it: the caller reads
        // the stderr log to explain an unclean exit as soon as this generator
        // returns, and only this await orders that read after the tee's write
        // (bounded, so a wedged sink cannot strand the attempt).
        await stderrCapture.waitForFlush();
      }
    },
    validate: async (command, values = {}) => {
      const rendered = renderProviderCommandTemplate(command, values).rendered;
      const parsed = parseProviderCommand(rendered, PROVIDER_LABEL);
      validateClaudeProtocolFlags(parsed.args);
      await validateClaudeStreamJsonCommand(parsed);
    }
  };
}

function providerEventsFromQueueItem(
  item: ProcessQueueItem,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  if (item.kind === "message") {
    return mapClaudeStreamJsonMessage(item.raw, activeRun);
  }

  return [mapProcessQueueControlEvent(item, activeRun.cancelled)];
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
          rateLimits:
            objectField(raw, "rate_limits") ?? objectField(raw, "rateLimits"),
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
    const structuredOutput = objectField(raw, "structured_output");
    return [
      {
        normalized: {
          durationMs: numberField(raw, "duration_ms"),
          numTurns: numberField(raw, "num_turns"),
          result: stringField(raw, "result"),
          sessionId,
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
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

function withOutputSchema(
  command: { args: string[]; executable: string },
  outputSchema: object | undefined
): { args: string[]; executable: string } {
  if (outputSchema === undefined) {
    return command;
  }
  const args = [...command.args];
  const disallowedToolsIndex = args.indexOf("--disallowedTools");
  args.splice(
    disallowedToolsIndex < 0 ? args.length : disallowedToolsIndex,
    0,
    "--json-schema",
    JSON.stringify(outputSchema)
  );
  return { ...command, args };
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

  if (!args.includes("--verbose")) {
    throw new Error(
      "Claude provider command must include --verbose (required by claude CLI when --print is combined with --output-format stream-json)"
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

// model/effort/permissionMode reach the command via the operator's own
// {{tag}} placement (see renderProviderCommandTemplate above) — this only
// adds the anti-backgrounding guard, which is not a declared per-routine
// field and must not be templated into a command shared with issue Runs.
function applyRoutineArguments(
  command: { args: string[]; executable: string },
  routine: ProviderRunInput["routine"]
): { args: string[]; executable: string } {
  if (routine === undefined) {
    return command;
  }

  const { args, tools } = extractDisallowedTools(command.args);
  const mergedTools = [
    ...new Set([...tools, "ScheduleWakeup", "Monitor", "CronCreate"])
  ];

  return {
    args: [...args, "--disallowedTools", ...mergedTools],
    executable: command.executable
  };
}

function extractDisallowedTools(args: string[]): {
  args: string[];
  tools: string[];
} {
  const remainingArgs: string[] = [];
  const tools: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg !== "--disallowedTools" && arg !== "--disallowed-tools") {
      remainingArgs.push(arg);
      continue;
    }

    while (true) {
      const tool = args[index + 1];
      if (tool === undefined || tool.startsWith("-")) {
        break;
      }
      tools.push(tool);
      index += 1;
    }
  }

  return { args: remainingArgs, tools };
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
