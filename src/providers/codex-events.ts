import type { ProviderEvent } from "../provider.js";
import {
  booleanField,
  objectField,
  responseId,
  stringArrayField,
  stringField,
  type JsonObject
} from "./codex-json.js";

// Codex streams command output and workspace diffs as high-frequency
// notifications: one recorded run emitted 563 output deltas and 84 diff
// updates. Each normalized event costs a Normalized Event Log line and a
// `provider_events` row holding the raw notification verbatim, so emitting a
// marker per notification would put whole build transcripts and diffs in the
// run store. The Watchdog only needs one marker per sample window (60 s by
// default), so markers are rate-limited well below that (ADR 0087).
const PROGRESS_MARKER_MIN_INTERVAL_MS = 5_000;

type CodexProgressSignal =
  "command_output" | "stream_retry" | "terminal_interaction" | "workspace_diff";

// The thread/turn identity the *provider* owns: written by session/turn setup
// and read back by `cancel()`. The reducer only ever reads it, so it crosses
// the seam as a read-only snapshot rather than mutable state the reducer holds.
// Both fields are always present but may be undefined before the thread and
// turn have started, matching the `?? session.threadId` fallbacks below.
type CodexTurnContext = {
  threadId: string | undefined;
  turnId: string | undefined;
};

export type CodexEventReducer = {
  reduce: (raw: unknown) => ProviderEvent;
};

// A stateful reducer over one Codex run's JSON-RPC message stream. The only
// mapping state — the in-progress agent message being accumulated from deltas,
// and the last progress-marker timestamp used for rate-limiting — lives in the
// closure, so no caller can name or mutate it; the provider passes `now` (for
// deterministic tests) and a read-only view of the run's thread/turn identity.
export function createCodexEventReducer(deps: {
  now: () => number;
  session: () => CodexTurnContext;
}): CodexEventReducer {
  let lastAgentMessage:
    { itemId: string | undefined; text: string } | undefined;
  let lastProgressMarkerAtMs: number | undefined;

  function progressMarkerEvent(
    raw: unknown,
    params: JsonObject | undefined,
    session: CodexTurnContext,
    signal: CodexProgressSignal
  ): ProviderEvent {
    const nowMs = deps.now();
    const previous = lastProgressMarkerAtMs;
    if (
      previous !== undefined &&
      nowMs - previous < PROGRESS_MARKER_MIN_INTERVAL_MS
    ) {
      return { raw };
    }
    lastProgressMarkerAtMs = nowMs;
    return {
      normalized: {
        signal,
        threadId: stringField(params, "threadId") ?? session.threadId,
        turnId: stringField(params, "turnId") ?? session.turnId,
        type: "progress"
      },
      raw
    };
  }

  function reduce(raw: unknown): ProviderEvent {
    const session = deps.session();
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
      const delta = stringField(params, "delta") ?? "";
      const itemId = stringField(params, "itemId");
      if (
        lastAgentMessage !== undefined &&
        lastAgentMessage.itemId === itemId
      ) {
        lastAgentMessage.text += delta;
      } else {
        lastAgentMessage = { itemId, text: delta };
      }
      return {
        normalized: {
          message: delta,
          threadId: stringField(params, "threadId"),
          turnId: stringField(params, "turnId"),
          type: "message"
        },
        raw
      };
    }

    if (method === "item/started") {
      const item = objectField(params, "item");
      const itemType = stringField(item, "type");
      if (itemType === "reasoning") {
        return thinkingEvent(raw, params, item, session, deps.now(), "started");
      }
      const toolCallInput =
        itemType === undefined ? undefined : codexToolCallInput(itemType, item);
      if (toolCallInput === undefined) {
        return { raw };
      }
      // Codex reports tool activity as typed items rather than a dedicated tool
      // event, so the started item is the analogue of Claude's `tool_use` block:
      // it marks the moment the model issued the call. Without this mapping the
      // Watchdog's `last_tool_call_at` progress signal is permanently null for
      // Codex runs (ADR 0054 signal 1).
      return {
        normalized: {
          input: toolCallInput,
          threadId: stringField(params, "threadId"),
          toolCallId: stringField(item, "id"),
          toolName: itemType,
          turnId: stringField(params, "turnId"),
          type: "tool_call"
        },
        raw
      };
    }

    if (method === "turn/plan/updated") {
      // Unlike command output, the plan is compact operator-facing state worth
      // preserving in the Normalized Event Log. Status spelling is normalized
      // here so operator surfaces never depend on Codex wire values (ADR 0096).
      return {
        normalized: {
          explanation: stringField(params, "explanation") ?? null,
          plan: codexPlan(params?.plan),
          threadId: stringField(params, "threadId") ?? session.threadId,
          turnId: stringField(params, "turnId") ?? session.turnId,
          type: "plan_updated"
        },
        raw
      };
    }

    // Codex reports a running command's stdout/stderr, terminal interaction,
    // and the evolving workspace diff as notifications rather than items. All
    // three are direct evidence the Run is alive during a long build or test
    // suite. Only a timestamped marker is normalized; command and terminal
    // payloads plus the diff stay in the raw log (ADRs 0087 and 0096).
    if (
      method === "item/commandExecution/outputDelta" ||
      method === "item/commandExecution/terminalInteraction" ||
      method === "turn/diff/updated"
    ) {
      return progressMarkerEvent(
        raw,
        params,
        session,
        method === "turn/diff/updated"
          ? "workspace_diff"
          : method === "item/commandExecution/terminalInteraction"
            ? "terminal_interaction"
            : "command_output"
      );
    }

    if (method === "item/completed") {
      const item = objectField(params, "item");
      if (stringField(item, "type") === "reasoning") {
        return thinkingEvent(
          raw,
          params,
          item,
          session,
          deps.now(),
          "completed"
        );
      }
      const phase = stringField(item, "phase");
      if (
        stringField(item, "type") === "agentMessage" &&
        (phase === undefined || phase === "final_answer")
      ) {
        lastAgentMessage = {
          itemId: stringField(item, "id"),
          text: stringField(item, "text") ?? ""
        };
      }
      return { raw };
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
      const turnId = stringField(turn, "id") ?? session.turnId;
      const threadId = stringField(params, "threadId") ?? session.threadId;

      if (status === "completed") {
        return {
          normalized: {
            ...(lastAgentMessage === undefined
              ? {}
              : { result: lastAgentMessage.text }),
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
      const message = stringField(error, "message") ?? "Codex provider error";
      const threadId = stringField(params, "threadId") ?? session.threadId;
      const turnId = stringField(params, "turnId") ?? session.turnId;

      // Codex reports a transient stream drop as an `error` notification it will
      // recover from itself, flagged `willRetry: true` ("Reconnecting... 2/5").
      // Treating it as terminal killed the process at the exact moment codex was
      // telling us it was still alive, inside its own
      // stream_idle_timeout_ms x stream_max_retries budget (ADR 0088). Only a
      // retry codex will not make itself ends the turn.
      if (booleanField(params, "willRetry") === true) {
        const signal: CodexProgressSignal = "stream_retry";
        return {
          normalized: {
            message,
            signal,
            threadId,
            turnId,
            type: "progress"
          },
          raw
        };
      }

      return {
        normalized: {
          message,
          threadId,
          turnId,
          type: "turn_failed"
        },
        raw
      };
    }

    return {
      raw
    };
  }

  return { reduce };
}

function thinkingEvent(
  raw: unknown,
  params: JsonObject | undefined,
  item: JsonObject | undefined,
  session: CodexTurnContext,
  nowMs: number,
  status: "completed" | "started"
): ProviderEvent {
  return {
    normalized: {
      itemId: stringField(item, "id"),
      status,
      summary: stringArrayField(item, "summary"),
      threadId: stringField(params, "threadId") ?? session.threadId,
      timestamp: new Date(nowMs).toISOString(),
      turnId: stringField(params, "turnId") ?? session.turnId,
      type: "thinking"
    },
    raw
  };
}

export function jsonRpcErrorEvent(raw: unknown): ProviderEvent {
  const error = objectField(raw, "error");
  return {
    normalized: {
      message: stringField(error, "message") ?? "Codex JSON-RPC error",
      type: "turn_failed"
    },
    raw
  };
}

function isInputRequiredMethod(method: string): boolean {
  return (
    method === "item/tool/requestUserInput" ||
    method === "mcpServer/elicitation/request" ||
    method.endsWith("/requestApproval")
  );
}

export function isTerminalFailure(type: string | undefined): boolean {
  return (
    type === "input_required" ||
    type === "malformed_event" ||
    type === "turn_failed"
  );
}

function codexToolCallInput(
  itemType: string,
  item: JsonObject | undefined
): JsonObject | undefined {
  if (item === undefined) {
    return undefined;
  }
  if (itemType === "commandExecution") {
    return {
      command: stringField(item, "command"),
      cwd: stringField(item, "cwd")
    };
  }
  if (itemType === "fileChange") {
    const changes = item.changes;
    return {
      paths: Array.isArray(changes)
        ? changes
            .map((change) => stringField(change, "path"))
            .filter(
              (changePath): changePath is string => changePath !== undefined
            )
        : []
    };
  }
  if (itemType === "webSearch") {
    return { query: stringField(item, "query") };
  }

  return undefined;
}

function codexPlan(value: unknown): Array<{ status: string; step: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const step = stringField(item, "step");
    if (step === undefined) {
      return [];
    }
    return [
      {
        status: codexPlanStatus(stringField(item, "status")),
        step
      }
    ];
  });
}

function codexPlanStatus(status: string | undefined): string {
  if (status === "inProgress") {
    return "in_progress";
  }
  if (status === "completed" || status === "pending") {
    return status;
  }
  return "unknown";
}
