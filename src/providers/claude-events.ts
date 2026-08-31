import type { ProviderEvent } from "../provider.js";

type JsonObject = Record<string, unknown>;

export type ClaudeEventReducer = {
  reduce: (raw: unknown) => ProviderEvent[];
};

// A stateful reducer over one Claude Run's stream-json message stream. The only
// mapping state is the `session_id` carried forward from the system/init
// message to every later Normalized Event; it lives in the closure, so no
// caller can name or mutate it. Unlike the Codex reducer, nothing is injected:
// the Claude mapping has no clock, and its session identity is mapping-owned
// (written here on init, read back by every later message) rather than
// provider-owned, so it needs neither a `now` nor a `session` snapshot.
export function createClaudeEventReducer(): ClaudeEventReducer {
  let sessionId: string | undefined;

  function mapSystemMessage(raw: unknown): ProviderEvent[] {
    if (stringField(raw, "subtype") !== "init") {
      return [
        {
          raw
        }
      ];
    }

    const messageSessionId = stringField(raw, "session_id");
    if (messageSessionId !== undefined) {
      sessionId = messageSessionId;
    }

    return [
      {
        normalized: {
          cwd: stringField(raw, "cwd"),
          model: stringField(raw, "model"),
          permissionMode: stringField(raw, "permissionMode"),
          sessionId: messageSessionId,
          type: "session_started"
        },
        raw
      }
    ];
  }

  function reduce(raw: unknown): ProviderEvent[] {
    const type = stringField(raw, "type");

    if (type === "system") {
      return mapSystemMessage(raw);
    }

    if (type === "assistant") {
      return mapAssistantMessage(raw, sessionId);
    }

    if (type === "result") {
      return mapResultMessage(raw, sessionId);
    }

    if (type === "stream_event") {
      return mapStreamEvent(raw, sessionId);
    }

    if (isInputRequiredType(type)) {
      return [
        {
          normalized: {
            input: objectField(raw, "input"),
            message:
              stringField(raw, "message") ?? "Claude provider requested input",
            sessionId: stringField(raw, "session_id") ?? sessionId,
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
            sessionId: stringField(raw, "session_id") ?? sessionId,
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

  return { reduce };
}

function mapAssistantMessage(
  raw: unknown,
  carriedSessionId: string | undefined
): ProviderEvent[] {
  const message = objectField(raw, "message");
  const sessionId = stringField(raw, "session_id") ?? carriedSessionId;
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
  carriedSessionId: string | undefined
): ProviderEvent[] {
  const sessionId = stringField(raw, "session_id") ?? carriedSessionId;
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

function mapStreamEvent(
  raw: unknown,
  carriedSessionId: string | undefined
): ProviderEvent[] {
  const event = objectField(raw, "event");
  const eventType = stringField(event, "type");
  const sessionId = stringField(raw, "session_id") ?? carriedSessionId;

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

export function isTerminalFailure(type: string | undefined): boolean {
  return (
    type === "input_required" ||
    type === "malformed_event" ||
    type === "turn_failed"
  );
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
