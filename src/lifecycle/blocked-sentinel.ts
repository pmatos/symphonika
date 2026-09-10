import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import { resolveArtifactPath } from "../workflow/predicates.js";

const execFileAsync = promisify(execFile);

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

// Resolves once the sentinel is gone or was never there (`force: true`
// swallows ENOENT); a permission or I/O error still rejects. Unlike the
// headShaAtAttemptStart snapshot's inspection failure, which is deferred into
// a distinct workspace_inspection_failed classification, the caller only
// warn-logs a rejection here and proceeds, so a stale sentinel can survive
// and misroute a later successful attempt. Runs once per attempt, after the
// headShaAtAttemptStart snapshot, before the provider executes.
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
  if (resolved === undefined) {
    return;
  }
  if (await isGitTracked(workspacePath, BLOCKED_SENTINEL_FILENAME)) {
    return;
  }
  await rm(resolved, { force: true });
}

async function isGitTracked(
  workspacePath: string,
  relativePath: string
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", workspacePath, "ls-files", "--error-unmatch", "--", relativePath],
      { timeout: GIT_COMMAND_TIMEOUT_MS }
    );
    return true;
  } catch {
    return false;
  }
}
