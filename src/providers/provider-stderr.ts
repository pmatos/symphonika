// Provider stderr is the only channel a CLI has for the things it says on the
// way down — auth warnings, retry notices, spawn failures — and none of it is
// framed as a protocol event, so the JSONL queues never see it. Draining it to
// nowhere (`child.stderr.resume()`) left a killed provider with no recoverable
// explanation at all; see issue #604 and the #603 incident it came from.
//
// The tee below writes the HEAD of the stream, not a rolling tail: every byte
// it keeps is on disk the moment it arrives, so an orchestrator that is itself
// killed still leaves the evidence behind. A rolling tail would buy the last
// words of a very chatty provider at the cost of losing everything when the
// flush never runs, which is exactly the case this file exists to serve.

import { createWriteStream, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

// A disk guard, not a diagnostic budget: real providers write kilobytes here.
export const PROVIDER_STDERR_LOG_MAX_BYTES = 1_048_576;
const PROVIDER_STDERR_TAIL_BYTES = 4_096;
// terminal_reason is rendered on one CLI line and in notification digests, so
// the surfaced excerpt stays short enough not to swamp them.
const PROVIDER_STDERR_REASON_CHARS = 200;

// The stderr log is a sibling of the attempt's raw log and shares its
// attempt suffix, so the two are derived from one another rather than being
// stored and threaded independently through the run/attempt/firing rows.
// `provider.raw.jsonl` -> `provider.stderr.log`
// `provider.raw.attempt-2.jsonl` -> `provider.stderr.attempt-2.log`
export function providerStderrLogPath(rawLogPath: string): string {
  const directory = path.dirname(rawLogPath);
  const base = path.basename(rawLogPath);
  const suffix = /^provider\.raw(?<attempt>\.attempt-\d+)?\.jsonl$/u.exec(base)
    ?.groups?.attempt;
  return path.join(directory, `provider.stderr${suffix ?? ""}.log`);
}

// Replaces `child.stderr.resume()`: the stream is always drained (a paused
// stderr would eventually block the provider on a full pipe) and, when an
// evidence path is known, teed to it. The file is created on the first byte,
// so "no file" means "the provider wrote nothing", not "nobody was looking".
export function attachProviderStderrLog(
  child: ChildProcessWithoutNullStreams,
  filePath: string | undefined,
  maxBytes: number = PROVIDER_STDERR_LOG_MAX_BYTES
): void {
  if (filePath === undefined) {
    child.stderr.resume();
    return;
  }

  let sink: WriteStream | undefined;
  let written = 0;
  let capped = false;
  let failed = false;

  const write = (chunk: Buffer): void => {
    if (failed || capped || chunk.length === 0) {
      return;
    }
    if (sink === undefined) {
      sink = createWriteStream(filePath, { flags: "a" });
      // Evidence capture is best-effort: an unwritable state directory must
      // not take the run down with it.
      sink.on("error", () => {
        failed = true;
      });
    }
    const remaining = maxBytes - written;
    if (chunk.length <= remaining) {
      written += chunk.length;
      sink.write(chunk);
      return;
    }
    capped = true;
    if (remaining > 0) {
      written += remaining;
      sink.write(chunk.subarray(0, remaining));
    }
    sink.write(
      `\n[symphonika] provider stderr truncated at ${maxBytes} bytes\n`
    );
  };

  child.stderr.on("data", write);
  const close = (): void => {
    sink?.end();
    sink = undefined;
  };
  // `end` covers an ordinary EOF; `close` covers forceKillProviderProcess
  // destroying the stream, which skips `end` entirely.
  child.stderr.once("end", close);
  child.stderr.once("close", close);
}

// Reads the last bytes of the log. The tee writes the head, so for any
// provider that stayed under the cap this is the true tail — the part that
// explains why it stopped.
export async function readProviderStderrTail(
  filePath: string,
  maxBytes: number = PROVIDER_STDERR_TAIL_BYTES
): Promise<string | undefined> {
  try {
    const handle = await open(filePath, "r");
    try {
      const size = (await handle.stat()).size;
      if (size === 0) {
        return undefined;
      }
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8").trim();
      return text.length === 0 ? undefined : text;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

// Collapses the excerpt onto one line: terminal_reason is a single-line field
// everywhere it is displayed.
function formatProviderStderrReason(
  tail: string | undefined
): string | undefined {
  if (tail === undefined) {
    return undefined;
  }
  const collapsed = tail.replaceAll(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  const excerpt =
    collapsed.length > PROVIDER_STDERR_REASON_CHARS
      ? `${collapsed.slice(collapsed.length - PROVIDER_STDERR_REASON_CHARS)}`
      : collapsed;
  return `stderr: ${excerpt}`;
}

// Appends the provider's last words to a reason that would otherwise carry no
// explanation at all (`process_exit_137`, `firing_timeout`). Returns the reason
// unchanged when the provider said nothing, so silent runs keep the exact
// reason strings callers already match on.
export async function withProviderStderrTail(
  reason: string,
  stderrLogPath: string | undefined
): Promise<string> {
  if (stderrLogPath === undefined) {
    return reason;
  }
  const suffix = formatProviderStderrReason(
    await readProviderStderrTail(stderrLogPath)
  );
  return suffix === undefined ? reason : `${reason} (${suffix})`;
}
