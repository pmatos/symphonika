import { lstat, rm } from "node:fs/promises";

import { resolveArtifactPath } from "../workflow/predicates.js";
import { git } from "../workspace.js";

// Mirrors src/http/git-status.ts and src/lifecycle/file-overlap-guard.ts: a
// wedged `git` must not hang the pre-attempt hook this runs from.
const GIT_COMMAND_TIMEOUT_MS = 30_000;

// The workspace-relative artifact a raw-FSM agent prompt writes to signal
// "blocked" (issue #730): exiting non-zero from a Bash tool call only ends
// that subshell, not the provider session, so provider_success always reads
// true regardless. A `when: artifact_exists: BLOCKED.md` transition is the
// mechanism that actually works. Unlike PLAN.md, which SPEC.md deliberately
// lets persist across attempts in a reused Workspace (ADR 0040), BLOCKED.md
// is attempt-scoped: a sentinel left by an earlier blocked attempt must not
// block a later, genuinely successful one.
export const BLOCKED_SENTINEL_FILENAME = "BLOCKED.md";

// Resolves once the sentinel is gone or was never there; a permission or I/O
// error still rejects. Unlike the headShaAtAttemptStart snapshot's inspection
// failure, which is deferred into a distinct workspace_inspection_failed
// classification, the caller only warn-logs a rejection here and proceeds, so
// a stale sentinel can survive and misroute a later successful attempt. Runs
// once per attempt, after the headShaAtAttemptStart snapshot, before the
// provider executes.
//
// Issue #739 / ADR-2026-09-10-2018: the caller only runs this for a state
// that declares the BLOCKED.md gate, but that alone doesn't prove the file at
// that path is the orchestration's own uncommitted sentinel rather than a
// managed repository's own git-tracked source file of the same name. A
// git-tracked BLOCKED.md is left alone -- deleting it would let the provider
// commit the removal of a real source file the orchestration never wrote.
export async function clearBlockedSentinel(
  workspacePath: string
): Promise<void> {
  const resolved = resolveArtifactPath(
    workspacePath,
    BLOCKED_SENTINEL_FILENAME
  );
  if (resolved === undefined || !(await fileExists(resolved))) {
    return;
  }
  if (await isGitTracked(workspacePath)) {
    return;
  }
  await rm(resolved, { force: true });
}

// `lstat`, not `stat`: a symlinked BLOCKED.md is judged by the link itself,
// matching how the `rm()` below treats it. Skips the git spawn below entirely
// on the common path (most attempts never got blocked, so nothing was ever
// written here) rather than always paying a subprocess spawn to answer "is
// this absent file tracked" before finding out it's absent.
async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isGitTracked(workspacePath: string): Promise<boolean> {
  try {
    await git(
      [
        "-C",
        workspacePath,
        "ls-files",
        "--error-unmatch",
        "--",
        BLOCKED_SENTINEL_FILENAME
      ],
      AbortSignal.timeout(GIT_COMMAND_TIMEOUT_MS)
    );
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
