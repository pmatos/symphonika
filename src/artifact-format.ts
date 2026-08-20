import type { RunArtifactDescriptor } from "./run-store.js";

// Shared renderer for the operator-facing artifact summary used by the CLI run
// views and the smoke-test failure diagnostic. Present artifacts carry their
// recorded byte size (including zero, which is itself a signal that an artifact
// was captured but empty); artifacts with an unknown size render as the bare
// kind. Absent artifacts are dropped, and an empty summary reads "(none)".
export function formatArtifactKinds(
  artifacts: readonly RunArtifactDescriptor[]
): string {
  const present = artifacts
    .filter((artifact) => artifact.present)
    .map((artifact) =>
      artifact.sizeBytes === undefined
        ? artifact.kind
        : `${artifact.kind}(${artifact.sizeBytes} bytes)`
    );
  return present.length === 0 ? "(none)" : present.join(", ");
}
