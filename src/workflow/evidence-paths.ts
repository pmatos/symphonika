import path from "node:path";

// Shared by persistRunEvidence (autonomous-prompt.ts) and the Workflow Claim
// path (claim.ts), which both name files inside the same per-run evidence
// directory. Kept in its own module so neither of those two pulls the other
// one in as a dependency.
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
