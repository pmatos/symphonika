import { describe, expect, it } from "vitest";

import { createCodexEventReducer } from "../src/providers/codex-events.js";

const SESSION = { threadId: "t1", turnId: "u1" };

function agentDelta(
  itemId: string,
  delta: string,
  threadId = "t1"
): Record<string, unknown> {
  return {
    method: "item/agentMessage/delta",
    params: { delta, itemId, threadId, turnId: "u1" }
  };
}

function turnCompleted(
  status: string,
  threadId = "t1"
): Record<string, unknown> {
  return {
    method: "turn/completed",
    params: { threadId, turn: { id: "u1", status } }
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
      threadId: "t1",
      turnId: "u1",
      type: "turn_completed"
    });
  });

  it("ignores a subagent thread's turn completion so the root turn keeps running", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const subagentDone = reducer.reduce(turnCompleted("completed", "sub-1"));
    expect(subagentDone.normalized).toBeUndefined();

    const rootDone = reducer.reduce(turnCompleted("completed"));
    expect(rootDone.normalized).toMatchObject({
      threadId: "t1",
      type: "turn_completed"
    });
  });

  it("ignores a subagent thread's failed turn and non-retry error", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    expect(
      reducer.reduce(turnCompleted("failed", "sub-1")).normalized
    ).toBeUndefined();
    expect(
      reducer.reduce({
        method: "error",
        params: { error: { message: "boom" }, threadId: "sub-1" }
      }).normalized
    ).toBeUndefined();
  });

  it("keeps a subagent retry visible as progress without ending the root turn", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const retry = reducer.reduce({
      method: "error",
      params: {
        error: { message: "Reconnecting" },
        threadId: "sub-1",
        willRetry: true
      }
    });
    expect(retry.normalized).toMatchObject({
      signal: "stream_retry",
      threadId: "sub-1",
      type: "progress"
    });
    expect(reducer.reduce(turnCompleted("completed")).normalized).toMatchObject(
      {
        type: "turn_completed"
      }
    );
  });

  it("does not let a subagent's message become the root turn result", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    reducer.reduce(agentDelta("root-msg", "root answer"));
    reducer.reduce(agentDelta("sub-msg", "scan summary", "sub-1"));

    const done = reducer.reduce(turnCompleted("completed"));
    expect(done.normalized).toMatchObject({ result: "root answer" });
  });

  it("treats subagent prose as progress rather than report text", () => {
    const reducer = createCodexEventReducer({
      now: () => 0,
      session: () => SESSION
    });

    const subagent = reducer.reduce(
      agentDelta("sub-msg", "scan summary", "sub-1")
    );
    expect(subagent.normalized).toMatchObject({
      signal: "subagent_message",
      threadId: "sub-1",
      type: "progress"
    });
    expect(
      reducer.reduce(turnCompleted("completed")).normalized
    ).not.toHaveProperty("result");
  });
});
