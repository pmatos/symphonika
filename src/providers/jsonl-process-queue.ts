// Shared line-delimited JSON (JSONL) reader for stream-json providers. The
// Claude and Codex adapters each spawn a child that emits one JSON object per
// line on stdout; both consumed that stream — and mapped its non-protocol
// error/exit/malformed items to ProviderEvents — with byte-identical code.
// Keeping a single implementation means the stdout framing and the control
// events those providers surface stay defined in one place rather than drifting
// between adapters. The Oh My Pi provider frames its own protocol differently
// and keeps its own queue.

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { ProviderEvent } from "../provider.js";
import { providerProcessExitResult } from "./provider-process.js";

// Non-message queue items: the process lifecycle and framing outcomes that map
// to ProviderEvents without any provider-specific protocol knowledge.
export type ProcessQueueControlItem =
  | {
      kind: "exit";
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      error: Error;
      kind: "error";
    }
  | {
      kind: "malformed";
      line: string;
      message: string;
    };

export type ProcessQueueItem =
  | ProcessQueueControlItem
  | {
      kind: "message";
      raw: unknown;
    };

export type ProcessQueue = {
  next: () => Promise<ProcessQueueItem>;
};

export function createJsonlProcessQueue(
  child: ChildProcessWithoutNullStreams
): ProcessQueue {
  const pending: ProcessQueueItem[] = [];
  let waiting: ((item: ProcessQueueItem) => void) | undefined;
  let stdoutBuffer = "";

  const push = (item: ProcessQueueItem): void => {
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      resolve(item);
      return;
    }

    pending.push(item);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trimEnd();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      pushLine(line, push);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer.length > 0) {
      pushLine(stdoutBuffer.trimEnd(), push);
      stdoutBuffer = "";
    }
  });
  child.once("error", (error) => {
    push({
      error,
      kind: "error"
    });
  });
  child.once("close", (exitCode, signal) => {
    const result = providerProcessExitResult(child, exitCode, signal);
    push({
      exitCode: result.exitCode,
      kind: "exit",
      signal: result.signal
    });
  });

  return {
    next: () => {
      const item = pending.shift();
      if (item !== undefined) {
        return Promise.resolve(item);
      }

      return new Promise<ProcessQueueItem>((resolve) => {
        waiting = resolve;
      });
    }
  };
}

function pushLine(line: string, push: (item: ProcessQueueItem) => void): void {
  if (line.trim().length === 0) {
    return;
  }

  try {
    push({
      kind: "message",
      raw: JSON.parse(line) as unknown
    });
  } catch (error) {
    push({
      kind: "malformed",
      line,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

// Maps a non-message queue item to its ProviderEvent. `cancelled` is passed by
// the caller at map time (never captured earlier): cancel() flips the run's
// flag mid-stream, and the exit event must report the post-cancellation value.
export function mapProcessQueueControlEvent(
  item: ProcessQueueControlItem,
  cancelled: boolean
): ProviderEvent {
  switch (item.kind) {
    case "error":
      return {
        normalized: {
          message: item.error.message,
          type: "turn_failed"
        },
        raw: {
          kind: "process_error",
          message: item.error.message
        }
      };
    case "exit":
      return {
        normalized: {
          cancelled,
          exitCode: item.exitCode,
          signal: item.signal,
          type: "process_exit"
        },
        raw: {
          cancelled,
          exitCode: item.exitCode,
          kind: "process_exit",
          signal: item.signal
        }
      };
    case "malformed":
      return {
        normalized: {
          line: item.line,
          message: item.message,
          type: "malformed_event"
        },
        raw: {
          kind: "malformed_json",
          line: item.line,
          message: item.message
        }
      };
  }
}
