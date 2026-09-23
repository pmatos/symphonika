import path from "node:path";

// Own module so persistRunEvidence (autonomous-prompt.ts) and claim.ts can
// both depend on it without either pulling in the other.
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
