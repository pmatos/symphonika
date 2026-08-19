import { createReadStream } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

type RecentRoutineEvent = {
  normalized: Record<string, unknown>;
  sequence: number | null;
  type: string;
};

export type RecentRoutineEventTail = {
  events: RecentRoutineEvent[];
  truncated: boolean;
};

const EVENT_TAIL_CHUNK_BYTES = 64 * 1_024;
const EVENT_INDEX_RECORD_BYTES = 16;

type RoutineEventIndexRecord = {
  offset: number;
  sequence: number;
};

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
    handle = await open(normalizedLogPath, "r");
    const { size } = await handle.stat();
    const indexedRecords = await readIndexedTailRecords(
      normalizedLogPath,
      limit
    );
    if (indexedRecords !== undefined) {
      const lines = await readValidatedIndexedEventTail(
        handle,
        size,
        indexedRecords
      );
      const selectedRecords = indexedRecords.slice(-limit);
      const firstRecord = selectedRecords[0];
      if (lines !== undefined && firstRecord !== undefined) {
        return {
          events: parseRecentRoutineEvents(
            lines.slice(-limit),
            firstRecord.sequence
          ),
          truncated: firstRecord.sequence > 1
        };
      }
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

async function readIndexedTailRecords(
  normalizedLogPath: string,
  limit: number
): Promise<RoutineEventIndexRecord[] | undefined> {
  try {
    const indexPath = routineEventIndexPath(normalizedLogPath);
    const { size } = await stat(indexPath);
    if (size === 0 || size % EVENT_INDEX_RECORD_BYTES !== 0) {
      return undefined;
    }
    const recordCount = size / EVENT_INDEX_RECORD_BYTES;
    // Include the preceding record when one exists so a selected offset
    // cannot silently repeat or cross its immediate neighbor.
    const selectedCount = Math.min(limit + 1, recordCount);
    const start = size - selectedCount * EVENT_INDEX_RECORD_BYTES;
    const contents = await readStreamRange(indexPath, start, size - 1);
    if (contents.length !== selectedCount * EVENT_INDEX_RECORD_BYTES) {
      return undefined;
    }

    const records: RoutineEventIndexRecord[] = [];
    for (let index = 0; index < selectedCount; index += 1) {
      const position = index * EVENT_INDEX_RECORD_BYTES;
      const offset = contents.readBigUInt64BE(position);
      const sequence = contents.readBigUInt64BE(position + 8);
      if (
        offset > BigInt(Number.MAX_SAFE_INTEGER) ||
        sequence < 1n ||
        sequence > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return undefined;
      }
      const record = {
        offset: Number(offset),
        sequence: Number(sequence)
      };
      const previous = records.at(-1);
      if (
        previous !== undefined &&
        (record.offset <= previous.offset ||
          record.sequence !== previous.sequence + 1)
      ) {
        return undefined;
      }
      records.push(record);
    }
    return records;
  } catch {
    return undefined;
  }
}

async function readStreamRange(
  filePath: string,
  start: number,
  end: number
): Promise<Buffer> {
  let contents = "";
  for await (const chunk of createReadStream(filePath, {
    encoding: "latin1",
    end,
    start
  })) {
    contents += chunk;
  }
  return Buffer.from(contents, "latin1");
}

async function readValidatedIndexedEventTail(
  handle: FileHandle,
  fileSize: number,
  records: RoutineEventIndexRecord[]
): Promise<string[] | undefined> {
  const firstRecord = records[0];
  if (firstRecord === undefined) {
    return undefined;
  }
  for (const record of records) {
    if (record.offset >= fileSize) {
      return undefined;
    }
    if (record.offset === 0) {
      if (record.sequence !== 1) {
        return undefined;
      }
      continue;
    }
    const boundary = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(
      boundary,
      0,
      boundary.length,
      record.offset - 1
    );
    if (bytesRead !== 1 || boundary[0] !== 0x0a) {
      return undefined;
    }
  }

  const chunks: Buffer[] = [];
  const lineOffsets: number[] = [];
  let currentLineHasContent = false;
  let currentLineOffset = firstRecord.offset;
  let position = firstRecord.offset;
  while (position < fileSize) {
    const length = Math.min(EVENT_TAIL_CHUNK_BYTES, fileSize - position);
    const chunk = Buffer.allocUnsafe(length);
    const read = await handle.read(chunk, 0, length, position);
    if (read.bytesRead === 0) {
      return undefined;
    }
    const contents =
      read.bytesRead === chunk.length
        ? chunk
        : chunk.subarray(0, read.bytesRead);
    chunks.push(contents);
    for (let index = 0; index < contents.length; index += 1) {
      const byte = contents[index];
      if (byte === 0x0a) {
        if (currentLineHasContent) {
          lineOffsets.push(currentLineOffset);
        }
        currentLineHasContent = false;
        currentLineOffset = position + index + 1;
      } else if (byte !== 0x0d) {
        currentLineHasContent = true;
      }
      if (lineOffsets.length > records.length) {
        return undefined;
      }
    }
    position += read.bytesRead;
  }
  if (currentLineHasContent) {
    lineOffsets.push(currentLineOffset);
  }

  if (
    lineOffsets.length !== records.length ||
    records.some((record, index) => record.offset !== lineOffsets[index])
  ) {
    return undefined;
  }
  return decodeRoutineEventLines(Buffer.concat(chunks));
}

async function readBoundedEventSuffix(
  handle: FileHandle,
  fileSize: number,
  limit: number
): Promise<{
  firstSequence: number | null;
  lines: string[];
  truncated: boolean;
}> {
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
    firstSequence:
      position === 0 ? lines.length - selectedLines.length + 1 : null,
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
  firstSequence: number | null
): RecentRoutineEvent[] {
  return lines.map((line, index) => {
    const sequence = firstSequence === null ? null : firstSequence + index;
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

function routineEventIndexPath(normalizedLogPath: string): string {
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
