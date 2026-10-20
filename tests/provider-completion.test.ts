import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedProviderEvent } from "../src/provider.js";
import { classifyProviderCompletion } from "../src/providers/provider-completion.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function stderrPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-completion-"));
  roots.push(root);
  return path.join(root, "provider.stderr.log");
}

describe("Provider Completion", () => {
  it.each([
    {
      name: "clean exit without workspace acceptance",
      events: [{ type: "process_exit", exitCode: 0 }],
      expected: { kind: "clean_exit" }
    },
    {
      name: "missing exit despite a completed turn",
      events: [{ type: "turn_completed" }],
      expected: {
        classification: "transient",
        kind: "failed",
        reason: "no_process_exit_event"
      }
    },
    {
      name: "cancelled exit before exit code",
      events: [{ type: "process_exit", cancelled: true, exitCode: 0 }],
      expected: { kind: "cancelled", reason: "provider_cancelled" }
    },
    {
      name: "strict cancellation flag",
      events: [{ type: "process_exit", cancelled: "true", exitCode: 0 }],
      expected: { kind: "clean_exit" }
    },
    {
      name: "first process exit",
      events: [
        { type: "process_exit", exitCode: 2 },
        { type: "process_exit", exitCode: 0 }
      ],
      expected: {
        classification: "transient",
        kind: "failed",
        reason: "process_exit_2"
      }
    },
    {
      name: "signal exit",
      events: [{ type: "process_exit", exitCode: null, signal: "SIGKILL" }],
      expected: {
        classification: "transient",
        kind: "failed",
        reason: "process_exit_signal_SIGKILL"
      }
    },
    {
      name: "strict numeric exit code and string signal",
      events: [{ type: "process_exit", exitCode: "0", signal: 9 }],
      expected: {
        classification: "transient",
        kind: "failed",
        reason: "process_exit_signal_unknown"
      }
    },
    {
      name: "input request fallback for non-string message",
      events: [{ type: "input_required", message: 42 }],
      expected: {
        classification: "input_required",
        kind: "input_required",
        reason: "provider requested input"
      }
    },
    {
      name: "first failed turn even when its message is missing",
      events: [
        { type: "turn_failed" },
        { type: "turn_failed", message: "later failure" },
        { type: "process_exit", cancelled: true }
      ],
      expected: {
        classification: "transient",
        kind: "failed",
        reason: "turn_failed"
      }
    },
    {
      name: "empty provider message remains evidence",
      events: [{ type: "input_required", message: "" }],
      expected: {
        classification: "input_required",
        kind: "input_required",
        reason: ""
      }
    },
    {
      name: "malformed output before a failed turn and cancelled exit",
      events: [
        { type: "process_exit", cancelled: true },
        { type: "turn_failed", message: "turn failure" },
        { type: "malformed_event" }
      ],
      expected: {
        classification: "deterministic",
        kind: "failed",
        reason: "malformed_provider_event"
      }
    }
  ] satisfies Array<{
    name: string;
    events: NormalizedProviderEvent[];
    expected: { kind: string; classification?: string; reason?: string };
  }>)("classifies $name", async ({ events, expected }) => {
    expect(await classifyProviderCompletion({ events })).toEqual(expected);
  });

  it.each([false, true])(
    "keeps category precedence with reversed events=%s and selects the first input request",
    async (reverse) => {
      const lower: NormalizedProviderEvent[] = [
        { type: "process_exit", cancelled: true, exitCode: 0 },
        { type: "turn_failed", message: "turn failure" },
        { type: "malformed_event" }
      ];
      const events: NormalizedProviderEvent[] = [
        ...(reverse ? lower.reverse() : lower),
        { type: "input_required", message: "first input" },
        { type: "input_required", message: "second input" }
      ];
      const original = structuredClone(events);
      expect(await classifyProviderCompletion({ events })).toEqual({
        classification: "input_required",
        kind: "input_required",
        reason: "first input"
      });
      expect(events).toEqual(original);
    }
  );

  it.each([
    { events: [], reason: "no_process_exit_event" },
    {
      events: [{ type: "process_exit", exitCode: 1 }],
      reason: "process_exit_1"
    },
    {
      events: [{ type: "process_exit", signal: "SIGTERM" }],
      reason: "process_exit_signal_SIGTERM"
    }
  ] satisfies Array<{ events: NormalizedProviderEvent[]; reason: string }>)(
    "explains $reason with stderr",
    async ({ events, reason }) => {
      const stderrLogPath = await stderrPath();
      await writeFile(stderrLogPath, "panic: upstream disconnected\n");
      expect(
        await classifyProviderCompletion({ events, stderrLogPath })
      ).toEqual({
        classification: "transient",
        kind: "failed",
        reason: `${reason} (stderr: panic: upstream disconnected)`
      });
    }
  );

  it.each(["missing", "empty"])(
    "keeps the base reason with %s stderr",
    async (kind) => {
      const stderrLogPath = await stderrPath();
      if (kind === "empty") {
        await writeFile(stderrLogPath, "");
      }
      expect(
        await classifyProviderCompletion({ events: [], stderrLogPath })
      ).toEqual({
        classification: "transient",
        kind: "failed",
        reason: "no_process_exit_event"
      });
    }
  );

  it.each([
    { type: "process_exit", exitCode: 0 },
    { type: "process_exit", cancelled: true },
    { type: "input_required", message: "ask the operator" },
    { type: "malformed_event" },
    { type: "turn_failed", message: "turn failure" }
  ] satisfies NormalizedProviderEvent[])(
    "does not decorate $type with unrelated stderr",
    async (event) => {
      const stderrLogPath = await stderrPath();
      await writeFile(stderrLogPath, "unrelated diagnostic\n");
      expect(
        await classifyProviderCompletion({ events: [event], stderrLogPath })
      ).toEqual(await classifyProviderCompletion({ events: [event] }));
    }
  );
});
