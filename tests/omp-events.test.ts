import { describe, expect, it } from "vitest";

import {
  createOmpEventReducer,
  type OmpEventReducer
} from "../src/providers/omp-events.js";

function startSession(
  reducer: OmpEventReducer,
  sessionId: string = "omp-session"
) {
  return reducer.reduce(
    {
      data: {
        model: { id: "gpt-5.4", provider: "openai" },
        sessionFile: "/tmp/omp-session.jsonl",
        sessionId
      },
      success: true,
      type: "response"
    },
    "get_state"
  );
}

describe("createOmpEventReducer", () => {
  it("maps get_state and carries the session id into later frames", () => {
    const reducer = createOmpEventReducer();

    expect(startSession(reducer).normalized).toEqual({
      model: "openai/gpt-5.4",
      sessionFile: "/tmp/omp-session.jsonl",
      sessionId: "omp-session",
      type: "session_started"
    });
    expect(reducer.reduce({ type: "agent_start" }).normalized).toEqual({
      sessionId: "omp-session",
      signal: "agent_start",
      type: "progress"
    });
  });

  it("accumulates assistant text into one turn result and consumes it", () => {
    const reducer = createOmpEventReducer();
    startSession(reducer);

    reducer.reduce({
      assistantMessageEvent: { delta: "Hel", type: "text_delta" },
      type: "message_update"
    });
    reducer.reduce({
      assistantMessageEvent: { delta: "private", type: "thinking_delta" },
      type: "message_update"
    });
    reducer.reduce({
      assistantMessageEvent: { delta: "lo", type: "text_delta" },
      type: "message_update"
    });
    reducer.reduce({ message: { role: "assistant" }, type: "message_end" });

    expect(reducer.reduce({ type: "turn_end" }).normalized).toEqual({
      result: "Hello",
      sessionId: "omp-session",
      type: "turn_completed"
    });
    expect(reducer.reduce({ type: "turn_end" }).normalized).toEqual({
      sessionId: "omp-session",
      type: "turn_completed"
    });
  });

  it("maps assistant usage and tool calls with the carried session", () => {
    const reducer = createOmpEventReducer();
    startSession(reducer, "s1");

    expect(
      reducer.reduce({
        message: {
          role: "assistant",
          usage: {
            cacheRead: 2,
            cacheWrite: 3,
            input: 11,
            output: 7,
            totalTokens: 23
          }
        },
        type: "message_end"
      }).normalized
    ).toEqual({
      sessionId: "s1",
      tokenUsage: {
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 23
      },
      type: "usage_updated"
    });
    expect(
      reducer.reduce({
        args: { cmd: "npm test" },
        toolCallId: "tool-1",
        toolName: "bash",
        type: "tool_execution_start"
      }).normalized
    ).toEqual({
      input: { cmd: "npm test" },
      sessionId: "s1",
      toolCallId: "tool-1",
      toolName: "bash",
      type: "tool_call"
    });
  });

  it("maps supported interactive requests to input_required", () => {
    const reducer = createOmpEventReducer();
    startSession(reducer, "s1");

    expect(
      reducer.reduce({
        id: "ui-1",
        method: "input",
        title: "Choose a release channel",
        type: "extension_ui_request"
      }).normalized
    ).toEqual({
      instructions: undefined,
      message: undefined,
      method: "input",
      requestId: "ui-1",
      sessionId: "s1",
      title: "Choose a release channel",
      type: "input_required",
      url: undefined
    });
    expect(
      reducer.reduce({ method: "notify", type: "extension_ui_request" })
        .normalized
    ).toBeUndefined();
  });

  it("accepts a prompt response without data and rejects explicit false", () => {
    const reducer = createOmpEventReducer();

    expect(
      reducer.reduce({ success: true, type: "response" }, "prompt").normalized
    ).toBeUndefined();
    expect(
      reducer.reduce(
        {
          data: { agentInvoked: false },
          success: true,
          type: "response"
        },
        "prompt"
      ).normalized
    ).toEqual({
      command: "prompt",
      message: "Oh My Pi did not invoke an agent for the prompt",
      type: "turn_failed"
    });
  });

  it("requires protocol v2 for a successful negotiation", () => {
    const reducer = createOmpEventReducer();

    expect(
      reducer.reduce(
        {
          data: { protocolVersion: 1 },
          success: true,
          type: "response"
        },
        "negotiate_protocol"
      ).normalized
    ).toEqual({
      command: "negotiate_protocol",
      message: "Oh My Pi did not confirm RPC protocol v2",
      type: "turn_failed"
    });
    expect(
      reducer.reduce(
        {
          data: { protocolVersion: 2 },
          success: true,
          type: "response"
        },
        "negotiate_protocol"
      ).normalized
    ).toBeUndefined();
  });

  it("preserves the provider-authored command on failed responses", () => {
    const reducer = createOmpEventReducer();

    expect(
      reducer.reduce(
        {
          command: "reported-command",
          error: "session busy",
          success: false,
          type: "response"
        },
        "prompt"
      ).normalized
    ).toEqual({
      command: "reported-command",
      message: "session busy",
      type: "turn_failed"
    });
  });

  it("maps provider errors and passes unknown frames through as raw only", () => {
    const reducer = createOmpEventReducer();
    const raw = { payload: true, type: "unknown" };

    expect(
      reducer.reduce({ level: "error", message: "boom", type: "notice" })
        .normalized
    ).toEqual({ message: "boom", type: "turn_failed" });
    expect(reducer.reduce(raw)).toEqual({ raw });
  });
});
