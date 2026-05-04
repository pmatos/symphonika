import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { NormalizedProviderEvent } from "../provider.js";
import type { FailureClassification } from "../run-store.js";
import { WorkspacePreparationError } from "../workspace.js";

const execFileAsync = promisify(execFile);

export type ClassifyFailureInput = {
  cancelRequested: boolean;
  error?: unknown;
  events: NormalizedProviderEvent[];
  successWorkspace?: {
    baseBranch: string;
    workspacePath: string;
  };
};

export type ClassifiedTerminal = {
  classification?: FailureClassification;
  kind: "success" | "failed" | "cancelled" | "input_required";
  reason: string;
};

export async function classifyFailure(
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

  const inputRequired = input.events.find((event) => event.type === "input_required");
  if (inputRequired !== undefined) {
    return {
      classification: "input_required",
      kind: "input_required",
      reason: extractMessage(inputRequired) ?? "provider requested input"
    };
  }

  const malformed = input.events.find((event) => event.type === "malformed_event");
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
      reason: "no_process_exit_event"
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
    reason:
      exitCode === undefined
        ? `process_exit_signal_${stringField(exit, "signal") ?? "unknown"}`
        : `process_exit_${exitCode}`
  };
}

async function verifyWorkspaceSuccess(
  workspace: ClassifyFailureInput["successWorkspace"]
): Promise<ClassifiedTerminal> {
  if (workspace === undefined) {
    return workspaceInspectionFailed();
  }

  try {
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
      return workspaceInspectionFailed();
    }
    const aheadCount = Number(trimmed);
    if (aheadCount === 0) {
      return {
        classification: "deterministic",
        kind: "failed",
        reason: "no_workspace_changes"
      };
    }
    return {
      kind: "success",
      reason: ""
    };
  } catch {
    return workspaceInspectionFailed();
  }
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
