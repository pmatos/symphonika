import type { NormalizedProviderEvent } from "../provider.js";
import type { FailureClassification } from "../run-store.js";
import { WorkspacePreparationError } from "../workspace.js";

export type ClassifyFailureInput = {
  cancelRequested: boolean;
  error?: unknown;
  events: NormalizedProviderEvent[];
};

export type ClassifiedTerminal = {
  classification?: FailureClassification;
  kind: "success" | "failed" | "cancelled" | "input_required";
  reason: string;
};

export function classifyFailure(input: ClassifyFailureInput): ClassifiedTerminal {
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
    return {
      kind: "success",
      reason: ""
    };
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
