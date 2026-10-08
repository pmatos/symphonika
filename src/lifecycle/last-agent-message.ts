import { open } from "node:fs/promises";

// Enough to hold the last message of a long run without reading a whole log.
const TAIL_BYTES = 256 * 1024;

// Events that carry no assistant text but interleave with streamed deltas
// (Codex emits usage/rate-limit updates between them), so they must not split
// one message into two.
const TRANSPARENT_EVENT_TYPES = new Set([
  "rate_limit_updated",
  "usage_updated"
]);

// The agent's last assistant message from a Normalized Event log. Codex and
// Oh My Pi stream a message as many `message` deltas while Claude emits whole
// text blocks, so a message is the run of consecutive non-thinking `message`
// events not interrupted by a tool call or turn boundary. Only a bounded tail
// of the log is read; undefined when there is no message or no readable log.
export async function readLastAgentMessage(
  normalizedLogPath: string
): Promise<string | undefined> {
  let tail: string;
  try {
    tail = await readTail(normalizedLogPath);
  } catch {
    return undefined;
  }

  let current = "";
  let last: string | undefined;
  const close = (): void => {
    if (current.trim() !== "") {
      last = current;
    }
    current = "";
  };

  for (const line of tail.split("\n")) {
    const event = parseEvent(line);
    if (event === undefined) {
      continue;
    }
    if (event.type === "message") {
      if (
        event.messageKind !== "thinking" &&
        typeof event.message === "string"
      ) {
        current += event.message;
      }
    } else if (
      typeof event.type === "string" &&
      !TRANSPARENT_EVENT_TYPES.has(event.type)
    ) {
      close();
    }
  }
  close();

  return last?.trim();
}

async function readTail(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8", 0, bytesRead);
    if (start === 0) {
      return text;
    }
    // A tail that starts mid-file begins inside a line; drop that fragment.
    // Byte start-1 tells whether the window opened on a line boundary.
    const prior = Buffer.alloc(1);
    await handle.read(prior, 0, 1, start - 1);
    if (prior[0] === 0x0a) {
      return text;
    }
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

function parseEvent(
  line: string
): { message?: unknown; messageKind?: unknown; type?: unknown } | undefined {
  if (line.trim() === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
