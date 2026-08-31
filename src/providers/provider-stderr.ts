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
import { StringDecoder } from "node:string_decoder";

import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { redactAll } from "../redaction.js";

// A disk guard, not a diagnostic budget: real providers write kilobytes here.
export const PROVIDER_STDERR_LOG_MAX_BYTES = 1_048_576;
const PROVIDER_STDERR_TAIL_BYTES = 4_096;
// terminal_reason is rendered on one CLI line and in notification digests, so
// the surfaced excerpt stays short enough not to swamp them.
const PROVIDER_STDERR_REASON_CHARS = 200;
// How long `finished` will wait on a sink that never settles. Evidence capture
// is best-effort by design, so a wedged write (full disk, stalled network state
// root) must degrade to a missing stderr excerpt, never to a Run or Firing that
// cannot reach a terminal state.
const PROVIDER_STDERR_FLUSH_TIMEOUT_MS = 2_000;

export type ProviderStderrCapture = {
  // Waits until the tee has flushed everything it is going to flush: the sink
  // finished, the sink failed, or the bounded grace period above elapsed.
  // Never rejects, and never waits longer than that grace period even if the
  // provider is still running — evidence capture is best-effort, so a wedged
  // write must degrade to a missing stderr excerpt, never to a Run or Firing
  // that cannot reach a terminal state.
  //
  // Awaiting this before the adapter returns is what gives
  // `readProviderStderrTail` a happens-before edge against the write. Without
  // it the caller classifies the exit while the flush is still in flight and
  // silently drops the provider's last words from the terminal reason.
  waitForFlush: () => Promise<void>;
};

export type AttachProviderStderrLogOptions = {
  maxBytes?: number;
  // Resolved secret values to scrub before anything reaches disk. The routine
  // dispatcher already redacts its raw/normalized evidence and terminal
  // reasons; this file lands in the same evidence directory and is served by
  // the same artifact routes, so it must honour the same invariant.
  redactSecrets?: readonly string[];
};

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
  options: AttachProviderStderrLogOptions = {}
): ProviderStderrCapture {
  if (filePath === undefined) {
    child.stderr.resume();
    return { waitForFlush: () => Promise.resolve() };
  }

  const maxBytes = options.maxBytes ?? PROVIDER_STDERR_LOG_MAX_BYTES;
  const secrets = (options.redactSecrets ?? []).filter(
    (secret) => secret.length > 0
  );
  const sink = createProviderStderrSink(filePath, maxBytes);
  const redactor = createStreamingRedactor(secrets);

  child.stderr.on("data", (chunk: Buffer) => {
    sink.write(redactor.push(chunk));
  });

  const finalize = (): void => {
    // The held-back carry must be flushed BEFORE ending the sink, or the last
    // few bytes of stderr — the provider's actual last words — are silently
    // dropped, which would make this fix worse than the bug it prevents.
    sink.write(redactor.flush());
    sink.end();
  };
  // `end` covers an ordinary EOF; `close` covers forceKillProviderProcess
  // destroying the stream, which skips `end` entirely. Both may fire, so
  // `finalize` is idempotent through the sink's own `ended` latch.
  child.stderr.once("end", finalize);
  child.stderr.once("close", finalize);

  return {
    waitForFlush: () =>
      Promise.race([sink.finished, flushGracePeriod()]).then(() => undefined)
  };
}

// The bound is applied at the await, not when the sink is created: an adapter
// can reach its cleanup path while the provider is still alive and its stderr
// still open (a caller that abandons the iterator), in which case the sink has
// no completion to offer and an unbounded await would hang the generator.
function flushGracePeriod(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PROVIDER_STDERR_FLUSH_TIMEOUT_MS);
    timer.unref();
  });
}

// Buffers what a byte-boundary redactor cannot yet rule out. `data` chunks
// split at arbitrary byte offsets, so a secret — or even a single multi-byte
// character — can straddle two of them; decoding through StringDecoder and
// holding back the tail is what makes a split secret still match. With no
// secrets configured the stream passes through as raw bytes, so the common
// case stays byte-identical to a plain tee.
function createStreamingRedactor(secrets: readonly string[]): {
  flush: () => Buffer;
  push: (chunk: Buffer) => Buffer;
} {
  if (secrets.length === 0) {
    return {
      flush: () => Buffer.alloc(0),
      push: (chunk) => chunk
    };
  }

  const decoder = new StringDecoder("utf8");
  let carry = "";

  return {
    flush: () => {
      const remaining = redactAll(carry + decoder.end(), secrets);
      carry = "";
      return Buffer.from(remaining, "utf8");
    },
    push: (chunk) => {
      const redacted = redactAll(carry + decoder.write(chunk), secrets);
      const boundary = holdbackBoundary(
        redacted,
        redacted.length - pendingSecretPrefixLength(redacted, secrets)
      );
      carry = redacted.slice(boundary);
      return Buffer.from(redacted.slice(0, boundary), "utf8");
    }
  };
}

// How much of the tail must be withheld because it could still turn out to be
// the start of a secret. Only a suffix that is a *proper prefix of some
// secret* qualifies; everything before it can never become part of a match and
// goes to disk now.
//
// A blanket `longest secret - 1` holdback would be simpler but would defeat
// this module's whole purpose: with a 40-character tracker token in the secret
// list, a short diagnostic like `fatal: disk full` would sit in memory and
// never reach disk if the orchestrator itself is killed — the crash-recovery
// case the tee exists to serve — and longer streams would always trail their
// last 39 characters.
function pendingSecretPrefixLength(
  text: string,
  secrets: readonly string[]
): number {
  const longest = Math.max(...secrets.map((secret) => secret.length));
  for (let length = Math.min(longest - 1, text.length); length > 0; length--) {
    const suffix = text.slice(text.length - length);
    if (
      secrets.some(
        (secret) => secret.length > length && secret.startsWith(suffix)
      )
    ) {
      return length;
    }
  }
  return 0;
}

// Each side of the holdback split is encoded by its own `Buffer.from`, so a
// boundary falling between an astral character's UTF-16 surrogates would turn
// both halves into U+FFFD — `xxxxx😀yyyyy` persisted as `xxxxx??yyyyy`. Move
// the split one unit left so the pair stays together in the carry.
function holdbackBoundary(text: string, boundary: number): number {
  if (boundary <= 0 || boundary >= text.length) {
    return boundary;
  }
  const isLowSurrogate =
    text.charCodeAt(boundary) >= 0xdc00 && text.charCodeAt(boundary) <= 0xdfff;
  const followsHighSurrogate =
    text.charCodeAt(boundary - 1) >= 0xd800 &&
    text.charCodeAt(boundary - 1) <= 0xdbff;
  return isLowSurrogate && followsHighSurrogate ? boundary - 1 : boundary;
}

// Owns the write stream, the byte cap, and the completion promise. The file is
// opened lazily on the first byte that survives redaction, so a provider that
// said nothing — or said only a secret — leaves no file behind.
function createProviderStderrSink(
  filePath: string,
  maxBytes: number
): {
  end: () => void;
  finished: Promise<void>;
  write: (chunk: Buffer) => void;
} {
  let stream: WriteStream | undefined;
  let written = 0;
  let capped = false;
  let failed = false;
  let ended = false;
  let settle!: () => void;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const done = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    settle();
  };

  return {
    end: () => {
      if (ended) {
        return;
      }
      ended = true;
      if (stream === undefined) {
        done();
        return;
      }
      // A sink that never reaches `finish` must not hold the caller forever;
      // the timer is unref'd so it cannot by itself keep the process alive.
      const timer = setTimeout(done, PROVIDER_STDERR_FLUSH_TIMEOUT_MS);
      timer.unref();
      stream.end(() => {
        clearTimeout(timer);
        done();
      });
    },
    finished,
    write: (chunk: Buffer) => {
      if (failed || capped || ended || chunk.length === 0) {
        return;
      }
      if (stream === undefined) {
        stream = createWriteStream(filePath, { flags: "a" });
        // Evidence capture is best-effort: an unwritable state directory must
        // not take the run down with it, and must not strand `finished`.
        stream.on("error", () => {
          failed = true;
          done();
        });
      }
      // The cap counts post-redaction bytes — it is a disk guard, and
      // `[REDACTED]` is longer than most secrets it replaces.
      const remaining = maxBytes - written;
      if (chunk.length <= remaining) {
        written += chunk.length;
        stream.write(chunk);
        return;
      }
      capped = true;
      if (remaining > 0) {
        written += remaining;
        stream.write(chunk.subarray(0, remaining));
      }
      stream.write(
        `\n[symphonika] provider stderr truncated at ${maxBytes} bytes\n`
      );
    }
  };
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
