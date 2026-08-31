import { describe, expect, it } from "vitest";

import { createCodexEventReducer } from "../src/providers/codex-events.js";

const SESSION = { threadId: "run-thread", turnId: "run-turn" };

function agentDelta(itemId: string, delta: string): Record<string, unknown> {
  return {
    method: "item/agentMessage/delta",
    params: { delta, itemId, threadId: "t1", turnId: "u1" }
  };
}

function turnCompleted(status: string): Record<string, unknown> {
  return {
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "u1", status } }
  };
}

function commandOutput(): Record<string, unknown> {
  return {
    method: "item/commandExecution/outputDelta",
    params: { threadId: "t1", turnId: "u1" }
  };
}

describe("createCodexEventReducer", () => {
  it("accumulates agent-message deltas into the completed turn result", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const first = reducer.reduce(agentDelta("a", "Hel"));
    expect(first.normalized).toMatchObject({ message: "Hel", type: "message" });
    reducer.reduce(agentDelta("a", "lo"));

    const done = reducer.reduce(turnCompleted("completed"));
    expect(done.normalized).toMatchObject({
      result: "Hello",
      status: "completed",
      type: "turn_completed"
    });
  });

  it("rate-limits progress markers below the minimum interval", () => {
    let clock = 0;
    const reducer = createCodexEventReducer({
      now: () => clock,
      session: () => SESSION
    });

    const emitted = reducer.reduce(commandOutput());
    expect(emitted.normalized).toMatchObject({
      signal: "command_output",
      type: "progress"
    });

    clock = 1_000;
    const suppressed = reducer.reduce(commandOutput());
    expect(suppressed.normalized).toBeUndefined();

    clock = 7_000;
    const emittedAgain = reducer.reduce(commandOutput());
    expect(emittedAgain.normalized).toMatchObject({ type: "progress" });
  });

  it("maps a willRetry error to a stream-retry progress marker, not a failure", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const event = reducer.reduce({
      method: "error",
      params: { error: { message: "Reconnecting" }, willRetry: true }
    });

    expect(event.normalized).toMatchObject({
      message: "Reconnecting",
      signal: "stream_retry",
      type: "progress"
    });
  });

  it("maps a non-retry error to turn_failed", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const event = reducer.reduce({
      method: "error",
      params: { error: { message: "boom" } }
    });

    expect(event.normalized).toMatchObject({
      message: "boom",
      type: "turn_failed"
    });
  });

  it("maps an input-required request to input_required carrying the request id", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const event = reducer.reduce({
      id: 7,
      method: "item/tool/requestUserInput",
      params: { prompt: "continue?" }
    });

    expect(event.normalized).toMatchObject({
      method: "item/tool/requestUserInput",
      requestId: 7,
      type: "input_required"
    });
  });

  it("falls back to the session thread/turn when a turn omits them", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const event = reducer.reduce({
      method: "turn/completed",
      params: { turn: { status: "completed" } }
    });

    expect(event.normalized).toMatchObject({
      threadId: "run-thread",
      turnId: "run-turn",
      type: "turn_completed"
    });
  });
});
