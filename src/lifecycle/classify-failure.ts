import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { NormalizedProviderEvent } from "../provider.js";
import { withProviderStderrTail } from "../providers/provider-stderr.js";
import { redactAll } from "../redaction.js";
import type { FailureClassification } from "../run-store.js";
import { git, WorkspacePreparationError } from "../workspace.js";

const execFileAsync = promisify(execFile);

export type ClassifyFailureInput = {
  cancelRequested: boolean;
  error?: unknown;
  events: NormalizedProviderEvent[];
  // Required, not optional: the terminal reason lifts arbitrary provider text
  // into SQLite, so a caller that forgets the inventory silently drops a
  // SPEC.md §6 boundary. An empty list is the explicit "nothing to scrub".
  redactSecrets: readonly string[];
  // Evidence path for the attempt's provider stderr tee. The unclean-exit
  // reasons below carry no explanation of their own, so the provider's last
  // words are appended to them when it wrote any.
  stderrLogPath?: string;
  successWorkspace?: {
    // When true, a `kind: git` workspace with zero commits ahead of base is
    // reported as `success` (with `commitsAhead: false`) instead of the
    // deterministic `no_workspace_changes` failure below, letting a caller
    // reach its own claim-aware reconciliation instead of being pre-empted
    // here. Only the Routine Firing path opts in; workspace success
    // verification for the issue-driven Run lifecycle never sets this.
    allowZeroCommits?: boolean;
    baseBranch: string;
    // A digest of `git diff <base>...HEAD` taken immediately before the
    // provider ran (see inspectWorkspaceContentDigest). Preferred over
    // headShaAtStart when present: a mid-attempt rebase/reset rewrites
    // commits to new SHAs even when their content is identical, but the
    // branch's diff against base is patch-equivalent across that rewrite, so
    // comparing digests (rather than the raw SHA) tells real new content
    // apart from a same-content rewrite (a bare amend, a no-diff
    // reword/squash). See symphonika#806 and its follow-up.
    contentDigestAtStart?: string;
    headInspectionFailed?: boolean;
    headShaAtStart?: string;
    workspacePath: string;
  };
};

export type ClassifiedTerminal = {
  branchAdvancedSinceAttemptStart?: boolean;
  classification?: FailureClassification;
  // Only ever set on a `kind: "success"` result for a `kind: git` workspace;
  // the real commits-ahead bit, so a caller doesn't have to re-derive it (or
  // infer it from `kind` alone) once it flows out of this module.
  commitsAhead?: boolean;
  kind: "success" | "failed" | "cancelled" | "input_required";
  reason: string;
};

export type WorkspaceCommitInspectionInput = {
  baseBranch: string;
  workspacePath: string;
};

export type WorkspaceHeadInspectionInput = {
  signal?: AbortSignal;
  workspacePath: string;
};

export async function classifyFailure(
  input: ClassifyFailureInput
): Promise<ClassifiedTerminal> {
  const terminal = await classifyFailureUnredacted(input);
  return {
    ...terminal,
    reason: redactAll(terminal.reason, input.redactSecrets)
  };
}

async function classifyFailureUnredacted(
  input: ClassifyFailureInput
): Promise<ClassifiedTerminal> {
  if (input.cancelRequested) {
    return {
      kind: "cancelled",
      reason: "cancelled"
    };
  }

  if (input.error !== undefined) {
    return classifyError(input.error);
  }

  const inputRequired = input.events.find(
    (event) => event.type === "input_required"
  );
  if (inputRequired !== undefined) {
    return {
      classification: "input_required",
      kind: "input_required",
      reason: extractMessage(inputRequired) ?? "provider requested input"
    };
  }

  const malformed = input.events.find(
    (event) => event.type === "malformed_event"
  );
  if (malformed !== undefined) {
    return {
      classification: "deterministic",
      kind: "failed",
      reason: "malformed_provider_event"
    };
  }

  const turnFailed = input.events.find((event) => event.type === "turn_failed");
  if (turnFailed !== undefined) {
    return {
      classification: "transient",
      kind: "failed",
      reason: extractMessage(turnFailed) ?? "turn_failed"
    };
  }

  const exit = input.events.find((event) => event.type === "process_exit");
  if (exit === undefined) {
    return {
      classification: "transient",
      kind: "failed",
      reason: await withProviderStderrTail(
        "no_process_exit_event",
        input.stderrLogPath
      )
    };
  }

  if (exit.cancelled === true) {
    return {
      kind: "cancelled",
      reason: "provider_cancelled"
    };
  }

  const exitCode = numberField(exit, "exitCode");
  if (exitCode === 0) {
    return verifyWorkspaceSuccess(input.successWorkspace);
  }

  return {
    classification: "transient",
    kind: "failed",
    reason: await withProviderStderrTail(
      exitCode === undefined
        ? `process_exit_signal_${stringField(exit, "signal") ?? "unknown"}`
        : `process_exit_${exitCode}`,
      input.stderrLogPath
    )
  };
}

async function verifyWorkspaceSuccess(
  workspace: ClassifyFailureInput["successWorkspace"]
): Promise<ClassifiedTerminal> {
  if (workspace === undefined) {
    return workspaceInspectionFailed();
  }

  try {
    if (workspace.headInspectionFailed === true) {
      return workspaceInspectionFailed();
    }
    if (!(await inspectWorkspaceCommitsAhead(workspace))) {
      if (workspace.allowZeroCommits !== true) {
        return {
          classification: "deterministic",
          kind: "failed",
          reason: "no_workspace_changes"
        };
      }
      return {
        commitsAhead: false,
        kind: "success",
        reason: ""
      };
    }
    const branchAdvancedSinceAttemptStart =
      await computeBranchAdvancedSinceAttemptStart(workspace);
    return {
      branchAdvancedSinceAttemptStart,
      commitsAhead: true,
      kind: "success",
      reason: ""
    };
  } catch {
    return workspaceInspectionFailed();
  }
}

export async function inspectWorkspaceCommitsAhead(
  workspace: WorkspaceCommitInspectionInput
): Promise<boolean> {
  const baseRef = `refs/remotes/origin/${workspace.baseBranch}`;
  const { stdout } = await execFileAsync("git", [
    "-C",
    workspace.workspacePath,
    "rev-list",
    "--count",
    `${baseRef}..HEAD`
  ]);
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`invalid git rev-list count: ${trimmed}`);
  }
  return Number(trimmed) > 0;
}

// A content fingerprint of what the branch carries beyond base, immune to
// history rewriting: `git diff <base>...HEAD` diffs HEAD against the
// merge-base of base and HEAD, so a clean rebase/reset onto an advanced base
// reproduces the same diff text (blob hashes are content-addressed, so an
// unchanged file's lines hash identically regardless of which commit carries
// them) and this digest stays the same, while real new content changes it.
// Comparing two of these digests answers "did this attempt's content change"
// in a way a raw HEAD SHA comparison cannot: a same-content rewrite (a bare
// `git commit --amend`, a no-diff reword/squash) also changes the SHA but
// leaves this digest untouched. See symphonika#806 and its follow-up.
const CONTENT_DIGEST_MAX_BUFFER = 10 * 1024 * 1024;

export async function inspectWorkspaceContentDigest(
  workspace: WorkspaceCommitInspectionInput
): Promise<string> {
  const baseRef = `refs/remotes/origin/${workspace.baseBranch}`;
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspace.workspacePath, "diff", `${baseRef}...HEAD`],
    { maxBuffer: CONTENT_DIGEST_MAX_BUFFER }
  );
  return createHash("sha256").update(stdout).digest("hex");
}

export async function inspectWorkspaceHead(
  workspace: WorkspaceHeadInspectionInput
): Promise<string> {
  // Uses the shared process-group-aware git() helper, not execFileAsync,
  // so a caller that passes a deadline signal actually tears down a stalled
  // `git rev-parse` rather than merely abandoning the promise racing it.
  const stdout = await git(
    ["-C", workspace.workspacePath, "rev-parse", "--verify", "HEAD^{commit}"],
    workspace.signal
  );
  const trimmed = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(trimmed)) {
    throw new Error(`invalid git HEAD: ${trimmed}`);
  }
  return trimmed;
}

// Prefers the content digest (immune to history rewriting and to a
// same-content rewrite alike) over the older headShaAtStart signal, which
// stays as a fallback for any caller that hasn't started passing
// contentDigestAtStart yet. Neither present defaults to true, matching the
// pre-symphonika#806 behavior for a caller that opts out of advancement
// detection entirely.
async function computeBranchAdvancedSinceAttemptStart(workspace: {
  baseBranch: string;
  contentDigestAtStart?: string;
  headShaAtStart?: string;
  workspacePath: string;
}): Promise<boolean> {
  if (workspace.contentDigestAtStart !== undefined) {
    const currentDigest = await inspectWorkspaceContentDigest(workspace);
    return currentDigest !== workspace.contentDigestAtStart;
  }
  if (workspace.headShaAtStart !== undefined) {
    // Deliberately not an ancestry check (no `git merge-base --is-ancestor`):
    // a mid-attempt rebase/reset onto an advanced base rewrites the
    // attempt's earlier commits to new SHAs, so the pre-attempt HEAD is no
    // longer an ancestor of the post-rebase HEAD even though the branch
    // strictly gained real work. Plain inequality survives that rewrite but,
    // unlike the digest above, can't tell a same-content rewrite (a bare
    // amend) from real new work; see symphonika#806.
    return (await inspectWorkspaceHead(workspace)) !== workspace.headShaAtStart;
  }
  return true;
}

function workspaceInspectionFailed(): ClassifiedTerminal {
  return {
    classification: "deterministic",
    kind: "failed",
    reason: "workspace_inspection_failed"
  };
}

function classifyError(error: unknown): ClassifiedTerminal {
  if (error instanceof WorkspacePreparationError) {
    return {
      classification: "deterministic",
      kind: "failed",
      reason: `workspace_${error.code}`
    };
  }

  const message = errorMessage(error);
  if (
    /workflow|prompt|unknown variable|render|workflow contract|workflow template/i.test(
      message
    )
  ) {
    return {
      classification: "deterministic",
      kind: "failed",
      reason: `render_error: ${message}`
    };
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  ) {
    return {
      classification: "deterministic",
      kind: "failed",
      reason: `binary_missing: ${message}`
    };
  }

  return {
    classification: "transient",
    kind: "failed",
    reason: message
  };
}

function extractMessage(event: NormalizedProviderEvent): string | undefined {
  return stringField(event, "message");
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value === "object" && value !== null && key in value) {
    const inner = (value as Record<string, unknown>)[key];
    if (typeof inner === "string") {
      return inner;
    }
  }
  return undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value === "object" && value !== null && key in value) {
    const inner = (value as Record<string, unknown>)[key];
    if (typeof inner === "number") {
      return inner;
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
