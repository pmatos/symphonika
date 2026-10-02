import path from "node:path";

// Per-run evidence directory and per-attempt file naming, shared by
// persistRunEvidence (autonomous-prompt.ts).
export function runEvidenceDirectoryPath(
  stateRoot: string,
  runId: string
): string {
  return path.join(
    path.resolve(stateRoot),
    "logs",
    "runs",
    safePathSegment(runId)
  );
}

export function attemptEvidenceFileName(
  stem: string,
  attemptNumber: number,
  extension: string
): string {
  return attemptNumber === 1
    ? `${stem}.${extension}`
    : `${stem}.attempt-${attemptNumber}.${extension}`;
}

function safePathSegment(input: string): string {
  const segment = input
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment.length === 0 ? "run" : segment;
}
