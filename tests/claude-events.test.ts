import { describe, expect, it } from "vitest";

import {
  createClaudeEventReducer,
  isTerminalFailure
} from "../src/providers/claude-events.js";

function initMessage(sessionId: string): Record<string, unknown> {
  return { session_id: sessionId, subtype: "init", type: "system" };
}

describe("createClaudeEventReducer", () => {
  it("carries the init session_id forward to later messages", () => {
    const reducer = createClaudeEventReducer();

    const started = reducer.reduce(initMessage("s1"));
    expect(started).toHaveLength(1);
    expect(started[0]?.normalized).toMatchObject({
      sessionId: "s1",
      type: "session_started"
    });

    const message = reducer.reduce({
      message: { content: [{ text: "hi", type: "text" }] },
      type: "assistant"
    });
    expect(message).toHaveLength(1);
    expect(message[0]?.normalized).toMatchObject({
      message: "hi",
      sessionId: "s1",
      type: "message"
    });
  });

  it("fans an assistant message out into text, tool, and usage events", () => {
    const reducer = createClaudeEventReducer();
    reducer.reduce(initMessage("s1"));

    const events = reducer.reduce({
      message: {
        content: [
          { text: "working", type: "text" },
          { id: "t-1", input: { path: "x" }, name: "Edit", type: "tool_use" }
        ],
        usage: { input_tokens: 5 }
      },
      type: "assistant"
    });

    expect(events.map((event) => event.normalized?.type)).toEqual([
      "message",
      "tool_call",
      "usage_updated"
    ]);
    expect(events[1]?.normalized).toMatchObject({
      toolCallId: "t-1",
      toolName: "Edit",
      type: "tool_call"
    });
  });

  it("maps an AskUserQuestion tool_use block to input_required", () => {
    const reducer = createClaudeEventReducer();

    const events = reducer.reduce({
      message: {
        content: [
          { id: "t-2", input: {}, name: "AskUserQuestion", type: "tool_use" }
        ]
      },
      type: "assistant"
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.normalized).toMatchObject({
      toolName: "AskUserQuestion",
      type: "input_required"
    });
  });

  it("maps a successful result to turn_completed", () => {
    const reducer = createClaudeEventReducer();
    reducer.reduce(initMessage("s1"));

    const events = reducer.reduce({
      duration_ms: 12,
      num_turns: 1,
      result: "done",
      subtype: "success",
      total_cost_usd: 0.01,
      type: "result"
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.normalized).toMatchObject({
      result: "done",
      sessionId: "s1",
      type: "turn_completed"
    });
  });

  it("maps an errored result to turn_failed", () => {
    const reducer = createClaudeEventReducer();

    const events = reducer.reduce({
      is_error: true,
      subtype: "error_max_turns",
      type: "result"
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.normalized).toMatchObject({
      subtype: "error_max_turns",
      type: "turn_failed"
    });
  });

  it("maps a stream_event text delta to a message", () => {
    const reducer = createClaudeEventReducer();

    const events = reducer.reduce({
      event: {
        delta: { text: "chunk", type: "text_delta" },
        type: "content_block_delta"
      },
      type: "stream_event"
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.normalized).toMatchObject({
      message: "chunk",
      type: "message"
    });
  });

  it("maps a top-level error message to turn_failed", () => {
    const reducer = createClaudeEventReducer();

    const events = reducer.reduce({
      error: { message: "boom" },
      type: "error"
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.normalized).toMatchObject({
      message: "boom",
      type: "turn_failed"
    });
  });

  it("maps a rate_limit message to rate_limit_updated", () => {
    const reducer = createClaudeEventReducer();

    const events = reducer.reduce({
      rate_limits: { remaining: 3 },
      type: "rate_limit"
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.normalized).toMatchObject({ type: "rate_limit_updated" });
  });

  it("passes an unknown message type through as raw only", () => {
    const reducer = createClaudeEventReducer();

    const events = reducer.reduce({ type: "mystery" });

    expect(events).toHaveLength(1);
    expect(events[0]?.normalized).toBeUndefined();
    expect(events[0]?.raw).toEqual({ type: "mystery" });
  });

  it("classifies terminal failures for the run loop", () => {
    expect(isTerminalFailure("turn_failed")).toBe(true);
    expect(isTerminalFailure("input_required")).toBe(true);
    expect(isTerminalFailure("malformed_event")).toBe(true);
    expect(isTerminalFailure("message")).toBe(false);
    expect(isTerminalFailure(undefined)).toBe(false);
  });
});
