import type { NormalizedProviderEvent } from "../provider.js";
import { withProviderStderrTail } from "./provider-stderr.js";

type ProviderCompletion =
  | { kind: "clean_exit" }
  | { kind: "cancelled"; reason: string }
  | {
      classification: "input_required";
      kind: "input_required";
      reason: string;
    }
  | {
      classification: "deterministic" | "transient";
      kind: "failed";
      reason: string;
    };

// A clean provider exit is evidence, not workspace acceptance. Reasons remain
// in-memory provider text; callers retain their existing redaction before
// persistence, just as they do for other locally constructed terminal reasons.
export async function classifyProviderCompletion(input: {
  events: readonly NormalizedProviderEvent[];
  stderrLogPath?: string;
}): Promise<ProviderCompletion> {
  const inputRequired = input.events.find(
    (event) => event.type === "input_required"
  );
  if (inputRequired !== undefined) {
    return {
      classification: "input_required",
      kind: "input_required",
      reason:
        stringField(inputRequired, "message") ?? "provider requested input"
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
      reason: stringField(turnFailed, "message") ?? "turn_failed"
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
    return { kind: "clean_exit" };
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
