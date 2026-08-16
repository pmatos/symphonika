import { createHash } from "node:crypto";

// The one hashing convention for "does this content match what's on disk":
// used by WorkflowContract's own contentHash field (src/workflow/
// contract-loading.ts) and by the save pipeline's stale-write check
// (src/http/save-pipeline.ts, #306). A second, differently-computed hash
// for the same purpose would make a stale-write check compare against the
// wrong baseline.
export function contentHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}
