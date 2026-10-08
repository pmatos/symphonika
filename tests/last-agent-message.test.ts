import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLastAgentMessage } from "../src/lifecycle/last-agent-message.js";

const jsonl = (...events: Array<Record<string, unknown>>): string[] =>
  events.map((event) => JSON.stringify(event));

describe("readLastAgentMessage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "last-agent-message-"));
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function readFromLines(lines: string[]): Promise<string | undefined> {
    const file = path.join(dir, "provider.normalized.jsonl");
    await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    return readLastAgentMessage(file);
  }

  it("concatenates streamed deltas up to the next boundary event", async () => {
    const lines = jsonl(
      { type: "message", message: "first" },
      { type: "tool_call", name: "bash" },
      { type: "message", message: "I’m " },
      { type: "usage_updated" },
      { type: "message", message: "done" },
      { type: "rate_limit_updated" },
      { type: "message", message: "." }
    );
    expect(await readFromLines(lines)).toBe("I’m done.");
  });

  it("ignores thinking deltas", async () => {
    const lines = jsonl(
      { type: "message", message: "answer", messageKind: "text" },
      { type: "message", message: "hmm", messageKind: "thinking" }
    );
    expect(await readFromLines(lines)).toBe("answer");
  });

  it("falls back to the previous message when the log ends on a boundary", async () => {
    const lines = jsonl(
      { type: "message", message: "push failed" },
      { type: "tool_call", name: "bash" },
      { type: "turn_completed" }
    );
    expect(await readFromLines(lines)).toBe("push failed");
  });

  it("skips malformed lines and returns undefined for no messages", async () => {
    expect(await readFromLines(["{not json", ""])).toBeUndefined();
    expect(
      await readFromLines(jsonl({ type: "message", message: "  " }))
    ).toBeUndefined();
  });

  it("returns undefined for a missing file", async () => {
    expect(
      await readLastAgentMessage(path.join(dir, "missing.jsonl"))
    ).toBeUndefined();
  });

  it("reads only a bounded tail of a large log", async () => {
    const filler = jsonl(
      ...Array.from({ length: 20000 }, () => ({
        type: "message",
        message: "x".repeat(40)
      })),
      { type: "tool_call" },
      { type: "message", message: "the end" }
    ).join("\n");
    const file = path.join(dir, "provider.normalized.jsonl");
    await writeFile(file, `${filler}\n`, "utf8");
    expect(await readLastAgentMessage(file)).toBe("the end");
  });
});
