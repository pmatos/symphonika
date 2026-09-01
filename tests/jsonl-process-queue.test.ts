import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  createJsonlProcessQueue,
  mapProcessQueueControlEvent,
  type ProcessQueueControlItem
} from "../src/providers/jsonl-process-queue.js";

// A ChildProcessWithoutNullStreams stand-in: the queue only touches
// child.stdout (setEncoding + data/end) and child.once(error|close), so a pair
// of EventEmitters is enough to drive every branch without spawning anything.
function fakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdout: EventEmitter;
} {
  const stdout = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn()
  });
  const child = Object.assign(new EventEmitter(), {
    stdout
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdout };
}

describe("mapProcessQueueControlEvent", () => {
  it("maps a spawn error to a turn_failed event", () => {
    const item: ProcessQueueControlItem = {
      error: new Error("boom"),
      kind: "error"
    };

    expect(mapProcessQueueControlEvent(item, false)).toEqual({
      normalized: {
        message: "boom",
        type: "turn_failed"
      },
      raw: {
        kind: "process_error",
        message: "boom"
      }
    });
  });

  it("maps an exit to a process_exit event carrying exit code, signal and cancelled=false", () => {
    const item: ProcessQueueControlItem = {
      exitCode: 0,
      kind: "exit",
      signal: null
    };

    expect(mapProcessQueueControlEvent(item, false)).toEqual({
      normalized: {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      },
      raw: {
        cancelled: false,
        exitCode: 0,
        kind: "process_exit",
        signal: null
      }
    });
  });

  it("propagates cancelled=true into both the normalized and raw exit event", () => {
    const item: ProcessQueueControlItem = {
      exitCode: null,
      kind: "exit",
      signal: "SIGTERM"
    };

    expect(mapProcessQueueControlEvent(item, true)).toEqual({
      normalized: {
        cancelled: true,
        exitCode: null,
        signal: "SIGTERM",
        type: "process_exit"
      },
      raw: {
        cancelled: true,
        exitCode: null,
        kind: "process_exit",
        signal: "SIGTERM"
      }
    });
  });

  it("maps a malformed line to a malformed_event carrying the raw line", () => {
    const item: ProcessQueueControlItem = {
      kind: "malformed",
      line: "{ not json",
      message: "Unexpected token"
    };

    expect(mapProcessQueueControlEvent(item, false)).toEqual({
      normalized: {
        line: "{ not json",
        message: "Unexpected token",
        type: "malformed_event"
      },
      raw: {
        kind: "malformed_json",
        line: "{ not json",
        message: "Unexpected token"
      }
    });
  });

  it("reads cancelled at call time, not from a value captured earlier", async () => {
    // Mirrors how providers consume the queue: activeRun.cancelled can flip
    // between yielding a message item and the exit item (cancel() sets it
    // mid-run), and the exit event must observe the post-cancellation value.
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);
    const activeRun = { cancelled: false };

    stdout.emit("data", '{"type":"assistant"}\n');
    const first = await queue.next();
    expect(first.kind).toBe("message");

    activeRun.cancelled = true;
    child.emit("close", 143, null);
    const second = await queue.next();
    if (second.kind === "message") {
      throw new Error("expected a control item");
    }

    expect(mapProcessQueueControlEvent(second, activeRun.cancelled)).toEqual({
      normalized: {
        cancelled: true,
        exitCode: 143,
        signal: null,
        type: "process_exit"
      },
      raw: {
        cancelled: true,
        exitCode: 143,
        kind: "process_exit",
        signal: null
      }
    });
  });
});

describe("createJsonlProcessQueue", () => {
  it("parses each newline-delimited JSON line into a message item", async () => {
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    stdout.emit("data", '{"a":1}\n{"b":2}\n');

    expect(await queue.next()).toEqual({
      kind: "message",
      raw: { a: 1 },
      receivedAt: expect.any(String) as string
    });
    expect(await queue.next()).toEqual({
      kind: "message",
      raw: { b: 2 },
      receivedAt: expect.any(String) as string
    });
  });

  it("reassembles a line delivered across multiple data chunks", async () => {
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    stdout.emit("data", '{"split"');
    stdout.emit("data", ":true}\n");

    expect(await queue.next()).toEqual({
      kind: "message",
      raw: { split: true },
      receivedAt: expect.any(String) as string
    });
  });

  it("flushes a trailing line without a newline when stdout ends", async () => {
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    stdout.emit("data", '{"tail":true}');
    stdout.emit("end");

    expect(await queue.next()).toEqual({
      kind: "message",
      raw: { tail: true },
      receivedAt: expect.any(String) as string
    });
  });

  it("ignores blank lines", async () => {
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    stdout.emit("data", '\n   \n{"kept":1}\n');

    expect(await queue.next()).toEqual({
      kind: "message",
      raw: { kept: 1 },
      receivedAt: expect.any(String) as string
    });
  });

  it("emits a malformed item for a line that is not valid JSON, trimming trailing whitespace", async () => {
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    // Trailing spaces and a CR before the newline must be stripped from the
    // echoed line so operators see the payload, not framing artefacts.
    stdout.emit("data", "not json  \r\n");

    const item = await queue.next();
    expect(item.kind).toBe("malformed");
    if (item.kind !== "malformed") {
      throw new Error("expected malformed item");
    }
    expect(item.line).toBe("not json");
    expect(item.message.length).toBeGreaterThan(0);
  });

  it("trims the trailing unterminated line and does not re-flush the buffer on a second end", async () => {
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    stdout.emit("data", "not json  \r");
    stdout.emit("end");

    const flushed = await queue.next();
    expect(flushed.kind).toBe("malformed");
    if (flushed.kind !== "malformed") {
      throw new Error("expected malformed item");
    }
    expect(flushed.line).toBe("not json");

    // A second end must not re-emit the already-flushed (now cleared) buffer;
    // the next item is the exit, not a duplicate malformed line.
    stdout.emit("end");
    child.emit("close", 0, null);
    expect(await queue.next()).toEqual({
      exitCode: 0,
      kind: "exit",
      signal: null,
      receivedAt: expect.any(String) as string
    });
  });

  it("emits an error item when the child errors", async () => {
    const { child } = fakeChild();
    const queue = createJsonlProcessQueue(child);
    const error = new Error("spawn failed");

    child.emit("error", error);

    expect(await queue.next()).toEqual({
      error,
      kind: "error",
      receivedAt: expect.any(String) as string
    });
  });

  it("emits an exit item carrying the exit code and signal on close", async () => {
    const { child } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    child.emit("close", 2, null);

    expect(await queue.next()).toEqual({
      exitCode: 2,
      kind: "exit",
      signal: null,
      receivedAt: expect.any(String) as string
    });
  });

  it("resolves a pending next() once an item arrives later", async () => {
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    const pending = queue.next();
    stdout.emit("data", '{"late":true}\n');

    expect(await pending).toEqual({
      kind: "message",
      raw: { late: true },
      receivedAt: expect.any(String) as string
    });
  });

  it("stamps receivedAt at push time, not when a busy consumer finally calls next()", async () => {
    // The regression this guards: a consumer that awaits a slow write before
    // requesting the next item must not see that wait folded into the next
    // item's own receipt time. Both items below are pushed five minutes
    // apart while nothing has called next() yet -- exactly the "N and N+1
    // both already queued before N is consumed" shape a slow persist creates
    // upstream in run-controller.ts.
    const { child, stdout } = fakeChild();
    const queue = createJsonlProcessQueue(child);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      stdout.emit("data", '{"a":1}\n');

      vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
      stdout.emit("data", '{"b":2}\n');

      // The consumer only gets around to asking for either item well after
      // both arrived.
      vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));

      const first = await queue.next();
      const second = await queue.next();

      expect(first.receivedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(second.receivedAt).toBe("2026-01-01T00:05:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
