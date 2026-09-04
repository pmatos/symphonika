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
  mapProcessQueueControlEvent,
  type ProcessQueue,
  type ProcessQueueItem
} from "./jsonl-process-queue.js";
import { shutdownProviderProcess } from "./provider-process.js";
import {
  createClaudeEventReducer,
  isTerminalFailure,
  type ClaudeEventReducer
} from "./claude-events.js";
import {
  jsonlProviderSession,
  type ProviderRunState,
  type ProviderTurn
} from "./provider-session.js";

const PROVIDER_LABEL: ProviderLabel = "Claude";

type ActiveClaudeRun = ProviderRunState & {
  reducer: ClaudeEventReducer;
};

export type ClaudeProviderOptions = {
  processScope?: ProcessScope;
};

export function createClaudeProvider(
  options: ClaudeProviderOptions = {}
): AgentProvider {
  const processScope = options.processScope ?? createProcessScope();
  const session = jsonlProviderSession<ActiveClaudeRun>({
    createRunState: () => ({
      cancelled: false,
      reducer: createClaudeEventReducer()
    }),
    extraEnv: (input) =>
      input.routine === undefined
        ? {}
        : { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    label: PROVIDER_LABEL,
    name: "claude",
    processScope,
    refineCommand: (command, input) =>
      withOutputSchema(
        applyRoutineArguments(command, input.routine),
        input.outputSchema
      ),
    runTurn: runClaudeTurn
  });

  return {
    ...session,
    validate: async (command, values = {}) => {
      const rendered = renderProviderCommandTemplate(command, values).rendered;
      const parsed = parseProviderCommand(rendered, PROVIDER_LABEL);
      validateClaudeProtocolFlags(parsed.args);
      await validateClaudeStreamJsonCommand(parsed);
    }
  };
}

// The Claude stream-json protocol: write the prompt, then map the JSONL event
// stream. The prologue, finally (ADR 0064), and cancel race (ADR 0052) are
// owned by the shared provider session harness.
async function* runClaudeTurn(
  turn: ProviderTurn<ActiveClaudeRun, ProcessQueue>
): AsyncGenerator<ProviderEvent> {
  const { child, input, queue, run: activeRun } = turn;
  writeClaudeInput(child, input.prompt);
  child.stdin.end();

  while (true) {
    const events = providerEventsFromQueueItem(await queue.next(), activeRun);
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
}

function providerEventsFromQueueItem(
  item: ProcessQueueItem,
  activeRun: ActiveClaudeRun
): ProviderEvent[] {
  const events =
    item.kind === "message"
      ? activeRun.reducer.reduce(item.raw)
      : [mapProcessQueueControlEvent(item, activeRun.cancelled)];

  return events.map((event) => ({ ...event, receivedAt: item.receivedAt }));
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
