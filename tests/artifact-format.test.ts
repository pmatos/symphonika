import { describe, expect, it } from "vitest";

import { formatArtifactKinds } from "../src/artifact-format.js";
import type { RunArtifactDescriptor } from "../src/run-store.js";

function artifact(
  overrides: Partial<RunArtifactDescriptor> &
    Pick<RunArtifactDescriptor, "kind">
): RunArtifactDescriptor {
  return {
    present: true,
    sizeBytes: undefined,
    ...overrides
  };
}

describe("formatArtifactKinds", () => {
  it("renders a present artifact's size in bytes alongside its kind", () => {
    expect(
      formatArtifactKinds([artifact({ kind: "prompt", sizeBytes: 128 })])
    ).toBe("prompt(128 bytes)");
  });

  it("renders a zero-byte present artifact so the empty-artifact signal is not hidden", () => {
    expect(
      formatArtifactKinds([artifact({ kind: "provider_raw", sizeBytes: 0 })])
    ).toBe("provider_raw(0 bytes)");
  });

  it("renders only the kind when the size is unknown", () => {
    expect(
      formatArtifactKinds([artifact({ kind: "prompt", sizeBytes: undefined })])
    ).toBe("prompt");
  });

  it("omits artifacts that are not present", () => {
    expect(
      formatArtifactKinds([
        artifact({ kind: "prompt", present: false, sizeBytes: 10 }),
        artifact({ kind: "issue_snapshot", present: true, sizeBytes: 42 })
      ])
    ).toBe("issue_snapshot(42 bytes)");
  });

  it("returns (none) when no artifacts are present", () => {
    expect(formatArtifactKinds([])).toBe("(none)");
    expect(
      formatArtifactKinds([
        artifact({ kind: "prompt", present: false, sizeBytes: 10 })
      ])
    ).toBe("(none)");
  });

  it("joins multiple present artifacts in order", () => {
    expect(
      formatArtifactKinds([
        artifact({ kind: "issue_snapshot", sizeBytes: 12 }),
        artifact({ kind: "prompt", sizeBytes: undefined }),
        artifact({ kind: "provider_normalized", sizeBytes: 7 })
      ])
    ).toBe("issue_snapshot(12 bytes), prompt, provider_normalized(7 bytes)");
  });
});
