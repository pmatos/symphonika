import { rm } from "node:fs/promises";

import { resolveArtifactPath } from "../workflow/predicates.js";

// The workspace-relative artifact a raw-FSM agent prompt writes to signal
// "blocked" (issue #730): exiting non-zero from a Bash tool call only ends
// that subshell, not the provider session, so provider_success always reads
// true regardless. A `when: artifact_exists: BLOCKED.md` transition is the
// mechanism that actually works. Unlike PLAN.md, which SPEC.md deliberately
// lets persist across attempts in a reused Workspace (ADR 0040), BLOCKED.md
// is attempt-scoped: a sentinel left by an earlier blocked attempt must not
// block a later, genuinely successful one.
export const BLOCKED_SENTINEL_FILENAME = "BLOCKED.md";

// Resolves once the sentinel is gone or was never there (`force: true`
// swallows ENOENT); a permission or I/O error still rejects. Unlike the
// headShaAtAttemptStart snapshot's inspection failure, which is deferred into
// a distinct workspace_inspection_failed classification, the caller only
// warn-logs a rejection here and proceeds, so a stale sentinel can survive
// and misroute a later successful attempt. Runs once per attempt, after the
// headShaAtAttemptStart snapshot, before the provider executes.
export async function clearBlockedSentinel(
  workspacePath: string
): Promise<void> {
  const resolved = resolveArtifactPath(
    workspacePath,
    BLOCKED_SENTINEL_FILENAME
  );
  if (resolved === undefined) {
    return;
  }
  await rm(resolved, { force: true });
}
