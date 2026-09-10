import { rm } from "node:fs/promises";
import path from "node:path";

// The workspace-relative artifact a raw-FSM agent prompt writes to signal
// "blocked" (issue #730): exiting non-zero from a Bash tool call only ends
// that subshell, not the provider session, so provider_success always reads
// true regardless. A `when: artifact_exists: BLOCKED.md` transition is the
// mechanism that actually works. Unlike PLAN.md, which SPEC.md deliberately
// lets persist across attempts in a reused Workspace (ADR 0040), BLOCKED.md
// is attempt-scoped: a sentinel left by an earlier blocked attempt must not
// block a later, genuinely successful one.
const BLOCKED_SENTINEL_FILENAME = "BLOCKED.md";

// Resolves once the sentinel is gone or was never there (`force: true`
// swallows ENOENT); a permission or I/O error still rejects, and the caller
// treats that as best-effort the same way it treats other pre-attempt
// workspace inspection failures. Runs once per attempt, before the provider
// executes, alongside the headShaAtAttemptStart snapshot.
export async function clearBlockedSentinel(
  workspacePath: string
): Promise<void> {
  await rm(path.join(workspacePath, BLOCKED_SENTINEL_FILENAME), {
    force: true
  });
}
