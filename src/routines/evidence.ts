import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type RecentRoutineEvent = {
  normalized: Record<string, unknown>;
  sequence: number;
  type: string;
};

// Firing evidence is a normalized-log file on disk, not a DB-backed
// provider_events table (a Run's own model) — this ring-buffer tail read
// is shared by the `show-firing` CLI command and GET /firings/:id so
// neither reimplements event parsing independently.
export async function readRecentRoutineEvents(
  normalizedLogPath: string,
  limit: number
): Promise<RecentRoutineEvent[]> {
  const recentLines: { line: string; sequence: number }[] = [];
  let nextSlot = 0;
  let sequence = 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(normalizedLogPath, "r");
    for await (const line of handle.readLines({ autoClose: false })) {
      if (line.length === 0) {
        continue;
      }
      sequence += 1;
      const entry = { line, sequence };
      if (recentLines.length < limit) {
        recentLines.push(entry);
      } else {
        recentLines[nextSlot] = entry;
        nextSlot = (nextSlot + 1) % limit;
      }
    }
  } catch {
    return [];
  } finally {
    await handle?.close();
  }

  const orderedLines =
    nextSlot === 0
      ? recentLines
      : [...recentLines.slice(nextSlot), ...recentLines.slice(0, nextSlot)];
  return orderedLines.map(({ line, sequence }) => {
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
  return {
    directory,
    normalizedLogPath: path.join(directory, "provider.normalized.jsonl"),
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
