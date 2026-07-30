import path from "node:path";

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
