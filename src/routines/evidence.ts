import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type RecentRoutineEvent = {
  normalized: Record<string, unknown>;
  sequence: number;
  type: string;
};

export type RecentRoutineEventTail = {
  events: RecentRoutineEvent[];
  truncated: boolean;
};

const EVENT_TAIL_CHUNK_BYTES = 64 * 1_024;
const EVENT_INDEX_RECORD_BYTES = 8;

// Firing evidence is a normalized-log file on disk, not a DB-backed
// provider_events table (a Run's own model) — this bounded suffix read is
// shared by the `show-firing` CLI command and GET /firings/:id so
// neither reimplements event parsing independently.
export async function readRecentRoutineEvents(
  normalizedLogPath: string,
  limit: number
): Promise<RecentRoutineEventTail> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return { events: [], truncated: false };
  }
  let handle: FileHandle | undefined;
  try {
    const indexedStart = await readIndexedTailStart(normalizedLogPath, limit);
    handle = await open(normalizedLogPath, "r");
    const { size } = await handle.stat();
    if (indexedStart !== undefined && indexedStart.offset < size) {
      const lines = await readEventRange(
        handle,
        indexedStart.offset,
        size - indexedStart.offset
      );
      const events = parseRecentRoutineEvents(lines, indexedStart.sequence);
      return {
        events: events.slice(-limit),
        truncated: indexedStart.sequence > 1 || events.length > limit
      };
    }
    const tail = await readBoundedEventSuffix(handle, size, limit);
    return {
      events: parseRecentRoutineEvents(tail.lines, tail.firstSequence),
      truncated: tail.truncated
    };
  } catch {
    return { events: [], truncated: false };
  } finally {
    await handle?.close();
  }
}

async function readIndexedTailStart(
  normalizedLogPath: string,
  limit: number
): Promise<{ offset: number; sequence: number } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(routineEventIndexPath(normalizedLogPath), "r");
    const { size } = await handle.stat();
    const recordCount = Math.floor(size / EVENT_INDEX_RECORD_BYTES);
    if (recordCount === 0) {
      return undefined;
    }
    const recordIndex = Math.max(0, recordCount - limit);
    const record = Buffer.allocUnsafe(EVENT_INDEX_RECORD_BYTES);
    const { bytesRead } = await handle.read(
      record,
      0,
      record.length,
      recordIndex * EVENT_INDEX_RECORD_BYTES
    );
    if (bytesRead !== record.length) {
      return undefined;
    }
    const offset = record.readBigUInt64BE();
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    return {
      offset: Number(offset),
      sequence: recordIndex + 1
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readEventRange(
  handle: FileHandle,
  position: number,
  length: number
): Promise<string[]> {
  const contents = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const read = await handle.read(
      contents,
      bytesRead,
      length - bytesRead,
      position + bytesRead
    );
    if (read.bytesRead === 0) {
      break;
    }
    bytesRead += read.bytesRead;
  }
  return decodeRoutineEventLines(contents.subarray(0, bytesRead));
}

async function readBoundedEventSuffix(
  handle: FileHandle,
  fileSize: number,
  limit: number
): Promise<{ firstSequence: number; lines: string[]; truncated: boolean }> {
  const reverseChunks: Buffer[] = [];
  let currentLineHasContent = false;
  let nonEmptyLineCount = 0;
  let position = fileSize;

  while (position > 0 && nonEmptyLineCount <= limit) {
    const length = Math.min(EVENT_TAIL_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = await handle.read(
        chunk,
        bytesRead,
        length - bytesRead,
        position + bytesRead
      );
      if (read.bytesRead === 0) {
        break;
      }
      bytesRead += read.bytesRead;
    }
    if (bytesRead === 0) {
      break;
    }
    const contents =
      bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
    reverseChunks.push(contents);

    for (let index = contents.length - 1; index >= 0; index -= 1) {
      const byte = contents[index];
      if (byte === 0x0a) {
        currentLineHasContent = false;
      } else if (byte !== 0x0d && !currentLineHasContent) {
        currentLineHasContent = true;
        nonEmptyLineCount += 1;
      }
    }
  }

  const lines = decodeRoutineEventLines(Buffer.concat(reverseChunks.reverse()));
  const selectedLines = lines.slice(-limit);
  return {
    firstSequence: position === 0 ? lines.length - selectedLines.length + 1 : 1,
    lines: selectedLines,
    truncated: position > 0 || lines.length > limit
  };
}

function decodeRoutineEventLines(contents: Buffer): string[] {
  return contents
    .toString("utf8")
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
}

function parseRecentRoutineEvents(
  lines: string[],
  firstSequence = 1
): RecentRoutineEvent[] {
  return lines.map((line, index) => {
    const sequence = firstSequence + index;
    try {
      const normalized = JSON.parse(line) as unknown;
      if (
        typeof normalized === "object" &&
        normalized !== null &&
        "type" in normalized &&
        typeof normalized.type === "string"
      ) {
        return {
          normalized,
          sequence,
          type: normalized.type
        };
      }
    } catch {
      // Preserve the line position as diagnosable malformed log evidence.
    }
    return {
      normalized: {
        message: "could not parse normalized event",
        type: "malformed_event"
      },
      sequence,
      type: "malformed_event"
    };
  });
}

export function routineEventIndexPath(normalizedLogPath: string): string {
  return `${normalizedLogPath}.idx`;
}

// Existence + size for one evidence file, mirroring RunStore's own private
// artifactSize check for Run artifacts — undefined means "not present",
// not an error (a firing that never got far enough never wrote the file).
export async function statRoutineEvidenceFile(
  filePath: string
): Promise<number | undefined> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

export type RoutineEvidencePaths = {
  directory: string;
  normalizedIndexPath: string;
  normalizedLogPath: string;
  promptMetadataPath: string;
  promptPath: string;
  rawLogPath: string;
};

export function routineEvidencePaths(
  stateRoot: string,
  firingId: string
): RoutineEvidencePaths {
  const directory = path.join(
    path.resolve(stateRoot),
    "logs",
    "routines",
    safePathSegment(firingId)
  );
  const normalizedLogPath = path.join(directory, "provider.normalized.jsonl");
  return {
    directory,
    normalizedIndexPath: routineEventIndexPath(normalizedLogPath),
    normalizedLogPath,
    promptMetadataPath: path.join(directory, "prompt-metadata.json"),
    promptPath: path.join(directory, "prompt.md"),
    rawLogPath: path.join(directory, "provider.raw.jsonl")
  };
}

function safePathSegment(input: string): string {
  const segment = input
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment.length === 0 ? "firing" : segment;
}
