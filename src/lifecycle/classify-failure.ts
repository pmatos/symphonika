import { execFile } from "node:child_process";
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
    baseBranch: string;
    headInspectionFailed?: boolean;
    headShaAtStart?: string;
    workspacePath: string;
  };
};

export type ClassifiedTerminal = {
  branchAdvancedSinceAttemptStart?: boolean;
  classification?: FailureClassification;
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
      return {
        classification: "deterministic",
        kind: "failed",
        reason: "no_workspace_changes"
      };
    }
    const branchAdvancedSinceAttemptStart =
      workspace.headShaAtStart === undefined
        ? true
        : await inspectWorkspaceAdvancedSinceHead({
            headShaAtStart: workspace.headShaAtStart,
            workspacePath: workspace.workspacePath
          });
    return {
      branchAdvancedSinceAttemptStart,
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

async function inspectWorkspaceAdvancedSinceHead(workspace: {
  headShaAtStart: string;
  workspacePath: string;
}): Promise<boolean> {
  try {
    await execFileAsync("git", [
      "-C",
      workspace.workspacePath,
      "merge-base",
      "--is-ancestor",
      workspace.headShaAtStart,
      "HEAD"
    ]);
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return false;
    }
    throw error;
  }
  return (await inspectWorkspaceHead(workspace)) !== workspace.headShaAtStart;
}

function gitExitCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
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
