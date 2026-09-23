import type { ProviderEvent } from "../provider.js";

export type OmpResponseCommand = "get_state" | "negotiate_protocol" | "prompt";

export type OmpEventReducer = {
  reduce: (raw: unknown, responseTo?: OmpResponseCommand) => ProviderEvent;
};

// A stateful reducer over one OMP Run's native RPC stream. Response ids are
// correlated by the provider before they cross this seam, so the caller names
// the command it is awaiting instead of the reducer trusting raw.command.
// Session identity and assistant-text carry-forward are mapping state and stay
// private to this closure; process, queue, and cancellation state stay in the
// provider adapter.
export function createOmpEventReducer(): OmpEventReducer {
  let assistantText: string | undefined;
  let completedAssistantText: string | undefined;
  let sessionId: string | undefined;

  return {
    reduce: (raw, responseTo) => {
      if (responseTo !== undefined) {
        return mapResponse(raw, responseTo);
      }
      return mapFrame(raw);
    }
  };

  function mapResponse(
    raw: unknown,
    responseTo: OmpResponseCommand
  ): ProviderEvent {
    if (
      stringField(raw, "type") !== "response" ||
      booleanField(raw, "success") !== true
    ) {
      return mapFailedResponse(raw);
    }

    if (responseTo === "get_state") {
      const state = objectField(raw, "data");
      sessionId = stringField(state, "sessionId");
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

    if (responseTo === "prompt") {
      if (booleanField(objectField(raw, "data"), "agentInvoked") === false) {
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

  function mapFrame(raw: unknown): ProviderEvent {
    const type = stringField(raw, "type");

    // Watchdog liveness marker (ADR 0087, issue #779 amendment). Fires once
    // per prompt, so no throttle (cf. codex-events.ts's progress marker).
    if (type === "agent_start") {
      return {
        normalized: {
          sessionId,
          signal: "agent_start",
          type: "progress"
        },
        raw
      };
    }

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
            sessionId,
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
          assistantText = (assistantText ?? "") + delta;
        }
        return {
          normalized: {
            message: delta,
            messageKind: updateType === "text_delta" ? "text" : "thinking",
            sessionId,
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
        assistantText !== undefined
      ) {
        completedAssistantText = assistantText;
        assistantText = undefined;
      }
      const usage = objectField(message, "usage");
      if (stringField(message, "role") === "assistant" && usage !== undefined) {
        return {
          normalized: {
            sessionId,
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
          sessionId,
          toolCallId: stringField(raw, "toolCallId"),
          toolName: stringField(raw, "toolName"),
          type: "tool_call"
        },
        raw
      };
    }

    if (type === "turn_end") {
      const result = assistantText ?? completedAssistantText;
      // OMP can emit more than one turn_end before terminal agent_end. Consume
      // completed text so a later textless turn cannot report a stale result.
      completedAssistantText = undefined;
      return {
        normalized: {
          ...(result === undefined ? {} : { result }),
          sessionId,
          type: "turn_completed"
        },
        raw
      };
    }

    return { raw };
  }
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

function objectField(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return value[key as keyof typeof value];
  }
  return undefined;
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
